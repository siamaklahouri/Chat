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

router.get('/users', (req, res) => {
  const status = clean(req.query.status);
  const users = store.listUsers(VALID_STATUS.has(status) ? { status } : {}).map(withPresence);
  res.json({ users, stats: store.stats() });
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
  res.json({ user: withPresence(store.publicUser(store.getUserById(id))) });
});

router.post('/users/:id/password', (req, res) => {
  const id = Number(req.params.id);
  const password = typeof req.body.password === 'string' ? req.body.password : '';
  if (password.length < 6) return fail(res, 400, 'رمز عبور باید حداقل ۶ نویسه باشد.');
  if (!store.getUserById(id)) return fail(res, 404, 'کاربر پیدا نشد.');

  store.setUserPassword(id, password);
  hub.disconnectUser(id);
  res.json({ ok: true });
});

router.delete('/users/:id', (req, res) => {
  const id = Number(req.params.id);
  const target = store.getUserById(id);
  if (!target) return fail(res, 404, 'کاربر پیدا نشد.');
  if (target.id === req.user.id) return fail(res, 400, 'حساب خودتان را نمی‌توانید حذف کنید.');
  if (target.is_admin) return fail(res, 400, 'ابتدا دسترسی مدیریت این کاربر را بردارید.');

  hub.disconnectUser(id);
  store.deleteUser(id);
  res.json({ ok: true });
});

router.post('/cleanup/run', (req, res) => {
  const result = wipeMessages('manual');
  hub.broadcastAll({ type: 'data:wiped', at: result.at });
  res.json({ result, cleanup: wipeStatus() });
});

module.exports = router;
