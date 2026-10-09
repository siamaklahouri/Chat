'use strict';

const fs = require('node:fs');
const express = require('express');
const multer = require('multer');
const {
  createSession,
  createFileToken,
  destroySession,
  requireAuth,
  requireApproved,
  userForToken,
  userIdFromFileToken,
  verifyPassword,
  SESSION_TTL_MS,
} = require('./auth');
const store = require('./store');
const { sniff, sniffAudio } = require('./media');
const { hub } = require('./realtime');
const { createLimiter, rateLimit, ipOf } = require('./ratelimit');

const router = express.Router();

const MAX_TEXT = 4000;
const MAX_IMAGE_BYTES = Number(process.env.MAX_IMAGE_BYTES || 8 * 1024 * 1024);
const MAX_VOICE_BYTES = Number(process.env.MAX_VOICE_BYTES || 6 * 1024 * 1024);
const MAX_VOICE_MS = 5 * 60 * 1000;
const USERNAME_RE = /^[a-zA-Z0-9_]{3,24}$/;
const MIN_PASSWORD = 8;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_IMAGE_BYTES, files: 1 },
});

const uploadVoice = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_VOICE_BYTES, files: 1 },
});

const fail = (res, status, error, code) => res.status(status).json({ error, code });

/* ----------------------------- محدودیت نرخ ----------------------------- */

// ورود: هم روی آی‌پی و هم روی نام کاربری شمرده می‌شود تا نه یک آی‌پی بتواند
// روی چند حساب حدس بزند و نه چند آی‌پی روی یک حساب.
const loginByIp = createLimiter({ windowMs: 15 * 60_000, max: 20 });
const loginByUser = createLimiter({ windowMs: 15 * 60_000, max: 10 });

// هش بی‌مصرف برای یکسان کردن زمان پاسخ وقتی نام کاربری وجود ندارد؛ بدون این،
// اختلاف زمانِ پاسخ لو می‌دهد که کدام نام کاربری ثبت شده است.
const DUMMY_HASH = '$2b$10$CwTycUXWue0Thq9StjUM0uJ8e1S1Qk1q0bNCcC1r0A2hQnJ0Vn3Hy';
const clean = (value) => (typeof value === 'string' ? value.trim() : '');
const withPresence = (user) => user && { ...user, online: hub.isOnline(user.id) };

const decorateConversation = (conv) =>
  conv && { ...conv, peer: withPresence(conv.peer), members: conv.members.map(withPresence) };

/** پشت پراکسی HTTPS، کوکی نشست با پرچم Secure فرستاده می‌شود. */
function setSessionCookie(req, res, token) {
  res.cookie('token', token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: req.secure,
    maxAge: SESSION_TTL_MS,
  });
}

/* -------------------------------- auth -------------------------------- */

router.post(
  '/auth/register',
  rateLimit({
    windowMs: 60 * 60_000,
    max: 5,
    scope: 'register',
    message: 'تعداد ثبت‌نام از این دستگاه زیاد است؛ یک ساعت دیگر تلاش کنید.',
  }),
  (req, res) => {
  const username = clean(req.body.username).toLowerCase();
  const displayName = clean(req.body.displayName) || username;
  const password = typeof req.body.password === 'string' ? req.body.password : '';

  if (!USERNAME_RE.test(username)) {
    return fail(res, 400, 'نام کاربری باید ۳ تا ۲۴ نویسه انگلیسی، عدد یا _ باشد.');
  }
  if (password.length < MIN_PASSWORD) {
    return fail(res, 400, `رمز عبور باید حداقل ${MIN_PASSWORD} نویسه باشد.`);
  }
  if (displayName.length > 40) return fail(res, 400, 'نام نمایشی طولانی است.');
  if (store.getUserByUsername(username)) return fail(res, 409, 'این نام کاربری قبلاً ثبت شده است.');

  // The very first account becomes the admin so the panel is reachable out of the box.
  const bootstrapAdmin = store.countUsers() === 0;
  const user = store.createUser({
    username,
    displayName,
    password,
    status: bootstrapAdmin ? 'approved' : 'pending',
    isAdmin: bootstrapAdmin,
  });

  const payload = store.publicUser(user);
  hub.notifyAdmins({ type: 'admin:pending', user: payload });

  if (!bootstrapAdmin) {
    return res.status(202).json({
      user: payload,
      pending: true,
      message: 'ثبت‌نام انجام شد. پس از تایید مدیر می‌توانید وارد شوید.',
    });
  }
  const { token } = createSession(user.id);
  setSessionCookie(req, res, token);
  res.status(201).json({ token, user: payload, pending: false, fileToken: createFileToken(user.id) });
  }
);

router.post('/auth/login', (req, res) => {
  const username = clean(req.body.username).toLowerCase();
  const password = typeof req.body.password === 'string' ? req.body.password : '';

  const ipKey = `login:${ipOf(req)}`;
  const userKey = `login:${username}`;
  const blocked = loginByIp.peek(ipKey).allowed === false || loginByUser.peek(userKey).allowed === false;
  if (blocked) {
    const wait = Math.max(
      loginByIp.peek(ipKey).retryAfterSeconds,
      loginByUser.peek(userKey).retryAfterSeconds
    );
    res.setHeader('Retry-After', String(wait));
    return fail(res, 429, `تلاش‌های ناموفق زیاد است. ${Math.ceil(wait / 60)} دقیقه دیگر دوباره تلاش کنید.`);
  }

  const user = store.getUserByUsername(username);
  // همیشه یک بار bcrypt اجرا می‌شود، حتی وقتی کاربر وجود ندارد، تا زمان پاسخ
  // نشان ندهد کدام نام کاربری ثبت شده است.
  const passwordOk = verifyPassword(password, user ? user.password_hash : DUMMY_HASH);

  if (!user || !passwordOk) {
    loginByIp.fail(ipKey);
    loginByUser.fail(userKey);
    return fail(res, 401, 'نام کاربری یا رمز عبور نادرست است.');
  }
  if (user.status === 'pending') {
    return fail(res, 403, 'حساب شما هنوز توسط مدیر تایید نشده است.', 'pending');
  }
  if (user.status === 'blocked') return fail(res, 403, 'حساب شما مسدود شده است.', 'blocked');

  loginByIp.reset(ipKey);
  loginByUser.reset(userKey);
  store.touchUser(user.id);
  const { token } = createSession(user.id);
  setSessionCookie(req, res, token);
  res.json({ token, user: store.publicUser(user), fileToken: createFileToken(user.id) });
});

router.post('/auth/logout', requireAuth, (req, res) => {
  destroySession(req.token);
  res.clearCookie('token');
  res.json({ ok: true });
});

/* ---------------------------------- me --------------------------------- */

router.get('/me', requireAuth, (req, res) => {
  res.json({ user: store.publicUser(req.user), fileToken: createFileToken(req.user.id) });
});

router.patch('/me', requireApproved, (req, res) => {
  const displayName = clean(req.body.displayName) || req.user.display_name;
  const bio = clean(req.body.bio).slice(0, 200);
  if (displayName.length > 40) return fail(res, 400, 'نام نمایشی طولانی است.');
  const user = store.updateUser(req.user.id, { displayName, bio });
  const payload = store.publicUser(user);
  hub.sendToUser(user.id, { type: 'me:updated', user: payload });
  res.json({ user: payload });
});

router.post(
  '/me/password',
  requireApproved,
  rateLimit({ windowMs: 15 * 60_000, max: 5, scope: 'password', by: 'user' }),
  (req, res) => {
  const currentPassword = typeof req.body.currentPassword === 'string' ? req.body.currentPassword : '';
  const newPassword = typeof req.body.newPassword === 'string' ? req.body.newPassword : '';

  if (!verifyPassword(currentPassword, req.user.password_hash)) {
    return fail(res, 403, 'رمز فعلی درست نیست.');
  }
  if (newPassword.length < MIN_PASSWORD) {
    return fail(res, 400, `رمز تازه باید حداقل ${MIN_PASSWORD} نویسه باشد.`);
  }
  if (newPassword === currentPassword) return fail(res, 400, 'رمز تازه با رمز فعلی یکی است.');

  // تغییر رمز همه‌ی نشست‌ها را باطل می‌کند (یعنی دستگاه‌های دیگر بیرون می‌افتند)،
  // پس برای همین دستگاه یک نشست تازه می‌سازیم تا کاربر بیرون پرت نشود.
  store.setUserPassword(req.user.id, newPassword);
  const { token } = createSession(req.user.id);
  setSessionCookie(req, res, token);
  res.json({ token, message: 'رمز عبور عوض شد. دستگاه‌های دیگر باید دوباره وارد شوند.' });
  }
);

router.get(
  '/users',
  requireApproved,
  rateLimit({ windowMs: 60_000, max: 30, scope: 'lookup', by: 'user' }),
  (req, res) => {
  // فقط تطبیق دقیقِ نام کاربری؛ هر ورودی‌ای که شکل نام کاربری ندارد، نتیجه‌ی خالی می‌دهد.
  const handle = clean(req.query.q).replace(/^@/, '');
  if (!USERNAME_RE.test(handle)) return res.json({ users: [] });
  res.json({ users: store.findUserByHandle(handle, req.user.id).map(withPresence) });
  }
);

/* ----------------------------- conversations ---------------------------- */

router.get('/conversations', requireApproved, (req, res) => {
  res.json({ conversations: store.listConversations(req.user.id).map(decorateConversation) });
});

/**
 * گفتگوی تازه با «نام کاربری» ساخته می‌شود، نه شناسه‌ی عددی.
 *
 * پیش از این شناسه‌ی عددی پذیرفته می‌شد و همین اجازه می‌داد کسی با شمردن
 * ۱، ۲، ۳… همه‌ی کاربران را پیدا کند — یعنی قانون «فقط با شناسه‌ی دقیق» عملاً
 * دور زده می‌شد.
 */
router.post(
  '/conversations/direct',
  requireApproved,
  rateLimit({ windowMs: 60 * 60_000, max: 30, scope: 'direct', by: 'user' }),
  (req, res) => {
  const handle = clean(req.body.username).replace(/^@/, '');
  if (!USERNAME_RE.test(handle)) return fail(res, 400, 'نام کاربری نامعتبر است.');

  const target = store.getUserByUsername(handle);
  if (!target || target.status !== 'approved' || target.id === req.user.id) {
    return fail(res, 404, 'کاربر پیدا نشد.');
  }
  const userId = target.id;

  const { conversation, created } = store.getOrCreateDirect(req.user.id, userId);
  if (created) {
    hub.sendToUser(userId, {
      type: 'conversation:new',
      conversation: decorateConversation(store.conversationView(conversation.id, userId)),
    });
  }
  res.status(created ? 201 : 200).json({
    conversation: decorateConversation(store.conversationView(conversation.id, req.user.id)),
  });
  }
);

router.post('/conversations/group', requireApproved, (req, res) => {
  const title = clean(req.body.title);
  if (!title || title.length > 60) return fail(res, 400, 'نام گروه باید بین ۱ تا ۶۰ نویسه باشد.');

  const memberIds = Array.isArray(req.body.memberIds)
    ? [...new Set(req.body.memberIds.map(Number).filter((id) => Number.isInteger(id) && id !== req.user.id))]
    : [];
  if (memberIds.length === 0) return fail(res, 400, 'حداقل یک عضو انتخاب کنید.');
  for (const id of memberIds) {
    const member = store.getUserById(id);
    if (!member || member.status !== 'approved') return fail(res, 404, 'کاربر پیدا نشد.');
  }

  const conv = store.createGroup({ title, creatorId: req.user.id, memberIds });
  store.createMessage({
    conversationId: conv.id,
    senderId: req.user.id,
    kind: 'system',
    body: `${req.user.display_name} گروه «${title}» را ساخت.`,
  });
  for (const id of memberIds) {
    hub.sendToUser(id, {
      type: 'conversation:new',
      conversation: decorateConversation(store.conversationView(conv.id, id)),
    });
  }
  res.status(201).json({
    conversation: decorateConversation(store.conversationView(conv.id, req.user.id)),
  });
});

/** Loads the conversation id and rejects non-members. */
function memberGuard(req, res, next) {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || !store.getConversationRow(id)) return fail(res, 404, 'گفتگو پیدا نشد.');
  if (!store.isMember(id, req.user.id)) return fail(res, 403, 'به این گفتگو دسترسی ندارید.');
  req.conversationId = id;
  next();
}

router.get('/conversations/:id', requireApproved, memberGuard, (req, res) => {
  res.json({
    conversation: decorateConversation(store.conversationView(req.conversationId, req.user.id)),
  });
});

router.get('/conversations/:id/messages', requireApproved, memberGuard, (req, res) => {
  const before = req.query.before ? Number(req.query.before) : null;
  const limit = Math.min(Math.max(Number(req.query.limit) || 40, 1), 100);
  const messages = store.listMessages(req.conversationId, {
    before: Number.isInteger(before) ? before : null,
    limit,
    viewerId: req.user.id,
  });
  res.json({ messages, hasMore: messages.length === limit });
});

function resolveReplyTo(value, conversationId) {
  if (value == null || value === '') return { ok: true, id: null };
  const target = store.rawMessage(Number(value));
  if (!target || target.conversation_id !== conversationId) return { ok: false };
  return { ok: true, id: target.id };
}

router.post(
  '/conversations/:id/messages',
  requireApproved,
  rateLimit({ windowMs: 60_000, max: 90, scope: 'send', by: 'user', message: 'سرعت ارسال پیام زیاد است.' }),
  memberGuard,
  (req, res) => {
  const body = clean(req.body.body);
  if (!body) return fail(res, 400, 'متن پیام خالی است.');
  if (body.length > MAX_TEXT) return fail(res, 400, 'پیام بیش از حد طولانی است.');

  const reply = resolveReplyTo(req.body.replyToId, req.conversationId);
  if (!reply.ok) return fail(res, 400, 'پیام مرجع نامعتبر است.');

  const message = store.createMessage({
    conversationId: req.conversationId,
    senderId: req.user.id,
    body,
    replyToId: reply.id,
  });
  store.markRead(req.conversationId, req.user.id, message.id);
  hub.sendToConversation(req.conversationId, { type: 'message:new', message });
  res.status(201).json({ message, clientId: req.body.clientId ?? null });
  }
);

/* -------------------------------- images ------------------------------- */

router.post(
  '/conversations/:id/images',
  requireApproved,
  rateLimit({ windowMs: 10 * 60_000, max: 40, scope: 'upload', by: 'user', message: 'تعداد آپلود عکس زیاد است.' }),
  memberGuard,
  upload.single('image'),
  (req, res) => {
    if (!req.file) return fail(res, 400, 'فایلی دریافت نشد.');

    const info = sniff(req.file.buffer);
    if (!info) return fail(res, 400, 'فقط عکس (JPEG، PNG، GIF یا WebP) پذیرفته می‌شود.');

    const caption = clean(req.body.caption).slice(0, MAX_TEXT);
    const reply = resolveReplyTo(req.body.replyToId, req.conversationId);
    if (!reply.ok) return fail(res, 400, 'پیام مرجع نامعتبر است.');

    const message = store.createMessage({
      conversationId: req.conversationId,
      senderId: req.user.id,
      kind: 'image',
      body: caption,
      replyToId: reply.id,
      file: {
        name: clean(req.file.originalname).slice(0, 120) || `image.${info.ext}`,
        mime: info.mime,
        size: req.file.size,
        width: info.width,
        height: info.height,
      },
    });

    try {
      fs.writeFileSync(store.filePathFor(message.id), req.file.buffer);
    } catch (err) {
      store.deleteMessage(message.id);
      console.error('[upload] ذخیره فایل ناموفق بود:', err);
      return fail(res, 500, 'ذخیره عکس ناموفق بود.');
    }

    store.markRead(req.conversationId, req.user.id, message.id);
    hub.sendToConversation(req.conversationId, { type: 'message:new', message });
    res.status(201).json({ message, clientId: req.body.clientId ?? null });
  }
);

/**
 * اعتبارسنجی مسیر فایل‌ها. اولویت با نشست عادی (هدر یا کوکی) است؛ اگر نبود،
 * توکن کوتاه‌عمر فایل از کوئری پذیرفته می‌شود، چون تگ <img> هدر نمی‌فرستد.
 * توکن نشست دیگر در کوئری پذیرفته نمی‌شود.
 */
function fileAuth(req, res, next) {
  const fileToken = req.query.t;
  if (fileToken) {
    const userId = userIdFromFileToken(String(fileToken));
    const user = userId ? store.getUserById(userId) : null;
    if (user && user.status === 'approved') {
      req.user = user;
      return next();
    }
    return fail(res, 403, 'نشانی فایل منقضی شده است.');
  }
  return requireApproved(req, res, next);
}

/* ------------------------------ پیام صوتی ------------------------------ */

router.post(
  '/conversations/:id/voice',
  requireApproved,
  rateLimit({ windowMs: 10 * 60_000, max: 60, scope: 'voice', by: 'user', message: 'تعداد پیام صوتی زیاد است.' }),
  memberGuard,
  uploadVoice.single('voice'),
  (req, res) => {
    if (!req.file) return fail(res, 400, 'فایلی دریافت نشد.');

    const info = sniffAudio(req.file.buffer);
    if (!info) return fail(res, 400, 'فایل صوتی معتبر نیست.');

    // مدت را کلاینت گزارش می‌کند؛ فقط برای نمایش است، پس محدودش می‌کنیم.
    const durationMs = Math.min(Math.max(Number(req.body.durationMs) || 0, 0), MAX_VOICE_MS);

    const reply = resolveReplyTo(req.body.replyToId, req.conversationId);
    if (!reply.ok) return fail(res, 400, 'پیام مرجع نامعتبر است.');

    const message = store.createMessage({
      conversationId: req.conversationId,
      senderId: req.user.id,
      kind: 'voice',
      body: '',
      replyToId: reply.id,
      file: {
        name: `voice.${info.ext}`,
        mime: info.mime,
        size: req.file.size,
        durationMs,
      },
    });

    try {
      fs.writeFileSync(store.filePathFor(message.id), req.file.buffer);
    } catch (err) {
      store.deleteMessage(message.id);
      console.error('[voice] ذخیره فایل ناموفق بود:', err);
      return fail(res, 500, 'ذخیره پیام صوتی ناموفق بود.');
    }

    store.markRead(req.conversationId, req.user.id, message.id);
    hub.sendToConversation(req.conversationId, { type: 'message:new', message });
    res.status(201).json({ message, clientId: req.body.clientId ?? null });
  }
);

router.get('/files/:id', fileAuth, (req, res) => {
  const row = store.rawMessage(Number(req.params.id));
  const isFile = row && (row.kind === 'image' || row.kind === 'voice');
  if (!isFile || row.deleted_at) return fail(res, 404, 'فایل پیدا نشد.');
  if (!store.isMember(row.conversation_id, req.user.id)) return fail(res, 403, 'دسترسی ندارید.');

  const filePath = store.filePathFor(row.id);
  if (!fs.existsSync(filePath)) return fail(res, 404, 'فایل پاک شده است.');

  res.type(row.file_mime || 'application/octet-stream');
  res.setHeader('Cache-Control', 'private, max-age=86400');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
  if (req.query.download) {
    res.setHeader(
      'Content-Disposition',
      `attachment; filename*=UTF-8''${encodeURIComponent(row.file_name || 'image')}`
    );
  }
  fs.createReadStream(filePath).pipe(res);
});

/* ------------------------- message edit / delete ------------------------ */

router.patch('/messages/:id', requireApproved, (req, res) => {
  const row = store.rawMessage(Number(req.params.id));
  if (!row || row.deleted_at) return fail(res, 404, 'پیام پیدا نشد.');
  if (row.sender_id !== req.user.id) return fail(res, 403, 'فقط پیام خودتان را می‌توانید ویرایش کنید.');

  if (row.kind === 'voice') return fail(res, 400, 'پیام صوتی قابل ویرایش نیست.');
  const body = clean(req.body.body);
  if (row.kind === 'text' && !body) return fail(res, 400, 'متن پیام خالی است.');
  if (body.length > MAX_TEXT) return fail(res, 400, 'پیام بیش از حد طولانی است.');

  const message = store.editMessage(row.id, body);
  hub.sendToConversation(row.conversation_id, { type: 'message:updated', message });
  res.json({ message });
});

router.delete('/messages/:id', requireApproved, (req, res) => {
  const row = store.rawMessage(Number(req.params.id));
  if (!row) return fail(res, 404, 'پیام پیدا نشد.');
  if (row.sender_id !== req.user.id) return fail(res, 403, 'فقط پیام خودتان را می‌توانید حذف کنید.');

  const message = store.deleteMessage(row.id);
  hub.sendToConversation(row.conversation_id, { type: 'message:deleted', message });
  res.json({ message });
});

router.post('/conversations/:id/read', requireApproved, memberGuard, (req, res) => {
  const messageId = Number(req.body.messageId);
  if (!Number.isInteger(messageId)) return fail(res, 400, 'شناسه پیام نامعتبر است.');
  store.markRead(req.conversationId, req.user.id, messageId);
  hub.sendToConversation(
    req.conversationId,
    { type: 'read', conversationId: req.conversationId, userId: req.user.id, messageId },
    req.user.id
  );
  res.json({ ok: true });
});

/* ------------------------------- members -------------------------------- */

/** حذف گفتگو فقط برای همین کاربر؛ نسخه‌ی طرف مقابل دست‌نخورده می‌ماند. */
router.delete('/conversations/:id', requireApproved, memberGuard, (req, res) => {
  const clearedUpToId = store.clearConversationFor(req.conversationId, req.user.id);
  hub.sendToUser(req.user.id, {
    type: 'conversation:cleared',
    conversationId: req.conversationId,
    clearedUpToId,
  });
  res.json({ ok: true, clearedUpToId });
});

router.post('/conversations/:id/members', requireApproved, memberGuard, (req, res) => {
  const conv = store.getConversationRow(req.conversationId);
  if (conv.type !== 'group') return fail(res, 400, 'فقط به گروه می‌توان عضو اضافه کرد.');

  // فقط سازنده‌ی گروه عضو اضافه می‌کند؛ وگرنه هر عضوی می‌توانست بدون اطلاع
  // بقیه، شخص تازه‌ای را وارد گفتگوی خصوصی کند.
  const me = store.membersOf(conv.id).find((m) => m.id === req.user.id);
  if (me?.role !== 'owner') return fail(res, 403, 'فقط سازنده‌ی گروه می‌تواند عضو اضافه کند.');

  // مثل ساخت گفتگوی دوطرفه، با نام کاربری دقیق — نه شناسه‌ی عددی.
  const handle = clean(req.body.username).replace(/^@/, '');
  if (!USERNAME_RE.test(handle)) return fail(res, 400, 'نام کاربری نامعتبر است.');
  const target = store.getUserByUsername(handle);
  if (!target || target.status !== 'approved') return fail(res, 404, 'کاربر پیدا نشد.');
  if (store.isMember(conv.id, target.id)) return fail(res, 409, 'این کاربر از قبل عضو است.');

  store.addMember(conv.id, target.id);
  const system = store.createMessage({
    conversationId: conv.id,
    senderId: req.user.id,
    kind: 'system',
    body: `${target.display_name} به گروه اضافه شد.`,
  });
  hub.sendToUser(target.id, {
    type: 'conversation:new',
    conversation: decorateConversation(store.conversationView(conv.id, target.id)),
  });
  hub.sendToConversation(conv.id, { type: 'message:new', message: system }, target.id);
  res.status(201).json({
    conversation: decorateConversation(store.conversationView(conv.id, req.user.id)),
  });
});

router.delete('/conversations/:id/members/me', requireApproved, memberGuard, (req, res) => {
  const conv = store.getConversationRow(req.conversationId);
  if (conv.type !== 'group') return fail(res, 400, 'فقط از گروه می‌توان خارج شد.');

  store.removeMember(conv.id, req.user.id);
  const system = store.createMessage({
    conversationId: conv.id,
    senderId: null,
    kind: 'system',
    body: `${req.user.display_name} گروه را ترک کرد.`,
  });
  hub.sendToConversation(conv.id, { type: 'message:new', message: system });
  hub.sendToUser(req.user.id, { type: 'conversation:left', conversationId: conv.id });
  res.json({ ok: true });
});

module.exports = { router, MAX_IMAGE_BYTES, MAX_VOICE_BYTES };
