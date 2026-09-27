// Imports every page of Tudo Rádio's Paraná directory and enriches each row
// with the public stream URL exposed by its station player page.
// Usage: node scripts/build-tudoradio-parana-directory.js
const fs = require('node:fs/promises');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const output = path.join(root, 'data', 'tudoradio', 'parana-directory.json');
const sourceUrl = 'https://tudoradio.com/radios/estado/PR';
const headers = { Accept: 'text/html', 'User-Agent': 'WorldRadioGlobe/1.0 (Brazil station catalog)' };

function slug(value) {
  return String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

async function fetchPage(url) {
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(20000) });
  if (!response.ok) throw new Error(`Tudo Rádio respondeu HTTP ${response.status} em ${url}`);
  return response.text();
}

function parseNextData(html, url) {
  const match = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/i);
  if (!match) throw new Error(`Não encontrei os dados da página ${url}.`);
  return JSON.parse(match[1]);
}

async function main() {
  const listed = new Map();
  let totalPages = 0;
  for (let page = 1; page <= 20; page += 1) {
    const url = `${sourceUrl}?page=${page}`;
    const data = parseNextData(await fetchPage(url), url)?.props?.pageProps?.paginatedResponse;
    if (!Array.isArray(data?.items)) throw new Error(`A página ${page} não contém a lista de rádios esperada.`);
    totalPages = Number(data.meta?.totalPages) || page;
    for (const item of data.items) {
      const id = String(item?.id || '');
      const name = String(item?.nome || '').trim();
      const city = String(item?.cidade?.nome || '').trim();
      const frequency = Number(item?.estacao);
      if (!id || !name || !city || !Number.isFinite(frequency)) continue;
      listed.set(id, {
        id, name, city, state: String(item.estado?.sigla || 'PR').toUpperCase(),
        frequency, band: String(item.frequencia || '').toUpperCase(),
        homepage: item.site || null, logo: item.logo || null,
        categories: (item.categorias || []).map(category => category.Nome).filter(Boolean),
        views: Number(item.views) || 0,
        detailsUrl: `https://tudoradio.com/player/radio/${id}-${slug(name)}`,
        sourcePage: url, source: 'Tudo Rádio'
      });
    }
    console.log(`Página ${page}/${totalPages}: ${data.items.length} rádios`);
    if (page >= totalPages) break;
  }

  const stations = Array.from(listed.values());
  let nextStation = 0;
  let enriched = 0;
  const workers = Array.from({ length: 4 }, async () => {
    while (nextStation < stations.length) {
      const station = stations[nextStation++];
      try {
        const data = parseNextData(await fetchPage(station.detailsUrl), station.detailsUrl)?.props?.pageProps?.radio;
        if (data && String(data.id) === station.id) {
          station.streamUrls = [...new Set([data.streaming, data.streaming_android, data.streamingmobile].filter(value => typeof value === 'string' && /^https?:\/\//i.test(value)))];
          station.streamUrl = station.streamUrls[0] || null;
          station.mobileStreamUrl = station.streamUrls[1] || null;
          station.player = data.player || null;
          station.phone = data.telefone || null;
          station.address = data.endereco || null;
          station.transmitterCity = data.localtransmissao || station.city;
          station.description = data.descricao || null;
          enriched += 1;
        }
      } catch (error) {
        console.warn(`Detalhes indisponíveis para ${station.name}: ${error.message}`);
      }
    }
  });
  await Promise.all(workers);
  const payload = {
    source: 'Tudo Rádio · diretório de rádios do Paraná', sourceUrl,
    generatedAt: new Date().toISOString(), pageCount: totalPages,
    stationCount: stations.length, enrichedStreamCount: enriched, stations
  };
  await fs.mkdir(path.dirname(output), { recursive: true });
  await fs.writeFile(output, `${JSON.stringify(payload)}\n`, 'utf8');
  console.log(`Gravado ${path.relative(root, output)}: ${stations.length} rádios, ${enriched} páginas de transmissão lidas.`);
}

main().catch(error => { console.error(`Falha na importação Tudo Rádio: ${error.message}`); process.exitCode = 1; });
