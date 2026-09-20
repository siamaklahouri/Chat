'use strict';

const fs = require('node:fs');
const { db, getMeta, setMeta, UPLOAD_DIR } = require('./db');

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const CHECK_INTERVAL_MS = 5 * 60 * 1000;

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
const nextWipeAt = () => lastWipeAt() + WEEK_MS;

function wipeStatus() {
  return {
    lastWipeAt: lastWipeAt() || null,
    lastWipeReason: getMeta('last_wipe_reason', null),
    nextWipeAt: nextWipeAt(),
    intervalDays: 7,
  };
}

/** Runs the wipe when a full week has passed; also catches up after downtime. */
function runIfDue() {
  if (!lastWipeAt()) {
    setMeta('last_wipe_at', Date.now());
    setMeta('last_wipe_reason', 'initial');
    return null;
  }
  if (Date.now() >= nextWipeAt()) return wipeMessages('scheduled');
  return null;
}

function startScheduler() {
  runIfDue();
  const timer = setInterval(runIfDue, CHECK_INTERVAL_MS);
  timer.unref?.();
  return timer;
}

module.exports = { wipeMessages, wipeStatus, runIfDue, startScheduler, WEEK_MS };
