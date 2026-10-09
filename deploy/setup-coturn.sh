#!/usr/bin/env bash
#
# نصب و تنظیم coturn برای تماس صوتی 9chat.
#
# coturn دو کار می‌کند: STUN (به هر طرف می‌گوید نشانی عمومی‌اش چیست) و TURN
# (اگر دو طرف نتوانستند مستقیم به هم وصل شوند، صدا را رله می‌کند). روی اینترنت
# ایران و شبکه‌های موبایل، بخش زیادی از تماس‌ها به TURN نیاز دارند.
#
# کاربرد:  sudo bash deploy/setup-coturn.sh 9chat.ir
#
# این اسکریپت فقط coturn و فایل محیطی خودِ 9chat را دست می‌زند. به nginx،
# گواهی‌ها و سایت‌های دیگر این سرور هیچ کاری ندارد.

set -euo pipefail

DOMAIN="${1:-}"
PUBLIC_IP="${2:-}"
SERVICE_NAME="9chat"
# مسیرها قابل جایگزینی‌اند تا بشود اسکریپت را بدون دست زدن به سیستم آزمود.
ENV_FILE="${ENV_FILE:-/etc/9chat.env}"
TURN_CONF="${TURN_CONF:-/etc/turnserver.conf}"
COTURN_DEFAULT="${COTURN_DEFAULT:-/etc/default/coturn}"
UNIT_FILE="${UNIT_FILE:-/etc/systemd/system/$SERVICE_NAME.service}"
MIN_PORT="${MIN_PORT:-49160}"
MAX_PORT="${MAX_PORT:-49260}"
# سقف پهنای باند هر تماس، بر حسب بایت بر ثانیه (نه بیت — نام گزینه گمراه‌کننده
# است). ۲۵۰ کیلوبایت ≈ ۲ مگابیت، برای تماس تصویری ۴۸۰p با جای کافی.
MAX_BPS="${MAX_BPS:-250000}"

info() { printf '\n\033[1;34m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[!]\033[0m %s\n' "$*"; }
die() { printf '\033[1;31m[x]\033[0m %s\n' "$*" >&2; exit 1; }

# بدون این تله، هر دستوری که زیر `set -e` شکست بخورد اسکریپت را بی‌هیچ پیامی
# تمام می‌کند و آدم فکر می‌کند کار انجام شده است.
on_error() {
  local code=$?
  printf '\033[1;31m[x]\033[0m اسکریپت در خط %s با کد %s متوقف شد.\n' "$1" "$code" >&2
  exit "$code"
}
trap 'on_error $LINENO' ERR

[[ $EUID -eq 0 ]] || die "این اسکریپت را با sudo اجرا کنید."
[[ -n "$DOMAIN" ]] || die "کاربرد: sudo bash deploy/setup-coturn.sh <دامنه> [آی‌پی عمومی]"

# ----------------------------------------------------------------- نصب
if command -v turnserver >/dev/null 2>&1; then
  info "coturn از قبل نصب است"
else
  info "نصب coturn"
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq
  apt-get install -y -qq coturn >/dev/null
fi

# ----------------------------------------------- آی‌پی عمومی و NAT
# نشانیِ کارت شبکه‌ای که مسیر پیش‌فرض از آن می‌رود — نه نخستین نشانی
# `hostname -I`، که روی سروری با داکر می‌تواند پل داکر (172.17.0.1) باشد.
LOCAL_IP="$(ip -4 route get 1.1.1.1 2>/dev/null |
  awk '{for (i = 1; i <= NF; i++) if ($i == "src") { print $(i + 1); exit } }' || true)"
[[ -n "$LOCAL_IP" ]] || LOCAL_IP="$(hostname -I | awk '{print $1}')"
[[ -n "$LOCAL_IP" ]] || die "نشانی شبکه‌ی سرور پیدا نشد."

if [[ -z "$PUBLIC_IP" ]]; then
  PUBLIC_IP="$(curl -4 -s --max-time 8 https://api.ipify.org || true)"
fi
[[ -n "$PUBLIC_IP" ]] || PUBLIC_IP="$LOCAL_IP"

EXTERNAL_LINE=""
if [[ "$PUBLIC_IP" != "$LOCAL_IP" ]]; then
  # سرور پشت NAT است: coturn باید نشانی عمومی را در کاندیداها اعلام کند.
  EXTERNAL_LINE="external-ip=$PUBLIC_IP/$LOCAL_IP"
  info "حالت NAT شناسایی شد: $PUBLIC_IP → $LOCAL_IP"
else
  EXTERNAL_LINE="external-ip=$PUBLIC_IP"
fi

# ------------------------------------------------------------ راز مشترک
# اگر قبلاً رازی ساخته شده، همان می‌ماند تا تماس‌های در جریان قطع نشوند.
# با لوله ننویسید: اگر فایل نباشد sed کد ۲ برمی‌گرداند و pipefail کل اسکریپت را
# بی‌صدا تمام می‌کند — دقیقاً همان چیزی که بار اول اتفاق افتاد.
TURN_SECRET=""
if [[ -f "$ENV_FILE" ]]; then
  TURN_SECRET="$(awk -F= '/^TURN_SECRET=/ { print $2; exit }' "$ENV_FILE" || true)"
fi
if [[ -z "$TURN_SECRET" ]]; then
  TURN_SECRET="$(openssl rand -hex 32)"
  info "راز مشترک TURN ساخته شد"
else
  info "راز مشترک موجود استفاده می‌شود"
fi

# --------------------------------------------------------- turnserver.conf
info "نوشتن $TURN_CONF"
if [[ -f "$TURN_CONF" && ! -f "$TURN_CONF.9chat-backup" ]]; then
  cp "$TURN_CONF" "$TURN_CONF.9chat-backup"
fi

cat > "$TURN_CONF" <<CONF
# ساخته‌شده توسط deploy/setup-coturn.sh برای 9chat — دست‌نوشته‌ها بازنویسی می‌شوند.

listening-port=3478
# فقط روی کارت شبکه‌ی عمومی؛ نه 127.0.0.1 و نه پل داکر.
listening-ip=$LOCAL_IP
relay-ip=$LOCAL_IP
$EXTERNAL_LINE
realm=$DOMAIN
server-name=$DOMAIN

# اعتبارنامه‌ی موقت: برنامه با همین راز، نام کاربری و رمز یک‌ساعته می‌سازد.
# هیچ کاربر ثابتی روی coturn تعریف نمی‌شود، پس چیزی برای لو رفتن نیست.
use-auth-secret
static-auth-secret=$TURN_SECRET

fingerprint
no-cli
# تماس صوتی از همان وب‌سوکت امنِ برنامه هماهنگ می‌شود؛ خود رله رمزنگاری SRTP دارد.
no-tls
no-dtls

# بازه‌ی پورت رله؛ هر تماس چند پورت می‌گیرد.
min-port=$MIN_PORT
max-port=$MAX_PORT

# سهمیه‌ها تا یک کاربر نتواند پهنای باند سرور را ببلعد.
user-quota=12
total-quota=100
max-bps=$MAX_BPS

# --- سخت‌سازی: TURN نباید پلی به شبکه‌ی داخلی همین سرور شود ---
# بدون این خطوط، هر کسی با یک اعتبارنامه‌ی معتبر می‌توانست از TURN برای رسیدن
# به سرویس‌های روی 127.0.0.1 یا شبکه‌ی خصوصی استفاده کند.
no-multicast-peers
denied-peer-ip=0.0.0.0-0.255.255.255
denied-peer-ip=10.0.0.0-10.255.255.255
denied-peer-ip=100.64.0.0-100.127.255.255
denied-peer-ip=127.0.0.0-127.255.255.255
denied-peer-ip=169.254.0.0-169.254.255.255
denied-peer-ip=172.16.0.0-172.31.255.255
denied-peer-ip=192.0.0.0-192.0.0.255
denied-peer-ip=192.0.2.0-192.0.2.255
denied-peer-ip=192.88.99.0-192.88.99.255
denied-peer-ip=192.168.0.0-192.168.255.255
denied-peer-ip=198.18.0.0-198.19.255.255
denied-peer-ip=198.51.100.0-198.51.100.255
denied-peer-ip=203.0.113.0-203.0.113.255
denied-peer-ip=240.0.0.0-255.255.255.255
denied-peer-ip=::1
denied-peer-ip=fc00::-fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff
denied-peer-ip=fe80::-febf:ffff:ffff:ffff:ffff:ffff:ffff:ffff

syslog
CONF
chmod 640 "$TURN_CONF"
chown root:root "$TURN_CONF"

# در اوبونتو سرویس تا این پرچم روشن نشود بالا نمی‌آید.
if [[ -f "$COTURN_DEFAULT" ]]; then
  if grep -q '^#*TURNSERVER_ENABLED' "$COTURN_DEFAULT"; then
    sed -i 's/^#*TURNSERVER_ENABLED=.*/TURNSERVER_ENABLED=1/' "$COTURN_DEFAULT"
  else
    echo 'TURNSERVER_ENABLED=1' >> "$COTURN_DEFAULT"
  fi
fi

# ------------------------------------------------------- فایل محیطی برنامه
info "نوشتن $ENV_FILE"
cat > "$ENV_FILE" <<ENV
# تنظیمات تماس صوتی 9chat — ساخته‌شده توسط deploy/setup-coturn.sh
TURN_HOST=$DOMAIN
TURN_SECRET=$TURN_SECRET
TURN_TTL_SECONDS=3600
ENV
chmod 600 "$ENV_FILE"
chown root:root "$ENV_FILE"

# این خط در deploy-native.sh هست، ولی اگر سرویس قبلاً نصب شده باشد باید اضافه شود.
if [[ -f "$UNIT_FILE" ]] && ! grep -q "EnvironmentFile=-$ENV_FILE" "$UNIT_FILE"; then
  sed -i "/^ExecStart=/i EnvironmentFile=-$ENV_FILE" "$UNIT_FILE"
  info "EnvironmentFile به سرویس $SERVICE_NAME اضافه شد"
fi

# ----------------------------------------------------------------- فایروال
if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q '^Status: active'; then
  info "باز کردن پورت‌ها در ufw"
  ufw allow 3478/udp >/dev/null
  ufw allow 3478/tcp >/dev/null
  ufw allow "$MIN_PORT:$MAX_PORT/udp" >/dev/null
else
  # فایروال خاموش است؛ روشن کردنش می‌تواند دسترسی SSH و سایت‌های دیگر این سرور
  # را قطع کند، پس دست نمی‌زنیم و فقط یادآوری می‌کنیم.
  warn "ufw فعال نیست؛ اگر فایروال دیگری دارید این پورت‌ها را باز کنید:"
  warn "  3478/udp, 3478/tcp, $MIN_PORT-$MAX_PORT/udp"
fi

# --------------------------------------------------------------- راه‌اندازی
info "راه‌اندازی سرویس‌ها"
systemctl daemon-reload
systemctl enable coturn >/dev/null 2>&1 || true
systemctl restart coturn
systemctl restart "$SERVICE_NAME" 2>/dev/null || warn "سرویس $SERVICE_NAME پیدا نشد؛ خودتان ری‌استارت کنید."

sleep 2
if systemctl is-active --quiet coturn; then
  info "coturn فعال است."
else
  warn "coturn بالا نیامد. لاگ:"
  journalctl -u coturn -n 20 --no-pager || true
  exit 1
fi

cat <<DONE

  ✅ تماس صوتی آماده است.

   سرور TURN:   $DOMAIN:3478  (UDP و TCP)
   بازه‌ی رله:   $MIN_PORT-$MAX_PORT/udp
   سقف هر تماس: $MAX_BPS بایت بر ثانیه
   تنظیمات:     $TURN_CONF
   راز مشترک:   $ENV_FILE  (فقط root می‌خواندش)

   اگر فایروالِ پنل هاست (نه ufw) دارید، همین پورت‌ها را آنجا هم باز کنید؛
   وگرنه تماس زنگ می‌خورد ولی صدا برقرار نمی‌شود.

   آزمودن: در دو مرورگر وارد شوید و از سربرگ گفتگوی دونفره دکمه‌ی تماس را بزنید.
   لاگ:    journalctl -u coturn -f

DONE
