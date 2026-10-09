#!/usr/bin/env bash
# راه‌اندازی 9chat بدون داکر (Node + systemd).
#
# برای سرورهایی که به Docker Hub دسترسی ندارند. مثل deploy-vhost.sh محافظه‌کار است:
# پورت ۸۰ و ۴۴۳ را نمی‌گیرد و به کانفیگ سایت‌های دیگر دست نمی‌زند.
#
#   sudo bash deploy/deploy-native.sh 9chat.ir you@mail.com     # برنامه + vhost + HTTPS
#   sudo APP_ONLY=1 bash deploy/deploy-native.sh 9chat.ir       # فقط برنامه (دامنه هنوز آماده نیست)
set -euo pipefail

DOMAIN="${1:-}"
EMAIL="${2:-}"
APP_PORT_FROM_ENV="${APP_PORT:-}"
APP_PORT="${APP_PORT:-3000}"
APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SERVICE_USER="${SERVICE_USER:-messenger}"
APP_DATA="${APP_DATA:-/var/lib/9chat}"
SERVICE_NAME="9chat"
UNIT_FILE="/etc/systemd/system/9chat.service"

die() { echo "خطا: $*" >&2; exit 1; }
info() { echo "==> $*"; }

[[ -n "$DOMAIN" ]] || die "کاربرد: sudo bash deploy/deploy-native.sh <دامنه> [ایمیل]"
[[ $EUID -eq 0 ]] || die "این اسکریپت را با sudo اجرا کنید."

# ------------------------------------------------------------------ Node
# برنامه به node:sqlite نیاز دارد که از Node 22.5 به بعد هست. اگر روی سرور چند
# نسخه‌ی Node باشد، باید همانی را پیدا و در سرویس پین کنیم که شرط را دارد —
# وگرنه systemd ممکن است نسخه‌ی قدیمی‌تر PATH را اجرا کند.
NODE_BIN=""

pick_node() {
  local candidate
  for candidate in $(type -a -P node 2>/dev/null) /usr/bin/node /usr/local/bin/node; do
    [[ -x "$candidate" ]] || continue
    if "$candidate" -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 22 ? 0 : 1)' 2>/dev/null; then
      NODE_BIN="$candidate"
      return 0
    fi
  done
  return 1
}

info "بررسی Node.js"
if pick_node; then
  echo "    Node $("$NODE_BIN" -v) در $NODE_BIN"
else
  info "نصب Node.js 22"
  apt-get install -y nodejs >/dev/null 2>&1 || true
  if ! pick_node; then
    curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
    apt-get install -y nodejs
  fi
  pick_node || die "نصب Node ناموفق بود؛ نسخه‌ی ۲۲ یا بالاتر لازم است."
  echo "    Node $("$NODE_BIN" -v) نصب شد در $NODE_BIN"
fi

# بررسی اینکه همین باینری واقعاً node:sqlite دارد (شرط اجرای برنامه)
"$NODE_BIN" -e 'require("node:sqlite")' 2>/dev/null ||
  die "این نسخه‌ی Node ماژول node:sqlite را ندارد: $("$NODE_BIN" -v)"


# ------------------------------------------------------- کاربر و پوشه‌ی داده
info "ساخت کاربر سرویس و پوشه‌ی داده"
id -u "$SERVICE_USER" >/dev/null 2>&1 ||
  useradd --system --home-dir "$APP_DATA" --shell /usr/sbin/nologin "$SERVICE_USER"
mkdir -p "$APP_DATA/uploads"
chown -R "$SERVICE_USER:$SERVICE_USER" "$APP_DATA"
chmod 750 "$APP_DATA"

# ----------------------------------------------------------- وابستگی‌ها
info "نصب وابستگی‌های برنامه"
cd "$APP_DIR"
PATH="$(dirname "$NODE_BIN"):$PATH"
npm ci --omit=dev --no-audit --no-fund || npm install --omit=dev --no-audit --no-fund ||
  die "نصب وابستگی‌ها ناموفق بود (دسترسی به registry.npmjs.org را چک کنید)."

# ------------------------------------------------------------------ پورت
# اگر سرویس از قبل نصب شده، همان پورتش را نگه می‌داریم. وگرنه هر بار اجرای
# دوباره‌ی اسکریپت، پورت خودِ سرویس را «مشغول» می‌بیند و یکی جلوتر می‌رود —
# که باعث می‌شود بلوک nginx به پورت قدیمی اشاره کند و سایت بالا نیاید.
EXISTING_PORT="$(sed -n 's/^Environment=PORT=//p' "$UNIT_FILE" 2>/dev/null | head -1)"
port_busy() { ss -ltn "sport = :$1" 2>/dev/null | grep -q LISTEN; }

if [[ -z "$APP_PORT_FROM_ENV" && -n "$EXISTING_PORT" ]]; then
  APP_PORT="$EXISTING_PORT"
  info "پورت سرویس موجود حفظ شد: 127.0.0.1:$APP_PORT"
else
  info "انتخاب پورت آزاد"
  systemctl stop "$SERVICE_NAME" 2>/dev/null || true   # تا پورت خودش را مشغول نبیند
  while port_busy "$APP_PORT"; do
    echo "    پورت $APP_PORT مشغول است؛ بعدی امتحان می‌شود."
    APP_PORT=$((APP_PORT + 1))
    [[ $APP_PORT -lt 3100 ]] || die "پورت آزادی پیدا نشد."
  done
  echo "    پورت برنامه: 127.0.0.1:$APP_PORT"
fi

# --------------------------------------------------------------- systemd
info "نصب سرویس systemd"
cat > "$UNIT_FILE" <<UNIT
[Unit]
Description=9chat messenger
After=network.target

[Service]
Type=simple
User=$SERVICE_USER
WorkingDirectory=$APP_DIR
Environment=NODE_ENV=production
Environment=HOST=127.0.0.1
Environment=PORT=$APP_PORT
Environment=DATA_DIR=$APP_DATA
# تنظیمات تماس صوتی (TURN) را اسکریپت deploy/setup-coturn.sh اینجا می‌نویسد.
# خط دستور با «-» شروع می‌شود تا نبودن فایل سرویس را از کار نیندازد.
EnvironmentFile=-/etc/9chat.env
ExecStart=$NODE_BIN server/index.js
Restart=always
RestartSec=5

NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=$APP_DATA

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl enable "$SERVICE_NAME" >/dev/null 2>&1
systemctl restart "$SERVICE_NAME"

info "انتظار برای بالا آمدن برنامه"
ready=0
for _ in $(seq 1 20); do
  if curl -fsS "http://127.0.0.1:$APP_PORT/api/health" >/dev/null 2>&1; then
    ready=1
    break
  fi
  sleep 1
done
if [[ $ready -ne 1 ]]; then
  journalctl -u "$SERVICE_NAME" -n 30 --no-pager || true
  die "برنامه بالا نیامد (لاگ بالا)."
fi
echo "    برنامه روی 127.0.0.1:$APP_PORT بالا آمد."

if [[ "${APP_ONLY:-0}" == "1" ]]; then
  cat <<DONE

✅ برنامه اجرا شد و با ری‌استارت سرور هم خودکار بالا می‌آید.

   تست:   curl -s http://127.0.0.1:$APP_PORT/api/health
   لاگ:   journalctl -u $SERVICE_NAME -f

وقتی دامنه فعال شد، همین اسکریپت را بدون APP_ONLY اجرا کنید تا nginx و HTTPS هم تنظیم شود:
   sudo bash deploy/deploy-native.sh $DOMAIN ${EMAIL:-you@mail.com}
DONE
  exit 0
fi

# ----------------------------------------------------------- vhost nginx
command -v nginx >/dev/null 2>&1 || die "nginx پیدا نشد. با APP_ONLY=1 اجرا کنید یا nginx نصب کنید."

AVAILABLE=/etc/nginx/sites-available
ENABLED=/etc/nginx/sites-enabled
[[ -d "$AVAILABLE" ]] || { AVAILABLE=/etc/nginx/conf.d; ENABLED=""; }
VHOST="$AVAILABLE/$DOMAIN.conf"

info "ساخت بلوک سرور برای $DOMAIN"
if [[ -e "$VHOST" ]]; then
  if grep -q "proxy_pass http://127.0.0.1:$APP_PORT;" "$VHOST"; then
    echo "    $VHOST از قبل هست و به پورت درست اشاره می‌کند."
  else
    info "اصلاح پورت در $VHOST"
    sed -i -E "s|proxy_pass http://127\.0\.0\.1:[0-9]+;|proxy_pass http://127.0.0.1:$APP_PORT;|" "$VHOST"
    nginx -t && systemctl reload nginx
  fi
else
  sed -e "s/__DOMAIN__/$DOMAIN/g" -e "s/__APP_PORT__/$APP_PORT/g" \
    "$APP_DIR/deploy/nginx-vhost.conf.template" > "$VHOST"
  [[ -z "$ENABLED" ]] || ln -sf "$VHOST" "$ENABLED/$DOMAIN.conf"

  info "تست کانفیگ nginx پیش از ریلود"
  nginx -t || {
    rm -f "$VHOST" ${ENABLED:+"$ENABLED/$DOMAIN.conf"}
    die "کانفیگ nginx تست نشد؛ فایل تازه حذف شد و چیزی تغییر نکرد."
  }
  systemctl reload nginx
  echo "    nginx ریلود شد (سایت‌های دیگر قطع نشدند)."
fi

# ----------------------------------------------------------------- HTTPS
info "گرفتن گواهی HTTPS"
if ! command -v certbot >/dev/null 2>&1; then
  apt-get update -qq && apt-get install -y -qq certbot python3-certbot-nginx
fi

# certbot ممکن است نصب باشد ولی افزونه‌ی nginx جدا نصب نشده باشد.
if ! certbot plugins --non-interactive 2>/dev/null | grep -qi nginx; then
  info "نصب افزونه‌ی nginx برای certbot"
  apt-get update -qq
  apt-get install -y -qq python3-certbot-nginx || true
fi
HAS_NGINX_PLUGIN=0
certbot plugins --non-interactive 2>/dev/null | grep -qi nginx && HAS_NGINX_PLUGIN=1

CERTBOT_ARGS=(--nginx -d "$DOMAIN" -d "www.$DOMAIN" --redirect --non-interactive --agree-tos)
[[ -n "$EMAIL" ]] && CERTBOT_ARGS+=(-m "$EMAIL") || CERTBOT_ARGS+=(--register-unsafely-without-email)

SCHEME=http
if [[ $HAS_NGINX_PLUGIN -ne 1 ]]; then
  echo "    هشدار: افزونه‌ی nginx برای certbot نصب نشد."
  echo "    دستی: apt install -y python3-certbot-nginx"
elif certbot "${CERTBOT_ARGS[@]}"; then
  SCHEME=https
else
  echo "    هشدار: گواهی صادر نشد."
  echo "    رایج‌ترین دلیل: رکورد DNS دامنه هنوز به این سرور نرسیده است."
  echo "    بعد از آماده شدن DNS: certbot --nginx -d $DOMAIN -d www.$DOMAIN --redirect"
fi

cat <<DONE

✅ تمام شد.

   9chat:       $SCHEME://$DOMAIN
   پنل مدیریت:  $SCHEME://$DOMAIN/admin

نخستین حسابی که ثبت‌نام کند خودکار مدیر می‌شود — همین حالا بسازیدش.

   لاگ:          journalctl -u $SERVICE_NAME -f
   ری‌استارت:    systemctl restart $SERVICE_NAME
   پشتیبان‌گیری: tar czf ~/9chat-backup.tar.gz -C $APP_DATA .
DONE
