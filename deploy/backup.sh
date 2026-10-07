#!/usr/bin/env bash
# پشتیبان‌گیری از پایگاه‌داده و عکس‌ها در یک فایل tar.gz.
#   bash deploy/backup.sh [پوشه‌ی مقصد]
set -euo pipefail

DEST="${1:-./backups}"
STAMP="$(date +%Y%m%d-%H%M%S)"
CONTAINER="${CONTAINER:-messenger}"
mkdir -p "$DEST"

docker inspect "$CONTAINER" >/dev/null 2>&1 ||
  { echo "کانتینر «$CONTAINER» در حال اجرا نیست." >&2; exit 1; }

# SQLite باید با دستور خودش پشتیبان گرفته شود تا فایل نیمه‌کاره نشود.
docker exec "$CONTAINER" node -e "
  const { DatabaseSync } = require('node:sqlite');
  new DatabaseSync('/data/chat.db').exec(\"VACUUM INTO '/data/backup.db'\");
"

docker exec "$CONTAINER" tar czf - -C /data backup.db uploads > "$DEST/messenger-$STAMP.tar.gz"
docker exec "$CONTAINER" rm -f /data/backup.db

echo "پشتیبان ساخته شد: $DEST/messenger-$STAMP.tar.gz"
