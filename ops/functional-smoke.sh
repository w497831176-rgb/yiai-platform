#!/usr/bin/env bash
set -Eeuo pipefail

BASE_URL="${YIAI_SMOKE_BASE_URL:-http://192.168.50.112:18114}"
DB_CONTAINER="${YIAI_SMOKE_DB_CONTAINER:-yiai-platform-db}"
APP_SLUG="${YIAI_SMOKE_APP_SLUG:-dunjiazi}"
username="migration_check_$(date +%s)"
password="MigrationCheck_$(date +%s)_A9"
workdir="$(mktemp -d)"

cleanup() {
  docker exec "$DB_CONTAINER" sh -c "psql -U \"\$POSTGRES_USER\" -d \"\$POSTGRES_DB\" -c \"DELETE FROM users WHERE username = '$username';\"" >/dev/null 2>&1 || true
  rm -rf "$workdir"
}
trap cleanup EXIT

printf '{"username":"%s","password":"%s"}' "$username" "$password" \
  | curl --noproxy '*' --fail-with-body --silent --show-error --max-time 20 \
    -H 'Content-Type: application/json' --data-binary @- "$BASE_URL/api/auth/register" > "$workdir/register.json"
printf '{"username":"%s","password":"%s"}' "$username" "$password" \
  | curl --noproxy '*' --fail-with-body --silent --show-error --max-time 20 \
    -H 'Content-Type: application/json' --data-binary @- "$BASE_URL/api/auth/login" > "$workdir/login.json"
token="$(python3 -c 'import json,sys; print(json.load(sys.stdin)["token"])' < "$workdir/login.json")"
curl --noproxy '*' --fail-with-body --silent --show-error --max-time 20 \
  -H "Authorization: Bearer $token" "$BASE_URL/api/apps" > "$workdir/apps.json"
app_count="$(python3 -c 'import json,sys; print(len(json.load(sys.stdin)))' < "$workdir/apps.json")"
printf '{"query":"Please provide a brief test response."}' \
  | curl --noproxy '*' --fail-with-body --silent --show-error --no-buffer --max-time 90 \
    -H "Authorization: Bearer $token" -H 'Content-Type: application/json' --data-binary @- \
    "$BASE_URL/api/apps/$APP_SLUG/chat" > "$workdir/chat.sse"
grep -q '"event":"message_end"' "$workdir/chat.sse"

echo 'register=ok'
echo "apps=$app_count"
echo 'chat_stream=message_end'
echo 'cleanup=ok'
