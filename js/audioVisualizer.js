/**
 * WORLD RADIO GLOBE — Visualizador de Áudio Analógico e Digital (audioVisualizer.js)
 * 5 Modos Selecionáveis:
 * 1. OSCILLOSCOPE (Osciloscópio de feixe catódico analógico)
 * 2. VU METER (Dois medidores analógicos de agulha com escala dB e LED de pico)
 * 3. SPECTRUM (Analisador de espectro de frequências cyberpunk)
 * 4. ANALOG (Radar circular / Sintonia de rádio com varredura harmônica)
 * 5. MINIMAL (Equalizador sutil de 7 barras cinéticas)
 * 
 * O canvas só representa bytes reais expostos pela Web Audio API. Quando CORS
 * impede a leitura, a UI indica indisponibilidade sem simular sinal.
 */

class AudioVisualizer {
  constructor(canvasElement, audioElement, appStateManager) {
    this.canvas = canvasElement;
    this.ctx = this.canvas ? this.canvas.getContext('2d') : null;
    this.audio = audioElement;
    this.state = appStateManager || window.appState;

    // Modos suportados
    this.modes = ['SPECTRUM', 'OSCILLOSCOPE', 'VU_METER', 'ANALOG', 'MINIMAL'];
    this.currentMode = Utils.storage.get('wrg_visualizer_mode', 'SPECTRUM');
    if (!this.modes.includes(this.currentMode)) {
      this.currentMode = 'SPECTRUM';
    }

    // Web Audio API
    this.audioCtx = null;
    this.analyser = null;
    this.sourceNode = null;
    this.hasDirectAudioNode = false;
    this.isAudioContextStarted = false;

    // Buffers de áudio
    this.fftSize = 256;
    this.freqData = new Uint8Array(this.fftSize / 2);
    this.timeData = new Uint8Array(this.fftSize);

    // Estado da animação
    this.animationId = null;
    this.isRunning = false;
    this.isDocumentVisible = !document.hidden;
    this.prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    // Física e Balística do VU Meter
    this.vuNeedleL = 0;
    this.vuNeedleR = 0;
    this.vuVelocityL = 0;
    this.vuVelocityR = 0;
    this.vuPeakHoldL = 0;
    this.vuPeakHoldR = 0;

    // Histórico de picos do Spectrum
    this.spectrumPeaks = new Float32Array(32);
    this.spectrumDecay = 0.94;

    // Ângulo de varredura do modo ANALOG
    this.analogAngle = 0;

    this._initListeners();
    this._resizeCanvas();
  }

  /**
   * Vincula ou atualiza o elemento canvas
   */
  attachCanvas(canvas) {
    this.canvas = canvas;
    this.ctx = canvas ? canvas.getContext('2d') : null;
    this._resizeCanvas();
  }

  /**
   * Vincula ou atualiza o elemento de áudio
   */
  attachAudio(audioElement) {
    this.audio = audioElement;
    this.hasDirectAudioNode = false;
    this.sourceNode = null;
  }

  _initListeners() {
    // Redimensionamento responsivo
    window.addEventListener('resize', Utils.debounce(() => this._resizeCanvas(), 200));

    // Otimização de bateria e CPU ao minimizar / trocar de aba
    document.addEventListener('visibilitychange', () => {
      this.isDocumentVisible = !document.hidden;
      if (this.isDocumentVisible && this._shouldAnimate()) {
        this.start();
      } else {
        this.stop();
      }
    });

    // Acessibilidade: prefers-reduced-motion
    window.matchMedia('(prefers-reduced-motion: reduce)').addEventListener('change', (e) => {
      this.prefersReducedMotion = e.matches;
    });

    // Mudanças de estado da aplicação
    if (this.state) {
      this.state.subscribeKey('playbackState', (state) => {
        if (state === 'PLAYING') {
          this.initAudioContext();
          this.start();
        } else {
          this.stop();
          this._drawIdleFrame();
        }
      });

      this.state.subscribeKey('visualizerMode', (mode) => {
        if (this.modes.includes(mode)) {
          this.currentMode = mode;
          if (!this.isRunning) this._drawIdleFrame();
        }
      });
    }
  }

  _resizeCanvas() {
    if (!this.canvas) return;
    const rect = this.canvas.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const width = Math.floor(rect.width || 320);
    const height = Math.floor(rect.height || 140);

    if (this.canvas.width !== width * dpr || this.canvas.height !== height * dpr) {
      this.canvas.width = width * dpr;
      this.canvas.height = height * dpr;
    }

    if (!this.isRunning) {
      this._drawIdleFrame();
    }
  }

  /**
   * Inicializa o AudioContext no primeiro gesto do usuário
   */
  initAudioContext() {
    if (this.isAudioContextStarted && this.analyser) return;

    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtx) return;

      if (!this.audioCtx) {
        this.audioCtx = new AudioCtx();
      }

      if (this.audioCtx.state === 'suspended') {
        this.audioCtx.resume();
      }

      if (!this.analyser) {
        this.analyser = this.audioCtx.createAnalyser();
        this.analyser.fftSize = this.fftSize;
        this.analyser.smoothingTimeConstant = 0.82;
      }

      // Só ligue o nó quando a reprodução tiver sido iniciada explicitamente em
      // modo CORS. Uma origem opaca pode silenciar o elemento ao passar pelo WebAudio.
      if (this.audio && this.audio.crossOrigin === 'anonymous' && !this.sourceNode) {
        try {
          this.sourceNode = this.audioCtx.createMediaElementSource(this.audio);
          this.sourceNode.connect(this.analyser);
          this.analyser.connect(this.audioCtx.destination);
          this.hasDirectAudioNode = true;
          console.log('[AudioVisualizer] Fonte de áudio conectada com sucesso via WebAudio.');
        } catch (corsErr) {
          // CORS bloqueado ou já conectado a outro nó: deixa o áudio nativo intacto.
          this.hasDirectAudioNode = false;
          console.info('[AudioVisualizer] O stream não expõe áudio para análise WebAudio.');
        }
      }

      this.isAudioContextStarted = true;
    } catch (e) {
      console.warn('[AudioVisualizer] WebAudio não disponível no navegador:', e);
    }
  }

  /**
   * Altera o modo do visualizador
   * @param {'OSCILLOSCOPE'|'VU_METER'|'SPECTRUM'|'ANALOG'|'MINIMAL'} mode 
   */
  setMode(mode) {
    if (this.modes.includes(mode)) {
      this.currentMode = mode;
      Utils.storage.set('wrg_visualizer_mode', mode);
      if (this.state) {
        this.state.setState({ visualizerMode: mode });
      }
      if (!this.isRunning) {
        this._drawIdleFrame();
      }
    }
  }

  /**
   * Alterna ciclicamente entre os 5 modos
   */
  cycleMode() {
    const nextIdx = (this.modes.indexOf(this.currentMode) + 1) % this.modes.length;
    this.setMode(this.modes[nextIdx]);
    return this.currentMode;
  }

  _shouldAnimate() {
    const isPlaying = this.state ? this.state.getState().playbackState === 'PLAYING' : true;
    return this.isDocumentVisible && isPlaying && !this.prefersReducedMotion;
  }

  /**
   * Inicia o loop de renderização a 60 FPS
   */
  start() {
    if (this.isRunning) return;
    this.isRunning = true;

    const renderLoop = () => {
      if (!this.isRunning) return;
      this._updateAudioData();
      this._render();
      this.animationId = requestAnimationFrame(renderLoop);
    };

    this.animationId = requestAnimationFrame(renderLoop);
  }

  /**
   * Para o loop de renderização
   */
  stop() {
    this.isRunning = false;
    if (this.animationId) {
      cancelAnimationFrame(this.animationId);
      this.animationId = null;
    }
  }

  /**
   * Atualiza dados de frequência e onda somente com amostras reais
   */
  _updateAudioData() {
    const isPlaying = this.state ? this.state.getState().playbackState === 'PLAYING' : true;
    if (this.hasDirectAudioNode && this.analyser && isPlaying) {
      this.analyser.getByteFrequencyData(this.freqData);
      this.analyser.getByteTimeDomainData(this.timeData);
    } else {
      this.freqData.fill(0);
      this.timeData.fill(128);
    }
  }

  /**
   * Roteia a renderização para o modo ativo
   */
  _render() {
    if (!this.ctx || !this.canvas) return;
    const width = this.canvas.width;
    const height = this.canvas.height;

    this.ctx.clearRect(0, 0, width, height);

    switch (this.currentMode) {
      case 'OSCILLOSCOPE':
        this._renderOscilloscope(width, height);
        break;
      case 'VU_METER':
        this._renderVuMeter(width, height);
        break;
      case 'SPECTRUM':
        this._renderSpectrum(width, height);
        break;
      case 'ANALOG':
        this._renderAnalogRadar(width, height);
        break;
      case 'MINIMAL':
      default:
        this._renderMinimal(width, height);
        break;
    }
    if (this.state?.getState().playbackState === 'PLAYING' && !this.hasDirectAudioNode) {
      this.ctx.save();
      this.ctx.fillStyle = 'rgba(8, 16, 24, 0.82)';
      this.ctx.fillRect(0, height - 22, width, 22);
      this.ctx.fillStyle = 'rgba(190, 205, 215, 0.9)';
      this.ctx.font = '10px Chakra Petch, monospace';
      this.ctx.textAlign = 'center';
      this.ctx.fillText('VISUALIZAÇÃO INDISPONÍVEL — STREAM SEM ACESSO CORS', width / 2, height - 7);
      this.ctx.restore();
    }
  }

  /**
   * Renderiza um quadro estático elegante quando ocioso
   */
  _drawIdleFrame() {
    if (!this.ctx || !this.canvas) return;
    const width = this.canvas.width;
    const height = this.canvas.height;
    this.ctx.clearRect(0, 0, width, height);

    this.ctx.save();
    this.ctx.strokeStyle = 'rgba(91, 216, 232, 0.15)';
    this.ctx.lineWidth = 1;
    this.ctx.setLineDash([4, 4]);

    // Linha de centro de repouso
    this.ctx.beginPath();
    this.ctx.moveTo(0, height / 2);
    this.ctx.lineTo(width, height / 2);
    this.ctx.stroke();

    this.ctx.fillStyle = 'rgba(166, 187, 200, 0.4)';
    this.ctx.font = '10px Chakra Petch, monospace';
    this.ctx.textAlign = 'center';
    this.ctx.fillText(`${this.currentMode} — STANDBY`, width / 2, height / 2 - 8);
    this.ctx.restore();
  }

  /* =========================================================================
     MODO 1: OSCILLOSCOPE (Osciloscópio de Fósforo Verde/Ciano)
     ========================================================================= */
  _renderOscilloscope(width, height) {
    const ctx = this.ctx;
    const bufferLength = this.timeData.length;

    // Grade Reticular de Fundo
    ctx.save();
    ctx.strokeStyle = 'rgba(91, 216, 232, 0.08)';
    ctx.lineWidth = 1;
    const gridStep = 24;
    for (let x = 0; x < width; x += gridStep) {
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, height);
      ctx.stroke();
    }
    for (let y = 0; y < height; y += gridStep) {
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(width, y);
      ctx.stroke();
    }

    // Traçado do Feixe Catódico com Brilho Neon (Phosphor Glow)
    ctx.shadowBlur = 10;
    ctx.shadowColor = '#5bd8e8';
    ctx.strokeStyle = '#5bd8e8';
    ctx.lineWidth = 2.2;
    ctx.beginPath();

    const sliceWidth = width / bufferLength;
    let x = 0;

    for (let i = 0; i < bufferLength; i++) {
      const v = this.timeData[i] / 128.0;
      const y = (v * height) / 2;

      if (i === 0) {
        ctx.moveTo(x, y);
      } else {
        ctx.lineTo(x, y);
      }
      x += sliceWidth;
    }

    ctx.stroke();

    // Rótulo discreto
    ctx.shadowBlur = 0;
    ctx.fillStyle = 'rgba(91, 216, 232, 0.45)';
    ctx.font = '9px Chakra Petch, monospace';
    ctx.textAlign = 'left';
    ctx.fillText('OSCILLOSCOPE // 10ms/DIV', 8, 14);
    ctx.restore();
  }

  /* =========================================================================
     MODO 2: VU METER (Dois Medidores Analógicos de Agulha e Escala dB)
     ========================================================================= */
  _renderVuMeter(width, height) {
    const ctx = this.ctx;
    const meterWidth = width / 2;

    // Calcula níveis RMS aproximados a partir do espectro
    let sumL = 0;
    let sumR = 0;
    const half = Math.floor(this.freqData.length / 2);

    for (let i = 0; i < half; i++) {
      sumL += this.freqData[i];
      sumR += this.freqData[half + i];
    }

    const targetL = Math.min(1.0, (sumL / (half * 255)) * 1.4);
    const targetR = Math.min(1.0, (sumR / (half * 255)) * 1.4);

    // Balística física da agulha (inércia, amortecimento e mola)
    const spring = 0.28;
    const damping = 0.72;

    this.vuVelocityL = (this.vuVelocityL + (targetL - this.vuNeedleL) * spring) * damping;
    this.vuNeedleL = Math.max(0, Math.min(1.15, this.vuNeedleL + this.vuVelocityL));

    this.vuVelocityR = (this.vuVelocityR + (targetR - this.vuNeedleR) * spring) * damping;
    this.vuNeedleR = Math.max(0, Math.min(1.15, this.vuNeedleR + this.vuVelocityR));

    // Renderiza Canal Esquerdo (CH L) e Canal Direito (CH R)
    this._drawSingleVuDial(ctx, 0, 0, meterWidth, height, this.vuNeedleL, 'CH-L');
    this._drawSingleVuDial(ctx, meterWidth, 0, meterWidth, height, this.vuNeedleR, 'CH-R');
  }

  _drawSingleVuDial(ctx, x, y, w, h, level, label) {
    ctx.save();
    ctx.translate(x, y);

    // Borda e Mostrador Retrô
    ctx.fillStyle = 'rgba(7, 13, 20, 0.85)';
    ctx.strokeStyle = 'rgba(91, 216, 232, 0.22)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.roundRect(4, 4, w - 8, h - 8, 8);
    ctx.fill();
    ctx.stroke();

    const pivotX = w / 2;
    const pivotY = h - 6;
    const radius = Math.min(w * 0.44, h * 0.78);

    // Arco da Escala (-20dB a +3dB)
    const minAngle = -Math.PI * 0.72;
    const maxAngle = -Math.PI * 0.28;
    const zeroAngle = minAngle + (maxAngle - minAngle) * 0.78; // 0 dB

    // Faixa Segura (Ciano) e Faixa de Pico (Vermelha)
    ctx.lineWidth = 2.5;
    ctx.strokeStyle = 'rgba(91, 216, 232, 0.6)';
    ctx.beginPath();
    ctx.arc(pivotX, pivotY, radius, minAngle, zeroAngle);
    ctx.stroke();

    ctx.strokeStyle = 'rgba(244, 63, 94, 0.85)';
    ctx.beginPath();
    ctx.arc(pivotX, pivotY, radius, zeroAngle, maxAngle);
    ctx.stroke();

    // Marcas de escala dB
    const marks = [
      { text: '-20', val: 0.0 },
      { text: '-10', val: 0.32 },
      { text: '-5', val: 0.58 },
      { text: '0', val: 0.78 },
      { text: '+3', val: 1.0 }
    ];

    ctx.fillStyle = 'rgba(166, 187, 200, 0.6)';
    ctx.font = '8px Chakra Petch, monospace';
    ctx.textAlign = 'center';

    marks.forEach(m => {
      const angle = minAngle + (maxAngle - minAngle) * m.val;
      const tx = pivotX + Math.cos(angle) * (radius - 10);
      const ty = pivotY + Math.sin(angle) * (radius - 10);
      ctx.fillText(m.text, tx, ty);
    });

    // Agulha Analógica
    const needleAngle = minAngle + (maxAngle - minAngle) * Math.min(1.1, level);
    ctx.shadowBlur = 6;
    ctx.shadowColor = level > 0.82 ? '#f43f5e' : '#5bd8e8';
    ctx.strokeStyle = level > 0.82 ? '#f43f5e' : '#e6f7ff';
    ctx.lineWidth = 1.8;

    ctx.beginPath();
    ctx.moveTo(pivotX, pivotY);
    ctx.lineTo(
      pivotX + Math.cos(needleAngle) * radius,
      pivotY + Math.sin(needleAngle) * radius
    );
    ctx.stroke();

    // Pivô central
    ctx.shadowBlur = 0;
    ctx.fillStyle = '#5bd8e8';
    ctx.beginPath();
    ctx.arc(pivotX, pivotY, 4, 0, Math.PI * 2);
    ctx.fill();

    // LED Indicador de Pico (PEAK)
    const isPeaking = level > 0.82;
    ctx.fillStyle = isPeaking ? '#f43f5e' : 'rgba(244, 63, 94, 0.18)';
    if (isPeaking) {
      ctx.shadowBlur = 8;
      ctx.shadowColor = '#f43f5e';
    }
    ctx.beginPath();
    ctx.arc(w - 18, 16, 3.5, 0, Math.PI * 2);
    ctx.fill();

    // Rótulos do Mostrador
    ctx.shadowBlur = 0;
    ctx.fillStyle = 'rgba(166, 187, 200, 0.7)';
    ctx.font = '8px Chakra Petch, monospace';
    ctx.textAlign = 'left';
    ctx.fillText(`VU METER // ${label}`, 12, 18);

    ctx.restore();
  }

  /* =========================================================================
     MODO 3: SPECTRUM (Equalizador Cibernético com Barras de Frequência)
     ========================================================================= */
  _renderSpectrum(width, height) {
    const ctx = this.ctx;
    const numBars = 32;
    const padding = 3;
    const totalBarWidth = width / numBars;
    const barWidth = Math.max(2, totalBarWidth - padding);

    ctx.save();

    for (let i = 0; i < numBars; i++) {
      // Amostragem logarítmica com ênfase nos graves e médios
      const freqIdx = Math.floor(Math.pow(i / numBars, 1.4) * (this.freqData.length - 1));
      const value = this.freqData[freqIdx] / 255.0;
      const barHeight = Math.max(2, value * (height - 18));

      const x = i * totalBarWidth + padding / 2;
      const y = height - barHeight - 4;

      // Atualiza tampa de pico em queda livre (Peak Hold)
      if (value > this.spectrumPeaks[i]) {
        this.spectrumPeaks[i] = value;
      } else {
        this.spectrumPeaks[i] *= this.spectrumDecay;
      }

      // Gradiente Vertical Sci-fi (Ciano -> Magenta)
      const grad = ctx.createLinearGradient(0, height, 0, y);
      grad.addColorStop(0, 'rgba(91, 216, 232, 0.85)');
      grad.addColorStop(0.7, 'rgba(0, 212, 255, 0.95)');
      grad.addColorStop(1, 'rgba(236, 72, 153, 0.95)');

      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.roundRect(x, y, barWidth, barHeight, [2, 2, 0, 0]);
      ctx.fill();

      // Tampa de Pico
      const peakY = height - (this.spectrumPeaks[i] * (height - 18)) - 6;
      ctx.fillStyle = 'rgba(241, 247, 250, 0.85)';
      ctx.fillRect(x, Math.max(2, peakY), barWidth, 1.5);
    }

    // Rótulo
    ctx.fillStyle = 'rgba(91, 216, 232, 0.45)';
    ctx.font = '9px Chakra Petch, monospace';
    ctx.textAlign = 'left';
    ctx.fillText('SPECTRUM // FFT 32-BAND', 8, 14);

    ctx.restore();
  }

  /* =========================================================================
     MODO 4: ANALOG (Radar Circular / Sintonia de Rádio com Varredura)
     ========================================================================= */
  _renderAnalogRadar(width, height) {
    const ctx = this.ctx;
    const centerX = width / 2;
    const centerY = height / 2;
    const maxRadius = Math.min(centerX, centerY) - 8;

    this.analogAngle = (this.analogAngle + 0.04) % (Math.PI * 2);

    ctx.save();

    // Círculos concêntricos de alcance de sinal
    ctx.strokeStyle = 'rgba(91, 216, 232, 0.12)';
    ctx.lineWidth = 1;
    for (let r = maxRadius * 0.3; r <= maxRadius; r += maxRadius * 0.35) {
      ctx.beginPath();
      ctx.arc(centerX, centerY, r, 0, Math.PI * 2);
      ctx.stroke();
    }

    // Eixos da mira
    ctx.beginPath();
    ctx.moveTo(centerX - maxRadius, centerY);
    ctx.lineTo(centerX + maxRadius, centerY);
    ctx.moveTo(centerX, centerY - maxRadius);
    ctx.lineTo(centerX, centerY + maxRadius);
    ctx.stroke();

    // Braço de Varredura do Radar
    const sweepGrad = ctx.createRadialGradient(centerX, centerY, 0, centerX, centerY, maxRadius);
    sweepGrad.addColorStop(0, 'rgba(91, 216, 232, 0.4)');
    sweepGrad.addColorStop(1, 'rgba(91, 216, 232, 0)');

    ctx.fillStyle = sweepGrad;
    ctx.beginPath();
    ctx.moveTo(centerX, centerY);
    ctx.arc(centerX, centerY, maxRadius, this.analogAngle - 0.45, this.analogAngle);
    ctx.closePath();
    ctx.fill();

    // Linha do feixe
    ctx.strokeStyle = '#5bd8e8';
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    ctx.moveTo(centerX, centerY);
    ctx.lineTo(
      centerX + Math.cos(this.analogAngle) * maxRadius,
      centerY + Math.sin(this.analogAngle) * maxRadius
    );
    ctx.stroke();

    // Ondulação Harmônica da Frequência no Perímetro
    ctx.beginPath();
    ctx.strokeStyle = 'rgba(91, 216, 232, 0.7)';
    ctx.lineWidth = 1.5;

    const points = 48;
    for (let i = 0; i <= points; i++) {
      const theta = (i / points) * Math.PI * 2;
      const sample = this.freqData[i % this.freqData.length] / 255.0;
      const modRadius = maxRadius * (0.8 + sample * 0.22);
      const px = centerX + Math.cos(theta) * modRadius;
      const py = centerY + Math.sin(theta) * modRadius;

      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.closePath();
    ctx.stroke();

    ctx.fillStyle = 'rgba(91, 216, 232, 0.45)';
    ctx.font = '9px Chakra Petch, monospace';
    ctx.textAlign = 'left';
    ctx.fillText('ANALOG RADAR // RF SWEEP', 8, 14);

    ctx.restore();
  }

  /* =========================================================================
     MODO 5: MINIMAL (Equalizador Cinético Sutil de 7 Barras)
     ========================================================================= */
  _renderMinimal(width, height) {
    const ctx = this.ctx;
    const barCount = 7;
    const barWidth = 6;
    const gap = 8;
    const totalW = barCount * barWidth + (barCount - 1) * gap;
    const startX = (width - totalW) / 2;
    const centerY = height / 2;

    ctx.save();

    for (let i = 0; i < barCount; i++) {
      const idx = Math.floor((i / barCount) * (this.freqData.length / 2));
      const val = Math.max(0.12, this.freqData[idx] / 255.0);
      const h = val * (height * 0.7);

      const x = startX + i * (barWidth + gap);
      const y = centerY - h / 2;

      ctx.fillStyle = 'rgba(91, 216, 232, 0.85)';
      ctx.beginPath();
      ctx.roundRect(x, y, barWidth, h, 3);
      ctx.fill();
    }

    ctx.fillStyle = 'rgba(91, 216, 232, 0.4)';
    ctx.font = '9px Chakra Petch, monospace';
    ctx.textAlign = 'center';
    ctx.fillText('MINIMAL EQ', width / 2, height - 8);

    ctx.restore();
  }
}

// Expõe globalmente
window.AudioVisualizer = AudioVisualizer;
