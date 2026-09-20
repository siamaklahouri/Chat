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
    status: row.status,
    isAdmin: Boolean(row.is_admin),
    lastSeenAt: row.last_seen_at,
  };

const attachmentOf = (row) =>
  row.kind === 'image' && !row.deleted_at
    ? {
        url: `/api/files/${row.id}`,
        name: row.file_name,
        mime: row.file_mime,
        size: row.file_size,
        width: row.image_width,
        height: row.image_height,
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
  db.prepare('DELETE FROM users WHERE id = ?').run(id);
}

function touchUser(id) {
  db.prepare('UPDATE users SET last_seen_at = ? WHERE id = ?').run(Date.now(), id);
}

const countUsers = () => db.prepare('SELECT COUNT(*) AS c FROM users').get().c;
const countAdmins = () => db.prepare('SELECT COUNT(*) AS c FROM users WHERE is_admin = 1').get().c;
const countPending = () =>
  db.prepare("SELECT COUNT(*) AS c FROM users WHERE status = 'pending'").get().c;

function listUsers({ status } = {}) {
  const rows = status
    ? db.prepare('SELECT * FROM users WHERE status = ? ORDER BY created_at DESC').all(status)
    : db.prepare('SELECT * FROM users ORDER BY created_at DESC').all();
  return rows.map((row) => ({
    ...publicUser(row),
    createdAt: row.created_at,
    reviewedAt: row.reviewed_at,
  }));
}

function searchUsers(query, excludeId, limit = 20) {
  const like = `%${query}%`;
  return db
    .prepare(
      `SELECT * FROM users
       WHERE id != ? AND status = 'approved'
         AND (username LIKE ? COLLATE NOCASE OR display_name LIKE ? COLLATE NOCASE)
       ORDER BY display_name LIMIT ?`
    )
    .all(excludeId, like, like, limit)
    .map(publicUser);
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

function addMember(conversationId, userId) {
  db.prepare(
    'INSERT OR IGNORE INTO members (conversation_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)'
  ).run(conversationId, userId, 'member', Date.now());
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
  const peer = conv.type === 'direct' ? members.find((m) => m.id !== viewerId) || null : null;
  const lastRow = db
    .prepare('SELECT * FROM messages WHERE conversation_id = ? ORDER BY id DESC LIMIT 1')
    .get(conversationId);
  const lastReadId = me ? me.lastReadMessageId : 0;
  const unread = db
    .prepare(
      `SELECT COUNT(*) AS c FROM messages
       WHERE conversation_id = ? AND id > ? AND sender_id IS NOT ? AND kind != 'system'`
    )
    .get(conversationId, lastReadId, viewerId).c;

  return {
    id: conv.id,
    type: conv.type,
    title: conv.type === 'group' ? conv.title : peer ? peer.displayName : 'گفتگو',
    avatarColor: conv.type === 'group' ? conv.avatar_color : peer ? peer.avatarColor : '#4f7cff',
    peer,
    members,
    memberCount: members.length,
    createdAt: conv.created_at,
    lastMessage: lastRow ? publicMessage(lastRow) : null,
    unread,
    lastReadMessageId: lastReadId,
  };
}

function listConversations(viewerId) {
  return db
    .prepare(
      `SELECT c.id FROM conversations c
       JOIN members m ON m.conversation_id = c.id AND m.user_id = ?
       LEFT JOIN (SELECT conversation_id, MAX(id) AS last_id FROM messages GROUP BY conversation_id) lm
         ON lm.conversation_id = c.id
       ORDER BY COALESCE(lm.last_id, 0) DESC, c.id DESC`
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

function listMessages(conversationId, { before, limit = 40 } = {}) {
  const rows = before
    ? db
        .prepare(`${MESSAGE_SELECT} WHERE m.conversation_id = ? AND m.id < ? ORDER BY m.id DESC LIMIT ?`)
        .all(conversationId, before, limit)
    : db
        .prepare(`${MESSAGE_SELECT} WHERE m.conversation_id = ? ORDER BY m.id DESC LIMIT ?`)
        .all(conversationId, limit);
  return rows.reverse().map(publicMessage);
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
}) {
  const info = db
    .prepare(
      `INSERT INTO messages
         (conversation_id, sender_id, kind, body, file_name, file_mime, file_size,
          image_width, image_height, reply_to_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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

function removeFileOf(messageId) {
  fs.rmSync(filePathFor(messageId), { force: true });
}

function markRead(conversationId, userId, messageId) {
  db.prepare(
    `UPDATE members SET last_read_message_id = ?
     WHERE conversation_id = ? AND user_id = ? AND last_read_message_id < ?`
  ).run(messageId, conversationId, userId, messageId);
}

/* ------------------------------ statistics ---------------------------- */

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
  searchUsers,
  getOrCreateDirect,
  createGroup,
  getConversationRow,
  isMember,
  memberIdsOf,
  membersOf,
  addMember,
  removeMember,
  conversationView,
  listConversations,
  listMessages,
  getMessage,
  createMessage,
  editMessage,
  deleteMessage,
  rawMessage,
  filePathFor,
  removeFileOf,
  markRead,
  stats,
};
