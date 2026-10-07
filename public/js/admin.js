/* پنل مدیریت — تایید کاربران و پاکسازی داده‌ها */
(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const TOKEN_KEY = 'messenger.token';
  const fa = (n) => Number(n || 0).toLocaleString('fa-IR');

  let token = localStorage.getItem(TOKEN_KEY) || null;
  let filter = '';
  let currentUserId = null;

  const STATUS_LABEL = { pending: 'در انتظار تایید', approved: 'تاییدشده', blocked: 'مسدود' };

  function toast(message, isError = false) {
    const el = $('toast');
    el.textContent = message;
    el.classList.toggle('error', isError);
    el.classList.remove('is-hidden');
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => el.classList.add('is-hidden'), 3000);
  }

  async function api(path, { method = 'GET', body } = {}) {
    const headers = {};
    if (token) headers.Authorization = `Bearer ${token}`;
    if (body) headers['Content-Type'] = 'application/json';
    const res = await fetch(`/api${path}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const error = new Error(data.error || 'خطای ناشناخته');
      error.status = res.status;
      throw error;
    }
    return data;
  }

  function showGate(message, showForm = true) {
    $('adminContent').classList.add('is-hidden');
    $('adminGate').classList.remove('is-hidden');
    $('gateMessage').textContent = message;
    $('adminLoginForm').classList.toggle('is-hidden', !showForm);
  }

  $('adminLoginForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = new FormData(event.target);
    try {
      const data = await api('/auth/login', {
        method: 'POST',
        body: { username: form.get('username'), password: form.get('password') },
      });
      if (!data.user.isAdmin) return showGate('این حساب دسترسی مدیریت ندارد.');
      token = data.token;
      localStorage.setItem(TOKEN_KEY, token);
      await start();
    } catch (err) {
      showGate(err.message);
    }
  });

  function renderOverview(payload) {
    const { stats, cleanup, online } = payload;
    $('statUsers').textContent = fa(stats.users);
    $('statPending').textContent = fa(stats.pending);
    $('statOnline').textContent = fa(online);
    $('statMessages').textContent = fa(stats.messages);
    $('statImages').textContent = fa(stats.images);
    $('statConversations').textContent = fa(stats.conversations);

    const format = (ts) =>
      new Date(ts).toLocaleString('fa-IR', {
        year: 'numeric',
        month: 'long',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      });
    const last = cleanup.lastWipeAt ? `آخرین پاکسازی: ${format(cleanup.lastWipeAt)}` : 'هنوز پاکسازی نشده';
    $('wipeText').textContent = cleanup.auto
      ? `پاکسازی خودکار هر ${fa(cleanup.intervalDays)} روز — بعدی: ${format(cleanup.nextWipeAt)} · ${last}`
      : `پاکسازی خودکار خاموش است؛ هر وقت خواستید از همین‌جا دستی پاک کنید. ${last}`;
  }

  function actionButton(label, className, onClick) {
    const button = document.createElement('button');
    button.className = `btn ${className}`;
    button.textContent = label;
    button.addEventListener('click', async () => {
      button.disabled = true;
      try {
        await onClick();
      } catch (err) {
        toast(err.message, true);
      } finally {
        button.disabled = false;
      }
    });
    return button;
  }

  function renderUsers(users) {
    const list = $('userList');
    list.innerHTML = '';
    if (users.length === 0) {
      list.innerHTML = '<p class="empty-list">کاربری در این دسته نیست.</p>';
      return;
    }

    for (const user of users) {
      const row = document.createElement('div');
      row.className = 'admin-user';

      const avatar = document.createElement('span');
      avatar.className = 'avatar';
      avatar.textContent = (user.displayName || '?').charAt(0).toUpperCase();
      avatar.style.background = user.avatarColor;

      const main = document.createElement('div');
      main.className = 'admin-user-main';
      const name = document.createElement('strong');
      name.textContent = user.displayName;
      const meta = document.createElement('small');
      meta.className = 'muted';
      const handle = document.createElement('bdi');
      handle.textContent = `@${user.username}`;
      meta.append(handle, ` — عضویت ${new Date(user.createdAt).toLocaleDateString('fa-IR')}`);
      const tags = document.createElement('div');
      tags.style.marginTop = '4px';
      tags.style.display = 'flex';
      tags.style.gap = '6px';
      const statusTag = document.createElement('span');
      statusTag.className = `tag ${user.status}`;
      statusTag.textContent = STATUS_LABEL[user.status];
      tags.appendChild(statusTag);
      if (user.isAdmin) {
        const adminTag = document.createElement('span');
        adminTag.className = 'tag admin';
        adminTag.textContent = 'مدیر';
        tags.appendChild(adminTag);
      }
      if (user.online) {
        const onlineTag = document.createElement('span');
        onlineTag.className = 'tag approved';
        onlineTag.textContent = 'آنلاین';
        tags.appendChild(onlineTag);
      }
      main.append(name, meta, tags);

      const actions = document.createElement('div');
      actions.className = 'admin-actions';
      const setStatus = (status) => async () => {
        await api(`/admin/users/${user.id}/status`, { method: 'POST', body: { status } });
        toast('وضعیت کاربر به‌روز شد.');
        await refresh();
      };

      const isSelf = user.id === currentUserId;
      if (!isSelf) {
        if (user.status !== 'approved') {
          actions.appendChild(actionButton('تایید', 'btn-primary', setStatus('approved')));
        }
        if (user.status !== 'blocked' && !user.isAdmin) {
          actions.appendChild(actionButton('مسدود', 'btn-danger', setStatus('blocked')));
        }
        if (user.status === 'blocked') {
          actions.appendChild(actionButton('بازگشت به انتظار', '', setStatus('pending')));
        }
      }
      if (!isSelf) actions.appendChild(
        actionButton(user.isAdmin ? 'حذف مدیریت' : 'مدیر کردن', '', async () => {
          await api(`/admin/users/${user.id}/admin`, {
            method: 'POST',
            body: { isAdmin: !user.isAdmin },
          });
          toast('دسترسی مدیریت تغییر کرد.');
          await refresh();
        })
      );
      actions.appendChild(
        actionButton('رمز جدید', '', async () => {
          const password = prompt(`رمز تازه برای @${user.username} (حداقل ۶ نویسه):`);
          if (!password) return;
          await api(`/admin/users/${user.id}/password`, { method: 'POST', body: { password } });
          toast('رمز عبور تغییر کرد.');
        })
      );
      if (!isSelf && !user.isAdmin) actions.appendChild(
        actionButton('حذف', 'btn-danger', async () => {
          if (!confirm(`حساب @${user.username} برای همیشه حذف شود؟`)) return;
          await api(`/admin/users/${user.id}`, { method: 'DELETE' });
          toast('کاربر حذف شد.');
          await refresh();
        })
      );

      row.append(avatar, main, actions);
      list.appendChild(row);
    }
  }

  async function refresh() {
    const [overview, users] = await Promise.all([
      api('/admin/overview'),
      api(`/admin/users${filter ? `?status=${filter}` : ''}`),
    ]);
    renderOverview(overview);
    renderUsers(users.users);
  }

  document.querySelectorAll('[data-filter]').forEach((chip) => {
    chip.addEventListener('click', async () => {
      document.querySelectorAll('[data-filter]').forEach((c) => c.classList.remove('is-active'));
      chip.classList.add('is-active');
      filter = chip.dataset.filter;
      await refresh().catch((err) => toast(err.message, true));
    });
  });

  $('wipeBtn').addEventListener('click', async () => {
    if (!confirm('همه‌ی پیام‌ها و عکس‌ها همین حالا پاک شوند؟')) return;
    try {
      const data = await api('/admin/cleanup/run', { method: 'POST' });
      toast(`${fa(data.result.messages)} پیام پاک شد.`);
      await refresh();
    } catch (err) {
      toast(err.message, true);
    }
  });

  async function start() {
    try {
      const { user } = await api('/me');
      if (!user.isAdmin) return showGate('این حساب دسترسی مدیریت ندارد.');
      $('adminWho').replaceChildren(Object.assign(document.createElement('bdi'), { textContent: `@${user.username}` }));
      currentUserId = user.id;
      $('adminGate').classList.add('is-hidden');
      $('adminContent').classList.remove('is-hidden');
      await refresh();
      setInterval(() => refresh().catch(() => {}), 20000);
    } catch (err) {
      showGate(err.status === 401 ? 'برای ورود به پنل، با حساب مدیر وارد شوید.' : err.message);
    }
  }

  if (!token) showGate('برای ورود به پنل، با حساب مدیر وارد شوید.');
  else start();
})();
