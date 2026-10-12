#!/usr/bin/env bash
#
# مانور: وانمود می‌کند گواهی Let's Encrypt منقضی شده، تا ببینید سوئیچ به
# گواهی پشتیبان واقعاً کار می‌کند و اپ اندروید سر جایش می‌ماند.
#
#   sudo bash deploy/drill-offline-tls.sh 9chat.ir start   # رفتن به حالت پشتیبان
#   sudo bash deploy/drill-offline-tls.sh 9chat.ir end     # برگشتن به حالت عادی
#
# فایل‌های واقعی /etc/letsencrypt هیچ‌وقت دست نمی‌خورند: فقط یک گواهیِ
# منقضیِ ساختگی در پوشه‌ی موقت ساخته می‌شود و نگهبان با همان صدا زده می‌شود.
# برای اینکه فراموش کردنِ `end` سایت را رها نکند، یک برگشت خودکار ۳۰ دقیقه‌ای
# هم گذاشته می‌شود.

set -euo pipefail

DOMAIN="${1:-}"
MODE="${2:-start}"
TLS_DIR="${TLS_DIR:-/etc/9chat-tls}"
GUARD_BIN="${GUARD_BIN:-/usr/local/bin/9chat-cert-guard}"
DRILL_DIR="${DRILL_DIR:-/run/9chat-drill}"
VHOST="${NGINX_VHOST:-/etc/nginx/sites-available/$DOMAIN.conf}"

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
[[ -n "$DOMAIN" ]] || die "کاربرد: sudo bash deploy/drill-offline-tls.sh <دامنه> [start|end]"
[[ -x "$GUARD_BIN" ]] || die "نگهبان پیدا نشد؛ اول deploy/setup-offline-tls.sh را اجرا کنید."

current_cert() {
  sed -n 's/^[[:space:]]*ssl_certificate[[:space:]]\+\(.*\);/\1/p' "$VHOST" | head -1
}

if [[ "$MODE" == "end" ]]; then
  info "برگشت به حالت عادی"
  rm -rf "$DRILL_DIR"
  "$GUARD_BIN" "$DOMAIN"
  printf '\n   گواهی فعلی: %s\n\n' "$(current_cert)"
  case "$(current_cert)" in
    *letsencrypt*) printf '   ✅ برگشتیم روی Let'"'"'s Encrypt.\n\n' ;;
    *) warn "هنوز روی پشتیبان است — گواهی Let's Encrypt سالم نیست؟" ;;
  esac
  exit 0
fi

[[ "$MODE" == "start" ]] || die "حالت باید start یا end باشد."
[[ -f "$TLS_DIR/server.crt" ]] || die "گواهی پشتیبان نیست؛ اول deploy/setup-offline-tls.sh را اجرا کنید."

info "ساخت یک گواهیِ منقضیِ ساختگی (فایل‌های واقعی دست نمی‌خورند)"
mkdir -p "$DRILL_DIR"
chmod 700 "$DRILL_DIR"
openssl req -newkey rsa:2048 -nodes -keyout "$DRILL_DIR/privkey.pem" \
  -out "$DRILL_DIR/req.csr" -subj "/CN=$DOMAIN" 2>/dev/null
# `-days -1` یعنی گواهی‌ای که دیروز منقضی شده.
openssl x509 -req -in "$DRILL_DIR/req.csr" -CA "$TLS_DIR/ca.crt" -CAkey "$TLS_DIR/ca.key" \
  -out "$DRILL_DIR/fullchain.pem" -days -1 2>/dev/null
rm -f "$DRILL_DIR/req.csr"

info "صدا زدن نگهبان با همان گواهیِ منقضی"
LE_CRT="$DRILL_DIR/fullchain.pem" LE_KEY="$DRILL_DIR/privkey.pem" "$GUARD_BIN" "$DOMAIN"

cert="$(current_cert)"
printf '\n   گواهی فعلی: %s\n' "$cert"
case "$cert" in
  "$TLS_DIR"/*) printf '   ✅ سوئیچ انجام شد.\n' ;;
  *) die "سوئیچ انجام نشد؛ لاگ: /var/log/9chat-cert-guard.log" ;;
esac

# تور ایمنی: اگر یادتان رفت end بزنید، نیم‌ساعت دیگر خودش برمی‌گردد.
if command -v systemd-run >/dev/null 2>&1; then
  systemd-run --on-active=30min --unit=9chat-drill-restore \
    /bin/sh -c "rm -rf '$DRILL_DIR'; '$GUARD_BIN' '$DOMAIN'" >/dev/null 2>&1 ||
    warn "برگشت خودکار تنظیم نشد؛ حتماً خودتان end را بزنید."
else
  warn "systemd-run نیست؛ حتماً خودتان end را بزنید."
fi

cat <<DONE

  ────────────────────────────────────────────────────────────────────
   حالا سایت با گواهی محلی بالاست. این‌ها را امتحان کنید:

   ۱) با اپ اندروید ۱.۳ وارد شوید، یک پیام صوتی بفرستید و یک تماس بگیرید.
      اگر کار کرد، یعنی بیمه جواب می‌دهد.

   ۲) با مرورگر باز کنید: باید اخطار گواهی بدهد. این درست است و انتظارش
      را داشتیم — مرورگرها مرجع ما را نمی‌شناسند.

   ۳) اپ نسخه‌ی ۱.۲ یا قدیمی‌تر باید وصل نشود. این هم درست است.

   وقتی تمام شد (یا حداکثر تا نیم ساعت دیگر، که خودش برمی‌گردد):

      sudo bash deploy/drill-offline-tls.sh $DOMAIN end
  ────────────────────────────────────────────────────────────────────

DONE
