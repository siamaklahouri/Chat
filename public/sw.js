/*
 * سرویس‌ورکر 9chat.
 *
 * راهبرد: «اول شبکه، بعد کش».
 * نسخه‌ی قبلی اول از کش می‌خواند و همین باعث می‌شد به‌روزرسانی‌های برنامه هرگز
 * به کاربری که یک بار سایت را باز کرده بود نرسد. حالا همیشه نسخه‌ی تازه گرفته
 * می‌شود و کش فقط وقتی به کار می‌آید که شبکه در دسترس نباشد.
 */
const CACHE = '9chat-shell-v4';
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
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(SHELL))
      .catch(() => {})
      .then(() => self.skipWaiting())
  );
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

  // API، وب‌سوکت و دامنه‌های دیگر اصلاً از اینجا رد نمی‌شوند.
  if (request.method !== 'GET' || url.origin !== location.origin) return;
  if (url.pathname.startsWith('/api/') || url.pathname === '/ws') return;

  event.respondWith(
    fetch(request)
      .then((response) => {
        if (response.ok) {
          const copy = response.clone();
          caches.open(CACHE).then((cache) => cache.put(request, copy)).catch(() => {});
        }
        return response;
      })
      .catch(async () => {
        // آفلاین: هر چه در کش هست، وگرنه صفحه‌ی اصلی برنامه.
        const cached = await caches.match(request);
        if (cached) return cached;
        if (request.mode === 'navigate') {
          const shell = await caches.match('/index.html');
          if (shell) return shell;
        }
        return Response.error();
      })
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
          client.postMessage({
            type: 'open-conversation',
            conversationId: event.notification.data?.conversationId,
          });
          return client.focus();
        }
      }
      return self.clients.openWindow(target);
    })
  );
});
