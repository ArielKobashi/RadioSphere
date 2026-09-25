/**
 * WORLD RADIO GLOBE — Gerenciador do Globo CesiumJS (globe.js)
 * Arquitetura de GIS / Renderização 3D em WGS84
 * Fase 4: Correção de Basemap (Camadas Globais Visíveis), Clustering, Efeito 4D (Tempo Solar 1x-1000x)
 */

class GlobeManager {
  constructor(containerId = 'cesiumContainer') {
    this.containerId = containerId;
    this.viewer = null;
    this.scene = null;
    this.camera = null;
    this.clock = null;
    this.ellipsoid = Cesium.Ellipsoid.WGS84;
    this.lightingEnabled = true;
    this.markersDataSource = null;
    this.clusteringEnabled = localStorage.getItem('wrg_station_clustering') !== 'false';

    // Camadas base independentes e sem necessidade de token
    this.currentBasemap = 'dark';
    this.basemapLayers = [];

    // Cache de Canvases para Marcadores e Clusters
    this.normalPinCanvas = null;
    this.activePinCanvas = null;
    this.clusterCanvasCache = new Map();

    // Referência da estação atualmente ativa e sua animação de onda
    this.activeStationId = null;
    this.activeStationWaveEntity = null;
    this.activeStationWaveEntityOuter = null;
    this.currentFlightArcEntity = null;
    this.renderedStationsMap = new Map();

    // Callbacks de eventos
    this.onTelemetryUpdate = null;
    this.onStationSelect = null;
    this.onHoverStation = null;
    this.onHoverCluster = null;
    this.onHoverOut = null;
    this.onViewChange = null;
    this.onTimeTick = null;

    this.init();
  }

  /**
   * Inicializa o Viewer do CesiumJS com iluminação, atmosfera e controles
   */
  init() {
    this.setupIonToken();

    // Gera as texturas de pins sci-fi em memória (HiDPI / Retina-ready)
    this.generateMarkerTextures();

    // CORREÇÃO CRÍTICA DO BASEMAP (Cesium 1.119+):
    // Definir 'baseLayer: false' impede que o Cesium tente carregar Ion World Imagery sem token (o que causava o globo azul sem mapa)
    this.viewer = new Cesium.Viewer(this.containerId, {
      baseLayer: false,
      baseLayerPicker: false,
      geocoder: false,
      homeButton: false,
      infoBox: false,
      sceneModePicker: false,
      selectionIndicator: false,
      timeline: false,
      animation: false,
      navigationHelpButton: false,
      fullscreenButton: false,
      scene3DOnly: true
    });

    this.scene = this.viewer.scene;
    this.camera = this.viewer.camera;
    this.clock = this.viewer.clock;

    // Carrega a camada de mapa do planeta Terra
    this.setBasemap('dark');

    // Configuração de Atmosfera, Céu e Iluminação Solar Dinâmica
    this.configureAtmosphereAndLighting();

    // Configuração do Relógio de Simulação 4D (Tempo Solar)
    this.setupSimulationClock();

    // Fonte de Dados para Marcadores de Estações com Clustering Ativo
    this.markersDataSource = new Cesium.CustomDataSource('radioStations');
    this.viewer.dataSources.add(this.markersDataSource);
    this.setupClustering();

    // Handlers de Interação do Mouse (Telemetria, Hover e Cliques)
    this.setupMouseEvents();

    // Notificador de movimentação da câmera (para carregamento sob demanda)
    this.setupCameraListeners();

    // Visão Inicial do Globo (Visão Global Centralizada)
    this.resetView(0);

    console.log('[GlobeManager] Globo WGS84 inicializado com mapa e suporte 4D.');
  }

  /**
   * Configura o Cesium Ion Access Token
   */
  setupIonToken() {
    const savedToken = localStorage.getItem('cesium_ion_token');
    if (savedToken && savedToken.trim().length > 10) {
      Cesium.Ion.defaultAccessToken = savedToken.trim();
    } else {
      Cesium.Ion.defaultAccessToken = '';
    }
  }

  /**
   * Define a camada cartográfica base do globo (Garante que o mapa NUNCA fique azul/vazio)
   * @param {'dark'|'streets'|'satellite'|'osm'} type
   */
  setBasemap(type = 'dark') {
    this.currentBasemap = type;
    this.viewer.imageryLayers.removeAll();

    let baseProvider;

    switch (type) {
      case 'satellite':
        // Satélite Real de Alta Resolução (ESRI World Imagery) - Fotografia orbital da Terra
        baseProvider = new Cesium.UrlTemplateImageryProvider({
          url: 'https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
          credit: 'Sources: Esri, DigitalGlobe, GeoEye, i-cubed, USDA FSA, USGS, AEX, Getmapping, Aerogrid, IGN, IGP, swisstopo, and the GIS User Community'
        });
        break;

      case 'osm':
        // OpenStreetMap Padrão Aberto
        baseProvider = new Cesium.UrlTemplateImageryProvider({
          url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
          credit: '© OpenStreetMap contributors'
        });
        break;

      case 'streets':
        // Ruas e referências geográficas do Esri World Street Map
        baseProvider = new Cesium.UrlTemplateImageryProvider({
          url: 'https://services.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}',
          credit: 'Sources: Esri, TomTom, Garmin, FAO, NOAA, USGS, © OpenStreetMap contributors, and the GIS User Community'
        });
        break;

      case 'dark':
      default:
        // Dark Canvas Profissional (ESRI Dark Gray Base) - Alta fidelidade e contraste sci-fi
        baseProvider = new Cesium.UrlTemplateImageryProvider({
          url: 'https://services.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}',
          credit: '© Esri, HERE, Garmin, © OpenStreetMap contributors'
        });
        break;
    }

    const baseLayer = this.viewer.imageryLayers.addImageryProvider(baseProvider);

    // Se for modo Dark Canvas, adiciona a camada superior de contornos e rótulos de países
    if (type === 'dark') {
      const labelsProvider = new Cesium.UrlTemplateImageryProvider({
        url: 'https://services.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Reference/MapServer/tile/{z}/{y}/{x}'
      });
      this.viewer.imageryLayers.addImageryProvider(labelsProvider);
    }

    this.scene?.requestRender?.();
    console.log(`[GlobeManager] Camada cartográfica configurada: ${type}`);
    return type;
  }

  /**
   * Alterna entre as camadas disponíveis
   */
  cycleBasemap() {
    const sequence = ['dark', 'streets', 'satellite', 'osm'];
    const nextIndex = (sequence.indexOf(this.currentBasemap) + 1) % sequence.length;
    this.setBasemap(sequence[nextIndex]);
    return sequence[nextIndex];
  }

  /**
   * Define atmosfera, estrelas de fundo e iluminação dia/noite
   */
  configureAtmosphereAndLighting() {
    const globe = this.scene.globe;

    globe.enableLighting = this.lightingEnabled;
    globe.showGroundAtmosphere = true;
    globe.depthTestAgainstTerrain = false;

    if (this.scene.skyAtmosphere) {
      this.scene.skyAtmosphere.show = true;
    }
    if (this.scene.skyBox) {
      this.scene.skyBox.show = true;
    }

    // Brilho da atmosfera ajustado para visual espacial imersivo
    this.scene.globe.atmosphereLightIntensity = 2.4;
    this.scene.globe.atmosphereRayleighCoefficient = new Cesium.Cartesian3(5.5e-6, 13.0e-6, 28.4e-6);

    this.scene.screenSpaceCameraController.inertiaSpin = 0.85;
    this.scene.screenSpaceCameraController.inertiaTranslate = 0.85;
    this.scene.screenSpaceCameraController.inertiaZoom = 0.8;
    this.scene.screenSpaceCameraController.minimumZoomDistance = 80;
    this.scene.screenSpaceCameraController.maximumZoomDistance = 45000000;
  }

  /**
   * Configuração do Relógio de Simulação 4D (Cesium Clock)
   */
  setupSimulationClock() {
    const now = new Date();
    const startTime = Cesium.JulianDate.fromDate(now);
    const stopTime = Cesium.JulianDate.addDays(startTime, 365, new Cesium.JulianDate());

    this.clock.startTime = startTime;
    this.clock.stopTime = stopTime;
    this.clock.currentTime = startTime;
    this.clock.clockRange = Cesium.ClockRange.UNBOUNDED;
    this.clock.multiplier = 1.0;
    this.clock.shouldAnimate = true;

    // Dispara listener para atualização contínua dos relógios da interface
    this.clock.onTick.addEventListener((clock) => {
      if (typeof this.onTimeTick === 'function') {
        const jsDate = Cesium.JulianDate.toDate(clock.currentTime);
        this.onTimeTick(jsDate, clock.multiplier, clock.shouldAnimate);
      }
    });
  }

  /**
   * Define a velocidade da simulação temporal (1x, 10x, 100x, 1000x, etc.)
   * @param {number} multiplier 
   */
  setTimeMultiplier(multiplier) {
    this.clock.multiplier = parseFloat(multiplier) || 1.0;
  }

  /**
   * Alterna reprodução/pausa da passagem do tempo no globo
   * @returns {boolean}
   */
  toggleTimePlay() {
    this.clock.shouldAnimate = !this.clock.shouldAnimate;
    return this.clock.shouldAnimate;
  }

  /**
   * Sincroniza a simulação com a hora real atual da máquina
   */
  syncRealTime() {
    this.clock.currentTime = Cesium.JulianDate.fromDate(new Date());
    this.clock.multiplier = 1.0;
    this.clock.shouldAnimate = true;
  }

  /**
   * Salta o tempo (para frente ou para trás) em horas
   * @param {number} hours 
   */
  advanceTimeHours(hours) {
    const current = this.clock.currentTime;
    this.clock.currentTime = Cesium.JulianDate.addSeconds(current, hours * 3600, new Cesium.JulianDate());
  }

  /**
   * Gera os bitmaps/canvases dinâmicos dos marcadores holográficos
   */
  generateMarkerTextures() {
    // Pinos vetoriais HiDPI com núcleo, anel de sintonia e haste de localização.
    const pinCanvas = document.createElement('canvas');
    pinCanvas.width = 96;
    pinCanvas.height = 96;
    const ctx = pinCanvas.getContext('2d');
    const paintPin = (context, x, y, color, active = false) => {
      context.shadowColor = color;
      context.shadowBlur = active ? 22 : 15;
      context.strokeStyle = color;
      context.lineWidth = active ? 4 : 3;
      context.beginPath(); context.arc(x, y, active ? 25 : 22, 0, Math.PI * 2); context.stroke();
      context.shadowBlur = 0;
      context.globalAlpha = 0.22;
      context.fillStyle = color;
      context.beginPath(); context.arc(x, y, active ? 19 : 16, 0, Math.PI * 2); context.fill();
      context.globalAlpha = 1;
      context.strokeStyle = 'rgba(255,255,255,.9)'; context.lineWidth = 2;
      context.beginPath(); context.moveTo(x, y + 18); context.lineTo(x, y + 36); context.stroke();
      context.fillStyle = color; context.beginPath(); context.arc(x, y, active ? 8 : 7, 0, Math.PI * 2); context.fill();
      context.fillStyle = '#fff'; context.beginPath(); context.arc(x, y, 3, 0, Math.PI * 2); context.fill();
      context.strokeStyle = color; context.lineWidth = 2;
      context.beginPath(); context.arc(x, y, 35, -2.55, -0.6); context.stroke();
      context.beginPath(); context.arc(x, y, 35, 0.6, 2.55); context.stroke();
    };
    paintPin(ctx, 48, 43, '#5BD8E8');

    this.normalPinCanvas = pinCanvas;

    // Estação tocando recebe aro âmbar pulsante e mais contraste.
    const activeCanvas = document.createElement('canvas');
    activeCanvas.width = 96;
    activeCanvas.height = 96;
    const actx = activeCanvas.getContext('2d');
    paintPin(actx, 48, 43, '#F59E0B', true);

    this.activePinCanvas = activeCanvas;
  }

  /**
   * Gera ou recupera do cache o Canvas estilizado para um Cluster de estações
   */
  getClusterCanvas(count) {
    let bucket = count;
    if (count > 99) bucket = '100+';

    if (this.clusterCanvasCache.has(bucket)) {
      return this.clusterCanvasCache.get(bucket);
    }

    const canvas = document.createElement('canvas');
    canvas.width = 54;
    canvas.height = 54;
    const ctx = canvas.getContext('2d');
    const cx = 27;
    const cy = 27;

    const glow = ctx.createRadialGradient(cx, cy, 10, cx, cy, 26);
    glow.addColorStop(0, 'rgba(91, 216, 232, 0.45)');
    glow.addColorStop(1, 'rgba(91, 216, 232, 0)');
    ctx.fillStyle = glow;
    ctx.beginPath();
    ctx.arc(cx, cy, 26, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = 'rgba(7, 38, 52, 0.96)';
    ctx.beginPath();
    ctx.arc(cx, cy, 19, 0, Math.PI * 2);
    ctx.fill();

    ctx.strokeStyle = '#7FF4FF';
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.arc(cx, cy, 19, 0, Math.PI * 2);
    ctx.stroke();

    ctx.strokeStyle = 'rgba(91, 216, 232, 0.5)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(cx, cy, 23, -0.4, 0.4);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(cx, cy, 23, Math.PI - 0.4, Math.PI + 0.4);
    ctx.stroke();

    ctx.fillStyle = '#FFFFFF';
    ctx.font = 'bold 12px "Chakra Petch", "JetBrains Mono", sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(bucket.toString(), cx, cy);

    this.clusterCanvasCache.set(bucket, canvas);
    return canvas;
  }

  /**
   * Configura o agrupamento dinâmico (Clustering) de marcadores
   */
  setupClustering() {
    const clustering = this.markersDataSource.clustering;
    clustering.enabled = this.clusteringEnabled;
    clustering.pixelRange = 48;
    clustering.minimumClusterSize = 3;

    clustering.clusterEvent.addEventListener((clusteredEntities, cluster) => {
      cluster.label.show = false;
      cluster.billboard.show = true;
      cluster.billboard.id = {
        isCluster: true,
        count: clusteredEntities.length,
        entities: clusteredEntities
      };
      cluster.billboard.image = this.getClusterCanvas(clusteredEntities.length);
      cluster.billboard.verticalOrigin = Cesium.VerticalOrigin.CENTER;
      cluster.billboard.horizontalOrigin = Cesium.HorizontalOrigin.CENTER;
      cluster.billboard.width = 46;
      cluster.billboard.height = 46;
    });
  }

  setClusteringEnabled(enabled) {
    this.clusteringEnabled = Boolean(enabled);
    this.markersDataSource.clustering.enabled = this.clusteringEnabled;
    return this.clusteringEnabled;
  }

  /**
   * Atualiza a lista de estações renderizadas no globo
   */
  setStations(stations = []) {
    if (!Array.isArray(stations)) return;

    // Hundreds of city hubs plus nearby radios can exceed mobile GPU limits.
    // Keep every hub and a recent/priority sample of radio pins on the globe.
    const renderLimit = 5000;
    const cityHubs = stations.filter(station => station?.isDialsCityHub);
    const radioStations = stations.filter(station => station && !station.isDialsCityHub);
    if (stations.length > renderLimit) {
      stations = [
        ...radioStations.slice(-Math.max(0, renderLimit - cityHubs.length)),
        ...cityHubs.slice(-renderLimit)
      ];
    }

    this.markersDataSource.entities.removeAll();
    this.renderedStationsMap.clear();

    stations.forEach(station => {
      if (!station || typeof station.lat !== 'number' || typeof station.lon !== 'number') return;

      const isCurrentActive = (station.id === this.activeStationId);

      const entity = this.markersDataSource.entities.add({
        id: `station_${station.id}`,
        name: station.name,
        position: Cesium.Cartesian3.fromDegrees(station.lon, station.lat, 20),
        billboard: {
          image: isCurrentActive ? this.activePinCanvas : this.normalPinCanvas,
          verticalOrigin: Cesium.VerticalOrigin.CENTER,
          horizontalOrigin: Cesium.HorizontalOrigin.CENTER,
          width: isCurrentActive ? 50 : 42,
          height: isCurrentActive ? 50 : 42,
          scale: isCurrentActive ? new Cesium.CallbackProperty(() => 1.04 + 0.08 * Math.sin(Date.now() / 260), false) : 1,
          scaleByDistance: new Cesium.NearFarScalar(800, 1.3, 2.2e7, 0.42),
          distanceDisplayCondition: new Cesium.DistanceDisplayCondition(0, 4.5e7)
        }
      });

      entity.stationData = station;
      this.renderedStationsMap.set(station.id, entity);
    });

    if (this.activeStationId) {
      const activeEntity = this.renderedStationsMap.get(this.activeStationId);
      if (activeEntity && activeEntity.stationData) {
        this.updateRadioWaveRing(activeEntity.stationData);
      }
    }
  }

  /**
   * Define uma estação como ativa/tocando e gera ondas de rádio em 3D no globo
   */
  setActiveStation(station) {
    if (!station) return;

    if (this.activeStationId && this.renderedStationsMap.has(this.activeStationId)) {
      const prev = this.renderedStationsMap.get(this.activeStationId);
      if (prev && prev.billboard) {
        prev.billboard.image = this.normalPinCanvas;
        prev.billboard.width = 42;
        prev.billboard.height = 42;
        prev.billboard.scale = 1;
      }
    }

    this.activeStationId = station.id;

    if (this.renderedStationsMap.has(station.id)) {
      const cur = this.renderedStationsMap.get(station.id);
      if (cur && cur.billboard) {
        cur.billboard.image = this.activePinCanvas;
        cur.billboard.width = 50;
        cur.billboard.height = 50;
        cur.billboard.scale = new Cesium.CallbackProperty(() => 1.04 + 0.08 * Math.sin(Date.now() / 260), false);
      }
    }

    this.updateRadioWaveRing(station);
  }

  /**
   * Cria ondas de rádio concêntricas animadas que pulsam e expandem na curvatura WGS84
   */
  updateRadioWaveRing(station) {
    if (this.activeStationWaveEntity) {
      this.viewer.entities.remove(this.activeStationWaveEntity);
      this.activeStationWaveEntity = null;
    }
    if (this.activeStationWaveEntityOuter) {
      this.viewer.entities.remove(this.activeStationWaveEntityOuter);
      this.activeStationWaveEntityOuter = null;
    }

    if (!station || typeof station.lat !== 'number' || typeof station.lon !== 'number') return;

    const startTime = Date.now();
    const maxRadius = 140000;
    const minRadius = 10000;
    const pulseDuration = 2000;

    // Onda Primária (Interna)
    this.activeStationWaveEntity = this.viewer.entities.add({
      position: Cesium.Cartesian3.fromDegrees(station.lon, station.lat, 10),
      ellipse: {
        semiMinorAxis: new Cesium.CallbackProperty(() => {
          const elapsed = (Date.now() - startTime) % pulseDuration;
          const progress = elapsed / pulseDuration;
          return minRadius + (maxRadius - minRadius) * progress;
        }, false),
        semiMajorAxis: new Cesium.CallbackProperty(() => {
          const elapsed = (Date.now() - startTime) % pulseDuration;
          const progress = elapsed / pulseDuration;
          return minRadius + (maxRadius - minRadius) * progress;
        }, false),
        material: new Cesium.ColorMaterialProperty(
          new Cesium.CallbackProperty(() => {
            const elapsed = (Date.now() - startTime) % pulseDuration;
            const progress = elapsed / pulseDuration;
            const alpha = Math.max(0, 0.7 * (1 - progress));
            return Cesium.Color.fromCssColorString('#5BD8E8').withAlpha(alpha);
          }, false)
        ),
        outline: true,
        outlineColor: new Cesium.CallbackProperty(() => {
          const elapsed = (Date.now() - startTime) % pulseDuration;
          const progress = elapsed / pulseDuration;
          const alpha = Math.max(0, 0.9 * (1 - progress));
          return Cesium.Color.fromCssColorString('#5BD8E8').withAlpha(alpha);
        }, false),
        outlineWidth: 2,
        height: 15
      }
    });

    // Onda Secundária (Defasada em 1s para efeito contínuo de transmissão)
    this.activeStationWaveEntityOuter = this.viewer.entities.add({
      position: Cesium.Cartesian3.fromDegrees(station.lon, station.lat, 10),
      ellipse: {
        semiMinorAxis: new Cesium.CallbackProperty(() => {
          const elapsed = (Date.now() - startTime + pulseDuration / 2) % pulseDuration;
          const progress = elapsed / pulseDuration;
          return minRadius + (maxRadius - minRadius) * progress;
        }, false),
        semiMajorAxis: new Cesium.CallbackProperty(() => {
          const elapsed = (Date.now() - startTime + pulseDuration / 2) % pulseDuration;
          const progress = elapsed / pulseDuration;
          return minRadius + (maxRadius - minRadius) * progress;
        }, false),
        material: new Cesium.ColorMaterialProperty(
          new Cesium.CallbackProperty(() => {
            const elapsed = (Date.now() - startTime + pulseDuration / 2) % pulseDuration;
            const progress = elapsed / pulseDuration;
            const alpha = Math.max(0, 0.45 * (1 - progress));
            return Cesium.Color.fromCssColorString('#00D4FF').withAlpha(alpha);
          }, false)
        ),
        outline: true,
        outlineColor: new Cesium.CallbackProperty(() => {
          const elapsed = (Date.now() - startTime + pulseDuration / 2) % pulseDuration;
          const progress = elapsed / pulseDuration;
          const alpha = Math.max(0, 0.65 * (1 - progress));
          return Cesium.Color.fromCssColorString('#00D4FF').withAlpha(alpha);
        }, false),
        outlineWidth: 1.5,
        height: 15
      }
    });
  }

  /**
   * Traça uma linha de voo orbital com elevação parabólica 3D entre duas estações
   */
  drawFlightArc(fromLat, fromLon, toLat, toLon, durationSeconds = 3) {
    if (typeof fromLat !== 'number' || typeof fromLon !== 'number' ||
        typeof toLat !== 'number' || typeof toLon !== 'number') return null;

    if (this.currentFlightArcEntity) {
      this.viewer.entities.remove(this.currentFlightArcEntity);
      this.currentFlightArcEntity = null;
    }

    try {
      const points = [];
      const numSteps = 40;
      const startCarto = Cesium.Cartographic.fromDegrees(fromLon, fromLat);
      const endCarto = Cesium.Cartographic.fromDegrees(toLon, toLat);
      const geodesic = new Cesium.EllipsoidGeodesic(startCarto, endCarto, this.ellipsoid);
      const totalDist = geodesic.surfaceDistance;
      const maxAltitude = Math.min(Math.max(totalDist * 0.22, 120000), 2200000);

      for (let i = 0; i <= numSteps; i++) {
        const fraction = i / numSteps;
        const interp = geodesic.interpolateUsingFraction(fraction, new Cesium.Cartographic());
        const altitude = Math.sin(fraction * Math.PI) * maxAltitude + 25000;
        points.push(Cesium.Cartesian3.fromRadians(interp.longitude, interp.latitude, altitude));
      }

      this.currentFlightArcEntity = this.viewer.entities.add({
        polyline: {
          positions: points,
          width: 3.5,
          material: new Cesium.PolylineGlowMaterialProperty({
            glowPower: 0.35,
            color: Cesium.Color.fromCssColorString('#5BD8E8')
          })
        }
      });

      setTimeout(() => {
        if (this.currentFlightArcEntity) {
          this.viewer.entities.remove(this.currentFlightArcEntity);
          this.currentFlightArcEntity = null;
        }
      }, (durationSeconds + 1.5) * 1000);
    } catch (e) {
      console.warn('[GlobeManager] Falha ao desenhar arco de voo:', e);
    }
  }

  /**
   * Monitora a posição do mouse, disparando telemetria, tooltips no hover e cliques
   */
  setupMouseEvents() {
    const handler = new Cesium.ScreenSpaceEventHandler(this.scene.canvas);

    handler.setInputAction((movement) => {
      const ray = this.camera.getPickRay(movement.endPosition);
      const cartesian = this.scene.globe.pick(ray, this.scene);

      let lat = null;
      let lon = null;
      if (cartesian) {
        const cartographic = this.ellipsoid.cartesianToCartographic(cartesian);
        lat = Cesium.Math.toDegrees(cartographic.latitude);
        lon = Cesium.Math.toDegrees(cartographic.longitude);
      }

      const cameraHeight = this.camera.positionCartographic.height;

      if (typeof this.onTelemetryUpdate === 'function') {
        this.onTelemetryUpdate({ lat, lon, altitude: cameraHeight });
      }

      const picked = this.scene.pick(movement.endPosition);
      if (Cesium.defined(picked) && picked.id) {
        if (picked.id.stationData) {
          this.scene.canvas.style.cursor = 'pointer';
          if (typeof this.onHoverStation === 'function') {
            this.onHoverStation(picked.id.stationData, movement.endPosition);
          }
          return;
        }

        if (picked.id.isCluster) {
          this.scene.canvas.style.cursor = 'pointer';
          if (typeof this.onHoverCluster === 'function') {
            this.onHoverCluster(picked.id.count, movement.endPosition);
          }
          return;
        }
      }

      this.scene.canvas.style.cursor = 'default';
      if (typeof this.onHoverOut === 'function') {
        this.onHoverOut();
      }
    }, Cesium.ScreenSpaceEventType.MOUSE_MOVE);

    handler.setInputAction((click) => {
      const picked = this.scene.pick(click.position);
      if (!Cesium.defined(picked) || !picked.id) return;

      if (picked.id.stationData) {
        if (typeof this.onStationSelect === 'function') {
          this.onStationSelect(picked.id.stationData);
        }
        return;
      }

      if (picked.id.isCluster) {
        const ray = this.camera.getPickRay(click.position);
        const targetCartesian = this.scene.globe.pick(ray, this.scene);
        if (targetCartesian) {
          const currentHeight = this.camera.positionCartographic.height;
          const targetHeight = Math.max(currentHeight * 0.45, 350000);
          const carto = this.ellipsoid.cartesianToCartographic(targetCartesian);

          this.flyTo(
            Cesium.Math.toDegrees(carto.latitude),
            Cesium.Math.toDegrees(carto.longitude),
            targetHeight,
            1.8
          );
        }
      }
    }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
  }

  setupCameraListeners() {
    this.camera.moveEnd.addEventListener(() => {
      if (typeof this.onViewChange !== 'function') return;

      const rect = this.camera.computeViewRectangle(this.scene.globe.ellipsoid);
      const altitude = this.camera.positionCartographic.height;

      if (rect) {
        this.onViewChange({
          west: Cesium.Math.toDegrees(rect.west),
          south: Cesium.Math.toDegrees(rect.south),
          east: Cesium.Math.toDegrees(rect.east),
          north: Cesium.Math.toDegrees(rect.north),
          altitude
        });
      }
    });
  }

  toggleLighting() {
    this.lightingEnabled = !this.lightingEnabled;
    this.scene.globe.enableLighting = this.lightingEnabled;
    return this.lightingEnabled;
  }

  flyTo(latitude, longitude, altitudeMetros = 3200000, durationSegundos = 2.5) {
    if (typeof latitude !== 'number' || typeof longitude !== 'number') return;

    this.camera.flyTo({
      destination: Cesium.Cartesian3.fromDegrees(longitude, latitude, altitudeMetros),
      orientation: {
        heading: Cesium.Math.toRadians(0),
        pitch: Cesium.Math.toRadians(-82),
        roll: 0.0
      },
      duration: durationSegundos,
      easingFunction: Cesium.EasingFunction.QUADRATIC_IN_OUT
    });
  }

  zoomIn() {
    const height = this.camera.positionCartographic.height;
    this.camera.zoomIn(Math.max(40, Math.min(height * 0.48, height - 80)));
  }

  zoomOut() {
    this.camera.zoomOut(Math.max(100, this.camera.positionCartographic.height * 0.58));
  }

  resetView(duration = 2) {
    this.camera.flyTo({
      destination: Cesium.Cartesian3.fromDegrees(-30.0, 10.0, 22000000),
      orientation: {
        heading: Cesium.Math.toRadians(0),
        pitch: Cesium.Math.toRadians(-90),
        roll: 0.0
      },
      duration: duration,
      easingFunction: Cesium.EasingFunction.QUADRATIC_IN_OUT
    });
  }

  setIonToken(token) {
    if (token) {
      localStorage.setItem('cesium_ion_token', token.trim());
      Cesium.Ion.defaultAccessToken = token.trim();
    } else {
      localStorage.removeItem('cesium_ion_token');
      Cesium.Ion.defaultAccessToken = '';
    }
    window.location.reload();
  }

  applyDarkBasemap() {
    this.setBasemap('dark');
  }
}
