'use strict';

/**
 * محدودکننده‌ی نرخ درخواست، در حافظه و بدون وابستگی بیرونی.
 *
 * هدف اصلی‌اش جلوگیری از حمله‌ی حدس رمز و شمارش کاربران است. چون برنامه روی یک
 * پروسه اجرا می‌شود، نگه داشتن شمارنده‌ها در حافظه کافی است؛ اگر روزی چند
 * پروسه شد، باید به چیزی مشترک مثل Redis منتقل شود.
 */

const buckets = new Map();

function createLimiter({ windowMs, max }) {
  const take = (key, record = true) => {
    const now = Date.now();
    const bucket = buckets.get(key);

    if (!bucket || now >= bucket.resetAt) {
      if (record) buckets.set(key, { count: 1, resetAt: now + windowMs });
      return { allowed: true, remaining: max - 1, retryAfterSeconds: 0 };
    }

    if (bucket.count >= max) {
      return {
        allowed: false,
        remaining: 0,
        retryAfterSeconds: Math.max(1, Math.ceil((bucket.resetAt - now) / 1000)),
      };
    }

    if (record) bucket.count += 1;
    return { allowed: true, remaining: max - bucket.count, retryAfterSeconds: 0 };
  };

  return {
    /** یک تلاش را ثبت و می‌گوید مجاز است یا نه. */
    consume: (key) => take(key, true),
    /** فقط بررسی می‌کند، بدون ثبت (برای شمردن «تلاش ناموفق») */
    peek: (key) => take(key, false),
    /** ثبت یک تلاش ناموفق */
    fail: (key) => take(key, true),
    /** پاک کردن شمارنده بعد از موفقیت */
    reset: (key) => buckets.delete(key),
  };
}

/** کلید را از آی‌پی واقعی کاربر می‌سازد (پشت nginx از X-Forwarded-For می‌آید). */
const ipOf = (req) => req.ip || req.socket?.remoteAddress || 'unknown';

/**
 * میان‌افزار آماده. `keyBy` تعیین می‌کند شمارش روی آی‌پی باشد یا روی حساب کاربری؛
 * شمارش روی حساب جلوی سوءاستفاده‌ی کاربرِ واردشده را می‌گیرد حتی اگر آی‌پی عوض کند.
 */
function rateLimit({ windowMs, max, scope, by = 'ip', message }) {
  const limiter = createLimiter({ windowMs, max });
  return (req, res, next) => {
    const identity = by === 'user' && req.user ? `u${req.user.id}` : ipOf(req);
    const result = limiter.consume(`${scope}:${identity}`);
    if (result.allowed) return next();
    res.setHeader('Retry-After', String(result.retryAfterSeconds));
    return res.status(429).json({
      error: message || 'درخواست‌های شما زیاد است؛ کمی بعد دوباره تلاش کنید.',
      retryAfter: result.retryAfterSeconds,
    });
  };
}

// پاک کردن دوره‌ای تا حافظه با کلیدهای قدیمی پر نشود.
const sweeper = setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of buckets) if (now >= bucket.resetAt) buckets.delete(key);
}, 60_000);
sweeper.unref?.();

module.exports = { createLimiter, rateLimit, ipOf };
