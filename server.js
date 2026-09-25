// Servidor opcional: arquivos estáticos + proxy Shazam. A chave fica apenas no ambiente do servidor.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const dns = require('node:dns/promises');
const { spawn, spawnSync } = require('node:child_process');
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
const rapidApiKey = process.env.RAPIDAPI_KEY || '';
const identifyByIp = new Map();
const tuRadioPageCache = new Map();
const tuRadioProbeCache = new Map();
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

function capturePcm(streamUrl) {
  return new Promise((resolve, reject) => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 12000);
    fetchPublicUrl(streamUrl, { headers: { 'Icy-MetaData': '0', 'User-Agent': 'WorldRadioGlobe/1.0' }, signal: controller.signal })
      .then(response => {
        if (!response.ok || !response.body) throw new Error(`A rádio respondeu HTTP ${response.status}.`);
        const decoder = spawn(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-i', 'pipe:0', '-t', '5', '-vn', '-ac', '1', '-ar', '44100', '-f', 's16le', '-acodec', 'pcm_s16le', 'pipe:1'], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
        const chunks = [];
        let bytes = 0;
        let settled = false;
        const finish = (error, buffer) => {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          controller.abort();
          if (error) reject(error); else resolve(buffer);
        };
        decoder.stdout.on('data', chunk => {
          bytes += chunk.length;
          if (bytes > 500000) { decoder.kill(); return finish(new Error('Amostra de áudio passou do limite.')); }
          chunks.push(chunk);
          if (bytes >= 44100 * 2 * 4) decoder.kill();
        });
        let diagnostic = '';
        decoder.stderr.on('data', chunk => { diagnostic = (diagnostic + chunk.toString()).slice(-800); });
        decoder.stdin.on('error', () => {});
        decoder.on('error', error => finish(new Error(`FFmpeg indisponível: ${error.message}`)));
        decoder.on('close', code => {
          if (bytes < 44100 * 2) return finish(new Error(diagnostic || 'A estação não forneceu áudio decodificável.'));
          finish(null, Buffer.concat(chunks));
        });
        Readable.fromWeb(response.body).pipe(decoder.stdin);
      })
      .catch(error => { clearTimeout(timeout); controller.abort(); reject(error); });
  });
}

async function identify(req, res) {
  if (!requestIsSameOrigin(req)) return json(res, 403, { error: 'Origem não autorizada.' });
  if (!rapidApiKey) return json(res, 503, { error: 'Reconhecimento Shazam não configurado no servidor (RAPIDAPI_KEY ausente).' });
  const ip = req.socket.remoteAddress || 'unknown';
  const last = identifyByIp.get(ip) || 0;
  if (Date.now() - last < 12000) return json(res, 429, { error: 'Aguarde 12 segundos antes de identificar outra faixa.' });
  identifyByIp.set(ip, Date.now());
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 4096) return json(res, 413, { error: 'Pedido muito grande.' });
  }
  try {
    const input = JSON.parse(body || '{}');
    const streamUrl = await validateStreamUrl(input.streamUrl);
    const pcm = await capturePcm(streamUrl);
    const shazamResponse = await fetch('https://shazam.p.rapidapi.com/songs/v3/detect?locale=pt-BR&timezone=America%2FSao_Paulo&samplems=4000', {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain', 'X-RapidAPI-Key': rapidApiKey, 'X-RapidAPI-Host': 'shazam.p.rapidapi.com' },
      body: pcm.toString('base64'), signal: AbortSignal.timeout(12000)
    });
    if (!shazamResponse.ok) return json(res, 502, { error: `Shazam/RapidAPI respondeu HTTP ${shazamResponse.status}.` });
    const result = await shazamResponse.json();
    const track = result.track || result.matches?.[0]?.track || null;
    if (!track?.title) return json(res, 200, { track: null, reason: 'no-match' });
    return json(res, 200, { track: { title: track.title, artist: track.subtitle || '', url: track.url || '', artwork: track.images?.coverarthq || track.images?.coverart || '' } });
  } catch (error) {
    return json(res, 502, { error: error.message || 'Falha no reconhecimento.' });
  }
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS' && req.url?.startsWith('/api/')) { res.writeHead(204, { 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' }); return res.end(); }
  if (req.method === 'GET' && req.url === '/api/shazam/status') {
    const check = spawnSync(ffmpeg, ['-version'], { windowsHide: true, stdio: 'ignore', timeout: 2500 });
    return json(res, 200, { provider: 'Shazam via RapidAPI', configured: Boolean(rapidApiKey), ffmpeg: !check.error && check.status === 0 });
  }
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
  if (req.method === 'GET' && req.url?.startsWith('/api/tudoradio/cities?')) {
    try {
      const params = new URL(req.url, 'http://localhost').searchParams;
      const cities = await loadTuRadioCities(params.get('uf'));
      return json(res, 200, { source: 'Tudo Rádio Dials', cities });
    } catch (error) { return json(res, 502, { error: error.message || 'Falha ao consultar cidades Dials.' }); }
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
  if (req.method === 'POST' && req.url === '/api/shazam/identify') return identify(req, res);
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
