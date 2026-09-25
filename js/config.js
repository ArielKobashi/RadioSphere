/** Limites comuns de chamadas e renderização da aplicação. */
window.WRG_CONFIG = Object.freeze({
  radioBrowser: Object.freeze({
    cacheTtlMs: 5 * 60 * 1000,
    catalogCacheTtlMs: 24 * 60 * 60 * 1000,
    catalogBatchDelayMs: 200,
    requestTimeoutMs: 7000,
    maxPageSize: 1000,
    startupStations: 4000,
    viewportStations: 4000,
    viewportSamplePages: 4,
    stationMemoryLimit: 20000,
    priorityCountry: 'BR'
  }),
  nominatim: Object.freeze({
    baseUrl: 'https://nominatim.openstreetmap.org/search',
    cacheTtlMs: 24 * 60 * 60 * 1000
  })
});
