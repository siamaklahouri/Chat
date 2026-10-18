/*
 * عکس پروفایل در مرورگر واقعی.
 *
 * چیزهایی را می‌سنجد که آزمون API نمی‌تواند: انتخاب فایل از پنجره‌ی پروفایل،
 * برشِ مربعی سمت کلاینت، و مهم‌تر از همه اینکه طرف مقابل تغییر را **بدون
 * رفرش** ببیند (رویداد user:updated).
 *
 * بخشی از `npm test` نیست چون به playwright و یک Chromium نیاز دارد:
 *   npm i -D playwright && npx playwright install chromium
 *   node test/avatar.e2e.js
 */
'use strict';
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { chromium } = require('playwright');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'av-'));
process.env.DATA_DIR = TMP;
process.env.DB_FILE = path.join(TMP, 'a.db');
process.env.UPLOAD_DIR = path.join(TMP, 'up');
const { server } = require('../server/index.js');
const store = require('../server/store.js');
const PORT = 4340, BASE = `http://127.0.0.1:${PORT}`;
const { pngBuffer } = require('./helpers/png.js');

const log = (...a) => console.log('·', ...a);
const reg = (u, d) => fetch(`${BASE}/api/auth/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: u, displayName: d, password: 'secret1234' }) }).then((r) => r.json());
const login = async (page, u) => {
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.fill('#loginForm input[name=username]', u);
  await page.fill('#loginForm input[name=password]', 'secret1234');
  await page.click('#loginForm button[type=submit]');
  await page.waitForSelector('#appScreen:not(.is-hidden)', { timeout: 15000 });
};
const avatarStyle = (page, sel) => page.$eval(sel, (e) => ({
  image: getComputedStyle(e).backgroundImage.slice(0, 60),
  color: getComputedStyle(e).backgroundColor,
  text: e.textContent.trim(),
}));

(async () => {
  await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
  await reg('admin', 'مدیر');
  await reg('sara', 'سارا');
  const saraId = store.getUserByUsername('sara').id;
  const adminId = store.getUserByUsername('admin').id;
  store.setUserStatus(saraId, 'approved', 1);
  const direct = store.getOrCreateDirect(adminId, saraId).conversation;
  store.createMessage({ conversationId: direct.id, senderId: saraId, body: 'سلام' });

  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--no-sandbox'] });
  const errors = [];
  const ctxA = await browser.newContext({ viewport: { width: 1280, height: 820 } });
  const ctxB = await browser.newContext({ viewport: { width: 1280, height: 820 } });
  const admin = await ctxA.newPage(), sara = await ctxB.newPage();
  for (const [n, p] of [['admin', admin], ['sara', sara]]) {
    p.on('pageerror', (e) => errors.push(`${n}: ${e.message}`));
    p.on('console', (m) => m.type() === 'error' && errors.push(`${n} console: ${m.text()}`));
  }

  await login(admin, 'admin');
  await login(sara, 'sara');
  await admin.click('#conversationList .conversation');
  await admin.waitForSelector('#chatView:not(.is-hidden)');

  log('پیش از آپلود، آواتار مدیر در نوار کناری:', JSON.stringify(await avatarStyle(sara, '#meAvatar')));

  // --- سارا عکس می‌گذارد ---
  await sara.click('#profileBtn');
  await sara.waitForSelector('.avatar-editor');
  const picked = await sara.textContent('.avatar-editor-actions .btn');
  log('متن دکمه پیش از انتخاب:', picked.trim());

  await sara.setInputFiles('.avatar-editor input[type=file]', {
    name: 'me.png', mimeType: 'image/png', buffer: pngBuffer(400, 260),
  });
  await sara.waitForFunction(() => /url\(/.test(getComputedStyle(document.querySelector('#meAvatar')).backgroundImage), null, { timeout: 10000 });
  log('آواتار خود سارا بعد از آپلود:', JSON.stringify(await avatarStyle(sara, '#meAvatar')));
  log('متن دکمه بعد از انتخاب:', (await sara.textContent('.avatar-editor-actions .btn')).trim());

  // عکس باید واقعاً مربع و ۵۱۲ یا کمتر باشد (برش از وسط)
  const dims = await sara.evaluate(async () => {
    const img = document.createElement('img');
    img.src = document.querySelector('#meAvatar').style.backgroundImage.slice(5, -2);
    await img.decode();
    return { w: img.naturalWidth, h: img.naturalHeight };
  });
  log('ابعاد عکس ذخیره‌شده:', JSON.stringify(dims), dims.w === dims.h ? '(مربع ✔)' : '(مربع نیست ✘)');

  await sara.keyboard.press('Escape');

  // --- مدیر باید بدون رفرش ببیندش ---
  await admin.waitForFunction(() => /url\(/.test(getComputedStyle(document.querySelector('#chatAvatar')).backgroundImage), null, { timeout: 10000 });
  log('سربرگ گفتگوی مدیر:', JSON.stringify(await avatarStyle(admin, '#chatAvatar')));
  log('فهرست گفتگوهای مدیر:', JSON.stringify(await avatarStyle(admin, '#conversationList .conversation .avatar')));

  // --- در گروه، آواتار کنار پیام ---
  const group = store.createGroup({ title: 'تیم', creatorId: adminId, memberIds: [saraId] });
  store.createMessage({ conversationId: group.id, senderId: saraId, body: 'سلام بچه‌ها' });
  await admin.reload({ waitUntil: 'domcontentloaded' });
  await admin.waitForSelector('#appScreen:not(.is-hidden)');
  await admin.click('#conversationList .conversation:has-text("تیم")');
  await admin.waitForSelector('.row-avatar', { timeout: 8000 });
  log('آواتار کنار پیام گروه:', JSON.stringify(await avatarStyle(admin, '.row-avatar')));

  // --- حذف ---
  await sara.click('#profileBtn');
  await sara.waitForSelector('.avatar-editor .btn-danger:not(.is-hidden)');
  await sara.click('.avatar-editor .btn-danger');
  await sara.waitForFunction(() => !/url\(/.test(getComputedStyle(document.querySelector('#meAvatar')).backgroundImage), null, { timeout: 10000 });
  log('بعد از حذف، آواتار سارا:', JSON.stringify(await avatarStyle(sara, '#meAvatar')));
  await admin.waitForFunction(() => !/url\(/.test(getComputedStyle(document.querySelector('#conversationList .conversation .avatar')).backgroundImage), null, { timeout: 10000 });
  log('مدیر هم حذف را دید ✔');

  console.log(errors.length ? `\n⚠ ${[...new Set(errors)].join('\n   ')}` : '\n✅ بدون خطای کنسول');
  await browser.close(); server.close();
  fs.rmSync(TMP, { recursive: true, force: true });
  process.exit(errors.length ? 1 : 0);
})().catch((e) => { console.error('✗', e.message); process.exit(1); });
