#!/usr/bin/env bash
# Mail send race gate: runs apps/web/test/mailbox-send-race.pg.test.ts (overlapping
# submissions, a save racing a send, two workers on one outbox) on a throwaway local
# PostgreSQL, then removes it. tmpfs storage, bound to 127.0.0.1, random password.
# PGlite runs one transaction at a time, so only a real server shows these races.
# Exit status is the test's. Run before a release that touches Mail sending.
set -euo pipefail
name="mepmail-send-race-pg-$$"
port="${MEPMAIL_RACE_PG_PORT:-15499}"
password="$(node -e 'process.stdout.write(require("crypto").randomBytes(16).toString("hex"))')"
cleanup() { docker rm -f "$name" >/dev/null 2>&1 || true; }
trap cleanup EXIT
MSYS_NO_PATHCONV=1 docker run -d --name "$name" -e POSTGRES_PASSWORD="$password" \
  -e POSTGRES_DB=race -p "127.0.0.1:$port:5432" --tmpfs /var/lib/postgresql/data \
  postgres:17-alpine >/dev/null
# TCP answers only once the init's temporary server has made way for the real one.
for _ in $(seq 1 60); do
  docker exec "$name" pg_isready -h 127.0.0.1 -U postgres -d race >/dev/null 2>&1 && break
  sleep 1
done
cd "$(dirname "$0")/../apps/web"
MEPMAIL_RACE_PG_URL="postgres://postgres:$password@127.0.0.1:$port/race" \
  npx vitest run test/mailbox-send-race.pg.test.ts
