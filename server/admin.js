'use strict';

const express = require('express');
const { requireAdmin } = require('./auth');
const store = require('./store');
const { hub } = require('./realtime');
const { wipeMessages, wipeStatus } = require('./cleanup');

const router = express.Router();
router.use(requireAdmin);

const fail = (res, status, error) => res.status(status).json({ error });
const clean = (value) => (typeof value === 'string' ? value.trim() : '');
const VALID_STATUS = new Set(['pending', 'approved', 'blocked']);

const withPresence = (user) => ({ ...user, online: hub.isOnline(user.id) });

router.get('/overview', (req, res) => {
  res.json({
    stats: store.stats(),
    cleanup: wipeStatus(),
    online: hub.onlineIds().length,
  });
});

const PAGE_SIZE = 25;

router.get('/users', (req, res) => {
  const status = clean(req.query.status);
  const query = clean(req.query.q).slice(0, 60);
  const page = Math.max(1, Number(req.query.page) || 1);

  const { users, total } = store.listUsers({
    status: VALID_STATUS.has(status) ? status : undefined,
    query,
    limit: PAGE_SIZE,
    offset: (page - 1) * PAGE_SIZE,
  });

  res.json({
    users: users.map(withPresence),
    stats: store.stats(),
    page,
    pageSize: PAGE_SIZE,
    total,
    pages: Math.max(1, Math.ceil(total / PAGE_SIZE)),
  });
});

/** گزارش کارهای مدیران: چه کسی چه کاری با چه کسی کرد. */
router.get('/log', (req, res) => {
  res.json({ entries: store.listAdminLog(50) });
});

router.post('/users/:id/status', (req, res) => {
  const id = Number(req.params.id);
  const status = clean(req.body.status);
  if (!VALID_STATUS.has(status)) return fail(res, 400, 'وضعیت نامعتبر است.');

  const target = store.getUserById(id);
  if (!target) return fail(res, 404, 'کاربر پیدا نشد.');
  if (target.id === req.user.id) return fail(res, 400, 'وضعیت حساب خودتان را نمی‌توانید تغییر دهید.');
  if (target.is_admin && status !== 'approved') {
    return fail(res, 400, 'ابتدا دسترسی مدیریت این کاربر را بردارید.');
  }

  const updated = store.setUserStatus(id, status, req.user.id);
  if (status !== 'approved') hub.disconnectUser(id);
  else hub.sendToUser(id, { type: 'me:approved' });
  store.logAdminAction({
    actor: req.user,
    action: { approved: 'تایید کاربر', blocked: 'مسدود کردن', pending: 'بازگرداندن به انتظار' }[status],
    target,
  });

  res.json({ user: withPresence({ ...store.publicUser(updated), createdAt: updated.created_at }) });
});

router.post('/users/:id/admin', (req, res) => {
  const id = Number(req.params.id);
  const makeAdmin = Boolean(req.body.isAdmin);
  const target = store.getUserById(id);
  if (!target) return fail(res, 404, 'کاربر پیدا نشد.');
  if (target.id === req.user.id && !makeAdmin) {
    return fail(res, 400, 'دسترسی مدیریت خودتان را نمی‌توانید بردارید.');
  }
  if (!makeAdmin && store.countAdmins() <= 1) return fail(res, 400, 'حداقل یک مدیر باید باقی بماند.');

  store.db.prepare('UPDATE users SET is_admin = ? WHERE id = ?').run(makeAdmin ? 1 : 0, id);
  if (makeAdmin && target.status !== 'approved') store.setUserStatus(id, 'approved', req.user.id);
  store.logAdminAction({
    actor: req.user,
    action: makeAdmin ? 'مدیر کردن' : 'برداشتن دسترسی مدیریت',
    target,
  });
  res.json({ user: withPresence(store.publicUser(store.getUserById(id))) });
});

router.post('/users/:id/password', (req, res) => {
  const id = Number(req.params.id);
  const password = typeof req.body.password === 'string' ? req.body.password : '';
  if (password.length < 6) return fail(res, 400, 'رمز عبور باید حداقل ۶ نویسه باشد.');
  if (!store.getUserById(id)) return fail(res, 404, 'کاربر پیدا نشد.');

  store.setUserPassword(id, password);
  hub.disconnectUser(id);
  store.logAdminAction({ actor: req.user, action: 'تغییر رمز کاربر', target: store.getUserById(id) });
  res.json({ ok: true });
});

router.delete('/users/:id', (req, res) => {
  const id = Number(req.params.id);
  const target = store.getUserById(id);
  if (!target) return fail(res, 404, 'کاربر پیدا نشد.');
  if (target.id === req.user.id) return fail(res, 400, 'حساب خودتان را نمی‌توانید حذف کنید.');
  if (target.is_admin) return fail(res, 400, 'ابتدا دسترسی مدیریت این کاربر را بردارید.');

  hub.disconnectUser(id);
  // پیش از حذف ثبت می‌شود، وگرنه نام کاربر دیگر در دسترس نیست.
  store.logAdminAction({ actor: req.user, action: 'حذف حساب', target });
  store.deleteUser(id);
  res.json({ ok: true });
});

router.post('/cleanup/run', (req, res) => {
  const result = wipeMessages('manual');
  hub.broadcastAll({ type: 'data:wiped', at: result.at });
  store.logAdminAction({
    actor: req.user,
    action: 'پاکسازی داده‌ها',
    detail: `${result.messages} پیام، ${result.images} عکس`,
  });
  res.json({ result, cleanup: wipeStatus() });
});

module.exports = router;
