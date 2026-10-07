#!/usr/bin/env bash
# پشتیبان‌گیری از نصب بدون داکر (سرویس systemd).
#
#   bash deploy/backup-native.sh                 # در /var/backups/9chat
#   bash deploy/backup-native.sh /mnt/disk2 10   # مقصد دلخواه، نگهداری ۱۰ نسخه
#
# نسخه‌ی قدیمی‌تر از تعداد تعیین‌شده پاک می‌شود تا دیسک پر نشود.
set -euo pipefail

DATA_DIR="${APP_DATA:-/var/lib/9chat}"
DEST="${1:-/var/backups/9chat}"
KEEP="${2:-8}"
STAMP="$(date +%Y%m%d-%H%M%S)"
ARCHIVE="$DEST/9chat-$STAMP.tar.gz"

[[ -d "$DATA_DIR" ]] || { echo "پوشه‌ی داده پیدا نشد: $DATA_DIR" >&2; exit 1; }
mkdir -p "$DEST"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# SQLite را نباید وسط نوشتن کپی کرد؛ VACUUM INTO یک نسخه‌ی سالم و یکدست می‌سازد.
NODE_BIN="$(command -v node || echo /usr/bin/node)"
"$NODE_BIN" -e "
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync('$DATA_DIR/chat.db', { readOnly: true });
  db.exec(\"VACUUM INTO '$WORK/chat.db'\");
" 2>/dev/null

tar czf "$ARCHIVE" -C "$WORK" chat.db -C "$DATA_DIR" uploads
chmod 600 "$ARCHIVE"

# چرخش: فقط تازه‌ترین‌ها می‌مانند.
mapfile -t OLD < <(ls -1t "$DEST"/9chat-*.tar.gz 2>/dev/null | tail -n +$((KEEP + 1)))
for file in "${OLD[@]:-}"; do [[ -n "$file" ]] && rm -f "$file"; done

echo "پشتیبان ساخته شد: $ARCHIVE ($(du -h "$ARCHIVE" | cut -f1))"
echo "نسخه‌های موجود: $(ls -1 "$DEST"/9chat-*.tar.gz 2>/dev/null | wc -l) (نگهداری: $KEEP)"
