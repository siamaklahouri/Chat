'use strict';

const fs = require('node:fs');
const { db, getMeta, setMeta, UPLOAD_DIR } = require('./db');

const DAY_MS = 24 * 60 * 60 * 1000;
const CHECK_INTERVAL_MS = 5 * 60 * 1000;

/**
 * پاکسازی خودکار پیش‌فرض خاموش است؛ مدیر هر وقت بخواهد از پنل دستی پاک می‌کند.
 * برای روشن کردنش، تعداد روز را در CLEANUP_INTERVAL_DAYS بگذارید (مثلاً 7).
 */
const INTERVAL_DAYS = Math.max(0, Number(process.env.CLEANUP_INTERVAL_DAYS || 0));
const INTERVAL_MS = INTERVAL_DAYS * DAY_MS;
const isAuto = () => INTERVAL_DAYS > 0;

/**
 * Wipes every message and uploaded image. Accounts, groups, memberships and
 * admin approvals are kept on purpose — only the conversation content goes.
 */
function wipeMessages(reason = 'scheduled') {
  const before = db.prepare('SELECT COUNT(*) AS c FROM messages').get().c;
  const images = db.prepare("SELECT COUNT(*) AS c FROM messages WHERE kind = 'image'").get().c;

  db.exec('DELETE FROM messages');
  db.exec('UPDATE members SET last_read_message_id = 0');

  let removedFiles = 0;
  for (const entry of fs.readdirSync(UPLOAD_DIR, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.startsWith('msg-')) {
      fs.rmSync(`${UPLOAD_DIR}/${entry.name}`, { force: true });
      removedFiles += 1;
    }
  }

  const now = Date.now();
  setMeta('last_wipe_at', now);
  setMeta('last_wipe_reason', reason);
  const result = { at: now, reason, messages: before, images, files: removedFiles };
  console.log(
    `[cleanup] ${reason}: ${before} پیام و ${removedFiles} فایل پاک شد (${new Date(now).toISOString()})`
  );
  return result;
}

const lastWipeAt = () => Number(getMeta('last_wipe_at', 0)) || 0;
const nextWipeAt = () => (isAuto() ? lastWipeAt() + INTERVAL_MS : null);

function wipeStatus() {
  return {
    auto: isAuto(),
    intervalDays: INTERVAL_DAYS,
    lastWipeAt: lastWipeAt() || null,
    lastWipeReason: getMeta('last_wipe_reason', null),
    nextWipeAt: nextWipeAt(),
  };
}

/** وقتی پاکسازی خودکار روشن باشد و موعدش رسیده باشد اجرا می‌کند (عقب‌افتادگی را هم جبران می‌کند). */
function runIfDue() {
  if (!isAuto()) return null;
  if (!lastWipeAt()) {
    setMeta('last_wipe_at', Date.now());
    setMeta('last_wipe_reason', 'initial');
    return null;
  }
  if (Date.now() >= nextWipeAt()) return wipeMessages('scheduled');
  return null;
}

function startScheduler() {
  if (!isAuto()) {
    console.log('پاکسازی خودکار خاموش است — پاکسازی فقط دستی از پنل مدیریت انجام می‌شود.');
    return null;
  }
  runIfDue();
  const timer = setInterval(runIfDue, CHECK_INTERVAL_MS);
  timer.unref?.();
  return timer;
}

module.exports = { wipeMessages, wipeStatus, runIfDue, startScheduler, INTERVAL_DAYS };
