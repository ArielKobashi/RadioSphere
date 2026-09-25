/**
 * WORLD RADIO GLOBE — Service Worker (sw.js)
 * Estratégia de cache offline para App Shell PWA e navegação resiliente.
 */

const CACHE_NAME = 'wrg-shell-v4';
const APP_SHELL_ASSETS = [
  './',
  './index.html',
  './manifest.json',
  './css/style.css',
  './css/globe.css',
  './css/player.css',
  './css/responsive.css',
  './css/visual.css',
  './js/utils.js',
  './js/config.js',
  './js/state.js',
  './js/globe.js',
  './js/radioApi.js',
  './js/search.js',
  './js/player.js',
  './js/audioVisualizer.js',
  './js/shazamRecognition.js',
  './js/metadataManager.js',
  './js/app.js'
];

// Instalação: Pré-carrega o App Shell
self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      console.log('[SW] Pré-carregando App Shell no cache...');
      return cache.addAll(APP_SHELL_ASSETS).catch((err) => {
        console.warn('[SW] Aviso ao pré-carregar recursos do shell:', err);
      });
    })
  );
});

// Ativação: Limpa versões anteriores de cache
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.map((key) => {
          if (key !== CACHE_NAME) {
            console.log('[SW] Removendo cache obsoleto:', key);
            return caches.delete(key);
          }
        })
      );
    }).then(() => self.clients.claim())
  );
});

// Interceptação de requisições
self.addEventListener('fetch', (event) => {
  const request = event.request;
  const url = new URL(request.url);

  // 1. Ignora streams de áudio contínuos e métodos não-GET (evita sobrecarga de cache)
  if (request.method !== 'GET') return;
  if (url.pathname.startsWith('/api/')) return;
  if (request.destination === 'audio' || url.pathname.endsWith('.mp3') || url.pathname.endsWith('.aac')) {
    return;
  }

  // 2. APIs dinâmicas (Radio Browser, Nominatim, Geocoding): Network First com timeout
  const isApi = url.hostname.includes('radio-browser.info') || 
                url.hostname.includes('openstreetmap.org') ||
                url.hostname.includes('arcgisonline.com');

  if (isApi) {
    event.respondWith(
      fetch(request).catch(() => {
        return caches.match(request);
      })
    );
    return;
  }

  // 3. App Shell e recursos locais: Stale-While-Revalidate
  event.respondWith(
    caches.match(request).then((cachedResponse) => {
      const fetchPromise = fetch(request).then((networkResponse) => {
        if (networkResponse && networkResponse.status === 200 && networkResponse.type === 'basic') {
          const responseToCache = networkResponse.clone();
          caches.open(CACHE_NAME).then((cache) => {
            cache.put(request, responseToCache);
          });
        }
        return networkResponse;
      }).catch(() => {
        // Se a rede falhar e for navegação de página, retorna index.html do cache
        if (request.mode === 'navigate') {
          return caches.match('./index.html');
        }
      });

      return cachedResponse || fetchPromise;
    })
  );
});
