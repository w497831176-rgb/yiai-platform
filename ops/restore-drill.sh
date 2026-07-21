#!/usr/bin/env bash
set -Eeuo pipefail

APP_ROOT="${YIAI_PLATFORM_APP_ROOT:-/srv/yiai-platform/current}"
SECRETS_DIR="${YIAI_PLATFORM_SECRETS_DIR:-/srv/yiai-platform/secrets}"
STAGING_DIR="${YIAI_PLATFORM_BACKUP_STAGING:-/srv/yiai-platform/backup-staging}"
BACKUP_ENV="$SECRETS_DIR/backup.env"
stamp="$(date +%Y%m%dT%H%M%S%z)"
DRILL_ROOT="${YIAI_PLATFORM_DRILL_ROOT:-/srv/yiai-platform/restore-drill/$stamp}"
RESTORE_ROOT="$DRILL_ROOT/restored-snapshot"
DRILL_DATA_ROOT="$DRILL_ROOT/data"
DRILL_ENV="$DRILL_ROOT/restored.env"

log() { printf '[%s] %s\n' "$(date --iso-8601=seconds)" "$*"; }
[[ -f "$BACKUP_ENV" ]] || { log 'missing backup configuration'; exit 1; }
set -a
# shellcheck disable=SC1090
. "$BACKUP_ENV"
set +a

latest="$(ssh -F "$YIAI_NAS_BACKUP_SSH_CONFIG" "$YIAI_NAS_BACKUP_HOST" "for file in '$YIAI_NAS_BACKUP_DIR'/snapshots/yiai-platform-*.tar.gz.age; do [ -f \"\$file\" ] && basename \"\$file\"; done" | sort | tail -n 1)"
[[ -n "$latest" ]] || { log 'no backup archive found'; exit 1; }

mkdir -p "$DRILL_ROOT" "$RESTORE_ROOT" "$DRILL_DATA_ROOT/icon-cache" "$STAGING_DIR"
start="$(date +%s)"
log "downloading encrypted snapshot $latest into isolated drill directory"
ssh -F "$YIAI_NAS_BACKUP_SSH_CONFIG" "$YIAI_NAS_BACKUP_HOST" "cat '$YIAI_NAS_BACKUP_DIR/snapshots/$latest'" > "$DRILL_ROOT/$latest"
ssh -F "$YIAI_NAS_BACKUP_SSH_CONFIG" "$YIAI_NAS_BACKUP_HOST" "cat '$YIAI_NAS_BACKUP_DIR/snapshots/$latest.sha256'" > "$DRILL_ROOT/$latest.sha256"
(cd "$DRILL_ROOT" && sha256sum -c "$latest.sha256")
age -d -i "$YIAI_BACKUP_AGE_IDENTITY" -o "$DRILL_ROOT/snapshot.tar.gz" "$DRILL_ROOT/$latest"
tar -xzf "$DRILL_ROOT/snapshot.tar.gz" -C "$RESTORE_ROOT"

dump_file="$RESTORE_ROOT/database/yiai-platform.pg.dump"
source_env="$RESTORE_ROOT/config/platform.env"
source_icons="$RESTORE_ROOT/data/icon-cache"
[[ -s "$dump_file" ]] || { log 'restored database dump is missing'; exit 1; }
[[ -f "$source_env" ]] || { log 'restored environment file is missing'; exit 1; }

cp "$source_env" "$DRILL_ENV"
chmod 600 "$DRILL_ENV"
printf '\nYIAI_PLATFORM_DRILL_DATA_ROOT=%s\n' "$DRILL_DATA_ROOT" >> "$DRILL_ENV"
cp -a "$source_icons/." "$DRILL_DATA_ROOT/icon-cache/"

compose=(docker compose -p yiai-platform-restore-drill --env-file "$DRILL_ENV" -f "$APP_ROOT/compose.restore-drill.yml")
log 'starting isolated PostgreSQL container'
"${compose[@]}" up -d db
for attempt in $(seq 1 30); do
  if docker exec yiai-platform-restore-drill-db pg_isready >/dev/null 2>&1; then
    break
  fi
  sleep 2
done
docker exec yiai-platform-restore-drill-db pg_isready >/dev/null

log 'importing restored PostgreSQL dump'
docker exec -i yiai-platform-restore-drill-db sh -c 'exec pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --no-owner --no-privileges' < "$dump_file"

log 'starting isolated API and Web services'
"${compose[@]}" up -d --build migrate api web
for attempt in $(seq 1 30); do
  if curl --noproxy '*' --silent --fail --max-time 5 http://127.0.0.1:18115/api/health >/dev/null; then
    break
  fi
  sleep 2
done
curl --noproxy '*' --silent --fail --max-time 10 http://127.0.0.1:18115/api/health >/dev/null

log 'running isolated login, application-list, and real streaming-chat smoke test'
YIAI_SMOKE_BASE_URL=http://127.0.0.1:18115 \
YIAI_SMOKE_DB_CONTAINER=yiai-platform-restore-drill-db \
  "$APP_ROOT/ops/functional-smoke.sh"

{
  printf 'completed_at=%s\n' "$(date --iso-8601=seconds)"
  printf 'elapsed_seconds=%s\n' "$(( $(date +%s) - start ))"
  printf 'health=http://127.0.0.1:18115/api/health\n'
  printf 'cleanup=docker compose -p yiai-platform-restore-drill --env-file %s -f %s/compose.restore-drill.yml down\n' "$DRILL_ENV" "$APP_ROOT"
} > "$DRILL_ROOT/RESULT.txt"
log "restore drill completed: $DRILL_ROOT"
