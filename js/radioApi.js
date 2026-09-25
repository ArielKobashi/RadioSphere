/**
 * WORLD RADIO GLOBE — Provedor de API de Rádio (radioApi.js)
 * Integração robusta com a Radio Browser API e Nominatim (OpenStreetMap)
 * Arquitetura resiliente com failover de espelhos (mirrors), cache em memória e normalização de dados.
 */

class RadioApiClient {
  constructor() {
    // Lista de espelhos oficiais da Radio Browser API
    this.mirrors = [
      'https://de1.api.radio-browser.info',
      'https://nl1.api.radio-browser.info',
      'https://at1.api.radio-browser.info'
    ];
    this.activeMirror = this.mirrors[0];
    this.isResolvingMirror = false;
    
    // Cache em memória para evitar requisições redundantes (TTL 5 minutos)
    this.cache = new Map();
    this.cacheTtlMs = window.WRG_CONFIG?.radioBrowser.cacheTtlMs || 5 * 60 * 1000;
    this.requestTimeoutMs = window.WRG_CONFIG?.radioBrowser.requestTimeoutMs || 7000;
    this.geocodeQueue = Promise.resolve();
    this.lastGeocodeAt = 0;
    this.iprdCatalogPromise = null;
    this.iprdCatalogExpiresAt = 0;
    this.catalogDbPromise = null;
    this.catalogLoadPromise = null;
    this.catalogAbortController = null;
    this.catalogStations = new Map();
    this.catalogDuplicatesRemoved = 0;
    this.catalogPersistentCache = false;
    this.catalogStatus = { phase: 'idle', received: 0, total: null, complete: false, cached: false };
    this.radioCountriesPromise = null;

    // Headers recomendados pelas diretrizes da Radio Browser API
    this.requestHeaders = {
      'Accept': 'application/json'
    };

    // Inicializa resolução do mirror mais veloz/ativo
    this.resolveActiveMirror();
  }

  /**
   * Resolve o espelho ativo via DNS ou ping aos servidores oficiais
   * @returns {Promise<string>}
   */
  async resolveActiveMirror() {
    if (this.isResolvingMirror) return this.activeMirror;
    this.isResolvingMirror = true;

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 3500);
      let response;
      try {
        response = await fetch('https://all.api.radio-browser.info/json/servers', {
          headers: this.requestHeaders,
          signal: controller.signal
        });
      } finally {
        clearTimeout(timeoutId);
      }

      if (response.ok) {
        const servers = await response.json();
        if (Array.isArray(servers) && servers.length > 0) {
          const selected = servers.find(server => /^[a-z0-9.-]+\.api\.radio-browser\.info$/i.test(server.name));
          if (selected) this.activeMirror = `https://${selected.name}`;
          console.log(`[RadioApi] Espelho ativo conectado: ${this.activeMirror}`);
          this.isResolvingMirror = false;
          return this.activeMirror;
        }
      }
    } catch (e) {
      console.warn('[RadioApi] Resolução automática de espelhos falhou, usando lista de contingência:', e.message);
    }

    // Fallback sequencial se a resolução falhar
    this.activeMirror = this.mirrors[0];
    this.isResolvingMirror = false;
    return this.activeMirror;
  }

  /**
   * Executa requisição fetch com timeout e failover automático para espelhos alternativos
   * @private
   * @param {string} endpoint 
   * @param {Object} queryParams 
   * @returns {Promise<any>}
   */
  async _fetchWithFailover(endpoint, queryParams = {}, externalSignal = null) {
    const queryString = new URLSearchParams(queryParams).toString();
    const cacheKey = `${endpoint}?${queryString}`;

    // Verificação de cache em memória
    const cached = this.cache.get(cacheKey);
    if (cached && (Date.now() - cached.timestamp < this.cacheTtlMs)) {
      return cached.data;
    }

    const mirrorsToTry = [this.activeMirror, ...this.mirrors.filter(m => m !== this.activeMirror)];

    for (const mirror of mirrorsToTry) {
      if (externalSignal?.aborted) throw new Error('Requisição cancelada.');
      try {
        const url = `${mirror}${endpoint}${queryString ? `?${queryString}` : ''}`;
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), this.requestTimeoutMs);
        const abortRequest = () => controller.abort();
        if (externalSignal?.aborted) controller.abort();
        else externalSignal?.addEventListener('abort', abortRequest, { once: true });
        let response;
        let data;
        try {
          response = await fetch(url, {
            method: 'GET',
            headers: this.requestHeaders,
            signal: controller.signal
          });
          if (response.ok) data = await response.json();
        } finally {
          clearTimeout(timeoutId);
          externalSignal?.removeEventListener('abort', abortRequest);
        }

        if (response.ok) {
          this.activeMirror = mirror; // Define o mirror de sucesso como prioritário

          // Salva no cache
          this.cache.set(cacheKey, {
            data,
            timestamp: Date.now()
          });

          return data;
        }
        if (response.status < 500 && response.status !== 429) break;
      } catch (err) {
        console.warn(`[RadioApi] Falha no espelho ${mirror}: ${err.message}. Tentando próximo...`);
      }
    }

    if (externalSignal?.aborted) throw new Error('Requisição cancelada.');
    if (cached && Date.now() - cached.timestamp < 24 * 60 * 60 * 1000) return cached.data;
    throw new Error('Todos os servidores da Radio Browser API estão inacessíveis no momento.');
  }

  /**
   * Normaliza um objeto cru retornado pela Radio Browser API
   * Valida coordenadas geográficas e segurança de stream
   * @param {Object} raw 
   * @returns {Object|null} Objeto normalizado ou null se inválido
   */
  normalizeStation(raw) {
    if (!raw || !raw.name || !raw.stationuuid) return null;

    const lat = parseFloat(raw.geo_lat);
    const lon = parseFloat(raw.geo_long);

    // Valida coordenadas geográficas reais WGS84
    const hasValidCoords = !isNaN(lat) && !isNaN(lon) && 
      lat >= -90 && lat <= 90 && 
      lon >= -180 && lon <= 180 &&
      !(lat === 0 && lon === 0); // Descarta nulos codificados como 0,0 no oceano atlântico equatorial

    const streamUrl = this.safeHttpUrl(raw.url_resolved || raw.url);
    const isCapitalCascavel = String(raw.countrycode || '').toUpperCase() === 'BR' &&
      /capital\s*fm/i.test(raw.name) && /cascavel/i.test(`${raw.city || ''} ${raw.state || ''}`);
    const homepage = isCapitalCascavel ? 'https://capitalfm.com.br/' : this.safeHttpUrl(raw.homepage);
    const listenPageUrl = isCapitalCascavel ? 'https://tudoradio.com/player/radio/986-capital-fm' : null;

    // Detecta se a transmissão é segura (HTTPS) para evitar bloqueio de Mixed Content
    const isHttps = Boolean(streamUrl && streamUrl.toLowerCase().startsWith('https://'));

    // Sanitiza tags/gêneros musicais
    const tags = (raw.tags || '')
      .split(',')
      .map(t => t.trim().toLowerCase())
      .filter(t => t.length > 1 && t.length < 25)
      .slice(0, 5);

    return {
      id: raw.stationuuid,
      sourceId: raw.stationuuid,
      name: raw.name.trim(),
      streamUrl,
      hasStream: Boolean(streamUrl),
      isHttps: isHttps,
      hasValidCoords: hasValidCoords,
      lat: hasValidCoords ? lat : null,
      lon: hasValidCoords ? lon : null,
      country: raw.country || 'Desconhecido',
      countryCode: (raw.countrycode || '').toUpperCase(),
      state: raw.state || '',
      city: raw.city || '',
      language: raw.language || '',
      tags: tags,
      favicon: this.safeHttpUrl(raw.favicon),
      codec: (raw.codec || 'MP3').toUpperCase(),
      bitrate: parseInt(raw.bitrate, 10) || 128,
      votes: parseInt(raw.votes, 10) || 0,
      clickCount: parseInt(raw.clickcount, 10) || 0,
      homepage,
      listenPageUrl,
      lastCheckOk: raw.lastcheckok === true || raw.lastcheckok === '1' || raw.lastcheckok === 1,
      lastCheckStatus: raw.lastcheckok === true || raw.lastcheckok === '1' || raw.lastcheckok === 1
        ? 'online'
        : (raw.lastchecktime_iso || raw.lastchecktime) &&
          (raw.lastcheckok === false || raw.lastcheckok === '0' || raw.lastcheckok === 0)
          ? 'offline' : 'unknown',
      lastCheckTime: raw.lastchecktime_iso || raw.lastchecktime || null,
      nowPlaying: null,
      metadataAvailable: false,
      locationAccuracy: hasValidCoords ? 'exact' : 'unknown',
      source: 'Radio Browser'
    };
  }

  safeHttpUrl(value) {
    if (typeof value !== 'string' || !value.trim()) return null;
    try {
      const url = new URL(value.trim());
      return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.href : null;
    } catch {
      return null;
    }
  }

  /**
   * Busca estações com coordenadas geográficas e filtros aplicados
   * Prioriza rádios com streaming HTTPS ativo
   * @param {Object} options
   * @returns {Promise<Array<Object>>}
   */
  async searchStations(options = {}) {
    const {
      name,
      country,
      countryCode,
      tag,
      language,
      limit = 60,
      offset = 0,
      order = 'votes',
      reverse = true,
      hasGeoOnly = true,
      preferHttps = true,
      hideBroken = true,
      signal = null
    } = options;

    const queryParams = {
      limit: Math.max(1, Math.min(Number(limit) || 60, window.WRG_CONFIG?.radioBrowser.maxPageSize || 1000)),
      offset: offset,
      order: order,
      reverse: reverse ? 'true' : 'false',
      hidebroken: hideBroken ? 'true' : 'false'
    };

    if (hasGeoOnly === true) queryParams.has_geo_info = 'true';
    if (name) queryParams.name = name.trim();
    if (country) queryParams.country = country.trim();
    if (countryCode) queryParams.countrycode = countryCode.trim().toUpperCase();
    if (tag) queryParams.tag = tag.trim().toLowerCase();
    if (language) queryParams.language = language.trim().toLowerCase();

    try {
      const rawStations = await this._fetchWithFailover('/json/stations/search', queryParams, signal);

      if (!Array.isArray(rawStations) || rawStations.length === 0) {
        return [];
      }

      // Normaliza e descarta inválidos
      let normalized = rawStations
        .map(s => this.normalizeStation(s))
        .filter(s => s !== null && (hasGeoOnly ? s.hasValidCoords : true));

      // Ordena preferencialmente streams HTTPS para topo da lista (segurança de reprodução)
      if (preferHttps) {
        normalized.sort((a, b) => {
          if (a.isHttps && !b.isHttps) return -1;
          if (!a.isHttps && b.isHttps) return 1;
          return b.votes - a.votes;
        });
      }

      return normalized;
    } catch (err) {
      console.error('[RadioApi] Erro na busca de estações:', err);
      throw err;
    }
  }

  async getCountries() {
    if (this.radioCountriesPromise) return this.radioCountriesPromise;
    this.radioCountriesPromise = this._fetchWithFailover('/json/countries', { order: 'name', reverse: 'false' })
      .then(rows => (Array.isArray(rows) ? rows : []).map(row => ({
        code: String(row.countrycode || '').trim().toUpperCase(),
        name: String(row.name || '').trim(),
        stationCount: Number(row.stationcount) || 0
      })).filter(row => /^[A-Z]{2}$/.test(row.code) && row.name)
        .sort((a, b) => a.name.localeCompare(b.name, 'pt-BR')))
      .catch(error => { this.radioCountriesPromise = null; throw error; });
    return this.radioCountriesPromise;
  }

  /** Estatísticas oficiais do diretório; nulas quando a fonte está indisponível. */
  async getGlobalStats(signal = null) {
    try {
      const stats = await this._fetchWithFailover('/json/stats', {}, signal);
      const total = Number(stats?.stations);
      const broken = Number(stats?.stations_broken);
      if (!Number.isFinite(total)) return null;
      return {
        totalStations: total,
        brokenStations: Number.isFinite(broken) ? broken : null,
        countries: Number.isFinite(Number(stats?.countries)) ? Number(stats.countries) : null,
        languages: Number.isFinite(Number(stats?.languages)) ? Number(stats.languages) : null,
        checkedAt: Date.now(),
        source: 'Radio Browser'
      };
    } catch (_) {
      return null;
    }
  }

  /** Percorre todas as páginas de um país para priorizar testes locais. */
  async loadCountryStations(countryCode, { onProgress = () => {}, signal = null, maxPages = 1000 } = {}) {
    const code = String(countryCode || '').trim().toUpperCase();
    if (!/^[A-Z]{2}$/.test(code)) throw new Error('Código de país inválido.');
    const pageSize = 1000;
    const unique = new Map();
    let offset = 0;
    let pages = 0;
    let emptyPages = 0;
    onProgress({ countryCode: code, received: 0, phase: 'loading' });
    while (pages < Math.max(1, maxPages)) {
      if (signal?.aborted) break;
      const batchOffsets = [offset, offset + pageSize];
      const batch = await Promise.allSettled(batchOffsets.map(pageOffset => this.searchStations({
        countryCode: code, limit: pageSize, offset: pageOffset, hasGeoOnly: false,
        preferHttps: false, hideBroken: false, order: 'votes', reverse: true, signal
      })));
      let reachedEnd = false;
      for (let index = 0; index < batch.length; index += 1) {
        const result = batch[index];
        const pageOffset = batchOffsets[index];
        pages += 1;
        if (result.status !== 'fulfilled') throw result.reason || new Error(`Falha ao carregar ${code} offset ${pageOffset}.`);
        const stations = result.value || [];
        if (!stations.length) { emptyPages += 1; reachedEnd = true; }
        else {
          emptyPages = 0;
          stations.forEach(station => unique.set(station.id, station));
          if (stations.length < pageSize) reachedEnd = true;
        }
        onProgress({ countryCode: code, received: unique.size, pages, phase: 'loading' });
      }
      offset += pageSize * batch.length;
      if (reachedEnd) break;
      const delay = window.WRG_CONFIG?.radioBrowser.catalogBatchDelayMs || 0;
      if (delay && pages < maxPages && !signal?.aborted) await new Promise(resolve => setTimeout(resolve, delay));
    }
    const stations = [...unique.values()];
    onProgress({ countryCode: code, received: stations.length, pages, phase: signal?.aborted ? 'cancelled' : 'ready' });
    return stations;
  }

  _openCatalogDb() {
    if (this.catalogDbPromise) return this.catalogDbPromise;
    if (!window.indexedDB) return Promise.resolve(null);
    this.catalogDbPromise = new Promise(resolve => {
      const request = window.indexedDB.open('world-radio-globe-catalog', 1);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains('pages')) db.createObjectStore('pages', { keyPath: 'offset' });
        if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', { keyPath: 'key' });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => resolve(null);
      request.onblocked = () => resolve(null);
    });
    return this.catalogDbPromise;
  }

  async _readCatalogCache() {
    const db = await this._openCatalogDb();
    if (!db) { this.catalogPersistentCache = false; return { pages: [], meta: null }; }
    return new Promise(resolve => {
      try {
        const tx = db.transaction(['pages', 'meta'], 'readonly');
        const pagesRequest = tx.objectStore('pages').getAll();
        const metaRequest = tx.objectStore('meta').get('catalog');
        tx.oncomplete = () => {
          this.catalogPersistentCache = true;
          resolve({ pages: pagesRequest.result || [], meta: metaRequest.result || null });
        };
        tx.onerror = tx.onabort = () => { this.catalogPersistentCache = false; resolve({ pages: [], meta: null }); };
      } catch (_) { resolve({ pages: [], meta: null }); }
    });
  }

  async _writeCatalogPage(offset, stations) {
    const db = await this._openCatalogDb();
    if (!db) { this.catalogPersistentCache = false; return false; }
    return new Promise(resolve => {
      try {
        const tx = db.transaction('pages', 'readwrite');
        tx.objectStore('pages').put({ offset, stations, updatedAt: Date.now() });
        tx.oncomplete = () => { this.catalogPersistentCache = true; resolve(true); };
        tx.onerror = tx.onabort = () => { this.catalogPersistentCache = false; resolve(false); };
      } catch (_) { resolve(false); }
    });
  }

  async _writeCatalogMeta(meta) {
    const db = await this._openCatalogDb();
    if (!db) { this.catalogPersistentCache = false; return false; }
    return new Promise(resolve => {
      try {
        const tx = db.transaction('meta', 'readwrite');
        tx.objectStore('meta').put({ ...meta, key: 'catalog' });
        tx.oncomplete = () => { this.catalogPersistentCache = true; resolve(true); };
        tx.onerror = tx.onabort = () => { this.catalogPersistentCache = false; resolve(false); };
      } catch (_) { resolve(false); }
    });
  }

  _dedupeCatalog(stations) {
    const unique = new Map();
    const streams = new Set();
    (stations || []).forEach(station => {
      if (!station?.id || !station.name) return;
      const streamKey = station.streamUrl ? String(station.streamUrl).trim().replace(/\/$/, '').toLowerCase() : '';
      if (unique.has(station.id) || (streamKey && streams.has(streamKey))) return;
      unique.set(station.id, station);
      if (streamKey) streams.add(streamKey);
    });
    return unique;
  }

  /**
   * Carrega o catálogo completo em páginas de até 1.000 registros, com no máximo
   * duas requisições simultâneas e cache IndexedDB. O mapa continua renderizando
   * apenas sua amostra; todos os registros ficam disponíveis para busca local.
   */
  loadGlobalCatalog({ onProgress = () => {}, forceRefresh = false, signal = null, pageSize = 1000 } = {}) {
    if (this.catalogLoadPromise) return this.catalogLoadPromise;
    this.catalogAbortController = new AbortController();
    let linkedAbort = null;
    if (signal) {
      if (signal.aborted) this.catalogAbortController.abort();
      else {
        linkedAbort = () => this.catalogAbortController?.abort();
        signal.addEventListener('abort', linkedAbort, { once: true });
      }
    }
    this.catalogLoadPromise = this._loadGlobalCatalog({ onProgress, forceRefresh, pageSize, signal: this.catalogAbortController.signal })
      .finally(() => {
        if (linkedAbort) signal.removeEventListener('abort', linkedAbort);
        this.catalogLoadPromise = null;
        this.catalogAbortController = null;
      });
    return this.catalogLoadPromise;
  }

  cancelGlobalCatalog() {
    this.catalogAbortController?.abort();
  }

  async _loadGlobalCatalog({ onProgress, forceRefresh, pageSize, signal }) {
    const safePageSize = Math.max(100, Math.min(1000, Number(pageSize) || 1000));
    const ttl = window.WRG_CONFIG?.radioBrowser.catalogCacheTtlMs || 24 * 60 * 60 * 1000;
    const cache = await this._readCatalogCache();
    onProgress({ ...this.catalogStatus, phase: 'loading', received: this.catalogStations.size, total: null, cached: false });
    const now = Date.now();
    const allPages = new Map((cache.pages || [])
      .filter(page => Array.isArray(page.stations))
      .map(page => [Number(page.offset), page]));
    const freshPages = new Map([...allPages.values()]
      .filter(page => !forceRefresh && now - page.updatedAt < ttl)
      .map(page => [Number(page.offset), page]));
    let cachedStations = [...allPages.values()].sort((a, b) => a.offset - b.offset).flatMap(page => page.stations);
    this.catalogStations = this._dedupeCatalog(cachedStations);
    this.catalogDuplicatesRemoved = cachedStations.length - this.catalogStations.size;
    if (cachedStations.length) {
      this.catalogStatus = {
        phase: 'cached', received: this.catalogStations.size, rawReceived: cachedStations.length,
        total: cache.meta?.total ?? null, complete: false, cached: true, persistentCache: true, stats: null
      };
      onProgress({ ...this.catalogStatus, stations: Array.from(this.catalogStations.values()) });
    }
    const stats = await this.getGlobalStats(signal);
    const total = stats?.totalStations ?? cache.meta?.total ?? null;
    if (total != null) {
      const maxOffset = Math.ceil(total / safePageSize) * safePageSize;
      for (const offset of allPages.keys()) if (offset >= maxOffset) allPages.delete(offset);
      for (const offset of freshPages.keys()) if (offset >= maxOffset) freshPages.delete(offset);
    }
    cachedStations = [...allPages.values()].sort((a, b) => a.offset - b.offset).flatMap(page => page.stations);
    this.catalogStations = this._dedupeCatalog(cachedStations);
    this.catalogDuplicatesRemoved = cachedStations.length - this.catalogStations.size;
    const cachedPageCount = total == null ? null : Math.ceil(total / safePageSize);
    const cacheComplete = Boolean(cache.meta?.complete && cache.meta.expiresAt > now && cachedPageCount != null &&
      Array.from({ length: cachedPageCount }, (_, index) => freshPages.has(index * safePageSize)).every(Boolean));

    if (cachedStations.length) {
      const cachedStatus = {
        phase: cacheComplete ? 'ready' : 'cached', received: this.catalogStations.size,
        rawReceived: cachedStations.length, total, complete: cacheComplete, cached: true,
        persistentCache: true, stats
      };
      this.catalogStatus = cachedStatus;
      onProgress({ ...cachedStatus, stations: Array.from(this.catalogStations.values()) });
    }
    if (cacheComplete && !forceRefresh) return { ...this.catalogStatus, stations: Array.from(this.catalogStations.values()) };
    if (signal.aborted) {
      const cancelled = { ...this.catalogStatus, phase: 'cancelled', received: this.catalogStations.size, total, complete: false, persistentCache: this.catalogPersistentCache, stats };
      this.catalogStatus = cancelled;
      onProgress(cancelled);
      return { ...cancelled, stations: Array.from(this.catalogStations.values()) };
    }
    if (total == null) {
      const unavailable = { ...this.catalogStatus, phase: 'unavailable', complete: false, total: null, persistentCache: this.catalogPersistentCache, stats: null };
      this.catalogStatus = unavailable;
      onProgress(unavailable);
      return { ...unavailable, stations: Array.from(this.catalogStations.values()) };
    }

    const pageCount = Math.ceil(total / safePageSize);
    await this._pruneCatalogPages(pageCount, now - 90 * 24 * 60 * 60 * 1000, safePageSize);
    let failed = false;
    const streamOwner = new Map(Array.from(this.catalogStations.values())
      .map(station => [station.streamUrl && station.streamUrl.trim().replace(/\/$/, '').toLowerCase(), station.id])
      .filter(([url]) => Boolean(url)));
    for (let start = 0; start < pageCount; start += 2) {
      if (signal.aborted) break;
      if (start > 0) {
        const delay = Math.max(0, Number(window.WRG_CONFIG?.radioBrowser.catalogBatchDelayMs) || 0);
        if (delay) await new Promise(resolve => {
          const finish = () => { clearTimeout(timer); signal.removeEventListener('abort', finish); resolve(); };
          const timer = setTimeout(finish, delay);
          signal.addEventListener('abort', finish, { once: true });
        });
        if (signal.aborted) break;
      }
      const offsets = [start, start + 1].filter(index => index < pageCount).map(index => index * safePageSize);
      const missing = offsets.filter(offset => !freshPages.has(offset));
      const results = await Promise.allSettled(missing.map(offset => this.searchStations({
        limit: safePageSize, offset, hasGeoOnly: null, order: 'name', reverse: false,
        preferHttps: false, hideBroken: false, signal
      }).then(async stations => {
        const page = { offset, stations, updatedAt: Date.now() };
        await this._writeCatalogPage(offset, stations);
        freshPages.set(offset, page);
        return page;
      })));
      const shortBeforeReportedEnd = results.some(result => result.status === 'fulfilled' &&
        result.value.stations.length < safePageSize && result.value.offset + result.value.stations.length < total);
      if (results.some(result => result.status === 'rejected') || shortBeforeReportedEnd) failed = true;
      for (const result of results) {
        if (result.status === 'fulfilled') {
          result.value.stations.forEach(station => {
            const key = station.streamUrl ? String(station.streamUrl).trim().replace(/\/$/, '').toLowerCase() : '';
            const previous = this.catalogStations.get(station.id);
            if (previous) {
              const previousKey = previous.streamUrl && previous.streamUrl.trim().replace(/\/$/, '').toLowerCase();
              if (previousKey && streamOwner.get(previousKey) === station.id) streamOwner.delete(previousKey);
              if (key && streamOwner.has(key) && streamOwner.get(key) !== station.id) {
                this.catalogDuplicatesRemoved++;
                this.catalogStations.set(station.id, { ...previous, lastCheckStatus: station.lastCheckStatus, lastCheckTime: station.lastCheckTime });
                if (previousKey) streamOwner.set(previousKey, station.id);
                return;
              }
              this.catalogStations.set(station.id, station);
              if (key) streamOwner.set(key, station.id);
              return;
            }
            if (key && streamOwner.has(key)) {
              this.catalogDuplicatesRemoved++;
              return;
            }
            this.catalogStations.set(station.id, station);
            if (key) streamOwner.set(key, station.id);
          });
        }
      }
      const received = [...freshPages.values()].reduce((sum, page) => sum + page.stations.length, 0);
      const progress = {
        phase: failed ? 'partial' : 'loading', received: this.catalogStations.size, rawReceived: received,
        total, complete: false, cached: false, persistentCache: this.catalogPersistentCache, stats,
        sourceMismatch: shortBeforeReportedEnd,
        pageStations: results.filter(result => result.status === 'fulfilled').flatMap(result => result.value.stations)
      };
      this.catalogStatus = progress;
      onProgress(progress);
      if (failed) break;
    }

    const complete = !failed && !signal.aborted && [...Array(pageCount).keys()].every(index => freshPages.has(index * safePageSize));
    const finalStatus = {
      phase: signal.aborted ? 'cancelled' : failed ? 'partial' : complete ? 'ready' : 'partial',
      received: this.catalogStations.size,
      rawReceived: [...freshPages.values()].reduce((sum, page) => sum + page.stations.length, 0),
      total, complete, cached: false, persistentCache: this.catalogPersistentCache, stats
    };
    this.catalogStatus = finalStatus;
    if (complete) await this._writeCatalogMeta({ complete: true, total, updatedAt: Date.now(), expiresAt: Date.now() + ttl, stats });
    onProgress(finalStatus);
    return { ...finalStatus, stations: Array.from(this.catalogStations.values()) };
  }

  async _pruneCatalogPages(pageCount, olderThan, pageSize = 1000) {
    const db = await this._openCatalogDb();
    if (!db) return;
    await new Promise(resolve => {
      try {
        const tx = db.transaction('pages', 'readwrite');
        const cursorRequest = tx.objectStore('pages').openCursor();
        cursorRequest.onsuccess = () => {
          const cursor = cursorRequest.result;
          if (!cursor) return;
          if (cursor.value.updatedAt < olderThan || cursor.value.offset >= pageCount * pageSize) cursor.delete();
          cursor.continue();
        };
        tx.oncomplete = tx.onerror = tx.onabort = () => resolve();
      } catch (_) { resolve(); }
    });
  }

  getCatalogDiagnostics() {
    const stations = Array.from(this.catalogStations.values());
    const countries = new Set(stations.map(station => station.country).filter(country => country && country !== 'Desconhecido'));
    const cities = new Set(stations.map(station => station.city).filter(Boolean));
    const withCoordinates = stations.filter(station => station.hasValidCoords).length;
    const noCoordinates = stations.length - withCoordinates;
    const online = stations.filter(station => station.lastCheckStatus === 'online').length;
    const offline = stations.filter(station => station.lastCheckStatus === 'offline').length;
    const unchecked = stations.length - online - offline;
    const metadataAvailable = stations.filter(station => station.metadataAvailable).length;
    const languages = new Set(stations.flatMap(station => String(station.language || '').split(/[;,]/).map(value => value.trim().toLowerCase()).filter(Boolean)));
    const regions = {
      'América do Norte': 0, 'América Central': 0, 'América do Sul': 0,
      Europa: 0, África: 0, Ásia: 0, 'Oriente Médio': 0, Oceania: 0, 'Sem região': 0
    };
    stations.filter(station => station.hasValidCoords).forEach(({ lat, lon }) => {
      if (lon < -30) regions[lat > 15 ? 'América do Norte' : lat > -12 ? 'América Central' : 'América do Sul']++;
      else if (lat >= 12 && lat <= 42 && lon >= 25 && lon <= 63) regions['Oriente Médio']++;
      else if (lat >= 35 && lat <= 72 && lon >= -12 && lon <= 45) regions.Europa++;
      else if (lat >= -35 && lat <= 37 && lon >= -20 && lon <= 55) regions.África++;
      else if (lon >= 110 && lat <= 0 && lat >= -50) regions.Oceania++;
      else if (lon > 45 && lat > 0) regions['Ásia']++;
      else regions['Sem região']++;
    });
    const valid = stations.filter(station => station.name && station.streamUrl).length;
    const withoutStream = stations.filter(station => !station.streamUrl).length;
    return {
      ...this.catalogStatus, valid, withoutStream,
      withCoordinates, noCoordinates, online, offline, unchecked, metadataAvailable,
      countries: countries.size, cities: cities.size, languages: languages.size,
      duplicateStreamsRemoved: this.catalogDuplicatesRemoved, regions
    };
  }

  /**
   * Busca estações contidas dentro de uma caixa delimitadora geográfica (Bounding Box)
   * Útil para carregar somente estações visíveis no viewport da câmera do CesiumJS
   * @param {number} minLat 
   * @param {number} minLon 
   * @param {number} maxLat 
   * @param {number} maxLon 
   * @param {number} limit 
   * @returns {Promise<Array<Object>>}
   */
  async getStationsInBoundingBox(minLat, minLon, maxLat, maxLon, limit = 50, countryCode = '') {
    try {
      // A Radio Browser não filtra por caixa; examina páginas aleatórias sucessivas
      // para encontrar mais estações na região, em vez de limitar a amostra mundial.
      const pageSize = 1000;
      const pageCount = countryCode ? 1 : Math.max(1, Math.min(
        Math.ceil((window.WRG_CONFIG?.radioBrowser.viewportStations || 4000) / pageSize),
        window.WRG_CONFIG?.radioBrowser.viewportSamplePages || 4
      ));
      const pages = await Promise.allSettled(Array.from({ length: pageCount }, (_, page) => this.searchStations({
        limit: pageSize,
        offset: page * pageSize,
        hasGeoOnly: true,
        order: countryCode ? 'clickcount' : 'random',
        countryCode: countryCode || undefined
      })));
      const stations = pages.flatMap(result => result.status === 'fulfilled' ? result.value : []);
      const uniqueStations = new Map(stations.map(station => [station.id, station]));

      // Filtra estritamente dentro da Bounding Box WGS84
      return [...uniqueStations.values()].filter(station => {
        const longitudeIsInside = minLon <= maxLon
          ? station.lon >= minLon && station.lon <= maxLon
          : station.lon >= minLon || station.lon <= maxLon;
        return (
          station.lat >= minLat &&
          station.lat <= maxLat &&
          longitudeIsInside
        );
      }).slice(0, limit);
    } catch (err) {
      console.warn('[RadioApi] Falha ao consultar bounding box:', err);
      return [];
    }
  }

  /** Busca no catálogo adicional IPRD (rádios públicas e comunitárias). */
  async searchIprdStations(query, limit = 18) {
    const needle = String(query || '').trim().toLocaleLowerCase();
    if (needle.length < 2) return [];
    try {
      if (!this.iprdCatalogPromise || Date.now() > this.iprdCatalogExpiresAt) {
        this.iprdCatalogPromise = (async () => {
          const controller = new AbortController();
          const timeoutId = setTimeout(() => controller.abort(), this.requestTimeoutMs);
          try {
            const response = await fetch('https://iprd-org.github.io/iprd/site_data/metadata/catalog.json', {
              headers: this.requestHeaders,
              signal: controller.signal
            });
            if (!response.ok) throw new Error(`IPRD HTTP ${response.status}`);
            const catalog = await response.json();
            if (Array.isArray(catalog)) return catalog;
            if (Array.isArray(catalog.stations)) return catalog.stations;
            if (Array.isArray(catalog.catalog)) return catalog.catalog;
            return Object.values(catalog).filter(item => item && typeof item === 'object' && (item.name || item.streams));
          } finally {
            clearTimeout(timeoutId);
          }
        })();
        this.iprdCatalogExpiresAt = Date.now() + 8 * 60 * 60 * 1000;
      }
      const catalog = await this.iprdCatalogPromise;
      return catalog.filter(raw => {
        const haystack = [raw.name, raw.country, raw.language, raw.genres, raw.tags].flat()
          .filter(Boolean).join(' ').toLocaleLowerCase();
        return haystack.includes(needle);
      }).slice(0, limit).map(raw => {
        const catalogStreams = Array.isArray(raw.streams)
          ? raw.streams
          : typeof raw.streams === 'string' ? [raw.streams] : Object.values(raw.streams || {});
        const streamRecords = [...catalogStreams, raw.url, raw.stream_url].map(value => typeof value === 'string' ? { url: value } : value);
        const selectedStream = streamRecords.find(value => this.safeHttpUrl(value?.url));
        const streamUrl = this.safeHttpUrl(selectedStream?.url);
        const name = String(raw.name || '').trim();
        if (!name || !streamUrl) return null;
        const genres = [raw.genres, raw.tags].flat().filter(Boolean).join(', ');
        return {
          id: `iprd-${raw.id || this._stableHash(`${name}|${raw.country || ''}|${streamUrl}`)}`,
          sourceId: raw.id || null,
          name, streamUrl, hasStream: true, isHttps: streamUrl.startsWith('https://'),
          hasValidCoords: false, lat: null, lon: null,
          country: raw.country || 'Desconhecido', countryCode: '', state: '', city: '',
          language: raw.language || '', tags: String(genres).split(',').map(tag => tag.trim().toLowerCase()).filter(Boolean).slice(0, 5),
          favicon: this.safeHttpUrl(raw.logo || raw.favicon), codec: String(selectedStream?.format || raw.codec || 'STREAM').toUpperCase(),
          bitrate: Number(selectedStream?.bitrate || raw.bitrate) || 0, reliability: Number(selectedStream?.reliability) || null,
          votes: 0, clickCount: 0, homepage: this.safeHttpUrl(raw.website), lastCheckOk: false,
          lastCheckTime: raw.lastChecked || null, lastCheckStatus: 'unknown', nowPlaying: null, metadataAvailable: false,
          locationAccuracy: 'unknown',
          source: 'IPRD · catálogo de rádios públicas'
        };
      }).filter(Boolean);
    } catch (err) {
      this.iprdCatalogPromise = null;
      console.warn('[RadioApi] Catálogo IPRD indisponível:', err.message);
      return [];
    }
  }

  _stableHash(value) {
    let hash = 2166136261;
    for (let index = 0; index < value.length; index += 1) {
      hash ^= value.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(36);
  }

  /**
   * Busca estações em um raio geográfico ao redor de um ponto (em KM)
   * @param {number} lat 
   * @param {number} lon 
   * @param {number} radiusKm 
   * @param {number} limit 
   * @returns {Promise<Array<Object>>}
   */
  async getStationsNear(lat, lon, radiusKm = 300, limit = 40) {
    try {
      const candidates = await this.searchStations({
        limit: 1000,
        hasGeoOnly: true,
        order: 'votes'
      });

      const withDistance = candidates.map(station => {
        const dist = Utils.haversineDistance(lat, lon, station.lat, station.lon);
        return { ...station, distanceKm: dist };
      });

      return withDistance
        .filter(s => s.distanceKm <= radiusKm)
        .sort((a, b) => a.distanceKm - b.distanceKm)
        .slice(0, limit);
    } catch (err) {
      console.warn('[RadioApi] Falha ao consultar estações por proximidade:', err);
      return [];
    }
  }

  /**
   * Sorteia uma estação com coordenadas válidas e stream ativo
   * @param {boolean} preferHttps 
   * @returns {Promise<Object|null>}
   */
  async getRandomStation(preferHttps = true) {
    try {
      const candidates = (await this.searchStations({
        limit: 20,
        hasGeoOnly: true,
        order: 'random'
      })).filter(station => station.hasStream);

      if (!candidates || candidates.length === 0) return null;

      if (preferHttps) {
        const httpsCandidate = candidates.find(c => c.isHttps);
        if (httpsCandidate) return httpsCandidate;
      }

      return candidates[0];
    } catch (err) {
      console.error('[RadioApi] Erro ao buscar estação aleatória:', err);
      return null;
    }
  }

  /**
   * Geocodificação Open-Source de Cidades e Países via Nominatim (OpenStreetMap)
   * @param {string} query Nome da cidade, estado ou país
   * @returns {Promise<Array<Object>>} Lista de locais encontrados com lat/lon
   */
  async geocodeLocation(query) {
    if (!query || query.trim().length < 2) return [];
    const cleanQuery = query.trim();
    const cacheKey = `wrg_geocode_${cleanQuery.toLocaleLowerCase()}`;
    const cached = Utils.storage.get(cacheKey);
    if (cached && Date.now() - cached.savedAt < (window.WRG_CONFIG?.nominatim.cacheTtlMs || 86400000)) return cached.results;

    const request = this.geocodeQueue.then(async () => {
      const waitMs = Math.max(0, 1100 - (Date.now() - this.lastGeocodeAt));
      if (waitMs) await new Promise(resolve => setTimeout(resolve, waitMs));
      this.lastGeocodeAt = Date.now();
      const url = `${window.WRG_CONFIG?.nominatim.baseUrl || 'https://nominatim.openstreetmap.org/search'}?format=json&q=${encodeURIComponent(cleanQuery)}&addressdetails=1&limit=5`;
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), this.requestTimeoutMs);
      try {
        const response = await fetch(url, { headers: { Accept: 'application/json' }, signal: controller.signal });
        if (!response.ok) return [];
        const results = await response.json();
        const places = results.map(item => ({
        displayName: item.display_name,
        name: item.name,
        lat: parseFloat(item.lat),
        lon: parseFloat(item.lon),
        type: item.type,
        country: item.address ? item.address.country : null,
        countryCode: item.address && item.address.country_code ? item.address.country_code.toUpperCase() : null,
        boundingBox: item.boundingbox ? item.boundingbox.map(Number) : null
        }));
        Utils.storage.set(cacheKey, { savedAt: Date.now(), results: places });
        return places;
      } finally {
        clearTimeout(timeoutId);
      }
    });
    this.geocodeQueue = request.catch(() => {});
    try {
      return await request;
    } catch (err) {
      console.warn('[RadioApi] Falha na geocodificação Nominatim:', err);
      return [];
    }
  }

  /**
   * Notifica a Radio Browser API de um clique/reprodução de rádio (Analytics da comunidade)
   * @param {string} stationUuid 
   */
  async registerPlayClick(stationUuid) {
    if (!stationUuid) return;
    try {
      await fetch(`${this.activeMirror}/json/url/${stationUuid}`, {
        method: 'GET',
        headers: this.requestHeaders,
        mode: 'no-cors' // Não necessita leitura do corpo
      });
    } catch (e) {
      // Falha silenciosa em analytics
    }
  }
}

// Expõe globalmente
window.RadioApiClient = RadioApiClient;
