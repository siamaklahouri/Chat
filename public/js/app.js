/* 9chat — منطق سمت کاربر */
(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const TOKEN_KEY = 'messenger.token';
  const MAX_IMAGE_EDGE = 1600; // عکس‌ها پیش از آپلود تا این اندازه کوچک می‌شوند
  const IMAGE_QUALITY = 0.82;

  const state = {
    token: localStorage.getItem(TOKEN_KEY) || null,
    me: null,
    conversations: new Map(),
    activeId: null,
    messages: [],
    hasMore: false,
    loadingMore: false,
    replyTo: null,
    editing: null,
    pendingImage: null,
    recorder: null,
    recordStartedAt: 0,
    recordTimer: null,
    typingPeers: new Map(),
    missedWhileUp: 0,
    typingTimer: null,
    typingSentAt: 0,
    socket: null,
    fileToken: null,
    call: null,
    callEnabled: false,
    reconnectDelay: 1000,
    filter: '',
  };

  /* ------------------------------ ابزارها ------------------------------ */

  const fa = (n) => Number(n).toLocaleString('fa-IR');
  const initials = (name) => (name || '?').trim().charAt(0).toUpperCase();

  const timeText = (ts) =>
    new Date(ts).toLocaleTimeString('fa-IR', { hour: '2-digit', minute: '2-digit' });

  const dayText = (ts) => {
    const date = new Date(ts);
    const today = new Date();
    const yesterday = new Date(Date.now() - 86400000);
    const same = (a, b) => a.toDateString() === b.toDateString();
    if (same(date, today)) return 'امروز';
    if (same(date, yesterday)) return 'دیروز';
    return date.toLocaleDateString('fa-IR', { year: 'numeric', month: 'long', day: 'numeric' });
  };

  const relativeTime = (ts) => {
    if (!ts) return '';
    const diff = Date.now() - ts;
    if (diff < 60000) return 'همین حالا';
    if (diff < 3600000) return `${fa(Math.floor(diff / 60000))} دقیقه پیش`;
    if (diff < 86400000) return `${fa(Math.floor(diff / 3600000))} ساعت پیش`;
    return `${fa(Math.floor(diff / 86400000))} روز پیش`;
  };

  const fileSize = (bytes) => {
    if (!bytes) return '';
    const units = ['بایت', 'کیلوبایت', 'مگابایت'];
    let value = bytes;
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) {
      value /= 1024;
      unit += 1;
    }
    return `${fa(value.toFixed(unit ? 1 : 0))} ${units[unit]}`;
  };

  function toast(message, isError = false) {
    const el = $('toast');
    el.textContent = message;
    el.classList.toggle('error', isError);
    el.classList.remove('is-hidden');
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => el.classList.add('is-hidden'), 3200);
  }

  function paintAvatar(el, name, color, online) {
    el.textContent = initials(name);
    el.style.background = color || 'var(--accent)';
    el.classList.toggle('online', Boolean(online));
  }

  /**
   * نشانی فایل با توکن کوتاه‌عمرِ مخصوص فایل ساخته می‌شود — نه با توکن نشست،
   * چون توکن نشست در لاگ و تاریخچه می‌نشیند و دسترسی کامل به حساب می‌دهد.
   */
  const fileUrl = (url) => `${url}?t=${encodeURIComponent(state.fileToken || '')}`;

  /* -------------------------------- API -------------------------------- */

  async function api(path, { method = 'GET', body, raw } = {}) {
    const headers = {};
    if (state.token) headers.Authorization = `Bearer ${state.token}`;
    if (body && !raw) headers['Content-Type'] = 'application/json';

    const res = await fetch(`/api${path}`, {
      method,
      headers,
      body: raw ? body : body ? JSON.stringify(body) : undefined,
    });

    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const error = new Error(data.error || 'خطای ناشناخته');
      error.status = res.status;
      error.code = data.code;
      throw error;
    }
    return data;
  }

  /* ------------------------------ احراز هویت ---------------------------- */

  function setAuthMessage(text, kind = '') {
    const el = $('authMessage');
    el.textContent = text;
    el.className = `auth-message ${kind}`;
  }

  document.querySelectorAll('[data-auth-tab]').forEach((tab) => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('[data-auth-tab]').forEach((t) => t.classList.remove('is-active'));
      tab.classList.add('is-active');
      const isLogin = tab.dataset.authTab === 'login';
      $('loginForm').classList.toggle('is-hidden', !isLogin);
      $('registerForm').classList.toggle('is-hidden', isLogin);
      setAuthMessage('');
    });
  });

  $('loginForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = new FormData(event.target);
    setAuthMessage('در حال ورود…');
    try {
      const data = await api('/auth/login', {
        method: 'POST',
        body: { username: form.get('username'), password: form.get('password') },
      });
      state.token = data.token;
      state.fileToken = data.fileToken || null;
      localStorage.setItem(TOKEN_KEY, data.token);
      setAuthMessage('');
      await startApp(data.user);
    } catch (err) {
      setAuthMessage(err.message, 'error');
    }
  });

  $('registerForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = new FormData(event.target);
    setAuthMessage('در حال ثبت‌نام…');
    try {
      const data = await api('/auth/register', {
        method: 'POST',
        body: {
          username: form.get('username'),
          displayName: form.get('displayName'),
          password: form.get('password'),
        },
      });
      if (data.pending) {
        event.target.reset();
        setAuthMessage(data.message, 'ok');
        return;
      }
      state.token = data.token;
      state.fileToken = data.fileToken || null;
      localStorage.setItem(TOKEN_KEY, data.token);
      setAuthMessage('');
      await startApp(data.user);
    } catch (err) {
      setAuthMessage(err.message, 'error');
    }
  });

  function signOut(message) {
    state.token = null;
    state.me = null;
    state.activeId = null;
    state.conversations.clear();
    localStorage.removeItem(TOKEN_KEY);
    if (state.socket) {
      state.socket.onclose = null;
      state.socket.close();
      state.socket = null;
    }
    $('appScreen').classList.add('is-hidden');
    $('authScreen').classList.remove('is-hidden');
    if (message) setAuthMessage(message, 'error');
  }

  /* ------------------------------ گفتگوها ------------------------------ */

  function conversationSubtitle(conv) {
    const message = conv.lastMessage;
    if (!message) return 'هنوز پیامی رد و بدل نشده';
    const prefix = message.senderId === state.me.id ? 'شما: ' : '';
    if (message.deleted) return `${prefix}پیام حذف شد`;
    if (message.kind === 'system') return message.body;
    if (message.kind === 'image') return `${prefix}🖼 عکس${message.body ? ` — ${message.body}` : ''}`;
    if (message.kind === 'voice') return `${prefix}🎤 پیام صوتی`;
    if (message.kind === 'call') return `📞 ${callRecordText(message)}`;
    return prefix + message.body;
  }

  function renderConversations() {
    const list = $('conversationList');
    const filter = state.filter.trim().toLowerCase();
    const items = [...state.conversations.values()]
      .filter((conv) => !filter || conv.title.toLowerCase().includes(filter))
      .sort((a, b) => (b.lastMessage?.id || 0) - (a.lastMessage?.id || 0));

    list.innerHTML = '';
    if (items.length === 0) {
      list.innerHTML = `<p class="empty-list">${
        filter ? 'گفتگویی پیدا نشد.' : 'هنوز گفتگویی ندارید. با دکمه + شروع کنید.'
      }</p>`;
      return;
    }

    for (const conv of items) {
      const button = document.createElement('button');
      button.className = `conversation${conv.id === state.activeId ? ' is-active' : ''}`;
      button.innerHTML = `
        <span class="avatar"></span>
        <span class="conversation-main">
          <span class="conversation-top">
            <span class="conversation-name"></span>
            <small class="muted"></small>
          </span>
          <span class="conversation-top">
            <span class="conversation-preview"></span>
          </span>
        </span>`;
      const online = conv.type === 'direct' && conv.peer?.online;
      paintAvatar(button.querySelector('.avatar'), conv.title, conv.avatarColor, online);
      button.querySelector('.conversation-name').textContent = conv.title;
      button.querySelector('.conversation-top small').textContent = conv.lastMessage
        ? timeText(conv.lastMessage.createdAt)
        : '';
      button.querySelector('.conversation-preview').textContent = conversationSubtitle(conv);
      if (conv.unread > 0) {
        const badge = document.createElement('span');
        badge.className = 'badge';
        badge.textContent = fa(conv.unread);
        button.querySelector('.conversation-main').lastElementChild.appendChild(badge);
      }
      button.addEventListener('click', () => openConversation(conv.id));
      list.appendChild(button);
    }
  }

  async function loadConversations() {
    const data = await api('/conversations');
    state.conversations = new Map(data.conversations.map((conv) => [conv.id, conv]));
    renderConversations();
  }

  function upsertConversation(conv) {
    state.conversations.set(conv.id, conv);
    renderConversations();
  }

  /* ------------------------------- پیام‌ها ------------------------------ */

  function chatStatusText(conv) {
    if (conv.type === 'group') return `${fa(conv.memberCount)} عضو`;
    if (!conv.peer) return 'این حساب دیگر وجود ندارد';
    return conv.peer.online ? 'آنلاین' : `آخرین بازدید ${relativeTime(conv.peer.lastSeenAt)}`;
  }

  function renderChatHeader() {
    const conv = state.conversations.get(state.activeId);
    if (!conv) return;
    paintAvatar(
      $('chatAvatar'),
      conv.title,
      conv.avatarColor,
      conv.type === 'direct' && conv.peer?.online
    );
    $('chatName').textContent = conv.title;
    $('chatStatus').textContent = chatStatusText(conv);
    // تماس فقط در گفتگوی دونفره، و فقط اگر سرور TURN تنظیم شده باشد.
    const callable = state.callEnabled && conv.type === 'direct' && Boolean(conv.peer);
    $('callBtn').classList.toggle('is-hidden', !callable);
  }

  function senderName(senderId) {
    const conv = state.conversations.get(state.activeId);
    const member = conv?.members.find((m) => m.id === senderId);
    return member ? member.displayName : 'کاربر حذف‌شده';
  }

  /** بیشترین شناسه پیامی که همه‌ی طرف‌های گفتگو خوانده‌اند */
  function readUpTo() {
    const conv = state.conversations.get(state.activeId);
    if (!conv) return 0;
    const others = conv.members.filter((m) => m.id !== state.me.id);
    if (others.length === 0) return 0;
    return Math.min(...others.map((m) => m.lastReadMessageId || 0));
  }

  function buildBubble(message, grouped) {
    const mine = message.senderId === state.me.id;
    const row = document.createElement('div');
    row.className = `message-row ${mine ? 'mine' : 'theirs'}`;
    row.dataset.id = message.id;

    const bubble = document.createElement('div');
    // پیامی که فقط عکس است، بدون حاشیه نشان داده می‌شود تا قاب‌مانند نشود.
    const mediaOnly = message.kind === 'image' && !message.body && !message.replyTo && !message.deleted;
    bubble.className = `bubble${grouped ? ' grouped' : ''}${mediaOnly ? ' media' : ''}`;

    const conv = state.conversations.get(state.activeId);
    if (!mine && conv?.type === 'group' && !grouped) {
      const author = document.createElement('div');
      author.className = 'bubble-author';
      author.textContent = senderName(message.senderId);
      bubble.appendChild(author);
    }

    if (message.replyTo) {
      const reply = document.createElement('div');
      reply.className = 'bubble-reply';
      const who = document.createElement('small');
      who.textContent = senderName(message.replyTo.senderId);
      const text = document.createElement('span');
      text.textContent = message.replyTo.deleted
        ? 'پیام حذف شد'
        : message.replyTo.kind === 'image'
          ? `🖼 عکس${message.replyTo.body ? ` — ${message.replyTo.body}` : ''}`
          : message.replyTo.kind === 'voice'
            ? '🎤 پیام صوتی'
            : message.replyTo.body;
      reply.append(who, text);
      reply.addEventListener('click', () => scrollToMessage(message.replyTo.id));
      bubble.appendChild(reply);
    }

    if (message.kind === 'image' && message.attachment) {
      const button = document.createElement('button');
      button.className = 'bubble-image';
      button.type = 'button';
      const { width, height } = message.attachment;
      // نسبت ابعاد را از قبل می‌دهیم تا موقع بارگذاری عکس، چیدمان نپرد.
      if (width && height) button.style.aspectRatio = `${width} / ${height}`;
      const img = document.createElement('img');
      img.loading = 'lazy';
      img.decoding = 'async';
      img.alt = message.attachment.name || 'عکس';
      img.src = fileUrl(message.attachment.url);
      button.appendChild(img);
      button.addEventListener('click', () => openLightbox(message.attachment));
      bubble.appendChild(button);
    }

    if (message.kind === 'voice' && message.attachment) {
      bubble.appendChild(voicePlayer(message));
    }

    if (message.body || message.deleted) {
      const text = document.createElement('div');
      text.className = `bubble-text${message.deleted ? ' deleted' : ''}`;
      text.textContent = message.deleted ? 'این پیام حذف شد' : message.body;
      bubble.appendChild(text);
    }

    const meta = document.createElement('div');
    meta.className = 'bubble-meta';
    const time = document.createElement('span');
    time.textContent = timeText(message.createdAt);
    meta.appendChild(time);
    if (message.editedAt && !message.deleted) {
      const edited = document.createElement('span');
      edited.textContent = '(ویرایش‌شده)';
      meta.appendChild(edited);
    }
    if (mine && !message.deleted) {
      const state = message.pending ? 'pending' : message.id <= readUpTo() ? 'read' : 'sent';
      meta.appendChild(tickIcon(state));
    }
    bubble.appendChild(meta);

    if (!message.deleted && !message.pending) {
      const actions = document.createElement('div');
      actions.className = 'bubble-actions';
      actions.appendChild(iconButton('↩', 'پاسخ', () => startReply(message)));
      if (mine && message.kind !== 'voice') {
        actions.appendChild(iconButton('✎', 'ویرایش', () => startEdit(message)));
      }
      if (mine) {
        actions.appendChild(iconButton('🗑', 'حذف', () => removeMessage(message)));
      }
      bubble.appendChild(actions);
      bubble.addEventListener('contextmenu', (event) => {
        event.preventDefault();
        document.querySelectorAll('.bubble.show-actions').forEach((b) => b.classList.remove('show-actions'));
        bubble.classList.add('show-actions');
      });
    }

    if (message.pending) bubble.style.opacity = '.6';
    row.appendChild(bubble);
    return row;
  }

  const clockText = (ms) => {
    const total = Math.round((ms || 0) / 1000);
    return `${fa(Math.floor(total / 60))}:${String(total % 60).padStart(2, '0').replace(/\d/g, (d) => fa(d))}`;
  };

  /** متن رکورد تماس در گفتگو؛ فرستنده‌ی رکورد همیشه تماس‌گیرنده است. */
  function callRecordText(message) {
    const mine = message.senderId === state.me?.id;
    if (message.body === 'ended') return `تماس صوتی · ${clockText(message.durationMs)}`;
    if (message.body === 'declined') return mine ? 'تماس رد شد' : 'تماس را رد کردید';
    return mine ? 'تماس بی‌پاسخ' : 'تماس بی‌پاسخ';
  }

  /** پخش‌کننده‌ی پیام صوتی: دکمه‌ی پخش، نوار پیشرفت و زمان. */
  function voicePlayer(message) {
    const wrap = document.createElement('div');
    wrap.className = 'voice';

    // المان صدا داخل خود حباب می‌نشیند (نه فقط در حافظه)، وگرنه منطق
    // «هر بار فقط یک صدا» که روی document کار می‌کند آن را پیدا نمی‌کند.
    const audio = document.createElement('audio');
    audio.src = fileUrl(message.attachment.url);
    audio.preload = 'none';
    audio.hidden = true;

    const play = document.createElement('button');
    play.type = 'button';
    play.className = 'voice-play';
    play.setAttribute('aria-label', 'پخش پیام صوتی');
    const setIcon = (playing) => {
      play.innerHTML = playing
        ? '<svg viewBox="0 0 24 24"><path fill="currentColor" d="M6 5h4v14H6zm8 0h4v14h-4z"/></svg>'
        : '<svg viewBox="0 0 24 24"><path fill="currentColor" d="M8 5v14l11-7z"/></svg>';
    };
    setIcon(false);

    const track = document.createElement('div');
    track.className = 'voice-track';
    const fill = document.createElement('div');
    fill.className = 'voice-fill';
    track.appendChild(fill);

    const time = document.createElement('span');
    time.className = 'voice-time';
    time.textContent = clockText(message.attachment.durationMs);

    play.addEventListener('click', () => {
      if (audio.paused) {
        // هر بار فقط یک صدا پخش شود.
        document.querySelectorAll('audio').forEach((other) => other !== audio && other.pause());
        audio.play().catch(() => toast('پخش صدا ممکن نشد.', true));
      } else {
        audio.pause();
      }
    });

    audio.addEventListener('play', () => setIcon(true));
    audio.addEventListener('pause', () => setIcon(false));
    audio.addEventListener('timeupdate', () => {
      const total = audio.duration || (message.attachment.durationMs || 0) / 1000;
      if (total > 0) fill.style.width = `${Math.min(100, (audio.currentTime / total) * 100)}%`;
      time.textContent = clockText(audio.currentTime * 1000);
    });
    audio.addEventListener('ended', () => {
      setIcon(false);
      fill.style.width = '0%';
      time.textContent = clockText(message.attachment.durationMs);
    });

    track.addEventListener('click', (event) => {
      const total = audio.duration;
      if (!total) return;
      const box = track.getBoundingClientRect();
      // صفحه راست‌چین است، ولی نوار پیشرفت از چپ پر می‌شود.
      const ratio = (event.clientX - box.left) / box.width;
      audio.currentTime = Math.min(Math.max(ratio, 0), 1) * total;
    });

    wrap.append(play, track, time, audio);
    return wrap;
  }

  /** آیکون وضعیت پیام: در حال ارسال → ارسال شد → خوانده شد. */
  function tickIcon(state) {
    const span = document.createElement('span');
    span.className = `tick tick-${state}`;
    span.title = { pending: 'در حال ارسال', sent: 'ارسال شد', read: 'خوانده شد' }[state];

    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 22 22');
    svg.setAttribute('aria-hidden', 'true');

    const draw = (d) => {
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('d', d);
      svg.appendChild(path);
    };

    if (state === 'pending') {
      draw('M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14');
      draw('M11 7.5V11l2.5 2');
    } else if (state === 'sent') {
      draw('M4 11.5 L8.5 16 L18 5.5');
    } else {
      draw('M1.5 11.5 L6 16 L14 5.5');
      draw('M9 11.5 L13.5 16 L21.5 5.5');
    }

    span.appendChild(svg);
    return span;
  }

  function iconButton(label, title, onClick) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = label;
    button.title = title;
    button.addEventListener('click', onClick);
    return button;
  }

  function renderMessages({ keepScroll = false, toBottom = null } = {}) {
    const list = $('messageList');
    const previousHeight = list.scrollHeight;
    const previousTop = list.scrollTop;
    // اگر کاربر بالا رفته و دارد تاریخچه می‌خواند، پیام تازه نباید صفحه را پایین بکشد.
    const stick = toBottom === null ? atBottom() : toBottom;
    list.innerHTML = '';

    let lastDay = '';
    let previous = null;
    for (const message of state.messages) {
      const day = dayText(message.createdAt);
      if (day !== lastDay) {
        const divider = document.createElement('div');
        divider.className = 'day-divider';
        divider.innerHTML = `<span></span>`;
        divider.firstChild.textContent = day;
        list.appendChild(divider);
        lastDay = day;
        previous = null;
      }

      if (message.kind === 'system' || message.kind === 'call') {
        const system = document.createElement('div');
        system.className = `system-message${message.kind === 'call' ? ' call-record' : ''}`;
        system.innerHTML = '<span></span>';
        system.firstChild.textContent =
          message.kind === 'call' ? `📞 ${callRecordText(message)}` : message.body;
        list.appendChild(system);
        previous = null;
        continue;
      }

      const grouped =
        previous &&
        previous.senderId === message.senderId &&
        message.createdAt - previous.createdAt < 5 * 60 * 1000;
      list.appendChild(buildBubble(message, Boolean(grouped)));
      previous = message;
    }

    if (keepScroll) list.scrollTop = list.scrollHeight - previousHeight + previousTop;
    else if (stick) list.scrollTop = list.scrollHeight;
    else list.scrollTop = previousTop;

    updateJumpButton();
  }

  /** دکمه‌ی «رفتن به آخرین پیام»، فقط وقتی کاربر بالا رفته باشد. */
  function updateJumpButton() {
    const button = $('jumpToLatest');
    if (!button) return;
    const hidden = atBottom() || state.messages.length === 0;
    button.classList.toggle('is-hidden', hidden);
    if (hidden) state.missedWhileUp = 0;
    const badge = button.querySelector('.jump-badge');
    badge.textContent = state.missedWhileUp ? fa(state.missedWhileUp) : '';
    badge.classList.toggle('is-hidden', !state.missedWhileUp);
  }

  function scrollToMessage(id) {
    const row = document.querySelector(`.message-row[data-id="${id}"]`);
    if (!row) return;
    row.scrollIntoView({ behavior: 'smooth', block: 'center' });
    row.querySelector('.bubble').animate(
      [{ filter: 'brightness(1)' }, { filter: 'brightness(1.6)' }, { filter: 'brightness(1)' }],
      { duration: 900 }
    );
  }

  const atBottom = () => {
    const list = $('messageList');
    return list.scrollHeight - list.scrollTop - list.clientHeight < 120;
  };

  async function openConversation(id) {
    state.activeId = id;
    state.messages = [];
    state.replyTo = null;
    state.editing = null;
    clearImagePreview();
    updateReplyBar();
    renderConversations();

    $('emptyState').classList.add('is-hidden');
    $('chatView').classList.remove('is-hidden');
    $('appScreen').classList.add('show-chat');
    $('messageList').innerHTML = '<p class="empty-list">در حال بارگذاری…</p>';

    try {
      const [{ conversation }, data] = await Promise.all([
        api(`/conversations/${id}`),
        api(`/conversations/${id}/messages?limit=40`),
      ]);
      state.conversations.set(id, conversation);
      state.messages = data.messages;
      state.hasMore = data.hasMore;
      renderChatHeader();
      const composer = $('composer');
      composer.classList.toggle('is-hidden', Boolean(conversation.orphaned));
      renderMessages({ toBottom: true });
      renderConversations();
      markConversationRead();
      $('messageInput').focus({ preventScroll: true });
    } catch (err) {
      toast(err.message, true);
    }
  }

  async function loadOlderMessages() {
    if (!state.hasMore || state.loadingMore || state.messages.length === 0) return;
    state.loadingMore = true;
    try {
      const data = await api(
        `/conversations/${state.activeId}/messages?limit=40&before=${state.messages[0].id}`
      );
      state.messages = [...data.messages, ...state.messages];
      state.hasMore = data.hasMore;
      renderMessages({ keepScroll: true });
    } catch (err) {
      toast(err.message, true);
    } finally {
      state.loadingMore = false;
    }
  }

  async function markConversationRead() {
    const conv = state.conversations.get(state.activeId);
    const last = state.messages[state.messages.length - 1];
    if (!conv || !last) return;
    if (conv.unread === 0 && conv.lastReadMessageId >= last.id) return;

    conv.unread = 0;
    conv.lastReadMessageId = last.id;
    const me = conv.members.find((m) => m.id === state.me.id);
    if (me) me.lastReadMessageId = last.id;
    renderConversations();
    try {
      await api(`/conversations/${conv.id}/read`, { method: 'POST', body: { messageId: last.id } });
    } catch {
      /* خواندن پیام حیاتی نیست */
    }
  }

  /* ------------------------------ ارسال پیام ---------------------------- */

  function startReply(message) {
    state.replyTo = message;
    state.editing = null;
    updateReplyBar();
    $('messageInput').focus();
  }

  function startEdit(message) {
    state.editing = message;
    state.replyTo = null;
    $('messageInput').value = message.body;
    autoGrow();
    updateReplyBar();
    $('messageInput').focus();
  }

  function updateReplyBar() {
    const bar = $('replyBar');
    if (state.editing) {
      bar.classList.remove('is-hidden');
      $('replyAuthor').textContent = 'ویرایش پیام';
      $('replyPreview').textContent = state.editing.body || 'عکس';
      return;
    }
    if (!state.replyTo) {
      bar.classList.add('is-hidden');
      return;
    }
    bar.classList.remove('is-hidden');
    $('replyAuthor').textContent = senderName(state.replyTo.senderId);
    $('replyPreview').textContent =
      state.replyTo.kind === 'image'
        ? '🖼 عکس'
        : state.replyTo.kind === 'voice'
          ? '🎤 پیام صوتی'
          : state.replyTo.body;
  }

  $('cancelReply').addEventListener('click', () => {
    state.replyTo = null;
    if (state.editing) {
      state.editing = null;
      $('messageInput').value = '';
      autoGrow();
    }
    updateReplyBar();
  });

  async function removeMessage(message) {
    if (!confirm('این پیام حذف شود؟')) return;
    try {
      await api(`/messages/${message.id}`, { method: 'DELETE' });
    } catch (err) {
      toast(err.message, true);
    }
  }

  function autoGrow() {
    const input = $('messageInput');
    input.style.height = 'auto';
    input.style.height = `${Math.min(input.scrollHeight, 132)}px`;
  }

  $('messageInput').addEventListener('input', () => {
    autoGrow();
    sendTyping(true);
  });

  $('messageInput').addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey && window.matchMedia('(min-width: 821px)').matches) {
      event.preventDefault();
      $('composer').requestSubmit();
    }
  });

  function sendTyping(isTyping) {
    if (!state.socket || state.socket.readyState !== WebSocket.OPEN || !state.activeId) return;
    const now = Date.now();
    if (isTyping && now - state.typingSentAt < 2000) return;
    state.typingSentAt = isTyping ? now : 0;
    state.socket.send(
      JSON.stringify({ type: 'typing', conversationId: state.activeId, isTyping })
    );
    clearTimeout(state.typingTimer);
    if (isTyping) state.typingTimer = setTimeout(() => sendTyping(false), 3000);
  }

  $('composer').addEventListener('submit', async (event) => {
    event.preventDefault();
    const input = $('messageInput');
    const text = input.value.trim();

    if (state.editing) {
      if (!text) return;
      const target = state.editing;
      state.editing = null;
      input.value = '';
      autoGrow();
      updateReplyBar();
      try {
        await api(`/messages/${target.id}`, { method: 'PATCH', body: { body: text } });
      } catch (err) {
        toast(err.message, true);
      }
      return;
    }

    if (state.pendingImage) {
      await sendImage(text);
      return;
    }
    if (!text) return;

    const replyToId = state.replyTo?.id ?? null;
    input.value = '';
    autoGrow();
    state.replyTo = null;
    updateReplyBar();
    sendTyping(false);

    // پیام موقت تا رسیدن پاسخ سرور
    const optimistic = {
      id: Number.MAX_SAFE_INTEGER - Math.floor(Math.random() * 1000),
      conversationId: state.activeId,
      senderId: state.me.id,
      kind: 'text',
      body: text,
      createdAt: Date.now(),
      pending: true,
      replyTo: null,
    };
    state.messages.push(optimistic);
    renderMessages({ toBottom: true });

    try {
      await api(`/conversations/${state.activeId}/messages`, {
        method: 'POST',
        body: { body: text, replyToId },
      });
      if (state.messages.includes(optimistic)) {
        state.messages = state.messages.filter((m) => m !== optimistic);
        renderMessages();
      }
    } catch (err) {
      state.messages = state.messages.filter((m) => m !== optimistic);
      renderMessages({ toBottom: true });
      input.value = text;
      autoGrow();
      toast(err.message, true);
    }
  });

  /* -------------------------------- عکس‌ها ------------------------------- */

  /* -------------------------------- ضبط صدا ------------------------------- */

  function pickAudioMime() {
    // مرورگرها فرمت‌های متفاوتی پشتیبانی می‌کنند؛ اولین موجود را برمی‌داریم.
    const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4'];
    return candidates.find((type) => MediaRecorder.isTypeSupported?.(type)) || '';
  }

  async function startRecording() {
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
      return toast('مرورگر شما ضبط صدا را پشتیبانی نمی‌کند.', true);
    }

    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      return toast('اجازه‌ی دسترسی به میکروفون داده نشد.', true);
    }

    const mimeType = pickAudioMime();
    const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
    const chunks = [];
    recorder.addEventListener('dataavailable', (event) => {
      if (event.data.size > 0) chunks.push(event.data);
    });
    recorder.addEventListener('stop', () => {
      stream.getTracks().forEach((track) => track.stop());
      const durationMs = Date.now() - state.recordStartedAt;
      const blob = new Blob(chunks, { type: recorder.mimeType || 'audio/webm' });
      state.recorder = null;
      clearInterval(state.recordTimer);
      $('recordBar').classList.add('is-hidden');
      $('composer').classList.remove('is-hidden');
      if (recorder.cancelled || blob.size === 0 || durationMs < 600) return;
      sendVoice(blob, durationMs);
    });

    state.recorder = recorder;
    state.recordStartedAt = Date.now();
    recorder.start();

    $('composer').classList.add('is-hidden');
    $('recordBar').classList.remove('is-hidden');
    $('recordTime').textContent = clockText(0);
    state.recordTimer = setInterval(() => {
      const elapsed = Date.now() - state.recordStartedAt;
      $('recordTime').textContent = clockText(elapsed);
      if (elapsed >= 5 * 60 * 1000) stopRecording();   // سقف پنج دقیقه
    }, 200);
  }

  function stopRecording({ cancel = false } = {}) {
    const recorder = state.recorder;
    if (!recorder) return;
    recorder.cancelled = cancel;
    recorder.stop();
  }

  async function sendVoice(blob, durationMs) {
    const replyToId = state.replyTo?.id ?? null;
    state.replyTo = null;
    updateReplyBar();

    const form = new FormData();
    form.append('voice', blob, 'voice');
    form.append('durationMs', String(Math.round(durationMs)));
    if (replyToId) form.append('replyToId', String(replyToId));

    try {
      await api(`/conversations/${state.activeId}/voice`, { method: 'POST', body: form, raw: true });
    } catch (err) {
      toast(err.message, true);
    }
  }

  $('micBtn').addEventListener('click', startRecording);
  $('stopRecord').addEventListener('click', () => stopRecording());
  $('cancelRecord').addEventListener('click', () => stopRecording({ cancel: true }));

  $('attachBtn').addEventListener('click', () => $('imageInput').click());

  $('imageInput').addEventListener('change', async (event) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    if (!file.type.startsWith('image/')) return toast('فقط فایل عکس قابل ارسال است.', true);

    try {
      const prepared = await prepareImage(file);
      state.pendingImage = prepared;
      $('imagePreviewImg').src = URL.createObjectURL(prepared.blob);
      $('imagePreviewName').textContent = prepared.name;
      $('imagePreviewSize').textContent = fileSize(prepared.blob.size);
      $('imagePreview').classList.remove('is-hidden');
      $('messageInput').placeholder = 'توضیح عکس (اختیاری)…';
      $('messageInput').focus();
    } catch (err) {
      toast(err.message || 'آماده‌سازی عکس ناموفق بود.', true);
    }
  });

  $('cancelImage').addEventListener('click', clearImagePreview);

  function clearImagePreview() {
    if ($('imagePreviewImg').src.startsWith('blob:')) URL.revokeObjectURL($('imagePreviewImg').src);
    state.pendingImage = null;
    $('imagePreview').classList.add('is-hidden');
    $('imagePreviewImg').removeAttribute('src');
    $('messageInput').placeholder = 'پیام بنویسید…';
  }

  /** عکس را پیش از آپلود کوچک و فشرده می‌کند تا مصرف داده روی موبایل کم شود. */
  async function prepareImage(file) {
    const isAnimatedGif = file.type === 'image/gif';
    if (isAnimatedGif || file.size < 180 * 1024) {
      return { blob: file, name: file.name || 'image' };
    }

    const bitmap = await createImageBitmap(file).catch(() => null);
    if (!bitmap) return { blob: file, name: file.name || 'image' };

    const scale = Math.min(1, MAX_IMAGE_EDGE / Math.max(bitmap.width, bitmap.height));
    const width = Math.round(bitmap.width * scale);
    const height = Math.round(bitmap.height * scale);

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    canvas.getContext('2d').drawImage(bitmap, 0, 0, width, height);
    bitmap.close?.();

    const blob = await new Promise((resolve) =>
      canvas.toBlob(resolve, 'image/jpeg', IMAGE_QUALITY)
    );
    if (!blob || blob.size >= file.size) return { blob: file, name: file.name || 'image' };

    const base = (file.name || 'image').replace(/\.[^.]+$/, '');
    return { blob, name: `${base}.jpg` };
  }

  async function sendImage(caption) {
    const image = state.pendingImage;
    if (!image) return;
    const replyToId = state.replyTo?.id ?? null;

    const form = new FormData();
    form.append('image', image.blob, image.name);
    if (caption) form.append('caption', caption);
    if (replyToId) form.append('replyToId', String(replyToId));

    const input = $('messageInput');
    input.value = '';
    autoGrow();
    state.replyTo = null;
    updateReplyBar();
    clearImagePreview();
    $('sendBtn').disabled = true;
    toast('در حال ارسال عکس…');

    try {
      await api(`/conversations/${state.activeId}/images`, { method: 'POST', body: form, raw: true });
    } catch (err) {
      toast(err.message, true);
    } finally {
      $('sendBtn').disabled = false;
    }
  }

  function openLightbox(attachment) {
    $('lightboxImg').src = fileUrl(attachment.url);
    $('lightboxDownload').href = `${fileUrl(attachment.url)}&download=1`;
    $('lightboxDownload').setAttribute('download', attachment.name || 'image');
    $('lightbox').classList.remove('is-hidden');
  }

  $('lightbox').addEventListener('click', (event) => {
    if (event.target.closest('.lightbox-download')) return;
    $('lightbox').classList.add('is-hidden');
    $('lightboxImg').removeAttribute('src');
  });

  /* ------------------------------ وب‌سوکت ------------------------------ */

  function connectSocket() {
    if (!state.token) return;
    const protocol = location.protocol === 'https:' ? 'wss' : 'ws';
    const socket = new WebSocket(
      `${protocol}://${location.host}/ws?token=${encodeURIComponent(state.token)}`
    );
    state.socket = socket;

    socket.addEventListener('open', () => {
      state.reconnectDelay = 1000;
      $('connectionState').textContent = 'آنلاین';
      // توکن فایل ۲۴ ساعته است؛ با هر اتصال تازه‌اش می‌کنیم تا عکس‌ها در
      // نشست‌های طولانی از کار نیفتند.
      api('/me')
        .then((data) => {
          if (data.fileToken) state.fileToken = data.fileToken;
        })
        .catch(() => {});
    });

    socket.addEventListener('message', (event) => {
      let payload;
      try {
        payload = JSON.parse(event.data);
      } catch {
        return;
      }
      handleEvent(payload);
    });

    socket.addEventListener('close', (event) => {
      $('connectionState').textContent = 'قطع — تلاش برای اتصال…';
      // بدون سوکت، سیگنالینگ تماس هم از کار می‌افتد.
      if (state.call) teardownCall('ارتباط قطع شد');
      if (event.code === 4001) return signOut('نشست شما منقضی شده است. دوباره وارد شوید.');
      if (event.code === 4003) {
        return signOut(
          event.reason === 'blocked' ? 'حساب شما مسدود شده است.' : 'حساب شما هنوز تایید نشده است.'
        );
      }
      setTimeout(connectSocket, state.reconnectDelay);
      state.reconnectDelay = Math.min(state.reconnectDelay * 2, 15000);
    });
  }

  function handleEvent(event) {
    switch (event.type) {
      case 'ready':
        markOnline(event.online);
        break;

      case 'message:new': {
        // پیام خودمان از سرور برگشته؛ نسخه‌ی موقتی که محلی ساخته بودیم باید برود،
        // وگرنه هر دو با هم روی صفحه می‌مانند.
        if (event.message.senderId === state.me.id) {
          state.messages = state.messages.filter(
            (m) => !(m.pending && m.kind === event.message.kind && m.body === event.message.body)
          );
        }
        const conv = state.conversations.get(event.message.conversationId);
        if (!conv) {
          loadConversations();
          break;
        }
        conv.lastMessage = event.message;
        if (event.message.conversationId === state.activeId) {
          const stick = atBottom();
          state.messages.push(event.message);
          if (!stick && event.message.senderId !== state.me.id) state.missedWhileUp += 1;
          renderMessages({ toBottom: stick });
          if (stick && document.visibilityState === 'visible') markConversationRead();
        } else if (event.message.senderId !== state.me.id && event.message.kind !== 'system') {
          conv.unread += 1;
          notify(conv, event.message);
        }
        renderConversations();
        break;
      }

      case 'message:updated':
      case 'message:deleted': {
        const conv = state.conversations.get(event.message.conversationId);
        if (conv?.lastMessage?.id === event.message.id) conv.lastMessage = event.message;
        const index = state.messages.findIndex((m) => m.id === event.message.id);
        if (index >= 0) {
          state.messages[index] = event.message;
          renderMessages();
        }
        renderConversations();
        break;
      }

      case 'conversation:new':
        upsertConversation(event.conversation);
        break;

      case 'conversation:cleared':
        // همین کاربر از دستگاه دیگری گفتگو را پاک کرده است.
        state.conversations.delete(event.conversationId);
        if (state.activeId === event.conversationId) closeChat();
        renderConversations();
        break;

      case 'conversation:left':
        state.conversations.delete(event.conversationId);
        if (state.activeId === event.conversationId) closeChat();
        renderConversations();
        break;

      case 'typing':
        handleTyping(event);
        break;

      case 'read': {
        const conv = state.conversations.get(event.conversationId);
        const member = conv?.members.find((m) => m.id === event.userId);
        if (member) member.lastReadMessageId = event.messageId;
        if (event.conversationId === state.activeId) renderMessages();
        break;
      }

      case 'presence': {
        for (const conv of state.conversations.values()) {
          const member = conv.members.find((m) => m.id === event.userId);
          if (member) {
            member.online = event.online;
            member.lastSeenAt = event.lastSeenAt;
          }
          if (conv.peer?.id === event.userId) {
            conv.peer.online = event.online;
            conv.peer.lastSeenAt = event.lastSeenAt;
          }
        }
        renderConversations();
        if (state.activeId) renderChatHeader();
        break;
      }

      case 'call:ringing':
        onCallRinging(event);
        break;

      case 'call:incoming':
        onCallIncoming(event);
        break;

      case 'call:accepted':
        onCallAccepted(event);
        break;

      case 'call:signal':
        handleCallSignal(event);
        break;

      case 'call:answered-elsewhere':
        // این تماس روی دستگاه دیگری جواب داده شد.
        if (state.call && state.call.id === event.callId && !state.call.pc) teardownCall();
        break;

      case 'call:ended':
        if (state.call && (!state.call.id || state.call.id === event.callId)) {
          teardownCall(CALL_ENDINGS[event.reason] || 'تماس پایان یافت');
        }
        break;

      case 'call:error':
        if (state.call) teardownCall(CALL_ERRORS[event.reason] || 'تماس برقرار نشد');
        else toast(CALL_ERRORS[event.reason] || 'تماس برقرار نشد', true);
        break;

      case 'me:updated':
        state.me = event.user;
        renderMe();
        break;

      case 'data:wiped':
        state.messages = [];
        toast('داده‌های هفتگی پاک شد.');
        loadConversations();
        if (state.activeId) openConversation(state.activeId);
        break;

      default:
        break;
    }
  }

  function markOnline(ids) {
    const online = new Set(ids);
    for (const conv of state.conversations.values()) {
      for (const member of conv.members) member.online = online.has(member.id);
      if (conv.peer) conv.peer.online = online.has(conv.peer.id);
    }
    renderConversations();
    if (state.activeId) renderChatHeader();
  }

  function handleTyping(event) {
    const key = `${event.conversationId}:${event.userId}`;
    if (event.isTyping) state.typingPeers.set(key, event);
    else state.typingPeers.delete(key);
    clearTimeout(handleTyping.timers?.[key]);
    handleTyping.timers = handleTyping.timers || {};
    if (event.isTyping) {
      handleTyping.timers[key] = setTimeout(() => {
        state.typingPeers.delete(key);
        renderTyping();
      }, 5000);
    }
    renderTyping();
  }

  function renderTyping() {
    const indicator = $('typingIndicator');
    const names = [...state.typingPeers.values()]
      .filter((event) => event.conversationId === state.activeId)
      .map((event) => event.displayName);
    if (names.length === 0) {
      indicator.classList.add('is-hidden');
      return;
    }
    indicator.textContent = `${names.join('، ')} در حال نوشتن…`;
    indicator.classList.remove('is-hidden');
  }

  /**
   * اعلان پیام تازه. سه مسیر، به ترتیب اولویت:
   *  ۱) اپ اندروید (WebView): از پل بومی، چون WebView اصلاً Notification API ندارد.
   *  ۲) سرویس‌ورکر: تنها راهی که در کروم اندروید کار می‌کند.
   *  ۳) Notification مستقیم: برای مرورگرهای دسکتاپ.
   */
  async function notify(conv, message) {
    if (document.visibilityState === 'visible') return;
    const body =
      message.kind === 'image'
        ? '🖼 عکس فرستاد'
        : message.kind === 'voice'
          ? '🎤 پیام صوتی فرستاد'
          : message.kind === 'call'
            ? `📞 ${callRecordText(message)}`
            : message.body.slice(0, 120);

    if (window.AndroidBridge?.notify) {
      try {
        window.AndroidBridge.notify(conv.title, body, String(conv.id));
        return;
      } catch {
        /* اگر پل در دسترس نبود، مسیرهای بعدی را امتحان می‌کنیم */
      }
    }

    if (!('Notification' in window) || Notification.permission !== 'granted') return;

    const options = {
      body,
      icon: '/icons/icon-192.png',
      badge: '/icons/icon-192.png',
      tag: `conv-${conv.id}`,
      data: { conversationId: conv.id, url: '/' },
    };

    try {
      const registration = await navigator.serviceWorker?.ready;
      if (registration) {
        await registration.showNotification(conv.title, options);
        return;
      }
    } catch {
      /* برمی‌گردیم به حالت ساده */
    }
    try {
      new Notification(conv.title, options);
    } catch {
      /* بعضی مرورگرها سازنده را روی موبایل ممنوع کرده‌اند */
    }
  }

  /** یک بار، بعد از ورود، اجازه‌ی اعلان را می‌گیرد (اگر هنوز تصمیمی گرفته نشده). */
  async function requestNotificationPermission({ force = false } = {}) {
    if (window.AndroidBridge?.requestNotificationPermission) {
      window.AndroidBridge.requestNotificationPermission();
      return;
    }
    if (!('Notification' in window)) return;
    if (Notification.permission === 'granted') return toast('اعلان‌ها از قبل فعال است.');
    if (Notification.permission === 'denied') {
      if (force) toast('اعلان‌ها را در تنظیمات مرورگر برای این سایت اجازه دهید.', true);
      return;
    }
    if (!force && localStorage.getItem('messenger.notifyAsked')) return;
    localStorage.setItem('messenger.notifyAsked', '1');
    const result = await Notification.requestPermission().catch(() => 'default');
    if (force) toast(result === 'granted' ? 'اعلان‌ها فعال شد.' : 'اعلان‌ها فعال نشد.', result !== 'granted');
  }

  /* ------------------------------ تماس صوتی ----------------------------- */

  /**
   * تماس صوتی با WebRTC: صدا مستقیم بین دو مرورگر می‌رود و فقط اگر شبکه اجازه
   * نداد از سرور TURN رله می‌شود. سرور ما هیچ صدایی نمی‌شنود؛ کارش تنها رساندن
   * پیام‌های هماهنگی (offer/answer/candidate) به طرف مقابل است.
   */
  const CALL_ERRORS = {
    disabled: 'تماس صوتی روی این سرور فعال نیست.',
    'not-direct': 'تماس صوتی فقط در گفتگوی دونفره ممکن است.',
    forbidden: 'اجازه‌ی این تماس را ندارید.',
    'too-many': 'تماس‌های زیادی گرفته‌اید؛ کمی بعد دوباره تلاش کنید.',
    'no-peer': 'طرف مقابل پیدا نشد.',
    'already-in-call': 'همین حالا در یک تماس هستید.',
    busy: 'طرف مقابل در تماس دیگری است.',
    offline: 'طرف مقابل آنلاین نیست.',
    gone: 'این تماس دیگر برقرار نیست.',
  };

  const CALL_ENDINGS = {
    declined: 'تماس رد شد',
    timeout: 'پاسخی داده نشد',
    cancelled: 'تماس لغو شد',
    offline: 'طرف مقابل آنلاین نیست',
    disconnected: 'ارتباط قطع شد',
    failed: 'برقراری تماس ممکن نشد',
  };

  function sendWs(payload) {
    if (!state.socket || state.socket.readyState !== WebSocket.OPEN) return false;
    state.socket.send(JSON.stringify(payload));
    return true;
  }

  /* --- زنگ: با WebAudio ساخته می‌شود تا فایل صوتی اضافه‌ای لازم نباشد --- */
  const ring = {
    ctx: null,
    timer: null,
    start(incoming) {
      this.stop();
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return;
      try {
        this.ctx = new Ctx();
      } catch {
        return;
      }
      const beep = () => {
        if (!this.ctx) return;
        const osc = this.ctx.createOscillator();
        const gain = this.ctx.createGain();
        osc.type = 'sine';
        osc.frequency.value = incoming ? 660 : 440;
        gain.gain.value = 0.0001;
        osc.connect(gain).connect(this.ctx.destination);
        const now = this.ctx.currentTime;
        gain.gain.exponentialRampToValueAtTime(0.08, now + 0.05);
        gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.6);
        osc.start(now);
        osc.stop(now + 0.65);
      };
      beep();
      this.timer = setInterval(beep, incoming ? 1200 : 2500);
    },
    stop() {
      clearInterval(this.timer);
      this.timer = null;
      if (this.ctx) {
        this.ctx.close().catch(() => {});
        this.ctx = null;
      }
    },
  };

  /* ------------------------------ نمایش تماس ----------------------------- */

  function showCallOverlay({ name, color, incoming }) {
    paintAvatar($('callAvatar'), name, color || '#2563eb', false);
    $('callName').textContent = name;
    $('callAccept').classList.toggle('is-hidden', !incoming);
    $('callMute').classList.toggle('is-hidden', incoming);
    $('callMute').classList.remove('is-on');
    $('callOverlay').classList.remove('is-hidden');
    document.body.classList.add('in-call');
  }

  function setCallState(text) {
    $('callState').textContent = text;
  }

  function hideCallOverlay() {
    $('callOverlay').classList.add('is-hidden');
    document.body.classList.remove('in-call');
  }

  function startCallTimer() {
    clearInterval(state.call.timer);
    const from = Date.now();
    const tick = () => setCallState(clockText(Date.now() - from));
    tick();
    state.call.timer = setInterval(tick, 1000);
  }

  /** همه‌ی منابع تماس را آزاد می‌کند؛ باید در هر مسیر پایان صدا زده شود. */
  function teardownCall(message) {
    const call = state.call;
    state.call = null;
    ring.stop();
    if (call) {
      clearInterval(call.timer);
      call.stream?.getTracks().forEach((track) => track.stop());
      if (call.pc) {
        call.pc.onicecandidate = null;
        call.pc.ontrack = null;
        call.pc.onconnectionstatechange = null;
        try {
          call.pc.close();
        } catch {
          /* already closed */
        }
      }
    }
    const audio = $('remoteAudio');
    audio.srcObject = null;
    hideCallOverlay();
    if (message) toast(message);
  }

  /* --------------------------- برقراری ارتباط --------------------------- */

  async function callIceServers() {
    // اعتبارنامه‌ی TURN کوتاه‌عمر است، پس برای هر تماس تازه گرفته می‌شود.
    try {
      const data = await api('/call/config');
      return data.iceServers || [];
    } catch {
      return [];
    }
  }

  async function createPeer() {
    const call = state.call;
    const iceServers = await callIceServers();
    if (!state.call || state.call !== call) return null; // تماس در این فاصله بسته شد

    const pc = new RTCPeerConnection({ iceServers });
    call.pc = pc;

    call.stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      video: false,
    });
    if (!state.call || state.call !== call) {
      call.stream.getTracks().forEach((t) => t.stop());
      return null;
    }
    for (const track of call.stream.getTracks()) pc.addTrack(track, call.stream);

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        sendWs({ type: 'call:signal', callId: call.id, data: { candidate: event.candidate } });
      }
    };

    pc.ontrack = (event) => {
      $('remoteAudio').srcObject = event.streams[0];
      $('remoteAudio').play?.().catch(() => {});
    };

    pc.onconnectionstatechange = () => {
      if (!state.call || state.call !== call) return;
      if (pc.connectionState === 'connected') {
        ring.stop();
        $('callMute').classList.remove('is-hidden');
        $('callAccept').classList.add('is-hidden');
        startCallTimer();
      } else if (pc.connectionState === 'failed') {
        endCall('failed');
      }
    };

    return pc;
  }

  /** candidate هایی که پیش از تنظیم توضیح طرف مقابل می‌رسند باید صبر کنند. */
  async function flushPendingCandidates() {
    const call = state.call;
    if (!call?.pc) return;
    for (const candidate of call.pendingCandidates) {
      await call.pc.addIceCandidate(candidate).catch(() => {});
    }
    call.pendingCandidates = [];
  }

  async function handleCallSignal(event) {
    const call = state.call;
    if (!call || call.id !== event.callId) return;
    const { sdp, candidate } = event.data || {};

    try {
      if (sdp) {
        if (!call.pc && call.role === 'callee') {
          if (!(await createPeer())) return;
        }
        if (!call.pc) return;
        await call.pc.setRemoteDescription(new RTCSessionDescription(sdp));
        if (sdp.type === 'offer') {
          const answer = await call.pc.createAnswer();
          await call.pc.setLocalDescription(answer);
          sendWs({ type: 'call:signal', callId: call.id, data: { sdp: call.pc.localDescription } });
        }
        await flushPendingCandidates();
        return;
      }

      if (candidate) {
        const ice = new RTCIceCandidate(candidate);
        if (call.pc?.remoteDescription?.type) await call.pc.addIceCandidate(ice).catch(() => {});
        else call.pendingCandidates.push(ice);
      }
    } catch (error) {
      console.error('[call] خطا در هماهنگی تماس:', error);
      endCall('failed');
    }
  }

  /* ----------------------------- کنش‌های کاربر ---------------------------- */

  function startCall() {
    const conv = state.conversations.get(state.activeId);
    if (!conv || conv.type !== 'direct' || !conv.peer) return;
    if (state.call) return toast('همین حالا در یک تماس هستید.', true);
    if (!window.RTCPeerConnection || !navigator.mediaDevices?.getUserMedia) {
      return toast('مرورگر شما تماس صوتی را پشتیبانی نمی‌کند.', true);
    }

    state.call = {
      id: null,
      role: 'caller',
      conversationId: conv.id,
      peerName: conv.title,
      peerColor: conv.avatarColor,
      pc: null,
      stream: null,
      timer: null,
      pendingCandidates: [],
    };
    showCallOverlay({ name: conv.title, color: conv.avatarColor, incoming: false });
    setCallState('در حال زنگ زدن…');
    if (!sendWs({ type: 'call:invite', conversationId: conv.id })) {
      teardownCall('ارتباط با سرور برقرار نیست.');
    }
  }

  async function acceptCall() {
    const call = state.call;
    if (!call || call.role !== 'callee') return;
    ring.stop();
    $('callAccept').classList.add('is-hidden');
    setCallState('در حال اتصال…');
    try {
      // اجازه‌ی میکروفون پیش از پذیرش گرفته می‌شود تا تماس بی‌صدا شروع نشود.
      if (!(await createPeer())) return;
    } catch {
      sendWs({ type: 'call:decline', callId: call.id });
      teardownCall('دسترسی به میکروفون داده نشد.');
      return;
    }
    sendWs({ type: 'call:accept', callId: call.id });
  }

  /** پایان تماس از سمت ما. */
  function endCall(reason) {
    const call = state.call;
    if (!call) return;
    if (call.id) {
      sendWs({
        type: call.role === 'callee' && !call.pc ? 'call:decline' : 'call:end',
        callId: call.id,
      });
    }
    teardownCall(reason ? CALL_ENDINGS[reason] : null);
  }

  function toggleMute() {
    const call = state.call;
    if (!call?.stream) return;
    const track = call.stream.getAudioTracks()[0];
    if (!track) return;
    track.enabled = !track.enabled;
    $('callMute').classList.toggle('is-on', !track.enabled);
    $('callMute').setAttribute(
      'aria-label',
      track.enabled ? 'بی‌صدا کردن میکروفون' : 'روشن کردن میکروفون'
    );
    toast(track.enabled ? 'میکروفون روشن شد.' : 'میکروفون بی‌صدا شد.');
  }

  /* ------------------------- رویدادهای رسیده از سرور ----------------------- */

  function onCallRinging(event) {
    if (!state.call || state.call.role !== 'caller') return;
    state.call.id = event.callId;
    ring.start(false);
  }

  async function onCallIncoming(event) {
    if (state.call) {
      // روی این دستگاه تماس دیگری در جریان است؛ به سرور خبر می‌دهیم.
      sendWs({ type: 'call:decline', callId: event.callId });
      return;
    }
    state.call = {
      id: event.callId,
      role: 'callee',
      conversationId: event.conversationId,
      peerName: event.from?.displayName || 'کاربر',
      peerColor: event.from?.avatarColor,
      pc: null,
      stream: null,
      timer: null,
      pendingCandidates: [],
    };
    showCallOverlay({
      name: state.call.peerName,
      color: state.call.peerColor,
      incoming: true,
    });
    setCallState('تماس صوتی ورودی…');
    ring.start(true);
    if (document.visibilityState !== 'visible') {
      notify({ id: event.conversationId, title: state.call.peerName }, {
        kind: 'text',
        body: 'تماس صوتی…',
      });
    }
  }

  async function onCallAccepted(event) {
    const call = state.call;
    if (!call || call.id !== event.callId || call.role !== 'caller') return;
    ring.stop();
    setCallState('در حال اتصال…');
    try {
      const pc = await createPeer();
      if (!pc) return;
      const offer = await pc.createOffer({ offerToReceiveAudio: true });
      await pc.setLocalDescription(offer);
      sendWs({ type: 'call:signal', callId: call.id, data: { sdp: pc.localDescription } });
    } catch {
      endCall('failed');
      toast('دسترسی به میکروفون داده نشد.', true);
    }
  }

  $('callBtn').addEventListener('click', startCall);
  $('callAccept').addEventListener('click', acceptCall);
  $('callMute').addEventListener('click', toggleMute);
  $('callHangup').addEventListener('click', () => endCall());

  /* ------------------------------- پنجره‌ها ----------------------------- */

  function openModal(title, build) {
    $('modalTitle').textContent = title;
    const body = $('modalBody');
    body.innerHTML = '';
    build(body);
    $('modalRoot').classList.remove('is-hidden');
  }

  const closeModal = () => $('modalRoot').classList.add('is-hidden');
  document.querySelectorAll('[data-close-modal]').forEach((el) =>
    el.addEventListener('click', closeModal)
  );

  /** نام کاربری لاتین را داخل <bdi> می‌گذارد تا در متن راست‌چین وارونه نشود. */
  function usernameTag(username) {
    const bdi = document.createElement('bdi');
    bdi.textContent = `@${username}`;
    return bdi;
  }

  function userRow(user, { selectable = false, onClick } = {}) {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'user-row';
    row.innerHTML = `
      <span class="avatar"></span>
      <span class="user-row-main"><strong></strong><small class="muted"></small></span>`;
    paintAvatar(row.querySelector('.avatar'), user.displayName, user.avatarColor, user.online);
    row.querySelector('strong').textContent = user.displayName;
    row.querySelector('small').replaceChildren(usernameTag(user.username));
    if (onClick) {
      row.addEventListener('click', () => onClick(row));
    }
    if (selectable) row.dataset.userId = user.id;
    return row;
  }

  function newChatModal() {
    openModal('گفتگوی جدید', (body) => {
      const search = document.createElement('input');
      search.type = 'search';
      search.placeholder = 'نام کاربری دقیق طرف مقابل…';
      const results = document.createElement('div');
      results.style.display = 'grid';
      results.style.gap = '8px';

      const hint = document.createElement('p');
      hint.className = 'muted';
      hint.style.margin = '0';
      hint.textContent = 'برای شروع گفتگو باید نام کاربری دقیق طرف مقابل را بدانید.';

      const groupBtn = document.createElement('button');
      groupBtn.className = 'btn';
      groupBtn.textContent = '👥 ساخت گروه جدید';
      groupBtn.addEventListener('click', newGroupModal);

      let timer;
      search.addEventListener('input', () => {
        clearTimeout(timer);
        const query = search.value.trim();
        timer = setTimeout(async () => {
          if (!query) return (results.innerHTML = '');
          try {
            const data = await api(`/users?q=${encodeURIComponent(query)}`);
            results.innerHTML = '';
            if (data.users.length === 0) {
              results.innerHTML =
                '<p class="empty-list">کاربری با این نام کاربری پیدا نشد. نام کاربری باید دقیق باشد.</p>';
              return;
            }
            for (const user of data.users) {
              results.appendChild(
                userRow(user, {
                  onClick: async () => {
                    try {
                      const { conversation } = await api('/conversations/direct', {
                        method: 'POST',
                        body: { username: user.username },
                      });
                      upsertConversation(conversation);
                      closeModal();
                      openConversation(conversation.id);
                    } catch (err) {
                      toast(err.message, true);
                    }
                  },
                })
              );
            }
          } catch (err) {
            toast(err.message, true);
          }
        }, 220);
      });

      body.append(groupBtn, hint, search, results);
      search.focus();
    });
  }

  function newGroupModal() {
    openModal('گروه جدید', (body) => {
      const selected = new Map();

      const title = document.createElement('input');
      title.placeholder = 'نام گروه';
      title.maxLength = 60;

      const search = document.createElement('input');
      search.type = 'search';
      search.placeholder = 'نام کاربری دقیق عضو تازه…';

      const chosen = document.createElement('div');
      chosen.className = 'muted';
      const results = document.createElement('div');
      results.style.display = 'grid';
      results.style.gap = '8px';

      const paintChosen = () => {
        chosen.textContent = selected.size
          ? `اعضا: ${[...selected.values()].map((u) => u.displayName).join('، ')}`
          : 'هنوز عضوی انتخاب نشده است.';
      };
      paintChosen();

      let timer;
      search.addEventListener('input', () => {
        clearTimeout(timer);
        const query = search.value.trim();
        timer = setTimeout(async () => {
          if (!query) return (results.innerHTML = '');
          const data = await api(`/users?q=${encodeURIComponent(query)}`).catch(() => ({ users: [] }));
          results.innerHTML = '';
          for (const user of data.users) {
            const row = userRow(user, {
              selectable: true,
              onClick: (element) => {
                if (selected.has(user.id)) selected.delete(user.id);
                else selected.set(user.id, user);
                element.classList.toggle('is-selected', selected.has(user.id));
                paintChosen();
              },
            });
            row.classList.toggle('is-selected', selected.has(user.id));
            results.appendChild(row);
          }
        }, 220);
      });

      const create = document.createElement('button');
      create.className = 'btn btn-primary';
      create.textContent = 'ساخت گروه';
      create.addEventListener('click', async () => {
        if (!title.value.trim()) return toast('نام گروه را بنویسید.', true);
        if (selected.size === 0) return toast('حداقل یک عضو انتخاب کنید.', true);
        try {
          const { conversation } = await api('/conversations/group', {
            method: 'POST',
            body: { title: title.value.trim(), memberIds: [...selected.keys()] },
          });
          upsertConversation(conversation);
          closeModal();
          openConversation(conversation.id);
        } catch (err) {
          toast(err.message, true);
        }
      });

      body.append(title, search, chosen, results, create);
      title.focus();
    });
  }

  function profileModal() {
    openModal('پروفایل', (body) => {
      const name = document.createElement('input');
      name.value = state.me.displayName;
      name.maxLength = 40;
      const bio = document.createElement('input');
      bio.value = state.me.bio || '';
      bio.placeholder = 'درباره من';
      bio.maxLength = 200;

      const username = document.createElement('p');
      username.className = 'muted';
      username.replaceChildren(usernameTag(state.me.username));

      const save = document.createElement('button');
      save.className = 'btn btn-primary';
      save.textContent = 'ذخیره';
      save.addEventListener('click', async () => {
        try {
          const data = await api('/me', {
            method: 'PATCH',
            body: { displayName: name.value.trim(), bio: bio.value.trim() },
          });
          state.me = data.user;
          renderMe();
          closeModal();
          toast('پروفایل به‌روز شد.');
        } catch (err) {
          toast(err.message, true);
        }
      });

      // --- تغییر رمز ---
      const divider = document.createElement('div');
      divider.className = 'modal-divider';
      divider.textContent = 'تغییر رمز عبور';

      const currentPassword = document.createElement('input');
      currentPassword.type = 'password';
      currentPassword.placeholder = 'رمز فعلی';
      currentPassword.autocomplete = 'current-password';

      const newPassword = document.createElement('input');
      newPassword.type = 'password';
      newPassword.placeholder = 'رمز تازه (حداقل ۸ نویسه)';
      newPassword.autocomplete = 'new-password';

      const changePassword = document.createElement('button');
      changePassword.className = 'btn';
      changePassword.textContent = 'تغییر رمز';
      changePassword.addEventListener('click', async () => {
        if (!currentPassword.value || !newPassword.value) {
          return toast('هر دو رمز را پر کنید.', true);
        }
        changePassword.disabled = true;
        try {
          const data = await api('/me/password', {
            method: 'POST',
            body: { currentPassword: currentPassword.value, newPassword: newPassword.value },
          });
          state.token = data.token;
          localStorage.setItem(TOKEN_KEY, data.token);
          currentPassword.value = '';
          newPassword.value = '';
          toast(data.message);
          // نشست تازه است، پس اتصال زنده هم باید با توکن تازه برقرار شود.
          if (state.socket) {
            state.socket.onclose = null;
            state.socket.close();
          }
          connectSocket();
        } catch (err) {
          toast(err.message, true);
        } finally {
          changePassword.disabled = false;
        }
      });

      const notifyBtn = document.createElement('button');
      notifyBtn.className = 'btn';
      notifyBtn.textContent = '🔔 فعال‌سازی اعلان‌ها';
      notifyBtn.addEventListener('click', () => requestNotificationPermission({ force: true }));

      const logout = document.createElement('button');
      logout.className = 'btn btn-danger';
      logout.textContent = 'خروج از حساب';
      logout.addEventListener('click', async () => {
        await api('/auth/logout', { method: 'POST' }).catch(() => {});
        closeModal();
        signOut();
      });

      body.append(
        username, name, bio, save,
        divider, currentPassword, newPassword, changePassword,
        notifyBtn, logout
      );
    });
  }

  function chatInfoModal() {
    const conv = state.conversations.get(state.activeId);
    if (!conv) return;

    openModal(conv.type === 'group' ? 'اطلاعات گروه' : 'اطلاعات مخاطب', (body) => {
      const heading = document.createElement('div');
      heading.style.display = 'flex';
      heading.style.gap = '10px';
      heading.style.alignItems = 'center';
      const avatar = document.createElement('span');
      avatar.className = 'avatar';
      paintAvatar(avatar, conv.title, conv.avatarColor, conv.peer?.online);
      const text = document.createElement('div');
      text.innerHTML = '<strong></strong><br /><small class="muted"></small>';
      text.querySelector('strong').textContent = conv.title;
      text.querySelector('small').textContent = chatStatusText(conv);
      heading.append(avatar, text);
      body.appendChild(heading);

      if (conv.type === 'direct' && !conv.peer) {
        const gone = document.createElement('p');
        gone.className = 'muted';
        gone.textContent =
          'حساب طرف مقابل حذف شده است. می‌توانید این گفتگو را از فهرست خود پاک کنید.';
        body.appendChild(gone);
      }

      if (conv.type === 'direct' && conv.peer?.bio) {
        const bio = document.createElement('p');
        bio.className = 'muted';
        bio.textContent = conv.peer.bio;
        body.appendChild(bio);
      }

      const removeChat = document.createElement('button');
      removeChat.className = 'btn btn-danger';
      removeChat.textContent = '🗑 حذف گفتگو (فقط برای من)';
      removeChat.addEventListener('click', async () => {
        if (!confirm('این گفتگو از فهرست شما پاک شود؟ طرف مقابل نسخه‌ی خودش را خواهد داشت.')) return;
        try {
          await api(`/conversations/${conv.id}`, { method: 'DELETE' });
          state.conversations.delete(conv.id);
          closeModal();
          if (state.activeId === conv.id) closeChat();
          renderConversations();
          toast('گفتگو پاک شد.');
        } catch (err) {
          toast(err.message, true);
        }
      });

      if (conv.type === 'group') {
        for (const member of conv.members) {
          const row = userRow(member);
          if (member.role === 'owner') row.querySelector('small').append(' — سازنده');
          body.appendChild(row);
        }

        // دکمه فقط برای سازنده‌ی گروه معنی دارد؛ سرور هم همین را الزام می‌کند.
        const iAmOwner = conv.members.find((m) => m.id === state.me.id)?.role === 'owner';
        if (iAmOwner) {
          const add = document.createElement('button');
          add.className = 'btn';
          add.textContent = '➕ افزودن عضو';
          add.addEventListener('click', () => addMemberModal(conv));
          body.appendChild(add);
        }

        const leave = document.createElement('button');
        leave.className = 'btn btn-danger';
        leave.textContent = 'خروج از گروه';
        leave.addEventListener('click', async () => {
          if (!confirm('از این گروه خارج می‌شوید؟')) return;
          try {
            await api(`/conversations/${conv.id}/members/me`, { method: 'DELETE' });
            state.conversations.delete(conv.id);
            closeModal();
            closeChat();
            renderConversations();
          } catch (err) {
            toast(err.message, true);
          }
        });
        body.appendChild(leave);
      }

      body.appendChild(removeChat);
    });
  }

  function addMemberModal(conv) {
    openModal('افزودن عضو', (body) => {
      const search = document.createElement('input');
      search.type = 'search';
      search.placeholder = 'نام کاربری دقیق…';
      const results = document.createElement('div');
      results.style.display = 'grid';
      results.style.gap = '8px';

      let timer;
      search.addEventListener('input', () => {
        clearTimeout(timer);
        const query = search.value.trim();
        timer = setTimeout(async () => {
          if (!query) return (results.innerHTML = '');
          const data = await api(`/users?q=${encodeURIComponent(query)}`).catch(() => ({ users: [] }));
          results.innerHTML = '';
          for (const user of data.users) {
            if (conv.members.some((m) => m.id === user.id)) continue;
            results.appendChild(
              userRow(user, {
                onClick: async () => {
                  try {
                    const data = await api(`/conversations/${conv.id}/members`, {
                      method: 'POST',
                      body: { username: user.username },
                    });
                    upsertConversation(data.conversation);
                    closeModal();
                    toast('عضو اضافه شد.');
                  } catch (err) {
                    toast(err.message, true);
                  }
                },
              })
            );
          }
        }, 220);
      });

      body.append(search, results);
      search.focus();
    });
  }

  /* -------------------------------- راه‌اندازی ---------------------------- */

  function closeChat() {
    state.activeId = null;
    state.messages = [];
    $('chatView').classList.add('is-hidden');
    $('emptyState').classList.remove('is-hidden');
    $('appScreen').classList.remove('show-chat');
  }

  function renderMe() {
    paintAvatar($('meAvatar'), state.me.displayName, state.me.avatarColor, true);
    $('meName').textContent = state.me.displayName;
    $('adminLink').classList.toggle('is-hidden', !state.me.isAdmin);
  }

  async function showWipeInfo() {
    try {
      const health = await fetch('/api/health').then((r) => r.json());
      $('wipeInfo').textContent = health.retentionNotice || '';
    } catch {
      /* نمایش این اطلاعات اختیاری است */
    }
  }

  async function startApp(user) {
    state.me = user;
    $('authScreen').classList.add('is-hidden');
    $('appScreen').classList.remove('is-hidden');
    renderMe();
    await loadConversations();
    api('/call/config')
      .then((data) => {
        state.callEnabled = Boolean(data.enabled);
        if (state.activeId) renderChatHeader();
      })
      .catch(() => {});
    connectSocket();
    showWipeInfo();
    requestNotificationPermission();
  }

  $('newChatBtn').addEventListener('click', newChatModal);
  $('profileBtn').addEventListener('click', profileModal);
  $('chatInfoBtn').addEventListener('click', chatInfoModal);
  $('backBtn').addEventListener('click', closeChat);
  $('conversationSearch').addEventListener('input', (event) => {
    state.filter = event.target.value;
    renderConversations();
  });
  $('messageList').addEventListener('scroll', () => {
    if ($('messageList').scrollTop < 60) loadOlderMessages();
    updateJumpButton();
  });
  $('jumpToLatest').addEventListener('click', () => {
    const list = $('messageList');
    list.scrollTo({ top: list.scrollHeight, behavior: 'smooth' });
    state.missedWhileUp = 0;
    markConversationRead();
    updateJumpButton();
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && state.activeId) markConversationRead();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    if (!$('lightbox').classList.contains('is-hidden')) {
      $('lightbox').classList.add('is-hidden');
      return;
    }
    closeModal();
  });

  async function boot() {
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('/sw.js').catch(() => {});
      navigator.serviceWorker.addEventListener('message', (event) => {
        if (event.data?.type === 'open-conversation' && event.data.conversationId) {
          openConversation(Number(event.data.conversationId));
        }
      });
    }
    if (!state.token) return;
    try {
      const data = await api('/me');
      state.fileToken = data.fileToken || null;
      if (data.user.status !== 'approved') {
        signOut(
          data.user.status === 'blocked'
            ? 'حساب شما مسدود شده است.'
            : 'حساب شما هنوز توسط مدیر تایید نشده است.'
        );
        return;
      }
      await startApp(data.user);
    } catch {
      signOut();
    }
  }

  boot();
})();
