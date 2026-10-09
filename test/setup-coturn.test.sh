#!/usr/bin/env bash
#
# اسکریپت نصب coturn را در یک جعبه‌ی شنی اجرا می‌کند: هیچ بسته‌ای نصب و هیچ
# سرویسی ری‌استارت نمی‌شود و چیزی بیرون از پوشه‌ی موقت نوشته نمی‌شود.
#
# انگیزه‌اش واقعی است: نسخه‌ی اول این اسکریپت دو جا زیر `set -euo pipefail`
# بی‌هیچ پیامی می‌مرد (یک لوله‌ی SIGPIPE و یک sed روی فایل نبوده) و روی سرور
# این‌طور به نظر می‌رسید که کار تمام شده، در حالی‌که نصف کار انجام نشده بود.
#
#   bash test/setup-coturn.test.sh

set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SB="$(mktemp -d)"
trap 'rm -rf "$SB"' EXIT

mkdir -p "$SB/bin" "$SB/etc/systemd/system" "$SB/etc/default"

for stub in apt-get systemctl journalctl; do
  printf '#!/bin/sh\nexit 0\n' > "$SB/bin/$stub"
done
# جایی که سرویس بیرونیِ تشخیص آی‌پی در دسترس نیست (مثل ایران)
printf '#!/bin/sh\nexit 7\n' > "$SB/bin/curl"
chmod +x "$SB/bin/"*

cat > "$SB/etc/systemd/system/9chat.service" <<'UNIT'
[Service]
Environment=PORT=3001
ExecStart=/usr/bin/node server/index.js
UNIT
printf '#TURNSERVER_ENABLED=1\n' > "$SB/etc/default/coturn"

run() {
  PATH="$SB/bin:$PATH" \
  ENV_FILE="$SB/etc/9chat.env" TURN_CONF="$SB/etc/turnserver.conf" \
  COTURN_DEFAULT="$SB/etc/default/coturn" UNIT_FILE="$SB/etc/systemd/system/9chat.service" \
    bash "$REPO/deploy/setup-coturn.sh" 9chat.ir > "$SB/out.log" 2>&1
}

fail() { printf '✗ %s\n' "$*" >&2; sed 's/^/    /' "$SB/out.log" >&2; exit 1; }
ok() { printf '✓ %s\n' "$*"; }

# ---------------------------------------------------------- اجرای نخست
run || fail "اسکریپت با کد خطا تمام شد"
ok "اجرای نخست تا آخر رفت"

[[ -f "$SB/etc/9chat.env" ]] || fail "فایل محیطی ساخته نشد"
[[ -f "$SB/etc/turnserver.conf" ]] || fail "turnserver.conf نوشته نشد"
ok "هر دو فایل تنظیمات نوشته شدند"

secret="$(awk -F= '/^TURN_SECRET=/ { print $2 }' "$SB/etc/9chat.env")"
[[ ${#secret} -eq 64 ]] || fail "راز مشترک ۶۴ نویسه نیست (${#secret})"
grep -q "static-auth-secret=$secret" "$SB/etc/turnserver.conf" ||
  fail "راز داخل turnserver.conf با فایل محیطی یکی نیست"
ok "راز مشترک ساخته شد و در هر دو فایل یکی است"

# بدون این خطوط، TURN پلی به سرویس‌های داخلی همین سرور می‌شد.
for range in '127.0.0.0-127.255.255.255' '10.0.0.0-10.255.255.255' '172.16.0.0-172.31.255.255' '192.168.0.0-192.168.255.255'; do
  grep -q "denied-peer-ip=$range" "$SB/etc/turnserver.conf" || fail "بازه‌ی $range مسدود نشده"
done
grep -q '^use-auth-secret' "$SB/etc/turnserver.conf" || fail "use-auth-secret ست نشده"
ok "سخت‌سازی: بازه‌های خصوصی مسدود و اعتبارنامه موقت است"

[[ "$(stat -c '%a' "$SB/etc/9chat.env")" == 600 ]] || fail "فایل محیطی مجوز ۶۰۰ ندارد"
ok "راز فقط برای root خواندنی است"

grep -q "^TURNSERVER_ENABLED=1$" "$SB/etc/default/coturn" || fail "coturn فعال نشد"
grep -q "EnvironmentFile=-$SB/etc/9chat.env" "$SB/etc/systemd/system/9chat.service" ||
  fail "EnvironmentFile به واحد systemd اضافه نشد"
ok "coturn فعال و فایل محیطی به سرویس وصل شد"

# ----------------------------------------------------------- اجرای دوم
run || fail "اجرای دوم با کد خطا تمام شد"
[[ "$(awk -F= '/^TURN_SECRET=/ { print $2 }' "$SB/etc/9chat.env")" == "$secret" ]] ||
  fail "اجرای دوم راز را عوض کرد (تماس‌های در جریان قطع می‌شدند)"
[[ "$(grep -c EnvironmentFile "$SB/etc/systemd/system/9chat.service")" == 1 ]] ||
  fail "خط EnvironmentFile تکراری شد"
ok "اجرای دوبار بی‌خطر است (راز و واحد دست‌نخورده ماندند)"

printf '\n✅ اسکریپت نصب coturn سالم است.\n'
