// Imports only Paraná stations whose pasted directory row has an explicit AM/FM dial.
// Usage: node scripts/import-radios-brasil-parana.js <path-to-pasted-text.txt>
const fs = require('node:fs/promises');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const input = process.argv[2];
const output = path.join(root, 'data', 'radios-brasil', 'parana-terrestrial.json');
const sourceUrl = 'https://radios-brasil.com/parana?sort=az';

function normalize(value) {
  return String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ').trim().replace(/\s+/g, ' ');
}

function slug(value) {
  return normalize(value).replace(/\s+/g, '-');
}

async function main() {
  if (!input) throw new Error('Informe o caminho do texto colado exportado do diretório.');
  const text = (await fs.readFile(path.resolve(input), 'utf8')).replace(/^\uFEFF/, '');
  const lines = text.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  const frequencyLine = /^(.+?)\s*[·|]\s*(\d{1,3}(?:[.,]\d{1,2})?|\d{3,4})\s*(FM|AM)$/i;
  const stations = new Map();

  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index].match(frequencyLine);
    if (!match) continue;
    const city = match[1].trim();
    let name = lines[index - 1] || '';
    if (index > 1 && lines[index - 2] === name) name = lines[index - 2];
    if (!name || name === city || /^\d+$/.test(name) || name === '…') continue;
    const band = match[3].toUpperCase();
    const frequency = Number(match[2].replace(',', '.'));
    const id = `RB-PR-${slug(city)}-${band}-${String(frequency).replace('.', '-')}-${slug(name)}`;
    const station = { id, name, city, state: 'PR', band, frequency, source: 'Radios Brasil', sourceUrl };
    stations.set([normalize(name), normalize(city), band, frequency].join('|'), station);
  }

  const result = Array.from(stations.values());
  if (!result.length) throw new Error('Não encontrei frequências AM/FM no texto; nenhum arquivo foi gravado.');
  result.sort((a, b) => a.name.localeCompare(b.name, 'pt-BR') || a.city.localeCompare(b.city, 'pt-BR'));
  const payload = {
    source: 'Radios Brasil · emissoras terrestres AM/FM do Paraná', sourceUrl,
    importedAt: new Date().toISOString(), sourcePages: 24,
    selectionRule: 'Inclui somente linhas com município, frequência e faixa AM/FM explícitos; exclui entradas sem dial terrestre.',
    stationCount: result.length,
    bands: result.reduce((counts, station) => ({ ...counts, [station.band]: (counts[station.band] || 0) + 1 }), {}),
    cityCount: new Set(result.map(station => normalize(station.city))).size,
    stations: result
  };
  await fs.mkdir(path.dirname(output), { recursive: true });
  await fs.writeFile(output, `${JSON.stringify(payload)}\n`, 'utf8');
  console.log(`Gravado ${path.relative(root, output)}: ${payload.stationCount} rádios terrestres AM/FM em ${payload.cityCount} municípios.`);
  console.log(`Faixas: ${JSON.stringify(payload.bands)}. Linhas sem AM/FM explícito foram excluídas.`);
}

main().catch(error => { console.error(`Falha na importação Radios Brasil: ${error.message}`); process.exitCode = 1; });
