'use strict';

const { WebSocketServer } = require('ws');
const { userForToken } = require('./auth');
const store = require('./store');

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

function setTyping(conversationId, userId, isTyping) {
  if (!typingState.has(conversationId)) typingState.set(conversationId, new Set());
  const set = typingState.get(conversationId);
  if (isTyping) set.add(userId);
  else set.delete(userId);
  if (set.size === 0) typingState.delete(conversationId);
}

function attach(server) {
  const wss = new WebSocketServer({ server, path: '/ws' });

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
      }
    });

    socket.on('close', () => {
      const wentOffline = hub.remove(user.id, socket);
      if (wentOffline) {
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
