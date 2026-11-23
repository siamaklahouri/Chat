'use strict';

/**
 * پیش‌نمایش لینک: عنوان و توضیحِ یک نشانی، از روی برچسب‌های og: و <title>.
 *
 * این تنها جایی است که سرور به دستورِ کاربر به بیرون وصل می‌شود، پس
 * محکم بسته شده است:
 *   - فقط http و https، و فقط پورت ۸۰ و ۴۴۳.
 *   - نشانی به IP تبدیل می‌شود و اگر به شبکه‌ی داخلی یا لوکال‌هاست اشاره
 *     کند رد می‌شود (SSRF). همین بررسی روی هر تغییرمسیر هم تکرار می‌شود.
 *   - حداکثر سه تغییرمسیر، ۵ ثانیه مهلت، و فقط ۱۲۸ کیلوبایت اولِ صفحه
 *     خوانده می‌شود؛ بقیه دور ریخته می‌شود.
 *   - فقط text/html خوانده می‌شود.
 * نتیجه در حافظه کش می‌شود تا یک لینکِ پرتکرار، سرور را بیرون نفرستد.
 */

const dns = require('node:dns').promises;
const net = require('node:net');

const TIMEOUT_MS = 5000;
const MAX_BYTES = 128 * 1024;
const MAX_REDIRECTS = 3;
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const CACHE_MAX = 300;

const cache = new Map();

/** آیا این IP داخلِ شبکه‌ی خودمان است؟ */
function isPrivateAddress(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    if (a === 10 || a === 127 || a === 0) return true;
    if (a === 169 && b === 254) return true; // link-local و متادیتای ابری
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
    if (a >= 224) return true; // multicast و رزرو
    return false;
  }
  if (net.isIPv6(ip)) {
    const low = ip.toLowerCase();
    if (low === '::1' || low === '::') return true;
    if (low.startsWith('fc') || low.startsWith('fd')) return true; // unique-local
    if (low.startsWith('fe80')) return true; // link-local
    // ::ffff:a.b.c.d — همان IPv4 با لباس دیگر
    const mapped = low.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPrivateAddress(mapped[1]);
    return false;
  }
  return true;
}

async function assertPublic(hostname) {
  if (net.isIP(hostname)) {
    if (isPrivateAddress(hostname)) throw new Error('نشانی داخلی است.');
    return;
  }
  const records = await dns.lookup(hostname, { all: true });
  if (records.length === 0) throw new Error('نشانی پیدا نشد.');
  for (const record of records) {
    if (isPrivateAddress(record.address)) throw new Error('نشانی داخلی است.');
  }
}

function checkUrl(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('نشانی نامعتبر است.');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('نشانی نامعتبر است.');
  if (url.port && !['80', '443'].includes(url.port)) throw new Error('نشانی نامعتبر است.');
  return url;
}

const decode = (text) =>
  text
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'")
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');

function metaOf(html, names) {
  for (const name of names) {
    const pattern = new RegExp(
      `<meta[^>]+(?:property|name)\\s*=\\s*["']${name}["'][^>]*>`,
      'i'
    );
    const tag = html.match(pattern)?.[0];
    if (!tag) continue;
    const value = tag.match(/content\s*=\s*["']([^"']*)["']/i)?.[1];
    if (value) return decode(value).trim();
  }
  return '';
}

/** فقط ۱۲۸ کیلوبایت اول را می‌خوانیم؛ برچسب‌های og همیشه در <head> هستند. */
async function readHead(response) {
  const reader = response.body?.getReader();
  if (!reader) return '';
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      size += value.length;
      if (size >= MAX_BYTES) break;
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return Buffer.concat(chunks).subarray(0, MAX_BYTES).toString('utf8');
}

async function fetchPreview(rawUrl) {
  let url = checkUrl(rawUrl);
  let response = null;

  // تغییرمسیر را خودمان دنبال می‌کنیم تا هر گام دوباره بررسی شود؛
  // وگرنه یک نشانیِ عمومی می‌توانست به ۱۲۷.۰.۰.۱ بفرستدمان.
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    await assertPublic(url.hostname);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      response = await fetch(url.href, {
        redirect: 'manual',
        signal: controller.signal,
        headers: { Accept: 'text/html,application/xhtml+xml', 'User-Agent': 'LinkPreview/1.0' },
      });
    } finally {
      clearTimeout(timer);
    }
    if (![301, 302, 303, 307, 308].includes(response.status)) break;
    const next = response.headers.get('location');
    if (!next) break;
    url = checkUrl(new URL(next, url).href);
    response = null;
  }

  if (!response || !response.ok) throw new Error('صفحه باز نشد.');
  if (!/text\/html/i.test(response.headers.get('content-type') || '')) {
    throw new Error('این نشانی صفحه‌ی وب نیست.');
  }

  const html = await readHead(response);
  const title =
    metaOf(html, ['og:title', 'twitter:title']) ||
    decode(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || '').trim();
  if (!title) throw new Error('عنوانی پیدا نشد.');

  return {
    url: url.href,
    site: url.hostname.replace(/^www\./, ''),
    title: title.slice(0, 120),
    description: metaOf(html, ['og:description', 'twitter:description', 'description']).slice(0, 220),
  };
}

async function preview(rawUrl) {
  const key = String(rawUrl).slice(0, 500);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) {
    if (hit.error) throw new Error(hit.error);
    return hit.data;
  }
  try {
    const data = await fetchPreview(key);
    if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
    cache.set(key, { at: Date.now(), data });
    return data;
  } catch (error) {
    if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
    cache.set(key, { at: Date.now(), error: error.message });
    throw error;
  }
}

module.exports = { preview, isPrivateAddress, checkUrl };
