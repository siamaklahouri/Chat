#!/usr/bin/env bash
#
# گواهی پشتیبان برای وقتی اینترنت جهانی قطع است.
#
# مشکل: گواهی Let's Encrypt هر ۹۰ روز باید تمدید شود و تمدید به سرورهای خارج
# نیاز دارد. اگر گواهی منقضی شود، فقط اخطار مرورگر نمی‌گیریم — میکروفون،
# دوربین و سرویس‌ورکر هم از کار می‌افتند، چون مرورگر آن‌ها را فقط روی
# «مبدأ امن» می‌دهد. یعنی پیام صوتی و تماس اولین چیزهایی‌اند که می‌میرند.
#
# راه‌حل: یک مرجع صدور (CA) ده‌ساله‌ی خودمان روی همین سرور می‌سازیم و یک گواهی
# ده‌ساله برای دامنه و آی‌پی صادر می‌کنیم. گواهیِ CA (که عمومی است) داخل اپ
# اندروید جا می‌گیرد، پس اپ آن را معتبر می‌شناسد. کلید خصوصیِ CA هیچ‌وقت از
# این سرور بیرون نمی‌رود.
#
# Let's Encrypt دست‌نخورده می‌ماند و گواهیِ اصلی باقی است؛ این فقط پشتیبان است
# و وقتی به کار می‌افتد که آن یکی منقضی شده باشد.
#
#   sudo bash deploy/setup-offline-tls.sh 9chat.ir [آی‌پی]

set -euo pipefail

DOMAIN="${1:-}"
PUBLIC_IP="${2:-}"
TLS_DIR="${TLS_DIR:-/etc/9chat-tls}"
NGINX_VHOST="${NGINX_VHOST:-/etc/nginx/sites-available/$DOMAIN.conf}"
GUARD_BIN="${GUARD_BIN:-/usr/local/bin/9chat-cert-guard}"
CRON_FILE="${CRON_FILE:-/etc/cron.d/9chat-cert-guard}"
DAYS="${DAYS:-3650}"

info() { printf '\n\033[1;34m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[!]\033[0m %s\n' "$*"; }
die() { printf '\033[1;31m[x]\033[0m %s\n' "$*" >&2; exit 1; }
on_error() {
  local code=$?
  printf '\033[1;31m[x]\033[0m اسکریپت در خط %s با کد %s متوقف شد.\n' "$1" "$code" >&2
  exit "$code"
}
trap 'on_error $LINENO' ERR

[[ $EUID -eq 0 ]] || die "این اسکریپت را با sudo اجرا کنید."
[[ -n "$DOMAIN" ]] || die "کاربرد: sudo bash deploy/setup-offline-tls.sh <دامنه> [آی‌پی]"
command -v openssl >/dev/null 2>&1 || die "openssl نصب نیست."

if [[ -z "$PUBLIC_IP" ]]; then
  PUBLIC_IP="$(ip -4 route get 1.1.1.1 2>/dev/null |
    awk '{for (i = 1; i <= NF; i++) if ($i == "src") { print $(i + 1); exit } }' || true)"
fi
[[ -n "$PUBLIC_IP" ]] || die "آی‌پی سرور پیدا نشد؛ آن را به‌عنوان آرگومان دوم بدهید."

mkdir -p "$TLS_DIR"
chmod 700 "$TLS_DIR"

# ------------------------------------------------------------------ CA
if [[ -f "$TLS_DIR/ca.crt" && -f "$TLS_DIR/ca.key" ]]; then
  info "CA از قبل هست؛ دوباره ساخته نمی‌شود"
  info "(اگر CA را عوض کنیم، اپ‌های نصب‌شده دیگر سرور را نمی‌شناسند.)"
else
  info "ساخت مرجع صدور گواهی (CA) — کلیدش از این سرور بیرون نمی‌رود"
  openssl req -x509 -newkey rsa:4096 -sha256 -days "$DAYS" -nodes \
    -keyout "$TLS_DIR/ca.key" -out "$TLS_DIR/ca.crt" \
    -subj "/CN=9chat Offline CA/O=9chat" \
    -addext "basicConstraints=critical,CA:TRUE,pathlen:0" \
    -addext "keyUsage=critical,keyCertSign,cRLSign" 2>/dev/null
fi

# -------------------------------------------------------- گواهی سرور
info "صدور گواهی سرور برای $DOMAIN و $PUBLIC_IP"
openssl req -newkey rsa:2048 -sha256 -nodes \
  -keyout "$TLS_DIR/server.key" -out "$TLS_DIR/server.csr" \
  -subj "/CN=$DOMAIN" 2>/dev/null

# آی‌پی هم داخل گواهی می‌آید: اگر DNS از کار بیفتد، اپ می‌تواند مستقیم با
# آی‌پی وصل شود و گواهی باز هم معتبر باشد.
cat > "$TLS_DIR/server.ext" <<EXT
basicConstraints=CA:FALSE
keyUsage=critical,digitalSignature,keyEncipherment
extendedKeyUsage=serverAuth
subjectAltName=DNS:$DOMAIN,DNS:www.$DOMAIN,IP:$PUBLIC_IP
EXT

openssl x509 -req -in "$TLS_DIR/server.csr" -CA "$TLS_DIR/ca.crt" -CAkey "$TLS_DIR/ca.key" \
  -CAcreateserial -out "$TLS_DIR/server.crt" -days "$DAYS" -sha256 \
  -extfile "$TLS_DIR/server.ext" 2>/dev/null

chmod 600 "$TLS_DIR"/*.key
chmod 644 "$TLS_DIR/ca.crt" "$TLS_DIR/server.crt"
rm -f "$TLS_DIR/server.csr"

# ------------------------------------------------------- نگهبان گواهی
info "نصب نگهبان گواهی در $GUARD_BIN"
cat > "$GUARD_BIN" <<'GUARD'
#!/usr/bin/env bash
#
# روزی یک بار نگاه می‌کند گواهی Let's Encrypt هنوز معتبر است یا نه:
#   معتبر   → همان را روی nginx نگه می‌دارد
#   منقضی  → به گواهی پشتیبانِ محلی سوئیچ می‌کند
# سایت با گواهی منقضی به‌هرحال خراب است، پس سوئیچ فقط اوضاع را بهتر می‌کند:
# اپ اندروید کامل کار می‌کند و مرورگر به‌جای خطای محض، اخطار می‌دهد.
set -euo pipefail

DOMAIN="${1:?دامنه لازم است}"
TLS_DIR="${TLS_DIR:-/etc/9chat-tls}"
VHOST="${NGINX_VHOST:-/etc/nginx/sites-available/$DOMAIN.conf}"
LE_CRT="${LE_CRT:-/etc/letsencrypt/live/$DOMAIN/fullchain.pem}"
LE_KEY="${LE_KEY:-/etc/letsencrypt/live/$DOMAIN/privkey.pem}"
LOG="${GUARD_LOG:-/var/log/9chat-cert-guard.log}"

say() { printf '%s %s\n' "$(date -Is)" "$*" >> "$LOG"; }

[[ -f "$VHOST" ]] || { say "فایل $VHOST نیست؛ کاری نشد"; exit 0; }

# گواهی Let's Encrypt هنوز دست‌کم یک روز اعتبار دارد؟
le_ok=0
if [[ -f "$LE_CRT" ]] && openssl x509 -checkend 86400 -noout -in "$LE_CRT" >/dev/null 2>&1; then
  le_ok=1
fi

if [[ $le_ok -eq 1 ]]; then
  want_crt="$LE_CRT"; want_key="$LE_KEY"; label="Let's Encrypt"
else
  want_crt="$TLS_DIR/server.crt"; want_key="$TLS_DIR/server.key"; label="گواهی پشتیبان محلی"
fi
[[ -f "$want_crt" && -f "$want_key" ]] || { say "گواهی $label ناقص است؛ دست نزدیم"; exit 0; }

current="$(sed -n 's/^[[:space:]]*ssl_certificate[[:space:]]\+\(.*\);/\1/p' "$VHOST" | head -1 || true)"
[[ "$current" == "$want_crt" ]] && exit 0   # همین حالا درست است

cp "$VHOST" "$VHOST.cert-guard-backup"
sed -i "s#^\([[:space:]]*\)ssl_certificate[[:space:]].*#\1ssl_certificate $want_crt;#" "$VHOST"
sed -i "s#^\([[:space:]]*\)ssl_certificate_key[[:space:]].*#\1ssl_certificate_key $want_key;#" "$VHOST"

if nginx -t >/dev/null 2>&1; then
  systemctl reload nginx
  say "سوئیچ به $label انجام شد"
else
  mv "$VHOST.cert-guard-backup" "$VHOST"
  say "خطا: پیکربندی nginx نامعتبر شد؛ برگرداندیم"
  exit 1
fi
GUARD
chmod 755 "$GUARD_BIN"

printf '# نگهبان گواهی 9chat — ساخته‌شده توسط deploy/setup-offline-tls.sh\n%s\n' \
  "17 4 * * * root $GUARD_BIN $DOMAIN" > "$CRON_FILE"
chmod 644 "$CRON_FILE"

# ------------------------------------------------------------- گزارش
info "آزمودن گواهیِ ساخته‌شده"
openssl verify -CAfile "$TLS_DIR/ca.crt" "$TLS_DIR/server.crt"
openssl x509 -in "$TLS_DIR/server.crt" -noout -enddate -ext subjectAltName | sed 's/^/   /'

cat <<DONE

  ✅ گواهی پشتیبان آماده است.

   تا وقتی Let's Encrypt معتبر است، هیچ‌چیز عوض نمی‌شود. نگهبان هر شب ساعت
   ۴:۱۷ بررسی می‌کند و فقط اگر آن گواهی منقضی شده بود، به این پشتیبان سوئیچ
   می‌کند — و وقتی دوباره تمدید شد، خودش برمی‌گردد.

   آزمودن همین حالا:  sudo $GUARD_BIN $DOMAIN
   گزارش کارهایش:     /var/log/9chat-cert-guard.log

  ────────────────────────────────────────────────────────────────────
   حالا متن زیر را کامل کپی کنید و بفرستید تا داخل اپ اندروید جاسازی شود.
   این «گواهیِ عمومی» است، نه کلید خصوصی — لو رفتنش خطری ندارد و قرار است
   داخل هر نسخه‌ی نصب‌شده‌ی برنامه باشد.
  ────────────────────────────────────────────────────────────────────

DONE
cat "$TLS_DIR/ca.crt"
echo
