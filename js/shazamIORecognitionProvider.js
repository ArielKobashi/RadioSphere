/** Provider ShazamIO: captura acústica feita no servidor, sem API key. */
class ShazamIORecognitionProvider {
  constructor() {
    this.automatic = true;
    this.name = 'ShazamIO';
    this.lastAttemptByStation = new Map();
    this.minimumIntervalMs = 45000;
  }

  async status() {
    return { provider: this.name, apiKeyRequired: false, mode: 'online-unofficial-api' };
  }

  async identify({ station, signal, metadataFirst = true, force = false } = {}) {
    if (!station?.streamUrl) return { reason: 'no-station' };
    if (metadataFirst) {
      const metadataResponse = await fetch('/api/nowplaying', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ stationId: station.id, streamUrl: station.streamUrl }), signal, cache: 'no-store'
      }).catch(() => null);
      if (metadataResponse?.ok) {
        const metadata = await metadataResponse.json().catch(() => ({}));
        if (metadata.track?.title) return {
          ...metadata.track, rawTitle: [metadata.track.artist, metadata.track.title].filter(Boolean).join(' - '),
          source: metadata.source || 'Metadata da rádio', method: 'metadata'
        };
      }
    }

    const key = String(station.id || station.streamUrl);
    const lastAttempt = this.lastAttemptByStation.get(key) || 0;
    if (!force && Date.now() - lastAttempt < this.minimumIntervalMs) return { reason: 'cooldown' };
    this.lastAttemptByStation.set(key, Date.now());
    const response = await fetch('/api/music/identify', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ stationId: station.id, streamUrl: station.streamUrl }), signal, cache: 'no-store'
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || `Reconhecimento ShazamIO HTTP ${response.status}`);
    if (!result.track?.title) return { reason: result.reason || 'no-match', diagnostics: result.diagnostics || null };
    return {
      ...result.track, rawTitle: [result.track.artist, result.track.title].filter(Boolean).join(' - '),
      source: 'ShazamIO · Shazam', method: 'acoustic', diagnostics: result.diagnostics || null
    };
  }
}

window.ShazamIORecognitionProvider = ShazamIORecognitionProvider;
