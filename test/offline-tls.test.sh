#!/usr/bin/env bash
#
# اسکریپت گواهی پشتیبان را در یک جعبه‌ی شنی اجرا می‌کند و مهم‌تر از آن،
# رفتار «نگهبان گواهی» را با یک گواهی منقضی و یک گواهی سالم می‌سنجد — چیزی
# که در عمل فقط یک بار و در بدترین لحظه پیش می‌آید.
#
#   bash test/offline-tls.test.sh

set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SB="$(mktemp -d)"
trap 'rm -rf "$SB"' EXIT
mkdir -p "$SB/bin" "$SB/nginx" "$SB/le" "$SB/cron"

fail() { printf '✗ %s\n' "$*" >&2; [[ -f "$SB/out.log" ]] && sed 's/^/    /' "$SB/out.log" >&2; exit 1; }
ok() { printf '✓ %s\n' "$*"; }

# nginx و systemctl قلابی، تا چیزی روی این ماشین بارگذاری مجدد نشود
cat > "$SB/bin/nginx" <<'N'
#!/bin/sh
# «پیکربندی معتبر است» مگر فایل مارکر ساخته شده باشد
[ -f "$SB_INVALID" ] && exit 1
exit 0
N
printf '#!/bin/sh\nexit 0\n' > "$SB/bin/systemctl"
chmod +x "$SB/bin/"*

VHOST="$SB/nginx/9chat.ir.conf"
cat > "$VHOST" <<'V'
server {
    listen 443 ssl;
    server_name 9chat.ir;
    ssl_certificate /etc/letsencrypt/live/9chat.ir/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/9chat.ir/privkey.pem;
}
V

export SB_INVALID="$SB/make-nginx-fail"

run_setup() {
  PATH="$SB/bin:$PATH" TLS_DIR="$SB/tls" NGINX_VHOST="$VHOST" \
    GUARD_BIN="$SB/bin/9chat-cert-guard" CRON_FILE="$SB/cron/guard" \
    bash "$REPO/deploy/setup-offline-tls.sh" 9chat.ir 203.0.113.9 > "$SB/out.log" 2>&1
}

guard() {
  PATH="$SB/bin:$PATH" TLS_DIR="$SB/tls" NGINX_VHOST="$VHOST" \
    LE_CRT="$SB/le/fullchain.pem" LE_KEY="$SB/le/privkey.pem" \
    GUARD_LOG="$SB/guard.log" \
    bash "$SB/bin/9chat-cert-guard" 9chat.ir
}

cert_in_vhost() { sed -n 's/^[[:space:]]*ssl_certificate[[:space:]]\+\(.*\);/\1/p' "$VHOST" | head -1; }

# یک گواهی Let's Encrypt ساختگی با تاریخ دلخواه می‌سازد
make_le_cert() {
  openssl req -x509 -newkey rsa:2048 -sha256 -nodes -days "$1" \
    -keyout "$SB/le/privkey.pem" -out "$SB/le/fullchain.pem" \
    -subj "/CN=9chat.ir" 2>/dev/null
}

# ------------------------------------------------------------- ساخت
run_setup || fail "اسکریپت با کد خطا تمام شد"
ok "اسکریپت تا آخر رفت"

[[ -f "$SB/tls/ca.crt" && -f "$SB/tls/server.crt" ]] || fail "گواهی‌ها ساخته نشدند"
openssl verify -CAfile "$SB/tls/ca.crt" "$SB/tls/server.crt" >/dev/null 2>&1 ||
  fail "گواهی سرور با CA خودش تایید نمی‌شود"
ok "گواهی سرور با CA تایید می‌شود"

san="$(openssl x509 -in "$SB/tls/server.crt" -noout -ext subjectAltName)"
for want in 'DNS:9chat.ir' 'DNS:www.9chat.ir' 'IP Address:203.0.113.9'; do
  [[ "$san" == *"$want"* ]] || fail "SAN شامل $want نیست — $san"
done
ok "گواهی هم روی دامنه و هم روی آی‌پی معتبر است (برای وقتی DNS نباشد)"

# بیش از ۹ سال اعتبار داشته باشد
end="$(openssl x509 -in "$SB/tls/server.crt" -noout -enddate | cut -d= -f2)"
secs=$(( $(date -d "$end" +%s) - $(date +%s) ))
[[ $secs -gt 283824000 ]] || fail "اعتبار گواهی کمتر از ۹ سال است"
ok "اعتبار گواهی بیش از ۹ سال است"

[[ "$(stat -c '%a' "$SB/tls/ca.key")" == 600 ]] || fail "کلید CA مجوز ۶۰۰ ندارد"
ok "کلید خصوصی CA فقط برای root خواندنی است"

ca1="$(sha256sum "$SB/tls/ca.crt" | cut -d' ' -f1)"
run_setup || fail "اجرای دوم شکست خورد"
[[ "$(sha256sum "$SB/tls/ca.crt" | cut -d' ' -f1)" == "$ca1" ]] ||
  fail "اجرای دوم CA را عوض کرد — اپ‌های نصب‌شده دیگر سرور را نمی‌شناختند"
ok "اجرای دوباره CA را دست‌نخورده می‌گذارد"

# ------------------------------------------------------- نگهبان گواهی
make_le_cert 30
guard
[[ "$(cert_in_vhost)" == "$SB/le/fullchain.pem" ]] ||
  fail "با گواهی سالمِ Let's Encrypt نباید سوئیچ می‌کرد — الان: $(cert_in_vhost)"
ok "گواهی Let's Encrypt سالم: دست نمی‌زند"

# گواهی منقضی: باید به پشتیبان سوئیچ کند.
# (openssl 3.0 گزینه‌ی تاریخ دلخواه ندارد، ولی `-days -1` گواهیِ همین دیروز
# منقضی‌شده می‌سازد که دقیقاً همان چیزی است که می‌خواهیم.)
openssl req -newkey rsa:2048 -nodes -keyout "$SB/le/privkey.pem" \
  -out "$SB/le/expired.csr" -subj "/CN=9chat.ir" 2>/dev/null
openssl x509 -req -in "$SB/le/expired.csr" -CA "$SB/tls/ca.crt" -CAkey "$SB/tls/ca.key" \
  -out "$SB/le/fullchain.pem" -days -1 2>/dev/null
openssl x509 -checkend 86400 -noout -in "$SB/le/fullchain.pem" >/dev/null 2>&1 &&
  fail "گواهیِ آزمون باید منقضی می‌بود"
guard
[[ "$(cert_in_vhost)" == "$SB/tls/server.crt" ]] ||
  fail "با گواهی منقضی باید به پشتیبان سوئیچ می‌کرد — الان: $(cert_in_vhost)"
ok "گواهی منقضی: به پشتیبان محلی سوئیچ می‌کند"

# و وقتی تمدید شد، خودش برمی‌گردد
make_le_cert 60
guard
[[ "$(cert_in_vhost)" == "$SB/le/fullchain.pem" ]] ||
  fail "بعد از تمدید باید برمی‌گشت — الان: $(cert_in_vhost)"
ok "بعد از تمدید، خودش به Let's Encrypt برمی‌گردد"

# اگر nginx پیکربندی را نپذیرد، باید همه‌چیز را برگرداند
touch "$SB_INVALID"
rm -f "$SB/le/fullchain.pem"
before="$(cat "$VHOST")"
guard || true
[[ "$(cat "$VHOST")" == "$before" ]] ||
  fail "وقتی nginx پیکربندی را رد کرد، فایل باید دست‌نخورده برمی‌گشت"
ok "اگر nginx پیکربندی را نپذیرد، تغییر برگردانده می‌شود"

printf '\n✅ گواهی پشتیبان و نگهبانش سالم‌اند.\n'
