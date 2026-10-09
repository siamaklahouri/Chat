'use strict';

const path = require('node:path');
const http = require('node:http');
const express = require('express');

const { router: api, MAX_IMAGE_BYTES } = require('./routes');
const adminRouter = require('./admin');
const { attach } = require('./realtime');
const { startScheduler, wipeStatus } = require('./cleanup');
const { purgeExpiredSessions } = require('./auth');
const store = require('./store');

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

/**
 * نوشته‌ای که پایین ستون گفتگوها به کاربر نشان داده می‌شود.
 * فقط یک اطلاع‌رسانی است و خودش چیزی را پاک نمی‌کند؛ پاکسازی از پنل مدیریت
 * انجام می‌شود. برای عوض کردن متن یا برداشتنش RETENTION_NOTICE را ست کنید
 * (رشته‌ی خالی یعنی چیزی نشان داده نشود).
 */
const RETENTION_NOTICE =
  process.env.RETENTION_NOTICE ?? 'پیام‌ها و عکس‌ها به‌صورت دوره‌ای پاک می‌شوند';

const app = express();
app.disable('x-powered-by');
// فقط به یک پراکسی (nginx روی همین ماشین) اعتماد می‌شود. با `true` هر کلاینتی
// می‌توانست با هدر X-Forwarded-For آی‌پی جعل کند و محدودیت نرخ را دور بزند.
app.set('trust proxy', 1);

app.use(express.json({ limit: '256kb' }));
app.use(express.urlencoded({ extended: false, limit: '64kb' }));

/**
 * هدرهای امنیتی. اینجا ست می‌شوند نه در nginx، تا هر جا برنامه اجرا شود
 * (پشت پراکسی، مستقیم، یا روی شبکه‌ی محلی) همراهش باشند.
 *
 * CSP سخت‌گیرانه است چون برنامه هیچ اسکریپت inline و هیچ منبع بیرونی ندارد؛
 * فقط استایل inline مجاز است که نمی‌تواند کد اجرا کند.
 */
app.use((req, res, next) => {
  res.setHeader(
    'Content-Security-Policy',
    [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob:",
      "font-src 'self'",
      "connect-src 'self' ws: wss:",
      "frame-ancestors 'none'",
      "base-uri 'none'",
      "form-action 'self'",
      "object-src 'none'",
    ].join('; ')
  );
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), payment=(), usb=()');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  next();
});

// عمداً هیچ آماری (مثل تعداد کاربران) برنمی‌گرداند؛ این مسیر عمومی است.
app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    maxImageBytes: MAX_IMAGE_BYTES,
    cleanup: { auto: wipeStatus().auto },
    retentionNotice: RETENTION_NOTICE,
  });
});

app.use('/api/admin', adminRouter);
app.use('/api', api);

app.use(
  express.static(PUBLIC_DIR, {
    setHeaders: (res, filePath) => {
      if (filePath.endsWith('sw.js')) res.setHeader('Cache-Control', 'no-cache');
    },
  })
);

app.get('/admin', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'admin.html')));

// Unknown non-API routes fall back to the single page app.
app.use((req, res, next) => {
  if (req.method !== 'GET' || req.path.startsWith('/api/')) return next();
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

app.use((req, res) => res.status(404).json({ error: 'مسیر پیدا نشد.' }));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err && err.code === 'LIMIT_FILE_SIZE') {
    const mb = Math.round(MAX_IMAGE_BYTES / (1024 * 1024));
    return res.status(413).json({ error: `حجم عکس نباید بیشتر از ${mb} مگابایت باشد.` });
  }
  console.error('[server]', err);
  res.status(500).json({ error: 'خطای داخلی سرور.' });
});

const server = http.createServer(app);
attach(server);

purgeExpiredSessions();
startScheduler();

if (require.main === module) {
  server.listen(PORT, HOST, () => {
    const status = wipeStatus();
    console.log(`9chat روی http://${HOST}:${PORT} اجرا شد`);
    console.log(`پنل مدیریت: http://${HOST}:${PORT}/admin`);
    console.log(
      status.auto
        ? `پاکسازی خودکار هر ${status.intervalDays} روز — بعدی: ${new Date(status.nextWipeAt).toLocaleString('fa-IR')}`
        : 'پاکسازی خودکار خاموش است (فقط دستی از پنل مدیریت)'
    );
    if (store.countUsers() === 0) {
      console.log('هنوز کاربری وجود ندارد — نخستین حساب ثبت‌شده به‌صورت خودکار مدیر می‌شود.');
    }
  });
}

module.exports = { app, server };
