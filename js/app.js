/**
 * WORLD RADIO GLOBE — Aplicação Principal (app.js)
 * Orquestrador Completo: Estado Central, Player 8 Estados, Visualizador, Metadados Now Playing,
 * Animações de Voo, PWA, Modo Offline e Compatibilidade Mobile.
 */

document.addEventListener('DOMContentLoaded', () => {
  console.log('[App] Inicializando World Radio Globe...');

  // 1. Instancia Gerenciadores do Sistema (na ordem correta de dependência)
  const globe = new GlobeManager('cesiumContainer');
  const radioApi = new RadioApiClient();
  const tuRadioCatalog = new TuRadioCatalogClient();
  const searchManager = new SearchManager(radioApi);
  // AppStateManager foi criado em state.js como window.appState
  const audioPlayer = new AudioPlayerManager(window.appState);

  window.globe = globe;
  window.radioApi = radioApi;
  window.tuRadioCatalog = tuRadioCatalog;
  window.audioPlayer = audioPlayer;

  // Visualizador: inicializa com o canvas do player
  const vizCanvas = document.getElementById('audioVisualizerCanvas');
  const visualizer = new AudioVisualizer(vizCanvas, audioPlayer.getAudioElement(), window.appState);
  window.visualizer = visualizer;

  // Metadados Now Playing
  const metadataManager = new MetadataManager(window.appState);
  metadataManager.setRecognitionProvider(new ShazamRecognitionProvider());
  window.metadataManager = metadataManager;

  // Registra Service Worker (PWA)
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').then(() => {
      console.log('[SW] Service Worker registrado com sucesso.');
    }).catch(err => {
      console.warn('[SW] Falha ao registrar Service Worker:', err);
    });
  }

  // Estado Atual da Aplicação
  let currentStation = null;
  let favorites = Utils.storage.get('wrg_favorites', []);
  if (!Array.isArray(favorites)) favorites = [];
  let playHistory = Utils.storage.get('wrg_play_history', []);
  if (!Array.isArray(playHistory)) playHistory = [];
  playHistory = playHistory.filter(entry => entry?.station?.id);
  let lastHistoryRecord = { stationId: '', timestamp: 0 };
  let allLoadedStations = new Map();
  const priorityStationIds = new Set();
  let radioCountries = [];
  let radioCountriesPromise = null;
  let activeStationFilters = { country: '', state: '', language: '', genre: '', codec: '', minBitrate: '' };

  // 2. Elementos de Interface do Usuário (HUD)
  const hudUtcTime = document.getElementById('hudUtcTime');
  const hudLocalTime = document.getElementById('hudLocalTime');
  const hudCoords = document.getElementById('hudCoords');
  const hudAltitude = document.getElementById('hudAltitude');
  const sysStatusText = document.getElementById('sysStatusText');
  const sysStatusDot = document.querySelector('.status-indicator .status-dot');
  const stationCatalogCount = document.getElementById('stationCatalogCount');
  const globalSearchInput = document.getElementById('globalSearchInput');
  const globalSearchForm = document.getElementById('globalSearchForm');
  const searchResults = document.getElementById('searchResults');
  const exploreCard = document.getElementById('exploreCard');
  const dismissExploreButton = document.getElementById('dismissExplore');
  const exploreSearchButton = document.getElementById('exploreSearch');
  const exploreRandomButton = document.getElementById('exploreRandom');
  const exploreTourButton = document.getElementById('exploreTour');

  function dismissExplore(remember = true) {
    if (!exploreCard) return;
    exploreCard.hidden = true;
    if (remember) Utils.storage.set('wrg_explore_dismissed', true);
  }

  function setSystemStatus(label, state = 'online') {
    if (sysStatusText) sysStatusText.textContent = label;
    if (sysStatusDot) {
      sysStatusDot.classList.remove('online', 'loading', 'offline');
      sysStatusDot.classList.add(state);
    }
  }

  if (exploreCard && !Utils.storage.get('wrg_explore_dismissed', false)) {
    exploreCard.hidden = false;
  }
  dismissExploreButton?.addEventListener('click', () => dismissExplore());
  exploreSearchButton?.addEventListener('click', () => {
    dismissExplore();
    globalSearchInput?.focus();
  });
  exploreRandomButton?.addEventListener('click', () => {
    dismissExplore();
    btnRandomStation?.click();
  });
  exploreTourButton?.addEventListener('click', () => {
    dismissExplore();
    btnWorldTour?.click();
  });

  // Controles de Simulação 4D (Tempo Solar)
  const btnTimePlayPause = document.getElementById('btnTimePlayPause');
  const iconTimeState = document.getElementById('iconTimeState');
  const btnTimeReverse = document.getElementById('btnTimeReverse');
  const btnTimeForward = document.getElementById('btnTimeForward');
  const btnTimeSyncReal = document.getElementById('btnTimeSyncReal');
  const speedPills = document.querySelectorAll('.speed-pill');

  // Tooltip e Indicador de Varredura
  const globeTooltip = document.getElementById('globeTooltip');
  const tooltipTitle = document.getElementById('tooltipTitle');
  const tooltipLoc = document.getElementById('tooltipLoc');
  const tooltipTag = document.getElementById('tooltipTag');
  const markerLoadingIndicator = document.getElementById('markerLoadingIndicator');

  // Painéis e Player
  const stationPanel = document.getElementById('stationPanel');
  const btnPlayPause = document.getElementById('btnPlayPause');
  const playerStatusText = document.getElementById('playerStatusText');
  const stationNameDisplay = document.getElementById('playerStationName');
  const stationNowPlaying = document.getElementById('playerNowPlaying');
  window.appState.subscribeKey('currentTrack', track => {
    if (!stationNowPlaying) return;
    if (track?.title) {
      const label = [track.artist, track.title].filter(Boolean).join(' — ');
      stationNowPlaying.textContent = track.confidence === 'possible' ? `Possível faixa: ${label}` : label;
      stationNowPlaying.classList.add('has-track');
      stationNowPlaying.dataset.source = track.source || 'unknown';
      updateRadioDiagnostics();
      return;
    }
    const playback = window.appState.getState().playbackState;
    stationNowPlaying.textContent = playback === 'PLAYING'
      ? track?.status === 'SEARCHING' ? 'Buscando informações da faixa…' : 'Música não identificada'
      : '';
    stationNowPlaying.classList.remove('has-track');
    stationNowPlaying.dataset.source = 'unknown';
    updateRadioDiagnostics();
  });
  const stationGeoDisplay = document.getElementById('playerGeoDisplay');
  const stationLogoThumb = document.getElementById('playerLogoThumb');
  const radioWaveBars = document.getElementById('radioWaveBars');
  const radioPlayerBar = document.getElementById('radioPlayerBar');
  const volumeSlider = document.getElementById('volumeSlider');
  const btnMuteToggle = document.getElementById('btnMuteToggle');
  const btnPlayerFavorite = document.getElementById('btnPlayerFavorite');
  const btnCycleVisualizer = document.getElementById('btnCycleVisualizer');

  // Botões de Ação do HUD
  const btnResetView = document.getElementById('btnResetView');
  const btnSwitchBasemap = document.getElementById('btnSwitchBasemap');
  const tooltipBasemap = document.getElementById('tooltipBasemap');
  const basemapMenu = document.getElementById('basemapMenu');
  const basemapButtons = document.querySelectorAll('[data-basemap]');
  const btnZoomIn = document.getElementById('btnZoomIn');
  const btnZoomOut = document.getElementById('btnZoomOut');
  const btnToggleClustering = document.getElementById('btnToggleClustering');
  const tooltipClustering = document.getElementById('tooltipClustering');
  const btnToggleLighting = document.getElementById('btnToggleLighting');
  const btnRandomStation = document.getElementById('btnRandomStation');
  const btnWorldTour = document.getElementById('btnWorldTour');
  const btnOpenLibrary = document.getElementById('btnOpenLibrary');
  const btnOpenFilters = document.getElementById('btnOpenFilters');
  const btnConfigToken = document.getElementById('btnConfigToken');
  const utilityPanel = document.getElementById('utilityPanel');
  const utilityPanelTitle = document.getElementById('utilityPanelTitle');
  const utilityPanelContent = document.getElementById('utilityPanelContent');
  let utilityMode = '';
  let catalogPageIndex = 0;
  let libraryTab = 'favorites';
  const brazilianStates = [
    ['AC', 'Acre'], ['AL', 'Alagoas'], ['AP', 'Amapá'], ['AM', 'Amazonas'], ['BA', 'Bahia'], ['CE', 'Ceará'], ['DF', 'Distrito Federal'],
    ['ES', 'Espírito Santo'], ['GO', 'Goiás'], ['MA', 'Maranhão'], ['MT', 'Mato Grosso'], ['MS', 'Mato Grosso do Sul'], ['MG', 'Minas Gerais'],
    ['PA', 'Pará'], ['PB', 'Paraíba'], ['PR', 'Paraná'], ['PE', 'Pernambuco'], ['PI', 'Piauí'], ['RJ', 'Rio de Janeiro'], ['RN', 'Rio Grande do Norte'],
    ['RS', 'Rio Grande do Sul'], ['RO', 'Rondônia'], ['RR', 'Roraima'], ['SC', 'Santa Catarina'], ['SP', 'São Paulo'], ['SE', 'Sergipe'], ['TO', 'Tocantins']
  ];
  let tuRadioSelectedUf = 'PR';
  let tuRadioCities = [];
  let tuRadioLoadingCities = false;
  let tuRadioSelectedCityPath = '';
  let tuRadioCityStations = [];
  let tuRadioResults = new Map();
  let tuRadioNationalStations = [];
  let tuRadioSearchStations = [];
  let tuRadioNationalCities = [];
  let tuRadioNationalCachePresent = false;
  let tuRadioNationalCacheCheckStarted = false;
  let tuRadioNationalController = null;
  let tuRadioProgress = '';
  let tuRadioBusy = new Set();
  let tuRadioBatchController = null;
  let isDialsResolvingCurrent = false;

  function escape(value) { return Utils.escapeHtml(value ?? ''); }

  function stationRecord(station) {
    return {
      id: station.id, name: station.name, state: station.state, country: station.country,
      streamUrl: station.streamUrl, hasStream: station.hasStream ?? Boolean(station.streamUrl),
      hasValidCoords: station.hasValidCoords ?? (Number.isFinite(station.lat) && Number.isFinite(station.lon)),
      lat: station.lat, lon: station.lon, codec: station.codec, bitrate: station.bitrate,
      votes: station.votes, language: station.language, tags: station.tags || [],
      favicon: station.favicon, isHttps: station.isHttps, homepage: station.homepage,
      source: station.source, listenPageUrl: station.listenPageUrl, dialsSourceRecord: station.dialsSourceRecord,
      dialsValidated: station.dialsValidated, dialsFrequency: station.dialsFrequency, dialsBand: station.dialsBand,
      dialsSignal: station.dialsSignal, dialsRds: station.dialsRds, dialsClassAndCallsign: station.dialsClassAndCallsign,
      dialsTechnical: station.dialsTechnical, dialsDetailsUrl: station.dialsDetailsUrl, dialsCityPageUrl: station.dialsCityPageUrl
    };
  }

  function recordHistory(station) {
    if (!station?.id) return;
    const now = Date.now();
    if (lastHistoryRecord.stationId === station.id && now - lastHistoryRecord.timestamp < 120000) return;
    lastHistoryRecord = { stationId: station.id, timestamp: now };
    playHistory = [{ station: stationRecord(station), playedAt: new Date(now).toISOString() },
      ...playHistory.filter(entry => entry.station?.id !== station.id)].slice(0, 50);
    Utils.storage.set('wrg_play_history', playHistory);
    if (utilityMode === 'history') renderUtilityPanel('history');
  }

  function stationImage(station, className = 'library-station-art') {
    let favicon = '';
    try {
      const url = new URL(station.favicon || '');
      if (url.protocol === 'https:' || url.protocol === 'http:') favicon = escape(url.href);
    } catch (_) { /* Usa o símbolo local quando a estação não tem logo válido. */ }
    return favicon
      ? `<img class="${className}" src="${favicon}" alt="" loading="lazy">`
      : `<span class="${className} library-art-fallback" aria-hidden="true"><svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="2"></circle><path d="M16.2 7.8a6 6 0 0 1 0 8.4m-8.4 0a6 6 0 0 1 0-8.4M19 5a10 10 0 0 1 0 14M5 19A10 10 0 0 1 5 5"></path></svg></span>`;
  }

  function getFilteredStations() {
    const filters = activeStationFilters;
    return Array.from(allLoadedStations.values()).filter(station => {
      const matches = (value, filter) => !filter || String(value || '').toLowerCase().includes(filter.toLowerCase());
      if (filters.country && String(station.countryCode || station.country || '').toLowerCase() !== filters.country.toLowerCase() && String(station.country || '').toLowerCase() !== filters.country.toLowerCase()) return false;
      if (!matches(station.state, filters.state) || !matches(station.language, filters.language)) return false;
      if (filters.genre && !(station.tags || []).some(tag => matches(tag, filters.genre))) return false;
      if (filters.codec && String(station.codec || '').toLowerCase() !== filters.codec.toLowerCase()) return false;
      if (filters.minBitrate && Number(station.bitrate || 0) < Number(filters.minBitrate)) return false;
      return true;
    });
  }

  function refreshGlobeStations() {
    globe.setStations(getFilteredStations());
  }

  function rememberMapStation(station) {
    if (!station?.id) return;
    allLoadedStations.set(station.id, station);
    const maxStations = window.WRG_CONFIG?.radioBrowser.stationMemoryLimit || 5000;
    if (allLoadedStations.size > maxStations) {
      for (const id of allLoadedStations.keys()) {
        if (allLoadedStations.size <= maxStations) break;
        if (id !== currentStation?.id && !priorityStationIds.has(id)) allLoadedStations.delete(id);
      }
    }
  }

  function normalizePlace(value) {
    return String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  }

  async function renderDialsCityPins(cities, signal = null, onProgress = () => {}, geocodeMissing = true) {
    const counts = new Map();
    for (const station of tuRadioNationalStations) counts.set(station.cityPageUrl, (counts.get(station.cityPageUrl) || 0) + 1);
    const stateName = code => brazilianStates.find(([uf]) => uf === code)?.[1] || code;
    let completed = 0;
    let added = 0;
    for (const city of cities) {
      if (signal?.aborted) break;
      const id = city.path.split('/').pop();
      let coordinates = await tuRadioCatalog.getCityCoordinates(id);
      if ((!coordinates || !Number.isFinite(coordinates.lat) || !Number.isFinite(coordinates.lon)) && geocodeMissing) {
        const cityName = city.slug.replace(/^\d+-/, '').replace(/-[a-z]{2}$/i, '').replace(/-/g, ' ');
        const query = `${cityName}, ${stateName(city.state)}, Brasil`;
        const existing = [...allLoadedStations.values()].filter(station => station.countryCode === 'BR' &&
          normalizePlace(station.state) === normalizePlace(stateName(city.state)) &&
          normalizePlace(station.city) === normalizePlace(cityName) && station.hasValidCoords);
        if (existing.length) {
          coordinates = { lat: existing.reduce((sum, station) => sum + station.lat, 0) / existing.length,
            lon: existing.reduce((sum, station) => sum + station.lon, 0) / existing.length, source: 'Radio Browser' };
        } else {
          const requestedState = normalizePlace(stateName(city.state));
          const place = (await radioApi.geocodeLocation(query)).find(item => {
            const resultState = normalizePlace(item.state);
            return item.countryCode === 'BR' && (!resultState || resultState.includes(requestedState) || requestedState.includes(resultState));
          });
          if (place && Number.isFinite(place.lat) && Number.isFinite(place.lon)) {
            coordinates = { lat: place.lat, lon: place.lon, source: 'OpenStreetMap Nominatim' };
          }
        }
        if (coordinates) await tuRadioCatalog.saveCityCoordinates(id, coordinates);
      }
      if (coordinates && Number.isFinite(coordinates.lat) && Number.isFinite(coordinates.lon)) {
        const cityName = city.slug.replace(/^\d+-/, '').replace(/-[a-z]{2}$/i, '').replace(/-/g, ' ');
        const stationCount = counts.get(`https://tudoradio.com${city.path}`) || 0;
        rememberMapStation({
          id: `dials-city-${id}`, name: `${cityName} · ${stationCount} rádios`, city: cityName,
          state: city.state, country: 'Brasil', countryCode: 'BR', lat: coordinates.lat, lon: coordinates.lon,
          hasValidCoords: true, hasStream: false, streamUrl: null, source: 'Tudo Rádio Dials · centro da cidade',
          isDialsCityHub: true, dialsCityPath: city.path, dialsStationCount: stationCount,
          dialsCoordinateSource: coordinates.source || 'OpenStreetMap Nominatim'
        });
        added += 1;
      }
      completed += 1;
      if (completed % 100 === 0 || completed === cities.length) {
        onProgress({ completed, total: cities.length, added });
        refreshGlobeStations();
      }
    }
    refreshGlobeStations();
    return added;
  }

  let radioBrowserCatalogTotal = null;
  let globalCatalogLoaded = 0;
  let globalCatalogPhase = 'idle';
  function updateCatalogCounter(globalTotal = null, catalogLoaded = null, phase = null) {
    if (!stationCatalogCount) return;
    if (Number.isFinite(globalTotal)) radioBrowserCatalogTotal = globalTotal;
    if (Number.isFinite(catalogLoaded)) globalCatalogLoaded = catalogLoaded;
    if (phase) globalCatalogPhase = phase;
    const loaded = allLoadedStations.size.toLocaleString('pt-BR');
    const cached = globalCatalogLoaded.toLocaleString('pt-BR');
    const total = Number.isFinite(radioBrowserCatalogTotal) ? radioBrowserCatalogTotal.toLocaleString('pt-BR') : 'total indisponível';
    const phaseLabel = globalCatalogPhase === 'ready' ? 'completo' :
      ['loading', 'cached'].includes(globalCatalogPhase) ? 'carregando' :
      globalCatalogPhase === 'partial' ? 'parcial' : globalCatalogPhase === 'unavailable' ? 'indisponível' : 'aguardando';
    stationCatalogCount.textContent = `Globo ${loaded} · Catálogo ${cached}/${total} (${phaseLabel})`;
    stationCatalogCount.title = `Estações no globo: ${loaded}. Registros únicos do catálogo local: ${cached}. Total da fonte: ${total}. Estado: ${phaseLabel}.`;
  }

  function refreshCatalogDiagnostics() {
    const container = document.getElementById('globalCatalogDiagnostics');
    if (!container) return;
    const d = radioApi.getCatalogDiagnostics();
    const phase = d.phase === 'ready' ? 'Completo' : d.phase === 'partial' ? 'Parcial (fonte indisponível ou carga interrompida)' : d.phase === 'unavailable' ? 'Estatísticas indisponíveis' : d.phase === 'loading' ? 'Carregando em segundo plano' : 'Aguardando';
    const regions = Object.entries(d.regions || {}).map(([name, count]) => `<li>${escape(name)}: ${count.toLocaleString('pt-BR')}</li>`).join('');
    container.innerHTML = `
      <p class="catalog-diagnostics-state">${phase} · ${d.received.toLocaleString('pt-BR')} de ${Number.isFinite(d.total) ? d.total.toLocaleString('pt-BR') : 'total desconhecido'}</p>
      <dl class="catalog-diagnostics-grid">
        <div><dt>Cache entre sessões</dt><dd>${d.persistentCache ? 'Disponível' : 'Indisponível'}</dd></div>
        <div><dt>Válidas</dt><dd>${d.valid.toLocaleString('pt-BR')}</dd></div>
        <div><dt>Sem stream</dt><dd>${d.withoutStream.toLocaleString('pt-BR')}</dd></div>
        <div><dt>Com coordenadas</dt><dd>${d.withCoordinates.toLocaleString('pt-BR')}</dd></div>
        <div><dt>Sem coordenadas</dt><dd>${d.noCoordinates.toLocaleString('pt-BR')}</dd></div>
        <div><dt>Verificadas online</dt><dd>${d.online.toLocaleString('pt-BR')}</dd></div>
        <div><dt>Verificadas offline</dt><dd>${d.offline.toLocaleString('pt-BR')}</dd></div>
        <div><dt>Sem verificação recente</dt><dd>${d.unchecked.toLocaleString('pt-BR')}</dd></div>
        <div><dt>Now Playing no catálogo</dt><dd>${d.metadataAvailable.toLocaleString('pt-BR')}</dd></div>
        <div><dt>Países</dt><dd>${d.countries.toLocaleString('pt-BR')}</dd></div>
        <div><dt>Idiomas</dt><dd>${d.languages.toLocaleString('pt-BR')}</dd></div>
        <div><dt>Cidades no campo da fonte</dt><dd>${d.cities.toLocaleString('pt-BR')}</dd></div>
        <div><dt>Duplicatas removidas</dt><dd>${d.duplicateStreamsRemoved.toLocaleString('pt-BR')}</dd></div>
      </dl>
      <p class="catalog-diagnostics-caption">Regiões aproximadas pelas coordenadas conhecidas; não equivalem a fronteiras oficiais.</p>
      <ul class="catalog-region-list">${regions}</ul>`;
  }

  let globalCatalogLoadingPromise = null;
  const priorityCatalogStations = () => [
    ...[...priorityStationIds].map(id => allLoadedStations.get(id)).filter(Boolean),
    ...tuRadioSearchStations
  ];
  function startGlobalCatalogLoad() {
    if (globalCatalogLoadingPromise) return globalCatalogLoadingPromise;
    globalCatalogLoadingPromise = radioApi.loadGlobalCatalog({ onProgress: progress => {
      if (Array.isArray(progress.stations)) searchManager.setCatalog([...progress.stations, ...priorityCatalogStations()]);
      if (Array.isArray(progress.pageStations)) searchManager.mergeCatalog(progress.pageStations);
      updateCatalogCounter(progress.total, progress.received, progress.phase);
      if (progress.phase === 'ready' || progress.phase === 'partial' || progress.phase === 'unavailable') refreshCatalogDiagnostics();
      if (utilityMode === 'catalog' && ['ready', 'partial', 'unavailable', 'cancelled'].includes(progress.phase)) {
        const scrollTop = utilityPanel.scrollTop;
        renderUtilityPanel('catalog');
        utilityPanel.scrollTop = scrollTop;
      }
    } }).then(result => {
      searchManager.setCatalog([...(result.stations || []), ...priorityCatalogStations()]);
      updateCatalogCounter(result.total, result.received, result.phase);
      refreshCatalogDiagnostics();
    }).catch(error => {
      console.warn('[App] Catálogo global incompleto:', error);
      updateCatalogCounter(null, radioApi.catalogStations.size, 'partial');
    }).finally(() => { globalCatalogLoadingPromise = null; });
    return globalCatalogLoadingPromise;
  }

  function filterOptions(key, getValue) {
    const values = Array.from(new Set(Array.from(allLoadedStations.values()).flatMap(station => {
      const value = getValue(station);
      return Array.isArray(value) ? value : [value];
    }).map(value => String(value || '').trim()).filter(Boolean)));
    values.sort((a, b) => a.localeCompare(b, 'pt-BR'));
    return `<option value="">Todos</option>${values.map(value => `<option value="${escape(value)}" ${activeStationFilters[key] === value ? 'selected' : ''}>${escape(value)}</option>`).join('')}`;
  }

  function countryFilterOptions() {
    const choices = new Map();
    for (const station of allLoadedStations.values()) {
      const code = String(station.countryCode || '').toUpperCase();
      if (code && station.country) choices.set(code, station.country);
    }
    radioCountries.forEach(country => choices.set(country.code, country.name));
    if (activeStationFilters.country && !choices.has(activeStationFilters.country)) {
      choices.set(activeStationFilters.country, activeStationFilters.country);
    }
    const options = [...choices.entries()].sort((a, b) => a[1].localeCompare(b[1], 'pt-BR'));
    return `<option value="">Todos os países</option>${options.map(([code, name]) => `<option value="${escape(code)}" ${activeStationFilters.country === code ? 'selected' : ''}>${escape(name)}${radioCountries.find(country => country.code === code)?.stationCount ? ` (${radioCountries.find(country => country.code === code).stationCount.toLocaleString('pt-BR')})` : ''}</option>`).join('')}`;
  }

  function renderUtilityPanel(mode = utilityMode) {
    if (!utilityPanel || !utilityPanelContent) return;
    utilityMode = mode;
    utilityPanel.hidden = false;
    stationPanel?.classList.add('hidden');
    btnOpenLibrary?.classList.toggle('active', mode === 'favorites' || mode === 'history');
    btnOpenFilters?.classList.toggle('active', mode === 'filters' || mode === 'catalog' || mode === 'dials');

    if (mode === 'filters') {
      utilityPanelTitle.textContent = 'Filtrar estações';
      const loaded = allLoadedStations.size;
      const visible = getFilteredStations().length;
      utilityPanelContent.innerHTML = `
        <p class="utility-intro">Escolha um país para carregar as rádios dele; os demais filtros refinam essa lista.</p>
        <form id="stationFilterForm" class="station-filter-form">
          <label>País<select name="country">${countryFilterOptions()}</select></label>
          <label>Cidade / região<select name="state">${filterOptions('state', station => station.state)}</select></label>
          <label>Idioma<select name="language">${filterOptions('language', station => station.language)}</select></label>
          <label>Gênero<select name="genre">${filterOptions('genre', station => station.tags || [])}</select></label>
          <label>Codec<select name="codec">${filterOptions('codec', station => station.codec)}</select></label>
          <label>Bitrate mínimo<input name="minBitrate" type="number" min="0" max="1000" step="16" value="${escape(activeStationFilters.minBitrate)}" placeholder="Qualquer bitrate"></label>
          <div class="filter-actions"><button class="utility-primary-btn" type="submit">Aplicar filtros</button><button class="utility-text-btn" id="clearStationFilters" type="button">Limpar</button></div>
        </form>
        <p class="filter-count" id="filterCount">${visible} de ${loaded} frequências carregadas</p>
        <p class="utility-note">Ao aplicar um país, o app consulta todas as páginas disponíveis da fonte. Rádios sem coordenadas aparecem na lista e na busca, mas não como pins no mapa.</p>
        <button class="utility-text-btn" id="openTuRadioCatalog" type="button">🇧🇷 Consultar e validar o catálogo Dials do Brasil</button>
        <button class="utility-text-btn" id="openFullCatalog" type="button">🌍 Explorar todas as estações do catálogo</button>
        <details class="catalog-diagnostics"><summary>Cobertura e saúde do catálogo</summary><div id="globalCatalogDiagnostics"></div></details>`;
      document.querySelector('.catalog-diagnostics')?.addEventListener('toggle', event => {
        if (event.currentTarget.open) refreshCatalogDiagnostics();
      });
      const form = document.getElementById('stationFilterForm');
      form?.addEventListener('submit', async event => {
        event.preventDefault();
        const values = new FormData(form);
        activeStationFilters = Object.fromEntries(Object.keys(activeStationFilters).map(key => [key, String(values.get(key) || '').trim()]));
        const countryCode = activeStationFilters.country;
        if (countryCode) {
          const submit = form.querySelector('[type="submit"]');
          if (submit) { submit.disabled = true; submit.textContent = 'Carregando estações…'; }
          try {
            const countryStations = await radioApi.loadCountryStations(countryCode, {
              onProgress: progress => { if (submit) submit.textContent = `Carregando ${progress.received.toLocaleString('pt-BR')}…`; }
            });
            countryStations.forEach(station => {
              if (station.countryCode === countryCode) priorityStationIds.add(station.id);
              rememberMapStation(station);
            });
            searchManager.mergeCatalog(countryStations);
            Utils.showToast(`${countryStations.length.toLocaleString('pt-BR')} estações carregadas para ${radioCountries.find(country => country.code === countryCode)?.name || countryCode}.`, 'success', 3000);
          } catch (error) {
            Utils.showToast(`Não foi possível carregar esse país: ${error.message}`, 'error', 4000);
          }
        }
        refreshGlobeStations();
        renderUtilityPanel('filters');
      });
      document.getElementById('clearStationFilters')?.addEventListener('click', () => {
        activeStationFilters = { country: '', state: '', language: '', genre: '', codec: '', minBitrate: '' };
        refreshGlobeStations();
        renderUtilityPanel('filters');
      });
      document.getElementById('openFullCatalog')?.addEventListener('click', () => {
        catalogPageIndex = 0;
        renderUtilityPanel('catalog');
      });
      document.getElementById('openTuRadioCatalog')?.addEventListener('click', () => renderUtilityPanel('dials'));
      if (!radioCountries.length && !radioCountriesPromise) {
        radioCountriesPromise = radioApi.getCountries().then(countries => {
          radioCountries = countries;
          if (utilityMode === 'filters') renderUtilityPanel('filters');
        }).catch(error => {
          console.warn('[App] Lista de países indisponível:', error);
          radioCountriesPromise = null;
        });
      }
      return;
    }

    if (mode === 'dials') {
      if (!tuRadioNationalCacheCheckStarted) {
        tuRadioNationalCacheCheckStarted = true;
        tuRadioCatalog.hasNationalCache().then(available => {
          tuRadioNationalCachePresent = available;
          if (utilityMode === 'dials') renderUtilityPanel('dials');
        });
      }
      utilityPanelTitle.textContent = 'Catálogo Dials Brasil';
      btnOpenLibrary?.classList.remove('active');
      const stateOptions = brazilianStates.map(([code, name]) => `<option value="${code}" ${tuRadioSelectedUf === code ? 'selected' : ''}>${escape(name)} (${code})</option>`).join('');
      const cityOptions = tuRadioCities.map(city => `<option value="${escape(city.path)}" ${tuRadioSelectedCityPath === city.path ? 'selected' : ''}>${escape(city.slug.replace(/^\d+-/, '').replace(/-/g, ' '))}</option>`).join('');
      const cityStationRows = tuRadioCityStations.map((station, index) => {
        const result = tuRadioResults.get(station.id);
        const busy = tuRadioBusy.has(station.id);
        const status = busy ? 'Validando URL de áudio…' : result
          ? result.streamValid ? `Stream validado · ${escape(result.streamSource)} · HTTP ${escape(result.station.streamValidation?.status || 'OK')} · ${escape(result.station.streamValidation?.contentType || 'áudio')}`
            : `Cadastro Dials confirmado · sem áudio validado${result.directCheck?.reason ? ` · ${escape(result.directCheck.reason)}` : ''}`
          : 'Cadastro Dials carregado · áudio ainda não testado';
        const matchNote = result?.streamValid && result.streamSource === 'Radio Browser' ? 'Encontrado após a validação do stream Dials.' : '';
        return `<article class="library-station-card dials-radio-card">
          <div class="library-station-copy"><strong>${escape(station.name)} · ${escape(station.frequency)} ${escape(station.band)}</strong>
            <span>${escape([station.transmitterCity || station.receptionCity, station.state, station.signal, station.classAndCallsign].filter(Boolean).join(' · '))}</span>
            <span class="dials-validation-status">${status}${matchNote ? ` ${escape(matchNote)}` : ''}</span>
          </div>
          <div class="dials-station-actions">
            ${result?.streamValid ? `<button class="library-play-btn" type="button" data-dials-play="${index}" aria-label="Tocar ${escape(station.name)}">▶</button>` : ''}
            <button class="utility-text-btn" type="button" data-dials-validate="${index}" ${busy || tuRadioBatchController ? 'disabled' : ''}>${busy ? 'TESTANDO…' : result?.streamValid ? 'TESTAR DE NOVO' : 'VALIDAR E BUSCAR STREAM'}</button>
            <a class="utility-text-btn" href="${escape(station.listenPageUrl)}" target="_blank" rel="noopener noreferrer">OUVIR NO TUDO RÁDIO</a>
          </div>
        </article>`;
      }).join('');
      const stateLabel = brazilianStates.find(([code]) => code === tuRadioSelectedUf)?.[1] || tuRadioSelectedUf;
      utilityPanelContent.innerHTML = `
        <p class="utility-intro">Use o catálogo Dials como validação de emissora, frequência e local. Depois o app verifica o stream direto; se falhar, procura uma transmissão correspondente no Radio Browser.</p>
        <div class="filter-actions"><button class="utility-primary-btn" id="loadDialsNational" type="button" ${tuRadioNationalController ? 'disabled' : ''}>${tuRadioNationalCachePresent ? 'Abrir catálogo nacional salvo' : tuRadioNationalStations.length ? 'Ver catálogo carregado' : 'Importar catálogo de todas as cidades'}</button>${tuRadioNationalController ? '<button class="utility-text-btn" id="cancelDialsNational" type="button">Cancelar importação</button>' : ''}</div>
        ${tuRadioNationalStations.length ? `<p class="utility-note">${tuRadioNationalStations.length.toLocaleString('pt-BR')} emissoras carregadas em ${tuRadioNationalCities.length.toLocaleString('pt-BR')} cidades. ${tuRadioNationalCachePresent ? 'O catálogo fica salvo neste navegador e abre sem baixar tudo de novo.' : 'O armazenamento persistente não confirmou o salvamento; os dados ficam disponíveis nesta sessão.'} Os pins representam o centro aproximado de cada cidade; toque em um pin para ver as rádios Dials locais.</p>` : ''}
        <p class="filter-count" id="dialsBatchProgress" aria-live="polite">${escape(tuRadioProgress)}</p>
        <div class="station-filter-form">
          <label>Estado<select id="dialsStateSelect">${stateOptions}</select></label>
          <label>Cidade<select id="dialsCitySelect" ${tuRadioCities.length ? '' : 'disabled'}><option value="">${tuRadioCities.length ? 'Selecione uma cidade' : 'Carregando cidades do estado…'}</option>${cityOptions}</select></label>
          <button class="utility-primary-btn" id="loadDialsCity" type="button" ${tuRadioSelectedCityPath ? '' : 'disabled'}>Carregar esta cidade</button>
        </div>
        ${tuRadioProgress ? `<p class="filter-count" id="dialsLocalProgress" aria-live="polite">${escape(tuRadioProgress)}</p>` : ''}
        ${tuRadioCityStations.length ? `<p class="filter-count">${tuRadioCityStations.length.toLocaleString('pt-BR')} emissoras listadas em ${escape(tuRadioCityStations[0]?.receptionCity || stateLabel)} · primeiro o cadastro Dials, depois teste do áudio</p>
          <div class="filter-actions"><button class="utility-primary-btn" id="validateAllDials" type="button" ${tuRadioBatchController ? 'disabled' : ''}>Validar e buscar streams de todas</button>${tuRadioBatchController ? '<button class="utility-text-btn" id="cancelDialsBatch" type="button">Cancelar</button>' : ''}</div>
          <div class="library-station-list">${cityStationRows}</div>` : '<p class="utility-note">Selecione uma cidade para consultar seu dial FM/AM completo. Os registros Dials são mantidos na lista mesmo quando não têm stream; só streams confirmados podem tocar ou aparecer no globo.</p>'}
        <a class="utility-text-btn" href="https://tudoradio.com/dials/estado/${tuRadioSelectedUf}" target="_blank" rel="noopener noreferrer">ABRIR PÁGINA ORIGINAL DO ESTADO</a>
        <button class="utility-text-btn" id="backToDialsFilters" type="button">Voltar aos filtros</button>`;

      const loadCities = async uf => {
        tuRadioSelectedUf = uf;
        tuRadioLoadingCities = true;
        tuRadioSelectedCityPath = '';
        tuRadioCities = [];
        tuRadioCityStations = [];
        tuRadioProgress = `Carregando municípios e regiões de ${uf}…`;
        renderUtilityPanel('dials');
        try {
          tuRadioCities = await tuRadioCatalog.getCities(uf);
          const knownCity = uf === 'PR' ? tuRadioCities.find(city => /-cascavel$/i.test(city.path)) : null;
          tuRadioSelectedCityPath = knownCity?.path || '';
          tuRadioProgress = `${tuRadioCities.length.toLocaleString('pt-BR')} cidades Dials disponíveis em ${uf}.`;
        } catch (error) { tuRadioProgress = `Não consegui carregar as cidades de ${uf}: ${error.message}`; }
        tuRadioLoadingCities = false;
        renderUtilityPanel('dials');
      };
      document.getElementById('dialsStateSelect')?.addEventListener('change', event => loadCities(event.target.value));
      document.getElementById('dialsCitySelect')?.addEventListener('change', event => {
        tuRadioSelectedCityPath = event.target.value;
        tuRadioProgress = '';
        renderUtilityPanel('dials');
      });
      document.getElementById('loadDialsCity')?.addEventListener('click', async () => {
        const city = tuRadioCities.find(item => item.path === tuRadioSelectedCityPath);
        if (!city) return;
        tuRadioProgress = 'Lendo e validando os registros Dials…';
        renderUtilityPanel('dials');
        try {
          const result = await tuRadioCatalog.getCityStations(city);
          tuRadioCityStations = result.stations || [];
          tuRadioResults = new Map();
          tuRadioProgress = `${tuRadioCityStations.length.toLocaleString('pt-BR')} registros confirmados no catálogo Dials de ${result.city?.name || city.slug}.`;
        } catch (error) { tuRadioProgress = `Não consegui carregar a cidade: ${error.message}`; }
        renderUtilityPanel('dials');
      });
      document.getElementById('backToDialsFilters')?.addEventListener('click', () => renderUtilityPanel('filters'));
      document.getElementById('loadDialsNational')?.addEventListener('click', async () => {
        tuRadioNationalController = new AbortController();
        const controller = tuRadioNationalController;
        tuRadioProgress = 'Lendo os 27 índices de estado do Dials…';
        renderUtilityPanel('dials');
        try {
          const result = await tuRadioCatalog.loadNationalCatalog({
            signal: controller.signal, concurrency: 3,
            onProgress: status => {
              if (status.phase === 'cached') tuRadioProgress = `Restaurando o catálogo salvo (${status.stationCount.toLocaleString('pt-BR')} emissoras)…`;
              else if (status.phase === 'states') tuRadioProgress = `Índices estaduais Dials: ${status.completed} de ${status.total} UFs.`;
              else tuRadioProgress = `Catálogo nacional: ${status.completed} de ${status.total} cidades lidas · ${status.stationCount.toLocaleString('pt-BR')} emissoras únicas encontradas.`;
              const progressNode = document.getElementById('dialsBatchProgress');
              if (progressNode) progressNode.textContent = tuRadioProgress;
            }
          });
          tuRadioNationalStations = result.stations;
          tuRadioSearchStations = result.stations.map(station => tuRadioCatalog.toUnverifiedStation(station));
          tuRadioNationalCities = result.cities;
          tuRadioNationalCachePresent = Boolean(result.persistent || result.cached);
          searchManager.mergeCatalog(tuRadioSearchStations);
          tuRadioProgress = `Catálogo com ${result.stations.length.toLocaleString('pt-BR')} emissoras salvo. Buscando posições aproximadas das cidades para criar pins…`;
          const cityPins = await renderDialsCityPins(result.cities, controller.signal, status => {
            tuRadioProgress = `Posições das cidades para o mapa: ${status.completed} de ${status.total} · ${status.added} pins prontos.`;
            const progressNode = document.getElementById('dialsBatchProgress');
            if (progressNode) progressNode.textContent = tuRadioProgress;
          });
          tuRadioProgress = controller.signal.aborted
            ? `Importação salva. Geolocalização pausada após preparar ${cityPins} pins; abra o catálogo salvo para continuar.`
            : `Catálogo salvo: ${result.stations.length.toLocaleString('pt-BR')} emissoras em ${result.cities.length.toLocaleString('pt-BR')} cidades de ${result.statesLoaded} UFs · ${cityPins} pins de cidade no globo.`;
        } catch (error) {
          tuRadioProgress = error.name === 'AbortError' ? 'Importação nacional cancelada; os dados já carregados nesta sessão continuam disponíveis.' : `Falha ao importar o Dials nacional: ${error.message}`;
        } finally {
          tuRadioNationalController = null;
          renderUtilityPanel('dials');
        }
      });
      document.getElementById('cancelDialsNational')?.addEventListener('click', () => tuRadioNationalController?.abort());
      const validateOne = async index => {
        const dialsStation = tuRadioCityStations[index];
        if (!dialsStation || tuRadioBusy.has(dialsStation.id)) return;
        tuRadioBusy.add(dialsStation.id);
        tuRadioProgress = `Validando ${dialsStation.name}: conferindo o áudio Dials antes de procurar alternativas…`;
        renderUtilityPanel('dials');
        try {
          const result = await tuRadioCatalog.validateAndResolve(dialsStation, radioApi, { signal: tuRadioBatchController?.signal });
          tuRadioResults.set(dialsStation.id, result);
          searchManager.mergeCatalog([result.station]);
          if (result.station.hasValidCoords) rememberMapStation(result.station);
          if (result.streamValid) Utils.showToast(`${dialsStation.name}: stream validado (${result.streamSource}).`, 'success', 3000);
          else Utils.showToast(`${dialsStation.name}: cadastro confirmado, nenhum stream reproduzível foi encontrado.`, 'info', 3500);
          refreshGlobeStations();
        } catch (error) {
          if (error.name !== 'AbortError') tuRadioProgress = `${dialsStation.name}: ${error.message}`;
        } finally {
          tuRadioBusy.delete(dialsStation.id);
          if (!tuRadioBatchController) tuRadioProgress = '';
          renderUtilityPanel('dials');
        }
      };
      utilityPanelContent.querySelectorAll('[data-dials-validate]').forEach(button => button.addEventListener('click', () => validateOne(Number(button.dataset.dialsValidate))));
      utilityPanelContent.querySelectorAll('[data-dials-play]').forEach(button => button.addEventListener('click', () => {
        const result = tuRadioResults.get(tuRadioCityStations[Number(button.dataset.dialsPlay)]?.id);
        if (result?.station?.hasStream) displayStation(result.station, true);
      }));
      document.getElementById('validateAllDials')?.addEventListener('click', async () => {
        tuRadioBatchController = new AbortController();
        const controller = tuRadioBatchController;
        let next = 0;
        let finished = 0;
        tuRadioProgress = `Validando 0 de ${tuRadioCityStations.length} rádios…`;
        renderUtilityPanel('dials');
        const worker = async () => {
          while (next < tuRadioCityStations.length && !controller.signal.aborted) {
            const index = next++;
            await validateOne(index);
            finished++;
            tuRadioProgress = `Validando rádios e streams: ${finished} de ${tuRadioCityStations.length}.`;
            const progressNode = document.getElementById('dialsLocalProgress');
            if (progressNode) progressNode.textContent = tuRadioProgress;
          }
        };
        await Promise.all(Array.from({ length: Math.min(3, tuRadioCityStations.length) }, worker));
        tuRadioBatchController = null;
        tuRadioProgress = controller.signal.aborted ? `Validação cancelada após ${finished} de ${tuRadioCityStations.length} rádios.` : `Concluído: ${finished} rádios conferidas.`;
        renderUtilityPanel('dials');
      });
      document.getElementById('cancelDialsBatch')?.addEventListener('click', () => tuRadioBatchController?.abort());
      if (!tuRadioLoadingCities && !tuRadioCities.length && !tuRadioProgress.startsWith('Não consegui')) loadCities(tuRadioSelectedUf);
      return;
    }

    if (mode === 'catalog') {
      utilityPanelTitle.textContent = 'Todas as estações';
      btnOpenLibrary?.classList.remove('active');
      const catalog = searchManager.getSortedCatalog();
      const pageSize = 50;
      const pageCount = Math.max(1, Math.ceil(catalog.length / pageSize));
      catalogPageIndex = Math.max(0, Math.min(catalogPageIndex, pageCount - 1));
      const stationEntries = catalog.slice(catalogPageIndex * pageSize, (catalogPageIndex + 1) * pageSize);
      const cards = stationEntries.map((station, index) => `
        <article class="library-station-card">
          <button class="library-station-select" type="button" data-catalog-station="${index}" aria-label="Selecionar ${escape(station.name)}">
            ${stationImage(station)}<span class="library-station-copy"><strong>${escape(station.name || 'Estação')}</strong><span>${escape([station.city, station.state, station.country, station.source].filter(Boolean).join(' · ') || 'Localização não informada')}</span></span>
          </button>
          <button class="library-play-btn" type="button" data-catalog-play="${index}" aria-label="Reproduzir ${escape(station.name)}" ${station.streamUrl ? '' : 'disabled'}>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg>
          </button>
        </article>`).join('');
      const start = catalog.length ? catalogPageIndex * pageSize + 1 : 0;
      const end = Math.min((catalogPageIndex + 1) * pageSize, catalog.length);
      utilityPanelContent.innerHTML = `
        <p class="utility-intro">${radioApi.catalogStatus.complete ? radioApi.catalogStatus.persistentCache ? 'Catálogo global completo salvo para próximas visitas.' : 'Catálogo completo nesta sessão; armazenamento persistente indisponível.' : 'Catálogo global em carregamento; a lista inclui os lotes já recebidos.'}</p>
        <p class="filter-count">${start.toLocaleString('pt-BR')}–${end.toLocaleString('pt-BR')} de ${catalog.length.toLocaleString('pt-BR')} estações únicas · até 50 itens por página</p>
        <div class="library-station-list">${cards || `<div class="utility-empty"><strong>Catálogo aguardando conexão</strong><p>As estações já carregadas no globo continuam disponíveis.</p></div>`}</div>
        <div class="catalog-load-controls">
          ${radioApi.catalogStatus.phase === 'loading' ? '<button id="cancelCatalogLoad" class="utility-text-btn" type="button">Pausar carregamento global</button>' : ''}
          ${radioApi.catalogStatus.phase === 'partial' || radioApi.catalogStatus.phase === 'cancelled' || radioApi.catalogStatus.phase === 'unavailable' ? '<button id="retryCatalogLoad" class="utility-text-btn" type="button">Retomar atualização do catálogo</button>' : ''}
        </div>
        <div class="catalog-pagination"><button id="catalogPrevious" class="utility-text-btn" type="button" ${catalogPageIndex === 0 ? 'disabled' : ''}>Anterior</button><span>Página ${catalogPageIndex + 1} de ${pageCount}</span><button id="catalogNext" class="utility-text-btn" type="button" ${catalogPageIndex + 1 >= pageCount ? 'disabled' : ''}>Próxima</button></div>
        <button class="utility-text-btn" id="backToFilters" type="button">Voltar aos filtros e diagnóstico</button>`;
      document.getElementById('catalogPrevious')?.addEventListener('click', () => { catalogPageIndex--; renderUtilityPanel('catalog'); });
      document.getElementById('catalogNext')?.addEventListener('click', () => { catalogPageIndex++; renderUtilityPanel('catalog'); });
      document.getElementById('backToFilters')?.addEventListener('click', () => renderUtilityPanel('filters'));
      document.getElementById('cancelCatalogLoad')?.addEventListener('click', () => radioApi.cancelGlobalCatalog());
      document.getElementById('retryCatalogLoad')?.addEventListener('click', () => startGlobalCatalogLoad());
      utilityPanelContent.querySelectorAll('[data-catalog-station]').forEach(button => button.addEventListener('click', () => {
        const station = stationEntries[Number(button.dataset.catalogStation)];
        if (station) displayStation(station, false);
        closeUtilityPanel();
      }));
      utilityPanelContent.querySelectorAll('[data-catalog-play]').forEach(button => button.addEventListener('click', () => {
        const station = stationEntries[Number(button.dataset.catalogPlay)];
        if (station) displayStation(station, true);
        closeUtilityPanel();
      }));
      return;
    }

    const isFavorites = mode === 'favorites';
    libraryTab = isFavorites ? 'favorites' : 'history';
    utilityPanelTitle.textContent = 'Minha rádio';
    const list = isFavorites ? favorites : playHistory;
    const stationEntries = isFavorites
      ? list.map((station, index) => ({ station, index, detail: [station.state, station.country].filter(Boolean).join(', ') || 'Estação salva' }))
      : list.map((entry, index) => ({ station: entry.station, index, detail: `${[entry.station?.state, entry.station?.country].filter(Boolean).join(', ') || 'Sintonizada'} · ${new Date(entry.playedAt).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })}` }));
    const cards = stationEntries.map(({ station, index, detail }) => `
      <article class="library-station-card">
        <button class="library-station-select" type="button" data-station-index="${index}" aria-label="Selecionar ${escape(station.name)}">
          ${stationImage(station)}<span class="library-station-copy"><strong>${escape(station.name || 'Estação')}</strong><span>${escape(detail)}</span></span>
        </button>
        <button class="library-play-btn" type="button" data-play-index="${index}" aria-label="Reproduzir ${escape(station.name)}" ${station.streamUrl || station.hasStream ? '' : 'disabled'}>
          <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg>
        </button>
        ${isFavorites ? `<button class="library-remove-btn" type="button" data-remove-index="${index}" aria-label="Remover ${escape(station.name)} dos favoritos">×</button>` : ''}
      </article>`).join('');
    utilityPanelContent.innerHTML = `
      <div class="library-tabs" role="tablist" aria-label="Biblioteca de rádios">
        <button type="button" role="tab" aria-selected="${isFavorites}" class="${isFavorites ? 'selected' : ''}" data-utility-tab="favorites">♡ Favoritos <span>${favorites.length}</span></button>
        <button type="button" role="tab" aria-selected="${!isFavorites}" class="${!isFavorites ? 'selected' : ''}" data-utility-tab="history">◷ Histórico <span>${playHistory.length}</span></button>
      </div>
      <div class="library-station-list">${cards || `<div class="utility-empty"><span>${isFavorites ? '♡' : '◷'}</span><strong>${isFavorites ? 'Sua biblioteca começa aqui' : 'Sua próxima viagem sonora aparece aqui'}</strong><p>${isFavorites ? 'Favorite uma rádio para encontrá-la rapidamente.' : 'Dê play em uma estação e ela ficará registrada.'}</p></div>`}</div>`;
    utilityPanelContent.querySelectorAll('[data-utility-tab]').forEach(tab => tab.addEventListener('click', () => renderUtilityPanel(tab.dataset.utilityTab)));
    utilityPanelContent.querySelectorAll('[data-station-index]').forEach(button => button.addEventListener('click', () => {
      const station = stationEntries[Number(button.dataset.stationIndex)]?.station;
      if (station) displayStation({ ...station, hasStream: station.hasStream ?? Boolean(station.streamUrl), hasValidCoords: station.hasValidCoords ?? (Number.isFinite(station.lat) && Number.isFinite(station.lon)) }, false);
      closeUtilityPanel();
    }));
    utilityPanelContent.querySelectorAll('[data-play-index]').forEach(button => button.addEventListener('click', () => {
      const station = stationEntries[Number(button.dataset.playIndex)]?.station;
      if (station) displayStation({ ...station, hasStream: station.hasStream ?? Boolean(station.streamUrl), hasValidCoords: station.hasValidCoords ?? (Number.isFinite(station.lat) && Number.isFinite(station.lon)) }, true);
      closeUtilityPanel();
    }));
    utilityPanelContent.querySelectorAll('[data-remove-index]').forEach(button => button.addEventListener('click', () => {
      const station = stationEntries[Number(button.dataset.removeIndex)]?.station;
      if (station) toggleFavorite(station);
      renderUtilityPanel('favorites');
    }));
  }

  function closeUtilityPanel() {
    if (utilityPanel) utilityPanel.hidden = true;
    utilityMode = '';
    btnOpenLibrary?.classList.remove('active');
    btnOpenFilters?.classList.remove('active');
  }

  btnOpenLibrary?.addEventListener('click', () => {
    if (utilityPanel && !utilityPanel.hidden && (utilityMode === 'favorites' || utilityMode === 'history')) closeUtilityPanel();
    else renderUtilityPanel(libraryTab);
  });
  btnOpenFilters?.addEventListener('click', () => {
    if (utilityPanel && !utilityPanel.hidden && utilityMode === 'filters') closeUtilityPanel();
    else renderUtilityPanel('filters');
  });
  document.getElementById('btnCloseUtility')?.addEventListener('click', closeUtilityPanel);
  document.addEventListener('keydown', event => { if (event.key === 'Escape') closeUtilityPanel(); });

  function closeSearchResults() {
    if (!searchResults || !globalSearchInput) return;
    searchResults.hidden = true;
    globalSearchInput.setAttribute('aria-expanded', 'false');
  }

  function showSearchResults(items, message = '') {
    if (!searchResults || !globalSearchInput) return;
    searchResults.replaceChildren();
    if (message) {
      const status = document.createElement('p');
      status.className = 'search-result-status';
      status.textContent = message;
      searchResults.append(status);
    }
    items.forEach(item => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'search-result-item';
      button.setAttribute('role', 'option');
      const title = document.createElement('strong');
      const meta = document.createElement('span');
      title.textContent = item.title;
      meta.textContent = item.meta;
      button.append(title, meta);
      button.addEventListener('click', () => {
        if (item.station) {
          if (item.station.hasValidCoords) {
            rememberMapStation(item.station);
            refreshGlobeStations();
            updateCatalogCounter();
            globe.flyTo(item.station.lat, item.station.lon, 360000, 1.8);
          }
          displayStation(item.station, false);
        } else if (item.place) {
          globe.flyTo(item.place.lat, item.place.lon, 1800000, 1.8);
          closeSearchResults();
        } else if (item.query) {
          globalSearchInput.value = item.query;
          runGlobalSearch(item.query);
          return;
        }
        closeSearchResults();
      });
      searchResults.append(button);
    });
    searchResults.hidden = false;
    globalSearchInput.setAttribute('aria-expanded', 'true');
  }

  async function runGlobalSearch(rawQuery) {
    const query = rawQuery.trim();
    if (query.length < 2) {
      showSearchResults([], 'Digite pelo menos 2 caracteres para pesquisar.');
      return;
    }
    const searchId = ++activeSearchId;
    showSearchResults([], 'Pesquisando rádios e lugares…');
    const recent = Utils.storage.get('wrg_recent_searches', []);
    Utils.storage.set('wrg_recent_searches', [query, ...recent.filter(value => value.toLowerCase() !== query.toLowerCase())].slice(0, 6));

    try {
      const { place, stations } = await searchManager.search(query);
      if (searchId !== activeSearchId) return;
      const items = [];
      if (place) items.push({ place, title: place.name || place.displayName.split(',')[0], meta: [place.country, 'Local • OpenStreetMap'].filter(Boolean).join(' · ') });
      stations.forEach(station => items.push({ station, title: station.name, meta: [station.state, station.country, station.hasValidCoords ? '' : 'Sem coordenadas', station.hasStream ? station.codec : 'Sem transmissão', station.source && station.source !== 'Radio Browser' ? station.source : ''].filter(Boolean).join(' · ') }));
      showSearchResults(items, items.length ? `${stations.length} estações encontradas${place ? ' • local incluído' : ''}` : 'Nenhum resultado. Tente outro nome, país, idioma ou gênero.');
    } catch (error) {
      if (searchId !== activeSearchId) return;
      console.warn('[App] Busca indisponível:', error);
      showSearchResults([], 'A busca está temporariamente indisponível. Tente novamente.');
    }
  }

  let activeSearchId = 0;

  if (globalSearchForm) globalSearchForm.addEventListener('submit', event => {
    event.preventDefault();
    dismissExplore();
    runGlobalSearch(globalSearchInput?.value || '');
  });
  if (globalSearchInput) {
    globalSearchInput.addEventListener('focus', () => {
      const recent = Utils.storage.get('wrg_recent_searches', []);
      if (recent.length && !globalSearchInput.value) {
        showSearchResults(recent.map(query => ({ query, title: query, meta: 'Pesquisa recente' })), 'BUSCAS RECENTES');
      }
    });
    globalSearchInput.addEventListener('keydown', event => {
      if (event.key === 'Escape') closeSearchResults();
    });
  }
  document.addEventListener('pointerdown', event => {
    if (!globalSearchForm?.contains(event.target)) closeSearchResults();
  });

  // Modal de Token Cesium
  const tokenModal = document.getElementById('tokenModal');
  const cesiumTokenInput = document.getElementById('cesiumTokenInput');
  const btnSaveToken = document.getElementById('btnSaveToken');
  const btnUseDarkFallback = document.getElementById('btnUseDarkFallback');
  const btnCloseModal = document.getElementById('btnCloseModal');

  // 3. Sistema de Relógios e Efeito 4D (Cesium Clock Integration)
  globe.onTimeTick = (simDate, multiplier, isAnimating) => {
    // Atualiza relógios com base no tempo simulado
    const utcHours = Utils.padZero(simDate.getUTCHours());
    const utcMinutes = Utils.padZero(simDate.getUTCMinutes());
    const utcSeconds = Utils.padZero(simDate.getUTCSeconds());
    if (hudUtcTime) hudUtcTime.textContent = `${utcHours}:${utcMinutes}:${utcSeconds} UTC`;

    const locHours = Utils.padZero(simDate.getHours());
    const locMinutes = Utils.padZero(simDate.getMinutes());
    const locSeconds = Utils.padZero(simDate.getSeconds());
    if (hudLocalTime) hudLocalTime.textContent = `${locHours}:${locMinutes}:${locSeconds}`;
  };

  // Botão Play/Pausa do Relógio 4D
  if (btnTimePlayPause) {
    btnTimePlayPause.addEventListener('click', () => {
      const isRunning = globe.toggleTimePlay();
      btnTimePlayPause.classList.toggle('active', isRunning);
      if (iconTimeState) {
        iconTimeState.innerHTML = isRunning
          ? '<rect x="6" y="4" width="4" height="16"></rect><rect x="14" y="4" width="4" height="16"></rect>'
          : '<polygon points="5 3 19 12 5 21 5 3"></polygon>';
      }
      Utils.showToast(isRunning ? 'Passagem do tempo retomada.' : 'Passagem do tempo pausada.', 'info', 1500);
    });
  }

  // Saltos temporais de 3 horas
  if (btnTimeReverse) {
    btnTimeReverse.addEventListener('click', () => {
      globe.advanceTimeHours(-3);
      Utils.showToast('Tempo solar retrocedido em 3 horas.', 'info', 1500);
    });
  }

  if (btnTimeForward) {
    btnTimeForward.addEventListener('click', () => {
      globe.advanceTimeHours(3);
      Utils.showToast('Tempo solar avançado em 3 horas.', 'info', 1500);
    });
  }

  // Sincronização com o tempo real
  if (btnTimeSyncReal) {
    btnTimeSyncReal.addEventListener('click', () => {
      globe.syncRealTime();
      speedPills.forEach(p => p.classList.toggle('active', p.dataset.speed === '1'));
      if (btnTimePlayPause) btnTimePlayPause.classList.add('active');
      Utils.showToast('Tempo sincronizado com o relógio real.', 'success', 2000);
    });
  }

  // Seletores de Velocidade 1x, 10x, 100x, 1000x
  speedPills.forEach(pill => {
    pill.addEventListener('click', () => {
      speedPills.forEach(p => p.classList.remove('active'));
      pill.classList.add('active');
      const speed = parseFloat(pill.dataset.speed) || 1.0;
      globe.setTimeMultiplier(speed);
      Utils.showToast(`Velocidade solar ajustada para ${speed}x.`, 'info', 1500);
    });
  });

  // 4. Integração da Telemetria com o Globo
  globe.onTelemetryUpdate = ({ lat, lon, altitude }) => {
    if (hudCoords) hudCoords.textContent = Utils.formatCoords(lat, lon);
    if (hudAltitude) hudAltitude.textContent = Utils.formatAltitude(altitude);
  };

  // 5. Seletor direto de camadas de mapa
  const basemapNames = {
    dark: 'Escuro · Esri',
    streets: 'Ruas · Esri',
    satellite: 'Satélite · Esri',
    osm: 'OpenStreetMap Aberto'
  };
  const savedBasemap = (() => {
    try { return localStorage.getItem('wrg_basemap'); } catch (_) { return null; }
  })();
  if (savedBasemap && basemapNames[savedBasemap]) {
    globe.setBasemap(savedBasemap);
    if (tooltipBasemap) tooltipBasemap.textContent = `Mapa: ${basemapNames[savedBasemap]}`;
    basemapButtons.forEach(button => button.setAttribute('aria-pressed', String(button.dataset.basemap === savedBasemap)));
  }

  if (btnSwitchBasemap) {
    btnSwitchBasemap.addEventListener('click', () => {
      const isOpening = basemapMenu?.hidden ?? true;
      if (basemapMenu) basemapMenu.hidden = !isOpening;
      btnSwitchBasemap.setAttribute('aria-expanded', String(isOpening));
    });
  }
  basemapButtons.forEach(button => button.addEventListener('click', () => {
    const type = button.dataset.basemap;
    globe.setBasemap(type);
    try { localStorage.setItem('wrg_basemap', type); } catch (_) { /* armazenamento opcional */ }
    basemapButtons.forEach(option => option.setAttribute('aria-pressed', String(option === button)));
      const readableName = basemapNames[type] || type;
      if (tooltipBasemap) tooltipBasemap.textContent = `Mapa: ${readableName}`;
      if (basemapMenu) basemapMenu.hidden = true;
      btnSwitchBasemap?.setAttribute('aria-expanded', 'false');
      globe.viewer?.scene?.requestRender?.();
      Utils.showToast(`Camada cartográfica: ${readableName}`, 'success', 1800);
  }));
  document.addEventListener('pointerdown', event => {
    if (!event.target.closest('.map-layer-control') && basemapMenu && !basemapMenu.hidden) {
      basemapMenu.hidden = true;
      btnSwitchBasemap?.setAttribute('aria-expanded', 'false');
    }
  });
  btnZoomIn?.addEventListener('click', () => globe.zoomIn());
  btnZoomOut?.addEventListener('click', () => globe.zoomOut());
  const syncClusteringControl = () => {
    const enabled = globe.clusteringEnabled;
    btnToggleClustering?.classList.toggle('active', enabled);
    btnToggleClustering?.setAttribute('aria-pressed', String(enabled));
    btnToggleClustering?.setAttribute('aria-label', `Agrupamento de estações ${enabled ? 'ligado' : 'desligado'}`);
    if (tooltipClustering) {
      tooltipClustering.textContent = enabled
        ? 'Agrupamento ligado · mostrar estações separadas'
        : 'Agrupamento desligado · agrupar estações próximas';
    }
    if (btnToggleClustering) {
      btnToggleClustering.title = enabled
        ? 'Desativar agrupamento e mostrar todas as estações'
        : 'Ativar agrupamento de estações próximas';
    }
  };
  syncClusteringControl();
  btnToggleClustering?.addEventListener('click', () => {
    const enabled = globe.setClusteringEnabled(!globe.clusteringEnabled);
    try { localStorage.setItem('wrg_station_clustering', String(enabled)); } catch (_) { /* preferência opcional */ }
    syncClusteringControl();
    Utils.showToast(enabled ? 'Agrupamento de estações ativado.' : 'Pins individuais exibidos.', 'info', 1800);
  });

  // 6. Tooltips Holográficos no Hover
  globe.onHoverStation = (station, mousePos) => {
    if (!globeTooltip) return;

    if (tooltipTitle) tooltipTitle.textContent = station.name;
    if (tooltipLoc) {
      const loc = [station.state, station.country].filter(Boolean).join(', ') || 'Localização global';
      tooltipLoc.textContent = loc;
    }
    if (tooltipTag) {
      const tag = (station.tags && station.tags[0]) ? `#${station.tags[0]}` : `#${station.codec}`;
      tooltipTag.textContent = tag;
    }

    globeTooltip.style.left = `${mousePos.x}px`;
    globeTooltip.style.top = `${mousePos.y}px`;
    globeTooltip.classList.add('visible');
  };

  globe.onHoverCluster = (count, mousePos) => {
    if (!globeTooltip) return;

    if (tooltipTitle) tooltipTitle.textContent = 'Hub de Comunicações';
    if (tooltipLoc) tooltipLoc.textContent = `${count} estações nesta região`;
    if (tooltipTag) tooltipTag.textContent = 'Clique para expandir';

    globeTooltip.style.left = `${mousePos.x}px`;
    globeTooltip.style.top = `${mousePos.y}px`;
    globeTooltip.classList.add('visible');
  };

  globe.onHoverOut = () => {
    if (globeTooltip) globeTooltip.classList.remove('visible');
  };

  // 7. Integração do Player de Áudio com a UI
  audioPlayer.onStateChange = ({ state, statusText, isPlaying, details }) => {
    updateRadioDiagnostics();
    radioPlayerBar?.classList.toggle('is-playing', Boolean(isPlaying));
    if (state === 'PLAYING') recordHistory(currentStation);
    if (playerStatusText) {
      playerStatusText.textContent = statusText;

      switch (state) {
        case 'PLAYING':
          playerStatusText.style.color = 'var(--accent-emerald)';
          if (radioWaveBars) {
            radioWaveBars.className = 'radio-wave-bars playing';
          }
          break;
        case 'BUFFERING':
          playerStatusText.style.color = 'var(--accent-amber)';
          if (radioWaveBars) {
            radioWaveBars.className = 'radio-wave-bars buffering';
          }
          break;
        case 'ERROR':
          playerStatusText.style.color = 'var(--accent-rose)';
          if (radioWaveBars) {
            radioWaveBars.className = 'radio-wave-bars error';
          }
          if (details) {
            Utils.showToast(details, 'error', 4000);
          }
          break;
        case 'PAUSED':
        default:
          playerStatusText.style.color = 'var(--text-dim)';
          if (radioWaveBars) {
            radioWaveBars.className = 'radio-wave-bars idle';
          }
          break;
      }
    }

    // Atualiza ícone do botão Play/Pause
    if (btnPlayPause) {
      btnPlayPause.disabled = false;
      btnPlayPause.innerHTML = isPlaying
        ? `<svg class="icon-pause" width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
            <rect x="6" y="4" width="4" height="16"></rect>
            <rect x="14" y="4" width="4" height="16"></rect>
           </svg>`
        : `<svg class="icon-play" width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
            <polygon points="5 3 19 12 5 21 5 3"></polygon>
           </svg>`;
    }
  };

  const failedStreamUrls = new Set();
  audioPlayer.onStreamError = async failedStation => {
    if (!failedStation?.name) return;
    const failedUrl = String(failedStation.streamUrl || '').trim().toLowerCase();
    if (failedUrl) failedStreamUrls.add(failedUrl);
    Utils.showToast(`Stream de ${failedStation.name} falhou. Procurando outra entrada da mesma rádio…`, 'info', 3500);
    try {
      if (String(failedStation.countryCode || '').toUpperCase() === 'BR' && failedStation.state && failedStation.city) {
        const dialsStation = await tuRadioCatalog.findDialsStation(failedStation.name, {
          uf: failedStation.state, city: failedStation.city
        }).catch(() => null);
        if (dialsStation) {
          const resolved = await tuRadioCatalog.validateAndResolve(dialsStation, radioApi, { excludeStreamUrls: failedStreamUrls });
          const resolvedUrl = String(resolved.station.streamUrl || '').trim().toLowerCase();
          if (resolved.streamValid && resolvedUrl && !failedStreamUrls.has(resolvedUrl)) {
            failedStreamUrls.add(resolvedUrl);
            searchManager.mergeCatalog([resolved.station]);
            if (resolved.station.hasValidCoords) rememberMapStation(resolved.station);
            Utils.showToast(`Transmissão validada no Dials para ${resolved.station.name}; tentando reproduzir.`, 'success', 3500);
            displayStation(resolved.station, true);
            refreshGlobeStations();
            return;
          }
        }
      }
      const candidates = await radioApi.searchStations({
        name: failedStation.name, countryCode: failedStation.countryCode || undefined,
        limit: 40, hasGeoOnly: false, hideBroken: false, preferHttps: true, order: 'clickcount'
      });
      const normalize = value => String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
      const targetName = normalize(failedStation.name);
      const isSameArea = candidate => {
        if (failedStation.hasValidCoords && candidate.hasValidCoords) return Utils.haversineDistance(failedStation.lat, failedStation.lon, candidate.lat, candidate.lon) <= 50;
        const targetCity = normalize(failedStation.city);
        const candidateCity = normalize(candidate.city);
        return targetCity ? targetCity === candidateCity : normalize(failedStation.state) === normalize(candidate.state);
      };
      const candidate = candidates.find(item => {
        const name = normalize(item.name);
        const sameName = name === targetName || name.includes(targetName) || targetName.includes(name);
        const url = String(item.streamUrl || '').trim().toLowerCase();
        return item.id !== failedStation.id && item.streamUrl && url !== failedUrl && !failedStreamUrls.has(url) && sameName && isSameArea(item);
      });
      if (candidate) {
        failedStreamUrls.add(String(candidate.streamUrl).trim().toLowerCase());
        Utils.showToast(`Testando outro stream cadastrado para ${candidate.name}.`, 'info', 3000);
        displayStation(candidate, true);
      } else {
        Utils.showToast(`Não encontrei outro stream válido cadastrado para ${failedStation.name}. O diretório pode estar com link antigo; tente o site oficial da rádio.`, 'error', 6000);
      }
    } catch (_) {
      Utils.showToast(`Não consegui consultar streams alternativos para ${failedStation.name}.`, 'error', 5000);
    }
  };

  // Controle de Volume e Mute
  if (volumeSlider) {
    volumeSlider.value = audioPlayer.volume;
    volumeSlider.addEventListener('input', (e) => {
      audioPlayer.setVolume(e.target.value);
    });
  }

  if (btnMuteToggle) {
    btnMuteToggle.addEventListener('click', () => {
      audioPlayer.toggleMute();
    });
  }

  audioPlayer.onVolumeChange = (vol, isMuted) => {
    if (volumeSlider) volumeSlider.value = vol;
    if (btnMuteToggle) {
      btnMuteToggle.classList.toggle('muted', isMuted);
    }
  };

  // Botão Play/Pause principal
  if (btnPlayPause) {
    btnPlayPause.addEventListener('click', () => {
      audioPlayer.togglePlayPause();
    });
  }

  // 8. Seleção e Exibição de Estações
  function isStationFavorited(stationId) {
    return favorites.some(fav => fav.id === stationId);
  }

  function updatePlayerFavoriteButton() {
    if (!btnPlayerFavorite) return;
    const isFav = Boolean(currentStation && isStationFavorited(currentStation.id));
    btnPlayerFavorite.disabled = !currentStation;
    btnPlayerFavorite.classList.toggle('active', isFav);
    btnPlayerFavorite.setAttribute('aria-label', isFav ? 'Remover rádio dos favoritos' : 'Favoritar estação atual');
    btnPlayerFavorite.title = isFav ? 'Remover dos favoritos' : 'Favoritar estação atual';
  }

  function toggleFavorite(station) {
    if (!station) return;
    const index = favorites.findIndex(fav => fav.id === station.id);
    if (index > -1) {
      favorites.splice(index, 1);
      Utils.showToast(`"${station.name}" removida dos favoritos.`, 'info');
    } else {
      favorites.push(stationRecord(station));
      Utils.showToast(`"${station.name}" salva nos favoritos!`, 'success');
    }
    Utils.storage.set('wrg_favorites', favorites);
    updateDrawerFavoriteButton();
    updatePlayerFavoriteButton();
    if (utilityMode === 'favorites') renderUtilityPanel('favorites');
  }
  btnPlayerFavorite?.addEventListener('click', () => toggleFavorite(currentStation));

  function updateDrawerFavoriteButton() {
    const favBtn = document.getElementById('drawerFavBtn');
    if (!favBtn || !currentStation) return;
    const isFav = isStationFavorited(currentStation.id);
    favBtn.classList.toggle('active', isFav);
    favBtn.innerHTML = `
      <svg width="15" height="15" viewBox="0 0 24 24" fill="${isFav ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="2">
        <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"></polygon>
      </svg>
      <span>${isFav ? 'Favoritada' : 'Favoritar'}</span>
    `;
  }

  async function displayStation(station, autoPlay = true) {
    if (!station) return;
    dismissExplore();
    closeUtilityPanel();

    // Arco de Voo: traça linha geodésica entre a estação anterior e a nova
    const prev = currentStation;
    if (prev && prev.hasValidCoords && station.hasValidCoords &&
        (Math.abs(prev.lat - station.lat) > 0.01 || Math.abs(prev.lon - station.lon) > 0.01)) {
      globe.drawFlightArc(prev.lat, prev.lon, station.lat, station.lon, 3);
    }

    currentStation = station;
    updatePlayerFavoriteButton();
    audioPlayer.selectStation(station);
    if (btnPlayPause) btnPlayPause.disabled = !station.hasStream;

    // Reseta campo "Now Playing" ao trocar de estação
    if (stationNowPlaying) {
      stationNowPlaying.textContent = '';
      stationNowPlaying.classList.remove('has-track');
    }

    // Ativa ondas 3D na superfície do globo
    globe.setActiveStation(station);

    // Atualiza metadados no player inferior
    if (stationNameDisplay) stationNameDisplay.textContent = station.name;
    if (stationGeoDisplay) {
      const geoText = [station.state, station.country].filter(Boolean).join(', ') || 'Localização global';
      const format = [station.codec, station.bitrate ? `${station.bitrate} kbps` : ''].filter(Boolean).join(' · ');
      stationGeoDisplay.textContent = format ? `${geoText} · ${format}` : geoText;
    }

    if (stationLogoThumb) {
      if (station.favicon) {
        stationLogoThumb.innerHTML = `<img src="${Utils.escapeHtml(station.favicon)}" alt="${Utils.escapeHtml(station.name)}" style="width:100%;height:100%;object-fit:cover;border-radius:inherit;" onerror="this.onerror=null;this.parentElement.innerHTML='<div class=\\'radio-wave-bars idle\\' id=\\'radioWaveBars\\'><span></span><span></span><span></span><span></span><span></span><span></span><span></span></div>';">`;
      } else {
        stationLogoThumb.innerHTML = `<div class="radio-wave-bars idle" id="radioWaveBars"><span></span><span></span><span></span><span></span><span></span><span></span><span></span></div>`;
      }
    }

    // Reconecta o visualizador ao elemento de áudio atualizado
    if (visualizer) {
      visualizer.attachAudio(audioPlayer.getAudioElement());
    }
    // Atualiza metadataManager com a estação atual
    if (metadataManager) {
      metadataManager.currentStation = station;
    }

    // Renderiza painel lateral
    renderStationDrawer(station);

    // Inicia reprodução
    if (autoPlay) {
      await audioPlayer.playStation(station);
    }
  }

  function renderStationDrawer(station) {
    if (!stationPanel) return;

    const locationText = Utils.escapeHtml([station.state, station.country].filter(Boolean).join(', ') || 'Não informada');
    const safeName = Utils.escapeHtml(station.name);
    const protocolBadgeHtml = station.isHttps 
      ? `<span class="protocol-badge https">HTTPS SEGURO</span>`
      : `<span class="protocol-badge http">STREAM HTTP</span>`;

    const tagsHtml = (station.tags && station.tags.length > 0)
      ? station.tags.map(tag => `<span class="station-tag">#${Utils.escapeHtml(tag)}</span>`).join('')
      : '<span class="station-tag">#geral</span>';

    const defaultIconSvg = `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="2"></circle><path d="M16.24 7.76a6 6 0 0 1 0 8.49m-8.48-.01a6 6 0 0 1 0-8.49"></path></svg>`;

    stationPanel.innerHTML = `
      <div class="station-drawer-hero">
        <div class="drawer-header-left">
          ${station.favicon 
            ? `<img class="drawer-logo" src="${Utils.escapeHtml(station.favicon)}" alt="${safeName}" onerror="this.onerror=null; this.replaceWith('${defaultIconSvg}');">`
            : `<div class="drawer-logo" style="display:flex;align-items:center;justify-content:center;color:var(--accent-cyan);">${defaultIconSvg}</div>`
          }
          <div class="drawer-title-group">
            <span class="drawer-eyebrow">NO AR PELO MUNDO</span>
            <h3 class="drawer-station-name font-display" title="${safeName}">${safeName}</h3>
            <span class="drawer-station-loc">${locationText}</span>
          </div>
        </div>
        <button class="btn-close-drawer" id="btnCloseDrawer" title="Fechar Painel">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <line x1="18" y1="6" x2="6" y2="18"></line>
            <line x1="6" y1="6" x2="18" y2="18"></line>
          </svg>
        </button>
      </div>

      <div>${protocolBadgeHtml}</div>

      <div class="station-specs-grid font-mono">
        <div class="spec-item">
          <span class="spec-label">CODEC</span>
          <span class="spec-val">${Utils.escapeHtml(station.codec || 'Não informado')}</span>
        </div>
        <div class="spec-item">
          <span class="spec-label">BITRATE</span>
          <span class="spec-val">${station.bitrate ? station.bitrate + ' kbps' : 'N/A'}</span>
        </div>
        <div class="spec-item">
          <span class="spec-label">VOTOS</span>
          <span class="spec-val">${Number(station.votes || 0).toLocaleString()}</span>
        </div>
        <div class="spec-item">
          <span class="spec-label">IDIOMA</span>
          <span class="spec-val">${Utils.escapeHtml(station.language || 'Não informado')}</span>
        </div>
      </div>

      <div>
        <span class="spec-label" style="display:block; margin-bottom: 6px;">GÊNEROS / TAGS</span>
        <div class="station-tags-container">
          ${tagsHtml}
        </div>
      </div>

      ${station.dialsValidated ? `<div class="station-specs-grid font-mono dials-tech-details">
        <div class="spec-item"><span class="spec-label">DIAL</span><span class="spec-val">${escape(station.dialsFrequency)} ${escape(station.dialsBand)}</span></div>
        <div class="spec-item"><span class="spec-label">SINAL / RDS</span><span class="spec-val">${escape(station.dialsSignal)} / ${station.dialsRds ? 'SIM' : 'NÃO'}</span></div>
        <div class="spec-item"><span class="spec-label">CLASSE / INDICATIVO</span><span class="spec-val">${escape(station.dialsClassAndCallsign)}</span></div>
        ${station.dialsTechnical?.potenciaERP ? `<div class="spec-item"><span class="spec-label">POTÊNCIA ERP</span><span class="spec-val">${escape(station.dialsTechnical.potenciaERP)}</span></div>` : ''}
      </div>` : ''}

      ${station.dialsSourceRecord ? `<button class="drawer-listen-btn" id="drawerValidateDialsBtn" type="button" ${isDialsResolvingCurrent ? 'disabled' : ''}>${isDialsResolvingCurrent ? 'VALIDANDO E PROCURANDO STREAM…' : 'VALIDAR CADASTRO E TESTAR STREAM'}</button>` : ''}

      <button class="drawer-listen-btn" id="drawerListenBtn" type="button" ${station.hasStream ? '' : 'disabled'}>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg>
        ${station.hasStream ? 'OUVIR ESTA RÁDIO' : 'TRANSMISSÃO INDISPONÍVEL'}
      </button>

      <button class="drawer-shazam-btn" id="drawerShazamBtn" type="button" ${station.hasStream ? '' : 'disabled'}>IDENTIFICAR MÚSICA</button>
      <p class="drawer-shazam-note" id="drawerShazamNote">Lê o Now Playing da rádio; se não houver, tenta reconhecer um trecho de áudio.</p>
      ${station.listenPageUrl ? `<a class="drawer-listen-btn" href="${Utils.escapeHtml(station.listenPageUrl)}" target="_blank" rel="noopener noreferrer">TENTAR OUVIR NO TUDO RÁDIO</a>` : ''}

      <details class="radio-debug"><summary>DEBUG RADIO</summary><div id="debugRadioDetails"></div></details>

      <div class="drawer-actions">
        <button class="drawer-btn-fav" id="drawerFavBtn">
        </button>
        <button class="drawer-btn-stop" id="drawerStopBtn" type="button" title="Parar e liberar o stream" aria-label="Parar estação atual" ${station.hasStream ? '' : 'disabled'}>
          <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="5" y="5" width="14" height="14" rx="2"></rect></svg>
        </button>
        ${station.homepage ? `
          <a class="drawer-btn-link" href="${Utils.escapeHtml(station.homepage)}" target="_blank" rel="noopener noreferrer" title="Visitar site oficial">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path>
              <polyline points="15 3 21 3 21 9"></polyline>
              <line x1="10" y1="14" x2="21" y2="3"></line>
            </svg>
          </a>
        ` : ''}
        ${station.dialsDetailsUrl ? `<a class="drawer-btn-link" href="${escape(station.dialsDetailsUrl)}" target="_blank" rel="noopener noreferrer" title="Dados técnicos no Tudo Rádio Dials">DIALS</a>` : ''}
      </div>
    `;

    stationPanel.classList.remove('hidden');
    updateRadioDiagnostics();

    const drawerListenBtn = document.getElementById('drawerListenBtn');
    drawerListenBtn?.addEventListener('click', () => {
      if (currentStation?.hasStream) audioPlayer.playStation(currentStation);
    });
    document.getElementById('drawerStopBtn')?.addEventListener('click', () => audioPlayer.stop());
    document.getElementById('drawerValidateDialsBtn')?.addEventListener('click', async () => {
      if (!currentStation?.dialsSourceRecord || isDialsResolvingCurrent) return;
      isDialsResolvingCurrent = true;
      renderStationDrawer(currentStation);
      try {
        const result = await tuRadioCatalog.validateAndResolve(currentStation.dialsSourceRecord, radioApi);
        searchManager.mergeCatalog([result.station]);
        if (result.station.hasValidCoords) rememberMapStation(result.station);
        currentStation = result.station;
        displayStation(result.station, false);
        refreshGlobeStations();
        Utils.showToast(result.streamValid
          ? `${result.station.name}: áudio validado por ${result.streamSource}.`
          : `${result.station.name}: cadastro Dials confirmado, mas não encontrei stream reproduzível.`,
        result.streamValid ? 'success' : 'info', 4000);
      } catch (error) {
        Utils.showToast(`Não foi possível validar essa rádio: ${error.message}`, 'error', 5000);
      } finally {
        isDialsResolvingCurrent = false;
        if (currentStation?.dialsSourceRecord) renderStationDrawer(currentStation);
      }
    });
    document.getElementById('drawerShazamBtn')?.addEventListener('click', async event => {
      const button = event.currentTarget;
      const note = document.getElementById('drawerShazamNote');
      if (!currentStation?.streamUrl) return;
      button.disabled = true;
      button.textContent = 'IDENTIFICANDO…';
      try {
        if (note) note.textContent = 'Consultando metadata do stream; depois tenta reconhecimento de áudio se habilitado.';
        const result = await metadataManager.identifyCurrentStation();
        if (!result.ok) throw new Error(result.reason === 'no-match' ? 'Não encontrei a faixa: a rádio não enviou metadata e o reconhecimento de áudio não está configurado/disponível.' : result.reason || 'Faixa não identificada.');
        Utils.showToast(`${result.track.source}: ${result.track.artist ? `${result.track.artist} — ` : ''}${result.track.title}`, 'success', 4500);
        if (note) note.textContent = `Identificada por ${result.track.source || 'metadata da rádio'}: ${result.track.artist ? `${result.track.artist} — ` : ''}${result.track.title}`;
      } catch (error) {
        if (note) note.textContent = error.message;
        Utils.showToast(error.message, 'error', 5000);
      } finally {
        button.disabled = !currentStation?.hasStream;
        button.textContent = 'IDENTIFICAR MÚSICA';
      }
    });

    const btnCloseDrawer = document.getElementById('btnCloseDrawer');
    if (btnCloseDrawer) {
      btnCloseDrawer.addEventListener('click', () => {
        stationPanel.classList.add('hidden');
      });
    }

    const drawerFavBtn = document.getElementById('drawerFavBtn');
    if (drawerFavBtn) {
      drawerFavBtn.addEventListener('click', () => {
        toggleFavorite(currentStation);
      });
      updateDrawerFavoriteButton();
    }
  }

  function updateRadioDiagnostics() {
    const container = document.getElementById('debugRadioDetails');
    if (!container || !currentStation) return;
    const state = window.appState.getState();
    const track = state.currentTrack || {};
    const audio = audioPlayer.getAudioElement();
    const streamState = currentStation.lastCheckStatus || 'unknown';
    const rows = [
      ['Estação', currentStation.name || 'Não informada'],
      ['Stream', currentStation.streamUrl || 'Não informado'],
      ['Fonte', currentStation.source || 'Não informada'],
      ['HTTP atual', 'Não exposto pelo elemento de áudio do navegador'],
      ['Codec / bitrate', [currentStation.codec, currentStation.bitrate ? `${currentStation.bitrate} kbps` : ''].filter(Boolean).join(' · ') || 'Não informado'],
      ['Última verificação do diretório', streamState === 'unknown' ? 'Sem confirmação' : streamState === 'online' ? 'Online na última verificação' : 'Offline na última verificação'],
      ['Metadata / Now Playing', track.title ? `${track.artist ? `${track.artist} — ` : ''}${track.title} · ${track.source} · ${track.confidence}` : 'Faixa não identificada'],
      ['Áudio', `${state.playbackState} · readyState ${audio.readyState} · networkState ${audio.networkState}`],
      ['CORS', 'Acesso de metadata não medido; reprodução nativa preservada'],
      ['Latência', 'Não medida pelo navegador neste player'],
      ['Erro / estado atual', state.errorDetails || state.statusText || 'Sem erro informado'],
      ['Última checagem', currentStation.lastCheckTime || 'Não informada']
    ];
    container.innerHTML = rows.map(([label, value]) => `<div class="radio-debug-row"><dt>${escape(label)}</dt><dd>${escape(String(value))}</dd></div>`).join('');
  }

  globe.onStationSelect = (station) => {
    if (station.isDialsCityHub) {
      const city = tuRadioNationalCities.find(item => item.path === station.dialsCityPath);
      if (city) {
        tuRadioSelectedUf = city.state;
        tuRadioCities = tuRadioNationalCities.filter(item => item.state === city.state);
        tuRadioSelectedCityPath = city.path;
        tuRadioCityStations = tuRadioNationalStations.filter(item => item.cityPageUrl === `https://tudoradio.com${city.path}`);
        tuRadioProgress = `${tuRadioCityStations.length.toLocaleString('pt-BR')} registros Dials em ${city.slug.replace(/^\d+-/, '').replace(/-/g, ' ')}. Pin aproximado no centro da cidade.`;
        renderUtilityPanel('dials');
      }
      return;
    }
    displayStation(station, false);
    Utils.showToast(station.hasStream ? 'Estação selecionada. Pressione play para ouvir.' : 'Esta estação não tem transmissão cadastrada.', station.hasStream ? 'info' : 'error', 2500);
  };

  // 9. Carregamento Inicial de Estações
  async function loadInitialStations() {
    if (markerLoadingIndicator) markerLoadingIndicator.classList.add('visible');
    setSystemStatus('CONECTANDO', 'loading');

    try {
      const catalogStatsPromise = radioApi.getGlobalStats();
      const priorityCountry = window.WRG_CONFIG?.radioBrowser.priorityCountry || 'BR';
      let stations = [];
      try {
        stations = await radioApi.loadCountryStations(priorityCountry, {
          onProgress: progress => {
            setSystemStatus(`BRASIL ${progress.received.toLocaleString('pt-BR')}`, 'loading');
            if (stationCatalogCount) stationCatalogCount.title = `Carregando páginas brasileiras para teste: ${progress.received.toLocaleString('pt-BR')} estações encontradas.`;
          }
        });
      } catch (countryError) {
        console.warn('[App] Não foi possível completar páginas do Brasil; tentando amostra mundial:', countryError);
      }
      // Só cai para a amostra mundial quando o filtro brasileiro falha ou não retorna registros.
      if (!stations.length) {
        stations = await radioApi.searchStations({
          limit: window.WRG_CONFIG?.radioBrowser.startupStations || 1000,
          offset: 0, hasGeoOnly: true, order: 'random', preferHttps: true
        });
      }
      const catalogStats = await catalogStatsPromise;
      if (stations.length > 0) {
        stations.forEach(station => { if (station.countryCode === priorityCountry) priorityStationIds.add(station.id); });
        stations.forEach(rememberMapStation);
        refreshGlobeStations();
        searchManager.mergeCatalog(stations);
      }
      updateCatalogCounter(catalogStats?.totalStations);
      const mappableBrazil = stations.filter(station => station.countryCode === priorityCountry && station.hasValidCoords).length;
      setSystemStatus(stations?.length ? mappableBrazil ? `BRASIL ${mappableBrazil.toLocaleString('pt-BR')}` : 'AO VIVO' : 'SEM SINAL', stations?.length ? 'online' : 'offline');
      startGlobalCatalogLoad();
    } catch (err) {
      console.warn('[App] Falha ao carregar estações iniciais:', err);
      setSystemStatus('SEM CONEXÃO', 'offline');
      startGlobalCatalogLoad();
    } finally {
      if (markerLoadingIndicator) markerLoadingIndicator.classList.remove('visible');
    }
  }

  loadInitialStations();

  // Reuse the complete Brazilian Dials import and its city pins after reload.
  // This only reads IndexedDB; it does not contact Tudo Rádio or geocode again.
  tuRadioCatalog.getSavedNationalCatalog().then(async saved => {
    if (!saved) return;
    tuRadioNationalStations = saved.stations;
    tuRadioSearchStations = saved.stations.map(station => tuRadioCatalog.toUnverifiedStation(station));
    tuRadioNationalCities = saved.cities;
    tuRadioNationalCachePresent = true;
    searchManager.mergeCatalog(tuRadioSearchStations);
    await renderDialsCityPins(saved.cities, null, () => {}, false);
  }).catch(error => console.warn('[App] Não foi possível restaurar o Dials salvo:', error));

  // 10. Varredura por Viewport
  const handleViewportStations = Utils.debounce(async ({ west, south, east, north, altitude }) => {
    if (altitude > 12000000) return;

    if (markerLoadingIndicator) markerLoadingIndicator.classList.add('visible');

    try {
      const markerLimit = altitude < 900000 ? 280 : altitude < 3500000 ? 220 : altitude < 8000000 ? 140 : 80;
      const regionStations = await radioApi.getStationsInBoundingBox(south, west, north, east, markerLimit);
      if (regionStations && regionStations.length > 0) {
        regionStations.forEach(rememberMapStation);
        refreshGlobeStations();
        updateCatalogCounter();
      }
    } catch (e) {
      // Ignora erro de rede temporário
    } finally {
      if (markerLoadingIndicator) markerLoadingIndicator.classList.remove('visible');
    }
  }, 750);

  globe.onViewChange = handleViewportStations;

  // 11. Botão Sintonizar Estação Aleatória
  if (btnRandomStation) {
    btnRandomStation.addEventListener('click', async () => {
      dismissExplore();
      btnRandomStation.classList.add('active');
      Utils.showToast('Varrendo globo por estação aleatória...', 'info', 2000);

      try {
        const station = await radioApi.getRandomStation(true);
        btnRandomStation.classList.remove('active');

        if (station && station.hasValidCoords) {
          rememberMapStation(station);
          refreshGlobeStations();
          updateCatalogCounter();
          globe.flyTo(station.lat, station.lon, 2200000, 2.5);
          displayStation(station, true);
          Utils.showToast(`Sintonizada: ${station.name} (${station.country})`, 'success');
        } else {
          Utils.showToast('Nenhuma rádio localizada nesta varredura.', 'info');
        }
      } catch (err) {
        btnRandomStation.classList.remove('active');
        Utils.showToast('Falha na comunicação com a API de rádios.', 'error');
      }
    });
  }

  // 12. World Tour
  const tourCountries = [
    { code: 'BR', name: 'Brasil' },
    { code: 'GB', name: 'Reino Unido' },
    { code: 'FR', name: 'França' },
    { code: 'JP', name: 'Japão' },
    { code: 'US', name: 'Estados Unidos' },
    { code: 'AU', name: 'Austrália' }
  ];

  let tourIndex = 0;
  let tourInterval = null;

  if (btnWorldTour) {
    btnWorldTour.addEventListener('click', async () => {
      dismissExplore();
      if (tourInterval) {
        clearInterval(tourInterval);
        tourInterval = null;
        btnWorldTour.classList.remove('active');
        Utils.showToast('World Tour pausado.', 'info');
        return;
      }

      btnWorldTour.classList.add('active');
      Utils.showToast('World Tour: explorando capitais do rádio...', 'success');

      const stepTour = async () => {
        const currentCountry = tourCountries[tourIndex];
        tourIndex = (tourIndex + 1) % tourCountries.length;

        try {
          const stations = await radioApi.searchStations({
            countryCode: currentCountry.code,
            limit: 5,
            hasGeoOnly: true,
            preferHttps: true
          });

          if (stations && stations.length > 0) {
            const chosen = stations[0];
            rememberMapStation(chosen);
            refreshGlobeStations();
            updateCatalogCounter();
            globe.flyTo(chosen.lat, chosen.lon, 2500000, 3);
            displayStation(chosen, true);
            Utils.showToast(`World Tour: ${chosen.country} — ${chosen.name}`, 'info');
          }
        } catch (err) {
          console.warn('[WorldTour] Erro no tour:', err);
        }
      };

      await stepTour();
      tourInterval = setInterval(stepTour, 9000);
    });
  }

  // 13. Demais Botões do HUD
  if (btnResetView) {
    btnResetView.addEventListener('click', () => {
      globe.resetView(2);
      Utils.showToast('Visualização redefinida para órbita global.', 'info');
    });
  }

  if (btnToggleLighting) {
    btnToggleLighting.addEventListener('click', () => {
      const active = globe.toggleLighting();
      btnToggleLighting.classList.toggle('active', active);
      Utils.showToast(
        active ? 'Iluminação solar (Dia/Noite) ativada.' : 'Iluminação solar desativada.',
        'info'
      );
    });
  }

  // 14. Gestão do Modal Cesium Ion Token
  if (btnConfigToken && tokenModal) {
    btnConfigToken.addEventListener('click', () => {
      const curToken = localStorage.getItem('cesium_ion_token') || '';
      cesiumTokenInput.value = curToken;
      tokenModal.showModal();
    });
  }

  if (btnCloseModal && tokenModal) {
    btnCloseModal.addEventListener('click', () => {
      tokenModal.close();
    });
  }

  if (btnSaveToken && tokenModal) {
    btnSaveToken.addEventListener('click', () => {
      const token = cesiumTokenInput.value.trim();
      if (!token) {
        Utils.showToast('Informe um token válido ou use a opção de camada aberta.', 'error');
        return;
      }
      globe.setIonToken(token);
    });
  }

  if (btnUseDarkFallback && tokenModal) {
    btnUseDarkFallback.addEventListener('click', () => {
      globe.applyDarkBasemap();
      tokenModal.close();
      Utils.showToast('Camada escura Esri aplicada com sucesso.', 'success');
    });
  }

  // 15. Atalhos de Teclado
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      if (globalSearchInput) {
        globalSearchInput.focus();
        globalSearchInput.select();
      }
    }
    // Barra de Espaço para Play/Pausa (se não estiver digitando)
    if (e.code === 'Space' && document.activeElement.tagName !== 'INPUT') {
      e.preventDefault();
      audioPlayer.togglePlayPause();
    }
    if (e.key === 'Escape') {
      if (tokenModal && tokenModal.open) tokenModal.close();
      if (stationPanel && !stationPanel.classList.contains('hidden')) stationPanel.classList.add('hidden');
    }
  });

  setTimeout(() => {
    Utils.showToast('Central de Comunicações: Mapa e Sistema de Áudio Prontos.', 'success');
  }, 1000);
});
