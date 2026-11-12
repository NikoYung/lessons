// Офлайн: всё приложение кэшируется при установке. При правке файлов поднимай VERSION.
const VERSION = 'v14';
const OCR_CACHE = 'lessons-ocr-7.0.0'; // модуль распознавания — отдельно, чтобы обновления не качали его заново
const CACHE = `lessons-${VERSION}`;

const SHELL = [
  './', 'index.html', 'manifest.webmanifest', 'css/app.css',
  'js/app.js', 'js/db.js', 'js/logic.js', 'js/voice.js', 'js/ocr.js', 'js/media.js',
  'icons/icon-192.png', 'icons/icon-512.png', 'icons/apple-touch-icon.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL.map((u) => new Request(u, { cache: 'reload' })))).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE && k !== OCR_CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

async function cacheFirst(request) {
  const cache = await caches.open(OCR_CACHE);
  const hit = await cache.match(request);
  if (hit) return hit;
  const res = await fetch(request);
  if (res.ok) await cache.put(request, res.clone());
  return res;
}

/** Сначала сеть, чтобы обновления доходили; без сети — кэш. */
async function networkFirst(request) {
  const cache = await caches.open(CACHE);
  try {
    // no-cache: GitHub Pages отдаёт файлы с max-age=600, и без этого телефон мог взять
    // новый app.js со старым voice.js — приложение тогда не запускается.
    const res = await fetch(request.url, { cache: 'no-cache', credentials: 'same-origin' });
    if (res.ok) await cache.put(request, res.clone());
    return res;
  } catch (err) {
    const hit = (await cache.match(request, { ignoreSearch: true })) || (request.mode === 'navigate' && (await cache.match('index.html')));
    if (hit) return hit;
    throw err;
  }
}

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  e.respondWith(url.pathname.includes('/vendor/') ? cacheFirst(e.request) : networkFirst(e.request));
});
