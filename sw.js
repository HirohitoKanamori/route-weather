// Route-WX.jp のサービスワーカー（PWA・オフライン用）
// - アプリ本体（index.html、js/、アイコン、FIT SDK）はキャッシュし、index.html と js/ はネットワーク優先で更新を取り込む
// - 予報 API（Open-Meteo・気象庁）はキャッシュしない（アプリ側が localStorage で保持する）
// - 地図タイルはキャッシュ優先（OSM の利用ポリシーに沿った端末内キャッシュ）。上限を超えたら古いものから消す
// vendor/ を更新したら VERSION を上げること
const VERSION = 'rw-v2';
const SHELL = 'shell-' + VERSION, TILES = 'tiles-' + VERSION;
const SHELL_FILES = ['./', './index.html', './js/core.js', './js/app.js', './vendor/leaflet/leaflet.js', './vendor/leaflet/leaflet.css', './manifest.webmanifest', './icons/icon-192.png', './icons/icon-512.png', './icons/apple-touch-icon.png'];
const TILE_MAX = 300;

self.addEventListener('install', e => {
  e.waitUntil(caches.open(SHELL).then(c => c.addAll(SHELL_FILES)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== SHELL && k !== TILES).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const req = e.request; if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin === location.origin) {
    if (req.mode === 'navigate' || url.pathname.endsWith('/index.html') || url.pathname.endsWith('/') || url.pathname.includes('/js/')) { e.respondWith(networkFirst(req, SHELL)); return; }
    if (url.pathname.includes('/vendor/') || url.pathname.includes('/icons/') || url.pathname.endsWith('.webmanifest')) { e.respondWith(cacheFirst(req, SHELL)); return; }
    return; // samples 等はそのまま
  }
  if (url.hostname === 'tile.openstreetmap.org') { e.respondWith(cacheFirst(req, TILES, TILE_MAX)); return; }
  // 予報・気象庁・逆ジオコーディングはネットワークのみ
});
async function networkFirst(req, cacheName) {
  const cache = await caches.open(cacheName);
  try { const res = await fetch(req); if (res && res.ok) cache.put(req, res.clone()); return res; }
  catch (e) { const hit = await cache.match(req, { ignoreSearch: true }); if (hit) return hit; throw e; }
}
async function cacheFirst(req, cacheName, max) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(req); if (hit) return hit;
  const res = await fetch(req);
  if (res && res.ok) { cache.put(req, res.clone()); if (max) trim(cache, max); }
  return res;
}
async function trim(cache, max) {
  const keys = await cache.keys();
  if (keys.length > max) await Promise.all(keys.slice(0, keys.length - max).map(k => cache.delete(k)));
}
