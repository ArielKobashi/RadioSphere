/**
 * WORLD RADIO GLOBE — Gerenciador de Metadados e Reconhecimento de Faixas (metadataManager.js)
 * Estratégia em 4 Camadas de Resolução com Regra Estrita de ZERO DADOS FALSOS.
 * 
 * Camadas:
 * - Camada 1: Metadados ICY de Stream (Icecast / Shoutcast StreamTitle via fetch com Icy-MetaData)
 * - Camada 2: Endpoints JSON de Estações Conhecidas (Icecast status-json.xsl / stats / AzuraCast)
 * - Camada 3: Diretório Radio Browser / Contexto de Programação
 * - Camada 4: Interface Modular AudioRecognitionProvider (AudD / ACRCloud / WebAudio Fingerprint)
 */

class AudioRecognitionProvider {
  /**
   * Interface abstrata para provedores de reconhecimento acústico (ACRCloud, AudD, Shazam, etc.)
   */
  async identify(audioBuffer) {
    // Implementação padrão: nenhum provedor externo configurado.
    // Retorna nulo para garantir que nenhum dado fictício seja inventado.
    return null;
  }
}

class MetadataManager {
  constructor(appStateManager) {
    this.state = appStateManager || window.appState;
    this.pollIntervalMs = 18000;
    this.timer = null;
    this.abortController = null;
    this.currentStation = null;
    this.recognitionProvider = new AudioRecognitionProvider();

    // Cache para evitar requisições redundantes
    this.lastDetectedRaw = '';
    this.consecutiveFailures = 0;

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
        confidence: 'unavailable',
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

    const timeoutId = setTimeout(() => this.abortController?.abort(), 5000);
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
    // Se a estação tiver tags de gênero ricas ou programa ativo no nome
    return null;
  }

  /**
   * Camada 4: Provedor modular de reconhecimento
   */
  async _queryLayer4Provider(signal) {
    try {
      const result = await this.recognitionProvider.identify({ station: this.currentStation, signal });
      if (result && result.title) {
        return {
          title: result.title,
          artist: result.artist || '',
          rawTitle: `${result.artist ? result.artist + ' - ' : ''}${result.title}`,
          source: result.source || 'provider',
          status: 'IDENTIFIED',
          confidence: 'verified',
          timestamp: Date.now()
        };
      }
    } catch (_) {
      // Falha no provedor
    }
    return null;
  }

  /** Reconhecimento sob demanda: a captura só inicia após ação explícita do usuário. */
  async identifyCurrentStation() {
    if (!this.currentStation?.streamUrl || !this.recognitionProvider) {
      return { ok: false, reason: 'no-station' };
    }
    this.abortController?.abort();
    this.abortController = new AbortController();
    const signal = this.abortController.signal;
    this.state?.setState({ currentTrack: {
      title: '', artist: '', rawTitle: '', source: 'Shazam', status: 'SEARCHING',
      confidence: 'unavailable', timestamp: Date.now()
    } });
    try {
      const result = await this.recognitionProvider.identify({ station: this.currentStation, signal });
      if (signal.aborted) return { ok: false, reason: 'cancelled' };
      if (!result?.title) {
        this._applyFallbackLiveState(this.currentStation);
        return { ok: false, reason: result?.reason || 'no-match' };
      }
      this._applyTrackUpdate({
        title: result.title, artist: result.artist || '', rawTitle: result.rawTitle || '',
        source: result.source || 'Reconhecimento de música', status: 'IDENTIFIED', confidence: 'verified', timestamp: Date.now()
      });
      return { ok: true, track: result };
    } catch (error) {
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
      confidence,
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
        rawTitle: '',
        source: 'none',
        status: 'UNKNOWN',
        confidence: 'unavailable',
        timestamp: Date.now()
      }
    });
  }
}

// Expõe globalmente
window.AudioRecognitionProvider = AudioRecognitionProvider;
window.MetadataManager = MetadataManager;
