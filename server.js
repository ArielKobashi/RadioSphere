// Servidor opcional: arquivos estáticos e proxy same-origin para Now Playing das rádios.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const dns = require('node:dns/promises');
const { spawn } = require('node:child_process');
const { Readable } = require('node:stream');

const root = __dirname;
try {
  for (const line of fs.readFileSync(path.join(root, '.env'), 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (match && !Object.hasOwn(process.env, match[1])) process.env[match[1]] = match[2].replace(/^(['"])(.*)\1$/, '$2');
  }
} catch (_) { /* .env local é opcional. */ }
const port = Number(process.env.PORT) || 8765;
const host = process.env.HOST || '127.0.0.1';
const ffmpeg = process.env.FFMPEG_PATH || 'ffmpeg';
const python = process.env.PYTHON_PATH || (process.platform === 'win32' ? 'py' : 'python3');
const recognitionCache = new Map();
const recognitionInFlight = new Set();
const recognitionByIp = new Map();
const tuRadioPageCache = new Map();
const tuRadioProbeCache = new Map();
const ibgeMunicipalityCache = new Map();
const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json' };

function json(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(JSON.stringify(payload));
}

function requestIsSameOrigin(req) {
  try { return Boolean(req.headers.origin && new URL(req.headers.origin).host === req.headers.host); }
  catch (_) { return false; }
}

function isPrivateAddress(address) {
  const ip = String(address).toLowerCase();
  const mappedV4 = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mappedV4) return isPrivateAddress(mappedV4[1]);
  if (ip === '::1' || ip === '::' || ip.startsWith('fc') || ip.startsWith('fd') || ip.startsWith('fe80:')) return true;
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some(n => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  return parts[0] === 0 || parts[0] === 10 || parts[0] === 127 || parts[0] >= 224 ||
    (parts[0] === 169 && parts[1] === 254) ||
    (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
    (parts[0] === 192 && parts[1] === 168) ||
    (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127);
}

async function validateStreamUrl(value) {
  let url;
  try { url = new URL(String(value || '')); } catch { throw new Error('Endereço do stream inválido.'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.port && !/^\d+$/.test(url.port)) {
    throw new Error('O stream precisa usar HTTP(S) e não pode conter credenciais.');
  }
  const host = url.hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || isPrivateAddress(host)) throw new Error('Endereço local bloqueado.');
  const addresses = await dns.lookup(host, { all: true, verbatim: true });
  if (!addresses.length || addresses.some(item => isPrivateAddress(item.address))) throw new Error('O endereço do stream não é público.');
  return url.href;
}

async function fetchPublicUrl(value, options = {}, maxRedirects = 5) {
  let currentUrl = await validateStreamUrl(value);
  for (let redirects = 0; redirects <= maxRedirects; redirects += 1) {
    const response = await fetch(currentUrl, { ...options, redirect: 'manual' });
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    const location = response.headers.get('location');
    if (!location || redirects === maxRedirects) throw new Error('Redirecionamento excessivo da rádio.');
    currentUrl = await validateStreamUrl(new URL(location, currentUrl).href);
  }
  throw new Error('Não foi possível acessar o stream.');
}

function readBalancedJson(source, start) {
  const first = source[start];
  if (first !== '{' && first !== '[') return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < source.length; index += 1) {
    const char = source[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') { inString = true; continue; }
    if (char === '{' || char === '[') depth += 1;
    else if (char === '}' || char === ']') {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  return null;
}

function extractTuRadioFlightText(html) {
  const frames = [];
  for (const script of html.matchAll(/<script>([\s\S]*?)<\/script>/gi)) {
    const body = script[1];
    let from = 0;
    while (true) {
      const pushAt = body.indexOf('self.__next_f.push(', from);
      if (pushAt < 0) break;
      const payloadStart = body.indexOf('(', pushAt) + 1;
      const payloadEnd = body.indexOf('])', payloadStart);
      if (payloadEnd < 0) break;
      try {
        const frame = JSON.parse(`${body.slice(payloadStart, payloadEnd)}]`);
        if (typeof frame?.[1] === 'string') frames.push(frame[1]);
      } catch (_) { /* descarta somente o frame inválido */ }
      from = payloadEnd + 2;
    }
  }
  return frames.join('');
}

function parseTuRadioJsonField(flightText, key, expectedType) {
  const marker = `"${key}":`;
  const at = flightText.indexOf(marker);
  if (at < 0) return null;
  const start = flightText.indexOf(expectedType === 'array' ? '[' : '{', at + marker.length);
  if (start < 0) return null;
  const json = readBalancedJson(flightText, start);
  if (!json) return null;
  try { return JSON.parse(json); } catch (_) { return null; }
}

function dialsSlug(value) {
  return String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

async function fetchTuRadioPage(pagePath) {
  const cached = tuRadioPageCache.get(pagePath);
  if (cached && cached.expiresAt > Date.now()) return cached.html;
  const url = new URL(pagePath, 'https://tudoradio.com');
  if (url.origin !== 'https://tudoradio.com' || !/^\/dials\/(?:estado\/[A-Z]{2}|cidade\/\d+-[a-z0-9-]+)$/i.test(url.pathname)) {
    throw new Error('Endereço de página Dials inválido.');
  }
  const response = await fetchPublicUrl(url.href, {
    headers: { 'Accept': 'text/html', 'User-Agent': 'WorldRadioGlobe/1.0 (Brazil station catalog)' },
    signal: AbortSignal.timeout(20000)
  });
  if (!response.ok) throw new Error(`Tudo Rádio respondeu HTTP ${response.status}.`);
  const reader = response.body?.getReader();
  if (!reader) throw new Error('A página Dials não devolveu conteúdo.');
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > 8 * 1024 * 1024) { await reader.cancel(); throw new Error('Página Dials excedeu o limite de leitura.'); }
      chunks.push(Buffer.from(value));
    }
  } finally { try { await reader.cancel(); } catch (_) {} }
  const html = Buffer.concat(chunks).toString('utf8');
  tuRadioPageCache.set(pagePath, { html, expiresAt: Date.now() + 6 * 60 * 60 * 1000 });
  if (tuRadioPageCache.size > 48) tuRadioPageCache.delete(tuRadioPageCache.keys().next().value);
  return html;
}

async function loadTuRadioCities(uf) {
  const stateCode = String(uf || '').toUpperCase();
  if (!/^(AC|AL|AP|AM|BA|CE|DF|ES|GO|MA|MT|MS|MG|PA|PB|PR|PE|PI|RJ|RN|RS|RO|RR|SC|SP|SE|TO)$/.test(stateCode)) {
    throw new Error('UF brasileira inválida.');
  }
  const html = await fetchTuRadioPage(`/dials/estado/${stateCode}`);
  const cities = new Map();
  for (const match of html.matchAll(/href=["'](?:https?:\/\/tudoradio\.com)?(\/dials\/cidade\/(\d+)-([a-z0-9-]+))["']/gi)) {
    const pagePath = match[1];
    cities.set(pagePath, { id: match[2], slug: match[3], path: pagePath, url: `https://tudoradio.com${pagePath}` });
  }
  if (!cities.size) throw new Error('Não consegui localizar cidades Dials para este estado.');
  return Array.from(cities.values()).sort((a, b) => a.slug.localeCompare(b.slug, 'pt-BR'));
}

async function loadIbgeMunicipalities(uf) {
  const stateCode = String(uf || '').toUpperCase();
  const stateNumbers = { AC: 12, AL: 27, AP: 16, AM: 13, BA: 29, CE: 23, DF: 53, ES: 32, GO: 52, MA: 21, MT: 51, MS: 50, MG: 31, PA: 15, PB: 25, PR: 41, PE: 26, PI: 22, RJ: 33, RN: 24, RS: 43, RO: 11, RR: 14, SC: 42, SP: 35, SE: 28, TO: 17 };
  if (!Object.hasOwn(stateNumbers, stateCode)) throw new Error('Informe uma UF brasileira válida.');
  const cached = ibgeMunicipalityCache.get(stateCode);
  if (cached && cached.expiresAt > Date.now()) return cached.municipalities;
  const response = await fetch(`https://servicodados.ibge.gov.br/api/v1/localidades/estados/${stateNumbers[stateCode]}/municipios?orderBy=nome`, {
    headers: { Accept: 'application/json', 'User-Agent': 'WorldRadioGlobe/1.0' },
    signal: AbortSignal.timeout(12000)
  });
  if (!response.ok) throw new Error(`IBGE respondeu HTTP ${response.status}.`);
  const raw = await response.json();
  if (!Array.isArray(raw) || !raw.length) throw new Error('A lista municipal do IBGE veio incompleta.');
  const municipalities = raw.map(item => ({ id: String(item.id), name: String(item.nome || '').trim(), state: stateCode }))
    .filter(item => item.id && item.name);
  ibgeMunicipalityCache.set(stateCode, { municipalities, expiresAt: Date.now() + 30 * 24 * 60 * 60 * 1000 });
  return municipalities;
}

async function loadTuRadioCity(cityIdSlug) {
  const cityKey = String(cityIdSlug || '').toLowerCase();
  if (!/^\d+-[a-z0-9-]+$/.test(cityKey)) throw new Error('Cidade Dials inválida.');
  const pagePath = `/dials/cidade/${cityKey}`;
  const html = await fetchTuRadioPage(pagePath);
  const flightText = extractTuRadioFlightText(html);
  const city = parseTuRadioJsonField(flightText, 'city', 'object');
  const radios = parseTuRadioJsonField(flightText, 'radios', 'array');
  if (!city || !Array.isArray(radios)) throw new Error('A página Dials não contém a lista esperada de emissoras.');
  const stations = radios.filter(item => item && item.id && item.nome && Number.isFinite(Number(item.estacao))).map(item => ({
    id: String(item.id), name: String(item.nome).trim(), frequency: Number(item.estacao), band: String(item.tipo || item.frequencia || '').toUpperCase(),
    signal: String(item.sinal || ''), rds: Boolean(item.rds), hybridRadio: Boolean(item.hibrida),
    transmitterCity: String(item.localTransmissao || '').trim(), state: String(city.uf || '').toUpperCase(), stateName: String(city.estado || ''),
    receptionCity: String(city.nome || ''), classAndCallsign: String(item.classe || ''), prefix: String(item.prefixo || ''),
    streamUrl: item.url || null, homepage: item.site || null,
    technical: item.detalhesTecnicos && typeof item.detalhesTecnicos === 'object' ? item.detalhesTecnicos : {},
    source: 'Tudo Rádio Dials', validatedRecord: true,
    detailsUrl: `https://tudoradio.com/dials/emissora/${encodeURIComponent(item.id)}-${dialsSlug(item.nome)}`,
    listenPageUrl: `https://tudoradio.com/player/radio/${encodeURIComponent(item.id)}-${dialsSlug(item.nome)}`,
    cityPageUrl: `https://tudoradio.com${pagePath}`
  }));
  return { city: { name: String(city.nome || ''), state: String(city.uf || '').toUpperCase(), path: pagePath, url: `https://tudoradio.com${pagePath}` }, stations };
}

async function validateAudioStream(streamUrl) {
  const requestedUrl = await validateStreamUrl(streamUrl);
  const cached = tuRadioProbeCache.get(requestedUrl);
  if (cached && cached.expiresAt > Date.now()) return cached.result;
  const response = await fetchPublicUrl(requestedUrl, {
    method: 'GET', headers: { 'Range': 'bytes=0-511', 'Icy-MetaData': '0', 'User-Agent': 'WorldRadioGlobe/1.0' },
    signal: AbortSignal.timeout(9000)
  });
  const contentType = String(response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  let sample = Buffer.alloc(0);
  let reader;
  try {
    reader = response.body?.getReader();
    if (reader) {
      const first = await reader.read();
      if (first.value) sample = Buffer.from(first.value).subarray(0, 512);
    }
  } finally { try { await reader?.cancel(); } catch (_) {} }
  const looksLikeAudio = /^audio\//.test(contentType) || contentType === 'application/ogg' ||
    contentType === 'application/octet-stream' && (sample.subarray(0, 3).toString() === 'ID3' ||
      sample.subarray(0, 4).toString() === 'OggS' || sample.subarray(0, 4).toString() === 'fLaC' ||
      sample.subarray(0, 4).toString() === 'RIFF' || (sample[0] === 0xff && (sample[1] & 0xe0) === 0xe0));
  const result = {
    valid: response.status >= 200 && response.status < 300 && looksLikeAudio,
    status: response.status, contentType, bytes: sample.length,
    url: response.url || requestedUrl,
    reason: response.status < 200 || response.status >= 300 ? `HTTP ${response.status}` : looksLikeAudio ? null : 'A URL não devolveu um tipo de áudio reconhecível.'
  };
  tuRadioProbeCache.set(requestedUrl, { result, expiresAt: Date.now() + 3 * 60 * 1000 });
  if (tuRadioProbeCache.size > 2000) tuRadioProbeCache.delete(tuRadioProbeCache.keys().next().value);
  return result;
}

function songFromMetadata(data, streamPath = '') {
  const sources = data?.icestats?.source
    ? Array.isArray(data.icestats.source) ? data.icestats.source : [data.icestats.source]
    : [];
  for (const source of sources) {
    if (source.title && (sources.length === 1 || String(source.listenurl || '').includes(streamPath))) {
      return { title: String(source.title).trim(), artist: String(source.artist || '').trim(), source: 'Metadata Icecast' };
    }
  }
  const song = data?.now_playing?.song || data?.nowplaying?.song || data?.song || null;
  if (song) {
    const title = String(song.title || song.text || '').trim();
    const artist = String(song.artist || '').trim();
    if (title) return { title, artist, source: 'Metadata da rádio' };
  }
  return null;
}

async function readIcyTrack(streamUrl) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  let reader;
  try {
    const response = await fetchPublicUrl(streamUrl, {
      headers: { 'Icy-MetaData': '1', 'User-Agent': 'WorldRadioGlobe/1.0' }, signal: controller.signal
    });
    if (!response.ok || !response.body) return null;
    const metaint = Number(response.headers.get('icy-metaint'));
    if (!Number.isInteger(metaint) || metaint < 1 || metaint > 1024 * 1024) { await response.body.cancel(); return null; }
    reader = response.body.getReader();
    let buffer = Buffer.alloc(0);
    let bytes = 0;
    while (bytes < 1024 * 1024) {
      const { value, done } = await reader.read();
      if (done) break;
      const chunk = Buffer.from(value);
      bytes += chunk.length;
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length > metaint) {
        const metadataBytes = buffer[metaint] * 16;
        const recordSize = metaint + 1 + metadataBytes;
        if (buffer.length < recordSize) break;
        if (metadataBytes) {
          const block = buffer.subarray(metaint + 1, recordSize).toString('utf8');
          const title = block.match(/StreamTitle\s*=\s*'([^']*)'/i)?.[1]?.trim();
          if (title) {
            const [artist, ...rest] = title.split(' - ');
            return { title: rest.length ? rest.join(' - ').trim() : title, artist: rest.length ? artist.trim() : '', source: 'ICY StreamTitle' };
          }
        }
        buffer = buffer.subarray(recordSize);
      }
    }
    return null;
  } catch (_) { return null; }
  finally { clearTimeout(timeout); controller.abort(); try { await reader?.cancel(); } catch (_) {} }
}

async function findStationNowPlaying(streamUrl) {
  const safeUrl = await validateStreamUrl(streamUrl);
  const stream = new URL(safeUrl);
  const base = `${stream.protocol}//${stream.host}`;
  const endpoints = [...new Set([
    `${base}/status-json.xsl`, `${base}/stats?json=1`, `${base}/api/nowplaying`,
    `${base}/api/live/nowplaying${stream.pathname.length > 1 ? stream.pathname : ''}`
  ])];
  for (const endpoint of endpoints) {
    try {
      const response = await fetchPublicUrl(endpoint, { headers: { 'Accept': 'application/json', 'User-Agent': 'WorldRadioGlobe/1.0' }, signal: AbortSignal.timeout(4500) });
      if (!response.ok) continue;
      const data = await response.json();
      const track = songFromMetadata(data, stream.pathname);
      if (track) return track;
    } catch (_) { /* tenta a próxima convenção conhecida */ }
  }
  return await readIcyTrack(safeUrl);
}

function captureRecognitionSample(streamUrl) {
  return new Promise((resolve, reject) => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 14000);
    fetchPublicUrl(streamUrl, { headers: { 'Icy-MetaData': '0', 'User-Agent': 'WorldRadioGlobe/1.0' }, signal: controller.signal })
      .then(response => {
        if (!response.ok || !response.body) throw new Error(`A rádio respondeu HTTP ${response.status}.`);
        const decoder = spawn(ffmpeg, [
          '-hide_banner', '-loglevel', 'error', '-i', 'pipe:0', '-t', '8', '-vn',
          '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', '-f', 'wav', 'pipe:1'
        ], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
        const chunks = [];
        let bytes = 0;
        let diagnostic = '';
        let settled = false;
        const finish = (error, sample) => {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          controller.abort();
          if (error) reject(error); else resolve(sample);
        };
        decoder.stdout.on('data', chunk => {
          bytes += chunk.length;
          if (bytes > 1000000) { decoder.kill(); return finish(new Error('Amostra excedeu 1 MB.')); }
          chunks.push(chunk);
        });
        decoder.stderr.on('data', chunk => { diagnostic = (diagnostic + chunk.toString()).slice(-700); });
        decoder.stdin.on('error', () => {});
        decoder.on('error', error => finish(new Error(`FFmpeg indisponível: ${error.message}`)));
        decoder.on('close', () => {
          if (bytes < 8000) return finish(new Error(diagnostic || 'A rádio não forneceu áudio decodificável.'));
          finish(null, Buffer.concat(chunks));
        });
        Readable.fromWeb(response.body).pipe(decoder.stdin);
      })
      .catch(error => { clearTimeout(timeout); controller.abort(); reject(error); });
  });
}

function recognizeWithShazamIO(sample) {
  return new Promise((resolve, reject) => {
    const script = path.join(root, 'scripts', 'recognize_shazamio.py');
    const args = process.platform === 'win32' && !process.env.PYTHON_PATH
      ? ['-3', script]
      : [script];
    const child = spawn(python, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    const chunks = [];
    let stdoutBytes = 0;
    let stderr = '';
    let settled = false;
    const timeout = setTimeout(() => { child.kill(); finish(new Error('Tempo limite do reconhecimento expirou.')); }, 22000);
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (error) reject(error); else resolve(result);
    };
    child.stdout.on('data', chunk => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > 200000) { child.kill(); return finish(new Error('Resposta do reconhecedor excedeu o limite.')); }
      chunks.push(chunk);
    });
    child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-1000); });
    child.on('error', error => finish(new Error(`Python não encontrado. Instale Python 3.10+ e rode pip install -r requirements-recognition.txt. ${error.message}`)));
    child.on('close', code => {
      if (settled) return;
      if (code !== 0) return finish(new Error(stderr || 'ShazamIO falhou. Verifique Python, dependências e conexão.'));
      try { finish(null, JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { finish(new Error('ShazamIO retornou uma resposta inválida.')); }
    });
    child.stdin.on('error', () => {});
    child.stdin.end(sample);
  });
}

async function identifyWithShazamIO(req, res) {
  if (!requestIsSameOrigin(req)) return json(res, 403, { error: 'Origem não autorizada.' });
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 4096) return json(res, 413, { error: 'Pedido muito grande.' });
  }
  let stationKey = '';
  try {
    const input = JSON.parse(body || '{}');
    const streamUrl = await validateStreamUrl(input.streamUrl);
    stationKey = `${String(input.stationId || '').slice(0, 100)}|${streamUrl}`.slice(0, 1500);
    const now = Date.now();
    for (const [key, entry] of recognitionCache) if (entry.expiresAt <= now) recognitionCache.delete(key);
    if (recognitionCache.size > 800) recognitionCache.delete(recognitionCache.keys().next().value);
    if (recognitionByIp.size > 1000) {
      for (const [key, timestamp] of recognitionByIp) if (now - timestamp > 300000) recognitionByIp.delete(key);
      while (recognitionByIp.size > 900) recognitionByIp.delete(recognitionByIp.keys().next().value);
    }
    const cached = recognitionCache.get(stationKey);
    if (cached) return json(res, 200, { ...cached.payload, cached: true });
    if (recognitionInFlight.has(stationKey)) return json(res, 429, { error: 'Esta rádio já está sendo analisada.' });
    const ip = req.socket.remoteAddress || 'unknown';
    if (now - (recognitionByIp.get(ip) || 0) < 10000) return json(res, 429, { error: 'Aguarde antes de pedir outra análise.' });
    recognitionByIp.set(ip, now);
    recognitionInFlight.add(stationKey);
    const captureStarted = Date.now();
    const sample = await captureRecognitionSample(streamUrl);
    const captureMs = Date.now() - captureStarted;
    const providerStarted = Date.now();
    const result = await recognizeWithShazamIO(sample);
    const providerMs = Date.now() - providerStarted;
    const payload = {
      provider: 'ShazamIO',
      diagnostics: { captureMs, providerMs, sampleBytes: sample.length },
      track: result.track || null,
      reason: result.track ? null : 'no-match'
    };
    recognitionCache.set(stationKey, { payload, expiresAt: now + 45000 });
    return json(res, 200, payload);
  } catch (error) {
    return json(res, 502, { error: error.message || 'Falha no reconhecimento com ShazamIO.' });
  } finally {
    if (stationKey) recognitionInFlight.delete(stationKey);
  }
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS' && req.url?.startsWith('/api/')) { res.writeHead(204, { 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' }); return res.end(); }
  if (req.method === 'POST' && req.url === '/api/nowplaying') {
    if (!requestIsSameOrigin(req)) return json(res, 403, { error: 'Origem não autorizada.' });
    let body = '';
    for await (const chunk of req) { body += chunk; if (body.length > 4096) return json(res, 413, { error: 'Pedido muito grande.' }); }
    try {
      const input = JSON.parse(body || '{}');
      const track = await findStationNowPlaying(input.streamUrl);
      return json(res, 200, { track, source: track?.source || null, reason: track ? null : 'station-does-not-publish-track-metadata' });
    } catch (error) { return json(res, 400, { error: error.message || 'Endereço do stream inválido.' }); }
  }
  if (req.method === 'POST' && req.url === '/api/music/identify') return identifyWithShazamIO(req, res);
  if (req.method === 'GET' && req.url?.startsWith('/api/tudoradio/cities?')) {
    try {
      const params = new URL(req.url, 'http://localhost').searchParams;
      const cities = await loadTuRadioCities(params.get('uf'));
      return json(res, 200, { source: 'Tudo Rádio Dials', cities });
    } catch (error) { return json(res, 502, { error: error.message || 'Falha ao consultar cidades Dials.' }); }
  }
  if (req.method === 'GET' && req.url?.startsWith('/api/ibge/municipalities?')) {
    try {
      const params = new URL(req.url, 'http://localhost').searchParams;
      const municipalities = await loadIbgeMunicipalities(params.get('uf'));
      return json(res, 200, { source: 'IBGE', municipalities });
    } catch (error) { return json(res, 502, { error: error.message || 'Falha ao consultar municípios do IBGE.' }); }
  }
  if (req.method === 'GET' && req.url?.startsWith('/api/tudoradio/city?')) {
    try {
      const params = new URL(req.url, 'http://localhost').searchParams;
      const result = await loadTuRadioCity(params.get('id'));
      return json(res, 200, { source: 'Tudo Rádio Dials', ...result });
    } catch (error) { return json(res, 502, { error: error.message || 'Falha ao consultar esta cidade Dials.' }); }
  }
  if (req.method === 'POST' && req.url === '/api/tudoradio/validate-stream') {
    if (!requestIsSameOrigin(req)) return json(res, 403, { error: 'Origem não autorizada.' });
    let body = '';
    for await (const chunk of req) { body += chunk; if (body.length > 4096) return json(res, 413, { error: 'Pedido muito grande.' }); }
    try {
      const input = JSON.parse(body || '{}');
      const result = await validateAudioStream(input.streamUrl);
      return json(res, 200, result);
    } catch (error) { return json(res, 200, { valid: false, reason: error.message || 'Falha ao validar stream.' }); }
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, { error: 'Método não permitido.' });
  const pathname = decodeURIComponent((req.url || '/').split('?')[0]);
  if (pathname.split('/').some(part => part.startsWith('.')) || pathname === '/server.js' || pathname.startsWith('/tests/')) return json(res, 404, { error: 'Não encontrado.' });
  const target = path.resolve(root, `.${pathname === '/' ? '/index.html' : pathname}`);
  if (!target.startsWith(`${root}${path.sep}`) && target !== path.join(root, 'index.html')) return json(res, 403, { error: 'Caminho inválido.' });
  fs.stat(target, (error, stat) => {
    if (error || !stat.isFile()) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': mime[path.extname(target)] || 'application/octet-stream', 'X-Content-Type-Options': 'nosniff' });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(target).pipe(res);
  });
});

server.listen(port, host, () => console.log(`World Radio Globe em http://${host}:${port}`));
