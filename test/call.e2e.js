/*
 * آزمون تماس صوتی در مرورگر واقعی: دو Chromium با میکروفون قلابی، یک تماس کامل
 * برقرار می‌کنند. چیزهایی را می‌سنجد که آزمون API نمی‌تواند: دسترسی میکروفون،
 * برقراری واقعی WebRTC، تایمر، بی‌صدا کردن و ثبت رکورد تماس در گفتگو.
 *
 * بخشی از `npm test` نیست چون به playwright و یک Chromium نیاز دارد:
 *   npm i -D playwright && npx playwright install chromium
 *   node test/call.e2e.js
 */
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'call-e2e-'));
process.env.DATA_DIR = TMP;
process.env.DB_FILE = path.join(TMP, 'e2e.db');
process.env.UPLOAD_DIR = path.join(TMP, 'uploads');
process.env.TURN_HOST = '127.0.0.1'; // STUN بی‌اثر؛ روی لوکال‌هاست کاندیدای host کافی است
process.env.PORT = '4310';
process.env.HOST = '127.0.0.1';

const { server } = require('../server/index.js');
const store = require('../server/store.js');

const BASE = 'http://127.0.0.1:4310';
const log = (...a) => console.log('·', ...a);

const register = async (username, displayName) => {
  const res = await fetch(`${BASE}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, displayName, password: 'secret1234' }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`ثبت‌نام ${username}: ${JSON.stringify(data)}`);
  return data;
};

async function login(page, username) {
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.fill('#loginForm input[name=username]', username);
  await page.fill('#loginForm input[name=password]', 'secret1234');
  await page.click('#loginForm button[type=submit]');
  await page.waitForSelector('#appScreen:not(.is-hidden)', { timeout: 15000 });
}

(async () => {
  await new Promise((r) => server.listen(4310, '127.0.0.1', r));
  log('سرور بالا آمد');

  const admin = await register('admin', 'مدیر');
  const sara = await register('sara', 'سارا');
  store.setUserStatus(store.getUserByUsername('sara').id, 'approved', 1);
  void admin; void sara;

  const browser = await chromium.launch({
    // در محیط‌هایی که Chromium جای دیگری نصب شده، با CHROMIUM_PATH مشخص کنید.
    executablePath: process.env.CHROMIUM_PATH || undefined,
    args: [
      '--use-fake-device-for-media-stream',
      '--use-fake-ui-for-media-stream',
      '--autoplay-policy=no-user-gesture-required',
      '--no-sandbox',
    ],
  });

  const ctxA = await browser.newContext({ permissions: ['microphone'], baseURL: BASE });
  const ctxB = await browser.newContext({ permissions: ['microphone'], baseURL: BASE });
  const a = await ctxA.newPage();
  const b = await ctxB.newPage();
  const errors = [];
  for (const [name, page] of [['admin', a], ['sara', b]]) {
    page.on('pageerror', (e) => errors.push(`${name}: ${e.message}`));
    page.on('console', (m) => m.type() === 'error' && errors.push(`${name} console: ${m.text()}`));
  }

  await login(a, 'admin');
  await login(b, 'sara');
  log('هر دو کاربر وارد شدند');

  // گفتگوی دونفره از سمت مدیر
  await a.click('#newChatBtn');
  await a.fill('#modalBody input[type=search]', 'sara');
  await a.waitForSelector('#modalBody .user-row', { timeout: 8000 });
  await a.click('#modalBody .user-row');
  await a.waitForSelector('#chatView:not(.is-hidden)', { timeout: 8000 });
  log('گفتگو ساخته شد');

  // طرف مقابل باید گفتگو را ببیند و بازش کند
  await b.waitForSelector('#conversationList .conversation', { timeout: 8000 });
  await b.click('#conversationList .conversation');
  await b.waitForSelector('#chatView:not(.is-hidden)');

  // دکمه‌ی تماس باید دیده شود
  await a.waitForSelector('#callBtn:not(.is-hidden)', { timeout: 8000 });
  log('دکمه‌ی تماس در سربرگ دیده می‌شود');

  // تماس
  await a.click('#callBtn');
  await a.waitForSelector('#callOverlay:not(.is-hidden)');
  log('صفحه‌ی تماس تماس‌گیرنده:', await a.textContent('#callState'));

  await b.waitForSelector('#callOverlay:not(.is-hidden)', { timeout: 8000 });
  await b.waitForSelector('#callAccept:not(.is-hidden)');
  log('زنگ روی دستگاه گیرنده:', await b.textContent('#callState'));

  await b.click('#callAccept');

  // اتصال واقعی WebRTC: وضعیت باید به شمارنده‌ی زمان برسد
  const connected = async (page) =>
    page.waitForFunction(
      () => /^[۰-۹]+:[۰-۹]{2}$/.test(document.getElementById('callState').textContent.trim()),
      null,
      { timeout: 20000 }
    );
  await Promise.all([connected(a), connected(b)]);
  log('تماس برقرار شد — تایمر:', await a.textContent('#callState'), '/', await b.textContent('#callState'));

  // صدای واقعی رسیده؟ وضعیت RTCPeerConnection و track صوتی را می‌پرسیم
  const audioLive = (page) =>
    page.evaluate(() => {
      const audio = document.getElementById('remoteAudio');
      const stream = audio?.srcObject;
      return {
        hasStream: Boolean(stream),
        tracks: stream ? stream.getAudioTracks().map((t) => t.readyState) : [],
        muteVisible: !document.getElementById('callMute').classList.contains('is-hidden'),
      };
    });
  log('سمت مدیر:', JSON.stringify(await audioLive(a)));
  log('سمت سارا:', JSON.stringify(await audioLive(b)));

  // بی‌صدا کردن
  await a.click('#callMute');
  const muted = await a.evaluate(() => document.getElementById('callMute').classList.contains('is-on'));
  log('بی‌صدا شد؟', muted);
  await a.click('#callMute');

  await new Promise((r) => setTimeout(r, 2500)); // چند ثانیه مکالمه

  // پایان تماس از سمت سارا
  await b.click('#callHangup');
  await a.waitForSelector('#callOverlay', { state: 'hidden', timeout: 8000 });
  await b.waitForSelector('#callOverlay', { state: 'hidden', timeout: 8000 });
  log('تماس پایان یافت و صفحه بسته شد');

  // رکورد تماس باید در گفتگوی هر دو طرف ثبت شده باشد
  for (const [name, page] of [['admin', a], ['sara', b]]) {
    await page.waitForSelector('.system-message.call-record', { timeout: 8000 });
    log(`رکورد تماس (${name}):`, (await page.textContent('.system-message.call-record')).trim());
  }

  // آزمون دوم: رد کردن تماس
  await a.click('#callBtn');
  await b.waitForSelector('#callAccept:not(.is-hidden)', { timeout: 8000 });
  await b.click('#callHangup');
  await a.waitForSelector('#callOverlay', { state: 'hidden', timeout: 8000 });
  const records = await a.$$eval('.system-message.call-record', (els) => els.map((e) => e.textContent.trim()));
  log('رکوردها پس از رد تماس:', JSON.stringify(records));

  log('— پایان —');

  if (errors.length) {
    console.log('\n⚠ خطاهای کنسول:');
    for (const e of [...new Set(errors)]) console.log('   ', e);
  } else {
    console.log('\n✅ بدون خطای کنسول');
  }

  await browser.close();
  server.close();
  fs.rmSync(TMP, { recursive: true, force: true });
  process.exit(errors.length ? 1 : 0);
})().catch(async (error) => {
  console.error('✗ شکست:', error.message);
  process.exit(1);
});
