/** Lê exclusivamente a faixa publicada pela estação; não simula reconhecimento acústico. */
class StationMetadataProvider {
  constructor() {
    this.automatic = false;
    this.name = 'Metadados da rádio';
  }

  async status() {
    return { provider: this.name, configured: true, acousticRecognition: false };
  }

  async identify({ station, signal } = {}) {
    if (!station?.streamUrl) return { reason: 'no-station' };
    const response = await fetch('/api/nowplaying', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ stationId: station.id, streamUrl: station.streamUrl }),
      signal,
      cache: 'no-store'
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || `Consulta de metadados HTTP ${response.status}`);
    if (!result.track?.title) return { reason: result.reason || 'station-does-not-publish-track-metadata' };
    return {
      ...result.track,
      rawTitle: [result.track.artist, result.track.title].filter(Boolean).join(' - '),
      source: result.source || result.track.source || 'Metadata da rádio',
      method: 'metadata'
    };
  }
}

window.StationMetadataProvider = StationMetadataProvider;
