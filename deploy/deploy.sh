#!/usr/bin/env bash
# راه‌اندازی پیام‌رسان روی یک سرور تازه‌ی اوبونتو/دبیان با HTTPS خودکار.
#
#   sudo bash deploy/deploy.sh chat.example.com you@example.com
#
# اگر داکر نصب نباشد نصب می‌شود، سپس برنامه و Caddy بالا می‌آیند.
set -euo pipefail

DOMAIN="${1:-}"
EMAIL="${2:-}"
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [[ -z "$DOMAIN" ]]; then
  echo "کاربرد: sudo bash deploy/deploy.sh <دامنه> [ایمیل]" >&2
  exit 1
fi

echo "==> بررسی داکر"
if ! command -v docker >/dev/null 2>&1; then
  echo "    داکر نصب نیست؛ نصب می‌شود…"
  curl -fsSL https://get.docker.com | sh
fi

if ! docker compose version >/dev/null 2>&1; then
  echo "خطا: افزونه‌ی docker compose پیدا نشد. آن را نصب کنید و دوباره اجرا کنید." >&2
  exit 1
fi

echo "==> بررسی اینکه دامنه به این سرور اشاره می‌کند"
SERVER_IP="$(curl -fsS --max-time 10 https://api.ipify.org || echo '')"
DOMAIN_IP="$(getent ahostsv4 "$DOMAIN" | awk 'NR==1{print $1}' || echo '')"
if [[ -n "$SERVER_IP" && -n "$DOMAIN_IP" && "$SERVER_IP" != "$DOMAIN_IP" ]]; then
  echo "    هشدار: $DOMAIN به $DOMAIN_IP اشاره می‌کند ولی IP این سرور $SERVER_IP است."
  echo "    تا وقتی رکورد A درست نشود، Let's Encrypt گواهی صادر نمی‌کند."
  read -r -p "    ادامه می‌دهید؟ [y/N] " answer
  [[ "$answer" == "y" || "$answer" == "Y" ]] || exit 1
fi

echo "==> نوشتن فایل .env"
cat > "$REPO_DIR/deploy/.env" <<ENV
DOMAIN=$DOMAIN
TLS_EMAIL=$EMAIL
MAX_IMAGE_BYTES=8388608
ENV

echo "==> ساخت و اجرای سرویس‌ها"
cd "$REPO_DIR/deploy"
docker compose up -d --build

echo "==> انتظار برای آماده شدن برنامه"
for _ in $(seq 1 30); do
  if docker compose exec -T app wget -qO- http://127.0.0.1:3000/api/health >/dev/null 2>&1; then
    echo "    برنامه بالا آمد."
    break
  fi
  sleep 2
done

cat <<DONE

✅ آماده است.

   پیام‌رسان:   https://$DOMAIN
   پنل مدیریت:  https://$DOMAIN/admin

نخستین حسابی که ثبت‌نام کند خودکار مدیر می‌شود — همین حالا بسازیدش.
(گرفتن گواهی HTTPS ممکن است تا یک دقیقه طول بکشد.)

دستورهای مفید:
   docker compose -f deploy/docker-compose.yml logs -f        نمایش لاگ‌ها
   docker compose -f deploy/docker-compose.yml restart        راه‌اندازی دوباره
   bash deploy/backup.sh                                      پشتیبان‌گیری از داده‌ها
DONE
