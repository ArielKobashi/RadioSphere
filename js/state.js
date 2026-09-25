/**
 * WORLD RADIO GLOBE — Sistema de Estado Centralizado (state.js)
 * Gerenciador unificado de estado com padrão Observer / PubSub reativo.
 */

class AppStateManager {
  constructor() {
    this._state = {
      // Estação e Transmissão
      currentStation: null,
      currentStream: null,
      previousStation: null,

      // Máquina de Estados de Reprodução (8 estados formais)
      // 'IDLE' | 'LOADING' | 'PLAYING' | 'PAUSED' | 'BUFFERING' | 'ERROR' | 'OFFLINE' | 'RECONNECTING' | 'STOPPED'
      playbackState: 'IDLE',
      statusText: 'PRONTO',
      errorDetails: null,
      reconnectAttempt: 0,

      // Controle de Áudio
      volume: Utils.storage.get('wrg_volume', 0.8),
      isMuted: false,

      // Metadados da Faixa ("Now Playing")
      currentTrack: {
        title: '',
        artist: '',
        rawTitle: '',
        source: 'none', // 'icy' | 'station_api' | 'provider' | 'none'
        confidence: 'unavailable', // 'verified' | 'possible' | 'unavailable'
        timestamp: 0
      },
      trackHistory: Utils.storage.get('wrg_track_history', []),

      // Visualizador
      // 'OSCILLOSCOPE' | 'VU_METER' | 'SPECTRUM' | 'ANALOG' | 'MINIMAL'
      visualizerMode: Utils.storage.get('wrg_visualizer_mode', 'SPECTRUM'),

      // Telemetria e Posição do Globo
      currentLocation: {
        lat: null,
        lon: null,
        altitude: 22000000
      },

      // Sistema e Conectividade
      isOnline: navigator.onLine,
      isNowPlayingDrawerOpen: false,
      activeFilters: {
        country: '',
        state: '',
        language: '',
        genre: '',
        codec: '',
        minBitrate: ''
      }
    };

    this._listeners = new Set();
    this._keyListeners = new Map();

    this._initSystemListeners();
  }

  _initSystemListeners() {
    // Monitoramento nativo de conexão de rede
    window.addEventListener('online', () => {
      this.setState({ isOnline: true });
    });

    window.addEventListener('offline', () => {
      this.setState({
        isOnline: false,
        playbackState: 'OFFLINE',
        statusText: 'SEM CONEXÃO DE REDE',
        errorDetails: 'O dispositivo perdeu o acesso à internet.'
      });
    });
  }

  /**
   * Retorna cópia imutável do estado atual
   */
  getState() {
    return { ...this._state };
  }

  /**
   * Atualiza partes do estado e notifica ouvintes
   * @param {Object} partialState 
   */
  setState(partialState) {
    if (!partialState || typeof partialState !== 'object') return;

    const changedKeys = [];
    const prevState = { ...this._state };

    for (const [key, value] of Object.entries(partialState)) {
      if (this._state[key] !== value) {
        this._state[key] = value;
        changedKeys.push(key);
      }
    }

    if (changedKeys.length === 0) return;

    // Persistências automáticas
    if (changedKeys.includes('volume')) {
      Utils.storage.set('wrg_volume', this._state.volume);
    }
    if (changedKeys.includes('visualizerMode')) {
      Utils.storage.set('wrg_visualizer_mode', this._state.visualizerMode);
    }
    if (changedKeys.includes('trackHistory')) {
      Utils.storage.set('wrg_track_history', this._state.trackHistory.slice(0, 30));
    }

    // Notifica ouvintes globais
    const currentState = this.getState();
    this._listeners.forEach(listener => {
      try {
        listener(currentState, prevState, changedKeys);
      } catch (err) {
        console.error('[AppStateManager] Erro em ouvinte global:', err);
      }
    });

    // Notifica ouvintes de chaves específicas
    changedKeys.forEach(key => {
      if (this._keyListeners.has(key)) {
        const keyListeners = this._keyListeners.get(key);
        keyListeners.forEach(listener => {
          try {
            listener(this._state[key], prevState[key], currentState);
          } catch (err) {
            console.error(`[AppStateManager] Erro em ouvinte da chave "${key}":`, err);
          }
        });
      }
    });
  }

  /**
   * Assina atualizações de todo o estado
   * @param {Function} listener 
   * @returns {Function} Função de desinscrição (unsubscribe)
   */
  subscribe(listener) {
    if (typeof listener !== 'function') return () => {};
    this._listeners.add(listener);
    return () => this._listeners.delete(listener);
  }

  /**
   * Assina atualizações de uma chave específica do estado
   * @param {string} key 
   * @param {Function} listener 
   * @returns {Function} Função de desinscrição (unsubscribe)
   */
  subscribeKey(key, listener) {
    if (typeof listener !== 'function') return () => {};
    if (!this._keyListeners.has(key)) {
      this._keyListeners.set(key, new Set());
    }
    this._keyListeners.get(key).add(listener);
    return () => {
      const set = this._keyListeners.get(key);
      if (set) {
        set.delete(listener);
        if (set.size === 0) this._keyListeners.delete(key);
      }
    };
  }

  /**
   * Registra uma faixa detectada no histórico de reprodução
   * @param {Object} trackInfo 
   */
  addTrackToHistory(trackInfo) {
    if (!trackInfo || !trackInfo.title) return;
    const current = this._state.currentStation;
    if (!current) return;

    const now = Date.now();
    const history = [...this._state.trackHistory];

    // Evita duplicidade da mesma faixa na mesma estação em menos de 2 minutos
    const recent = history.find(h => 
      h.stationId === current.id && 
      h.title === trackInfo.title && 
      (now - h.timestamp < 120000)
    );

    if (recent) return;

    const entry = {
      id: `${current.id}-${now}`,
      stationId: current.id,
      stationName: current.name,
      stationCountry: current.country,
      title: trackInfo.title,
      artist: trackInfo.artist || '',
      album: trackInfo.album || '',
      source: trackInfo.source || 'unknown',
      confidence: trackInfo.confidence || 'verified',
      timestamp: now
    };

    history.unshift(entry);
    this.setState({ trackHistory: history.slice(0, 30) });
  }
}

// Instância global única
window.appState = new AppStateManager();
