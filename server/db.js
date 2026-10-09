'use strict';

const { DatabaseSync } = require('node:sqlite');
const path = require('node:path');
const fs = require('node:fs');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(DATA_DIR, 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const db = new DatabaseSync(process.env.DB_FILE || path.join(DATA_DIR, 'chat.db'));

db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT NOT NULL UNIQUE,
  display_name  TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  bio           TEXT NOT NULL DEFAULT '',
  avatar_color  TEXT NOT NULL DEFAULT '#4f7cff',
  status        TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','blocked')),
  is_admin      INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL,
  reviewed_at   INTEGER,
  reviewed_by   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  last_seen_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS conversations (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  type         TEXT NOT NULL CHECK (type IN ('direct','group')),
  title        TEXT,
  avatar_color TEXT NOT NULL DEFAULT '#8b5cf6',
  direct_key   TEXT UNIQUE,
  created_by   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS members (
  conversation_id      INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  user_id              INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role                 TEXT NOT NULL DEFAULT 'member',
  joined_at            INTEGER NOT NULL,
  last_read_message_id INTEGER NOT NULL DEFAULT 0,
  cleared_up_to_id     INTEGER NOT NULL DEFAULT 0,
  hidden               INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (conversation_id, user_id)
);

CREATE TABLE IF NOT EXISTS messages (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  sender_id       INTEGER REFERENCES users(id) ON DELETE SET NULL,
  kind            TEXT NOT NULL DEFAULT 'text' CHECK (kind IN ('text','image','voice','system')),
  body            TEXT NOT NULL DEFAULT '',
  file_name       TEXT,
  file_mime       TEXT,
  file_size       INTEGER,
  image_width     INTEGER,
  image_height    INTEGER,
  duration_ms     INTEGER,
  reply_to_id     INTEGER REFERENCES messages(id) ON DELETE SET NULL,
  created_at      INTEGER NOT NULL,
  edited_at       INTEGER,
  deleted_at      INTEGER
);

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conversation_id, id);
CREATE INDEX IF NOT EXISTS idx_members_user ON members(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_users_status ON users(status);
`);

// مهاجرت‌ها: CREATE TABLE IF NOT EXISTS ستون تازه را به جدول موجود اضافه نمی‌کند،
// پس برای پایگاه‌داده‌هایی که از قبل ساخته شده‌اند دستی اضافه می‌شوند.
for (const [table, column, definition] of [
  ['members', 'cleared_up_to_id', 'INTEGER NOT NULL DEFAULT 0'],
  ['members', 'hidden', 'INTEGER NOT NULL DEFAULT 0'],
  ['messages', 'duration_ms', 'INTEGER'],
]) {
  const existing = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  if (!existing.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

/*
 * افزودن نوع «voice» به پیام‌ها.
 *
 * SQLite اجازه‌ی تغییر یک CHECK را نمی‌دهد، پس جدول باید بازسازی شود: ساخت
 * جدول تازه، کپی داده‌ها، حذف قدیمی و تغییر نام. همه داخل یک تراکنش انجام
 * می‌شود تا اگر وسط کار چیزی خطا داد، داده‌ها دست‌نخورده بمانند.
 */
const messagesSchema =
  db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'messages'").get()?.sql ||
  '';

if (messagesSchema && !messagesSchema.includes("'voice'")) {
  const columns = db
    .prepare('PRAGMA table_info(messages)')
    .all()
    .map((c) => c.name)
    .join(', ');

  db.exec('PRAGMA foreign_keys = OFF');
  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec(`
      CREATE TABLE messages_rebuilt (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        sender_id       INTEGER REFERENCES users(id) ON DELETE SET NULL,
        kind            TEXT NOT NULL DEFAULT 'text' CHECK (kind IN ('text','image','voice','system')),
        body            TEXT NOT NULL DEFAULT '',
        file_name       TEXT,
        file_mime       TEXT,
        file_size       INTEGER,
        image_width     INTEGER,
        image_height    INTEGER,
        duration_ms     INTEGER,
        reply_to_id     INTEGER REFERENCES messages(id) ON DELETE SET NULL,
        created_at      INTEGER NOT NULL,
        edited_at       INTEGER,
        deleted_at      INTEGER
      );
      INSERT INTO messages_rebuilt (${columns}) SELECT ${columns} FROM messages;
      DROP TABLE messages;
      ALTER TABLE messages_rebuilt RENAME TO messages;
      CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conversation_id, id);
    `);
    db.exec('COMMIT');
    console.log('[db] جدول پیام‌ها برای پشتیبانی از پیام صوتی بازسازی شد.');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
  }
}

const getMeta = (key, fallback = null) => {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key);
  return row ? row.value : fallback;
};

const setMeta = (key, value) => {
  db.prepare(
    'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).run(key, String(value));
};

module.exports = { db, DATA_DIR, UPLOAD_DIR, getMeta, setMeta };
