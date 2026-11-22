#!/usr/bin/env node
/*
 * مهاجرت پایگاه‌داده را روی یک پایگاه‌داده‌ی «قدیمی» می‌آزماید.
 *
 * انگیزه‌اش واقعی است: جدول پیام‌ها برای عوض کردن CHECK بازسازی می‌شود، و یک
 * بار ستونی که با ALTER اضافه شده بود در تعریف جدول تازه نبود — یعنی سرویس
 * با ری‌استارت بعدی اصلاً بالا نمی‌آمد و داده‌ها کپی نمی‌شدند.
 *
 *   node test/migration.test.js
 */
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'migrate-'));
const DB_FILE = path.join(TMP, 'old.db');
const ok = (label) => console.log(`✓ ${label}`);

/** پایگاه‌داده‌ای دقیقاً به شکل نسخه‌ی پیش از پشتیبانی از فایل. */
function buildOldDatabase() {
  const db = new DatabaseSync(DB_FILE);
  db.exec(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL UNIQUE,
      display_name TEXT NOT NULL, password_hash TEXT NOT NULL, bio TEXT,
      avatar_color TEXT NOT NULL DEFAULT '#4b3bff',
      status TEXT NOT NULL DEFAULT 'pending', is_admin INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL,
      reviewed_at INTEGER, reviewed_by INTEGER, avatar_at INTEGER
    );
    CREATE TABLE sessions (
      token TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL
    );
    CREATE TABLE conversations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL CHECK (type IN ('direct','group')), title TEXT,
      avatar_color TEXT NOT NULL DEFAULT '#4b3bff', direct_key TEXT UNIQUE,
      created_by INTEGER, created_at INTEGER NOT NULL, avatar_at INTEGER
    );
    CREATE TABLE members (
      conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      role TEXT NOT NULL DEFAULT 'member', joined_at INTEGER NOT NULL,
      last_read_message_id INTEGER NOT NULL DEFAULT 0,
      cleared_up_to_id INTEGER NOT NULL DEFAULT 0, hidden INTEGER NOT NULL DEFAULT 0,
      pinned_at INTEGER, muted INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (conversation_id, user_id)
    );
    CREATE TABLE messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      sender_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      kind TEXT NOT NULL DEFAULT 'text' CHECK (kind IN ('text','image','voice','call','system')),
      body TEXT NOT NULL DEFAULT '', file_name TEXT, file_mime TEXT, file_size INTEGER,
      image_width INTEGER, image_height INTEGER, duration_ms INTEGER,
      forwarded INTEGER NOT NULL DEFAULT 0,
      reply_to_id INTEGER REFERENCES messages(id) ON DELETE SET NULL,
      created_at INTEGER NOT NULL, edited_at INTEGER, deleted_at INTEGER
    );
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
  `);

  const now = Date.now();
  db.prepare(
    `INSERT INTO users (id, username, display_name, password_hash, avatar_color, status, created_at, last_seen_at)
     VALUES (1, 'kaveh', 'کاوه', 'x', '#f00', 'approved', ?, ?), (2, 'mina', 'مینا', 'y', '#0f0', 'approved', ?, ?)`
  ).run(now, now, now, now);
  db.prepare(
    "INSERT INTO conversations (id, type, direct_key, created_by, created_at) VALUES (1, 'direct', '1:2', 1, ?)"
  ).run(now);
  db.prepare('INSERT INTO members (conversation_id, user_id, role, joined_at) VALUES (1,1,?,?),(1,2,?,?)')
    .run('member', now, 'member', now);

  const insert = db.prepare(
    'INSERT INTO messages (conversation_id, sender_id, kind, body, forwarded, created_at) VALUES (?, ?, ?, ?, ?, ?)'
  );
  insert.run(1, 1, 'text', 'پیام اول', 0, now);
  insert.run(1, 2, 'text', 'پیام بازفرستاده', 1, now + 1);
  insert.run(1, 1, 'call', 'ended', 0, now + 2);
  db.close();
}

buildOldDatabase();
ok('پایگاه‌داده‌ی نسخه‌ی قبلی ساخته شد');

process.env.DATA_DIR = TMP;
process.env.DB_FILE = DB_FILE;
const { db } = require('../server/db.js');
ok('db.js بدون خطا بالا آمد (مهاجرت اجرا شد)');

const schema = db
  .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'messages'")
  .get().sql;
assert.ok(schema.includes("'file'"), 'نوع file باید به CHECK اضافه شده باشد');
ok('نوع file به جدول پیام‌ها اضافه شد');

const columns = db.prepare('PRAGMA table_info(messages)').all().map((c) => c.name);
assert.ok(columns.includes('forwarded'), 'ستون forwarded نباید در بازسازی گم می‌شد');
ok('ستون forwarded سر جایش ماند');

const rows = db.prepare('SELECT * FROM messages ORDER BY id').all();
assert.equal(rows.length, 3, 'هر سه پیام باید کپی شده باشند');
assert.equal(rows[0].body, 'پیام اول');
assert.equal(rows[1].forwarded, 1, 'مقدار forwarded باید حفظ شده باشد');
assert.equal(rows[2].kind, 'call');
ok('هر سه پیام با مقدارهایشان منتقل شدند');

// نوع تازه باید پذیرفته شود و نوع نامعتبر رد
db.prepare(
  "INSERT INTO messages (conversation_id, sender_id, kind, body, created_at) VALUES (1, 1, 'file', 'x', ?)"
).run(Date.now());
ok('پیام از نوع file پذیرفته می‌شود');

assert.throws(
  () =>
    db
      .prepare("INSERT INTO messages (conversation_id, sender_id, kind, body, created_at) VALUES (1, 1, 'virus', 'x', ?)")
      .run(Date.now()),
  'نوع ناشناخته باید رد شود'
);
ok('نوع ناشناخته همچنان رد می‌شود');

for (const table of ['reactions', 'blocks', 'admin_log']) {
  assert.ok(
    db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table),
    `جدول ${table} ساخته نشد`
  );
}
for (const [table, column] of [['sessions', 'user_agent'], ['sessions', 'last_seen_at']]) {
  const names = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  assert.ok(names.includes(column), `${table}.${column} اضافه نشد`);
}
ok('جدول‌ها و ستون‌های بقیه‌ی مهاجرت‌ها هم ساخته شدند');

db.close();
fs.rmSync(TMP, { recursive: true, force: true });
console.log('\n✅ مهاجرت روی پایگاه‌داده‌ی قدیمی سالم است.');
