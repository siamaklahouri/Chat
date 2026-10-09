'use strict';

const { WebSocketServer } = require('ws');
const { userForToken } = require('./auth');
const store = require('./store');
const calls = require('./calls');
const { createLimiter } = require('./ratelimit');

/** conversationId -> Set<userId> of users currently typing */
const typingState = new Map();

class Hub {
  constructor() {
    /** userId -> Set<WebSocket> (a user may have several tabs/devices open) */
    this.clients = new Map();
  }

  add(userId, socket) {
    if (!this.clients.has(userId)) this.clients.set(userId, new Set());
    this.clients.get(userId).add(socket);
    return this.clients.get(userId).size === 1; // became online
  }

  remove(userId, socket) {
    const set = this.clients.get(userId);
    if (!set) return false;
    set.delete(socket);
    if (set.size === 0) {
      this.clients.delete(userId);
      return true; // went offline
    }
    return false;
  }

  isOnline(userId) {
    return this.clients.has(userId);
  }

  onlineIds() {
    return [...this.clients.keys()];
  }

  sendToUser(userId, payload) {
    const set = this.clients.get(userId);
    if (!set) return;
    const data = JSON.stringify(payload);
    for (const socket of set) {
      if (socket.readyState === socket.OPEN) socket.send(data);
    }
  }

  sendToUsers(userIds, payload) {
    for (const id of new Set(userIds)) this.sendToUser(id, payload);
  }

  /** Broadcasts to every member of a conversation, optionally skipping one user. */
  sendToConversation(conversationId, payload, exceptUserId = null) {
    const ids = store.memberIdsOf(conversationId).filter((id) => id !== exceptUserId);
    this.sendToUsers(ids, payload);
  }

  /** Pushes an event to every connected client. */
  broadcastAll(payload) {
    this.sendToUsers(this.onlineIds(), payload);
  }

  /** Pushes an event to every admin that is currently connected. */
  notifyAdmins(payload) {
    const admins = store.db
      .prepare('SELECT id FROM users WHERE is_admin = 1')
      .all()
      .map((r) => r.id);
    this.sendToUsers(admins, payload);
  }

  /** Closes every live socket of a user, e.g. after an admin blocks them. */
  disconnectUser(userId, code = 4003, reason = 'session-revoked') {
    const set = this.clients.get(userId);
    if (!set) return;
    for (const socket of [...set]) {
      try {
        socket.close(code, reason);
      } catch {
        /* already gone */
      }
    }
  }

  /** Notifies everyone sharing a conversation with this user that presence changed. */
  broadcastPresence(userId, online) {
    const peers = new Set();
    for (const conv of store.listConversations(userId)) {
      for (const member of conv.members) if (member.id !== userId) peers.add(member.id);
    }
    this.sendToUsers([...peers], {
      type: 'presence',
      userId,
      online,
      lastSeenAt: Date.now(),
    });
  }
}

const hub = new Hub();

/* ------------------------------ تماس صوتی ------------------------------ */

/**
 * سیگنالینگ تماس روی همان وب‌سوکت چت انجام می‌شود: سرور فقط پیام‌های WebRTC را
 * بین دو طرف جابه‌جا می‌کند و صدا از آن عبور نمی‌کند (مستقیم یا از TURN می‌رود).
 * هر پیام سیگنالینگ بررسی می‌شود که فرستنده واقعاً یکی از دو طرف همان تماس است.
 */
const inviteLimiter = createLimiter({ windowMs: 60_000, max: 20 });

const callError = (socket, reason) =>
  socket.send(JSON.stringify({ type: 'call:error', reason }));

/** رکورد تماس را در گفتگو ثبت و برای هر دو طرف می‌فرستد. */
function recordCall(call, status, durationMs = null) {
  try {
    const message = store.createMessage({
      conversationId: call.conversationId,
      senderId: call.callerId,
      kind: 'call',
      body: status,
      file: durationMs == null ? null : { durationMs },
    });
    hub.sendToConversation(call.conversationId, { type: 'message:new', message });
  } catch (error) {
    console.error('[call] ثبت رکورد تماس ناموفق بود:', error.message);
  }
}

/** پایان تماس: ثبت رکورد، خبر دادن به طرفین و پاک کردن از حافظه. */
function finishCall(callId, reason, endedBy = null) {
  const call = calls.endCall(callId);
  if (!call) return;

  if (call.answered) {
    recordCall(call, 'ended', Math.max(0, Date.now() - call.startedAt));
  } else if (reason === 'declined') {
    recordCall(call, 'declined');
  } else {
    recordCall(call, 'missed');
  }

  for (const userId of [call.callerId, call.calleeId]) {
    if (userId === endedBy) continue;
    hub.sendToUser(userId, { type: 'call:ended', callId, reason });
  }
  if (endedBy) hub.sendToUser(endedBy, { type: 'call:ended', callId, reason });
}

function handleCall(msg, user, socket) {
  if (!calls.callsEnabled()) return callError(socket, 'disabled');

  if (msg.type === 'call:invite') {
    if (!Number.isInteger(msg.conversationId)) return;
    const conv = store.getConversationRow(msg.conversationId);
    if (!conv || conv.type !== 'direct') return callError(socket, 'not-direct');
    if (!store.isMember(conv.id, user.id)) return callError(socket, 'forbidden');
    if (!inviteLimiter.consume(`call:${user.id}`).allowed) return callError(socket, 'too-many');

    const peerId = store.memberIdsOf(conv.id).find((id) => id !== user.id);
    if (!peerId) return callError(socket, 'no-peer');
    if (calls.isBusy(user.id)) return callError(socket, 'already-in-call');
    if (calls.isBusy(peerId)) return callError(socket, 'busy');
    if (!hub.isOnline(peerId)) return callError(socket, 'offline');

    const callId = calls.createCall({
      callerId: user.id,
      calleeId: peerId,
      conversationId: conv.id,
      onTimeout: (id) => finishCall(id, 'timeout'),
    });
    hub.sendToUser(user.id, {
      type: 'call:ringing',
      callId,
      conversationId: conv.id,
      peerId,
      timeoutMs: calls.RING_TIMEOUT_MS,
    });
    hub.sendToUser(peerId, {
      type: 'call:incoming',
      callId,
      conversationId: conv.id,
      from: store.publicUser(store.getUserById(user.id)),
      timeoutMs: calls.RING_TIMEOUT_MS,
    });
    return;
  }

  if (typeof msg.callId !== 'string') return;
  const call = calls.callOf(msg.callId);
  if (!call) return callError(socket, 'gone');
  const peerId = calls.peerInCall(call, user.id);
  if (!peerId) return callError(socket, 'forbidden');

  switch (msg.type) {
    case 'call:accept': {
      // فقط گیرنده می‌تواند جواب بدهد، و فقط یک بار.
      if (call.calleeId !== user.id) return callError(socket, 'forbidden');
      if (!calls.markAnswered(call.id)) return;
      hub.sendToUser(call.callerId, { type: 'call:accepted', callId: call.id });
      // سایر دستگاه‌های گیرنده دیگر زنگ نزنند.
      hub.sendToUser(call.calleeId, { type: 'call:answered-elsewhere', callId: call.id });
      break;
    }
    case 'call:decline':
      if (call.calleeId !== user.id) return callError(socket, 'forbidden');
      finishCall(call.id, 'declined', user.id);
      break;
    case 'call:end':
      finishCall(call.id, call.answered ? 'hangup' : 'cancelled', user.id);
      break;
    case 'call:signal':
      // محتوای سیگنال برای سرور بی‌معناست؛ فقط عیناً منتقل می‌شود.
      if (!msg.data || typeof msg.data !== 'object') return;
      hub.sendToUser(peerId, { type: 'call:signal', callId: call.id, data: msg.data });
      break;
    default:
      break;
  }
}

function setTyping(conversationId, userId, isTyping) {
  if (!typingState.has(conversationId)) typingState.set(conversationId, new Set());
  const set = typingState.get(conversationId);
  if (isTyping) set.add(userId);
  else set.delete(userId);
  if (set.size === 0) typingState.delete(conversationId);
}

function attach(server) {
  const wss = new WebSocketServer({
    server,
    path: '/ws',
    // کلاینت فقط رویدادهای کوچک (در حال نوشتن و سیگنالینگ تماس) می‌فرستد؛ بدون
    // این سقف، یک اتصال می‌توانست با فریم‌های عظیم حافظه‌ی سرور را پر کند.
    // SDP تماس صوتی چند کیلوبایت است، پس سقف را دست‌ودل‌بازتر اما بسته می‌گیریم.
    maxPayload: 64 * 1024,
    verifyClient: ({ origin, req }, done) => {
      // اتصال از صفحه‌ی سایت دیگر پذیرفته نمی‌شود. (کلاینت‌های غیرمرورگری
      // مثل اپ اندروید اصلاً هدر Origin نمی‌فرستند و مجازند.)
      if (!origin) return done(true);
      const host = req.headers.host;
      let ok = false;
      try {
        ok = new URL(origin).host === host;
      } catch {
        ok = false;
      }
      done(ok, 403, 'origin not allowed');
    },
  });

  wss.on('connection', (socket, req) => {
    const url = new URL(req.url, 'http://localhost');
    const user = userForToken(url.searchParams.get('token'));
    if (!user) {
      socket.close(4001, 'unauthorized');
      return;
    }
    if (user.status !== 'approved') {
      socket.close(4003, user.status === 'blocked' ? 'blocked' : 'pending');
      return;
    }

    socket.userId = user.id;
    socket.isAlive = true;
    const becameOnline = hub.add(user.id, socket);
    store.touchUser(user.id);
    if (becameOnline) hub.broadcastPresence(user.id, true);

    socket.send(JSON.stringify({ type: 'ready', userId: user.id, online: hub.onlineIds() }));

    socket.on('pong', () => {
      socket.isAlive = true;
    });

    socket.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (msg.type === 'typing' && Number.isInteger(msg.conversationId)) {
        if (!store.isMember(msg.conversationId, user.id)) return;
        setTyping(msg.conversationId, user.id, Boolean(msg.isTyping));
        hub.sendToConversation(
          msg.conversationId,
          {
            type: 'typing',
            conversationId: msg.conversationId,
            userId: user.id,
            displayName: user.display_name,
            isTyping: Boolean(msg.isTyping),
          },
          user.id
        );
        return;
      }
      if (typeof msg.type === 'string' && msg.type.startsWith('call:')) {
        handleCall(msg, user, socket);
      }
    });

    socket.on('close', () => {
      const wentOffline = hub.remove(user.id, socket);
      if (wentOffline) {
        // آخرین دستگاه کاربر رفت: اگر وسط تماس بود، تماس را ببند.
        const callId = calls.callIdOfUser(user.id);
        if (callId) finishCall(callId, 'disconnected', user.id);
        store.touchUser(user.id);
        hub.broadcastPresence(user.id, false);
      }
    });
  });

  // Drop dead connections so presence does not go stale.
  const heartbeat = setInterval(() => {
    for (const socket of wss.clients) {
      if (!socket.isAlive) {
        socket.terminate();
        continue;
      }
      socket.isAlive = false;
      socket.ping();
    }
  }, 30000);
  heartbeat.unref?.();

  wss.on('close', () => clearInterval(heartbeat));
  return wss;
}

module.exports = { hub, attach };
