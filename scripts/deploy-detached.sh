#!/usr/bin/env bash
# MepMail deploy that outlives the operator's session.
#
# Why this exists (A149): on 21/11 the deploy ran inside a session whose timeout
# killed the `compose up` mid-flight, the old channels were removed before the
# new containers were healthy, and the SMTP logs from the switchover were lost
# with them. This script runs detached, copies the old containers' logs to disk
# BEFORE compose replaces them, and refuses to move on until each role answers.
#
# It never deletes the previous image: the rollback digest stays tagged and the
# compose file keeps a timestamped backup for the whole run.
#
# usage:
#   setsid nohup scripts/deploy-detached.sh \
#     --digest sha256:<new-image-id> --revision <git-sha> \
#     >/var/log/mepmail/deploy-$(date +%s).boot 2>&1 &
#
# Then watch: tail -f /var/log/mepmail/deploy-<ts>.log
set -Eeuo pipefail

ROOT="${MEPMAIL_DEPLOY_ROOT:-/home/jean/millionsend}"
LOGDIR="${MEPMAIL_DEPLOY_LOGDIR:-/var/log/mepmail}"
COMPOSE_FILES=(
  "$ROOT/docker-compose.yml"
  "$ROOT/.private/azure-email-events.compose.json"
)
SERVICES=(smtp mailclients millionsend)

DIGEST=""
REVISION=""
for arg in "$@"; do
  case "$arg" in
    --digest=*) DIGEST="${arg#*=}" ;;
    --digest) shift; DIGEST="${1:-}" ;;
    --revision=*) REVISION="${arg#*=}" ;;
    --revision) shift; REVISION="${1:-}" ;;
    *) echo "unknown argument: $arg" >&2; exit 2 ;;
  esac
done
[[ -n "$DIGEST" ]] || { echo "--digest sha256:<id> is required" >&2; exit 2; }

mkdir -p "$LOGDIR"
TS="$(date -u +%Y%m%dT%H%M%SZ)"
LOG="$LOGDIR/deploy-$TS.log"
exec > >(tee -a "$LOG") 2>&1
say() { printf '%s %s\n' "$(date -u +%H:%M:%SZ)" "$*"; }
fail() { say "FAIL: $*"; exit 1; }

say "deploy start digest=$DIGEST revision=${REVISION:-unknown} root=$ROOT"
docker image inspect "$DIGEST" >/dev/null 2>&1 || fail "digest $DIGEST not present locally"

# 1. What is serving right now, and its evidence. The logs of the containers
#    about to be replaced are the only record of their last minutes.
declare -A OLD_DIGEST
for svc in "${SERVICES[@]}"; do
  cid="$(docker compose --project-directory "$ROOT" ps -q "$svc" 2>/dev/null || true)"
  [[ -n "$cid" ]] || { say "no running container for $svc (first deploy?)"; continue; }
  OLD_DIGEST[$svc]="$(docker inspect "$cid" --format '{{.Image}}')"
  docker logs --timestamps "$cid" >"$LOGDIR/$TS-$svc-old.log" 2>&1 || true
  say "captured $svc ($cid) image ${OLD_DIGEST[$svc]} logs=$LOGDIR/$TS-$svc-old.log"
done

PREVIOUS="$(printf '%s\n' "${OLD_DIGEST[@]}" | sort -u | head -1)"
[[ -n "$PREVIOUS" ]] || fail "could not read the running image; refusing to deploy blind"

# 2. Point every compose file that pins the old digest at the new one, keeping a
#    timestamped copy so the rollback is a file move, not a guess.
for f in "${COMPOSE_FILES[@]}"; do
  [[ -f "$f" ]] || continue
  cp -a "$f" "$f.bak-$TS"
  if grep -q "$PREVIOUS" "$f"; then
    sed -i "s/$PREVIOUS/$DIGEST/g" "$f"
    say "rewrote $f ($PREVIOUS -> $DIGEST), backup $f.bak-$TS"
  fi
done
if [[ -n "$REVISION" ]]; then
  for f in "${COMPOSE_FILES[@]}"; do
    [[ -f "$f" ]] || continue
    sed -i "s/\"MEPMAIL_REVISION\": \"[0-9a-f]\{7,\}\"/\"MEPMAIL_REVISION\": \"$REVISION\"/" "$f" || true
  done
fi

compose_up() {
  local svc="$1"
  docker compose --project-directory "$ROOT" up -d --no-deps --force-recreate "$svc"
}
compose_down_to_rollback() {
  local svc="$1"
  say "rolling $svc back to $PREVIOUS"
  for f in "${COMPOSE_FILES[@]}"; do
    [[ -f "$f.bak-$TS" ]] && cp -a "$f.bak-$TS" "$f"
  done
  compose_up "$svc" || true
}

# 3. One role at a time, each gated on its own readiness answer.
wait_http() {
  local url="$1" tries=60
  for _ in $(seq "$tries"); do
    if curl -fsS -o /dev/null --max-time 3 "$url"; then return 0; fi
    sleep 2
  done
  return 1
}
wait_port() {
  local port="$1" tries=60
  for _ in $(seq "$tries"); do
    if ss -ltn 2>/dev/null | grep -q ":$port "; then return 0; fi
    sleep 2
  done
  return 1
}

for svc in "${SERVICES[@]}"; do
  say "recreating $svc"
  if ! compose_up "$svc"; then
    compose_down_to_rollback "$svc"
    fail "$svc did not recreate; rolled back"
  fi
  case "$svc" in
    millionsend)
      if ! wait_http "http://127.0.0.1:3000/health"; then
        docker logs --tail 200 "$(docker compose --project-directory "$ROOT" ps -q "$svc")" || true
        compose_down_to_rollback "$svc"
        fail "web /health never answered; rolled back"
      fi
      ;;
    smtp)
      if ! wait_port 2587; then
        compose_down_to_rollback "$svc"
        fail "smtp 2587 never listened; rolled back"
      fi
      ;;
    mailclients)
      if ! wait_port 1465; then
        compose_down_to_rollback "$svc"
        fail "mailclients 1465 never listened; rolled back"
      fi
      ;;
  esac
  say "$svc healthy"
done

# 4. The new set is serving: only now is anything old removed. The previous
#    image stays in place as the rollback artefact.
for svc in "${SERVICES[@]}"; do
  cid="$(docker compose --project-directory "$ROOT" ps -q "$svc")"
  [[ -n "$cid" ]] || continue
  say "$svc -> $(docker inspect "$cid" --format '{{.Image}}') revision=$(docker inspect "$cid" --format '{{index .Config.Labels "com.docker.compose.service"}}')"
  docker logs --timestamps "$cid" >"$LOGDIR/$TS-$svc-new.log" 2>&1 || true
done

say "delete nothing: rollback image $PREVIOUS, compose backups *.bak-$TS"
say "DEPLOY OK digest=$DIGEST log=$LOG"
