/**
 * WORLD RADIO GLOBE — Gerenciador do WebAudio Player (player.js)
 * Sistema de 8 Estados, Reconexão Automática com Exponential Backoff,
 * Sequência de Sintonia Analógica e Integração com AppStateManager.
 */

class AudioPlayerManager {
  constructor(appStateManager) {
    this.state = appStateManager || window.appState;
    this.audio = new Audio();
    this.audio.preload = 'none';
    // Do not force CORS mode on radio streams: many otherwise playable stations
    // do not send Access-Control-Allow-Origin and would become unplayable.
    this.audio.crossOrigin = '';
    this.requestGeneration = 0;

    this.currentStation = null;
    this.currentStreamUrl = null;
    this.isPlaying = false;
    this.isMuted = false;
    this.volume = Utils.storage.get('wrg_volume', 0.8);

    this.audio.volume = this.volume;

    // Gerenciador de Reconexão e Retry
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 3;
    this.reconnectTimer = null;
    this.wasPlayingBeforeOffline = false;

    // Callbacks de compatibilidade com versões anteriores
    this.onStateChange = null;
    this.onVolumeChange = null;
    this.onStreamError = null;

    this.setupListeners();
    this.setupNetworkWatchers();
  }

  /**
   * Retorna o elemento HTML5 Audio para conexão com o analisador do visualizador
   */
  getAudioElement() {
    return this.audio;
  }

  /**
   * Monitoramento nativo de conexão online/offline
   */
  setupNetworkWatchers() {
    window.addEventListener('offline', () => {
      if (this.isPlaying) {
        this.wasPlayingBeforeOffline = true;
        this.pause();
      }
      this.notifyState('OFFLINE', 'SEM CONEXÃO DE REDE', 'Verifique sua conexão com a internet.');
    });

    window.addEventListener('online', () => {
      if (this.wasPlayingBeforeOffline && this.currentStation) {
        this.wasPlayingBeforeOffline = false;
        Utils.showToast('Conexão restabelecida. Reconectando à estação...', 'info');
        this.playStation(this.currentStation);
      } else {
        this.notifyState('PAUSED', 'CONEXÃO RESTABELECIDA');
      }
    });
  }

  /**
   * Configura listeners de eventos do elemento HTML5 Audio
   */
  setupListeners() {
    this.audio.addEventListener('loadstart', () => {
      this.notifyState('LOADING', 'CARREGANDO TRANSMISSÃO...');
    });

    this.audio.addEventListener('waiting', () => {
      this.notifyState('BUFFERING', 'BUFFERING...');
    });

    this.audio.addEventListener('canplay', () => {
      if (this.isPlaying) {
        this.notifyState('PLAYING', 'AO VIVO');
      }
    });

    this.audio.addEventListener('playing', () => {
      this.isPlaying = true;
      this.reconnectAttempts = 0;
      if (this.reconnectTimer) {
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
      }
      this.notifyState('PLAYING', 'AO VIVO');
    });

    this.audio.addEventListener('pause', () => {
      // Se não estiver em transição de erro/loading/reconnect
      const curState = this.state ? this.state.getState().playbackState : null;
      if (curState !== 'RECONNECTING' && curState !== 'LOADING' && curState !== 'BUFFERING') {
        this.isPlaying = false;
        this.notifyState('PAUSED', 'PAUSADO');
      }
    });

    this.audio.addEventListener('stalled', () => {
      if (this.isPlaying && navigator.onLine) {
        this.handleStreamStall();
      }
    });

    // Tratamento resiliente de erro de transmissão
    this.audio.addEventListener('error', (e) => {
      this.isPlaying = false;
      let errorMsg = 'Transmissão indisponível no momento';

      if (!navigator.onLine) {
        this.notifyState('OFFLINE', 'OFFLINE', 'Sem conexão com a internet.');
        return;
      }

      if (this.currentStation) {
        // Detecta erro de Mixed Content (HTTP em HTTPS)
        if (window.location.protocol === 'https:' && !this.currentStation.isHttps) {
          errorMsg = 'Bloqueado pelo navegador: Stream HTTP em site HTTPS seguro.';
        } else if (this.audio.error) {
          switch (this.audio.error.code) {
            case MediaError.MEDIA_ERR_ABORTED:
              errorMsg = 'Transmissão abortada.';
              break;
            case MediaError.MEDIA_ERR_NETWORK:
              errorMsg = 'Falha de rede ao conectar à estação.';
              break;
            case MediaError.MEDIA_ERR_DECODE:
              errorMsg = 'Codec de áudio não suportado pelo navegador.';
              break;
            case MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED:
              errorMsg = 'Formato ou endereço da rádio inacessível.';
              break;
            default:
              errorMsg = 'Não foi possível conectar ao fluxo de áudio.';
          }
        }
      }

      console.warn('[AudioPlayer] Erro na reprodução da estação:', errorMsg, e);

      // Tenta reconexão automática com exponential backoff se não for erro fatal de protocolo
      if (this.reconnectAttempts < this.maxReconnectAttempts && !errorMsg.includes('Bloqueado')) {
        this.triggerReconnect();
      } else {
        this.notifyState('ERROR', 'STREAM INDISPONÍVEL', errorMsg);
        this.onStreamError?.(this.currentStation, errorMsg);
      }
    });
  }

  /**
   * Trata congelamento do buffer de transmissão
   */
  handleStreamStall() {
    console.warn('[AudioPlayer] Transmissão estagnada (stalled). Tentando resincronizar...');
    this.notifyState('BUFFERING', 'RESINCRONIZANDO...');
    if (this.audio.src) {
      this.audio.currentTime = this.audio.currentTime;
    }
  }

  /**
   * Dispara tentativa de reconexão com backoff exponencial
   */
  triggerReconnect() {
    this.reconnectAttempts++;
    const delay = Math.pow(2, this.reconnectAttempts) * 1000; // 2s, 4s, 8s

    this.notifyState('RECONNECTING', `RECONECTANDO (${this.reconnectAttempts}/${this.maxReconnectAttempts})...`);

    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => {
      if (this.currentStation && this.currentStation.streamUrl) {
        console.log(`[AudioPlayer] Tentativa de reconexão ${this.reconnectAttempts}...`);
        this.audio.load();
        this.audio.play().catch(err => {
          console.warn('[AudioPlayer] Falha na tentativa de reconexão:', err);
        });
      }
    }, delay);
  }

  selectStation(station) {
    this.requestGeneration++;
    this.clearReconnect();
    this.audio.pause();
    this.audio.removeAttribute('src');
    this.audio.load();
    this.currentStation = station || null;
    this.currentStreamUrl = station?.streamUrl || null;
    this.isPlaying = false;
    this.reconnectAttempts = 0;

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    const hasStream = Boolean(station?.hasStream || station?.streamUrl);
    this.notifyState(
      hasStream ? 'PAUSED' : 'ERROR',
      hasStream ? 'PRONTO PARA REPRODUZIR' : 'SEM TRANSMISSÃO',
      hasStream ? null : 'Esta estação não informa um endereço de transmissão.'
    );
  }

  /**
   * Dispara callback e atualiza o estado centralizado
   */
  notifyState(state, statusText, details = null) {
    if (this.state) {
      this.state.setState({
        playbackState: state,
        statusText,
        errorDetails: details,
        currentStation: this.currentStation,
        currentStream: this.currentStreamUrl,
        reconnectAttempt: this.reconnectAttempts
      });
    }

    if (typeof this.onStateChange === 'function') {
      this.onStateChange({
        state,
        statusText,
        station: this.currentStation,
        isPlaying: this.isPlaying,
        details
      });
    }
  }

  /**
   * Sintoniza e inicia a reprodução de uma estação com sequência analógica de sintonia
   * @param {Object} station Objeto normalizado da rádio
   */
  async playStation(station) {
    const generation = ++this.requestGeneration;
    let validStream = false;
    try {
      validStream = Boolean(station?.streamUrl && ['http:', 'https:'].includes(new URL(station.streamUrl).protocol));
    } catch { validStream = false; }

    if (!station || !validStream) {
      this.notifyState('ERROR', 'STREAM INVÁLIDO', 'Endereço de rádio não encontrado ou inválido.');
      return;
    }

    if (!navigator.onLine) {
      this.notifyState('OFFLINE', 'OFFLINE', 'Sem conexão com a internet.');
      return;
    }

    this.clearReconnect();
    this.audio.pause();
    this.audio.removeAttribute('src');
    this.audio.load();
    this.currentStation = station;
    this.currentStreamUrl = station.streamUrl;
    this.reconnectAttempts = 0;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    // Keep playback in the initiating user gesture; artificial delays can
    // make browsers reject the stream as autoplay.
    this.notifyState('LOADING', 'VARRENDO FREQUÊNCIA...');
    this.notifyState('BUFFERING', 'SINCRONIZANDO SINAL...');
    this.audio.src = station.streamUrl;
    this.audio.load();

    try {
      await this.audio.play();
      if (generation !== this.requestGeneration) return;
      this.isPlaying = true;
      this.notifyState('PLAYING', 'AO VIVO');

      // Notifica a API de analytics sobre a reprodução
      if (window.radioApi && typeof window.radioApi.registerPlayClick === 'function') {
        window.radioApi.registerPlayClick(station.id);
      }
    } catch (err) {
      if (generation !== this.requestGeneration) return;
      this.isPlaying = false;
      if (err.name === 'NotAllowedError') {
        this.notifyState('PAUSED', 'CLIQUE PLAY PARA OUVIR', 'Autoplay bloqueado pelo navegador.');
      } else {
        this.notifyState('ERROR', 'STREAM INDISPONÍVEL', 'Não foi possível conectar ao fluxo de áudio.');
      }
    }
  }

  /**
   * Alterna entre Play e Pause
   */
  togglePlayPause() {
    if (!this.currentStation) return;

    if (this.isPlaying) {
      this.pause();
    } else {
      if (!this.audio.src || this.audio.src === '' || this.audio.src === window.location.href) {
        this.playStation(this.currentStation);
      } else {
        const generation = ++this.requestGeneration;
        this.clearReconnect();
        this.audio.play().then(() => {
          if (generation !== this.requestGeneration) return;
          this.isPlaying = true;
          this.notifyState('PLAYING', 'AO VIVO');
        }).catch(() => {
          if (generation === this.requestGeneration) this.playStation(this.currentStation);
        });
      }
    }
  }

  /**
   * Pausa a reprodução
   */
  pause() {
    this.requestGeneration++;
    this.clearReconnect();
    this.audio.pause();
    this.isPlaying = false;
    this.notifyState('PAUSED', 'PAUSADO');
  }

  stop() {
    this.requestGeneration++;
    this.clearReconnect();
    this.audio.pause();
    this.audio.removeAttribute('src');
    this.audio.load();
    this.isPlaying = false;
    this.notifyState('STOPPED', 'PARADO');
  }

  clearReconnect() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  /**
   * Define o volume da transmissão (0.0 a 1.0)
   * @param {number} value 
   */
  setVolume(value) {
    const val = Math.max(0, Math.min(1, parseFloat(value) || 0));
    this.volume = val;
    this.audio.volume = val;
    this.isMuted = (val === 0);

    Utils.storage.set('wrg_volume', val);

    if (this.state) {
      this.state.setState({ volume: val, isMuted: this.isMuted });
    }

    if (typeof this.onVolumeChange === 'function') {
      this.onVolumeChange(this.volume, this.isMuted);
    }
  }

  /**
   * Alterna estado mudo (Mute/Unmute)
   */
  toggleMute() {
    this.isMuted = !this.isMuted;
    this.audio.muted = this.isMuted;

    if (this.state) {
      this.state.setState({ isMuted: this.isMuted });
    }

    if (typeof this.onVolumeChange === 'function') {
      this.onVolumeChange(this.isMuted ? 0 : this.volume, this.isMuted);
    }
  }
}

// Expõe globalmente
window.AudioPlayerManager = AudioPlayerManager;
