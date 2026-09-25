/** Cliente para o proxy Shazam no servidor da própria aplicação. */
class ShazamRecognitionProvider {
  async status() {
    const response = await fetch('/api/shazam/status', { cache: 'no-store' });
    if (!response.ok) throw new Error(`Serviço Shazam HTTP ${response.status}`);
    return response.json();
  }

  async identify({ station, signal } = {}) {
    if (!station?.streamUrl) return { reason: 'no-station' };
    const metadataResponse = await fetch('/api/nowplaying', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ stationId: station.id, streamUrl: station.streamUrl }), signal, cache: 'no-store'
    }).catch(() => null);
    if (metadataResponse?.ok) {
      const metadata = await metadataResponse.json().catch(() => ({}));
      if (metadata.track?.title) return {
        title: metadata.track.title, artist: metadata.track.artist || '',
        rawTitle: [metadata.track.artist, metadata.track.title].filter(Boolean).join(' - '),
        source: metadata.source || metadata.track.source || 'Metadata da rádio'
      };
    }
    const response = await fetch('/api/shazam/identify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ stationId: station.id, streamUrl: station.streamUrl }),
      signal,
      cache: 'no-store'
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || `Serviço de identificação HTTP ${response.status}`);
    if (!result.track?.title) return { reason: result.reason || 'no-match' };
    return {
      title: result.track.title,
      artist: result.track.artist || '',
      rawTitle: [result.track.artist, result.track.title].filter(Boolean).join(' - '),
      source: 'Shazam'
    };
  }
}

window.ShazamRecognitionProvider = ShazamRecognitionProvider;
