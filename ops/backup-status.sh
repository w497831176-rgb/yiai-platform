#!/usr/bin/env bash
set -Eeuo pipefail

SECRETS_DIR="${YIAI_PLATFORM_SECRETS_DIR:-/srv/yiai-platform/secrets}"
BACKUP_ENV="$SECRETS_DIR/backup.env"
[[ -f "$BACKUP_ENV" ]] || { echo 'missing backup configuration'; exit 1; }
set -a
# shellcheck disable=SC1090
. "$BACKUP_ENV"
set +a

latest="$(ssh -F "$YIAI_NAS_BACKUP_SSH_CONFIG" "$YIAI_NAS_BACKUP_HOST" "for file in '$YIAI_NAS_BACKUP_DIR'/snapshots/yiai-platform-*.tar.gz.age; do [ -f \"\$file\" ] && basename \"\$file\"; done" | sort | tail -n 1)"
[[ -n "$latest" ]] || { echo 'no successful backup archive found'; exit 1; }
echo "latest_backup=$latest"
