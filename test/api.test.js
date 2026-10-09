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
// تماس صوتی فقط وقتی فعال است که TURN تنظیم شده باشد؛ برای آزمون روشنش می‌کنیم.
process.env.TURN_HOST = 'turn.example.test';
process.env.TURN_SECRET = 'secret-for-tests';

const { server } = require('../server/index.js');
const WebSocket = require('ws');

let base;
const context = {};

test.before(async () => {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => {
  // سوکت‌های باز نگه‌داشته‌شده مانع بسته شدن سرور و پایان آزمون می‌شوند.
  for (const socket of [...(context.sockets || []), ...(context.callSockets || [])]) {
    try {
      socket.close();
    } catch {
      /* already closed */
    }
  }
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

test('نخستین کاربر به‌صورت خودکار مدیر و تاییدشده است', async () => {
  const res = await call('/api/auth/register', {
    method: 'POST',
    body: { username: 'admin', displayName: 'مدیر', password: 'secret1234' },
  });
  assert.equal(res.status, 201);
  assert.equal(res.body.user.isAdmin, true);
  assert.equal(res.body.user.status, 'approved');
  context.adminToken = res.body.token;
});

test('کاربر تازه در انتظار تایید می‌ماند و نمی‌تواند وارد شود', async () => {
  const register = await call('/api/auth/register', {
    method: 'POST',
    body: { username: 'sara', displayName: 'سارا', password: 'secret1234' },
  });
  assert.equal(register.status, 202);
  assert.equal(register.body.pending, true);
  context.saraId = register.body.user.id;

  const login = await call('/api/auth/login', {
    method: 'POST',
    body: { username: 'sara', password: 'secret1234' },
  });
  assert.equal(login.status, 403);
  assert.equal(login.body.code, 'pending');
});

test('رمز کوتاه و نام کاربری تکراری رد می‌شوند', async () => {
  const short = await call('/api/auth/register', {
    method: 'POST',
    body: { username: 'reza', displayName: 'رضا', password: '1234567' },
  });
  assert.equal(short.status, 400);

  const duplicate = await call('/api/auth/register', {
    method: 'POST',
    body: { username: 'sara', displayName: 'سارا', password: 'secret1234' },
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
    body: { username: 'sara', password: 'secret1234' },
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
    body: { username: 'sara' },
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

test('پیام صوتی ذخیره و پخش می‌شود', async () => {
  // سرآیند WebM — همان چیزی که MediaRecorder در کروم و اندروید می‌سازد
  const webm = Buffer.concat([
    Buffer.from([0x1a, 0x45, 0xdf, 0xa3]),
    Buffer.alloc(64, 0x11),
  ]);
  const form = new FormData();
  form.append('voice', new Blob([webm], { type: 'audio/webm' }), 'voice');
  form.append('durationMs', '4200');

  const res = await fetch(`${base}/api/conversations/${context.conversationId}/voice`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${context.adminToken}` },
    body: form,
  });
  const data = await res.json();
  assert.equal(res.status, 201);
  assert.equal(data.message.kind, 'voice');
  assert.equal(data.message.attachment.mime, 'audio/webm');
  assert.equal(data.message.attachment.durationMs, 4200);
  context.voiceMessageId = data.message.id;

  const file = await fetch(`${base}/api/files/${data.message.id}`, {
    headers: { Authorization: `Bearer ${context.adminToken}` },
  });
  assert.equal(file.status, 200);
  assert.equal(file.headers.get('content-type'), 'audio/webm');
});

test('مدت پیام صوتی به سقف محدود می‌شود و فایل نامعتبر رد می‌شود', async () => {
  const webm = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(32, 0x22)]);

  // ادعای مدت ده ساعته باید به سقف پنج دقیقه بریده شود
  const long = new FormData();
  long.append('voice', new Blob([webm], { type: 'audio/webm' }), 'voice');
  long.append('durationMs', String(10 * 60 * 60 * 1000));
  const longRes = await fetch(`${base}/api/conversations/${context.conversationId}/voice`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${context.adminToken}` },
    body: long,
  });
  const longData = await longRes.json();
  assert.equal(longData.message.attachment.durationMs, 5 * 60 * 1000);

  // چیزی که صدا نیست پذیرفته نمی‌شود، حتی با Content-Type درست
  const fake = new FormData();
  fake.append('voice', new Blob([Buffer.from('not audio at all')], { type: 'audio/webm' }), 'v');
  const fakeRes = await fetch(`${base}/api/conversations/${context.conversationId}/voice`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${context.adminToken}` },
    body: fake,
  });
  assert.equal(fakeRes.status, 400);
});

test('پیام صوتی قابل ویرایش نیست', async () => {
  const res = await call(`/api/messages/${context.voiceMessageId}`, {
    method: 'PATCH',
    token: context.adminToken,
    body: { body: 'متن جعلی' },
  });
  assert.equal(res.status, 400);
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
    body: { username: 'ali', displayName: 'علی', password: 'secret1234' },
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
    body: { username: 'ali', password: 'secret1234' },
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

test('امنیت: توکن نشست دیگر در نشانی فایل کار نمی‌کند', async () => {
  const form = new FormData();
  form.append('image', new Blob([pngBuffer(6, 6)], { type: 'image/png' }), 'secret.png');
  const upload = await fetch(`${base}/api/conversations/${context.conversationId}/images`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${context.adminToken}` },
    body: form,
  });
  const { message } = await upload.json();

  // توکن نشست در کوئری: دیگر پذیرفته نمی‌شود
  const withSession = await fetch(
    `${base}/api/files/${message.id}?token=${encodeURIComponent(context.adminToken)}`
  );
  assert.equal(withSession.status, 401, 'توکن نشست نباید از طریق URL کار کند');

  // توکن مخصوص فایل: کار می‌کند
  const me = await call('/api/me', { token: context.adminToken });
  assert.ok(me.body.fileToken, 'سرور باید توکن فایل بدهد');
  const withFileToken = await fetch(
    `${base}/api/files/${message.id}?t=${encodeURIComponent(me.body.fileToken)}`
  );
  assert.equal(withFileToken.status, 200);

  // توکن دستکاری‌شده رد می‌شود
  const tampered = me.body.fileToken.slice(0, -1) + (me.body.fileToken.endsWith('a') ? 'b' : 'a');
  const forged = await fetch(`${base}/api/files/${message.id}?t=${encodeURIComponent(tampered)}`);
  assert.equal(forged.status, 403, 'امضای دستکاری‌شده باید رد شود');

  // توکن فایلِ یک کاربر، به فایل گفتگویی که عضوش نیست دسترسی نمی‌دهد
  const aliMe = await call('/api/me', { token: context.aliToken });
  const outsider = await fetch(
    `${base}/api/files/${message.id}?t=${encodeURIComponent(aliMe.body.fileToken)}`
  );
  assert.equal(outsider.status, 403, 'عضو نبودن در گفتگو باید جلوی دسترسی را بگیرد');
});

test('امنیت: شناسه‌ی عددی کاربر، راه دور زدن جستجوی دقیق نیست', async () => {
  // پیش از این با فرستادن userId می‌شد با شمردن ۱، ۲، ۳… همه‌ی کاربران را پیدا کرد.
  const byNumericId = await call('/api/conversations/direct', {
    method: 'POST',
    token: context.aliToken,
    body: { userId: 1 },
  });
  assert.equal(byNumericId.status, 400, 'شناسه‌ی عددی نباید پذیرفته شود');

  const unknown = await call('/api/conversations/direct', {
    method: 'POST',
    token: context.aliToken,
    body: { username: 'nobody_here' },
  });
  assert.equal(unknown.status, 404);
});

test('امنیت: تلاش‌های پیاپی برای حدس رمز مسدود می‌شود', async () => {
  let blockedAt = 0;
  for (let attempt = 1; attempt <= 25; attempt += 1) {
    const res = await call('/api/auth/login', {
      method: 'POST',
      body: { username: 'admin', password: `wrong-${attempt}` },
    });
    if (res.status === 429) {
      blockedAt = attempt;
      break;
    }
    assert.equal(res.status, 401);
  }
  assert.ok(blockedAt > 0 && blockedAt <= 21, `باید مسدود می‌شد، شد در تلاش ${blockedAt}`);
});

test('امنیت: هدرهای محافظ روی پاسخ‌ها ست شده‌اند', async () => {
  const res = await fetch(`${base}/`);
  const csp = res.headers.get('content-security-policy') || '';
  assert.match(csp, /default-src 'self'/);
  assert.match(csp, /script-src 'self'/);
  assert.match(csp, /frame-ancestors 'none'/);
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(res.headers.get('x-frame-options'), 'DENY');
  assert.equal(res.headers.get('x-powered-by'), null);
});

test('امنیت: مسیر سلامت هیچ آماری لو نمی‌دهد', async () => {
  const res = await call('/api/health');
  assert.equal(res.status, 200);
  assert.equal(res.body.users, undefined, 'تعداد کاربران نباید عمومی باشد');
  assert.equal(res.body.cleanup.lastWipeAt, undefined);
});

test('امنیت: عکس با هدرهایی سرو می‌شود که اجرای محتوا را ممنوع کند', async () => {
  const form = new FormData();
  form.append('image', new Blob([pngBuffer(4, 4)], { type: 'image/png' }), 'x.png');
  const upload = await fetch(`${base}/api/conversations/${context.conversationId}/images`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${context.adminToken}` },
    body: form,
  });
  const { message } = await upload.json();

  const file = await fetch(`${base}/api/files/${message.id}`, {
    headers: { Authorization: `Bearer ${context.adminToken}` },
  });
  assert.equal(file.status, 200);
  assert.equal(file.headers.get('x-content-type-options'), 'nosniff');
  assert.match(file.headers.get('content-security-policy') || '', /default-src 'none'/);
});

test('پاکسازی خودکار به‌صورت پیش‌فرض خاموش است', async () => {
  const { setMeta } = require('../server/db.js');
  const { runIfDue, wipeStatus } = require('../server/cleanup.js');

  await call(`/api/conversations/${context.conversationId}/messages`, {
    method: 'POST',
    token: context.adminToken,
    body: { body: 'پیام ماندگار' },
  });

  setMeta('last_wipe_at', Date.now() - 30 * 24 * 60 * 60 * 1000); // سی روز پیش
  assert.equal(runIfDue(), null, 'با خاموش بودن خودکار نباید چیزی پاک شود');
  assert.equal(wipeStatus().auto, false);
  assert.equal(wipeStatus().nextWipeAt, null);

  const overview = await call('/api/admin/overview', { token: context.adminToken });
  assert.ok(overview.body.stats.messages > 0, 'پیام باید سر جایش باشد');
});

test('با روشن کردن CLEANUP_INTERVAL_DAYS، پاکسازی عقب‌افتاده جبران می‌شود', () => {
  // چون فاصله‌ی پاکسازی هنگام بارگذاری ماژول از محیط خوانده می‌شود،
  // این حالت در یک پروسه‌ی جدا با متغیر محیطی تنظیم‌شده بررسی می‌شود.
  const { execFileSync } = require('node:child_process');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cleanup-auto-'));
  const script = `
    const { db, setMeta } = require(${JSON.stringify(path.resolve(__dirname, '../server/db.js'))});
    const { runIfDue, wipeStatus } = require(${JSON.stringify(path.resolve(__dirname, '../server/cleanup.js'))});
    const now = Date.now();
    db.prepare("INSERT INTO conversations (type, title, avatar_color, created_at) VALUES ('group','گ','#fff',?)").run(now);
    db.prepare("INSERT INTO messages (conversation_id, sender_id, kind, body, created_at) VALUES (1, NULL, 'text', 'x', ?)").run(now);
    setMeta('last_wipe_at', now - 3 * 24 * 60 * 60 * 1000);
    const result = runIfDue();
    console.log(JSON.stringify({
      reason: result && result.reason,
      wiped: result && result.messages,
      auto: wipeStatus().auto,
      remaining: db.prepare('SELECT COUNT(*) AS c FROM messages').get().c,
    }));
  `;
  const out = execFileSync(process.execPath, ['-e', script], {
    env: {
      ...process.env,
      CLEANUP_INTERVAL_DAYS: '1',
      DATA_DIR: dir,
      DB_FILE: path.join(dir, 'auto.db'),
      UPLOAD_DIR: path.join(dir, 'uploads'),
    },
    encoding: 'utf8',
  });

  const info = JSON.parse(out.trim().split('\n').pop());
  fs.rmSync(dir, { recursive: true, force: true });

  assert.equal(info.auto, true);
  assert.equal(info.reason, 'scheduled');
  assert.equal(info.wiped, 1);
  assert.equal(info.remaining, 0);
});

test('حذف گفتگو فقط برای همان کاربر انجام می‌شود', async () => {
  // گفتگوی تازه بین مدیر و علی تا به بقیه‌ی آزمون‌ها دست نخورد
  const created = await call('/api/conversations/direct', {
    method: 'POST',
    token: context.adminToken,
    body: { username: 'ali' },
  });
  const convId = created.body.conversation.id;

  for (const text of ['پیام یک', 'پیام دو']) {
    await call(`/api/conversations/${convId}/messages`, {
      method: 'POST',
      token: context.adminToken,
      body: { body: text },
    });
  }

  const beforeDelete = await call(`/api/conversations/${convId}/messages`, { token: context.aliToken });
  assert.equal(beforeDelete.body.messages.length, 2);

  const removed = await call(`/api/conversations/${convId}`, { method: 'DELETE', token: context.aliToken });
  assert.equal(removed.status, 200);

  // از فهرست و تاریخچه‌ی علی رفته است
  const aliList = await call('/api/conversations', { token: context.aliToken });
  assert.ok(!aliList.body.conversations.some((c) => c.id === convId), 'نباید در فهرست علی باشد');
  const aliMessages = await call(`/api/conversations/${convId}/messages`, { token: context.aliToken });
  assert.equal(aliMessages.body.messages.length, 0);

  // ولی مدیر نسخه‌ی خودش را کامل دارد
  const adminList = await call('/api/conversations', { token: context.adminToken });
  assert.ok(adminList.body.conversations.some((c) => c.id === convId), 'باید در فهرست مدیر بماند');
  const adminMessages = await call(`/api/conversations/${convId}/messages`, { token: context.adminToken });
  assert.equal(adminMessages.body.messages.length, 2);

  // با پیام تازه، گفتگو برای علی برمی‌گردد — ولی فقط با پیام‌های تازه
  await call(`/api/conversations/${convId}/messages`, {
    method: 'POST',
    token: context.adminToken,
    body: { body: 'پیام سوم' },
  });
  const back = await call('/api/conversations', { token: context.aliToken });
  const revived = back.body.conversations.find((c) => c.id === convId);
  assert.ok(revived, 'با پیام تازه باید برگردد');
  assert.equal(revived.unread, 1);
  const aliAfter = await call(`/api/conversations/${convId}/messages`, { token: context.aliToken });
  assert.equal(aliAfter.body.messages.length, 1);
  assert.equal(aliAfter.body.messages[0].body, 'پیام سوم');
});

test('تغییر رمز: رمز فعلی اشتباه رد می‌شود و رمز درست نشست تازه می‌دهد', async () => {
  // آزمون مسدودسازی، نشست‌های این کاربر را باطل کرده بود؛ یک نشست تازه می‌گیریم.
  const relogin = await call('/api/auth/login', {
    method: 'POST',
    body: { username: 'sara', password: 'secret1234' },
  });
  assert.equal(relogin.status, 200);
  context.saraToken = relogin.body.token;

  const wrong = await call('/api/me/password', {
    method: 'POST',
    token: context.saraToken,
    body: { currentPassword: 'not-the-password', newPassword: 'brandNew1234' },
  });
  assert.equal(wrong.status, 403);

  const short = await call('/api/me/password', {
    method: 'POST',
    token: context.saraToken,
    body: { currentPassword: 'secret1234', newPassword: '1234567' },
  });
  assert.equal(short.status, 400);

  const ok = await call('/api/me/password', {
    method: 'POST',
    token: context.saraToken,
    body: { currentPassword: 'secret1234', newPassword: 'brandNew1234' },
  });
  assert.equal(ok.status, 200);
  assert.ok(ok.body.token, 'باید نشست تازه بدهد');

  // نشست قدیمی باطل شده (یعنی دستگاه‌های دیگر بیرون افتاده‌اند)
  const oldSession = await call('/api/conversations', { token: context.saraToken });
  assert.equal(oldSession.status, 401);

  // نشست تازه کار می‌کند
  const fresh = await call('/api/conversations', { token: ok.body.token });
  assert.equal(fresh.status, 200);

  // ورود با رمز قدیمی دیگر ممکن نیست، با رمز تازه هست
  const oldLogin = await call('/api/auth/login', {
    method: 'POST',
    body: { username: 'sara', password: 'secret1234' },
  });
  assert.equal(oldLogin.status, 401);

  const newLogin = await call('/api/auth/login', {
    method: 'POST',
    body: { username: 'sara', password: 'brandNew1234' },
  });
  assert.equal(newLogin.status, 200);
  context.saraToken = newLogin.body.token;
});

test('کاربر فقط با نام کاربری دقیق پیدا می‌شود، نه با بخشی از آن', async () => {
  const exact = await call('/api/users?q=sara', { token: context.adminToken });
  assert.equal(exact.status, 200);
  assert.equal(exact.body.users.length, 1);
  assert.equal(exact.body.users[0].username, 'sara');

  // با @ هم باید کار کند
  const withAt = await call('/api/users?q=%40sara', { token: context.adminToken });
  assert.equal(withAt.body.users.length, 1);

  for (const q of ['sar', 'ara', 'سارا', 's', '%']) {
    const res = await call(`/api/users?q=${encodeURIComponent(q)}`, { token: context.adminToken });
    assert.equal(res.body.users.length, 0, `«${q}» نباید کسی را لو بدهد`);
  }
});

/* ------------------------------ تماس صوتی ------------------------------ */

test('تنظیمات تماس: اعتبارنامه‌ی TURN موقت و مخصوص همین کاربر است', async () => {
  const res = await call('/api/call/config', { token: context.adminToken });
  assert.equal(res.status, 200);
  assert.equal(res.body.enabled, true);

  const turn = res.body.iceServers.find((s) => String(s.urls).includes('turn:'));
  assert.ok(turn, 'سرور TURN باید در فهرست باشد');

  const [expiresAt, user] = turn.username.split(':');
  assert.match(user, /^u\d+$/);
  assert.ok(Number(expiresAt) > Math.floor(Date.now() / 1000), 'اعتبارنامه نباید منقضی باشد');

  // رمز باید HMAC همان نام کاربری با راز مشترک باشد (همان چیزی که coturn می‌سنجد)
  const expected = require('node:crypto')
    .createHmac('sha1', process.env.TURN_SECRET)
    .update(turn.username)
    .digest('base64');
  assert.equal(turn.credential, expected);

  // بدون نشست، تنظیمات (و راز) اصلاً برگردانده نمی‌شود.
  const anonymous = await call('/api/call/config');
  assert.equal(anonymous.status, 401);
});

test('تماس صوتی: زنگ، پاسخ، سیگنالینگ و ثبت رکورد در گفتگو', async () => {
  // سوکت‌های تازه با توکن‌های فعلی (رمز سارا در آزمون قبلی عوض شده است)
  const adminSocket = await openSocket(context.adminToken);
  const saraSocket = await openSocket(context.saraToken);
  context.callSockets = [adminSocket, saraSocket];

  const ringing = nextEvent(adminSocket, 'call:ringing');
  const incoming = nextEvent(saraSocket, 'call:incoming');
  adminSocket.send(
    JSON.stringify({ type: 'call:invite', conversationId: context.conversationId })
  );

  const ring = await ringing;
  const invite = await incoming;
  assert.equal(ring.callId, invite.callId);
  assert.equal(invite.conversationId, context.conversationId);
  assert.equal(invite.from.username, 'admin');

  // پاسخ گیرنده باید به تماس‌گیرنده برسد
  const accepted = nextEvent(adminSocket, 'call:accepted');
  saraSocket.send(JSON.stringify({ type: 'call:accept', callId: invite.callId }));
  assert.equal((await accepted).callId, invite.callId);

  // سیگنال WebRTC عیناً به طرف مقابل منتقل می‌شود
  const relayed = nextEvent(saraSocket, 'call:signal');
  adminSocket.send(
    JSON.stringify({
      type: 'call:signal',
      callId: invite.callId,
      data: { sdp: { type: 'offer', sdp: 'v=0' } },
    })
  );
  assert.deepEqual((await relayed).data, { sdp: { type: 'offer', sdp: 'v=0' } });

  // پایان تماس: رکوردش باید در گفتگو ثبت شود
  const record = nextEvent(saraSocket, 'message:new');
  const ended = nextEvent(saraSocket, 'call:ended');
  adminSocket.send(JSON.stringify({ type: 'call:end', callId: invite.callId }));
  assert.equal((await ended).reason, 'hangup');

  const message = (await record).message;
  assert.equal(message.kind, 'call');
  assert.equal(message.body, 'ended');
  assert.ok(message.durationMs >= 0);
});

test('تماس تصویری: نوع تماس به طرف مقابل و به رکورد گفتگو می‌رسد', async () => {
  const [adminSocket, saraSocket] = context.callSockets;

  const incoming = nextEvent(saraSocket, 'call:incoming');
  const ringing = nextEvent(adminSocket, 'call:ringing');
  adminSocket.send(
    JSON.stringify({ type: 'call:invite', conversationId: context.conversationId, video: true })
  );

  const invite = await incoming;
  assert.equal(invite.video, true, 'گیرنده باید بداند تماس تصویری است');
  assert.equal((await ringing).video, true);

  // رد کردن تماس تصویری باید رکوردِ «تصویری» بسازد، نه صوتی
  const record = nextEvent(adminSocket, 'message:new');
  saraSocket.send(JSON.stringify({ type: 'call:decline', callId: invite.callId }));
  assert.equal((await record).message.body, 'video-declined');
});

test('تماس صوتی: فقط طرف‌های همان تماس می‌توانند سیگنال بفرستند', async () => {
  const [adminSocket, saraSocket] = context.callSockets;

  // «علی» نه عضو این گفتگو است و نه طرف تماس
  const outsiderSocket = await openSocket(context.aliToken);

  const incoming = nextEvent(saraSocket, 'call:incoming');
  adminSocket.send(
    JSON.stringify({ type: 'call:invite', conversationId: context.conversationId })
  );
  const { callId } = await incoming;

  // نفر سوم شناسه‌ی تماس را حدس زده: باید رد شود، نه رله
  const refused = nextEvent(outsiderSocket, 'call:error');
  outsiderSocket.send(JSON.stringify({ type: 'call:signal', callId, data: { sdp: 'x' } }));
  assert.equal((await refused).reason, 'forbidden');

  // و تماس‌گیرنده نمی‌تواند به‌جای گیرنده تماس را «جواب» بدهد
  const notAllowed = nextEvent(adminSocket, 'call:error');
  adminSocket.send(JSON.stringify({ type: 'call:accept', callId }));
  assert.equal((await notAllowed).reason, 'forbidden');

  const declined = nextEvent(adminSocket, 'call:ended');
  saraSocket.send(JSON.stringify({ type: 'call:decline', callId }));
  assert.equal((await declined).reason, 'declined');

  outsiderSocket.close();
});

test('تماس صوتی: در گفتگوی گروهی تماس گرفته نمی‌شود', async () => {
  const [adminSocket] = context.callSockets;
  const sara = require('../server/store.js').getUserByUsername('sara');
  const group = await call('/api/conversations/group', {
    method: 'POST',
    token: context.adminToken,
    body: { title: 'گروه آزمون تماس', memberIds: [sara.id] },
  });
  assert.equal(group.status, 201);

  const refused = nextEvent(adminSocket, 'call:error');
  adminSocket.send(
    JSON.stringify({ type: 'call:invite', conversationId: group.body.conversation.id })
  );
  assert.equal((await refused).reason, 'not-direct');
});
