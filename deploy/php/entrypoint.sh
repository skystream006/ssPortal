#!/bin/sh
set -eu

mkdir -p "$APP_DATA_DIR"
chown www-data:www-data "$APP_DATA_DIR"

if [ "$APP_NAME" = "grocy" ] && [ ! -f "$APP_DATA_DIR/config.php" ]; then
  cp /var/www/grocy/config-dist.php "$APP_DATA_DIR/config.php"
  chown www-data:www-data "$APP_DATA_DIR/config.php"
fi

exec docker-php-entrypoint "$@"