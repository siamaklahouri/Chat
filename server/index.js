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
app.set('trust proxy', true);

app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: false }));

app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    users: store.countUsers(),
    maxImageBytes: MAX_IMAGE_BYTES,
    cleanup: wipeStatus(),
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
