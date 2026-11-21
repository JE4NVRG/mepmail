#!/usr/bin/env bash
# MepMail deploy that outlives the operator's session.
#
# Why this exists (A149): on 21/11 the deploy ran inside a session whose timeout
# killed the `compose up` mid-flight, the old channels were removed before the
# new containers were healthy, and the SMTP logs from the switchover were lost
# with them. This script runs detached, copies the old containers' logs to disk
# BEFORE compose replaces them, and refuses to move on until each role answers.
#
# It never deletes the previous image: the rollback digest stays tagged and every
# compose file keeps a timestamped backup for the whole run.
#
# The project runs with FOUR compose files (base + three overlays that carry
# secrets and product switches). The list is read from the running container's
# own labels, so this script can never recreate a role with a partial config.
#
# usage:
#   scripts/deploy-detached.sh --digest sha256:<id> --revision <git-sha> --check
#   setsid nohup scripts/deploy-detached.sh --digest sha256:<id> --revision <git-sha> \
#     >/dev/null 2>&1 &
#   tail -f /home/jean/mepmail-builds/deploy-<ts>.log
set -Eeuo pipefail

ROOT="${MEPMAIL_DEPLOY_ROOT:-/home/jean/millionsend}"
LOGDIR="${MEPMAIL_DEPLOY_LOGDIR:-/home/jean/mepmail-builds}"
ANCHOR_SERVICE="millionsend"
SERVICES=(smtp mailclients millionsend)

DIGEST=""
REVISION=""
CHECK="false"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --digest=*) DIGEST="${1#*=}"; shift ;;
    --digest) DIGEST="${2:-}"; shift 2 ;;
    --revision=*) REVISION="${1#*=}"; shift ;;
    --revision) REVISION="${2:-}"; shift 2 ;;
    --check) CHECK="true"; shift ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done
[[ -n "$DIGEST" ]] || { echo "--digest sha256:<id> is required" >&2; exit 2; }

mkdir -p "$LOGDIR"
TS="$(date -u +%Y%m%dT%H%M%SZ)"
LOG="$LOGDIR/deploy-$TS.log"
echo "$LOG" >"$LOGDIR/LATEST-DEPLOY"
exec > >(tee -a "$LOG") 2>&1
say() { printf '%s %s\n' "$(date -u +%H:%M:%SZ)" "$*"; }
fail() { say "FAIL: $*"; exit 1; }

say "deploy start digest=$DIGEST revision=${REVISION:-unknown} check=$CHECK root=$ROOT"
docker image inspect "$DIGEST" >/dev/null 2>&1 || fail "digest $DIGEST not present locally"

# 1. The exact compose stack this project is running, straight from the
#    container's own labels: base file first, overlays in their original order.
ANCHOR="$(docker ps -q --filter "label=com.docker.compose.service=$ANCHOR_SERVICE" | head -1)"
[[ -n "$ANCHOR" ]] || fail "no running $ANCHOR_SERVICE container to read the compose files from"
mapfile -t FILES < <(docker inspect "$ANCHOR" --format '{{index .Config.Labels "com.docker.compose.project.config_files"}}' | tr ',' '\n')
[[ ${#FILES[@]} -gt 0 ]] || fail "could not read compose config files from $ANCHOR_SERVICE"
for f in "${FILES[@]}"; do
  [[ -f "$f" ]] || fail "compose file missing: $f"
  say "compose file: $f"
done
COMPOSE_ARGS=()
for f in "${FILES[@]}"; do COMPOSE_ARGS+=(-f "$f"); done
# smtp, mailclients, docs and backup live behind compose profiles; without them
# the resolved model does not even contain the services this script recreates.
compose() { docker compose "${COMPOSE_ARGS[@]}" --profile "*" --project-directory "$ROOT" "$@"; }
compose config --quiet || fail "compose config is invalid before any change"
SERVICES_PRESENT="$(compose config --services | tr '\n' ' ')"
say "compose config valid; services: $SERVICES_PRESENT"
for svc in "${SERVICES[@]}"; do
  case " $SERVICES_PRESENT " in
    *" $svc "*) ;;
    *) fail "service $svc is not in the resolved compose model; refusing to touch anything" ;;
  esac
done

PREVIOUS="$(docker inspect "$ANCHOR" --format '{{.Image}}')"
say "currently serving image $PREVIOUS"

# 2. Rewrite the digest and the revision everywhere they are pinned. Every file
#    touched keeps a timestamped backup, so the rollback is a file move.
declare -a TOUCHED=()
for f in "${FILES[@]}"; do
  if grep -q "$PREVIOUS" "$f" || [[ -n "$REVISION" ]] && grep -q "MEPMAIL_REVISION" "$f"; then
    cp -a "$f" "$f.bak-$TS"
    TOUCHED+=("$f")
  fi
done
[[ ${#TOUCHED[@]} -gt 0 ]] || say "no compose file pins the current digest; nothing to rewrite"
for f in "${TOUCHED[@]}"; do
  sed -i "s/$PREVIOUS/$DIGEST/g" "$f"
  if [[ -n "$REVISION" ]]; then
    sed -i -E "s/(MEPMAIL_REVISION[\"']?:[[:space:]]*[\"'])[0-9a-f]{7,}([\"'])/\1$REVISION\2/g" "$f"
    sed -i -E "s/(MILLIONSEND_REVISION[\"']?:[[:space:]]*[\"'])[0-9a-f]{7,}([\"'])/\1$REVISION\2/g" "$f"
  fi
  say "rewrote $f (backup $f.bak-$TS)"
done

restore() {
  for f in "${TOUCHED[@]:-}"; do
    [[ -f "$f.bak-$TS" ]] && cp -a "$f.bak-$TS" "$f"
  done
}

if ! compose config --quiet; then
  restore
  fail "compose config became invalid after the rewrite; restored the originals"
fi
if [[ "$CHECK" == "true" ]]; then
  # Only the two lines this script is allowed to touch. Printing the diff with
  # context would spill every secret the overlays carry into the log.
  say "CHECK MODE — lines that would change (no values):"
  for f in "${TOUCHED[@]:-}"; do
    printf '  %s: image=%s revision=%s
' "$f"       "$(grep -c "^[[:space:]]*image: $DIGEST" "$f" || true)"       "$(grep -c "MEPMAIL_REVISION.*$REVISION" "$f" || true)"
  done
  restore
  say "check done, originals restored, nothing recreated"
  exit 0
fi

# 3. The logs of the containers about to be replaced are the only record of
#    their last minutes: copy them before compose takes the containers away.
for svc in "${SERVICES[@]}"; do
  cid="$(compose ps -q "$svc" 2>/dev/null | head -1)"
  [[ -n "$cid" ]] || { say "no running container for $svc"; continue; }
  docker logs --timestamps "$cid" >"$LOGDIR/$TS-$svc-old.log" 2>&1 || true
  say "captured $svc ($cid) logs=$LOGDIR/$TS-$svc-old.log"
done

wait_http() {
  local url="$1"
  for _ in $(seq 60); do
    curl -fsS -o /dev/null --max-time 3 "$url" && return 0
    sleep 2
  done
  return 1
}
wait_port() {
  local port="$1"
  for _ in $(seq 60); do
    ss -ltn 2>/dev/null | grep -q ":$port " && return 0
    sleep 2
  done
  return 1
}
rollback() {
  local svc="$1"
  say "rolling $svc back to $PREVIOUS"
  restore
  compose up -d --no-deps --force-recreate "$svc" || say "rollback of $svc failed too — manual action needed"
}

# 4. One role at a time, each gated on its own readiness answer.
for svc in "${SERVICES[@]}"; do
  say "recreating $svc"
  compose up -d --no-deps --force-recreate "$svc" || { rollback "$svc"; fail "$svc did not recreate"; }
  case "$svc" in
    millionsend)
      if ! wait_http "http://127.0.0.1:3000/health"; then
        docker logs --tail 120 "$(compose ps -q "$svc" | head -1)" 2>&1 | tail -40 || true
        rollback "$svc"
        fail "web /health never answered"
      fi
      ;;
    smtp) wait_port 2587 || { rollback "$svc"; fail "smtp 2587 never listened"; } ;;
    mailclients) wait_port 1465 || { rollback "$svc"; fail "mailclients 1465 never listened"; } ;;
  esac
  say "$svc healthy"
done

# 5. The new set is serving. Nothing old is removed here: the previous image
#    stays as the rollback artefact.
for svc in "${SERVICES[@]}"; do
  cid="$(compose ps -q "$svc" | head -1)"
  [[ -n "$cid" ]] || continue
  say "$svc -> image=$(docker inspect "$cid" --format '{{.Image}}') revision=$(docker inspect "$cid" --format '{{range .Config.Env}}{{println .}}{{end}}' | grep -m1 '^MEPMAIL_REVISION=' | cut -d= -f2)"
  docker logs --timestamps "$cid" >"$LOGDIR/$TS-$svc-new.log" 2>&1 || true
done

say "rollback artefact kept: $PREVIOUS; compose backups: *.bak-$TS"
say "DEPLOY OK digest=$DIGEST log=$LOG"
