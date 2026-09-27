const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const root = path.resolve(__dirname, '..');
const input = path.join(root, 'data', 'radios-com-br', 'parana-am-fm.tsv');
const output = path.join(root, 'data', 'radios-com-br', 'parana-am-fm.json');
const sourceUrl = 'https://www.radios.com.br/radio/uf/parana/16/am-fm';
const coordinateSourceUrl = 'https://geoftp.ibge.gov.br/cartas_e_mapas/mapas_municipais/colecao_de_mapas_municipais/2022/PR/sao_pedro_do_iguacu/A0_4125753_MM.pdf';
const livePages = new Map([
  ['Rádio Colméia 98.7 FM|Maringá', 'https://www.radios.com.br/aovivo/radio-colmeia-987-fm/8785'],
  ['Rádio Evangelizar 99.5 FM|Curitiba', 'https://www.radios.com.br/aovivo/radio-evangelizar-995-fm/72767'],
  ['Rádio TMC 100.3 FM|Curitiba', 'https://www.radios.com.br/aovivo/radio-tmc-1003-fm/8832'],
  ['Rádio Clube 95.7 FM|Londrina', 'https://www.radios.com.br/aovivo/radio-clube-957-fm/199403'],
  ['Rádio Vida FM Gospel 104.9|Andirá', 'https://www.radios.com.br/aovivo/radio-vida-fm-gospel-1049/14811'],
  ['Rádio Banda B 89.7 FM|Curitiba', 'https://www.radios.com.br/aovivo/radio-banda-b-897-fm/10406'],
  ['Rádio Elite 101.7 FM|Pato Branco', 'https://www.radios.com.br/aovivo/radio-elite-1017-fm/13057'],
  ['Rádio Canoa Grande FM 87.7|Iguaraçu', 'https://www.radios.com.br/aovivo/radio-canoa-grande-fm-877/17443'],
  ['93.3 FM Maringá|Maringá', 'https://www.radios.com.br/aovivo/933-fm-maringa/13310'],
  ['Essência Gospel FM 96.7 FM|Foz do Iguaçu', 'https://www.radios.com.br/aovivo/essencia-gospel-fm-967-fm/13850'],
  ['Nossa Rádio 91.7 FM|Bituruna', 'https://www.radios.com.br/aovivo/nossa-radio-917-fm/107305'],
  ['Rádio 102.9 FM|Rio Branco do Sul', 'https://www.radios.com.br/aovivo/radio-1029-fm/35038'],
  ['Rádio 104 FM|Cornélio Procópio', 'https://www.radios.com.br/aovivo/radio-104-fm/45'],
  ['Rádio 104 FM|Cambará', 'https://www.radios.com.br/aovivo/radio-104-fm/39']
]);

if (!fs.existsSync(input)) throw new Error(`Arquivo fonte não encontrado: ${input}`);

const sourceRows = fs.readFileSync(input, 'utf8').trim().split(/\r?\n/).map((line, index) => {
  const [name, city, bandValue, frequencyValue, pageValue] = line.split('\t');
  if (!name || !city || !pageValue) throw new Error(`Linha ${index + 1} incompleta.`);
  const band = ['AM', 'FM'].includes(bandValue) ? bandValue : null;
  const frequency = frequencyValue && frequencyValue !== '-' ? Number(frequencyValue) : null;
  if (frequency !== null && !Number.isFinite(frequency)) throw new Error(`Frequência inválida na linha ${index + 1}.`);
  const page = Number(pageValue);
  if (!Number.isInteger(page) || page < 1 || page > 28) throw new Error(`Página inválida na linha ${index + 1}.`);
  return { name: name.trim(), city: city.trim(), band, frequency, page };
});

const keyOf = row => [row.name, row.city, row.band || '', row.frequency ?? ''].map(value => String(value).toLocaleLowerCase('pt-BR').trim()).join('|');
const seen = new Set();
const rows = sourceRows.filter(row => {
  const key = keyOf(row);
  if (seen.has(key)) return false;
  seen.add(key);
  return true;
});

const stations = rows.map(row => {
  const key = keyOf(row);
  const station = {
    id: `RC-${crypto.createHash('sha256').update(key).digest('hex').slice(0, 16)}`,
    name: row.name,
    city: row.city,
    state: 'PR',
    band: row.band,
    frequency: row.frequency,
    country: 'Brasil',
    sourcePage: `${sourceUrl}?pg=${row.page - 1}`,
    homepage: null,
    detailsUrl: livePages.get(`${row.name}|${row.city}`) || null,
    lat: null,
    lon: null,
    locationAccuracy: null,
    coordinateSourceUrl: null,
    streamUrl: null
  };
  if (row.name === 'Rádio Alvorada 105.9 FM' && row.city === 'São Pedro do Iguaçu' && row.frequency === 105.9) {
    Object.assign(station, {
      id: '9195',
      detailsUrl: 'https://www.radios.com.br/aovivo/radio-alvorada-1059-fm/9195',
      homepage: 'http://www.alvoradafmsaopedro.com.br/',
      detailsUrl: 'https://www.radios.com.br/aovivo/radio-alvorada-1059-fm/9195',
      lat: -24.93,
      lon: -53.86,
      locationAccuracy: 'municipality',
      coordinateSourceUrl
    });
  }
  return station;
});

const counts = { AM: 0, FM: 0, unknownBand: 0, unknownFrequency: 0 };
for (const station of stations) {
  if (station.band) counts[station.band]++;
  else counts.unknownBand++;
  if (station.frequency === null) counts.unknownFrequency++;
}

const catalog = {
  source: 'Radios.com.br · AM/FM do Paraná',
  sourceUrl,
  updatedAt: new Date().toISOString().slice(0, 10),
  pageCount: 28,
  listingEntryCount: 615,
  duplicateRowsExcluded: 615 - stations.length,
  stationCount: stations.length,
  counts,
  selectionRule: 'Registros das 28 páginas do diretório AM/FM. Duplicatas exatas por nome, cidade, faixa e frequência foram removidas; bandas e frequências ausentes permanecem sem inferência. Diretórios de rádio web foram excluídos.',
  stations
};

fs.writeFileSync(output, `${JSON.stringify(catalog, null, 2)}\n`, 'utf8');
process.stdout.write(`Gerado ${path.relative(root, output)}: ${stations.length} estações de ${sourceRows.length} linhas importadas. ${JSON.stringify(counts)}\n`);
