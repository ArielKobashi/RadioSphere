/**
 * WORLD RADIO GLOBE — Gerenciador de Metadados e Reconhecimento de Faixas (metadataManager.js)
 * Estratégia em 4 Camadas de Resolução com Regra Estrita de ZERO DADOS FALSOS.
 * 
 * Camadas:
 * - Camada 1: Metadados ICY de Stream (Icecast / Shoutcast StreamTitle via fetch com Icy-MetaData)
 * - Camada 2: Endpoints JSON de Estações Conhecidas (Icecast status-json.xsl / stats / AzuraCast)
 * - Camada 3: Diretório Radio Browser / Contexto de Programação
 * - Camada 4: ponto de extensão opcional para futuros provedores de reconhecimento
 */

class AudioRecognitionProvider {
  /**
   * Interface abstrata para futuros provedores independentes de metadados/reconhecimento.
   */
  async identify(audioBuffer) {
    // Implementação padrão: nenhum provedor externo configurado.
    // Retorna nulo para garantir que nenhum dado fictício seja inventado.
    return null;
  }
}

class MusicRecognitionService {
  constructor(appStateManager) {
    this.state = appStateManager || window.appState;
    this.pollIntervalMs = 60000;
    this.timer = null;
    this.abortController = null;
    this.currentStation = null;
    this.recognitionProvider = new AudioRecognitionProvider();

    // Cache para evitar requisições redundantes
    this.lastDetectedRaw = '';
    this.consecutiveFailures = 0;
    this.recognitionDiagnostics = { provider: 'ShazamIO', attempts: 0, capture: 'idle', lastDurationMs: null, captureMs: null, providerMs: null, sampleBytes: null, lastError: '' };

    // Escuta mudanças de estado de reprodução
    if (this.state) {
      this.state.subscribeKey('playbackState', (state) => {
        if (state === 'PLAYING') {
          this.startMonitoring();
        } else if (['PAUSED', 'IDLE', 'ERROR', 'OFFLINE'].includes(state)) {
          this.stopMonitoring();
        }
      });

      this.state.subscribeKey('currentStation', (station) => {
        this.currentStation = station;
        this.lastDetectedRaw = '';
        this.consecutiveFailures = 0;
        this.resetTrackState();
        if (this.state.getState().playbackState === 'PLAYING') {
          this.fetchMetadata();
        }
      });
    }
  }

  /**
   * Define um provedor personalizado de reconhecimento de áudio (Camada 4)
   * @param {AudioRecognitionProvider} provider 
   */
  setRecognitionProvider(provider) {
    if (provider && typeof provider.identify === 'function') {
      this.recognitionProvider = provider;
    }
  }

  /**
   * Reseta metadados da faixa para o estado inicial
   */
  resetTrackState() {
    this.state.setState({
      currentTrack: {
        title: '',
        artist: '',
        rawTitle: '',
        source: 'none',
        status: 'SEARCHING',
        confidence: null,
        timestamp: Date.now()
      }
    });
  }

  /**
   * Inicia o monitoramento periódico de metadados
   */
  startMonitoring() {
    this.stopMonitoring();
    this.fetchMetadata();
    this.timer = setInterval(() => {
      this.fetchMetadata();
    }, this.pollIntervalMs);
  }

  /**
   * Para o monitoramento
   */
  stopMonitoring() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
  }

  /**
   * Executa a resolução em 4 camadas
   */
  async fetchMetadata() {
    const station = this.currentStation || this.state.getState().currentStation;
    if (!station || !station.streamUrl) return;

    if (this.abortController) {
      this.abortController.abort();
    }
    this.abortController = new AbortController();
    const signal = this.abortController.signal;

    let result = null;

    const timeoutId = setTimeout(() => this.abortController?.abort(), 35000);
    try {
      // CAMADA 1: Tentativa de leitura de metadados ICY (Icecast / Shoutcast)
      result = await this._queryLayer1Icy(station.streamUrl, signal);

      // CAMADA 2: Endpoints JSON de servidores de rádio conhecidos
      if (!result) {
        result = await this._queryLayer2StationJson(station, signal);
      }

      // CAMADA 3: Metadados estruturados do diretório da rádio
      if (!result) {
        result = await this._queryLayer3Directory(station);
      }

      // CAMADA 4: Provedor de reconhecimento acústico (modular)
      if (!result && this.recognitionProvider?.automatic === true) {
        result = await this._queryLayer4Provider(signal);
      }
    } catch (e) {
      // Ignora erro abortado
      if (signal.aborted) return;
      this.consecutiveFailures++;
    } finally {
      clearTimeout(timeoutId);
    }

    if (signal.aborted) return;

    if (result && result.title) {
      this.consecutiveFailures = 0;
      this._applyTrackUpdate(result);
    } else {
      const visibleTrack = this.state.getState().currentTrack;
      if (visibleTrack?.title && ['provider', 'acoustic'].includes(visibleTrack.method)) return;
      // Quando não há metadados, expõe com clareza: NUNCA inventa títulos falsos!
      this._applyFallbackLiveState(station);
    }
  }

  /**
   * Camada 1: Leitura de cabeçalho ICY (Icecast/Shoutcast StreamTitle)
   */
  async _queryLayer1Icy(streamUrl, signal) {
    try {
      // Alguns streams permitem preflight CORS para consulta de cabeçalho ou chunk inicial
      // Usamos Range para pegar somente os primeiros 8KB onde o ICY metadata interval reside
      const response = await fetch(streamUrl, {
        method: 'GET',
        headers: {
          'Icy-MetaData': '1',
          'Range': 'bytes=0-8192'
        },
        signal,
        cache: 'no-store'
      });

      // Verifica cabeçalhos de resposta padrão do Icecast / Shoutcast
      const icyName = response.headers.get('icy-name');
      const icyDescription = response.headers.get('icy-description');
      const icyMetaint = response.headers.get('icy-metaint');

      // Se temos o leitor de buffer com metaint
      if (icyMetaint) {
        const metaIntNum = parseInt(icyMetaint, 10);
        if (metaIntNum > 0 && metaIntNum < 16384) {
          const buffer = await response.arrayBuffer();
          if (buffer.byteLength > metaIntNum) {
            const metaLenByte = new Uint8Array(buffer, metaIntNum, 1)[0];
            const metaLength = metaLenByte * 16;
            if (metaLength > 0 && buffer.byteLength >= metaIntNum + 1 + metaLength) {
              const metaBytes = new Uint8Array(buffer, metaIntNum + 1, metaLength);
              const metaString = new TextDecoder('utf-8', { fatal: false }).decode(metaBytes);
              const match = metaString.match(/StreamTitle='([^']*)'/);
              if (match && match[1] && match[1].trim()) {
                return this._parseTrackString(match[1].trim(), 'icy', 'verified');
              }
            }
          }
        }
      }

      // Se não há bloco metaint, mas há icy-name com separador de faixa
      if (icyName && icyName.includes(' - ') && !icyName.toLowerCase().includes('radio')) {
        return this._parseTrackString(icyName, 'icy', 'possible');
      }
    } catch (_) {
      // CORS ou stream não suporta range fetch; segue silenciosamente para Camada 2
    }
    return null;
  }

  /**
   * Camada 2: Consulta endpoints JSON de servidores Icecast/Shoutcast/AzuraCast
   */
  async _queryLayer2StationJson(station, signal) {
    if (!station.streamUrl) return null;

    try {
      const url = new URL(station.streamUrl);
      const host = `${url.protocol}//${url.host}`;
      const path = url.pathname;

      // URLs candidatas comuns em servidores de rádio Icecast / AzuraCast
      const candidates = [
        `${host}/status-json.xsl`,
        `${host}/stats?json=1`,
        `${host}/api/live/nowplaying${path.length > 1 ? path : ''}`
      ];

      for (const endpoint of candidates) {
        try {
          const res = await fetch(endpoint, { signal, cache: 'no-store' });
          if (!res.ok) continue;

          const data = await res.json();
          const song = this._extractSongFromIcecastJson(data, path);
          if (song) {
            return this._parseTrackString(song, 'station_api', 'verified');
          }
        } catch (_) {
          // Continua para próximo candidato
        }
      }
    } catch (_) {
      // URL inválida ou cors bloqueado
    }

    return null;
  }

  /**
   * Extrai faixa do payload JSON do Icecast
   */
  _extractSongFromIcecastJson(json, streamPath) {
    if (!json) return null;

    // Icecast status-json.xsl
    if (json.icestats && json.icestats.source) {
      const sources = Array.isArray(json.icestats.source) ? json.icestats.source : [json.icestats.source];
      for (const src of sources) {
        if (src.title && (src.listenurl?.includes(streamPath) || sources.length === 1)) {
          const artist = src.artist ? `${src.artist} - ` : '';
          return `${artist}${src.title}`;
        }
      }
    }

    // AzuraCast nowplaying
    if (json.now_playing && json.now_playing.song) {
      return json.now_playing.song.text || `${json.now_playing.song.artist} - ${json.now_playing.song.title}`;
    }

    return null;
  }

  /**
   * Camada 3: Diretório Radio Browser / Contexto da Estação
   */
  async _queryLayer3Directory(station) {
    // Proxy same-origin consulta headers ICY e endpoints JSON sem depender do CORS da estação.
    try {
      const response = await fetch('/api/nowplaying', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ stationId: station.id, streamUrl: station.streamUrl }),
        signal: this.abortController?.signal, cache: 'no-store'
      });
      if (!response.ok) return null;
      const payload = await response.json();
      if (!payload.track?.title) return null;
      return {
        title: String(payload.track.title), artist: String(payload.track.artist || ''),
        album: String(payload.track.album || ''), artwork: String(payload.track.artwork || ''),
        url: String(payload.track.url || ''), rawTitle: [payload.track.artist, payload.track.title].filter(Boolean).join(' - '),
        source: payload.source || payload.track.source || 'Metadata da rádio', method: 'metadata',
        status: 'METADATA', confidence: null, timestamp: Date.now()
      };
    } catch (_) { /* API local ausente em publicação estática ou estação indisponível. */ }
    return null;
  }

  /**
   * Camada 4: Provedor modular de reconhecimento
   */
  async _queryLayer4Provider(signal) {
    try {
      this.state?.setState({ currentTrack: { ...this.state.getState().currentTrack, status: 'SEARCHING', source: this.recognitionProvider.name || 'Reconhecimento' } });
      this.recognitionDiagnostics.attempts++;
      this.recognitionDiagnostics.capture = 'capturing';
      const result = await this.recognitionProvider.identify({ station: this.currentStation, signal, metadataFirst: false });
      this.recognitionDiagnostics.capture = 'idle';
      this.recognitionDiagnostics.captureMs = result?.diagnostics?.captureMs ?? null;
      this.recognitionDiagnostics.providerMs = result?.diagnostics?.providerMs ?? null;
      this.recognitionDiagnostics.sampleBytes = result?.diagnostics?.sampleBytes ?? null;
      this.recognitionDiagnostics.lastDurationMs = result?.diagnostics
        ? result.diagnostics.captureMs + result.diagnostics.providerMs
        : null;
      this.recognitionDiagnostics.lastError = result?.reason === 'cooldown' ? '' : (result?.reason || '');
      if (result && result.title) {
        return {
          title: result.title,
          artist: result.artist || '',
          album: result.album || '', artwork: result.artwork || '', releaseDate: result.releaseDate || '',
          duration: result.duration ?? null, identifier: result.identifier || '', url: result.url || '',
          rawTitle: `${result.artist ? result.artist + ' - ' : ''}${result.title}`,
          source: result.source || this.recognitionProvider.name || 'provider',
          status: 'IDENTIFIED',
          confidence: result.confidence ?? null,
          method: result.method || 'provider',
          timestamp: Date.now()
        };
      }
    } catch (error) {
      this.recognitionDiagnostics.capture = 'idle';
      this.recognitionDiagnostics.lastError = error?.message || 'provider-error';
    }
    return null;
  }

  /** Reconhecimento sob demanda pela hierarquia do provider configurado. */
  async identifyCurrentStation() {
    if (!this.currentStation?.streamUrl || !this.recognitionProvider) {
      return { ok: false, reason: 'no-station' };
    }
    this.recognitionDiagnostics ||= { provider: this.recognitionProvider.name || 'RecognitionProvider', attempts: 0, capture: 'idle', lastDurationMs: null, captureMs: null, providerMs: null, sampleBytes: null, lastError: '' };
    this.abortController?.abort();
    this.abortController = new AbortController();
    const signal = this.abortController.signal;
    this.recognitionDiagnostics.attempts++;
    this.recognitionDiagnostics.capture = 'capturing';
    this.state?.setState({ currentTrack: {
      title: '', artist: '', rawTitle: '', source: this.recognitionProvider.name || 'Reconhecimento', status: 'SEARCHING', method: 'acoustic',
      confidence: null, timestamp: Date.now()
    } });
    try {
      const result = await this.recognitionProvider.identify({ station: this.currentStation, signal, force: true });
      if (signal.aborted) return { ok: false, reason: 'cancelled' };
      this.recognitionDiagnostics.capture = 'idle';
      this.recognitionDiagnostics.captureMs = result.diagnostics?.captureMs ?? null;
      this.recognitionDiagnostics.providerMs = result.diagnostics?.providerMs ?? null;
      this.recognitionDiagnostics.sampleBytes = result.diagnostics?.sampleBytes ?? null;
      this.recognitionDiagnostics.lastError = result.reason || '';
      if (!result?.title) {
        this._applyFallbackLiveState(this.currentStation);
        return { ok: false, reason: result?.reason || 'no-match' };
      }
      this._applyTrackUpdate({
        title: result.title, artist: result.artist || '', rawTitle: result.rawTitle || '',
        album: result.album || '', artwork: result.artwork || '', releaseDate: result.releaseDate || '',
        duration: result.duration ?? null, identifier: result.identifier || '', url: result.url || '',
        source: result.source || 'Metadados da rádio', method: result.method || 'metadata', status: 'IDENTIFIED',
        confidence: result.confidence ?? null, timestamp: Date.now()
      });
      return { ok: true, track: result };
    } catch (error) {
      this.recognitionDiagnostics.capture = 'idle';
      this.recognitionDiagnostics.lastError = error?.message || 'provider-error';
      if (!signal.aborted) this._applyFallbackLiveState(this.currentStation);
      return { ok: false, reason: error?.message || 'unavailable' };
    }
  }

  /**
   * Processa e higieniza strings brutas de música (ex: "Queen - Bohemian Rhapsody")
   */
  _parseTrackString(raw, source, confidence) {
    if (!raw) return null;

    let clean = raw.trim();

    // Filtra ruídos comuns de autopromoção de rádios ("Station ID", "Jingle", etc.)
    const ignoredPromos = [
      /^(ao vivo|live|on air|streaming|transmissao|radio|musica|programacao|spot|vinheta)$/i,
      /^(commercial|advertisement|station id|jingle)$/i
    ];

    if (ignoredPromos.some(p => p.test(clean))) {
      return null;
    }

    let artist = '';
    let title = clean;

    // Divide em "Artista - Título" se contiver separador padrão
    if (clean.includes(' - ')) {
      const parts = clean.split(' - ');
      artist = parts[0].trim();
      title = parts.slice(1).join(' - ').trim();
    } else if (clean.includes(' / ')) {
      const parts = clean.split(' / ');
      artist = parts[0].trim();
      title = parts.slice(1).join(' / ').trim();
    }

    // Remove parênteses com publicidade comum
    title = title.replace(/\s*\((radio edit|original mix|official audio|clean)\)/gi, '').trim();

    return {
      title: title || clean,
      artist: artist || '',
      rawTitle: clean,
      source,
      status: source === 'provider' ? 'IDENTIFIED' : 'METADATA',
      confidence: null,
      metadataQuality: confidence,
      timestamp: Date.now()
    };
  }

  /**
   * Aplica atualização de faixa identificada
   */
  _applyTrackUpdate(track) {
    if (!track) return;

    if (this.lastDetectedRaw === track.rawTitle) {
      return; // Já está exibindo
    }

    this.lastDetectedRaw = track.rawTitle;
    this.state.setState({ currentTrack: track });
    this.state.addTrackToHistory(track);
  }

  /**
   * Aplica estado honesto quando não há metadados disponíveis (NUNCA INVENTA)
   */
  _applyFallbackLiveState(station) {
    this.state.setState({
      currentTrack: {
        title: '',
        artist: '',
        album: '', artwork: '', releaseDate: '', duration: null, identifier: '', url: '', method: 'none',
        rawTitle: '',
        source: 'none',
        status: 'UNKNOWN',
        confidence: null,
        timestamp: Date.now()
      }
    });
  }
}

// Expõe globalmente
window.AudioRecognitionProvider = AudioRecognitionProvider;
window.MusicRecognitionService = MusicRecognitionService;
window.MetadataManager = MusicRecognitionService;
