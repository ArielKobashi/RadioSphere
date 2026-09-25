// Builds the static Tudo Rádio Dials files used by GitHub Pages.
// Usage: node scripts/build-tudoradio-static.js
const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
const net = require('node:net');

const root = path.resolve(__dirname, '..');
const states = ['AC', 'AL', 'AP', 'AM', 'BA', 'CE', 'DF', 'ES', 'GO', 'MA', 'MT', 'MS', 'MG', 'PA', 'PB', 'PR', 'PE', 'PI', 'RJ', 'RN', 'RS', 'RO', 'RR', 'SC', 'SP', 'SE', 'TO'];

async function freePort() {
  const probe = net.createServer();
  await new Promise((resolve, reject) => probe.listen(0, '127.0.0.1', resolve).once('error', reject));
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  return port;
}

async function run() {
  const port = await freePort();
  const server = spawn(process.execPath, [path.join(root, 'server.js')], {
    cwd: root, windowsHide: true, stdio: 'ignore', env: { ...process.env, HOST: '127.0.0.1', PORT: String(port) }
  });
  const base = `http://127.0.0.1:${port}`;
  const request = async url => {
    const response = await fetch(`${base}${url}`, { signal: AbortSignal.timeout(30000) });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
    return body;
  };
  try {
    let ready = false;
    for (let attempt = 0; attempt < 40 && !ready; attempt += 1) {
      if (server.exitCode !== null) throw new Error('O servidor local não iniciou.');
      try { ready = (await fetch(base)).ok; } catch (_) { await new Promise(resolve => setTimeout(resolve, 250)); }
    }
    if (!ready) throw new Error('Tempo esgotado ao iniciar o servidor local.');

    const citiesByState = new Map();
    let nextState = 0;
    const stateWorkers = Array.from({ length: 3 }, async () => {
      while (nextState < states.length) {
        const uf = states[nextState++];
        try {
          const result = await request(`/api/tudoradio/cities?uf=${uf}`);
          citiesByState.set(uf, (result.cities || []).map(city => ({ ...city, state: uf })));
          console.log(`${uf}: ${citiesByState.get(uf).length} cidades`);
        } catch (error) { console.warn(`${uf}: ${error.message}`); }
      }
    });
    await Promise.all(stateWorkers);

    const cities = Array.from(citiesByState.values()).flat();
    if (!cities.length) throw new Error('O catálogo não retornou nenhuma cidade; nenhum arquivo foi sobrescrito.');
    const outputRoot = path.join(root, 'data', 'tudoradio');
    const citiesDir = path.join(outputRoot, 'cities');
    await fs.mkdir(citiesDir, { recursive: true });
    let nextCity = 0;
    let written = 0;
    const writtenCityPaths = new Set();
    const cityWorkers = Array.from({ length: 4 }, async () => {
      while (nextCity < cities.length) {
        const city = cities[nextCity++];
        const id = city.path.split('/').pop();
        try {
          const result = await request(`/api/tudoradio/city?id=${encodeURIComponent(id)}`);
          await fs.writeFile(path.join(citiesDir, `${id}.json`), `${JSON.stringify(result)}\n`, 'utf8');
          writtenCityPaths.add(city.path);
          written += 1;
          if (written % 25 === 0) console.log(`Cidades gravadas: ${written}/${cities.length}`);
        } catch (error) { console.warn(`${city.slug}: ${error.message}`); }
      }
    });
    await Promise.all(cityWorkers);
    const index = { source: 'Tudo Rádio Dials', generatedAt: new Date().toISOString(), states: states.filter(uf => citiesByState.has(uf)), cities: cities.filter(city => writtenCityPaths.has(city.path)) };
    await fs.writeFile(path.join(outputRoot, 'index.json'), `${JSON.stringify(index)}\n`, 'utf8');
    console.log(`Catálogo estático pronto: ${written} cidades, ${index.states.length} UFs em ${path.relative(root, outputRoot)}.`);
  } finally {
    server.kill();
  }
}

run().catch(error => { console.error(`Falha ao gerar o catálogo Dials estático: ${error.message}`); process.exitCode = 1; });
