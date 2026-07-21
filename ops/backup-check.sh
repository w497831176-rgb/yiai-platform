#!/usr/bin/env bash
set -Eeuo pipefail

SECRETS_DIR="${YIAI_PLATFORM_SECRETS_DIR:-/srv/yiai-platform/secrets}"
STAGING_DIR="${YIAI_PLATFORM_BACKUP_STAGING:-/srv/yiai-platform/backup-staging}"
BACKUP_ENV="$SECRETS_DIR/backup.env"
[[ -f "$BACKUP_ENV" ]] || { echo 'missing backup configuration'; exit 1; }
set -a
# shellcheck disable=SC1090
. "$BACKUP_ENV"
set +a

latest="$(ssh -F "$YIAI_NAS_BACKUP_SSH_CONFIG" "$YIAI_NAS_BACKUP_HOST" "for file in '$YIAI_NAS_BACKUP_DIR'/snapshots/yiai-platform-*.tar.gz.age; do [ -f \"\$file\" ] && basename \"\$file\"; done" | sort | tail -n 1)"
[[ -n "$latest" ]] || { echo 'no backup archive found'; exit 1; }
workdir="$(mktemp -d "$STAGING_DIR/check.XXXXXX")"
trap 'rm -rf "$workdir"' EXIT

ssh -F "$YIAI_NAS_BACKUP_SSH_CONFIG" "$YIAI_NAS_BACKUP_HOST" "cat '$YIAI_NAS_BACKUP_DIR/snapshots/$latest'" > "$workdir/$latest"
ssh -F "$YIAI_NAS_BACKUP_SSH_CONFIG" "$YIAI_NAS_BACKUP_HOST" "cat '$YIAI_NAS_BACKUP_DIR/snapshots/$latest.sha256'" > "$workdir/$latest.sha256"
(cd "$workdir" && sha256sum -c "$latest.sha256")
age -d -i "$YIAI_BACKUP_AGE_IDENTITY" "$workdir/$latest" | tar -tzf - >/dev/null
echo "backup_check=ok archive=$latest"
