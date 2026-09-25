/** Busca estações e lugares sem executar autocomplete no Nominatim público. */
class SearchManager {
  constructor(radioApiClient) {
    this.radioApi = radioApiClient;
    this.catalog = new Map();
    this.sortedCatalog = null;
  }

  setCatalog(stations = []) {
    this.catalog.clear();
    this.sortedCatalog = null;
    this.mergeCatalog(stations);
  }

  mergeCatalog(stations = []) {
    for (const station of stations || []) {
      if (station?.id) {
        this.catalog.set(station.id, station);
        this.sortedCatalog = null;
      }
    }
  }

  getSortedCatalog() {
    if (!this.sortedCatalog) {
      this.sortedCatalog = Array.from(this.catalog.values()).sort((a, b) =>
        String(a.name || '').localeCompare(String(b.name || ''), 'pt-BR', { sensitivity: 'base' }));
    }
    return this.sortedCatalog;
  }

  searchCatalog(query, limit = 40) {
    const needle = String(query || '').trim().toLocaleLowerCase();
    if (needle.length < 2 || !this.catalog.size) return [];
    return Array.from(this.catalog.values())
      .filter(station => [station.name, station.country, station.state, station.city, station.language, ...(station.tags || [])]
        .some(value => String(value || '').toLocaleLowerCase().includes(needle)))
      .sort((a, b) => {
        const aName = String(a.name || '').toLocaleLowerCase().startsWith(needle);
        const bName = String(b.name || '').toLocaleLowerCase().startsWith(needle);
        return Number(bName) - Number(aName) || (b.votes || 0) - (a.votes || 0);
      })
      .slice(0, limit);
  }

  dedupeStations(stations) {
    const unique = new Map();
    const lookup = new Map();
    const normalized = value => String(value || '').trim().toLocaleLowerCase().replace(/\s+/g, ' ');
    const stationKeys = station => {
      const name = normalized(station.name);
      const country = normalized(station.countryCode || station.country);
      const location = normalized(station.city || station.state);
      const stream = normalized(station.streamUrl).replace(/\/$/, '');
      const homepage = normalized(station.homepage).replace(/\/$/, '');
      const keys = [];
      if (station.id) keys.push(`id:${station.id}`);
      if (stream) keys.push(`stream:${stream}`);
      if (name && country && location) keys.push(`name-location:${name}|${country}|${location}`);
      if (name && country && homepage) keys.push(`name-homepage:${name}|${country}|${homepage}`);
      return keys;
    };
    const providerRank = station => station.source === 'Radio Browser' ? 3 :
      String(station.source || '').startsWith('IPRD') ? 1 : 2;
    for (const station of stations.filter(Boolean)) {
      const keys = stationKeys(station);
      const existingKey = keys.map(key => lookup.get(key)).find(Boolean);
      if (!existingKey) {
        const identity = station.id || keys[0] || `result-${unique.size}`;
        unique.set(identity, station);
        keys.forEach(key => lookup.set(key, identity));
        continue;
      }
      const existing = unique.get(existingKey);
      const preferred = providerRank(station) > providerRank(existing) ? station : existing;
      const fallback = preferred === station ? existing : station;
      const merged = { ...fallback, ...preferred };
      merged.tags = Array.from(new Set([...(fallback.tags || []), ...(preferred.tags || [])])).slice(0, 8);
      unique.set(existingKey, merged);
      stationKeys(merged).forEach(key => lookup.set(key, existingKey));
      stationKeys(fallback).forEach(key => lookup.set(key, existingKey));
    }
    return { stations: [...unique.values()], duplicateCount: stations.filter(Boolean).length - unique.size };
  }

  async search(rawQuery) {
    const query = String(rawQuery || '').trim();
    if (query.length < 2) return { place: null, stations: [] };

    const results = await Promise.allSettled([
      this.radioApi.searchStations({ name: query, limit: 35, hasGeoOnly: false, order: 'clickcount' }),
      this.radioApi.searchStations({ tag: query, limit: 20, hasGeoOnly: false, order: 'clickcount' }),
      this.radioApi.searchStations({ language: query, limit: 20, hasGeoOnly: false, order: 'clickcount' }),
      this.radioApi.geocodeLocation(query),
      Promise.resolve().then(() => this.radioApi.searchIprdStations?.(query, 18) || []),
      Promise.resolve(this.searchCatalog(query, 40))
    ]);
    const [nameMatches, tagMatches, languageMatches, places, libraryMatches, catalogMatches] = results.map(result =>
      result.status === 'fulfilled' ? result.value : []
    );

    const place = places[0] || null;
    let placeStations = [];
    if (place?.countryCode) {
      placeStations = await this.radioApi.searchStations({
        countryCode: place.countryCode,
        limit: 1000,
        hasGeoOnly: true,
        order: 'clickcount'
      }).catch(() => []);
      const box = place.boundingBox;
      const inPlaceBounds = box && placeStations.filter(station => {
        const [south, north, west, east] = box;
        const inLongitude = west <= east
          ? station.lon >= west && station.lon <= east
          : station.lon >= west || station.lon <= east;
        return station.lat >= south && station.lat <= north && inLongitude;
      });
      if (inPlaceBounds?.length) {
        placeStations = inPlaceBounds;
      } else {
        placeStations = placeStations
          .map(station => ({ ...station, distanceKm: Utils.haversineDistance(place.lat, place.lon, station.lat, station.lon) }))
          .filter(station => station.distanceKm <= 250)
          .sort((a, b) => a.distanceKm - b.distanceKm)
          .slice(0, 40);
      }
    } else if (place) {
      const box = place.boundingBox;
      const bounds = box
        ? [box[0], box[2], box[1], box[3]]
        : [place.lat - 1.5, place.lon - 1.5, place.lat + 1.5, place.lon + 1.5];
      placeStations = await this.radioApi.getStationsInBoundingBox(...bounds, 40);
    }

    const deduped = this.dedupeStations([...catalogMatches, ...libraryMatches, ...nameMatches, ...tagMatches, ...languageMatches, ...placeStations]);
    return { place, stations: deduped.stations.slice(0, 50), duplicateCount: deduped.duplicateCount };
  }
}

window.SearchManager = SearchManager;
