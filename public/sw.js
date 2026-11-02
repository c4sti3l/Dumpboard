importScripts('/db.js', '/api.js');

const CACHE = 'dumpboard-v2';
const SHELL = [
  '/',
  '/index.html',
  '/app.js',
  '/db.js',
  '/api.js',
  '/style.css',
  '/manifest.webmanifest',
  '/icons/icon.svg',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  if (request.method === 'POST' && url.pathname === '/share-target') {
    event.respondWith(handleShare(request));
    return;
  }
  // API und Dateien nie cachen, die gehen immer direkt zum Server.
  if (request.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/api/')) return;

  // App-Shell: Cache zuerst, im Hintergrund aktualisieren (stale-while-revalidate).
  event.respondWith(
    caches.match(request, { ignoreSearch: true }).then((cached) => {
      const network = fetch(request)
        .then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(request, copy));
          }
          return res;
        })
        .catch(() => cached || (request.mode === 'navigate' ? caches.match('/index.html') : Response.error()));
      return cached || network;
    })
  );
});

// Geteiltes Zeug geht direkt zum Server. Klappt das nicht (offline, nicht angemeldet),
// landet es in der lokalen Warteschlange und wird später von der Seite hochgeladen.
async function handleShare(request) {
  let outcome = 'shared=1';
  try {
    const form = await request.formData();
    const str = (key) => String(form.get(key) || '');
    const files = form
      .getAll('files')
      .filter((f) => f instanceof File && (f.size > 0 || f.name))
      .map((f) => ({ name: f.name, type: f.type, size: f.size, blob: f }));
    const item = { createdAt: Date.now(), title: str('title'), text: str('text'), url: str('url'), files };

    try {
      await API.create(item);
    } catch (e) {
      await DB.add(item);
      outcome = e.auth ? 'shared=login' : 'shared=queued';
    }

    const channel = new BroadcastChannel('dumpboard');
    channel.postMessage('changed');
    channel.close();
  } catch (err) {
    console.error('Share-Target fehlgeschlagen', err);
    outcome = 'shared=error';
  }
  return Response.redirect('/?' + outcome, 303);
}
