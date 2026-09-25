/** Consulta e valida registros públicos do Tudo Rádio Dials antes de usar streams. */
class TuRadioCatalogClient {
  constructor() {
    this.cityCache = new Map();
    this.stationCache = new Map();
    this.staticIndexPromise = null;
    this.staticCatalogAvailable = null;
  }

  async _json(url, options = {}) {
    const response = await fetch(url, { cache: 'no-store', ...options });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(data.error || `Tudo Rádio respondeu HTTP ${response.status}.`);
      error.status = response.status;
      throw error;
    }
    return data;
  }

  async _staticIndex() {
    if (!this.staticIndexPromise) {
      this.staticIndexPromise = fetch('data/tudoradio/index.json', { cache: 'no-cache' }).then(async response => {
        if (!response.ok) {
          const error = new Error(response.status === 404
            ? 'Catálogo Dials não publicado neste site estático. Gere os arquivos de dados antes de publicar.'
            : `Não foi possível carregar o índice estático do catálogo (HTTP ${response.status}).`);
          error.staticCatalogMissing = response.status === 404;
          throw error;
        }
        const index = await response.json();
        if (index?.source !== 'Tudo Rádio Dials' || !Array.isArray(index.cities)) throw new Error('O índice estático do Dials está inválido.');
        this.staticCatalogAvailable = true;
        return index;
      }).catch(error => {
        this.staticCatalogAvailable = false;
        this.staticIndexPromise = null;
        throw error;
      });
    }
    return this.staticIndexPromise;
  }

  async _withStaticFallback(apiRequest, fallback) {
    try { return await apiRequest(); }
    catch (error) {
      if (error.status !== 404) throw error;
      this.staticCatalogAvailable = true;
      return fallback();
    }
  }

  async getCities(uf, { signal } = {}) {
    const code = String(uf || '').toUpperCase();
    if (!/^(AC|AL|AP|AM|BA|CE|DF|ES|GO|MA|MT|MS|MG|PA|PB|PR|PE|PI|RJ|RN|RS|RO|RR|SC|SP|SE|TO)$/.test(code)) {
      throw new Error('Escolha uma UF brasileira válida.');
    }
    if (!this.cityCache.has(code)) {
      this.cityCache.set(code, this._withStaticFallback(
        () => this._json(`api/tudoradio/cities?uf=${code}`, { signal }).then(result => result.cities || []),
        async () => (await this._staticIndex()).cities.filter(city => city.state === code)
      )
        .catch(error => { this.cityCache.delete(code); throw error; }));
    }
    return this.cityCache.get(code);
  }

  async getCityStations(city, { signal, cache = true } = {}) {
    if (!city?.path || !/^\/dials\/cidade\/\d+-[a-z0-9-]+$/i.test(city.path)) throw new Error('Escolha uma cidade do catálogo Dials.');
    const id = city.path.split('/').pop();
    const load = () => this._withStaticFallback(
      () => this._json(`api/tudoradio/city?id=${encodeURIComponent(id)}`, { signal }),
      async () => {
        const response = await fetch(`data/tudoradio/cities/${encodeURIComponent(id)}.json`, { signal, cache: 'force-cache' });
        if (!response.ok) throw new Error(response.status === 404
          ? 'Esta cidade não está incluída no catálogo estático publicado.'
          : `Não foi possível carregar esta cidade (HTTP ${response.status}).`);
        return response.json();
      }
    );
    if (!cache) return load();
    if (!this.stationCache.has(city.path)) {
      this.stationCache.set(city.path, load()
        .catch(error => { this.stationCache.delete(city.path); throw error; }));
      if (this.stationCache.size > 40) this.stationCache.delete(this.stationCache.keys().next().value);
    }
    return this.stationCache.get(city.path);
  }

  async findDialsStation(name, { uf, city, signal } = {}) {
    const normalize = value => this._normalizeName(value);
    const targetName = normalize(name);
    const targetCity = normalize(String(city || '').split(/[,/]|\s[-–—]\s(?=[A-Z]{2}(?:\b|$))/i)[0]);
    const stateCodes = { acre: 'AC', alagoas: 'AL', amap: 'AP', amazonas: 'AM', bahia: 'BA', ceara: 'CE', 'distrito federal': 'DF',
      'espirito santo': 'ES', goias: 'GO', maranhao: 'MA', 'mato grosso': 'MT', 'mato grosso do sul': 'MS', 'minas gerais': 'MG', para: 'PA',
      paraiba: 'PB', parana: 'PR', pernambuco: 'PE', piaui: 'PI', 'rio de janeiro': 'RJ', 'rio grande do norte': 'RN',
      'rio grande do sul': 'RS', rondonia: 'RO', roraima: 'RR', 'santa catarina': 'SC', sergipe: 'SE', tocantins: 'TO', 'sao paulo': 'SP' };
    const ufValue = String(uf || '').trim();
    const code = /^[A-Z]{2}$/i.test(ufValue) ? ufValue.toUpperCase() : stateCodes[normalize(ufValue)];
    if (!targetName || !code || !targetCity) return null;
    const cities = await this.getCities(code, { signal });
    const dialsCity = cities.find(item => normalize(item.slug.replace(/^\d+-/, '')) === targetCity) ||
      cities.find(item => normalize(item.slug.replace(/^\d+-/, '')).includes(targetCity) || targetCity.includes(normalize(item.slug.replace(/^\d+-/, ''))));
    if (!dialsCity) return null;
    const result = await this.getCityStations(dialsCity, { signal });
    const matches = (result.stations || []).map(station => {
      const stationName = normalize(station.name);
      const nameMatch = stationName === targetName || stationName.includes(targetName) || targetName.includes(stationName);
      const transmitter = normalize(station.transmitterCity);
      const locationMatch = !transmitter || transmitter === targetCity || transmitter.includes(targetCity) || targetCity.includes(transmitter);
      return { station, nameMatch, locationMatch, score: Number(stationName === targetName) * 2 + Number(locationMatch) };
    }).filter(item => item.nameMatch && item.locationMatch).sort((a, b) => b.score - a.score);
    return matches[0]?.station || null;
  }

  async validateStream(streamUrl, { signal } = {}) {
    if (!streamUrl) return { valid: false, reason: 'O Dials não forneceu uma URL de transmissão.' };
    const result = await this._json('api/tudoradio/validate-stream', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ streamUrl }), signal
    });
    return result;
  }

  async loadNationalCatalog({ onProgress = () => {}, signal = null, concurrency = 4 } = {}) {
    const states = ['AC', 'AL', 'AP', 'AM', 'BA', 'CE', 'DF', 'ES', 'GO', 'MA', 'MT', 'MS', 'MG', 'PA', 'PB', 'PR', 'PE', 'PI', 'RJ', 'RN', 'RS', 'RO', 'RR', 'SC', 'SP', 'SE', 'TO'];
    const stateCities = new Map();
    // Probe one API route first. GitHub Pages returns 404 for it, so switch to
    // its prebuilt index before issuing the other 26 state requests.
    let apiProbeError = null;
    if (location.protocol !== 'file:') {
      try { stateCities.set('PR', await this.getCities('PR', { signal })); }
      catch (error) {
        if (error.staticCatalogMissing) throw error;
        apiProbeError = error;
      }
      if (apiProbeError?.status === 404 || this.staticCatalogAvailable) {
        const index = await this._staticIndex();
        stateCities.clear();
        for (const uf of states) {
          const cities = index.cities.filter(city => city.state === uf);
          if (cities.length) stateCities.set(uf, cities);
          onProgress({ phase: 'states', uf, completed: stateCities.size, total: states.length });
        }
        if (!stateCities.size) throw new Error('O índice estático não contém cidades brasileiras.');
      }
    }
    if (!stateCities.size) {
      let stateIndex = 0;
      const stateWorker = async () => {
        while (stateIndex < states.length && !signal?.aborted) {
          const uf = states[stateIndex++];
          if (stateCities.has(uf)) continue;
          try { stateCities.set(uf, await this.getCities(uf, { signal })); }
          catch (error) { onProgress({ phase: 'states', uf, error: error.message, completed: stateCities.size, total: states.length }); }
          onProgress({ phase: 'states', uf, completed: stateCities.size, total: states.length });
        }
      };
      await Promise.all(Array.from({ length: Math.min(concurrency, states.length) }, stateWorker));
      }
    if (signal?.aborted) throw new DOMException('Importação cancelada.', 'AbortError');
    const cities = Array.from(stateCities.values()).flat();
    const uniqueCities = Array.from(new Map(cities.map(city => [city.path, city])).values());
    const stations = new Map();
    let cityIndex = 0;
    let completedCities = 0;
    const cityWorker = async () => {
      while (cityIndex < uniqueCities.length && !signal?.aborted) {
        const city = uniqueCities[cityIndex++];
        try {
          const result = await this.getCityStations(city, { signal, cache: false });
          for (const station of result.stations || []) {
            const prior = stations.get(station.id);
            const score = item => Number(Boolean(item.streamUrl)) * 4 + Number(Boolean(item.classAndCallsign)) * 2 + Object.keys(item.technical || {}).filter(key => item.technical[key] && item.technical[key] !== '$undefined').length;
            if (!prior || score(station) > score(prior)) stations.set(station.id, station);
          }
        } catch (error) {
          if (error.name === 'AbortError') throw error;
          onProgress({ phase: 'cities', city, error: error.message, completed: completedCities, total: uniqueCities.length, stationCount: stations.size });
        }
        completedCities += 1;
        onProgress({ phase: 'cities', city, completed: completedCities, total: uniqueCities.length, stationCount: stations.size });
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, uniqueCities.length) }, cityWorker));
    if (signal?.aborted) throw new DOMException('Importação cancelada.', 'AbortError');
    return { stations: Array.from(stations.values()), cities: uniqueCities, statesLoaded: stateCities.size };
  }

  toUnverifiedStation(dialsStation) {
    return {
      id: `tudoradio-${dialsStation.id}`, sourceId: dialsStation.id,
      name: dialsStation.name, streamUrl: null, hasStream: false, isHttps: false,
      hasValidCoords: false, lat: null, lon: null, country: 'Brasil', countryCode: 'BR',
      state: dialsStation.state, city: dialsStation.transmitterCity || dialsStation.receptionCity,
      language: 'português', tags: [dialsStation.band, `${dialsStation.frequency} ${dialsStation.band}`].filter(Boolean),
      favicon: null, codec: 'Não validado', bitrate: 0, votes: 0, clickCount: 0,
      homepage: dialsStation.homepage, lastCheckOk: false, lastCheckStatus: 'unknown', lastCheckTime: null,
      nowPlaying: null, metadataAvailable: false, locationAccuracy: 'unknown', source: 'Tudo Rádio Dials',
      dialsCandidateStreamUrl: dialsStation.streamUrl, dialsSourceRecord: dialsStation,
      dialsId: dialsStation.id, dialsFrequency: dialsStation.frequency, dialsBand: dialsStation.band,
      dialsSignal: dialsStation.signal, dialsRds: dialsStation.rds,
      dialsClassAndCallsign: dialsStation.classAndCallsign, dialsTechnical: dialsStation.technical,
      dialsValidated: true, dialsCity: dialsStation.receptionCity, listenPageUrl: dialsStation.listenPageUrl,
      dialsDetailsUrl: dialsStation.detailsUrl, dialsCityPageUrl: dialsStation.cityPageUrl
    };
  }

  _normalizeName(value) {
    return String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase()
      .replace(/\b(radio|fm|am|de|do|da|the)\b/g, ' ').replace(/[^a-z0-9]+/g, ' ').trim().replace(/\s+/g, ' ');
  }

  _sameStationArea(candidate, dialsStation) {
    if (String(candidate.countryCode || '').toUpperCase() !== 'BR') return false;
    const normalize = value => this._normalizeName(value);
    const targetCity = normalize(dialsStation.transmitterCity || dialsStation.receptionCity);
    const targetState = normalize(dialsStation.state);
    const candidateCity = normalize(candidate.city);
    const candidateState = normalize(candidate.state);
    if (targetCity) return Boolean(candidateCity && (candidateCity === targetCity || candidateCity.includes(targetCity) || targetCity.includes(candidateCity)));
    return Boolean(targetState && candidateState && targetState === candidateState);
  }

  async findWorkingAlternative(dialsStation, radioApi, { signal, maxCandidates = 5, excludeStreamUrls } = {}) {
    const dialsName = this._normalizeName(dialsStation.name);
    if (!dialsName) return null;
    const candidates = await radioApi.searchStations({
      name: dialsStation.name, countryCode: 'BR', limit: 40, hasGeoOnly: false,
      hideBroken: false, order: 'clickcount', signal
    }).catch(() => []);
    const normalized = candidates.map(candidate => {
      const candidateName = this._normalizeName(candidate.name);
      const exact = candidateName === dialsName;
      const contains = candidateName.includes(dialsName) || dialsName.includes(candidateName);
      const tokens = new Set(dialsName.split(' '));
      const overlap = candidateName.split(' ').filter(token => tokens.has(token)).length / Math.max(1, tokens.size);
      const sameArea = this._sameStationArea(candidate, dialsStation);
      const frequency = Number(dialsStation.frequency).toFixed(1);
      const hasFrequency = `${candidate.name} ${(candidate.tags || []).join(' ')}`.replace(',', '.').includes(frequency);
      const score = (exact ? 1 : contains ? 0.8 : overlap) + (sameArea ? 0.5 : 0) + (hasFrequency ? 0.4 : 0);
      return { candidate, sameArea, hasFrequency, score, acceptable: sameArea && (exact || contains || overlap >= 0.6) };
    }).filter(item => item.acceptable).sort((a, b) => b.score - a.score).slice(0, maxCandidates);

    for (const item of normalized) {
      if (signal?.aborted) throw new DOMException('Validação cancelada.', 'AbortError');
      const candidateUrl = String(item.candidate.streamUrl || '').trim().toLowerCase();
      if (excludeStreamUrls?.has(candidateUrl)) continue;
      const checked = await this.validateStream(item.candidate.streamUrl, { signal }).catch(() => ({ valid: false }));
      if (!checked.valid) continue;
      return {
        ...item.candidate,
        streamUrl: checked.url || item.candidate.streamUrl, hasStream: true,
        isHttps: String(checked.url || item.candidate.streamUrl).startsWith('https://'),
        lastCheckOk: true, lastCheckStatus: 'online', lastCheckTime: new Date().toISOString(),
        source: 'Tudo Rádio Dials + Radio Browser', streamValidation: checked
      };
    }
    return null;
  }

  async validateAndResolve(dialsStation, radioApi, options = {}) {
    const recordValid = Boolean(dialsStation?.id && dialsStation?.name && Number.isFinite(Number(dialsStation.frequency)) && dialsStation.cityPageUrl);
    if (!recordValid) throw new Error('O registro Dials não passou pela validação de dados básicos.');
    let checked = await this.validateStream(dialsStation.streamUrl, options).catch(error => ({ valid: false, reason: error.message }));
    if (checked.valid && options.excludeStreamUrls?.has(String(checked.url || dialsStation.streamUrl).trim().toLowerCase())) {
      checked = { ...checked, valid: false, reason: 'Esse endereço já falhou durante esta sessão.' };
    }
    let station;
    if (checked.valid) {
      station = {
        id: `tudoradio-${dialsStation.id}`, sourceId: dialsStation.id,
        name: dialsStation.name, streamUrl: checked.url || dialsStation.streamUrl, hasStream: true,
        isHttps: String(checked.url || dialsStation.streamUrl).startsWith('https://'),
        hasValidCoords: false, lat: null, lon: null, country: 'Brasil', countryCode: 'BR',
        state: dialsStation.state, city: dialsStation.transmitterCity || dialsStation.receptionCity,
        language: 'português', tags: [dialsStation.band, `${dialsStation.frequency} ${dialsStation.band}`].filter(Boolean),
        favicon: null, codec: checked.contentType || 'ÁUDIO', bitrate: 0, votes: 0, clickCount: 0,
        homepage: dialsStation.homepage, lastCheckOk: true, lastCheckStatus: 'online',
        lastCheckTime: new Date().toISOString(), nowPlaying: null, metadataAvailable: false,
        locationAccuracy: 'unknown', source: 'Tudo Rádio Dials', streamValidation: checked
      };
    } else {
      station = await this.findWorkingAlternative(dialsStation, radioApi, options);
    }
    if (station) {
      station = {
        ...station,
        dialsId: dialsStation.id, dialsFrequency: dialsStation.frequency, dialsBand: dialsStation.band,
        dialsSignal: dialsStation.signal, dialsRds: dialsStation.rds,
        dialsClassAndCallsign: dialsStation.classAndCallsign, dialsTechnical: dialsStation.technical,
        dialsValidated: true, dialsCity: dialsStation.receptionCity, listenPageUrl: dialsStation.listenPageUrl,
        dialsDetailsUrl: dialsStation.detailsUrl, dialsCityPageUrl: dialsStation.cityPageUrl,
        dialsSourceRecord: dialsStation
      };
      return { station, recordValid: true, streamValid: true, streamSource: checked.valid ? 'Tudo Rádio Dials' : 'Radio Browser', directCheck: checked };
    }

    station = {
      id: `tudoradio-${dialsStation.id}`, sourceId: dialsStation.id,
      name: dialsStation.name, streamUrl: null, hasStream: false, isHttps: false,
      hasValidCoords: false, lat: null, lon: null, country: 'Brasil', countryCode: 'BR',
      state: dialsStation.state, city: dialsStation.transmitterCity || dialsStation.receptionCity,
      language: 'português', tags: [dialsStation.band, `${dialsStation.frequency} ${dialsStation.band}`].filter(Boolean),
      favicon: null, codec: 'Não validado', bitrate: 0, votes: 0, clickCount: 0,
      homepage: dialsStation.homepage, lastCheckOk: false, lastCheckStatus: 'unknown', lastCheckTime: null,
      nowPlaying: null, metadataAvailable: false, locationAccuracy: 'unknown', source: 'Tudo Rádio Dials',
      dialsId: dialsStation.id, dialsFrequency: dialsStation.frequency, dialsBand: dialsStation.band,
      dialsSignal: dialsStation.signal, dialsRds: dialsStation.rds,
      dialsClassAndCallsign: dialsStation.classAndCallsign, dialsTechnical: dialsStation.technical,
      dialsValidated: true, dialsCity: dialsStation.receptionCity, listenPageUrl: dialsStation.listenPageUrl,
      dialsDetailsUrl: dialsStation.detailsUrl, dialsCityPageUrl: dialsStation.cityPageUrl,
      streamValidation: checked, dialsSourceRecord: dialsStation
    };
    return { station, recordValid: true, streamValid: false, streamSource: null, directCheck: checked };
  }
}

window.TuRadioCatalogClient = TuRadioCatalogClient;
