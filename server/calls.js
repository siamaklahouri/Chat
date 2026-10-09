'use strict';

const crypto = require('node:crypto');

/**
 * پیکربندی سرورهای ICE برای تماس صوتی.
 *
 * TURN با «اعتبارنامه‌ی موقت» کار می‌کند: به‌جای یک رمز ثابت که اگر لو برود تا
 * ابد قابل سوءاستفاده است، سرور با یک راز مشترک نام کاربری و رمزِ ساعتی تولید
 * می‌کند. خود coturn همان را با همان راز بررسی می‌کند؛ هیچ ارتباط دیگری بین
 * برنامه و coturn لازم نیست.
 */
const TURN_HOST = process.env.TURN_HOST || '';
const TURN_SECRET = process.env.TURN_SECRET || '';
const TURN_TTL_SECONDS = Number(process.env.TURN_TTL_SECONDS || 3600);

function iceServers(userId) {
  const servers = [];
  if (!TURN_HOST) return servers;

  servers.push({ urls: [`stun:${TURN_HOST}:3478`] });

  if (TURN_SECRET) {
    const expiresAt = Math.floor(Date.now() / 1000) + TURN_TTL_SECONDS;
    const username = `${expiresAt}:u${userId}`;
    const credential = crypto
      .createHmac('sha1', TURN_SECRET)
      .update(username)
      .digest('base64');

    servers.push({
      urls: [`turn:${TURN_HOST}:3478?transport=udp`, `turn:${TURN_HOST}:3478?transport=tcp`],
      username,
      credential,
    });
  }

  return servers;
}

const callsEnabled = () => Boolean(TURN_HOST);


/* --------------------------- مدیریت تماس‌های فعال --------------------------- */

/**
 * تماس‌ها فقط در حافظه نگه داشته می‌شوند؛ یک تماس چیزی نیست که بخواهیم بعد از
 * ریستارت سرور ادامه بدهیم. هر تماس تا وقتی جواب داده نشود پس از
 * RING_TIMEOUT_MS خودش بسته می‌شود تا زنگ بی‌پایان نخورد.
 */
const RING_TIMEOUT_MS = 45_000;

/** callId -> { callerId, calleeId, conversationId, answered, startedAt, timer } */
const activeCalls = new Map();
/** userId -> callId (هر کاربر هم‌زمان فقط یک تماس) */
const userCall = new Map();

const newCallId = () => crypto.randomBytes(12).toString('hex');

const callOf = (callId) => activeCalls.get(callId) || null;
const callIdOfUser = (userId) => userCall.get(userId) || null;
const isBusy = (userId) => userCall.has(userId);

/** طرف مقابل این تماس؛ اگر کاربر بخشی از تماس نباشد null برمی‌گردد. */
function peerInCall(call, userId) {
  if (!call) return null;
  if (call.callerId === userId) return call.calleeId;
  if (call.calleeId === userId) return call.callerId;
  return null;
}

function createCall({ callerId, calleeId, conversationId, onTimeout }) {
  const callId = newCallId();
  const timer = setTimeout(() => onTimeout(callId), RING_TIMEOUT_MS);
  timer.unref?.();
  activeCalls.set(callId, {
    id: callId,
    callerId,
    calleeId,
    conversationId,
    answered: false,
    createdAt: Date.now(),
    startedAt: null,
    timer,
  });
  userCall.set(callerId, callId);
  userCall.set(calleeId, callId);
  return callId;
}

function markAnswered(callId) {
  const call = activeCalls.get(callId);
  if (!call || call.answered) return null;
  clearTimeout(call.timer);
  call.timer = null;
  call.answered = true;
  call.startedAt = Date.now();
  return call;
}

/** تماس را می‌بندد و اطلاعاتش را برمی‌گرداند (برای ثبت مدت تماس). */
function endCall(callId) {
  const call = activeCalls.get(callId);
  if (!call) return null;
  if (call.timer) clearTimeout(call.timer);
  activeCalls.delete(callId);
  if (userCall.get(call.callerId) === callId) userCall.delete(call.callerId);
  if (userCall.get(call.calleeId) === callId) userCall.delete(call.calleeId);
  return call;
}

module.exports = {
  iceServers,
  callsEnabled,
  TURN_TTL_SECONDS,
  RING_TIMEOUT_MS,
  createCall,
  callOf,
  callIdOfUser,
  isBusy,
  peerInCall,
  markAnswered,
  endCall,
};
