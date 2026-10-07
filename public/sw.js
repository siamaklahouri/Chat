/* سرویس‌ورکر — فقط پوسته‌ی برنامه را کش می‌کند تا آفلاین هم باز شود. */
const CACHE = '9chat-shell-v3';
const SHELL = [
  '/',
  '/index.html',
  '/css/style.css',
  '/js/app.js',
  '/manifest.webmanifest',
  '/icons/icon-192.png',
  '/fonts/outfit-600-latin.woff2',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // درخواست‌های API و فایل‌ها هرگز کش نمی‌شوند.
  if (request.method !== 'GET' || url.pathname.startsWith('/api/') || url.pathname === '/ws') return;

  event.respondWith(
    caches.match(request).then(
      (cached) =>
        cached ||
        fetch(request)
          .then((response) => {
            if (response.ok && url.origin === location.origin) {
              const copy = response.clone();
              caches.open(CACHE).then((cache) => cache.put(request, copy));
            }
            return response;
          })
          .catch(() => caches.match('/index.html'))
    )
  );
});

/* کلیک روی اعلان: اگر پنجره‌ی برنامه باز است همان را جلو می‌آورد، وگرنه بازش می‌کند. */
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = event.notification.data?.url || '/';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windows) => {
      for (const client of windows) {
        if ('focus' in client) {
          client.postMessage({ type: 'open-conversation', conversationId: event.notification.data?.conversationId });
          return client.focus();
        }
      }
      return self.clients.openWindow(target);
    })
  );
});
