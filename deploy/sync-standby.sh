#!/usr/bin/env bash
# همگام‌سازی یک‌طرفه‌ی داده‌ها از سرور اصلی به سرور پشتیبان (سرد).
#
#   bash deploy/sync-standby.sh root@backup.example.com
#
# سرور پشتیبان تا زمان سوییچ، فقط نسخه‌ای از داده‌ها را نگه می‌دارد و کاربر
# روی آن کار نمی‌کند؛ چون دو نسخه‌ی فعالِ هم‌زمان با هم ادغام نمی‌شوند.
set -euo pipefail

TARGET="${1:-}"
CONTAINER="${CONTAINER:-messenger}"

if [[ -z "$TARGET" ]]; then
  echo "کاربرد: bash deploy/sync-standby.sh user@host" >&2
  exit 1
fi

STAGING="$(mktemp -d)"
trap 'rm -rf "$STAGING"' EXIT

echo "==> گرفتن نسخه‌ی سالم از پایگاه‌داده"
docker exec "$CONTAINER" node -e "
  const { DatabaseSync } = require('node:sqlite');
  new DatabaseSync('/data/chat.db').exec(\"VACUUM INTO '/data/sync.db'\");
"
docker exec "$CONTAINER" tar cf - -C /data sync.db uploads | tar xf - -C "$STAGING"
docker exec "$CONTAINER" rm -f /data/sync.db
mv "$STAGING/sync.db" "$STAGING/chat.db"

echo "==> ارسال به $TARGET"
rsync -az --delete "$STAGING/" "$TARGET:/var/lib/messenger-standby/"

echo "همگام‌سازی تمام شد. برای سوییچ: داده‌ها را روی والیوم سرور پشتیبان بگذارید،"
echo "سرویس را بالا بیاورید و رکورد DNS را به آن سرور تغییر دهید."
