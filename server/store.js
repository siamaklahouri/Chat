'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { db, UPLOAD_DIR } = require('./db');
const { hashPassword } = require('./auth');

const AVATAR_COLORS = [
  '#4f7cff', '#8b5cf6', '#ec4899', '#f97316',
  '#10b981', '#06b6d4', '#eab308', '#ef4444',
];

const pickColor = (seed) =>
  AVATAR_COLORS[Math.abs([...seed].reduce((a, c) => a + c.charCodeAt(0), 0)) % AVATAR_COLORS.length];

const publicUser = (row) =>
  row && {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    bio: row.bio,
    avatarColor: row.avatar_color,
    // نشانی با زمانِ آخرین تغییر امضا می‌شود تا وقتی کاربر عکسش را عوض کرد،
    // نسخه‌ی کش‌شده‌ی مرورگر دیگر استفاده نشود.
    avatarUrl: row.avatar_at ? `/api/avatars/${row.id}?v=${row.avatar_at}` : null,
    status: row.status,
    isAdmin: Boolean(row.is_admin),
    lastSeenAt: row.last_seen_at,
  };

const attachmentOf = (row) =>
  ['image', 'voice', 'file'].includes(row.kind) && !row.deleted_at
    ? {
        url: `/api/files/${row.id}`,
        name: row.file_name,
        mime: row.file_mime,
        size: row.file_size,
        width: row.image_width,
        height: row.image_height,
        durationMs: row.duration_ms,
      }
    : null;

const publicMessage = (row) => ({
  id: row.id,
  conversationId: row.conversation_id,
  senderId: row.sender_id,
  kind: row.kind,
  body: row.deleted_at ? '' : row.body,
  caption: row.deleted_at ? '' : row.body,
  attachment: attachmentOf(row),
  // برای پیام صوتی داخل attachment هم هست؛ برای رکورد تماس اینجا لازم است.
  durationMs: row.deleted_at ? null : row.duration_ms,
  forwarded: Boolean(row.forwarded),
  replyToId: row.reply_to_id,
  createdAt: row.created_at,
  editedAt: row.edited_at,
  deleted: Boolean(row.deleted_at),
  replyTo:
    row.reply_to_id == null
      ? null
      : {
          id: row.reply_to_id,
          senderId: row.reply_sender_id,
          kind: row.reply_kind,
          body: row.reply_deleted_at ? '' : row.reply_body,
          deleted: Boolean(row.reply_deleted_at),
        },
});

/* ------------------------------- users ------------------------------- */

function createUser({ username, displayName, password, status = 'pending', isAdmin = false }) {
  const now = Date.now();
  const info = db
    .prepare(
      `INSERT INTO users (username, display_name, password_hash, avatar_color, status, is_admin, created_at, last_seen_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(username, displayName, hashPassword(password), pickColor(username), status, isAdmin ? 1 : 0, now, now);
  return getUserById(Number(info.lastInsertRowid));
}

const getUserById = (id) => db.prepare('SELECT * FROM users WHERE id = ?').get(id) || null;
const getUserByUsername = (username) =>
  db.prepare('SELECT * FROM users WHERE username = ? COLLATE NOCASE').get(username) || null;

function updateUser(id, { displayName, bio }) {
  db.prepare('UPDATE users SET display_name = ?, bio = ? WHERE id = ?').run(displayName, bio, id);
  return getUserById(id);
}

function setUserStatus(id, status, reviewerId) {
  db.prepare('UPDATE users SET status = ?, reviewed_at = ?, reviewed_by = ? WHERE id = ?').run(
    status,
    Date.now(),
    reviewerId,
    id
  );
  if (status !== 'approved') db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
  return getUserById(id);
}

function setUserPassword(id, password) {
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(password), id);
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
}

function deleteUser(id) {
  // فایل عکس هم باید برود، وگرنه روی دیسک یتیم می‌ماند.
  fs.rmSync(path.join(UPLOAD_DIR, `avatar-${id}`), { force: true });
  db.prepare('DELETE FROM users WHERE id = ?').run(id);
}

function touchUser(id) {
  db.prepare('UPDATE users SET last_seen_at = ? WHERE id = ?').run(Date.now(), id);
}

const countUsers = () => db.prepare('SELECT COUNT(*) AS c FROM users').get().c;
const countAdmins = () => db.prepare('SELECT COUNT(*) AS c FROM users WHERE is_admin = 1').get().c;
const countPending = () =>
  db.prepare("SELECT COUNT(*) AS c FROM users WHERE status = 'pending'").get().c;

/**
 * فهرست کاربران برای پنل مدیریت، با جستجو و صفحه‌بندی.
 *
 * اینجا برخلاف جستجوی کاربرانِ خود برنامه، جستجوی بخشی روی نام و نام کاربری
 * مجاز است — مدیر به‌هرحال فهرست کامل را می‌بیند، پس چیزی لو نمی‌رود.
 */
function listUsers({ status, query = '', limit = 25, offset = 0 } = {}) {
  const where = [];
  const params = [];
  if (status) {
    where.push('status = ?');
    params.push(status);
  }
  if (query) {
    where.push('(username LIKE ? ESCAPE \'\\\' OR display_name LIKE ? ESCAPE \'\\\')');
    const like = `%${query.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    params.push(like, like);
  }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const total = db.prepare(`SELECT COUNT(*) AS c FROM users ${clause}`).get(...params).c;
  const rows = db
    .prepare(`SELECT * FROM users ${clause} ORDER BY created_at DESC LIMIT ? OFFSET ?`)
    .all(...params, limit, offset);

  return {
    total,
    users: rows.map((row) => ({
      ...publicUser(row),
      createdAt: row.created_at,
      reviewedAt: row.reviewed_at,
    })),
  };
}

/* --------------------------- گزارش کار مدیر --------------------------- */

/**
 * نام‌ها در لحظه‌ی ثبت کپی می‌شوند، نه فقط شناسه: اگر کاربری بعداً حذف شود،
 * گزارش باید هنوز بگوید چه کسی چه کاری با چه کسی کرد.
 */
function logAdminAction({ actor, action, target = null, detail = null }) {
  db.prepare(
    `INSERT INTO admin_log (actor_id, actor_name, action, target_id, target_name, detail, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(
    actor?.id ?? null,
    actor?.display_name || actor?.username || 'نامشخص',
    action,
    target?.id ?? null,
    target ? target.display_name || target.username : null,
    detail,
    Date.now()
  );
}

function listAdminLog(limit = 50) {
  return db
    .prepare('SELECT * FROM admin_log ORDER BY id DESC LIMIT ?')
    .all(limit)
    .map((row) => ({
      id: row.id,
      actor: row.actor_name,
      action: row.action,
      target: row.target_name,
      detail: row.detail,
      createdAt: row.created_at,
    }));
}

/**
 * کاربر فقط با نام کاربری دقیق پیدا می‌شود — نه با بخشی از آن و نه با نام نمایشی.
 * هدف این است که فهرست کاربران قابل مرور نباشد: برای پیام دادن باید شناسه‌ی
 * طرف مقابل را از قبل بدانید.
 */
function findUserByHandle(handle, excludeId) {
  const row = db
    .prepare(
      `SELECT * FROM users
       WHERE username = ? COLLATE NOCASE AND id != ? AND status = 'approved'`
    )
    .get(handle, excludeId);
  return row ? [publicUser(row)] : [];
}

/* --------------------------- conversations --------------------------- */

const directKey = (a, b) => [a, b].sort((x, y) => x - y).join(':');

function getOrCreateDirect(userA, userB) {
  const key = directKey(userA, userB);
  const existing = db.prepare('SELECT * FROM conversations WHERE direct_key = ?').get(key);
  if (existing) return { conversation: existing, created: false };

  const now = Date.now();
  const info = db
    .prepare(
      `INSERT INTO conversations (type, title, avatar_color, direct_key, created_by, created_at)
       VALUES ('direct', NULL, ?, ?, ?, ?)`
    )
    .run(pickColor(key), key, userA, now);
  const id = Number(info.lastInsertRowid);
  const add = db.prepare(
    'INSERT INTO members (conversation_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)'
  );
  add.run(id, userA, 'member', now);
  add.run(id, userB, 'member', now);
  return { conversation: getConversationRow(id), created: true };
}

function createGroup({ title, creatorId, memberIds }) {
  const now = Date.now();
  const info = db
    .prepare(
      `INSERT INTO conversations (type, title, avatar_color, created_by, created_at)
       VALUES ('group', ?, ?, ?, ?)`
    )
    .run(title, pickColor(title + now), creatorId, now);
  const id = Number(info.lastInsertRowid);
  const add = db.prepare(
    'INSERT OR IGNORE INTO members (conversation_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)'
  );
  add.run(id, creatorId, 'owner', now);
  for (const memberId of memberIds) add.run(id, memberId, 'member', now);
  return getConversationRow(id);
}

const getConversationRow = (id) =>
  db.prepare('SELECT * FROM conversations WHERE id = ?').get(id) || null;

const isMember = (conversationId, userId) =>
  Boolean(
    db
      .prepare('SELECT 1 FROM members WHERE conversation_id = ? AND user_id = ?')
      .get(conversationId, userId)
  );

const memberIdsOf = (conversationId) =>
  db
    .prepare('SELECT user_id FROM members WHERE conversation_id = ?')
    .all(conversationId)
    .map((r) => r.user_id);

const membersOf = (conversationId) =>
  db
    .prepare(
      `SELECT u.*, m.role, m.last_read_message_id FROM members m
       JOIN users u ON u.id = m.user_id
       WHERE m.conversation_id = ? ORDER BY m.joined_at`
    )
    .all(conversationId)
    .map((row) => ({
      ...publicUser(row),
      role: row.role,
      lastReadMessageId: row.last_read_message_id,
    }));

/** دید این کاربر از گفتگو: تا کجا پاک کرده و آیا مخفی‌اش کرده. */
const memberView = (conversationId, userId) =>
  db
    .prepare(
      `SELECT last_read_message_id, cleared_up_to_id, hidden, pinned_at, muted, archived
       FROM members WHERE conversation_id = ? AND user_id = ?`
    )
    .get(conversationId, userId) || {
    last_read_message_id: 0,
    cleared_up_to_id: 0,
    hidden: 0,
    pinned_at: null,
    muted: 0,
    archived: 0,
  };

/** سنجاق و بی‌صدا هر کدام فقط برای همان کاربر است، نه برای طرف مقابل. */
function setConversationFlags(conversationId, userId, { pinned, muted, archived, unread }) {
  if (pinned !== undefined) {
    db.prepare('UPDATE members SET pinned_at = ? WHERE conversation_id = ? AND user_id = ?')
      .run(pinned ? Date.now() : null, conversationId, userId);
  }
  if (muted !== undefined) {
    db.prepare('UPDATE members SET muted = ? WHERE conversation_id = ? AND user_id = ?')
      .run(muted ? 1 : 0, conversationId, userId);
  }
  if (archived !== undefined) {
    db.prepare('UPDATE members SET archived = ? WHERE conversation_id = ? AND user_id = ?')
      .run(archived ? 1 : 0, conversationId, userId);
  }
  // «خوانده‌نشده کردن»: نشانگر خواندن را یک پیام عقب می‌بریم تا شمارنده
  // دوباره روشن شود. پیام‌ها دست نمی‌خورند.
  if (unread === true) {
    const last = db
      .prepare('SELECT MAX(id) AS id FROM messages WHERE conversation_id = ? AND sender_id IS NOT ?')
      .get(conversationId, userId)?.id;
    if (last) {
      db.prepare(
        'UPDATE members SET last_read_message_id = ? WHERE conversation_id = ? AND user_id = ?'
      ).run(last - 1, conversationId, userId);
    }
  }
  return conversationView(conversationId, userId);
}

/**
 * «حذف گفتگو» فقط برای همین کاربر: پیام‌های تا این لحظه از دید او پنهان می‌شوند و
 * گفتگو از فهرستش می‌رود. طرف مقابل نسخه‌ی خودش را دست‌نخورده دارد، و اگر پیام
 * تازه‌ای بیاید گفتگو دوباره — فقط با پیام‌های تازه — برمی‌گردد.
 */
function clearConversationFor(conversationId, userId) {
  const last =
    db.prepare('SELECT MAX(id) AS id FROM messages WHERE conversation_id = ?').get(conversationId)
      ?.id || 0;
  db.prepare(
    `UPDATE members SET cleared_up_to_id = ?, hidden = 1, last_read_message_id = ?
     WHERE conversation_id = ? AND user_id = ?`
  ).run(last, last, conversationId, userId);
  return last;
}

function addMember(conversationId, userId) {
  db.prepare(
    'INSERT OR IGNORE INTO members (conversation_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)'
  ).run(conversationId, userId, 'member', Date.now());
}

function setMemberRole(conversationId, userId, role) {
  db.prepare('UPDATE members SET role = ? WHERE conversation_id = ? AND user_id = ?')
    .run(role, conversationId, userId);
}

function removeMember(conversationId, userId) {
  db.prepare('DELETE FROM members WHERE conversation_id = ? AND user_id = ?').run(
    conversationId,
    userId
  );
}

/** Shapes a conversation for one viewer: title, avatar, peer, last message, unread count. */
function conversationView(conversationId, viewerId) {
  const conv = getConversationRow(conversationId);
  if (!conv) return null;
  const members = membersOf(conversationId);
  const me = members.find((m) => m.id === viewerId);
  const view = memberView(conversationId, viewerId);
  const cleared = view.cleared_up_to_id;
  const peer = conv.type === 'direct' ? members.find((m) => m.id !== viewerId) || null : null;
  const lastRow = db
    .prepare('SELECT * FROM messages WHERE conversation_id = ? AND id > ? ORDER BY id DESC LIMIT 1')
    .get(conversationId, cleared);
  const lastReadId = Math.max(me ? me.lastReadMessageId : 0, cleared);
  const unread = db
    .prepare(
      `SELECT COUNT(*) AS c FROM messages
       WHERE conversation_id = ? AND id > ? AND sender_id IS NOT ? AND kind != 'system'`
    )
    .get(conversationId, lastReadId, viewerId).c;

  // در گفتگوی دوطرفه اگر طرف مقابل پیدا نشود یعنی حسابش حذف شده است.
  const orphaned = conv.type === 'direct' && !peer;

  return {
    id: conv.id,
    type: conv.type,
    title: conv.type === 'group' ? conv.title : peer ? peer.displayName : 'کاربر حذف‌شده',
    orphaned,
    avatarColor: conv.type === 'group' ? conv.avatar_color : peer ? peer.avatarColor : '#64748b',
    avatarUrl:
      conv.type === 'group'
        ? conv.avatar_at
          ? `/api/conversations/${conv.id}/avatar?v=${conv.avatar_at}`
          : null
        : peer?.avatarUrl || null,
    peer,
    members,
    memberCount: members.length,
    createdAt: conv.created_at,
    lastMessage: lastRow ? publicMessage(lastRow) : null,
    unread,
    lastReadMessageId: lastReadId,
    clearedUpToId: cleared,
    pinned: Boolean(view.pinned_at),
    muted: Boolean(view.muted),
    archived: Boolean(view.archived),
    // پیامِ سنجاق‌شده‌ی خودِ گفتگو — برای همه‌ی اعضا یکی است، برخلاف
    // «سنجاق کردن گفتگو» که برای هر کس جداست.
    pinnedMessage: pinnedMessageOf(conv, cleared),
  };
}

/** پیامِ سنجاق‌شده، اگر هنوز هست و این کاربر پاکش نکرده باشد. */
function pinnedMessageOf(conv, cleared) {
  if (!conv.pinned_message_id || conv.pinned_message_id <= cleared) return null;
  const row = db.prepare(`${MESSAGE_SELECT} WHERE m.id = ?`).get(conv.pinned_message_id);
  if (!row || row.deleted_at || row.conversation_id !== conv.id) return null;
  return publicMessage(row);
}

/** سنجاق کردن یا برداشتنِ سنجاقِ یک پیام. پیام باید مالِ همین گفتگو باشد. */
function setPinnedMessage(conversationId, messageId) {
  if (messageId != null) {
    const row = db.prepare('SELECT conversation_id, deleted_at FROM messages WHERE id = ?').get(messageId);
    if (!row || row.deleted_at || row.conversation_id !== conversationId) return false;
  }
  db.prepare('UPDATE conversations SET pinned_message_id = ? WHERE id = ?').run(messageId, conversationId);
  return true;
}

function listConversations(viewerId) {
  return db
    .prepare(
      `SELECT c.id FROM conversations c
       JOIN members m ON m.conversation_id = c.id AND m.user_id = ?
       LEFT JOIN (SELECT conversation_id, MAX(id) AS last_id FROM messages GROUP BY conversation_id) lm
         ON lm.conversation_id = c.id
       WHERE m.hidden = 0 OR COALESCE(lm.last_id, 0) > m.cleared_up_to_id
       ORDER BY m.archived, (m.pinned_at IS NULL), m.pinned_at DESC,
                COALESCE(lm.last_id, 0) DESC, c.id DESC`
    )
    .all(viewerId)
    .map((r) => conversationView(r.id, viewerId));
}

/* ------------------------------ messages ------------------------------ */

const MESSAGE_SELECT = `
  SELECT m.*, r.body AS reply_body, r.kind AS reply_kind,
         r.sender_id AS reply_sender_id, r.deleted_at AS reply_deleted_at
  FROM messages m
  LEFT JOIN messages r ON r.id = m.reply_to_id
`;

function listMessages(conversationId, { before, limit = 40, viewerId = null } = {}) {
  // پیام‌هایی که این کاربر پاک کرده، دیگر برای او برگردانده نمی‌شوند.
  const cleared = viewerId ? memberView(conversationId, viewerId).cleared_up_to_id : 0;
  const rows = before
    ? db
        .prepare(
          `${MESSAGE_SELECT} WHERE m.conversation_id = ? AND m.id < ? AND m.id > ? ORDER BY m.id DESC LIMIT ?`
        )
        .all(conversationId, before, cleared, limit)
    : db
        .prepare(`${MESSAGE_SELECT} WHERE m.conversation_id = ? AND m.id > ? ORDER BY m.id DESC LIMIT ?`)
        .all(conversationId, cleared, limit);
  return rows.reverse().map(publicMessage);
}

/**
 * تاریخچه‌ی تماس‌های این کاربر، از همه‌ی گفتگوهایش.
 *
 * رکورد تماس خودش یک پیام با kind='call' است، پس جدول تازه‌ای لازم نیست.
 * پیام‌هایی که کاربر گفتگو را برایشان پاک کرده برنمی‌گردند، مثل هر پیام دیگر.
 */
function listCallsFor(viewerId, limit = 60) {
  const rows = db
    .prepare(
      `${MESSAGE_SELECT}
       JOIN members mem ON mem.conversation_id = m.conversation_id AND mem.user_id = ?
       WHERE m.kind = 'call' AND m.id > mem.cleared_up_to_id AND m.deleted_at IS NULL
       ORDER BY m.id DESC LIMIT ?`
    )
    .all(viewerId, limit);
  return rows.map((row) => ({
    ...publicMessage(row),
    conversation: conversationView(row.conversation_id, viewerId),
  }));
}

/**
 * رسانه‌های یک گفتگو: عکس، فایل و پیام صوتی، تازه‌ترین اول.
 * همان قاعده‌ی پیام‌ها: چیزی که کاربر پاک کرده برنمی‌گردد.
 */
function listMediaIn(conversationId, { viewerId, kind = null, limit = 60, before = null } = {}) {
  const cleared = viewerId ? memberView(conversationId, viewerId).cleared_up_to_id : 0;
  const kinds = kind === 'file' ? ['file'] : kind === 'voice' ? ['voice'] : ['image'];
  const marks = kinds.map(() => '?').join(', ');
  const rows = db
    .prepare(
      `${MESSAGE_SELECT}
       WHERE m.conversation_id = ? AND m.kind IN (${marks}) AND m.deleted_at IS NULL
         AND m.id > ? ${before ? 'AND m.id < ?' : ''}
       ORDER BY m.id DESC LIMIT ?`
    )
    .all(conversationId, ...kinds, cleared, ...(before ? [before] : []), limit);
  return rows.map(publicMessage);
}

function getMessage(id) {
  const row = db.prepare(`${MESSAGE_SELECT} WHERE m.id = ?`).get(id);
  return row ? publicMessage(row) : null;
}

function createMessage({
  conversationId,
  senderId,
  body = '',
  replyToId = null,
  kind = 'text',
  file = null,
  forwarded = false,
}) {
  const info = db
    .prepare(
      `INSERT INTO messages
         (conversation_id, sender_id, kind, body, file_name, file_mime, file_size,
          image_width, image_height, duration_ms, forwarded, reply_to_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      conversationId,
      senderId,
      kind,
      body,
      file?.name ?? null,
      file?.mime ?? null,
      file?.size ?? null,
      file?.width ?? null,
      file?.height ?? null,
      file?.durationMs ?? null,
      forwarded ? 1 : 0,
      replyToId,
      Date.now()
    );
  return getMessage(Number(info.lastInsertRowid));
}

function editMessage(id, body) {
  db.prepare('UPDATE messages SET body = ?, edited_at = ? WHERE id = ?').run(body, Date.now(), id);
  return getMessage(id);
}

function deleteMessage(id) {
  removeFileOf(id);
  db.prepare("UPDATE messages SET deleted_at = ?, body = '' WHERE id = ?").run(Date.now(), id);
  return getMessage(id);
}

const rawMessage = (id) => db.prepare('SELECT * FROM messages WHERE id = ?').get(id) || null;

const filePathFor = (messageId) => path.join(UPLOAD_DIR, `msg-${messageId}`);

/**
 * عکس پروفایل با پیشوند avatar- ذخیره می‌شود، نه msg-. پاکسازی دوره‌ای فقط
 * فایل‌های msg- را برمی‌دارد، پس عکس پروفایل‌ها مثل خود حساب‌ها باقی می‌مانند.
 */
const avatarPathFor = (userId) => path.join(UPLOAD_DIR, `avatar-${userId}`);

/** عکس گروه هم مثل عکس پروفایل، بیرون از دایره‌ی پاکسازی دوره‌ای می‌ماند. */
const groupAvatarPathFor = (conversationId) =>
  path.join(UPLOAD_DIR, `group-${conversationId}`);

function setGroupAvatar(conversationId, buffer) {
  fs.writeFileSync(groupAvatarPathFor(conversationId), buffer);
  db.prepare('UPDATE conversations SET avatar_at = ? WHERE id = ?').run(Date.now(), conversationId);
  return getConversationRow(conversationId);
}

function removeGroupAvatar(conversationId) {
  fs.rmSync(groupAvatarPathFor(conversationId), { force: true });
  db.prepare('UPDATE conversations SET avatar_at = NULL WHERE id = ?').run(conversationId);
  return getConversationRow(conversationId);
}

function renameGroup(conversationId, title) {
  db.prepare('UPDATE conversations SET title = ? WHERE id = ?').run(title, conversationId);
  return getConversationRow(conversationId);
}

function setUserAvatar(userId, buffer) {
  fs.writeFileSync(avatarPathFor(userId), buffer);
  const now = Date.now();
  db.prepare('UPDATE users SET avatar_at = ? WHERE id = ?').run(now, userId);
  return getUserById(userId);
}

function removeUserAvatar(userId) {
  fs.rmSync(avatarPathFor(userId), { force: true });
  db.prepare('UPDATE users SET avatar_at = NULL WHERE id = ?').run(userId);
  return getUserById(userId);
}

function removeFileOf(messageId) {
  fs.rmSync(filePathFor(messageId), { force: true });
}

/* ------------------------------- استوری ------------------------------- */

/**
 * استوری پس از ۲۴ ساعت خودش می‌رود.
 *
 * برخلاف پیام‌ها که فقط دستی پاک می‌شوند، استوری ذاتاً موقت است — کاربر با
 * همین انتظار می‌گذاردش.
 */
const STORY_TTL_MS = 24 * 60 * 60 * 1000;

const storyPathFor = (id) => path.join(UPLOAD_DIR, `story-${id}`);

function createStory(userId, caption, buffer) {
  const now = Date.now();
  const info = db
    .prepare('INSERT INTO stories (user_id, caption, created_at, expires_at) VALUES (?, ?, ?, ?)')
    .run(userId, caption, now, now + STORY_TTL_MS);
  const id = Number(info.lastInsertRowid);
  try {
    fs.writeFileSync(storyPathFor(id), buffer);
  } catch (error) {
    db.prepare('DELETE FROM stories WHERE id = ?').run(id);
    throw error;
  }
  return getStory(id);
}

const getStory = (id) => db.prepare('SELECT * FROM stories WHERE id = ?').get(id) || null;

function deleteStory(id) {
  fs.rmSync(storyPathFor(id), { force: true });
  db.prepare('DELETE FROM stories WHERE id = ?').run(id);
}

/** استوری‌های منقضی را با فایلشان برمی‌دارد. */
function sweepStories() {
  const rows = db.prepare('SELECT id FROM stories WHERE expires_at <= ?').all(Date.now());
  for (const row of rows) deleteStory(row.id);
  return rows.length;
}

/**
 * استوری‌هایی که این کاربر حق دیدنشان را دارد: مال خودش، و مال کسانی که
 * دست‌کم یک گفتگوی مشترک با او دارند — همان قاعده‌ی بقیه‌ی برنامه.
 */
function listStoriesFor(viewerId) {
  sweepStories();
  const allowed = new Set([viewerId, ...peerIdsOf(viewerId)]);
  const blocked = new Set(
    db.prepare('SELECT blocked_id AS id FROM blocks WHERE blocker_id = ?').all(viewerId).map((r) => r.id)
  );
  const hidesMe = new Set(
    db.prepare('SELECT blocker_id AS id FROM blocks WHERE blocked_id = ?').all(viewerId).map((r) => r.id)
  );

  const rows = db
    .prepare(
      `SELECT s.*, u.username, u.display_name, u.avatar_color, u.avatar_at,
              (SELECT 1 FROM story_views v WHERE v.story_id = s.id AND v.user_id = ?) AS seen
       FROM stories s JOIN users u ON u.id = s.user_id
       WHERE s.expires_at > ? ORDER BY s.user_id, s.id`
    )
    .all(viewerId, Date.now());

  const groups = new Map();
  for (const row of rows) {
    if (!allowed.has(row.user_id)) continue;
    if (blocked.has(row.user_id) || hidesMe.has(row.user_id)) continue;
    if (!groups.has(row.user_id)) {
      groups.set(row.user_id, {
        user: publicUser({
          id: row.user_id,
          username: row.username,
          display_name: row.display_name,
          avatar_color: row.avatar_color,
          avatar_at: row.avatar_at,
        }),
        mine: row.user_id === viewerId,
        items: [],
      });
    }
    groups.get(row.user_id).items.push({
      id: row.id,
      url: `/api/stories/${row.id}/file`,
      caption: row.caption,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      seen: Boolean(row.seen),
    });
  }

  // خودم اول، بعد آن‌هایی که ندیده‌ام، بعد بقیه.
  return [...groups.values()]
    .map((group) => ({ ...group, allSeen: group.items.every((i) => i.seen) }))
    .sort((a, b) => Number(b.mine) - Number(a.mine) || Number(a.allSeen) - Number(b.allSeen));
}

function markStorySeen(storyId, userId) {
  db.prepare(
    'INSERT OR IGNORE INTO story_views (story_id, user_id, seen_at) VALUES (?, ?, ?)'
  ).run(storyId, userId, Date.now());
}

/** چه کسانی استوری مرا دیده‌اند. */
function storyViewers(storyId) {
  return db
    .prepare(
      `SELECT u.* FROM story_views v JOIN users u ON u.id = v.user_id
       WHERE v.story_id = ? ORDER BY v.seen_at DESC`
    )
    .all(storyId)
    .map(publicUser);
}

/* -------------------------------- بلاک -------------------------------- */

/**
 * بلاک یک‌طرفه است و فقط جلوی پیام دادن را می‌گیرد: گفتگوی قبلی پاک نمی‌شود
 * و طرف مقابل خبردار نمی‌شود که بلاک شده — همان رفتاری که پیام‌رسان‌ها دارند.
 */
function blockUser(blockerId, blockedId) {
  db.prepare(
    'INSERT OR IGNORE INTO blocks (blocker_id, blocked_id, created_at) VALUES (?, ?, ?)'
  ).run(blockerId, blockedId, Date.now());
}

function unblockUser(blockerId, blockedId) {
  db.prepare('DELETE FROM blocks WHERE blocker_id = ? AND blocked_id = ?').run(blockerId, blockedId);
}

const hasBlocked = (blockerId, blockedId) =>
  Boolean(
    db
      .prepare('SELECT 1 FROM blocks WHERE blocker_id = ? AND blocked_id = ?')
      .get(blockerId, blockedId)
  );

/** آیا بین این دو نفر بلاکی هست (در هر جهت)؟ */
const blockedBetween = (a, b) => hasBlocked(a, b) || hasBlocked(b, a);

function listBlocked(userId) {
  return db
    .prepare(
      `SELECT u.* FROM blocks b JOIN users u ON u.id = b.blocked_id
       WHERE b.blocker_id = ? ORDER BY b.created_at DESC`
    )
    .all(userId)
    .map(publicUser);
}

/* ------------------------------ ری‌اکشن ------------------------------ */

/** ری‌اکشن‌های یک دسته پیام: { messageId: [{ emoji, count, mine }] } */
function reactionsFor(messageIds, viewerId) {
  if (messageIds.length === 0) return {};
  const marks = messageIds.map(() => '?').join(',');
  const rows = db
    .prepare(
      `SELECT message_id, emoji, COUNT(*) AS count,
              SUM(CASE WHEN user_id = ? THEN 1 ELSE 0 END) AS mine
       FROM reactions WHERE message_id IN (${marks})
       GROUP BY message_id, emoji ORDER BY count DESC, emoji`
    )
    .all(viewerId, ...messageIds);

  const out = {};
  for (const row of rows) {
    (out[row.message_id] ||= []).push({
      emoji: row.emoji,
      count: row.count,
      mine: row.mine > 0,
    });
  }
  return out;
}

/** زدن یا برداشتن ری‌اکشن. برمی‌گرداند که الان زده شده یا نه. */
function toggleReaction(messageId, userId, emoji) {
  const existing = db
    .prepare('SELECT 1 FROM reactions WHERE message_id = ? AND user_id = ? AND emoji = ?')
    .get(messageId, userId, emoji);
  if (existing) {
    db.prepare('DELETE FROM reactions WHERE message_id = ? AND user_id = ? AND emoji = ?')
      .run(messageId, userId, emoji);
    return false;
  }
  db.prepare(
    'INSERT INTO reactions (message_id, user_id, emoji, created_at) VALUES (?, ?, ?, ?)'
  ).run(messageId, userId, emoji, Date.now());
  return true;
}

/* ------------------------- جستجو در پیام‌ها ------------------------- */

/**
 * جستجوی متنی در پیام‌های همین کاربر. فقط گفتگوهایی که عضوشان است، و فقط
 * پیام‌هایی که برای خودش پاک نکرده.
 */
function searchMessages(viewerId, query, limit = 40) {
  const like = `%${query.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  return db
    .prepare(
      `SELECT m.*, c.type AS conv_type, c.title AS conv_title
       FROM messages m
       JOIN members mem ON mem.conversation_id = m.conversation_id AND mem.user_id = ?
       JOIN conversations c ON c.id = m.conversation_id
       WHERE m.deleted_at IS NULL AND m.kind IN ('text', 'image')
         AND m.id > mem.cleared_up_to_id
         AND m.body LIKE ? ESCAPE '\\'
       ORDER BY m.id DESC LIMIT ?`
    )
    .all(viewerId, like, limit)
    .map((row) => ({
      ...publicMessage(row),
      conversationTitle: row.conv_type === 'group' ? row.conv_title : null,
    }));
}

/** ری‌اکشن‌ها را به پیام‌ها می‌چسباند (یک پرس‌وجو برای کل دسته). */
function withReactions(messages, viewerId) {
  const map = reactionsFor(messages.map((m) => m.id), viewerId);
  return messages.map((m) => ({ ...m, reactions: map[m.id] || [] }));
}

function markRead(conversationId, userId, messageId) {
  db.prepare(
    `UPDATE members SET last_read_message_id = ?
     WHERE conversation_id = ? AND user_id = ? AND last_read_message_id < ?`
  ).run(messageId, conversationId, userId, messageId);
}

/* ------------------------------ statistics ---------------------------- */

/** شناسه‌ی همه‌ی کسانی که با این کاربر دست‌کم یک گفتگوی مشترک دارند. */
function peerIdsOf(userId) {
  return db
    .prepare(
      `SELECT DISTINCT other.user_id AS id FROM members mine
       JOIN members other ON other.conversation_id = mine.conversation_id
       WHERE mine.user_id = ? AND other.user_id != ?`
    )
    .all(userId, userId)
    .map((r) => r.id);
}

function stats() {
  return {
    users: countUsers(),
    pending: countPending(),
    approved: db.prepare("SELECT COUNT(*) AS c FROM users WHERE status = 'approved'").get().c,
    blocked: db.prepare("SELECT COUNT(*) AS c FROM users WHERE status = 'blocked'").get().c,
    conversations: db.prepare('SELECT COUNT(*) AS c FROM conversations').get().c,
    messages: db.prepare('SELECT COUNT(*) AS c FROM messages').get().c,
    images: db.prepare("SELECT COUNT(*) AS c FROM messages WHERE kind = 'image'").get().c,
  };
}

module.exports = {
  db,
  UPLOAD_DIR,
  publicUser,
  publicMessage,
  createUser,
  getUserById,
  getUserByUsername,
  updateUser,
  setUserStatus,
  setUserPassword,
  deleteUser,
  touchUser,
  countUsers,
  countAdmins,
  countPending,
  listUsers,
  logAdminAction,
  listAdminLog,
  findUserByHandle,
  getOrCreateDirect,
  createGroup,
  getConversationRow,
  isMember,
  memberIdsOf,
  membersOf,
  addMember,
  memberView,
  clearConversationFor,
  setMemberRole,
  removeMember,
  conversationView,
  listConversations,
  listMessages,
  listCallsFor,
  listMediaIn,
  setPinnedMessage,
  getMessage,
  createMessage,
  editMessage,
  deleteMessage,
  rawMessage,
  filePathFor,
  avatarPathFor,
  setUserAvatar,
  removeUserAvatar,
  groupAvatarPathFor,
  setGroupAvatar,
  removeGroupAvatar,
  renameGroup,
  removeFileOf,
  markRead,
  setConversationFlags,
  STORY_TTL_MS,
  storyPathFor,
  createStory,
  getStory,
  deleteStory,
  sweepStories,
  listStoriesFor,
  markStorySeen,
  storyViewers,
  blockUser,
  unblockUser,
  hasBlocked,
  blockedBetween,
  listBlocked,
  reactionsFor,
  withReactions,
  toggleReaction,
  searchMessages,
  peerIdsOf,
  stats,
};
