#!/usr/bin/env bash
# راه‌اندازی پیام‌رسان روی سروری که از قبل سایت‌های دیگری دارد.
#
#   sudo bash deploy/deploy-vhost.sh 9chat.ir you@mail.com
#
# این اسکریپت عمداً محافظه‌کار است:
#   • پورت ۸۰ و ۴۴۳ را خودش نمی‌گیرد؛ برنامه فقط روی 127.0.0.1 گوش می‌دهد.
#   • هیچ فایل کانفیگ موجودی را تغییر نمی‌دهد؛ فقط یک فایل تازه برای این دامنه می‌سازد.
#   • اگر فایلی با همین نام از قبل باشد، متوقف می‌شود.
#   • پیش از ریلود، کانفیگ وب‌سرور را تست می‌کند و وب‌سرور را reload می‌کند نه restart.
set -euo pipefail

DOMAIN="${1:-}"
EMAIL="${2:-}"
APP_PORT="${APP_PORT:-3000}"
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

die() { echo "خطا: $*" >&2; exit 1; }
info() { echo "==> $*"; }

[[ -n "$DOMAIN" ]] || die "کاربرد: sudo bash deploy/deploy-vhost.sh <دامنه> [ایمیل]"
[[ $EUID -eq 0 ]] || die "این اسکریپت را با sudo اجرا کنید."

# ---------------------------------------------------------------- وب‌سرور
info "تشخیص وب‌سرور فعلی"
if command -v nginx >/dev/null 2>&1; then
  WEBSERVER=nginx
elif command -v apache2 >/dev/null 2>&1 || command -v httpd >/dev/null 2>&1; then
  WEBSERVER=apache
else
  WEBSERVER=none
fi
echo "    وب‌سرور: $WEBSERVER"

if [[ "$WEBSERVER" == "apache" ]]; then
  cat >&2 <<APACHE
این سرور از apache استفاده می‌کند. برای اینکه به سایت‌های دیگر دست نزنیم،
کانفیگ apache را خودکار اعمال نمی‌کنم. این مراحل را دستی انجام دهید:

  1) bash deploy/deploy-vhost.sh را با APP_ONLY=1 اجرا کنید تا فقط برنامه بالا بیاید:
       sudo APP_ONLY=1 bash deploy/deploy-vhost.sh $DOMAIN
  2) فایل deploy/apache-vhost.conf.template را با دامنه و پورت پر کنید و در
     /etc/apache2/sites-available/$DOMAIN.conf بگذارید.
  3) a2enmod proxy proxy_http proxy_wstunnel rewrite
     a2ensite $DOMAIN && apache2ctl configtest && systemctl reload apache2
  4) certbot --apache -d $DOMAIN -d www.$DOMAIN
APACHE
  [[ "${APP_ONLY:-0}" == "1" ]] || exit 1
fi

if [[ "$WEBSERVER" == "none" && "${APP_ONLY:-0}" != "1" ]]; then
  die "نه nginx پیدا شد نه apache. اگر سرور وب‌سرور ندارد از deploy/deploy.sh استفاده کنید."
fi

# ------------------------------------------------------------------- داکر
info "بررسی داکر"
if ! command -v docker >/dev/null 2>&1; then
  info "نصب داکر"
  curl -fsSL https://get.docker.com | sh
fi
docker compose version >/dev/null 2>&1 || die "افزونه‌ی docker compose پیدا نشد."

# ------------------------------------------------------------------- پورت
info "انتخاب پورت آزاد برای برنامه"
port_busy() { ss -ltn "sport = :$1" 2>/dev/null | grep -q LISTEN; }
while port_busy "$APP_PORT"; do
  echo "    پورت $APP_PORT مشغول است؛ یکی بالاتر امتحان می‌شود."
  APP_PORT=$((APP_PORT + 1))
  [[ $APP_PORT -lt 3100 ]] || die "پورت آزادی پیدا نشد."
done
echo "    پورت برنامه: 127.0.0.1:$APP_PORT"

# ------------------------------------------------------------- اجرای برنامه
info "ساخت و اجرای برنامه (بدون گرفتن پورت ۸۰ و ۴۴۳)"
cd "$REPO_DIR/deploy"
cat > .env <<ENV
APP_PORT=$APP_PORT
MAX_IMAGE_BYTES=${MAX_IMAGE_BYTES:-8388608}
ENV
docker compose -f docker-compose.app-only.yml up -d --build

info "انتظار برای آماده شدن برنامه"
ready=0
for _ in $(seq 1 30); do
  if curl -fsS "http://127.0.0.1:$APP_PORT/api/health" >/dev/null 2>&1; then
    ready=1
    break
  fi
  sleep 2
done
[[ $ready -eq 1 ]] || die "برنامه بالا نیامد. لاگ: docker compose -f deploy/docker-compose.app-only.yml logs"
echo "    برنامه روی 127.0.0.1:$APP_PORT بالا آمد."

if [[ "${APP_ONLY:-0}" == "1" ]]; then
  echo
  echo "✅ برنامه اجرا شد. حالا vhost را دستی تنظیم کنید (بالا توضیح داده شد)."
  exit 0
fi

# -------------------------------------------------------------- vhost nginx
AVAILABLE=/etc/nginx/sites-available
ENABLED=/etc/nginx/sites-enabled
[[ -d "$AVAILABLE" ]] || { AVAILABLE=/etc/nginx/conf.d; ENABLED=""; }
VHOST="$AVAILABLE/$DOMAIN.conf"

info "ساخت بلوک سرور برای $DOMAIN"
if [[ -e "$VHOST" ]]; then
  die "فایل $VHOST از قبل وجود دارد. برای اینکه چیزی از سایت‌های دیگر خراب نشود، متوقف شدم."
fi

sed -e "s/__DOMAIN__/$DOMAIN/g" -e "s/__APP_PORT__/$APP_PORT/g" \
  "$REPO_DIR/deploy/nginx-vhost.conf.template" > "$VHOST"
[[ -z "$ENABLED" ]] || ln -sf "$VHOST" "$ENABLED/$DOMAIN.conf"

info "تست کانفیگ nginx پیش از ریلود"
nginx -t || {
  rm -f "$VHOST" "${ENABLED:+$ENABLED/$DOMAIN.conf}"
  die "کانفیگ nginx تست نشد؛ فایل تازه حذف شد و چیزی تغییر نکرد."
}
systemctl reload nginx
echo "    nginx ریلود شد (سایت‌های دیگر قطع نشدند)."

# --------------------------------------------------------------------- TLS
info "گرفتن گواهی HTTPS برای $DOMAIN"
if ! command -v certbot >/dev/null 2>&1; then
  apt-get update -qq && apt-get install -y -qq certbot python3-certbot-nginx
fi

CERTBOT_ARGS=(--nginx -d "$DOMAIN" -d "www.$DOMAIN" --redirect --non-interactive --agree-tos)
if [[ -n "$EMAIL" ]]; then
  CERTBOT_ARGS+=(-m "$EMAIL")
else
  CERTBOT_ARGS+=(--register-unsafely-without-email)
fi

if certbot "${CERTBOT_ARGS[@]}"; then
  SCHEME=https
else
  SCHEME=http
  echo "    هشدار: گرفتن گواهی ناموفق بود (معمولاً یعنی رکورد A هنوز به این سرور اشاره نمی‌کند)."
  echo "    بعد از درست شدن DNS این را اجرا کنید: certbot --nginx -d $DOMAIN -d www.$DOMAIN --redirect"
fi

cat <<DONE

✅ تمام شد.

   پیام‌رسان:   $SCHEME://$DOMAIN
   پنل مدیریت:  $SCHEME://$DOMAIN/admin

نخستین حسابی که ثبت‌نام کند خودکار مدیر می‌شود — همین حالا بسازیدش.

سایت‌های دیگر دست‌نخورده‌اند؛ تنها فایل اضافه‌شده: $VHOST

دستورهای مفید:
   docker compose -f deploy/docker-compose.app-only.yml logs -f    لاگ برنامه
   docker compose -f deploy/docker-compose.app-only.yml restart    ری‌استارت
   bash deploy/backup.sh                                           پشتیبان‌گیری
DONE
