/* 9chat — منطق سمت کاربر */
(() => {
  'use strict';

  /* لایه‌ی زبان در i18n.js بار می‌شود و پیش از این فایل اجرا شده است.
     اگر به هر دلیلی نبود، برنامه نباید بخوابد: متن فارسی برمی‌گردد. */
  const i18n = window.i18n || {
    t: (key, vars) =>
      vars
        ? Object.entries(vars).reduce((out, [k, v]) => out.split(`{${k}}`).join(String(v)), key)
        : key,
    num: (n) => Number(n).toLocaleString('fa-IR'),
    localeOf: () => 'fa-IR',
    translateDom: () => {},
    setLang: () => {},
    langs: [['fa', 'فارسی', 'rtl']],
    current: 'fa',
  };
  const t = (key, vars) => i18n.t(key, vars);

  const $ = (id) => document.getElementById(id);
  const TOKEN_KEY = 'messenger.token';
  const MAX_IMAGE_EDGE = 1600; // عکس‌ها پیش از آپلود تا این اندازه کوچک می‌شوند
  const AVATAR_EDGE = 512; // عکس پروفایل مربع و در این اندازه ذخیره می‌شود
  const MAX_FILE_BYTES = 100 * 1024 * 1024; // باید با MAX_FILE_BYTES سرور یکی باشد
  const IMAGE_QUALITY = 0.82;

  const state = {
    token: localStorage.getItem(TOKEN_KEY) || null,
    me: null,
    conversations: new Map(),
    activeId: null,
    messages: [],
    hasMore: false,
    tab: 'chats',
    loadingMore: false,
    replyTo: null,
    editing: null,
    pendingImage: null,
    recorder: null,
    recordStartedAt: 0,
    recordTimer: null,
    typingPeers: new Map(),
    picked: new Set(),
    missedWhileUp: 0,
    stickToBottom: true,
    searchTimer: null,
    clientVersion: null,
    androidVersion: null,
    builtAt: null,
    stories: [],
    updateDismissed: false,
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

  const fa = (n) => i18n.num(n);
  const initials = (name) => (name || '?').trim().charAt(0).toUpperCase();

  /** وضعیت اتصال در نوار بالا: متن، به‌علاوه‌ی رنگِ نقطه‌ی کنارش. */
  function setConnectionState(text, mode) {
    const el = $('connectionState');
    el.textContent = text;
    el.classList.toggle('is-online', mode === 'is-online');
    el.classList.toggle('is-off', mode === 'is-off');
  }

  /** پیام کوتاهِ «چیزی اینجا نیست». متن همیشه به‌صورت textContent می‌نشیند. */
  function emptyNote(text, className = 'empty-list') {
    const p = document.createElement('p');
    p.className = className;
    p.textContent = text;
    return p;
  }

  const timeText = (ts) =>
    new Date(ts).toLocaleTimeString(i18n.localeOf(), { hour: '2-digit', minute: '2-digit' });

  const dayText = (ts) => {
    const date = new Date(ts);
    const today = new Date();
    const yesterday = new Date(Date.now() - 86400000);
    const same = (a, b) => a.toDateString() === b.toDateString();
    if (same(date, today)) return t('امروز');
    if (same(date, yesterday)) return t('دیروز');
    return date.toLocaleDateString(i18n.localeOf(), {
      year: 'numeric', month: 'long', day: 'numeric',
    });
  };

  const relativeTime = (ts) => {
    if (!ts) return '';
    const diff = Date.now() - ts;
    if (diff < 60000) return t('همین حالا');
    if (diff < 3600000) return t('{n} دقیقه پیش', { n: fa(Math.floor(diff / 60000)) });
    if (diff < 86400000) return t('{n} ساعت پیش', { n: fa(Math.floor(diff / 3600000)) });
    return t('{n} روز پیش', { n: fa(Math.floor(diff / 86400000)) });
  };

  const fileSize = (bytes) => {
    if (!bytes) return '';
    const units = [t('بایت'), t('کیلوبایت'), t('مگابایت')];
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

  function paintAvatar(el, name, color, online, avatarUrl = null) {
    // `background` را ست نمی‌کنیم چون شورتهند است و backgroundImage را پاک می‌کند.
    el.style.backgroundColor = color || 'var(--accent)';
    el.style.backgroundImage = avatarUrl ? `url("${fileUrl(avatarUrl)}")` : '';
    el.textContent = avatarUrl ? '' : initials(name);
    el.classList.toggle('has-photo', Boolean(avatarUrl));
    el.classList.toggle('online', Boolean(online));
  }

  /* ------------------------------ تم ظاهری ------------------------------ */

  /**
   * تم سه حالت دارد: «خودکار» (پیروی از سیستم‌عامل، پیش‌فرض) و دو حالت دستی.
   * هر سه انتخابِ ظاهری در همین مرورگر می‌ماند — روی سرور ذخیره نمی‌شود، پس
   * چیزی به حساب کاربر اضافه نمی‌کند و روی هر دستگاه جداگانه است.
   */
  const THEME_KEY = 'messenger.theme';

  function applyTheme(theme) {
    if (theme === 'light' || theme === 'dark') document.documentElement.dataset.theme = theme;
    else delete document.documentElement.dataset.theme;
  }

  /* رنگ لهجه و پس‌زمینه‌ی گفتگو. هر دو فقط یک data-attribute روی <html>
     می‌گذارند؛ CSS بقیه‌ی توکن‌ها را از همان‌ها می‌سازد. */
  const ACCENT_KEY = 'messenger.accent';
  const WALL_KEY = 'messenger.wall';
  const WALL_IMAGE_KEY = 'messenger.wallImage';
  /* عکس دلخواه فقط روی همین دستگاه می‌ماند و هیچ‌وقت به سرور نمی‌رود. */
  const WALL_IMAGE_EDGE = 1280;
  const WALL_IMAGE_MAX_BYTES = 2 * 1024 * 1024;

  const ACCENTS = [
    ['indigo', t('بنفش‌آبی')],
    ['violet', t('بنفش')],
    ['blue', t('آبی')],
    ['teal', t('فیروزه‌ای')],
    ['rose', t('سرخابی')],
    ['amber', t('کهربایی')],
  ];

  const WALLS = [
    ['mesh', t('مه رنگی')],
    ['aurora', t('شفق')],
    ['sunset', t('غروب')],
    ['ocean', t('اقیانوس')],
    ['forest', t('جنگل')],
    ['plum', t('ارغوانی')],
    ['night', t('شب')],
    ['waves', t('راه‌راه')],
    ['dots', t('نقطه‌چین')],
    ['grid', t('شبکه')],
    ['plain', t('ساده')],
  ];

  const DEFAULT_ACCENT = 'indigo';
  const DEFAULT_WALL = 'mesh';

  const storedAccent = () => localStorage.getItem(ACCENT_KEY) || DEFAULT_ACCENT;
  const storedWall = () => localStorage.getItem(WALL_KEY) || DEFAULT_WALL;


  function applyAccent(name) {
    document.documentElement.dataset.accent =
      ACCENTS.some(([id]) => id === name) ? name : DEFAULT_ACCENT;
  }

  const wallImage = () => {
    try {
      return localStorage.getItem(WALL_IMAGE_KEY);
    } catch {
      return null;
    }
  };

  function applyWall(name) {
    const root = document.documentElement;
    if (name === 'custom') {
      const image = wallImage();
      // عکس پاک شده ولی انتخاب مانده: به پیش‌فرض برمی‌گردیم تا تخت نماند.
      if (!image) return applyWall(DEFAULT_WALL);
      root.style.setProperty('--wall-custom', `url("${image}")`);
      root.dataset.wall = 'custom';
      return;
    }
    root.style.removeProperty('--wall-custom');
    root.dataset.wall = WALLS.some(([id]) => id === name) ? name : DEFAULT_WALL;
  }

  /**
   * عکس گالری را برای پس‌زمینه آماده می‌کند: بلندترین ضلع تا ۱۲۸۰ کوچک
   * می‌شود و خروجی JPEG است، چون باید در localStorage همین مرورگر جا شود.
   */
  async function prepareWallImage(file) {
    const bitmap = await createImageBitmap(file).catch(() => null);
    if (!bitmap) throw new Error(t('این فایل عکس نیست.'));

    const scale = Math.min(1, WALL_IMAGE_EDGE / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close?.();

    // کیفیت پایین می‌آید تا در سهمیه‌ی مرورگر جا شود؛ نه بی‌نهایت.
    for (const quality of [0.72, 0.6, 0.45]) {
      const url = canvas.toDataURL('image/jpeg', quality);
      if (url.length <= WALL_IMAGE_MAX_BYTES) return url;
    }
    throw new Error(t('این عکس خیلی بزرگ است؛ عکس کوچک‌تری انتخاب کنید.'));
  }

  /**
   * سه انتخابگرِ ظاهر در یک جعبه. هم از دکمه‌ی سربرگ باز می‌شود و هم
   * داخل پنجره‌ی پروفایل می‌نشیند — چون کاربر تم را آنجا می‌جوید.
   */
  function appearanceSection() {
    const box = document.createElement('div');
    {
      const section = (heading, className) => {
        const wrap = document.createElement('div');
        wrap.className = 'look-section';
        const title = document.createElement('h4');
        title.textContent = heading;
        const row = document.createElement('div');
        row.className = className;
        wrap.append(title, row);
        box.appendChild(wrap);
        return row;
      };

      // ---- زبان
      const langRow = section(t('زبان'), 'look-row');
      for (const [code, label] of i18n.langs) {
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = label;
        // نام هر زبان همیشه به خطِ خودش نوشته می‌شود، پس جهتش را هم
        // جدا می‌گذاریم تا «English» وسط متن فارسی نشکند.
        button.dir = code === 'fa' ? 'rtl' : 'ltr';
        button.classList.toggle('is-active', code === i18n.current);
        button.addEventListener('click', () => {
          if (code === i18n.current) return;
          i18n.setLang(code);
        });
        langRow.appendChild(button);
      }

      // ---- تم
      const themeRow = section(t('تم'), 'look-row');
      const current = localStorage.getItem(THEME_KEY) || 'auto';
      for (const [value, label] of [['auto', t('خودکار')], ['light', t('روشن')], ['dark', t('تیره')]]) {
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = label;
        button.classList.toggle('is-active', value === current);
        button.addEventListener('click', () => {
          if (value === 'auto') localStorage.removeItem(THEME_KEY);
          else localStorage.setItem(THEME_KEY, value);
          applyTheme(localStorage.getItem(THEME_KEY));
          for (const sibling of themeRow.children) sibling.classList.remove('is-active');
          button.classList.add('is-active');
        });
        themeRow.appendChild(button);
      }

      // ---- رنگ لهجه
      const accentRow = section(t('رنگ'), 'swatches');
      for (const [id, label] of ACCENTS) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'swatch';
        button.dataset.accent = id;
        button.title = label;
        button.setAttribute('aria-label', t('رنگ {label}', { label }));
        button.classList.toggle('is-active', id === storedAccent());
        button.addEventListener('click', () => {
          localStorage.setItem(ACCENT_KEY, id);
          applyAccent(id);
          for (const sibling of accentRow.children) sibling.classList.remove('is-active');
          button.classList.add('is-active');
        });
        accentRow.appendChild(button);
      }

      // ---- پس‌زمینه‌ی گفتگو
      const wallRow = section(t('پس‌زمینه‌ی گفتگو'), 'walls');
      for (const [id, label] of WALLS) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'wall-chip';
        button.dataset.wall = id;
        button.title = label;
        button.setAttribute('aria-label', t('پس‌زمینه‌ی {label}', { label }));
        button.classList.toggle('is-active', id === storedWall());
        button.addEventListener('click', () => {
          localStorage.setItem(WALL_KEY, id);
          applyWall(id);
          for (const sibling of wallRow.children) sibling.classList.remove('is-active');
          button.classList.add('is-active');
        });
        wallRow.appendChild(button);
      }

      // ---- عکس دلخواه از گالری
      const pick = document.createElement('button');
      pick.type = 'button';
      pick.className = 'wall-chip wall-pick';
      pick.dataset.wall = 'custom';
      pick.title = t('عکس از گالری');
      pick.setAttribute('aria-label', t('انتخاب عکس پس‌زمینه از گالری'));

      const file = document.createElement('input');
      file.type = 'file';
      file.accept = 'image/*';
      file.className = 'is-hidden';

      const drawPick = () => {
        const image = wallImage();
        pick.style.backgroundImage = image ? `url("${image}")` : '';
        pick.classList.toggle('has-image', Boolean(image));
        pick.textContent = image ? '' : '＋';
        pick.classList.toggle('is-active', storedWall() === 'custom' && Boolean(image));
      };

      const markActive = (node) => {
        for (const sibling of wallRow.children) sibling.classList.remove('is-active');
        node.classList.add('is-active');
      };

      pick.addEventListener('click', () => {
        // اگر عکسی هست، ضربه همان را انتخاب می‌کند؛ برای عوض کردنش دکمه‌ی
        // جداگانه‌ی زیرش هست، تا کسی عکسش را ناخواسته از دست ندهد.
        if (wallImage() && storedWall() !== 'custom') {
          localStorage.setItem(WALL_KEY, 'custom');
          applyWall('custom');
          markActive(pick);
          return;
        }
        file.click();
      });

      file.addEventListener('change', async () => {
        const chosen = file.files?.[0];
        file.value = '';
        if (!chosen) return;
        try {
          const url = await prepareWallImage(chosen);
          try {
            localStorage.setItem(WALL_IMAGE_KEY, url);
          } catch {
            throw new Error(t('جای کافی در این مرورگر نیست؛ عکس کوچک‌تری انتخاب کنید.'));
          }
          localStorage.setItem(WALL_KEY, 'custom');
          applyWall('custom');
          drawPick();
          markActive(pick);
          removeImage.classList.remove('is-hidden');
          toast(t('پس‌زمینه عوض شد.'));
        } catch (err) {
          toast(err.message, true);
        }
      });

      const removeImage = document.createElement('button');
      removeImage.type = 'button';
      removeImage.className = 'btn wall-clear';
      removeImage.textContent = t('برداشتن عکس پس‌زمینه');
      removeImage.classList.toggle('is-hidden', !wallImage());
      removeImage.addEventListener('click', () => {
        localStorage.removeItem(WALL_IMAGE_KEY);
        if (storedWall() === 'custom') {
          localStorage.setItem(WALL_KEY, DEFAULT_WALL);
          applyWall(DEFAULT_WALL);
          markActive(wallRow.querySelector(`[data-wall="${DEFAULT_WALL}"]`));
        }
        drawPick();
        removeImage.classList.add('is-hidden');
      });

      drawPick();
      wallRow.appendChild(pick);
      wallRow.after(file, removeImage);
    }
    return box;
  }

  /** همان جعبه، این بار به‌تنهایی از دکمه‌ی سربرگ. */
  function appearanceModal() {
    openModal(t('ظاهر'), (body) => body.appendChild(appearanceSection()));
  }

  applyTheme(localStorage.getItem(THEME_KEY));
  applyAccent(storedAccent());
  applyWall(storedWall());
  // متن‌های ثابتِ index.html هم باید به زبان انتخابی دربیایند.
  i18n.translateDom();

  /**
   * نشانی فایل با توکن کوتاه‌عمرِ مخصوص فایل ساخته می‌شود — نه با توکن نشست،
   * چون توکن نشست در لاگ و تاریخچه می‌نشیند و دسترسی کامل به حساب می‌دهد.
   */
  const fileUrl = (url) =>
    `${url}${url.includes('?') ? '&' : '?'}t=${encodeURIComponent(state.fileToken || '')}`;

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
      const error = new Error(data.error || t('خطای ناشناخته'));
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
    setAuthMessage(t('در حال ورود…'));
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
    setAuthMessage(t('در حال ثبت‌نام…'));
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
    if (!message) return t('هنوز پیامی رد و بدل نشده');
    const prefix = message.senderId === state.me.id ? t('شما: ') : '';
    if (message.deleted) return t('{prefix}پیام حذف شد', { prefix });
    if (message.kind === 'system') return message.body;
    if (message.kind === 'image') {
      return t('{prefix}🖼 عکس', { prefix }) + (message.body ? ` — ${message.body}` : '');
    }
    if (message.kind === 'voice') return t('{prefix}🎤 پیام صوتی', { prefix });
    if (message.kind === 'file') return t('{prefix}📎 {name}', { prefix, name: message.attachment?.name || t('فایل') });
    if (message.kind === 'call') return `${message.body.startsWith('video-') ? '📹' : '📞'} ${callRecordText(message)}`;
    return prefix + message.body;
  }

  /** منوی کوتاه یک گفتگو: سنجاق، بی‌صدا، حذف. */
  function conversationMenu(conv) {
    openModal(conv.title, (body) => {
      const make = (label, onClick, danger = false) => {
        const button = document.createElement('button');
        button.className = `btn${danger ? ' btn-danger' : ''}`;
        button.textContent = label;
        button.addEventListener('click', onClick);
        return button;
      };
      body.append(
        make(conv.pinned ? t('📌 برداشتن سنجاق') : t('📌 سنجاق کردن'), async () => {
          await setConversationFlag(conv, { pinned: !conv.pinned });
          closeModal();
        }),
        make(conv.muted ? t('🔔 روشن کردن صدا') : t('🔕 بی‌صدا کردن'), async () => {
          await setConversationFlag(conv, { muted: !conv.muted });
          closeModal();
        }),
        make(conv.archived ? t('📤 خارج کردن از بایگانی') : t('📥 بایگانی کردن'), async () => {
          await setConversationFlag(conv, { archived: !conv.archived });
          closeModal();
        }),
        make(t('🔵 علامت‌زدن به‌عنوان خوانده‌نشده'), async () => {
          await setConversationFlag(conv, { unread: true });
          closeModal();
        })
      );
    });
  }

  /**
   * هم فهرست کاملِ تبِ «گفتگوها» را می‌سازد و هم نتیجه‌ی تبِ «جستجو» را.
   * یک تابع، چون هر دو دقیقاً یک ردیف را نشان می‌دهند.
   */
  function renderConversations() {
    drawConversations($('conversationList'), '');
    if (state.tab === 'search') drawConversations($('searchResults'), state.filter);
  }

  function drawConversations(list, rawFilter) {
    const filter = rawFilter.trim().toLowerCase();
    // صفحه‌ی جستجو تا وقتی چیزی ننوشته‌اند خالی می‌ماند؛ وگرنه همان فهرستِ
    // کاملِ تبِ گفتگوها را دوباره نشان می‌داد.
    if (!filter && list.id === 'searchResults') {
      list.innerHTML = '';
      return;
    }
    const items = [...state.conversations.values()]
      .filter((conv) => !filter || conv.title.toLowerCase().includes(filter))
      .sort((a, b) => (b.lastMessage?.id || 0) - (a.lastMessage?.id || 0));

    list.innerHTML = '';
    if (items.length === 0) {
      list.appendChild(emptyNote(
        filter ? t('گفتگویی پیدا نشد.') : t('هنوز گفتگویی ندارید. با دکمه + شروع کنید.')
      ));
      return;
    }

    for (const conv of items) {
      const button = document.createElement('button');
      button.className = `conversation${conv.id === state.activeId ? ' is-active' : ''}${
        conv.pinned ? ' is-pinned' : ''
      }`;
      // نگه‌داشتن انگشت یا راست‌کلیک: سنجاق و بی‌صدا
      button.addEventListener('contextmenu', (event) => {
        event.preventDefault();
        conversationMenu(conv);
      });
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
      paintAvatar(
        button.querySelector('.avatar'),
        conv.title,
        conv.avatarColor,
        online,
        conv.avatarUrl
      );
      const nameCell = button.querySelector('.conversation-name');
      nameCell.textContent = conv.title;
      for (const [flag, mark, title] of [
        [conv.pinned, '📌', t('سنجاق‌شده')],
        [conv.muted, '🔕', t('بی‌صدا')],
        [conv.archived, '📥', t('بایگانی‌شده')],
      ]) {
        if (!flag) continue;
        const icon = document.createElement('span');
        icon.className = 'conversation-flag';
        icon.textContent = mark;
        icon.title = title;
        nameCell.appendChild(icon);
      }
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
    if (conv.type === 'group') return t('{n} عضو', { n: fa(conv.memberCount) });
    if (!conv.peer) return t('این حساب دیگر وجود ندارد');
    return conv.peer.online ? t('آنلاین') : t('آخرین بازدید {when}', { when: relativeTime(conv.peer.lastSeenAt) });
  }

  function renderChatHeader() {
    const conv = state.conversations.get(state.activeId);
    if (!conv) return;
    paintAvatar(
      $('chatAvatar'),
      conv.title,
      conv.avatarColor,
      conv.type === 'direct' && conv.peer?.online,
      conv.avatarUrl
    );
    $('chatName').textContent = conv.title;
    $('chatStatus').textContent = chatStatusText(conv);
    // تماس فقط در گفتگوی دونفره، و فقط اگر سرور TURN تنظیم شده باشد.
    const callable = state.callEnabled && conv.type === 'direct' && Boolean(conv.peer);
    // دو دکمه داخل یک کپسول‌اند، پس با هم پنهان و نمایان می‌شوند.
    $('callPill').classList.toggle('is-hidden', !callable);
  }

  /**
   * نشانی‌های داخل متن را به پیوند تبدیل می‌کند.
   *
   * با گره‌های DOM ساخته می‌شود و نه با innerHTML، تا متنی که کاربر فرستاده
   * هیچ‌وقت به‌عنوان HTML اجرا نشود. فقط http و https پذیرفته می‌شوند؛ مثلاً
   * javascript: پیوند نمی‌شود.
   */
  const URL_PATTERN = /(https?:\/\/[^\s<>"']+|(?:^|[\s(])www\.[^\s<>"']+)/gi;

  function linkify(container, text) {
    let last = 0;
    for (const match of text.matchAll(URL_PATTERN)) {
      // الگو ممکن است یک فاصله‌ی ابتدایی را هم گرفته باشد.
      const lead = match[0].match(/^[\s(]/) ? match[0][0] : '';
      const start = match.index + lead.length;
      let raw = match[0].slice(lead.length);

      // نقطه و پرانتز پایانی معمولاً نشانه‌گذاری جمله‌اند، نه بخشی از نشانی.
      const trimmed = raw.replace(/[.,!?؛،)\]]+$/u, '');
      const href = trimmed.startsWith('www.') ? `https://${trimmed}` : trimmed;

      if (start > last) container.appendChild(document.createTextNode(text.slice(last, start)));
      const link = document.createElement('a');
      link.href = href;
      link.target = '_blank';
      link.rel = 'noopener noreferrer nofollow';
      link.className = 'bubble-link';
      link.textContent = trimmed;
      container.appendChild(link);
      last = start + trimmed.length;
    }
    if (last < text.length) container.appendChild(document.createTextNode(text.slice(last)));
    return container;
  }

  function senderName(senderId) {
    const conv = state.conversations.get(state.activeId);
    const member = conv?.members.find((m) => m.id === senderId);
    return member ? member.displayName : t('کاربر حذف‌شده');
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
    const inGroup = !mine && conv?.type === 'group';
    if (inGroup) {
      // نخستین پیام هر دسته آواتار می‌گیرد؛ بقیه فقط جای خالی، تا هم‌تراز بمانند.
      if (grouped) {
        const gap = document.createElement('span');
        gap.className = 'row-avatar-gap';
        row.appendChild(gap);
      } else {
        const sender = conv.members.find((m) => m.id === message.senderId);
        const avatar = document.createElement('span');
        avatar.className = 'avatar row-avatar';
        paintAvatar(
          avatar,
          senderName(message.senderId),
          sender?.avatarColor,
          false,
          sender?.avatarUrl
        );
        row.appendChild(avatar);
      }

      if (!grouped) {
        const author = document.createElement('div');
        author.className = 'bubble-author';
        author.textContent = senderName(message.senderId);
        bubble.appendChild(author);
      }
    }

    if (message.forwarded && !message.deleted) {
      const tag = document.createElement('div');
      tag.className = 'bubble-forwarded';
      tag.textContent = t('↪ بازفرستاده‌شده');
      bubble.appendChild(tag);
    }

    if (message.replyTo) {
      const reply = document.createElement('div');
      reply.className = 'bubble-reply';
      const who = document.createElement('small');
      who.textContent = senderName(message.replyTo.senderId);
      const text = document.createElement('span');
      text.textContent = message.replyTo.deleted
        ? t('پیام حذف شد')
        : message.replyTo.kind === 'image'
          ? t('🖼 عکس') + (message.replyTo.body ? ` — ${message.replyTo.body}` : '')
          : message.replyTo.kind === 'voice'
            ? t('🎤 پیام صوتی')
            : message.replyTo.body;
      reply.append(who, text);
      reply.addEventListener('click', () => scrollToMessage(message.replyTo.id));
      bubble.appendChild(reply);
    }

    if (message.kind === 'image' && message.attachment) {
      const button = document.createElement('button');
      button.className = 'bubble-image';
      button.type = 'button';
      // اندازه را از قبل و به پیکسل می‌دهیم، نه فقط با نسبت ابعاد: حبابِ
      // فقط-عکس عرض ذاتی ندارد، پس پیش از بار شدن عکس `width: 100%` تقریباً
      // صفر می‌شود و هیچ فضایی رزرو نمی‌ماند — بعد عکس که می‌آید فهرست
      // بلندتر می‌شود و کاربر وسط تاریخچه جا می‌ماند.
      const { width, height } = message.attachment;
      if (width && height) {
        const maxWidth = Math.min(420, Math.round(window.innerWidth * 0.66));
        const maxHeight = Math.round(window.innerHeight * 0.62);
        const scale = Math.min(1, maxWidth / width, maxHeight / height);
        button.style.width = `${Math.round(width * scale)}px`;
        button.style.height = `${Math.round(height * scale)}px`;
      } else {
        // بدون ابعاد (عکس‌های قدیمی) دست‌کم یک جای پیش‌فرض نگه می‌داریم.
        button.style.aspectRatio = '4 / 3';
        button.style.width = '280px';
      }
      const img = document.createElement('img');
      img.loading = 'lazy';
      img.decoding = 'async';
      img.alt = message.attachment.name || t('عکس');
      img.src = fileUrl(message.attachment.url);
      keepPinnedAfterLoad(img);
      button.appendChild(img);
      button.addEventListener('click', () => openLightbox(message.attachment));
      bubble.appendChild(button);
    }

    if (message.kind === 'voice' && message.attachment) {
      bubble.appendChild(voicePlayer(message));
    }

    if (message.kind === 'file' && message.attachment) {
      bubble.appendChild(fileCard(message));
    }

    if (message.body || message.deleted) {
      const text = document.createElement('div');
      text.className = `bubble-text${message.deleted ? ' deleted' : ''}`;
      if (message.deleted) text.textContent = t('این پیام حذف شد');
      else linkify(text, message.body);
      bubble.appendChild(text);
    }

    const meta = document.createElement('div');
    meta.className = 'bubble-meta';
    const time = document.createElement('span');
    time.textContent = timeText(message.createdAt);
    meta.appendChild(time);
    if (message.editedAt && !message.deleted) {
      const edited = document.createElement('span');
      edited.textContent = t('(ویرایش‌شده)');
      meta.appendChild(edited);
    }
    if (mine && !message.deleted) {
      const state = message.pending ? 'pending' : message.id <= readUpTo() ? 'read' : 'sent';
      meta.appendChild(tickIcon(state));
    }
    bubble.appendChild(meta);

    if (message.reactions?.length) bubble.appendChild(reactionBar(message));

    if (!message.deleted && !message.pending) {
      const actions = document.createElement('div');
      actions.className = 'bubble-actions';
      actions.appendChild(iconButton('😊', t('واکنش'), () => openReactionPicker(message)));
      if (message.body) {
        actions.appendChild(
          iconButton('⧉', t('کپی متن'), async () => {
            const ok = await copyText(message.body);
            toast(ok ? t('متن کپی شد.') : t('کپی ممکن نشد.'), !ok);
          })
        );
      }
      actions.appendChild(iconButton('☑', t('انتخاب'), () => togglePick(message.id, true)));
      actions.appendChild(iconButton('↪', t('بازفرستادن'), () => forwardModal(message)));
      actions.appendChild(iconButton('↩', t('پاسخ'), () => startReply(message)));
      if (mine && message.kind !== 'voice') {
        actions.appendChild(iconButton('✎', t('ویرایش'), () => startEdit(message)));
      }
      if (mine) {
        actions.appendChild(iconButton('🗑', t('حذف'), () => removeMessage(message)));
      }
      bubble.appendChild(actions);
      bubble.addEventListener('contextmenu', (event) => {
        event.preventDefault();
        document.querySelectorAll('.bubble.show-actions').forEach((b) => b.classList.remove('show-actions'));
        bubble.classList.add('show-actions');
      });
    }

    if (message.pending) bubble.style.opacity = '.6';
    if (state.picked.has(message.id)) row.classList.add('is-picked');
    // در حالت انتخاب، کلیک روی هر جای پیام یعنی انتخاب/لغو انتخاب.
    if (state.picked.size > 0) {
      row.addEventListener('click', (event) => {
        if (event.target.closest('a, button, audio, video')) return;
        togglePick(message.id);
      });
    }
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
    const video = message.body.startsWith('video-');
    const status = video ? message.body.slice(6) : message.body;
    const what = video ? t('تماس تصویری') : t('تماس صوتی');
    if (status === 'ended') return `${what} · ${clockText(message.durationMs)}`;
    if (status === 'declined') return mine ? t('{what} رد شد', { what }) : t('{what} را رد کردید', { what });
    return t('{what} بی‌پاسخ', { what });
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
    play.setAttribute('aria-label', t('پخش پیام صوتی'));
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
        audio.play().catch(() => toast(t('پخش صدا ممکن نشد.'), true));
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

  const PLAYABLE = /\.(mp4|webm|mp3|m4a|ogg|wav)$/i;

  /** حباب پیوست فایل: ویدیو و صوت پخش می‌شوند، بقیه دکمه‌ی دانلود دارند. */
  function fileCard(message) {
    const { name, size, url } = message.attachment;
    const wrap = document.createElement('div');

    if (PLAYABLE.test(name || '')) {
      const media = document.createElement(/\.(mp4|webm)$/i.test(name) ? 'video' : 'audio');
      media.src = fileUrl(url);
      media.controls = true;
      media.preload = 'metadata';
      media.className = 'bubble-media';
      wrap.appendChild(media);
    }

    const card = document.createElement('a');
    card.className = 'file-card';
    card.href = `${fileUrl(url)}&download=1`;
    card.setAttribute('download', name || 'file');

    const icon = document.createElement('span');
    icon.className = 'file-icon';
    icon.textContent = (/\.([a-z0-9]{1,5})$/i.exec(name || '')?.[1] || '?').slice(0, 4);

    const main = document.createElement('span');
    main.className = 'file-main';
    main.append(
      Object.assign(document.createElement('span'), { className: 'file-name', textContent: name }),
      Object.assign(document.createElement('span'), {
        className: 'file-size',
        textContent: fileSize(size),
      })
    );

    card.append(icon, main);
    wrap.appendChild(card);
    return wrap;
  }

  /** آیکون وضعیت پیام: در حال ارسال → ارسال شد → خوانده شد. */
  function tickIcon(state) {
    const span = document.createElement('span');
    span.className = `tick tick-${state}`;
    span.title = { pending: t('در حال ارسال'), sent: t('ارسال شد'), read: t('خوانده شد') }[state];

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

  const REACTIONS = ['👍', '❤️', '😂', '😮', '😢', '🙏', '🔥', '👏'];

  /** نوار واکنش‌های زیر حباب. */
  function reactionBar(message) {
    const bar = document.createElement('div');
    bar.className = 'reactions';
    for (const item of message.reactions) {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = `reaction${item.mine ? ' is-mine' : ''}`;
      chip.title = item.mine ? t('برداشتن واکنش') : t('همین واکنش');
      chip.append(item.emoji, Object.assign(document.createElement('span'), { textContent: fa(item.count) }));
      chip.addEventListener('click', () => sendReaction(message, item.emoji));
      bar.appendChild(chip);
    }
    return bar;
  }

  async function sendReaction(message, emoji) {
    try {
      await api(`/messages/${message.id}/reactions`, { method: 'POST', body: { emoji } });
    } catch (err) {
      toast(err.message, true);
    }
  }

  function openReactionPicker(message) {
    openModal(t('واکنش'), (body) => {
      const grid = document.createElement('div');
      grid.className = 'reaction-picker';
      for (const emoji of REACTIONS) {
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = emoji;
        button.addEventListener('click', async () => {
          await sendReaction(message, emoji);
          closeModal();
        });
        grid.appendChild(button);
      }
      body.appendChild(grid);
    });
  }

  /** انتخاب گفتگوی مقصد برای بازفرستادن. */
  function forwardModal(message) {
    openModal(t('بازفرستادن به…'), (body) => {
      const list = document.createElement('div');
      list.style.display = 'grid';
      list.style.gap = '6px';
      const others = [...state.conversations.values()].filter((c) => !c.orphaned);
      if (others.length === 0) {
        body.innerHTML = emptyNote(t('گفتگویی برای بازفرستادن نیست.')).outerHTML;
        return;
      }
      for (const conv of others) {
        const row = document.createElement('button');
        row.type = 'button';
        row.className = 'user-row';
        const avatar = document.createElement('span');
        avatar.className = 'avatar';
        paintAvatar(avatar, conv.title, conv.avatarColor, false, conv.avatarUrl);
        const main = document.createElement('span');
        main.className = 'user-row-main';
        main.append(Object.assign(document.createElement('strong'), { textContent: conv.title }));
        row.append(avatar, main);
        row.addEventListener('click', async () => {
          row.disabled = true;
          try {
            await api(`/conversations/${conv.id}/forward`, {
              method: 'POST',
              body: { messageId: message.id },
            });
            closeModal();
            toast(t('به «{title}» فرستاده شد.', { title: conv.title }));
          } catch (err) {
            toast(err.message, true);
            row.disabled = false;
          }
        });
        list.appendChild(row);
      }
      body.appendChild(list);
    });
  }

  function iconButton(label, title, onClick) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = label;
    button.title = title;
    button.addEventListener('click', onClick);
    return button;
  }

  /* شناسه‌ی پیام‌هایی که یک‌بار روی صفحه آمده‌اند. تاریخچه‌ای که یکجا بار
     می‌شود از همان اول «دیده» حساب می‌شود، وگرنه با باز کردن هر گفتگو کل
     صفحه با هم می‌پرید. */
  const seenMessageIds = new Set();

  const markAlreadySeen = (messages) => {
    for (const message of messages) if (message.id != null) seenMessageIds.add(message.id);
  };

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
          message.kind === 'call'
            ? `${message.body.startsWith('video-') ? '📹' : '📞'} ${callRecordText(message)}`
            : message.body;
        list.appendChild(system);
        previous = null;
        continue;
      }

      const grouped =
        previous &&
        previous.senderId === message.senderId &&
        message.createdAt - previous.createdAt < 5 * 60 * 1000;
      const row = buildBubble(message, Boolean(grouped));
      // «تازه» یعنی این پیام را هنوز ندیده‌ایم. فهرست در هر بازرسم از نو
      // ساخته می‌شود، پس بدون این نشانه همه‌ی پیام‌ها با هم می‌پریدند.
      if (message.id != null && !seenMessageIds.has(message.id)) {
        seenMessageIds.add(message.id);
        row.classList.add('is-new');
      }
      list.appendChild(row);
      previous = message;
    }

    if (keepScroll) list.scrollTop = list.scrollHeight - previousHeight + previousTop;
    else if (stick) pinToBottom(list);
    else list.scrollTop = previousTop;

    updateJumpButton();
  }

  /**
   * پریدن به انتهای فهرست، بدون انیمیشن.
   *
   * نوشتن مستقیم روی scrollTop وقتی `scroll-behavior: smooth` است، در کروم
   * یک حرکت نرم راه می‌اندازد؛ اگر در همان فاصله عکسی بار شود و ارتفاع فهرست
   * بلندتر شود، حرکت روی مقصدِ قدیمی تمام می‌کند و کاربر وسط تاریخچه می‌ماند.
   */
  function pinToBottom(list) {
    list.scrollTo({ top: list.scrollHeight, behavior: 'instant' });
    state.stickToBottom = true;
  }

  /**
   * عکسی که تازه بار شده ارتفاع فهرست را بلندتر می‌کند. اگر کاربر پایین بود،
   * باید پایین بماند — وگرنه با هر عکس، آخرین پیام از دستش می‌رود.
   */
  function keepPinnedAfterLoad(img) {
    img.addEventListener(
      'load',
      () => {
        // به atBottom تکیه نمی‌کنیم: وقتی عکسِ قبلی فهرست را بلند کرده،
        // همین حالا هم «پایین» نیستیم. نیت کاربر را نگه می‌داریم.
        const list = $('messageList');
        if (list && state.stickToBottom) pinToBottom(list);
        updateJumpButton();
      },
      { once: true }
    );
  }

  /* ------------------------ انتخاب چند پیام ------------------------ */

  function togglePick(id, force = false) {
    if (state.picked.has(id) && !force) state.picked.delete(id);
    else state.picked.add(id);
    renderSelectBar();
    renderMessages({ keepScroll: true });
  }

  function clearPicks() {
    if (state.picked.size === 0) return;
    state.picked.clear();
    renderSelectBar();
    renderMessages({ keepScroll: true });
  }

  function renderSelectBar() {
    const bar = $('selectBar');
    bar.classList.toggle('is-hidden', state.picked.size === 0);
    $('selectCount').textContent = t('{n} پیام انتخاب شده', { n: fa(state.picked.size) });
  }

  /** حذف دسته‌ای. پیام‌هایی که مال ما نیستند از قبل حذف نمی‌شوند. */
  async function removePicked() {
    const mine = state.messages.filter(
      (m) => state.picked.has(m.id) && m.senderId === state.me.id && !m.deleted
    );
    if (mine.length === 0) {
      clearPicks();
      return toast(t('فقط پیام‌های خودتان قابل حذف‌اند.'), true);
    }
    if (!confirm(t('{n} پیام حذف شود؟', { n: fa(mine.length) }))) return;

    let failed = 0;
    for (const message of mine) {
      try {
        await api(`/messages/${message.id}`, { method: 'DELETE' });
      } catch {
        failed += 1;
      }
    }
    clearPicks();
    toast(failed ? t('{n} پیام حذف نشد.', { n: fa(failed) }) : t('{n} پیام حذف شد.', { n: fa(mine.length) }), Boolean(failed));
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

  const DRAFT_KEY = (id) => `messenger.draft.${id}`;

  function saveDraft() {
    if (!state.activeId || state.editing) return;
    const text = $('messageInput').value;
    try {
      if (text.trim()) localStorage.setItem(DRAFT_KEY(state.activeId), text);
      else localStorage.removeItem(DRAFT_KEY(state.activeId));
    } catch {
      /* حافظه‌ی مرورگر ممکن است در دسترس نباشد */
    }
  }

  function loadDraft(id) {
    let text = '';
    try {
      text = localStorage.getItem(DRAFT_KEY(id)) || '';
    } catch {
      /* بی‌خیال */
    }
    const input = $('messageInput');
    input.value = text;
    autoGrow();
  }

  async function openConversation(id) {
    // نوشته‌ی نیمه‌کاره‌ی گفتگوی قبلی نباید بپرد.
    saveDraft();
    state.picked.clear();
    renderSelectBar();
    state.activeId = id;
    state.stickToBottom = true;
    state.messages = [];
    state.replyTo = null;
    state.editing = null;
    clearImagePreview();
    updateReplyBar();
    renderConversations();

    $('emptyState').classList.add('is-hidden');
    $('chatView').classList.remove('is-hidden');
    $('appScreen').classList.add('show-chat');
    $('messageList').innerHTML = emptyNote(t('در حال بارگذاری…')).outerHTML;

    try {
      const [{ conversation }, data] = await Promise.all([
        api(`/conversations/${id}`),
        api(`/conversations/${id}/messages?limit=40`),
      ]);
      state.conversations.set(id, conversation);
      state.messages = data.messages;
      seenMessageIds.clear();
      markAlreadySeen(state.messages);
      state.hasMore = data.hasMore;
      renderChatHeader();
      const composer = $('composer');
      composer.classList.toggle('is-hidden', Boolean(conversation.orphaned));
      renderMessages({ toBottom: true });
      renderConversations();
      markConversationRead();
      loadDraft(id);
      // روی موبایل گفتگو تمام صفحه را می‌گیرد، پس باید با بازگشت بسته شود.
      if (onNarrowScreen() && !overlays.some((o) => o.name === 'chat')) {
        pushOverlay('chat', closeChat);
      }
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
      markAlreadySeen(data.messages);
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
      $('replyAuthor').textContent = t('ویرایش پیام');
      $('replyPreview').textContent = state.editing.body || t('عکس');
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
        ? t('🖼 عکس')
        : state.replyTo.kind === 'voice'
          ? t('🎤 پیام صوتی')
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
    if (!confirm(t('این پیام حذف شود؟'))) return;
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
    clearTimeout(saveDraft.timer);
    saveDraft.timer = setTimeout(saveDraft, 400);
  });

  $('messageInput').addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey && window.matchMedia('(min-width: 821px)').matches) {
      event.preventDefault();
      $('composer').requestSubmit();
    }
  });

  window.addEventListener('beforeunload', saveDraft);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') saveDraft();
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
      saveDraft();
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
    saveDraft();
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
      return toast(t('مرورگر شما ضبط صدا را پشتیبانی نمی‌کند.'), true);
    }

    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      return toast(t('اجازه‌ی دسترسی به میکروفون داده نشد.'), true);
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

  /**
   * یک دکمه‌ی پیوست به‌جای دو تا.
   *
   * با پنج دکمه کنار کادر نوشتن، روی گوشی ۳۹۰ پیکسلی فقط ۱۳۴ پیکسل برای
   * نوشتن می‌ماند و روی ۳۲۰ پیکسلی ۶۴ پیکسل — عملاً غیرقابل استفاده.
   */
  $('attachBtn').addEventListener('click', () => {
    openModal(t('پیوست'), (body) => {
      const option = (icon, label, hint, onClick) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'attach-option';
        const mark = document.createElement('span');
        mark.className = 'attach-icon';
        mark.textContent = icon;
        const main = document.createElement('span');
        main.className = 'attach-main';
        main.append(
          Object.assign(document.createElement('strong'), { textContent: label }),
          Object.assign(document.createElement('small'), { className: 'muted', textContent: hint })
        );
        button.append(mark, main);
        button.addEventListener('click', () => {
          closeModal();
          onClick();
        });
        return button;
      };

      body.append(
        option('🖼', t('عکس'), t('می‌توانید چند عکس را با هم انتخاب کنید'), () =>
          $('imageInput').click()
        ),
        option('📎', t('فایل'), t('تا {size} — سند، ویدیو، فایل فشرده', { size: fileSize(MAX_FILE_BYTES) }), () =>
          $('fileInput').click()
        )
      );
    });
  });

  $('imageInput').addEventListener('change', async (event) => {
    const chosen = [...(event.target.files || [])];
    event.target.value = '';
    if (chosen.length === 0) return;

    const images = chosen.filter((f) => f.type.startsWith('image/'));
    if (images.length === 0) return toast(t('فقط فایل عکس قابل ارسال است.'), true);

    // چند عکس با هم: اولی در پیش‌نمایش می‌نشیند تا بشود برایش توضیح نوشت،
    // بقیه پشت سر هم و بی‌توضیح می‌روند.
    if (images.length > 1) {
      toast(t('در حال ارسال {n} عکس…', { n: fa(images.length) }));
      for (const one of images.slice(1)) {
        try {
          const prepared = await prepareImage(one);
          const form = new FormData();
          form.append('image', prepared.blob, prepared.name);
          await api(`/conversations/${state.activeId}/images`, {
            method: 'POST', body: form, raw: true,
          });
        } catch (err) {
          toast(err.message, true);
          break;
        }
      }
    }

    const file = images[0];
    try {
      const prepared = await prepareImage(file);
      state.pendingImage = prepared;
      $('imagePreviewImg').src = URL.createObjectURL(prepared.blob);
      $('imagePreviewName').textContent = prepared.name;
      $('imagePreviewSize').textContent = fileSize(prepared.blob.size);
      $('imagePreview').classList.remove('is-hidden');
      $('messageInput').placeholder = t('توضیح عکس (اختیاری)…');
      $('messageInput').focus();
    } catch (err) {
      toast(err.message || t('آماده‌سازی عکس ناموفق بود.'), true);
    }
  });

  $('cancelImage').addEventListener('click', clearImagePreview);

  $('fileInput').addEventListener('change', async (event) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file || !state.activeId) return;
    if (file.size > MAX_FILE_BYTES) {
      return toast(t('حجم فایل بیشتر از {size} است.', { size: fileSize(MAX_FILE_BYTES) }), true);
    }

    const form = new FormData();
    form.append('file', file, file.name);
    if (state.replyTo) form.append('replyToId', String(state.replyTo.id));

    toast(t('در حال فرستادن {name}…', { name: file.name }));
    $('attachBtn').disabled = true;
    try {
      await api(`/conversations/${state.activeId}/files`, { method: 'POST', body: form, raw: true });
      state.replyTo = null;
      updateReplyBar();
    } catch (err) {
      toast(err.message, true);
    } finally {
      $('attachBtn').disabled = false;
    }
  });

  /**
   * عکس پروفایل را مربع و کوچک می‌کند. برش از وسط انجام می‌شود تا صورت‌ها
   * معمولاً سر جایشان بمانند، و خروجی JPEG است تا حجمش کم باشد.
   */
  async function prepareAvatar(file) {
    const bitmap = await createImageBitmap(file).catch(() => null);
    if (!bitmap) throw new Error(t('این فایل عکس نیست.'));

    const side = Math.min(bitmap.width, bitmap.height);
    const sx = Math.round((bitmap.width - side) / 2);
    const sy = Math.round((bitmap.height - side) / 2);
    const out = Math.min(AVATAR_EDGE, side);

    const canvas = document.createElement('canvas');
    canvas.width = out;
    canvas.height = out;
    canvas.getContext('2d').drawImage(bitmap, sx, sy, side, side, 0, 0, out, out);
    bitmap.close?.();

    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.86));
    if (!blob) throw new Error(t('آماده‌سازی عکس ممکن نشد.'));
    return blob;
  }

  function clearImagePreview() {
    if ($('imagePreviewImg').src.startsWith('blob:')) URL.revokeObjectURL($('imagePreviewImg').src);
    state.pendingImage = null;
    $('imagePreview').classList.add('is-hidden');
    $('imagePreviewImg').removeAttribute('src');
    $('messageInput').placeholder = t('پیام بنویسید…');
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
    saveDraft();
    autoGrow();
    state.replyTo = null;
    updateReplyBar();
    clearImagePreview();
    $('sendBtn').disabled = true;
    toast(t('در حال ارسال عکس…'));

    try {
      await api(`/conversations/${state.activeId}/images`, { method: 'POST', body: form, raw: true });
    } catch (err) {
      toast(err.message, true);
    } finally {
      $('sendBtn').disabled = false;
    }
  }

  function hideLightbox() {
    $('lightbox').classList.add('is-hidden');
    $('lightboxImg').removeAttribute('src');
  }

  function closeLightbox() {
    if (!closeOverlay('lightbox')) hideLightbox();
  }

  function openLightbox(attachment) {
    $('lightboxImg').src = fileUrl(attachment.url);
    $('lightboxDownload').href = `${fileUrl(attachment.url)}&download=1`;
    $('lightboxDownload').setAttribute('download', attachment.name || 'image');
    $('lightbox').classList.remove('is-hidden');
    pushOverlay('lightbox', hideLightbox);
  }

  $('lightbox').addEventListener('click', (event) => {
    if (event.target.closest('.lightbox-download')) return;
    closeLightbox();
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
      setConnectionState(t('آنلاین'), 'is-online');
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
      setConnectionState(t('قطع — تلاش برای اتصال…'), 'is-off');
      // بدون سوکت، سیگنالینگ تماس هم از کار می‌افتد.
      if (state.call) teardownCall(t('ارتباط قطع شد'));
      if (event.code === 4001) return signOut(t('نشست شما منقضی شده است. دوباره وارد شوید.'));
      if (event.code === 4003) {
        return signOut(
          event.reason === 'blocked' ? t('حساب شما مسدود شده است.') : t('حساب شما هنوز تایید نشده است.')
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

      case 'message:reactions': {
        const target = state.messages.find((m) => m.id === event.messageId);
        if (target && event.conversationId === state.activeId) {
          target.reactions = event.reactions;
          renderMessages({ keepScroll: true });
        }
        break;
      }

      case 'story:new':
        loadStories();
        break;

      case 'conversation:updated': {
        upsertConversation(event.conversation);
        if (event.conversation.id === state.activeId) renderChatHeader();
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
          teardownCall(CALL_ENDINGS[event.reason] || t('تماس پایان یافت'));
        }
        break;

      case 'call:error':
        if (state.call) teardownCall(CALL_ERRORS[event.reason] || t('تماس برقرار نشد'));
        else toast(CALL_ERRORS[event.reason] || t('تماس برقرار نشد'), true);
        break;

      case 'user:updated': {
        // یکی از مخاطب‌ها پروفایلش را عوض کرد؛ نسخه‌ی ما از او باید تازه شود.
        let touched = false;
        for (const conv of state.conversations.values()) {
          const index = conv.members.findIndex((m) => m.id === event.user.id);
          if (index === -1) continue;
          conv.members[index] = { ...conv.members[index], ...event.user };
          if (conv.peer?.id === event.user.id) {
            conv.peer = { ...conv.peer, ...event.user };
            conv.title = event.user.displayName;
            // در گفتگوی دونفره، عکس گفتگو همان عکس طرف مقابل است.
            conv.avatarColor = event.user.avatarColor;
            conv.avatarUrl = event.user.avatarUrl;
          }
          touched = true;
        }
        if (touched) {
          renderConversations();
          if (state.activeId) {
            renderChatHeader();
            renderMessages({ keepScroll: true });
          }
        }
        break;
      }

      case 'me:updated':
        state.me = event.user;
        renderMe();
        break;

      case 'data:wiped':
        state.messages = [];
        toast(t('داده‌های هفتگی پاک شد.'));
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
    indicator.textContent = t('{names} در حال نوشتن…', { names: names.join(t('، ')) });
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
    if (conv.muted) return; // کاربر خودش خواسته این گفتگو ساکت باشد
    const body =
      {
        image: () => t('🖼 عکس فرستاد'),
        file: () => t('📎 {name} فرستاد', { name: message.attachment?.name || t('فایل') }),
        voice: () => t('🎤 پیام صوتی فرستاد'),
        call: () => callRecordText(message),
      }[message.kind]?.() ?? message.body.slice(0, 120);

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
    if (Notification.permission === 'granted') return toast(t('اعلان‌ها از قبل فعال است.'));
    if (Notification.permission === 'denied') {
      if (force) toast(t('اعلان‌ها را در تنظیمات مرورگر برای این سایت اجازه دهید.'), true);
      return;
    }
    if (!force && localStorage.getItem('messenger.notifyAsked')) return;
    localStorage.setItem('messenger.notifyAsked', '1');
    const result = await Notification.requestPermission().catch(() => 'default');
    if (force) toast(result === 'granted' ? t('اعلان‌ها فعال شد.') : t('اعلان‌ها فعال نشد.'), result !== 'granted');
  }

  /* ------------------------------ تماس صوتی ----------------------------- */

  /**
   * تماس صوتی با WebRTC: صدا مستقیم بین دو مرورگر می‌رود و فقط اگر شبکه اجازه
   * نداد از سرور TURN رله می‌شود. سرور ما هیچ صدایی نمی‌شنود؛ کارش تنها رساندن
   * پیام‌های هماهنگی (offer/answer/candidate) به طرف مقابل است.
   */
  const CALL_ERRORS = {
    disabled: t('تماس صوتی روی این سرور فعال نیست.'),
    'not-direct': t('تماس صوتی فقط در گفتگوی دونفره ممکن است.'),
    forbidden: t('اجازه‌ی این تماس را ندارید.'),
    'too-many': t('تماس‌های زیادی گرفته‌اید؛ کمی بعد دوباره تلاش کنید.'),
    'no-peer': t('طرف مقابل پیدا نشد.'),
    'already-in-call': t('همین حالا در یک تماس هستید.'),
    busy: t('طرف مقابل در تماس دیگری است.'),
    offline: t('طرف مقابل آنلاین نیست.'),
    gone: t('این تماس دیگر برقرار نیست.'),
  };

  const CALL_ENDINGS = {
    declined: t('تماس رد شد'),
    timeout: t('پاسخی داده نشد'),
    cancelled: t('تماس لغو شد'),
    offline: t('طرف مقابل آنلاین نیست'),
    disconnected: t('ارتباط قطع شد'),
    failed: t('برقراری تماس ممکن نشد'),
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

  function showCallOverlay({ name, color, incoming, photo = null }) {
    paintAvatar($('callAvatar'), name, color || '#2563eb', false, photo);
    $('callName').textContent = name;
    $('callAccept').classList.toggle('is-hidden', !incoming);
    $('callMute').classList.toggle('is-hidden', incoming);
    $('callMute').classList.remove('is-on');
    for (const id of ['callCamera', 'callFlip', 'remoteVideo', 'localVideo']) {
      $(id).classList.add('is-hidden');
    }
    $('callOverlay').classList.remove('is-hidden', 'has-video');
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
    $('remoteAudio').srcObject = null;
    $('remoteVideo').srcObject = null;
    $('localVideo').srcObject = null;
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

  /**
   * میکروفون (و در تماس تصویری، دوربین) را می‌گیرد. اگر دوربین نبود یا اجازه
   * داده نشد، تماس را نمی‌کُشیم: با صدای تنها ادامه می‌دهیم و طرف مقابل
   * تصویر ما را نمی‌بیند — بهتر از قطع شدن تماس است.
   */
  async function captureMedia(call) {
    const audio = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };
    if (!call.video) return navigator.mediaDevices.getUserMedia({ audio, video: false });

    const video = {
      facingMode: call.facing || 'user',
      // رزولوشن را عمداً متوسط می‌گیریم: تصویرِ رله‌شده از سرور رد می‌شود و
      // پهنای باند سرور و اینترنت موبایل هر دو محدودند.
      width: { ideal: 640 },
      height: { ideal: 480 },
      frameRate: { ideal: 24, max: 30 },
    };

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio, video });
      call.hasMultipleCameras = await countCameras() > 1;
      $('localVideo').srcObject = stream;
      $('localVideo').classList.remove('is-hidden');
      $('callOverlay').classList.add('has-video');
      return stream;
    } catch (error) {
      console.warn('[call] دوربین در دسترس نیست؛ تماس صوتی ادامه می‌یابد:', error.name);
      toast(t('دوربین در دسترس نیست؛ تماس فقط صوتی برقرار می‌شود.'), true);
      call.cameraDenied = true;
      return navigator.mediaDevices.getUserMedia({ audio, video: false });
    }
  }

  async function countCameras() {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      return devices.filter((d) => d.kind === 'videoinput').length;
    } catch {
      return 0;
    }
  }

  /** سقف نرخ بیت تصویر، تا یک تماس همه‌ی پهنای باند سرور را نگیرد. */
  async function capVideoBitrate(pc) {
    const sender = pc.getSenders().find((s) => s.track?.kind === 'video');
    if (!sender?.getParameters) return;
    try {
      const params = sender.getParameters();
      params.encodings = params.encodings?.length ? params.encodings : [{}];
      params.encodings[0].maxBitrate = 600_000; // ۶۰۰ کیلوبیت بر ثانیه
      await sender.setParameters(params);
    } catch {
      /* بعضی مرورگرها اجازه نمی‌دهند؛ مهم نیست */
    }
  }

  async function createPeer() {
    const call = state.call;
    const iceServers = await callIceServers();
    if (!state.call || state.call !== call) return null; // تماس در این فاصله بسته شد

    const pc = new RTCPeerConnection({ iceServers });
    call.pc = pc;

    call.stream = await captureMedia(call);
    if (!state.call || state.call !== call) {
      call.stream.getTracks().forEach((t) => t.stop());
      return null;
    }
    for (const track of call.stream.getTracks()) pc.addTrack(track, call.stream);
    if (call.video) await capVideoBitrate(pc);

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        sendWs({ type: 'call:signal', callId: call.id, data: { candidate: event.candidate } });
      }
    };

    pc.ontrack = (event) => {
      const [stream] = event.streams;
      if (event.track.kind === 'video') {
        $('remoteVideo').srcObject = stream;
        $('remoteVideo').classList.remove('is-hidden');
        $('callOverlay').classList.add('has-video');
        $('remoteVideo').play?.().catch(() => {});
      } else {
        $('remoteAudio').srcObject = stream;
        $('remoteAudio').play?.().catch(() => {});
      }
    };

    pc.onconnectionstatechange = () => {
      if (!state.call || state.call !== call) return;
      if (pc.connectionState === 'connected') {
        ring.stop();
        $('callMute').classList.remove('is-hidden');
        $('callAccept').classList.add('is-hidden');
        if (call.video) {
          $('callCamera').classList.remove('is-hidden');
          if (call.hasMultipleCameras) $('callFlip').classList.remove('is-hidden');
        }
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

  function startCall(video = false) {
    const conv = state.conversations.get(state.activeId);
    if (!conv || conv.type !== 'direct' || !conv.peer) return;
    if (state.call) return toast(t('همین حالا در یک تماس هستید.'), true);
    if (!window.RTCPeerConnection || !navigator.mediaDevices?.getUserMedia) {
      return toast(t('مرورگر شما تماس را پشتیبانی نمی‌کند.'), true);
    }

    state.call = {
      id: null,
      role: 'caller',
      video,
      facing: 'user',
      conversationId: conv.id,
      peerName: conv.title,
      peerColor: conv.avatarColor,
      pc: null,
      stream: null,
      timer: null,
      pendingCandidates: [],
    };
    showCallOverlay({
      name: conv.title,
      color: conv.avatarColor,
      incoming: false,
      photo: conv.peer?.avatarUrl,
    });
    setCallState(t('در حال زنگ زدن…'));
    if (!sendWs({ type: 'call:invite', conversationId: conv.id, video })) {
      teardownCall(t('ارتباط با سرور برقرار نیست.'));
    }
  }

  async function acceptCall() {
    const call = state.call;
    if (!call || call.role !== 'callee') return;
    ring.stop();
    $('callAccept').classList.add('is-hidden');
    setCallState(t('در حال اتصال…'));
    try {
      // اجازه‌ی میکروفون پیش از پذیرش گرفته می‌شود تا تماس بی‌صدا شروع نشود.
      if (!(await createPeer())) return;
    } catch {
      sendWs({ type: 'call:decline', callId: call.id });
      teardownCall(t('دسترسی به میکروفون داده نشد.'));
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
      track.enabled ? t('بی‌صدا کردن میکروفون') : t('روشن کردن میکروفون')
    );
    toast(track.enabled ? t('میکروفون روشن شد.') : t('میکروفون بی‌صدا شد.'));
  }

  function toggleCamera() {
    const track = state.call?.stream?.getVideoTracks()[0];
    if (!track) return;
    track.enabled = !track.enabled;
    $('callCamera').classList.toggle('is-on', !track.enabled);
    $('localVideo').classList.toggle('is-off', !track.enabled);
    $('callCamera').setAttribute(
      'aria-label',
      track.enabled ? t('خاموش کردن دوربین') : t('روشن کردن دوربین')
    );
  }

  /**
   * تعویض دوربین جلو و عقب. به‌جای ساختن اتصال تازه، فقط فرستنده‌ی تصویر را
   * با دوربین دیگر عوض می‌کنیم تا تماس قطع نشود.
   */
  async function flipCamera() {
    const call = state.call;
    if (!call?.pc || !call.video) return;
    const next = call.facing === 'user' ? 'environment' : 'user';
    let fresh;
    try {
      fresh = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: { exact: next } },
      });
    } catch {
      toast(t('دوربین دیگری پیدا نشد.'), true);
      return;
    }

    const track = fresh.getVideoTracks()[0];
    const sender = call.pc.getSenders().find((s) => s.track?.kind === 'video');
    if (!sender || !track) {
      fresh.getTracks().forEach((t) => t.stop());
      return;
    }

    await sender.replaceTrack(track).catch(() => {});
    const old = call.stream.getVideoTracks()[0];
    if (old) {
      call.stream.removeTrack(old);
      old.stop();
    }
    call.stream.addTrack(track);
    call.facing = next;
    $('localVideo').srcObject = call.stream;
    await capVideoBitrate(call.pc);
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
      video: Boolean(event.video),
      facing: 'user',
      conversationId: event.conversationId,
      peerName: event.from?.displayName || t('کاربر'),
      peerColor: event.from?.avatarColor,
      peerPhoto: event.from?.avatarUrl,
      pc: null,
      stream: null,
      timer: null,
      pendingCandidates: [],
    };
    showCallOverlay({
      name: state.call.peerName,
      color: state.call.peerColor,
      incoming: true,
      photo: state.call.peerPhoto,
    });
    setCallState(state.call.video ? t('تماس تصویری ورودی…') : t('تماس صوتی ورودی…'));
    ring.start(true);
    if (document.visibilityState !== 'visible') {
      notify({ id: event.conversationId, title: state.call.peerName }, {
        kind: 'text',
        body: state.call.video ? t('تماس تصویری…') : t('تماس صوتی…'),
      });
    }
  }

  async function onCallAccepted(event) {
    const call = state.call;
    if (!call || call.id !== event.callId || call.role !== 'caller') return;
    ring.stop();
    setCallState(t('در حال اتصال…'));
    try {
      const pc = await createPeer();
      if (!pc) return;
      const offer = await pc.createOffer({ offerToReceiveAudio: true });
      await pc.setLocalDescription(offer);
      sendWs({ type: 'call:signal', callId: call.id, data: { sdp: pc.localDescription } });
    } catch {
      endCall('failed');
      toast(t('دسترسی به میکروفون داده نشد.'), true);
    }
  }

  $('callBtn').addEventListener('click', () => startCall(false));
  $('videoCallBtn').addEventListener('click', () => startCall(true));
  $('callCamera').addEventListener('click', toggleCamera);
  $('callFlip').addEventListener('click', flipCamera);
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
    pushOverlay('modal', hideModal);
  }

  /* --------------------------- دکمه‌ی بازگشت --------------------------- */

  /**
   * هر چیزی که روی صفحه باز می‌شود (پنجره، گفتگو روی موبایل، نمای بزرگ عکس)
   * یک ورودی در تاریخچه‌ی مرورگر می‌گذارد.
   *
   * بدون این، دکمه‌ی بازگشت گوشی مستقیم از برنامه بیرون می‌انداخت — چون
   * WebView چیزی برای برگشتن نداشت. حالا بازگشت همان لایه‌ی بالایی را
   * می‌بندد، و فقط وقتی چیزی باز نباشد از برنامه خارج می‌شود.
   */
  const overlays = [];

  function pushOverlay(name, close) {
    overlays.push({ name, close });
    try {
      history.pushState({ overlay: overlays.length }, '');
    } catch {
      /* در بعضی حالت‌ها تاریخچه در دسترس نیست؛ برنامه باید کار کند */
    }
  }

  /** بستن از راه رابط کاربری: تاریخچه را عقب می‌برد تا هماهنگ بماند. */
  function closeOverlay(name) {
    const index = overlays.findIndex((o) => o.name === name);
    if (index === -1) return false;
    // هر چه روی آن باز شده هم باید بسته شود.
    const steps = overlays.length - index;
    history.go(-steps);
    return true;
  }

  window.addEventListener('popstate', () => {
    const top = overlays.pop();
    if (top) top.close();
  });

  const hideModal = () => $('modalRoot').classList.add('is-hidden');

  /** بستن پنجره از راه دکمه‌ی ✕ یا Escape. */
  function closeModal() {
    if (!closeOverlay('modal')) hideModal();
  }
  document.querySelectorAll('[data-close-modal]').forEach((el) =>
    el.addEventListener('click', closeModal)
  );

  /** نام کاربری لاتین را داخل <bdi> می‌گذارد تا در متن راست‌چین وارونه نشود. */
  /** کادر ورودی به‌همراه برچسبش. */
  function labeled(labelText, input, hint = '') {
    const wrap = document.createElement('label');
    wrap.className = 'field';
    const label = document.createElement('span');
    label.textContent = labelText;
    wrap.append(label, input);
    if (hint) {
      const note = document.createElement('small');
      note.className = 'muted';
      note.textContent = hint;
      wrap.appendChild(note);
    }
    return wrap;
  }

  /** عنوان یک بخش داخل پنجره. */
  function sectionTitle(text) {
    const el = document.createElement('div');
    el.className = 'modal-divider';
    el.textContent = text;
    return el;
  }

  /** کپی کردن متن، با پشتیبان برای مرورگرهایی که clipboard ندارند. */
  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      const box = document.createElement('textarea');
      box.value = text;
      box.setAttribute('readonly', '');
      box.style.position = 'fixed';
      box.style.opacity = '0';
      document.body.appendChild(box);
      box.select();
      let ok = false;
      try {
        ok = document.execCommand('copy');
      } catch {
        ok = false;
      }
      box.remove();
      return ok;
    }
  }

  /**
   * شناسه‌ی من، با دکمه‌ی کپی. کل برنامه روی «پیدا کردن با نام کاربری دقیق»
   * بنا شده، پس باید بشود آن را راحت به کسی داد.
   */
  function myHandleBox() {
    const wrap = document.createElement('div');
    wrap.className = 'handle-box';

    const text = document.createElement('div');
    text.className = 'handle-value';
    text.appendChild(usernameTag(state.me.username));

    const hint = document.createElement('small');
    hint.className = 'muted';
    hint.textContent = t('دیگران با همین شناسه شما را پیدا می‌کنند.');

    const copy = document.createElement('button');
    copy.type = 'button';
    copy.className = 'btn';
    copy.textContent = t('کپی');
    copy.addEventListener('click', async () => {
      const ok = await copyText(`@${state.me.username}`);
      toast(ok ? t('شناسه کپی شد.') : t('کپی ممکن نشد؛ دستی انتخابش کنید.'), !ok);
    });

    const actions = document.createElement('div');
    actions.className = 'handle-actions';
    actions.appendChild(copy);

    if (navigator.share) {
      const share = document.createElement('button');
      share.type = 'button';
      share.className = 'btn';
      share.textContent = t('اشتراک‌گذاری');
      share.addEventListener('click', () => {
        navigator
          .share({ title: '9chat', text: t('شناسه‌ی من در 9chat: @{username}', { username: state.me.username }) })
          .catch(() => {});
      });
      actions.appendChild(share);
    }

    const main = document.createElement('div');
    main.className = 'handle-main';
    main.append(text, hint);
    wrap.append(main, actions);
    return wrap;
  }

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
    paintAvatar(
      row.querySelector('.avatar'),
      user.displayName,
      user.avatarColor,
      user.online,
      user.avatarUrl
    );
    row.querySelector('strong').textContent = user.displayName;
    row.querySelector('small').replaceChildren(usernameTag(user.username));
    if (onClick) {
      row.addEventListener('click', () => onClick(row));
    }
    if (selectable) row.dataset.userId = user.id;
    return row;
  }

  function newChatModal() {
    openModal(t('گفتگوی جدید'), (body) => {
      const search = document.createElement('input');
      search.type = 'search';
      search.placeholder = t('نام کاربری دقیق طرف مقابل…');
      const results = document.createElement('div');
      results.style.display = 'grid';
      results.style.gap = '8px';

      const hint = document.createElement('p');
      hint.className = 'muted';
      hint.style.margin = '0';
      hint.textContent = t('برای شروع گفتگو باید نام کاربری دقیق طرف مقابل را بدانید.');

      const groupBtn = document.createElement('button');
      groupBtn.className = 'btn';
      groupBtn.textContent = t('👥 ساخت گروه جدید');
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
                emptyNote(t('کاربری با این نام کاربری پیدا نشد. نام کاربری باید دقیق باشد.')).outerHTML;
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

      // کار اصلی پیدا کردن شخص است، پس اول جستجو می‌آید و گروه بعد از آن.
      body.append(hint, search, results, groupBtn);
      search.focus();
    });
  }

  function newGroupModal() {
    openModal(t('گروه جدید'), (body) => {
      const selected = new Map();

      const title = document.createElement('input');
      title.placeholder = t('نام گروه');
      title.maxLength = 60;

      const search = document.createElement('input');
      search.type = 'search';
      search.placeholder = t('نام کاربری دقیق عضو تازه…');

      const chosen = document.createElement('div');
      chosen.className = 'muted';
      const results = document.createElement('div');
      results.style.display = 'grid';
      results.style.gap = '8px';

      const paintChosen = () => {
        chosen.textContent = selected.size
          ? t('اعضا: {names}', { names: [...selected.values()].map((u) => u.displayName).join(t('، ')) })
          : t('هنوز عضوی انتخاب نشده است.');
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
      create.textContent = t('ساخت گروه');
      create.addEventListener('click', async () => {
        if (!title.value.trim()) return toast(t('نام گروه را بنویسید.'), true);
        if (selected.size === 0) return toast(t('حداقل یک عضو انتخاب کنید.'), true);
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

  /** بخش عکس پروفایل در پنجره‌ی پروفایل: نمایش، انتخاب و حذف. */
  function avatarEditor() {
    const wrap = document.createElement('div');
    wrap.className = 'avatar-editor';

    const avatar = document.createElement('span');
    avatar.className = 'avatar avatar-lg';

    const file = document.createElement('input');
    file.type = 'file';
    file.accept = 'image/*';
    file.className = 'is-hidden';

    const pick = document.createElement('button');
    pick.type = 'button';
    pick.className = 'btn';

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'btn btn-danger';
    remove.textContent = t('حذف عکس');

    const paint = () => {
      paintAvatar(avatar, state.me.displayName, state.me.avatarColor, false, state.me.avatarUrl);
      pick.textContent = state.me.avatarUrl ? t('تغییر عکس') : t('انتخاب عکس');
      remove.classList.toggle('is-hidden', !state.me.avatarUrl);
    };
    paint();

    const busy = (on) => {
      pick.disabled = on;
      remove.disabled = on;
    };

    pick.addEventListener('click', () => file.click());
    file.addEventListener('change', async () => {
      const chosen = file.files?.[0];
      file.value = '';
      if (!chosen) return;
      busy(true);
      try {
        const form = new FormData();
        form.append('avatar', await prepareAvatar(chosen), 'avatar.jpg');
        const data = await api('/me/avatar', { method: 'POST', body: form, raw: true });
        state.me = data.user;
        paint();
        renderMe();
        toast(t('عکس پروفایل به‌روز شد.'));
      } catch (err) {
        toast(err.message, true);
      } finally {
        busy(false);
      }
    });

    remove.addEventListener('click', async () => {
      busy(true);
      try {
        const data = await api('/me/avatar', { method: 'DELETE' });
        state.me = data.user;
        paint();
        renderMe();
        toast(t('عکس پروفایل حذف شد.'));
      } catch (err) {
        toast(err.message, true);
      } finally {
        busy(false);
      }
    });

    const buttons = document.createElement('div');
    buttons.className = 'avatar-editor-actions';
    buttons.append(pick, remove);
    wrap.append(avatar, buttons, file);
    return wrap;
  }

  /** نام خوانای دستگاه از روی User-Agent. */
  function deviceName(userAgent) {
    if (!userAgent) return t('دستگاه ناشناس');
    const ua = userAgent.toLowerCase();
    const platform = ua.includes('android')
      ? t('اندروید')
      : /iphone|ipad|ipod/.test(ua)
        ? 'iOS'
        : ua.includes('windows')
          ? t('ویندوز')
          : ua.includes('mac os')
            ? t('مک')
            : ua.includes('linux')
              ? t('لینوکس')
              : t('نامشخص');
    const browser = ua.includes('firefox')
      ? t('فایرفاکس')
      : ua.includes('edg/')
        ? t('اج')
        : ua.includes('chrome')
          ? t('کروم')
          : ua.includes('safari')
            ? t('سافاری')
            : t('مرورگر');
    return t('{browser} روی {platform}', { browser, platform });
  }

  /** فهرست دستگاه‌هایی که با این حساب وارد شده‌اند. */
  function devicesSection() {
    const wrap = document.createElement('div');
    wrap.className = 'stack';
    const list = document.createElement('div');
    // جای خالی از پیش گرفته می‌شود: این فهرست با تأخیر از سرور می‌آید و اگر
    // ارتفاعش ناگهان زیاد شود، هرچه زیرش است زیر دست کاربر می‌پرد.
    list.className = 'stack async-list';
    list.innerHTML = emptyNote(t('در حال بارگذاری…'), 'muted').outerHTML;

    const closeOthers = document.createElement('button');
    closeOthers.className = 'btn btn-danger is-hidden';
    closeOthers.textContent = t('بستن همه‌ی دستگاه‌های دیگر');

    const draw = (sessions) => {
      list.innerHTML = '';
      for (const session of sessions) {
        const row = document.createElement('div');
        row.className = 'device-row';
        const main = document.createElement('div');
        main.className = 'device-main';
        const title = document.createElement('strong');
        title.textContent = deviceName(session.userAgent);
        const when = document.createElement('small');
        when.className = 'muted';
        when.textContent = session.current
          ? t('همین دستگاه')
          : t('آخرین فعالیت {when}', { when: relativeTime(session.lastSeenAt) });
        main.append(title, when);
        row.appendChild(main);

        if (!session.current) {
          const close = document.createElement('button');
          close.className = 'btn';
          close.textContent = t('بستن');
          close.addEventListener('click', async () => {
            close.disabled = true;
            try {
              await api(`/me/sessions/${session.id}`, { method: 'DELETE' });
              await load();
              toast(t('دستگاه بسته شد.'));
            } catch (err) {
              toast(err.message, true);
              close.disabled = false;
            }
          });
          row.appendChild(close);
        }
        list.appendChild(row);
      }
      closeOthers.classList.toggle('is-hidden', sessions.length < 2);
    };

    const load = async () => {
      try {
        const data = await api('/me/sessions');
        draw(data.sessions);
      } catch (err) {
        list.innerHTML = '';
        list.appendChild(Object.assign(document.createElement('p'), {
          className: 'muted',
          textContent: err.message,
        }));
      }
    };

    closeOthers.addEventListener('click', async () => {
      if (!confirm(t('همه‌ی دستگاه‌های دیگر از حساب خارج شوند؟'))) return;
      closeOthers.disabled = true;
      try {
        const data = await api('/me/sessions/others', { method: 'DELETE' });
        await load();
        toast(t('{n} دستگاه بسته شد.', { n: fa(data.closed) }));
      } catch (err) {
        toast(err.message, true);
      } finally {
        closeOthers.disabled = false;
      }
    });

    load();
    wrap.append(list, closeOthers);
    return wrap;
  }

  /** کاربرانی که بلاک کرده‌ام. */
  function blockedSection() {
    const wrap = document.createElement('div');
    wrap.className = 'stack';
    const list = document.createElement('div');
    list.className = 'stack async-list';

    const draw = (users) => {
      list.innerHTML = '';
      if (users.length === 0) {
        list.appendChild(Object.assign(document.createElement('p'), {
          className: 'muted',
          textContent: t('کسی را بلاک نکرده‌اید.'),
        }));
        return;
      }
      for (const user of users) {
        const row = userRow(user);
        const undo = document.createElement('button');
        undo.className = 'btn';
        undo.textContent = t('رفع بلاک');
        undo.addEventListener('click', async (event) => {
          event.stopPropagation();
          undo.disabled = true;
          try {
            const data = await api(`/me/blocks/${user.id}`, { method: 'DELETE' });
            draw(data.users);
            toast(t('رفع بلاک شد.'));
          } catch (err) {
            toast(err.message, true);
            undo.disabled = false;
          }
        });
        row.appendChild(undo);
        list.appendChild(row);
      }
    };

    api('/me/blocks')
      .then((data) => draw(data.users))
      .catch(() => draw([]));
    wrap.appendChild(list);
    return wrap;
  }

  /** «1.4» → «۱.۴» — فقط رقم‌ها عوض می‌شوند، نه نقطه‌ها. */
  const faDigits = (text) =>
    i18n.current === 'fa'
      ? String(text).replace(/[0-9]/g, (d) => '۰۱۲۳۴۵۶۷۸۹'[Number(d)])
      : String(text);

  /** نسخه‌ی برنامه، برای وقتی کاربر یا من بخواهیم بدانیم چه چیزی در دست اوست. */
  function aboutSection() {
    const wrap = document.createElement('div');
    wrap.className = 'stack';

    const line = (label, value) => {
      const row = document.createElement('div');
      row.className = 'about-row';
      row.append(
        Object.assign(document.createElement('span'), { className: 'muted', textContent: label }),
        Object.assign(document.createElement('b'), { textContent: value })
      );
      return row;
    };

    const built = state.builtAt
      ? new Date(state.builtAt).toLocaleDateString(i18n.localeOf(), {
          year: 'numeric', month: 'long', day: 'numeric',
        })
      : '—';
    wrap.appendChild(line(t('نسخه‌ی وب'), `${built} (${state.clientVersion || '—'})`));

    // نسخه‌ی اپ را فقط خود اپ می‌داند، و آن هم از ۱.۴ به بعد.
    const installed = window.AndroidBridge?.appVersion?.();
    if (installed) {
      wrap.appendChild(line(t('اپ اندروید'), faDigits(installed)));
    } else if (window.AndroidBridge) {
      const hint = document.createElement('small');
      hint.className = 'muted';
      hint.textContent =
        t('نسخه‌ی اپ را اینجا نشان نمی‌دهد چون نسخه‌ی نصب‌شده قدیمی‌تر از ۱.۴ است؛ ') +
        t('از تنظیمات گوشی ← برنامه‌ها ← 9chat ببینیدش.');
      wrap.appendChild(hint);
    }

    const copy = document.createElement('button');
    copy.type = 'button';
    copy.className = 'btn';
    copy.textContent = t('کپی اطلاعات نسخه');
    copy.addEventListener('click', async () => {
      const text = [
        t('نسخه‌ی وب: {version} ({built})', { version: state.clientVersion || '—', built }),
        installed ? t('اپ اندروید: {version}', { version: installed }) : null,
        t('APK روی سرور: {version}', { version: state.androidVersion || '—' }),
      ]
        .filter(Boolean)
        .join('\n');
      const ok = await copyText(text);
      toast(ok ? t('اطلاعات نسخه کپی شد.') : t('کپی ممکن نشد.'), !ok);
    });
    wrap.appendChild(copy);
    return wrap;
  }

  function profileModal() {
    openModal(t('پروفایل'), (body) => buildProfile(body));
  }

  /** همان محتوای پروفایل؛ یک‌بار نوشته می‌شود، دو جا می‌نشیند. */
  function buildProfile(body) {
    {
      const photo = avatarEditor();
      const name = document.createElement('input');
      name.value = state.me.displayName;
      name.maxLength = 40;
      const bio = document.createElement('input');
      bio.value = state.me.bio || '';
      bio.placeholder = t('درباره من');
      bio.maxLength = 200;

      const save = document.createElement('button');
      save.className = 'btn btn-primary';
      save.textContent = t('ذخیره');
      save.addEventListener('click', async () => {
        try {
          const data = await api('/me', {
            method: 'PATCH',
            body: { displayName: name.value.trim(), bio: bio.value.trim() },
          });
          state.me = data.user;
          renderMe();
          closeModal();
          toast(t('پروفایل به‌روز شد.'));
        } catch (err) {
          toast(err.message, true);
        }
      });

      // --- تغییر رمز ---

      const currentPassword = document.createElement('input');
      currentPassword.type = 'password';
      currentPassword.placeholder = t('رمز فعلی');
      currentPassword.autocomplete = 'current-password';

      const newPassword = document.createElement('input');
      newPassword.type = 'password';
      newPassword.placeholder = t('رمز تازه (حداقل ۸ نویسه)');
      newPassword.autocomplete = 'new-password';

      const changePassword = document.createElement('button');
      changePassword.className = 'btn';
      changePassword.textContent = t('تغییر رمز');
      changePassword.addEventListener('click', async () => {
        if (!currentPassword.value || !newPassword.value) {
          return toast(t('هر دو رمز را پر کنید.'), true);
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
      notifyBtn.textContent = t('🔔 فعال‌سازی اعلان‌ها');
      notifyBtn.addEventListener('click', () => requestNotificationPermission({ force: true }));

      const logout = document.createElement('button');
      logout.className = 'btn btn-danger';
      logout.textContent = t('خروج از حساب');
      logout.addEventListener('click', async () => {
        await api('/auth/logout', { method: 'POST' }).catch(() => {});
        closeModal();
        signOut();
      });

      body.append(
        photo,
        myHandleBox(),
        labeled(t('نام نمایشی'), name, t('همین نامی که دیگران می‌بینند.')),
        labeled(t('درباره‌ی من'), bio),
        save,
        sectionTitle(t('ظاهر')),
        appearanceSection(),
        sectionTitle(t('تغییر رمز عبور')),
        labeled(t('رمز فعلی'), currentPassword),
        labeled(t('رمز تازه'), newPassword, t('حداقل ۸ نویسه.')),
        changePassword,
        sectionTitle(t('دستگاه‌های واردشده')),
        devicesSection(),
        sectionTitle(t('کاربران بلاک‌شده')),
        blockedSection(),
        sectionTitle(t('سایر')),
        notifyBtn,
        logout,
        sectionTitle(t('درباره‌ی برنامه')),
        aboutSection()
      );
    }
  }

  /** نام و عکس گروه — فقط برای سازنده. */
  function groupEditor(conv) {
    const wrap = document.createElement('div');
    wrap.className = 'avatar-editor';

    const avatar = document.createElement('span');
    avatar.className = 'avatar avatar-lg';

    const file = document.createElement('input');
    file.type = 'file';
    file.accept = 'image/*';
    file.className = 'is-hidden';

    const pick = document.createElement('button');
    pick.type = 'button';
    pick.className = 'btn';
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'btn btn-danger';
    remove.textContent = t('حذف عکس');

    let current = conv;
    const paint = () => {
      paintAvatar(avatar, current.title, current.avatarColor, false, current.avatarUrl);
      pick.textContent = current.avatarUrl ? t('تغییر عکس گروه') : t('انتخاب عکس گروه');
      remove.classList.toggle('is-hidden', !current.avatarUrl);
    };
    paint();

    const apply = (conversation) => {
      current = conversation;
      upsertConversation(conversation);
      if (conversation.id === state.activeId) renderChatHeader();
      paint();
    };

    pick.addEventListener('click', () => file.click());
    file.addEventListener('change', async () => {
      const chosen = file.files?.[0];
      file.value = '';
      if (!chosen) return;
      pick.disabled = true;
      try {
        const form = new FormData();
        form.append('avatar', await prepareAvatar(chosen), 'group.jpg');
        const data = await api(`/conversations/${conv.id}/avatar`, {
          method: 'POST',
          body: form,
          raw: true,
        });
        apply(data.conversation);
        toast(t('عکس گروه به‌روز شد.'));
      } catch (err) {
        toast(err.message, true);
      } finally {
        pick.disabled = false;
      }
    });

    remove.addEventListener('click', async () => {
      remove.disabled = true;
      try {
        const data = await api(`/conversations/${conv.id}/avatar`, { method: 'DELETE' });
        apply(data.conversation);
        toast(t('عکس گروه حذف شد.'));
      } catch (err) {
        toast(err.message, true);
      } finally {
        remove.disabled = false;
      }
    });

    const name = document.createElement('input');
    name.value = conv.title;
    name.maxLength = 60;

    const rename = document.createElement('button');
    rename.className = 'btn';
    rename.textContent = t('ذخیره‌ی نام');
    rename.addEventListener('click', async () => {
      const title = name.value.trim();
      if (!title) return toast(t('نام گروه خالی است.'), true);
      rename.disabled = true;
      try {
        const data = await api(`/conversations/${conv.id}`, { method: 'PATCH', body: { title } });
        apply(data.conversation);
        toast(t('نام گروه به‌روز شد.'));
      } catch (err) {
        toast(err.message, true);
      } finally {
        rename.disabled = false;
      }
    });

    const buttons = document.createElement('div');
    buttons.className = 'avatar-editor-actions';
    buttons.append(pick, remove);

    const rest = document.createElement('div');
    rest.className = 'group-editor-fields';
    rest.append(labeled(t('نام گروه'), name), rename);

    wrap.append(avatar, buttons, file, rest);
    return wrap;
  }

  /** تغییر سنجاق یا بی‌صدا برای یک گفتگو. */
  async function setConversationFlag(conv, patch) {
    try {
      const data = await api(`/conversations/${conv.id}/flags`, { method: 'POST', body: patch });
      upsertConversation(data.conversation);
      if ('pinned' in patch) toast(patch.pinned ? t('سنجاق شد.') : t('سنجاق برداشته شد.'));
      else if ('muted' in patch) toast(patch.muted ? t('بی‌صدا شد.') : t('صدا روشن شد.'));
      else if ('archived' in patch) toast(patch.archived ? t('بایگانی شد.') : t('از بایگانی خارج شد.'));
      else toast(t('خوانده‌نشده شد.'));
    } catch (err) {
      toast(err.message, true);
    }
  }

  function chatInfoModal() {
    const conv = state.conversations.get(state.activeId);
    if (!conv) return;

    openModal(conv.type === 'group' ? t('اطلاعات گروه') : t('اطلاعات مخاطب'), (body) => {
      const heading = document.createElement('div');
      heading.style.display = 'flex';
      heading.style.gap = '10px';
      heading.style.alignItems = 'center';
      const avatar = document.createElement('span');
      avatar.className = 'avatar';
      paintAvatar(avatar, conv.title, conv.avatarColor, conv.peer?.online, conv.avatarUrl);
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
          t('حساب طرف مقابل حذف شده است. می‌توانید این گفتگو را از فهرست خود پاک کنید.');
        body.appendChild(gone);
      }

      if (conv.type === 'direct' && conv.peer?.bio) {
        const bio = document.createElement('p');
        bio.className = 'muted';
        bio.textContent = conv.peer.bio;
        body.appendChild(bio);
      }

      if (conv.type === 'direct' && conv.peer) {
        const block = document.createElement('button');
        block.className = 'btn btn-danger';
        block.textContent = t('🚫 بلاک کردن این کاربر');
        block.addEventListener('click', async () => {
          if (!confirm(t('{name} بلاک شود؟ دیگر نمی‌توانید به هم پیام بدهید.', { name: conv.peer.displayName }))) return;
          block.disabled = true;
          try {
            await api('/me/blocks', { method: 'POST', body: { username: conv.peer.username } });
            closeModal();
            toast(t('کاربر بلاک شد. از پروفایل می‌توانید رفع بلاکش کنید.'));
          } catch (err) {
            toast(err.message, true);
            block.disabled = false;
          }
        });
        body.appendChild(block);
      }

      const removeChat = document.createElement('button');
      removeChat.className = 'btn btn-danger';
      removeChat.textContent = t('🗑 حذف گفتگو (فقط برای من)');
      removeChat.addEventListener('click', async () => {
        if (!confirm(t('این گفتگو از فهرست شما پاک شود؟ طرف مقابل نسخه‌ی خودش را خواهد داشت.'))) return;
        try {
          await api(`/conversations/${conv.id}`, { method: 'DELETE' });
          state.conversations.delete(conv.id);
          closeModal();
          if (state.activeId === conv.id) closeChat();
          renderConversations();
          toast(t('گفتگو پاک شد.'));
        } catch (err) {
          toast(err.message, true);
        }
      });

      if (conv.type === 'group') {
        // دکمه‌ها فقط برای سازنده‌ی گروه معنی دارند؛ سرور هم همین را الزام می‌کند.
        const myRole = conv.members.find((m) => m.id === state.me.id)?.role;
        const iAmOwner = myRole === 'owner';
        const iAmStaff = iAmOwner || myRole === 'admin';

        if (iAmStaff) {
          body.append(groupEditor(conv), sectionTitle(t('اعضا')));
        }

        for (const member of conv.members) {
          const row = userRow(member);
          if (member.role === 'owner') row.querySelector('small').append(t(' — سازنده'));
          else if (member.role === 'admin') row.querySelector('small').append(t(' — مدیر گروه'));
          if (iAmOwner && member.id !== state.me.id) {
            const roleBtn = document.createElement('button');
            roleBtn.type = 'button';
            roleBtn.className = 'btn';
            roleBtn.textContent = member.role === 'admin' ? t('برداشتن مدیریت') : t('مدیر گروه');
            roleBtn.addEventListener('click', async (event) => {
              event.stopPropagation();
              roleBtn.disabled = true;
              try {
                const data = await api(`/conversations/${conv.id}/members/${member.id}/role`, {
                  method: 'POST',
                  body: { role: member.role === 'admin' ? 'member' : 'admin' },
                });
                upsertConversation(data.conversation);
                closeModal();
                toast(t('نقش عضو به‌روز شد.'));
              } catch (err) {
                toast(err.message, true);
                roleBtn.disabled = false;
              }
            });
            row.appendChild(roleBtn);
          }
          if (iAmStaff && member.id !== state.me.id && member.role !== 'owner') {
            const kick = document.createElement('button');
            kick.type = 'button';
            kick.className = 'row-remove';
            kick.title = t('حذف از گروه');
            kick.setAttribute('aria-label', t('حذف {name} از گروه', { name: member.displayName }));
            kick.textContent = '✕';
            kick.addEventListener('click', async (event) => {
              event.stopPropagation();
              if (!confirm(t('{name} از گروه حذف شود؟', { name: member.displayName }))) return;
              kick.disabled = true;
              try {
                const data = await api(`/conversations/${conv.id}/members/${member.id}`, {
                  method: 'DELETE',
                });
                upsertConversation(data.conversation);
                closeModal();
                toast(t('عضو حذف شد.'));
              } catch (err) {
                toast(err.message, true);
                kick.disabled = false;
              }
            });
            row.appendChild(kick);
          }
          body.appendChild(row);
        }

        if (iAmStaff) {
          const add = document.createElement('button');
          add.className = 'btn';
          add.textContent = t('➕ افزودن عضو');
          add.addEventListener('click', () => addMemberModal(conv));
          body.appendChild(add);
        }

        const leave = document.createElement('button');
        leave.className = 'btn btn-danger';
        leave.textContent = t('خروج از گروه');
        leave.addEventListener('click', async () => {
          if (!confirm(t('از این گروه خارج می‌شوید؟'))) return;
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
    openModal(t('افزودن عضو'), (body) => {
      const search = document.createElement('input');
      search.type = 'search';
      search.placeholder = t('نام کاربری دقیق…');
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
                    toast(t('عضو اضافه شد.'));
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

  const onNarrowScreen = () => window.matchMedia('(max-width: 820px)').matches;

  /** بستن گفتگو از راه دکمه‌ی بازگشت خود برنامه. */
  function leaveChat() {
    if (!closeOverlay('chat')) closeChat();
  }

  function closeChat() {
    state.activeId = null;
    state.messages = [];
    $('chatView').classList.add('is-hidden');
    $('emptyState').classList.remove('is-hidden');
    $('appScreen').classList.remove('show-chat');
  }

  function renderMe() {
    paintAvatar($('meAvatar'), state.me.displayName, state.me.avatarColor, true, state.me.avatarUrl);
    $('meName').textContent = state.me.displayName;
    $('adminLink').classList.toggle('is-hidden', !state.me.isAdmin);
  }

  async function showWipeInfo() {
    try {
      const health = await fetch('/api/health').then((r) => r.json());
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
    loadStories();
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

  $('forgotPassword').addEventListener('click', (event) => {
    event.preventDefault();
    setAuthMessage(
      t('9chat ایمیل و شماره‌ی شما را نمی‌گیرد، پس بازیابی خودکار رمز ممکن نیست. ') +
        t('از مدیر بخواهید از پنل مدیریت برایتان رمز تازه بگذارد.'),
      ''
    );
  });

  // دکمه‌ی چشم کنار کادرهای رمز
  for (const button of document.querySelectorAll('.reveal-password')) {
    button.addEventListener('click', () => {
      const input = button.parentElement.querySelector('input');
      const shown = input.type === 'text';
      input.type = shown ? 'password' : 'text';
      button.classList.toggle('is-on', !shown);
      button.setAttribute('aria-label', shown ? t('نمایش رمز') : t('پنهان کردن رمز'));
    });
  }

  $('cancelSelect').addEventListener('click', clearPicks);
  $('deleteSelected').addEventListener('click', removePicked);
  $('copySelected').addEventListener('click', async () => {
    const text = state.messages
      .filter((m) => state.picked.has(m.id) && m.body)
      .map((m) => `${senderName(m.senderId)}: ${m.body}`)
      .join('\n');
    if (!text) return toast(t('متنی برای کپی نیست.'), true);
    const ok = await copyText(text);
    toast(ok ? t('متن‌ها کپی شدند.') : t('کپی ممکن نشد.'), !ok);
    if (ok) clearPicks();
  });

  /* ----------------------------- ایموجی ----------------------------- */

  const EMOJIS = (
    '😀😁😂🤣😊😇🙂😉😍🥰😘😋😎🤓🧐🤔🤨😐😑😶🙄😏😣😥😮🤐😯😪😫🥱😴' +
    '😌😛😜😝🤤😒😓😔😕🙃🤑😲🙁😖😞😟😤😢😭😦😧😨😩🤯😬😰😱🥵🥶😳' +
    '👍👎👌✌️🤞🤝🙏👏🙌💪🔥✨⭐️❤️🧡💛💚💙💜🖤🤍💔💯✅❌⚠️🎉🎂🎁'
  ).match(/\p{Extended_Pictographic}(\uFE0F)?/gu) || [];

  $('emojiBtn').addEventListener('click', () => {
    // جای مکان‌نما را همین حالا نگه می‌داریم؛ با باز شدن پنجره، فوکوس از
    // کادر نوشتن می‌رود و دیگر نمی‌شود مطمئن بود کجا بوده.
    const input = $('messageInput');
    const at = input.selectionStart ?? input.value.length;

    openModal(t('ایموجی'), (body) => {
      const grid = document.createElement('div');
      grid.className = 'emoji-grid';
      for (const emoji of EMOJIS) {
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = emoji;
        button.addEventListener('click', () => {
          input.value = input.value.slice(0, at) + emoji + input.value.slice(at);
          input.selectionStart = input.selectionEnd = at + emoji.length;
          autoGrow();
          saveDraft();
          closeModal();
          input.focus();
        });
        grid.appendChild(button);
      }
      body.appendChild(grid);
    });
  });

  for (const button of $('tabBar').querySelectorAll('.tab-item')) {
    button.addEventListener('click', () => showTab(button.dataset.tab));
  }
  $('newChatBtn').addEventListener('click', newChatModal);
  $('profileBtn').addEventListener('click', profileModal);
  $('chatInfoBtn').addEventListener('click', chatInfoModal);
  $('backBtn').addEventListener('click', leaveChat);
  $('conversationSearch').addEventListener('input', (event) => {
    state.filter = event.target.value;
    drawConversations($('searchResults'), state.filter);
    clearTimeout(state.searchTimer);
    // جستجوی داخل پیام‌ها به سرور می‌رود، پس کمی صبر می‌کنیم.
    state.searchTimer = setTimeout(searchInMessages, 350);
  });

  /**
   * جستجو در متن پیام‌ها. نتیجه زیر فهرست گفتگوها می‌نشیند و با کلیک، همان
   * گفتگو باز و روی همان پیام اسکرول می‌شود.
   */
  async function searchInMessages() {
    const query = state.filter.trim();
    const box = $('messageHits');
    if (query.length < 2) {
      box.classList.add('is-hidden');
      box.innerHTML = '';
      return;
    }
    let messages = [];
    try {
      ({ messages } = await api(`/search?q=${encodeURIComponent(query)}`));
    } catch {
      return;
    }
    // ممکن است کاربر در این فاصله متن را عوض کرده باشد.
    if (state.filter.trim() !== query) return;

    box.innerHTML = '';
    if (messages.length === 0) {
      box.classList.add('is-hidden');
      return;
    }
    const title = document.createElement('div');
    title.className = 'hits-title';
    title.textContent = t('{n} پیام پیدا شد', { n: fa(messages.length) });
    box.appendChild(title);

    for (const message of messages) {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'hit';
      const where = document.createElement('small');
      where.className = 'muted';
      where.textContent =
        message.conversationTitle ||
        state.conversations.get(message.conversationId)?.title ||
        t('گفتگو');
      const text = document.createElement('span');
      text.textContent = message.kind === 'image' ? `🖼 ${message.body}` : message.body;
      const when = document.createElement('small');
      when.className = 'muted';
      when.textContent = dayText(message.createdAt);
      row.append(where, text, when);
      row.addEventListener('click', async () => {
        if (state.activeId !== message.conversationId) {
          await openConversation(message.conversationId);
        }
        scrollToMessage(message.id);
      });
      box.appendChild(row);
    }
    box.classList.remove('is-hidden');
  }
  $('messageList').addEventListener('scroll', () => {
    if ($('messageList').scrollTop < 60) loadOlderMessages();
    state.stickToBottom = atBottom();
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
      closeLightbox();
      return;
    }
    if (!$('modalRoot').classList.contains('is-hidden')) closeModal();
    else if (onNarrowScreen() && state.activeId) leaveChat();
  });

  /* ------------------------------- استوری ------------------------------- */

  /**
   * استوری: عکسی که ۲۴ ساعت می‌ماند. نوارش بالای فهرست گفتگوهاست و فقط
   * استوری کسانی را نشان می‌دهد که گفتگوی مشترک دارید — همان قاعده‌ی بقیه‌ی
   * برنامه.
   */
  const STORY_MS = 5000;

  async function loadStories() {
    try {
      const data = await api('/stories');
      state.stories = data.stories;
    } catch {
      state.stories = [];
    }
    renderStories();
  }

  function renderStories() {
    renderStoriesPage();
  }

  /** همان استوری‌ها، این بار به‌صورت صفحه‌ی کامل در تبِ خودش. */
  function renderStoriesPage() {
    const grid = $('storiesGrid');
    grid.innerHTML = '';
    const groups = state.stories || [];
    const mine = groups.find((g) => g.mine);

    const card = (user, { unseen = false, label, onClick }) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = `story-card${unseen ? ' is-unseen' : ''}`;
      const avatar = document.createElement('span');
      avatar.className = 'avatar';
      paintAvatar(avatar, user.displayName, user.avatarColor, false, user.avatarUrl);
      const name = document.createElement('span');
      name.className = 'story-card-name';
      name.textContent = label;
      button.append(avatar, name);
      button.addEventListener('click', onClick);
      grid.appendChild(button);
    };

    card(state.me, {
      label: mine ? t('استوری من') : t('افزودن'),
      onClick: () => (mine ? openStories(groups.indexOf(mine)) : $('storyInput').click()),
    });
    for (const group of groups) {
      if (group.mine) continue;
      card(group.user, {
        unseen: !group.allSeen,
        label: group.user.displayName,
        onClick: () => openStories(groups.indexOf(group)),
      });
    }
  }

  /* ------------------------------ تب‌ها ------------------------------ */

  /**
   * چهار بخشِ برنامه. هر بار فقط یکی دیده می‌شود؛ محتوای تبِ تماس و
   * تنظیمات تنبل ساخته می‌شود، چون بیشتر کاربرها سراغشان نمی‌روند.
   */
  const TABS = ['chats', 'calls', 'stories', 'search', 'settings'];
  const PAGE_OF = {
    chats: 'chatsPage',
    calls: 'callsPage',
    stories: 'storiesPage',
    search: 'searchPage',
    settings: 'settingsPage',
  };

  function showTab(name) {
    const tab = TABS.includes(name) ? name : 'chats';
    state.tab = tab;
    for (const id of TABS) $(PAGE_OF[id]).classList.toggle('is-hidden', id !== tab);
    for (const button of $('tabBar').querySelectorAll('.tab-item')) {
      const active = button.dataset.tab === tab;
      button.classList.toggle('is-active', active);
      if (active) button.setAttribute('aria-current', 'page');
      else button.removeAttribute('aria-current');
    }
    if (tab === 'calls') renderCallsPage();
    if (tab === 'search') {
      drawConversations($('searchResults'), state.filter);
      // صفحه‌کلید را خودش بالا می‌آورد؛ کسی که روی «جستجو» می‌زند می‌خواهد بنویسد.
      setTimeout(() => $('conversationSearch').focus(), 60);
    }
    if (tab === 'settings') {
      // هر بار از نو ساخته می‌شود تا فهرست دستگاه‌ها و بلاک‌شده‌ها تازه باشد.
      $('settingsBody').innerHTML = '';
      buildProfile($('settingsBody'));
    }
  }

  /* ------------------------------ تماس‌ها ------------------------------ */

  async function renderCallsPage() {
    const list = $('callsList');
    list.innerHTML = '';
    list.appendChild(emptyNote(t('در حال بارگذاری…')));
    let calls = [];
    try {
      calls = (await api('/calls')).calls;
    } catch {
      calls = [];
    }
    list.innerHTML = '';
    if (calls.length === 0) {
      list.appendChild(emptyNote(t('هنوز تماسی نگرفته‌اید.')));
      return;
    }
    for (const call of calls) {
      const conv = call.conversation;
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'call-row';

      const avatar = document.createElement('span');
      avatar.className = 'avatar';
      paintAvatar(avatar, conv.title, conv.avatarColor, conv.online, conv.avatarUrl);

      const main = document.createElement('div');
      main.className = 'call-main';
      const name = document.createElement('strong');
      name.textContent = conv.title;
      const kind = document.createElement('span');
      const video = call.body.startsWith('video-');
      const status = video ? call.body.slice(6) : call.body;
      // «بی‌پاسخ» و «رد شده» قرمز می‌شوند، مثل هر دفترچه‌ی تماس.
      kind.className = `call-kind${status === 'ended' ? '' : ' is-missed'}`;
      kind.textContent = `${video ? '📹' : '📞'} ${callRecordText(call)}`;
      main.append(name, kind);

      const when = document.createElement('span');
      when.className = 'call-when';
      when.textContent = relativeTime(call.createdAt);

      row.append(avatar, main, when);
      row.addEventListener('click', () => {
        showTab('chats');
        openConversation(conv.id);
      });
      list.appendChild(row);
    }
  }

  /* --- نمای تمام‌صفحه --- */

  const story = { groupIndex: 0, itemIndex: 0, timer: null };

  function openStories(groupIndex) {
    if (groupIndex < 0) return;
    story.groupIndex = groupIndex;
    story.itemIndex = 0;
    $('storyViewer').classList.remove('is-hidden');
    pushOverlay('story', hideStories);
    showStory();
  }

  function hideStories() {
    clearTimeout(story.timer);
    $('storyViewer').classList.add('is-hidden');
    $('storyImage').removeAttribute('src');
    // حلقه‌ها باید وضعیت تازه‌ی «دیده شد» را نشان بدهند.
    loadStories();
  }

  const closeStories = () => {
    if (!closeOverlay('story')) hideStories();
  };

  function showStory() {
    const group = state.stories[story.groupIndex];
    if (!group) return closeStories();
    const item = group.items[story.itemIndex];
    if (!item) return nextStory();

    paintAvatar(
      $('storyAvatar'), group.user.displayName, group.user.avatarColor, false, group.user.avatarUrl
    );
    $('storyName').textContent = group.user.displayName;
    $('storyWhen').textContent = relativeTime(item.createdAt);
    $('storyImage').src = fileUrl(item.url);
    $('storyCaption').textContent = item.caption || '';
    $('storyDelete').classList.toggle('is-hidden', !group.mine);
    $('storyViewers').classList.toggle('is-hidden', !group.mine);
    if (group.mine) showViewerCount(item.id);

    // نوارهای پیشرفت بالای صفحه
    const bars = $('storyBars');
    bars.innerHTML = '';
    group.items.forEach((_, index) => {
      const bar = document.createElement('span');
      bar.className = `story-bar${index < story.itemIndex ? ' is-done' : ''}${
        index === story.itemIndex ? ' is-live' : ''
      }`;
      bar.style.setProperty('--story-ms', `${STORY_MS}ms`);
      bar.appendChild(document.createElement('i'));
      bars.appendChild(bar);
    });

    api(`/stories/${item.id}/seen`, { method: 'POST' }).catch(() => {});
    clearTimeout(story.timer);
    story.timer = setTimeout(nextStory, STORY_MS);
  }

  async function showViewerCount(storyId) {
    try {
      const data = await api(`/stories/${storyId}/viewers`);
      $('storyViewers').textContent = data.users.length
        ? t('👁 {n} بیننده', { n: fa(data.users.length) })
        : t('👁 هنوز کسی ندیده');
      $('storyViewers').onclick = () => {
        if (data.users.length === 0) return;
        openModal(t('بیننده‌های استوری'), (body) => {
          for (const user of data.users) body.appendChild(userRow(user));
        });
      };
    } catch {
      $('storyViewers').classList.add('is-hidden');
    }
  }

  function nextStory() {
    const group = state.stories[story.groupIndex];
    if (group && story.itemIndex + 1 < group.items.length) {
      story.itemIndex += 1;
      return showStory();
    }
    // گروه بعدی، و اگر نبود بسته می‌شود.
    if (story.groupIndex + 1 < state.stories.length) {
      story.groupIndex += 1;
      story.itemIndex = 0;
      return showStory();
    }
    return closeStories();
  }

  function prevStory() {
    if (story.itemIndex > 0) {
      story.itemIndex -= 1;
      return showStory();
    }
    if (story.groupIndex > 0) {
      story.groupIndex -= 1;
      story.itemIndex = Math.max(0, state.stories[story.groupIndex].items.length - 1);
      return showStory();
    }
    return showStory();
  }

  $('storyNext').addEventListener('click', nextStory);
  $('storyPrev').addEventListener('click', prevStory);
  $('storyClose').addEventListener('click', closeStories);
  $('storyDelete').addEventListener('click', async () => {
    const group = state.stories[story.groupIndex];
    const item = group?.items[story.itemIndex];
    if (!item || !confirm(t('این استوری حذف شود؟'))) return;
    try {
      const data = await api(`/stories/${item.id}`, { method: 'DELETE' });
      state.stories = data.stories;
      closeStories();
      toast(t('استوری حذف شد.'));
    } catch (err) {
      toast(err.message, true);
    }
  });

  $('storyInput').addEventListener('change', async (event) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    try {
      const blob = await prepareStoryImage(file);
      const form = new FormData();
      form.append('image', blob, 'story.jpg');
      const data = await api('/stories', { method: 'POST', body: form, raw: true });
      state.stories = data.stories;
      renderStories();
      toast(t('استوری شما تا ۲۴ ساعت دیده می‌شود.'));
    } catch (err) {
      toast(err.message || t('فرستادن استوری ناموفق بود.'), true);
    }
  });

  /** استوری را کوچک می‌کند؛ لازم نیست تمام‌اندازه باشد. */
  async function prepareStoryImage(file) {
    const bitmap = await createImageBitmap(file).catch(() => null);
    if (!bitmap) throw new Error(t('این فایل عکس نیست.'));
    const scale = Math.min(1, 1080 / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close?.();
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.85));
    if (!blob) throw new Error(t('آماده‌سازی عکس ممکن نشد.'));
    return blob;
  }

  /* --------------------------- نسخه‌ی تازه --------------------------- */

  /**
   * اگر کد سمت کاربر روی سرور عوض شده باشد، یا اپ اندرویدِ تازه‌تری موجود
   * باشد، یک نوار بالای صفحه پیشنهاد به‌روزرسانی می‌دهد.
   *
   * نسخه‌ی کد از روی خود فایل‌های وب ساخته می‌شود، پس ری‌استارت ساده‌ی سرور
   * این نوار را بی‌دلیل نمی‌آورد.
   */
  const VERSION_CHECK_MS = 20 * 60_000;

  /** مقایسه‌ی نسخه‌های نقطه‌دار: «۱.۱۰» تازه‌تر از «۱.۹» است. */
  function isNewer(candidate, current) {
    if (!candidate || !current) return false;
    const a = String(candidate).split('.').map(Number);
    const b = String(current).split('.').map(Number);
    for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
      const x = a[i] || 0;
      const y = b[i] || 0;
      if (x !== y) return x > y;
    }
    return false;
  }

  function showUpdateBar({ text, action, onClick }) {
    $('updateText').textContent = text;
    $('updateAction').textContent = action;
    $('updateAction').onclick = onClick;
    $('updateBar').classList.remove('is-hidden');
  }

  async function checkForUpdate() {
    let data;
    try {
      data = await api('/version');
    } catch {
      return; // قطعی شبکه ربطی به نسخه ندارد
    }

    // نخستین بار فقط ثبت می‌کنیم؛ همین نسخه‌ای است که الان اجرا می‌شود.
    if (!state.clientVersion) {
      state.clientVersion = data.client;
      state.androidVersion = data.android;
      state.builtAt = data.builtAt;
    }

    if (data.client !== state.clientVersion && !state.updateDismissed) {
      showUpdateBar({
        text: t('نسخه‌ی تازه‌ای از برنامه آمده است.'),
        action: t('تازه‌سازی'),
        onClick: () => location.reload(),
      });
      return;
    }

    // نسخه‌ی اپ اندروید را فقط خودِ اپ می‌داند؛ مرورگر معمولی خبر ندارد.
    const installed = window.AndroidBridge?.appVersion?.();
    if (installed && isNewer(data.android, installed) && !state.updateDismissed) {
      showUpdateBar({
        text: t('نسخه‌ی {version} اپ اندروید آمده است (شما {installed} دارید).', { version: faDigits(data.android), installed: faDigits(installed) }),
        action: t('دریافت'),
        onClick: () => {
          window.open('/app.apk', '_blank');
        },
      });
    }
  }

  $('updateDismiss').addEventListener('click', () => {
    state.updateDismissed = true;
    $('updateBar').classList.add('is-hidden');
  });

  /** اگر فایل نصبی روی سرور باشد، پیوند دانلودش را در صفحه‌ی ورود نشان می‌دهد. */
  async function showApkLink() {
    try {
      const res = await fetch('/api/app/android');
      const data = await res.json();
      if (!data.available) return;
      $('apkMeta').textContent = `${data.name} · ${fileSize(data.size)}`;
      $('apkLink').classList.remove('is-hidden');
    } catch {
      /* نبودش ایرادی ندارد */
    }
  }

  async function boot() {
    showApkLink();
    checkForUpdate();
    setInterval(checkForUpdate, VERSION_CHECK_MS);
    // برگشتن به برنامه بعد از مدتی، بهترین لحظه برای بررسی است.
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') checkForUpdate();
    });
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
            ? t('حساب شما مسدود شده است.')
            : t('حساب شما هنوز توسط مدیر تایید نشده است.')
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
