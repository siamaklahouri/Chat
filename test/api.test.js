'use strict';

/**
 * آزمون سرتاسری: ثبت‌نام، تایید مدیر، گفتگو، ارسال عکس،
 * رویدادهای زنده و پاکسازی هفتگی.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'messenger-test-'));
process.env.DATA_DIR = TMP;
process.env.DB_FILE = path.join(TMP, 'test.db');
process.env.UPLOAD_DIR = path.join(TMP, 'uploads');

const { server } = require('../server/index.js');
const WebSocket = require('ws');

let base;

test.before(async () => {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => {
  server.close();
  fs.rmSync(TMP, { recursive: true, force: true });
});

async function call(path, { method = 'GET', body, token, raw } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body && !raw) headers['Content-Type'] = 'application/json';
  const res = await fetch(base + path, {
    method,
    headers,
    body: raw ? body : body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

/** یک PNG کوچک واقعی می‌سازد تا آپلود، تشخیص فرمت را رد کند. */
function pngBuffer(width = 8, height = 6) {
  const crcTable = [];
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crcTable[n] = c;
  }
  const crc32 = (buf) => {
    let c = 0xffffffff;
    for (const byte of buf) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const raw = Buffer.alloc((width * 4 + 1) * height, 0x40);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const openSocket = (token) =>
  new Promise((resolve, reject) => {
    const socket = new WebSocket(`${base.replace('http', 'ws')}/ws?token=${token}`);
    socket.once('open', () => resolve(socket));
    socket.once('error', reject);
  });

const nextEvent = (socket, type, timeout = 4000) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`رویداد ${type} نرسید`)), timeout);
    const onMessage = (raw) => {
      const event = JSON.parse(raw.toString());
      if (event.type !== type) return;
      clearTimeout(timer);
      socket.off('message', onMessage);
      resolve(event);
    };
    socket.on('message', onMessage);
  });

const context = {};

test('نخستین کاربر به‌صورت خودکار مدیر و تاییدشده است', async () => {
  const res = await call('/api/auth/register', {
    method: 'POST',
    body: { username: 'admin', displayName: 'مدیر', password: 'secret123' },
  });
  assert.equal(res.status, 201);
  assert.equal(res.body.user.isAdmin, true);
  assert.equal(res.body.user.status, 'approved');
  context.adminToken = res.body.token;
});

test('کاربر تازه در انتظار تایید می‌ماند و نمی‌تواند وارد شود', async () => {
  const register = await call('/api/auth/register', {
    method: 'POST',
    body: { username: 'sara', displayName: 'سارا', password: 'secret123' },
  });
  assert.equal(register.status, 202);
  assert.equal(register.body.pending, true);
  context.saraId = register.body.user.id;

  const login = await call('/api/auth/login', {
    method: 'POST',
    body: { username: 'sara', password: 'secret123' },
  });
  assert.equal(login.status, 403);
  assert.equal(login.body.code, 'pending');
});

test('رمز کوتاه و نام کاربری تکراری رد می‌شوند', async () => {
  const short = await call('/api/auth/register', {
    method: 'POST',
    body: { username: 'reza', displayName: 'رضا', password: '123' },
  });
  assert.equal(short.status, 400);

  const duplicate = await call('/api/auth/register', {
    method: 'POST',
    body: { username: 'sara', displayName: 'سارا', password: 'secret123' },
  });
  assert.equal(duplicate.status, 409);
});

test('مدیر کاربر را تایید می‌کند و کاربر وارد می‌شود', async () => {
  const pending = await call('/api/admin/users?status=pending', { token: context.adminToken });
  assert.equal(pending.status, 200);
  assert.equal(pending.body.users.length, 1);

  const approve = await call(`/api/admin/users/${context.saraId}/status`, {
    method: 'POST',
    token: context.adminToken,
    body: { status: 'approved' },
  });
  assert.equal(approve.status, 200);
  assert.equal(approve.body.user.status, 'approved');

  const login = await call('/api/auth/login', {
    method: 'POST',
    body: { username: 'sara', password: 'secret123' },
  });
  assert.equal(login.status, 200);
  context.saraToken = login.body.token;
});

test('کاربر عادی به مسیرهای مدیریتی دسترسی ندارد', async () => {
  const res = await call('/api/admin/users', { token: context.saraToken });
  assert.equal(res.status, 403);
});

test('گفتگوی دوطرفه ساخته می‌شود و پیام متنی زنده می‌رسد', async () => {
  const adminSocket = await openSocket(context.adminToken);
  const saraSocket = await openSocket(context.saraToken);
  context.sockets = [adminSocket, saraSocket];

  const created = await call('/api/conversations/direct', {
    method: 'POST',
    token: context.adminToken,
    body: { userId: context.saraId },
  });
  assert.equal(created.status, 201);
  context.conversationId = created.body.conversation.id;

  const incoming = nextEvent(saraSocket, 'message:new');
  const sent = await call(`/api/conversations/${context.conversationId}/messages`, {
    method: 'POST',
    token: context.adminToken,
    body: { body: 'سلام سارا' },
  });
  assert.equal(sent.status, 201);
  context.firstMessageId = sent.body.message.id;

  const event = await incoming;
  assert.equal(event.message.body, 'سلام سارا');
});

test('ارسال عکس ذخیره و با ابعاد درست پخش می‌شود', async () => {
  const form = new FormData();
  form.append('image', new Blob([pngBuffer(8, 6)], { type: 'image/png' }), 'test.png');
  form.append('caption', 'یک عکس');
  form.append('replyToId', String(context.firstMessageId));

  const incoming = nextEvent(context.sockets[0], 'message:new');
  const res = await fetch(`${base}/api/conversations/${context.conversationId}/images`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${context.saraToken}` },
    body: form,
  });
  const data = await res.json();
  assert.equal(res.status, 201);
  assert.equal(data.message.kind, 'image');
  assert.equal(data.message.attachment.width, 8);
  assert.equal(data.message.attachment.height, 6);
  assert.equal(data.message.replyTo.id, context.firstMessageId);
  context.imageMessageId = data.message.id;
  await incoming;

  const file = await fetch(`${base}/api/files/${data.message.id}`, {
    headers: { Authorization: `Bearer ${context.adminToken}` },
  });
  assert.equal(file.status, 200);
  assert.equal(file.headers.get('content-type'), 'image/png');
  assert.ok((await file.arrayBuffer()).byteLength > 0);
});

test('فایل غیرعکس پذیرفته نمی‌شود', async () => {
  const form = new FormData();
  form.append('image', new Blob([Buffer.from('MZ not-an-image')], { type: 'image/png' }), 'x.png');
  const res = await fetch(`${base}/api/conversations/${context.conversationId}/images`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${context.saraToken}` },
    body: form,
  });
  assert.equal(res.status, 400);
});

test('کاربر بیرونی نه گفتگو را می‌بیند نه فایل را', async () => {
  await call('/api/auth/register', {
    method: 'POST',
    body: { username: 'ali', displayName: 'علی', password: 'secret123' },
  });
  const outsider = await call('/api/admin/users?status=pending', { token: context.adminToken });
  const aliId = outsider.body.users[0].id;
  await call(`/api/admin/users/${aliId}/status`, {
    method: 'POST',
    token: context.adminToken,
    body: { status: 'approved' },
  });
  const login = await call('/api/auth/login', {
    method: 'POST',
    body: { username: 'ali', password: 'secret123' },
  });
  const aliToken = login.body.token;

  const messages = await call(`/api/conversations/${context.conversationId}/messages`, {
    token: aliToken,
  });
  assert.equal(messages.status, 403);

  const file = await call(`/api/files/${context.imageMessageId}`, { token: aliToken });
  assert.equal(file.status, 403);
  context.aliToken = aliToken;
  context.aliId = aliId;
});

test('ویرایش و حذف فقط برای فرستنده‌ی پیام مجاز است', async () => {
  const forbidden = await call(`/api/messages/${context.firstMessageId}`, {
    method: 'PATCH',
    token: context.saraToken,
    body: { body: 'دستکاری' },
  });
  assert.equal(forbidden.status, 403);

  const edited = await call(`/api/messages/${context.firstMessageId}`, {
    method: 'PATCH',
    token: context.adminToken,
    body: { body: 'سلام سارا جان' },
  });
  assert.equal(edited.status, 200);
  assert.equal(edited.body.message.body, 'سلام سارا جان');
  assert.ok(edited.body.message.editedAt);

  const deleted = await call(`/api/messages/${context.firstMessageId}`, {
    method: 'DELETE',
    token: context.adminToken,
  });
  assert.equal(deleted.status, 200);
  assert.equal(deleted.body.message.deleted, true);
});

test('شمارنده‌ی خوانده‌نشده و علامت خواندن کار می‌کند', async () => {
  await call(`/api/conversations/${context.conversationId}/messages`, {
    method: 'POST',
    token: context.adminToken,
    body: { body: 'پیام خوانده‌نشده' },
  });

  const before = await call('/api/conversations', { token: context.saraToken });
  const conv = before.body.conversations.find((c) => c.id === context.conversationId);
  assert.ok(conv.unread > 0);

  await call(`/api/conversations/${context.conversationId}/read`, {
    method: 'POST',
    token: context.saraToken,
    body: { messageId: conv.lastMessage.id },
  });

  const after = await call('/api/conversations', { token: context.saraToken });
  assert.equal(after.body.conversations.find((c) => c.id === context.conversationId).unread, 0);
});

test('گروه ساخته می‌شود و عضو تازه رویداد دریافت می‌کند', async () => {
  const incoming = nextEvent(context.sockets[1], 'conversation:new');
  const res = await call('/api/conversations/group', {
    method: 'POST',
    token: context.adminToken,
    body: { title: 'تیم ما', memberIds: [context.saraId, context.aliId] },
  });
  assert.equal(res.status, 201);
  assert.equal(res.body.conversation.memberCount, 3);
  const event = await incoming;
  assert.equal(event.conversation.title, 'تیم ما');

  const left = await call(`/api/conversations/${res.body.conversation.id}/members/me`, {
    method: 'DELETE',
    token: context.aliToken,
  });
  assert.equal(left.status, 200);
});

test('نشانگر «در حال نوشتن» بین دو کاربر رد و بدل می‌شود', async () => {
  const incoming = nextEvent(context.sockets[1], 'typing');
  context.sockets[0].send(
    JSON.stringify({ type: 'typing', conversationId: context.conversationId, isTyping: true })
  );
  const event = await incoming;
  assert.equal(event.isTyping, true);
  assert.equal(event.conversationId, context.conversationId);
});

test('مسدود کردن کاربر، نشست و اتصال زنده‌اش را می‌بندد', async () => {
  const closed = new Promise((resolve) => context.sockets[1].once('close', resolve));
  const res = await call(`/api/admin/users/${context.saraId}/status`, {
    method: 'POST',
    token: context.adminToken,
    body: { status: 'blocked' },
  });
  assert.equal(res.status, 200);
  await closed;

  const denied = await call('/api/conversations', { token: context.saraToken });
  assert.equal(denied.status, 401); // نشست باطل شده است

  await call(`/api/admin/users/${context.saraId}/status`, {
    method: 'POST',
    token: context.adminToken,
    body: { status: 'approved' },
  });
});

test('پاکسازی، پیام‌ها و فایل‌ها را حذف و حساب‌ها را حفظ می‌کند', async () => {
  const uploadsBefore = fs.readdirSync(process.env.UPLOAD_DIR);
  assert.ok(uploadsBefore.length > 0);

  const res = await call('/api/admin/cleanup/run', { method: 'POST', token: context.adminToken });
  assert.equal(res.status, 200);
  assert.ok(res.body.result.messages > 0);

  const overview = await call('/api/admin/overview', { token: context.adminToken });
  assert.equal(overview.body.stats.messages, 0);
  assert.equal(overview.body.stats.images, 0);
  assert.ok(overview.body.stats.users >= 3); // حساب‌ها دست‌نخورده مانده‌اند
  assert.equal(fs.readdirSync(process.env.UPLOAD_DIR).length, 0);

  const conversations = await call('/api/conversations', { token: context.adminToken });
  assert.ok(conversations.body.conversations.length > 0); // گفتگوها باقی می‌مانند
  assert.equal(conversations.body.conversations[0].unread, 0);

  for (const socket of context.sockets) socket.close();
});

test('زمان‌بند، پاکسازی عقب‌افتاده را جبران می‌کند', async () => {
  const { setMeta } = require('../server/db.js');
  const { runIfDue } = require('../server/cleanup.js');

  await call(`/api/conversations/${context.conversationId}/messages`, {
    method: 'POST',
    token: context.adminToken,
    body: { body: 'پیام قدیمی' },
  });

  setMeta('last_wipe_at', Date.now() - 8 * 24 * 60 * 60 * 1000); // هشت روز پیش
  const result = runIfDue();
  assert.ok(result, 'باید پاکسازی انجام می‌شد');
  assert.equal(result.reason, 'scheduled');

  const overview = await call('/api/admin/overview', { token: context.adminToken });
  assert.equal(overview.body.stats.messages, 0);
  assert.ok(overview.body.cleanup.nextWipeAt > Date.now());
});
