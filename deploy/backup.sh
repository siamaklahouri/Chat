#!/usr/bin/env bash
# پشتیبان‌گیری از پایگاه‌داده و عکس‌ها در یک فایل tar.gz.
#   bash deploy/backup.sh [پوشه‌ی مقصد]
set -euo pipefail

DEST="${1:-./backups}"
STAMP="$(date +%Y%m%d-%H%M%S)"
mkdir -p "$DEST"

# SQLite باید با دستور خودش پشتیبان گرفته شود تا فایل نیمه‌کاره نشود.
docker compose -f "$(dirname "$0")/docker-compose.yml" exec -T app \
  node -e "
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync('/data/chat.db');
    db.exec(\"VACUUM INTO '/data/backup.db'\");
    console.log('snapshot ok');
  "

docker compose -f "$(dirname "$0")/docker-compose.yml" exec -T app \
  tar czf - -C /data backup.db uploads > "$DEST/messenger-$STAMP.tar.gz"

docker compose -f "$(dirname "$0")/docker-compose.yml" exec -T app rm -f /data/backup.db

echo "پشتیبان ساخته شد: $DEST/messenger-$STAMP.tar.gz"
