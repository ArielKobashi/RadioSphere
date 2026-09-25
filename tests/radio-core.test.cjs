const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');

function loadBrowserScript(relativePath, additions = {}) {
  const storage = new Map();
  const sandbox = {
    URL,
    URLSearchParams,
    AbortController,
    Date,
    Map,
    Math,
    Promise,
    setTimeout,
    clearTimeout,
    console,
    fetch: async () => { throw new Error('Unexpected network request in unit test'); },
    localStorage: {
      getItem: key => storage.has(key) ? storage.get(key) : null,
      setItem: (key, value) => storage.set(key, value),
      removeItem: key => storage.delete(key)
    },
    navigator: { onLine: true },
    document: { hidden: false, addEventListener() {} },
    window: {
      WRG_CONFIG: { radioBrowser: { cacheTtlMs: 300000, maxPageSize: 1000, catalogBatchDelayMs: 0 }, nominatim: { cacheTtlMs: 86400000 } },
      location: { protocol: 'https:', href: 'https://app.example/' },
      addEventListener() {}, matchMedia: () => ({ matches: false, addEventListener() {} })
    },
    ...additions
  };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(root, relativePath), 'utf8'), sandbox, { filename: relativePath });
  return sandbox;
}

const apiContext = loadBrowserScript('js/radioApi.js');
const RadioApiClient = apiContext.window.RadioApiClient;

test('normaliza coordenadas, URL HTTPS e campos de estação', () => {
  const station = Object.create(RadioApiClient.prototype).normalizeStation({
    stationuuid: 'station-1', name: 'Radio Central', url_resolved: 'https://radio.example/stream',
    geo_lat: '-23.5', geo_long: '-46.6', country: 'Brazil', countrycode: 'br',
    codec: 'mp3', bitrate: '128', votes: '5', tags: 'rock,pop'
  });
  assert.equal(station.lat, -23.5);
  assert.equal(station.lon, -46.6);
  assert.equal(station.hasValidCoords, true);
  assert.equal(station.hasStream, true);
  assert.equal(station.isHttps, true);
  assert.deepEqual(Array.from(station.tags), ['rock', 'pop']);
});

test('mantém estações sem coordenadas ou stream sem fabricar dados', () => {
  const station = Object.create(RadioApiClient.prototype).normalizeStation({
    stationuuid: 'station-2', name: 'Community Radio', url: '', geo_lat: '', geo_long: ''
  });
  assert.equal(station.hasValidCoords, false);
  assert.equal(station.lat, null);
  assert.equal(station.hasStream, false);
  assert.equal(station.streamUrl, null);
});

test('rejeita esquemas de URL que não sejam HTTP(S)', () => {
  const client = Object.create(RadioApiClient.prototype);
  assert.equal(client.safeHttpUrl('javascript:alert(1)'), null);
  assert.equal(client.safeHttpUrl('https://user:pass@example.test/stream'), null);
  assert.equal(client.safeHttpUrl('https://example.test/stream'), 'https://example.test/stream');
});

test('usa cache da resposta de API até o TTL expirar', async () => {
  let requests = 0;
  const context = loadBrowserScript('js/radioApi.js', {
    fetch: async () => {
      requests++;
      return { ok: true, status: 200, json: async () => [{ value: 7 }] };
    }
  });
  const client = Object.assign(Object.create(context.window.RadioApiClient.prototype), {
    activeMirror: 'https://mirror.example', mirrors: ['https://mirror.example'],
    cache: new Map(), cacheTtlMs: 300000, requestTimeoutMs: 1000, requestHeaders: { Accept: 'application/json' }
  });
  const first = await client._fetchWithFailover('/json/example', { limit: 2 });
  const second = await client._fetchWithFailover('/json/example', { limit: 2 });
  assert.equal(requests, 1);
  assert.deepEqual(Array.from(first), [{ value: 7 }]);
  assert.deepEqual(Array.from(second), [{ value: 7 }]);
});

test('consulta estatísticas reais do catálogo e preserva campos ausentes como nulos', async () => {
  const context = loadBrowserScript('js/radioApi.js');
  const client = Object.assign(Object.create(context.window.RadioApiClient.prototype), {
    _fetchWithFailover: async endpoint => {
      assert.equal(endpoint, '/json/stats');
      return { stations: '12345', stations_broken: '678', countries: '91' };
    }
  });
  const stats = await client.getGlobalStats();
  assert.equal(stats.totalStations, 12345);
  assert.equal(stats.brokenStations, 678);
  assert.equal(stats.countries, 91);
  assert.equal(stats.languages, null);
});

test('envia paginação e permite pedir registros com falha para diagnóstico', async () => {
  const context = loadBrowserScript('js/radioApi.js');
  let request;
  const client = Object.assign(Object.create(context.window.RadioApiClient.prototype), {
    _fetchWithFailover: async (endpoint, params) => { request = { endpoint, params }; return []; }
  });
  await client.searchStations({ offset: 2000, limit: 1000, hasGeoOnly: false, hideBroken: false });
  assert.equal(request.endpoint, '/json/stations/search');
  assert.equal(request.params.offset, 2000);
  assert.equal(request.params.limit, 1000);
  assert.equal(request.params.hidebroken, 'false');
});

test('busca sem exigir coordenadas consulta qualquer estação', async () => {
  const context = loadBrowserScript('js/radioApi.js');
  let params;
  const client = Object.assign(Object.create(context.window.RadioApiClient.prototype), {
    _fetchWithFailover: async (_endpoint, query) => { params = query; return []; }
  });
  await client.searchStations({ name: 'community', hasGeoOnly: false });
  assert.equal(Object.hasOwn(params, 'has_geo_info'), false);
  await client.searchStations({ name: 'located', hasGeoOnly: true });
  assert.equal(params.has_geo_info, 'true');
});

test('carrega o catálogo completo em páginas limitadas, deduplica streams e mede cobertura', async () => {
  const context = loadBrowserScript('js/radioApi.js');
  const RadioApi = context.window.RadioApiClient;
  const client = Object.assign(Object.create(RadioApi.prototype), {
    catalogLoadPromise: null,
    catalogStations: new Map(),
    _readCatalogCache: async () => ({ pages: [], meta: null }),
    _writeCatalogPage: async () => true,
    _writeCatalogMeta: async meta => { client.savedMeta = meta; return true; },
    getGlobalStats: async () => ({ totalStations: 205, countries: 4 }),
    activeRequests: 0,
    maxActiveRequests: 0,
    async searchStations(options) {
      assert.equal(options.hasGeoOnly, null);
      assert.equal(options.hideBroken, false);
      this.activeRequests++;
      this.maxActiveRequests = Math.max(this.maxActiveRequests, this.activeRequests);
      await new Promise(resolve => setTimeout(resolve, 1));
      const count = Math.min(100, 205 - options.offset);
      const stations = Array.from({ length: count }, (_, index) => {
        const idNumber = options.offset + index;
        return {
          id: `station-${idNumber}`, name: `Radio ${idNumber}`, country: `Country ${idNumber % 4}`,
          city: idNumber % 2 ? '' : `City ${idNumber % 6}`, streamUrl: `https://stream.example/${idNumber}`,
          hasStream: true, hasValidCoords: idNumber % 3 !== 0, lat: idNumber % 3 ? 35 : null, lon: idNumber % 3 ? 20 : null,
          lastCheckStatus: idNumber % 5 ? 'online' : 'offline', votes: 0, tags: []
        };
      });
      if (options.offset === 100) stations[0].streamUrl = 'https://stream.example/1';
      this.activeRequests--;
      return stations;
    }
  });
  const progress = [];
  const result = await client.loadGlobalCatalog({ pageSize: 100, onProgress: item => progress.push(item.phase) });
  assert.deepEqual(Array.from(client.catalogStations.keys()).slice(0, 2), ['station-0', 'station-1']);
  assert.equal(result.complete, true);
  assert.equal(result.rawReceived, 205);
  assert.equal(result.received, 204);
  assert.equal(client.catalogDuplicatesRemoved, 1);
  assert.equal(client.maxActiveRequests, 2);
  assert.equal(client.savedMeta.complete, true);
  assert.ok(progress.includes('loading'));
  const diagnostics = client.getCatalogDiagnostics();
  assert.equal(diagnostics.valid, 204);
  assert.equal(diagnostics.duplicateStreamsRemoved, 1);
  assert.ok(diagnostics.withCoordinates > 0);
  assert.ok(diagnostics.regions.Europa > 0);
});

test('reutiliza páginas completas e ainda válidas do cache sem baixar o catálogo novamente', async () => {
  const context = loadBrowserScript('js/radioApi.js');
  const expiresAt = Date.now() + 60_000;
  let requests = 0;
  const stations = [{ id: 'cached-1', name: 'Cached Radio', country: 'Brasil', streamUrl: 'https://cache.example/live', hasStream: true, hasValidCoords: false, lat: null, lon: null, lastCheckStatus: 'unknown', votes: 0, tags: [] }];
  const client = Object.assign(Object.create(context.window.RadioApiClient.prototype), {
    catalogLoadPromise: null,
    catalogStations: new Map(),
    _readCatalogCache: async () => ({
      pages: [{ offset: 0, stations, updatedAt: Date.now() }],
      meta: { key: 'catalog', complete: true, total: 1, expiresAt }
    }),
    getGlobalStats: async () => ({ totalStations: 1 }),
    searchStations: async () => { requests++; return []; }
  });
  const result = await client.loadGlobalCatalog({ pageSize: 100 });
  assert.equal(result.complete, true);
  assert.equal(result.cached, true);
  assert.equal(requests, 0);
  assert.equal(result.stations[0].id, 'cached-1');
});

test('cancela a varredura global antes de iniciar páginas e deixa o estado recuperável', async () => {
  const context = loadBrowserScript('js/radioApi.js');
  const controller = new AbortController();
  const client = Object.assign(Object.create(context.window.RadioApiClient.prototype), {
    catalogLoadPromise: null, catalogStations: new Map(),
    _readCatalogCache: async () => ({ pages: [], meta: null }),
    getGlobalStats: async () => ({ totalStations: 50_000 }),
    searchStations: async () => { throw new Error('Não deveria iniciar requisições de páginas'); }
  });
  const result = await client.loadGlobalCatalog({ signal: controller.signal, onProgress: progress => {
    if (progress.phase === 'loading') controller.abort();
  } });
  assert.equal(result.phase, 'cancelled');
  assert.equal(result.received, 0);
});

test('deduplica resultados combinados na busca', async () => {
  const context = loadBrowserScript('js/utils.js');
  context.window.Utils = vm.runInContext('Utils', context);
  context.window.SearchManager = undefined;
  vm.runInContext(fs.readFileSync(path.join(root, 'js/search.js'), 'utf8'), context);
  const station = { id: 'same', name: 'Station', hasValidCoords: true, lat: 1, lon: 2, hasStream: true };
  const api = {
    searchStations: async () => [station],
    geocodeLocation: async () => []
  };
  const result = await new context.window.SearchManager(api).search('station');
  assert.equal(result.stations.length, 1);
  assert.equal(result.stations[0].id, 'same');
});

test('busca continua funcionando quando provedor IPRD é opcional', async () => {
  const context = loadBrowserScript('js/utils.js');
  context.window.Utils = vm.runInContext('Utils', context);
  vm.runInContext(fs.readFileSync(path.join(root, 'js/search.js'), 'utf8'), context);
  const station = { id: 'rb-1', name: 'Local FM', streamUrl: 'https://radio.example/live' };
  const manager = new context.window.SearchManager({
    searchStations: async options => options.name ? [station] : [],
    geocodeLocation: async () => []
  });
  const result = await manager.search('local');
  assert.equal(result.stations.length, 1);
});

test('busca local encontra estações do catálogo completo sem coordenadas', async () => {
  const context = loadBrowserScript('js/utils.js');
  context.window.Utils = vm.runInContext('Utils', context);
  vm.runInContext(fs.readFileSync(path.join(root, 'js/search.js'), 'utf8'), context);
  const manager = new context.window.SearchManager({
    searchStations: async () => [], geocodeLocation: async () => [], searchIprdStations: async () => []
  });
  manager.setCatalog([{ id: 'no-geo', name: 'Remote Community Radio', country: 'Islandia', hasValidCoords: false, streamUrl: 'https://radio.example/live' }]);
  const result = await manager.search('community');
  assert.equal(result.stations.length, 1);
  assert.equal(result.stations[0].hasValidCoords, false);
});

test('deduplicação da busca une provedores por nome e localização e conserva o registro mais rico', () => {
  const context = loadBrowserScript('js/utils.js');
  context.window.Utils = vm.runInContext('Utils', context);
  vm.runInContext(fs.readFileSync(path.join(root, 'js/search.js'), 'utf8'), context);
  const manager = new context.window.SearchManager({});
  const merged = manager.dedupeStations([
    { id: 'iprd-1', name: 'Radio Aurora', country: 'Brasil', state: 'São Paulo', source: 'IPRD', tags: ['jazz'], streamUrl: 'https://one.example/live' },
    { id: 'rb-1', name: 'Radio Aurora', country: 'Brasil', state: 'São Paulo', source: 'Radio Browser', tags: ['news'], streamUrl: 'https://two.example/live', hasValidCoords: true, lat: -23, lon: -46 }
  ]);
  assert.equal(merged.stations.length, 1);
  assert.equal(merged.stations[0].id, 'rb-1');
  assert.equal(merged.stations[0].hasValidCoords, true);
  assert.deepEqual(Array.from(merged.stations[0].tags).sort(), ['jazz', 'news']);
  assert.equal(merged.duplicateCount, 1);
});

test('distância Haversine considera corretamente pontos próximos', () => {
  const context = loadBrowserScript('js/utils.js');
  context.window.Utils = vm.runInContext('Utils', context);
  assert.equal(context.window.Utils.haversineDistance(-23.55, -46.63, -23.56, -46.64), 2);
});

test('armazenamento local preserva favoritos entre leituras', () => {
  const context = loadBrowserScript('js/utils.js');
  context.window.Utils = vm.runInContext('Utils', context);
  const favorites = [{ id: 'station-1', name: 'Radio Central' }];
  assert.equal(context.window.Utils.storage.set('wrg_favorites', favorites), true);
  assert.deepEqual(JSON.parse(JSON.stringify(context.window.Utils.storage.get('wrg_favorites'))), favorites);
});

test('player transita para PLAYING e recusa estação sem URL de transmissão', async () => {
  class AudioStub {
    constructor() { this.events = new Map(); this.volume = 1; this.src = ''; this.muted = false; }
    addEventListener(name, callback) { this.events.set(name, callback); }
    pause() { this.events.get('pause')?.(); }
    removeAttribute(name) { if (name === 'src') this.src = ''; }
    load() {}
    play() { return Promise.resolve(); }
  }
  const context = loadBrowserScript('js/utils.js', { Audio: AudioStub });
  context.window.Utils = vm.runInContext('Utils', context);
  vm.runInContext(fs.readFileSync(path.join(root, 'js/player.js'), 'utf8'), context);
  const player = new context.window.AudioPlayerManager();
  const states = [];
  player.onStateChange = state => states.push(state.state);
  await player.playStation({ id: 'station-1', hasStream: true, streamUrl: 'https://radio.example/live' });
  assert.equal(states.includes('PLAYING'), true);
  player.stop();
  assert.equal(states.at(-1), 'STOPPED');
  player.selectStation({ id: 'station-2', hasStream: false, streamUrl: null });
  assert.equal(states.at(-1), 'ERROR');
});

test('player não força modo CORS e pause cancela tentativas de reconexão', async () => {
  class AudioStub {
    constructor() { this.events = new Map(); this.volume = 1; this.src = ''; this.muted = false; this.crossOrigin = ''; }
    addEventListener(name, callback) { this.events.set(name, callback); }
    pause() { this.events.get('pause')?.(); }
    removeAttribute(name) { if (name === 'src') this.src = ''; }
    load() {}
    play() { return Promise.resolve(); }
  }
  const context = loadBrowserScript('js/utils.js', { Audio: AudioStub });
  context.window.Utils = vm.runInContext('Utils', context);
  vm.runInContext(fs.readFileSync(path.join(root, 'js/player.js'), 'utf8'), context);
  const player = new context.window.AudioPlayerManager();
  player.triggerReconnect();
  assert.ok(player.reconnectTimer);
  player.pause();
  assert.equal(player.reconnectTimer, null);
  assert.equal(player.audio.crossOrigin, '');
});

test('visualizador não fabrica amostras quando WebAudio não consegue ler o stream', () => {
  const context = loadBrowserScript('js/utils.js');
  context.window.Utils = vm.runInContext('Utils', context);
  vm.runInContext(fs.readFileSync(path.join(root, 'js/audioVisualizer.js'), 'utf8'), context);
  const viz = Object.assign(Object.create(context.window.AudioVisualizer.prototype), {
    state: { getState: () => ({ playbackState: 'PLAYING' }) },
    audio: { volume: 1, muted: false }, hasDirectAudioNode: false, analyser: null,
    freqData: new Uint8Array(4).fill(127), timeData: new Uint8Array(4).fill(0)
  });
  viz._updateAudioData();
  assert.deepEqual(Array.from(viz.freqData), [0, 0, 0, 0]);
  assert.deepEqual(Array.from(viz.timeData), [128, 128, 128, 128]);
});

test('resultado atrasado de uma sintonia não substitui a estação mais recente', async () => {
  const playPromises = [];
  class AudioStub {
    constructor() { this.events = new Map(); this.volume = 1; this.src = ''; this.muted = false; this.crossOrigin = ''; }
    addEventListener(name, callback) { this.events.set(name, callback); }
    pause() { this.events.get('pause')?.(); }
    removeAttribute(name) { if (name === 'src') this.src = ''; }
    load() {}
    play() { return new Promise(resolve => playPromises.push(resolve)); }
  }
  const context = loadBrowserScript('js/utils.js', { Audio: AudioStub });
  context.window.Utils = vm.runInContext('Utils', context);
  vm.runInContext(fs.readFileSync(path.join(root, 'js/player.js'), 'utf8'), context);
  const player = new context.window.AudioPlayerManager();
  player.onStateChange = () => {};
  const first = player.playStation({ id: 'old', streamUrl: 'https://old.example/live' });
  const second = player.playStation({ id: 'new', streamUrl: 'https://new.example/live' });
  playPromises[1]();
  await second;
  playPromises[0]();
  await first;
  assert.equal(player.currentStation.id, 'new');
  assert.equal(player.isPlaying, true);
});

test('metadata sem faixa mantém estado desconhecido sem inventar título', () => {
  const context = loadBrowserScript('js/metadataManager.js');
  let state;
  const manager = Object.create(context.window.MetadataManager.prototype);
  manager.state = { getState: () => ({ playbackState: 'PLAYING' }), setState: value => { state = value; } };
  manager._applyFallbackLiveState({ country: 'Brasil' });
  assert.equal(state.currentTrack.title, '');
  assert.equal(state.currentTrack.source, 'none');
  assert.equal(state.currentTrack.confidence, 'unavailable');
});

test('carrega todas as páginas brasileiras até a última página curta', async () => {
  const context = loadBrowserScript('js/radioApi.js');
  const client = Object.create(context.window.RadioApiClient.prototype);
  const offsets = [];
  client.searchStations = async options => {
    offsets.push(options.offset);
    assert.equal(options.countryCode, 'BR');
    assert.equal(options.hasGeoOnly, false);
    assert.equal(options.hideBroken, false);
    return options.offset === 0
      ? Array.from({ length: 1000 }, (_, index) => ({ id: `br-${index}`, name: `Radio ${index}` }))
      : options.offset === 1000
        ? Array.from({ length: 23 }, (_, index) => ({ id: `br-${1000 + index}`, name: `Radio ${index}` }))
        : [];
  };
  const progress = [];
  const stations = await client.loadCountryStations('br', { onProgress: value => progress.push(value) });
  assert.equal(stations.length, 1023);
  assert.deepEqual(offsets, [0, 1000]);
  assert.equal(progress.at(-1).phase, 'ready');
});

test('reconhecimento Shazam só é chamado pela ação explícita e usa a estação atual', async () => {
  const context = loadBrowserScript('js/metadataManager.js');
  const manager = Object.create(context.window.MetadataManager.prototype);
  const station = { id: 'radio-br-1', streamUrl: 'https://radio.example/live' };
  let passed;
  let track;
  manager.currentStation = station;
  manager.abortController = null;
  manager.state = { setState() {} };
  manager.recognitionProvider = { identify: async args => { passed = args; return { title: 'Canção', artist: 'Artista' }; } };
  manager._applyTrackUpdate = result => { track = result; };
  manager._applyFallbackLiveState = () => {};
  const result = await manager.identifyCurrentStation();
  assert.equal(result.ok, true);
  assert.equal(passed.station, station);
  assert.equal(passed.signal.aborted, false);
  assert.equal(track.source, 'Reconhecimento de música');
  assert.equal(track.status, 'IDENTIFIED');
});

test('troca as quatro camadas do mapa e solicita redesenho do globo', () => {
  const layers = [];
  let redraws = 0;
  class UrlTemplateImageryProvider { constructor(options) { this.url = options.url; } }
  const context = loadBrowserScript('js/globe.js', { Cesium: { UrlTemplateImageryProvider } });
  const globePrototype = vm.runInContext('GlobeManager.prototype', context);
  const manager = Object.assign(Object.create(globePrototype), {
    currentBasemap: 'dark',
    viewer: { imageryLayers: { removeAll() { layers.length = 0; }, addImageryProvider(provider) { layers.push(provider); return provider; } } },
    scene: { requestRender() { redraws++; } }
  });
  for (const type of ['dark', 'streets', 'satellite', 'osm']) {
    assert.equal(manager.setBasemap(type), type);
    assert.match(layers[0].url, /https:\/\//);
  }
  assert.equal(manager.currentBasemap, 'osm');
  assert.equal(redraws, 4);
});

test('lista países com código e mantém o total oficial para montar o filtro', async () => {
  const context = loadBrowserScript('js/radioApi.js');
  const client = Object.create(context.window.RadioApiClient.prototype);
  client.radioCountriesPromise = null;
  client._fetchWithFailover = async path => {
    assert.equal(path, '/json/countries');
    return [{ countrycode: 'us', name: 'United States', stationcount: '1234' }, { countrycode: '', name: 'Invalid' }];
  };
  const countries = await client.getCountries();
  assert.deepEqual(Array.from(countries, country => ({ ...country })), [{ code: 'US', name: 'United States', stationCount: 1234 }]);
});

test('Capital FM Cascavel ganha link para fonte de escuta Tudo Rádio sem inventar stream', () => {
  const context = loadBrowserScript('js/radioApi.js');
  const client = Object.create(context.window.RadioApiClient.prototype);
  const station = client.normalizeStation({
    name: 'Capital FM', stationuuid: 'capital-cascavel', countrycode: 'BR', city: 'Cascavel', state: 'Paraná',
    url: '', homepage: ''
  });
  assert.equal(station.homepage, 'https://capitalfm.com.br/');
  assert.equal(station.streamUrl, null);
  assert.equal(station.listenPageUrl, 'https://tudoradio.com/player/radio/986-capital-fm');
});

test('identificador usa metadata grátis da própria estação antes do fallback acústico', async () => {
  const requests = [];
  const context = loadBrowserScript('js/shazamRecognition.js', {
    fetch: async (url, options) => {
      requests.push({ url, options });
      return { ok: true, json: async () => ({ source: 'ICY StreamTitle', track: { title: 'Faixa ao vivo', artist: 'Artista' } }) };
    }
  });
  const provider = new context.window.ShazamRecognitionProvider();
  const result = await provider.identify({ station: { id: 'radio-1', streamUrl: 'https://radio.example/live' } });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, '/api/nowplaying');
  assert.equal(result.title, 'Faixa ao vivo');
  assert.equal(result.source, 'ICY StreamTitle');
});

test('Tudo Rádio Dials valida o stream da emissora antes de consultar fontes alternativas', async () => {
  const calls = [];
  const context = loadBrowserScript('js/tudoradio.js', {
    fetch: async (url, options = {}) => {
      const request = options.body ? JSON.parse(options.body) : {};
      calls.push({ url, streamUrl: request.streamUrl || '' });
      return { ok: true, json: async () => ({ valid: true, status: 206, contentType: 'audio/mpeg', url: request.streamUrl }) };
    }
  });
  const client = new context.window.TuRadioCatalogClient();
  const dialsStation = {
    id: '986', name: 'Capital FM', frequency: 102.7, band: 'FM', state: 'PR',
    transmitterCity: 'Cascavel', receptionCity: 'Cascavel', cityPageUrl: 'https://tudoradio.com/dials/cidade/113-cascavel',
    streamUrl: 'https://audio.example/capital', listenPageUrl: 'https://tudoradio.com/player/radio/986-capital-fm'
  };
  const result = await client.validateAndResolve(dialsStation, { searchStations: async () => { throw new Error('não deveria procurar alternativa'); } });
  assert.equal(result.recordValid, true);
  assert.equal(result.streamValid, true);
  assert.equal(result.streamSource, 'Tudo Rádio Dials');
  assert.equal(result.station.dialsValidated, true);
  assert.deepEqual(calls.map(call => call.streamUrl), ['https://audio.example/capital']);
});

test('Tudo Rádio Dials só busca stream alternativo após falha e limita candidatos à mesma praça', async () => {
  const tested = [];
  const context = loadBrowserScript('js/tudoradio.js', {
    fetch: async (_url, options = {}) => {
      const input = JSON.parse(options.body || '{}');
      tested.push(input.streamUrl);
      return { ok: true, json: async () => input.streamUrl.includes('working')
        ? { valid: true, status: 200, contentType: 'audio/aacp', url: input.streamUrl }
        : { valid: false, status: 404, contentType: 'text/html', reason: 'HTTP 404' } };
    }
  });
  const client = new context.window.TuRadioCatalogClient();
  const dialsStation = {
    id: '986', name: 'Capital FM', frequency: 102.7, band: 'FM', state: 'PR',
    transmitterCity: 'Cascavel', receptionCity: 'Cascavel', cityPageUrl: 'https://tudoradio.com/dials/cidade/113-cascavel',
    streamUrl: 'https://audio.example/dead'
  };
  const radioApi = { searchStations: async () => [
    { id: 'wrong-city', name: 'Capital FM', countryCode: 'BR', city: 'Curitiba', state: 'PR', streamUrl: 'https://audio.example/wrong-working', hasValidCoords: true },
    { id: 'same-city', name: 'Capital FM', countryCode: 'BR', city: 'Cascavel', state: 'PR', streamUrl: 'https://audio.example/working', hasValidCoords: true }
  ] };
  const result = await client.validateAndResolve(dialsStation, radioApi);
  assert.equal(result.streamValid, true);
  assert.equal(result.streamSource, 'Radio Browser');
  assert.equal(result.station.id, 'same-city');
  assert.deepEqual(tested, ['https://audio.example/dead', 'https://audio.example/working']);
});

test('importação nacional do Dials lê as 27 UFs, deduplica IDs e deixa streams não testados desativados', async () => {
  const requests = [];
  const context = loadBrowserScript('js/tudoradio.js', {
    fetch: async (url) => {
      requests.push(url);
      if (url.startsWith('/api/tudoradio/cities?')) return { ok: true, json: async () => ({ cities: [{ id: '113', slug: 'cascavel', path: '/dials/cidade/113-cascavel' }] }) };
      return { ok: true, json: async () => ({ city: { name: 'Cascavel', state: 'PR' }, stations: [
        { id: '986', name: 'Capital FM', frequency: 102.7, band: 'FM', state: 'PR', transmitterCity: 'Cascavel', receptionCity: 'Cascavel',
          streamUrl: 'https://audio.example/capital', homepage: 'https://capitalfm.com.br/', cityPageUrl: 'https://tudoradio.com/dials/cidade/113-cascavel',
          listenPageUrl: 'https://tudoradio.com/player/radio/986-capital-fm', detailsUrl: 'https://tudoradio.com/dials/emissora/986-capital-fm', technical: {} }
      ] }) };
    }
  });
  const client = new context.window.TuRadioCatalogClient();
  const result = await client.loadNationalCatalog({ concurrency: 6 });
  assert.equal(result.statesLoaded, 27);
  assert.equal(result.cities.length, 1);
  assert.equal(result.stations.length, 1);
  assert.equal(requests.filter(url => url.startsWith('/api/tudoradio/cities?')).length, 27);
  const unverified = client.toUnverifiedStation(result.stations[0]);
  assert.equal(unverified.streamUrl, null);
  assert.equal(unverified.hasStream, false);
  assert.equal(unverified.dialsCandidateStreamUrl, 'https://audio.example/capital');
});
