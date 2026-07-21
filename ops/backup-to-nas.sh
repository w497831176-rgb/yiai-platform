#!/usr/bin/env bash
set -Eeuo pipefail

APP_ROOT="${YIAI_PLATFORM_APP_ROOT:-/srv/yiai-platform/current}"
DATA_ROOT="${YIAI_PLATFORM_DATA_ROOT:-/srv/yiai-platform/data}"
SECRETS_DIR="${YIAI_PLATFORM_SECRETS_DIR:-/srv/yiai-platform/secrets}"
STAGING_DIR="${YIAI_PLATFORM_BACKUP_STAGING:-/srv/yiai-platform/backup-staging}"
BACKUP_ENV="$SECRETS_DIR/backup.env"
LOCK_FILE="/run/lock/yiai-platform-backup.lock"

log() { printf '[%s] %s\n' "$(date --iso-8601=seconds)" "$*"; }
die() { log "ERROR: $*"; exit 1; }

[[ -f "$BACKUP_ENV" ]] || die "missing backup configuration: $BACKUP_ENV"
[[ -d "$APP_ROOT" ]] || die "missing application release: $APP_ROOT"
mkdir -p "$STAGING_DIR"

exec 9>"$LOCK_FILE"
if ! flock -n 9; then
  log 'another backup is already running; skipping this trigger'
  exit 0
fi

set -a
# shellcheck disable=SC1090
. "$BACKUP_ENV"
set +a

: "${YIAI_NAS_BACKUP_HOST:?YIAI_NAS_BACKUP_HOST is required}"
: "${YIAI_NAS_BACKUP_SSH_CONFIG:?YIAI_NAS_BACKUP_SSH_CONFIG is required}"
: "${YIAI_NAS_BACKUP_DIR:?YIAI_NAS_BACKUP_DIR is required}"
: "${YIAI_BACKUP_AGE_RECIPIENT:?YIAI_BACKUP_AGE_RECIPIENT is required}"

ssh_run() { ssh -F "$YIAI_NAS_BACKUP_SSH_CONFIG" "$YIAI_NAS_BACKUP_HOST" "$@"; }

timestamp="$(date +%Y%m%dT%H%M%S%z)"
archive_name="yiai-platform-${timestamp}.tar.gz.age"
workdir="$(mktemp -d "$STAGING_DIR/backup-${timestamp}.XXXXXX")"
trap 'rm -rf "$workdir"' EXIT

mkdir -p "$workdir/database" "$workdir/data" "$workdir/config"
log 'starting consistent PostgreSQL export'
docker exec yiai-platform-db sh -c 'exec pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' \
  > "$workdir/database/yiai-platform.pg.dump"
[[ -s "$workdir/database/yiai-platform.pg.dump" ]] || die 'PostgreSQL export is empty'

[[ -d "$DATA_ROOT/icon-cache" ]] || die 'icon cache directory is missing'
[[ -f "$SECRETS_DIR/.env" ]] || die 'application environment file is missing'
cp -a "$DATA_ROOT/icon-cache" "$workdir/data/"
install -m 600 "$SECRETS_DIR/.env" "$workdir/config/platform.env"
install -m 644 "$APP_ROOT/compose.ubuntu.yml" "$workdir/config/"
install -m 644 "$APP_ROOT/Dockerfile.api" "$APP_ROOT/Dockerfile.web" "$workdir/config/"
install -m 644 "$APP_ROOT/infra/nginx/nginx.ubuntu.conf" "$workdir/config/"
cp -a "$APP_ROOT/deploy/systemd" "$workdir/config/systemd"

{
  printf 'created_at=%s\n' "$(date --iso-8601=seconds)"
  printf 'database_dump=database/yiai-platform.pg.dump\n'
  docker image inspect --format '{{.Id}}' yiai-platform-api:latest 2>/dev/null | sed 's/^/api_image=/' || true
  docker image inspect --format '{{.Id}}' yiai-platform-web:latest 2>/dev/null | sed 's/^/web_image=/' || true
} > "$workdir/release-manifest.txt"

plain_archive="$workdir/${archive_name%.age}"
encrypted_archive="$workdir/$archive_name"
tar -C "$workdir" -czf "$plain_archive" database data config release-manifest.txt
age -r "$YIAI_BACKUP_AGE_RECIPIENT" -o "$encrypted_archive" "$plain_archive"
(cd "$workdir" && sha256sum "$archive_name") > "$encrypted_archive.sha256"
rm -f "$plain_archive"

log 'uploading encrypted archive to NAS via SSH'
ssh_run "mkdir -p '$YIAI_NAS_BACKUP_DIR/snapshots'"
remote_archive="$YIAI_NAS_BACKUP_DIR/snapshots/$archive_name"
remote_checksum="$remote_archive.sha256"
cat "$encrypted_archive" | ssh_run "cat > '$remote_archive.part'"
cat "$encrypted_archive.sha256" | ssh_run "cat > '$remote_checksum.part'"
ssh_run "cd '$YIAI_NAS_BACKUP_DIR/snapshots' && mv '$archive_name.part' '$archive_name' && mv '$archive_name.sha256.part' '$archive_name.sha256' && if sha256sum -c '$archive_name.sha256'; then :; else rm -f -- '$archive_name' '$archive_name.sha256'; exit 1; fi"

declare -A kept_day kept_week kept_month
daily_count=0
weekly_count=0
monthly_count=0
today="$(date +%Y%m%d)"
removals=()

mapfile -t archives < <(ssh_run "for file in '$YIAI_NAS_BACKUP_DIR'/snapshots/yiai-platform-*.tar.gz.age; do [ -f \"\$file\" ] && basename \"\$file\"; done" | sort -r)
for archive in "${archives[@]}"; do
  if [[ ! "$archive" =~ ^yiai-platform-([0-9]{8})T[0-9]{6}[+-][0-9]{4}\.tar\.gz\.age$ ]]; then
    continue
  fi
  day="${BASH_REMATCH[1]}"
  iso_date="${day:0:4}-${day:4:2}-${day:6:2}"
  week="$(date -d "$iso_date" +%G-W%V)"
  month="${day:0:6}"
  if [[ "$day" == "$today" ]]; then
    continue
  elif [[ -z "${kept_day[$day]:-}" && "$daily_count" -lt 14 ]]; then
    kept_day[$day]=1
    ((daily_count += 1))
  elif [[ -z "${kept_week[$week]:-}" && "$weekly_count" -lt 8 ]]; then
    kept_week[$week]=1
    ((weekly_count += 1))
  elif [[ -z "${kept_month[$month]:-}" && "$monthly_count" -lt 6 ]]; then
    kept_month[$month]=1
    ((monthly_count += 1))
  else
    removals+=("$archive")
  fi
done

for archive in "${removals[@]}"; do
  ssh_run "rm -f -- '$YIAI_NAS_BACKUP_DIR/snapshots/$archive' '$YIAI_NAS_BACKUP_DIR/snapshots/$archive.sha256'"
done

log "backup completed successfully: $archive_name; removed ${#removals[@]} expired archive(s)"
