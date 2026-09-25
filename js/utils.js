/**
 * WORLD RADIO GLOBE — Utilitários Gerais (utils.js)
 */

const Utils = {
  escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, character => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    })[character]);
  },
  /**
   * Exibe notificação temporária (Toast) na UI
   * @param {string} message Texto da notificação
   * @param {'info'|'success'|'error'} type Tipo de toast
   * @param {number} duration Duração em milissegundos
   */
  showToast(message, type = 'info', duration = 3500) {
    const container = document.getElementById('toastContainer');
    if (!container) return;

    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.textContent = message;

    container.appendChild(toast);

    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transform = 'translateX(20px)';
      toast.style.transition = 'all 0.25s ease';
      setTimeout(() => toast.remove(), 260);
    }, duration);
  },

  /**
   * Formata relógio digital com dois dígitos
   * @param {number} num 
   * @returns {string}
   */
  padZero(num) {
    return num.toString().padStart(2, '0');
  },

  /**
   * Formata coordenadas geográficas para exibição amigável
   * @param {number} lat Latitude
   * @param {number} lon Longitude
   * @returns {string}
   */
  formatCoords(lat, lon) {
    if (typeof lat !== 'number' || typeof lon !== 'number') return 'LAT: --.----° | LON: --.----°';
    const latDir = lat >= 0 ? 'N' : 'S';
    const lonDir = lon >= 0 ? 'E' : 'W';
    return `LAT: ${Math.abs(lat).toFixed(4)}° ${latDir} | LON: ${Math.abs(lon).toFixed(4)}° ${lonDir}`;
  },

  /**
   * Formata altitude em metros para km legíveis
   * @param {number} altitudeMetros 
   * @returns {string}
   */
  formatAltitude(altitudeMetros) {
    if (!altitudeMetros && altitudeMetros !== 0) return '-- km';
    if (altitudeMetros >= 1000) {
      return `${(altitudeMetros / 1000).toLocaleString('pt-BR', { maximumFractionDigits: 0 })} km`;
    }
    return `${Math.round(altitudeMetros)} m`;
  },

  /**
   * Calcula a distância entre dois pontos geográficos em quilômetros (Fórmula de Haversine)
   * @param {number} lat1 
   * @param {number} lon1 
   * @param {number} lat2 
   * @param {number} lon2 
   * @returns {number} Distância em km
   */
  haversineDistance(lat1, lon1, lat2, lon2) {
    const R = 6371; // Raio da Terra em km
    const dLat = (lat2 - lat1) * (Math.PI / 180);
    const dLon = (lon2 - lon1) * (Math.PI / 180);
    const a =
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(lat1 * (Math.PI / 180)) * Math.cos(lat2 * (Math.PI / 180)) *
      Math.sin(dLon / 2) * Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return Math.round(R * c);
  },

  /**
   * Debounce genérico para limitar taxa de execução
   * @param {Function} fn 
   * @param {number} delay 
   * @returns {Function}
   */
  debounce(fn, delay = 300) {
    let timer = null;
    return function (...args) {
      clearTimeout(timer);
      timer = setTimeout(() => fn.apply(this, args), delay);
    };
  },

  /**
   * Wrapper seguro para o LocalStorage com tratamento contra quota/privacidade
   */
  storage: {
    get(key, defaultValue = null) {
      try {
        const item = localStorage.getItem(key);
        return item ? JSON.parse(item) : defaultValue;
      } catch (e) {
        console.warn(`[Utils.storage] Falha ao ler chave "${key}":`, e);
        return defaultValue;
      }
    },
    set(key, value) {
      try {
        localStorage.setItem(key, JSON.stringify(value));
        return true;
      } catch (e) {
        console.warn(`[Utils.storage] Falha ao salvar chave "${key}":`, e);
        return false;
      }
    },
    remove(key) {
      try {
        localStorage.removeItem(key);
      } catch (e) {
        console.warn(`[Utils.storage] Falha ao remover chave "${key}":`, e);
      }
    }
  }
};
