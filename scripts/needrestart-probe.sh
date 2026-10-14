#!/usr/bin/env bash
#
# needrestart-probe.sh — restart-debt probe (FABLE ruling 2026-10-06, 2-4/2-5).
#
# Runs `needrestart -b`, turns the result into one row of kernel state, and
# PUTs it to the kernel's system_health table over loopback. The host writes
# through the API exactly like NanoClaw does, so the kernel stays sole writer
# of kernel.db — this script never opens the database.
#
#   PUT http://127.0.0.1:4100/system-health/restart-debt
#   { "status": "ok|warn", "detail": "<short summary>" }
#
# No "actor" field: /system-health/:key is a health route, not a registry
# mutation, so it is outside the audit_log rule (kernel server.js: the handler
# takes status + detail only).
#
# STATUS MAPPING
#   ok    — no debt at all, OR debt younger than RESTART_DEBT_WARN_DAYS.
#           Ruling 2-6 wants the dashboard badge NEUTRAL under 7 days; the
#           facts still travel in `detail`, so the dashboard can render a
#           neutral "2 services pending (3d)" without an amber alert.
#   warn  — debt RESTART_DEBT_WARN_DAYS old or older (default 7, ruling 2-4).
#   critical — NOT EMITTED. TODO: ruling 2-4 wants 48h instead of 7 days when
#           the pending upgrade carries a critical or remotely exploitable CVE.
#           Deciding "is this CVE critical" needs a source this probe does not
#           have (USN/OVAL feed or similar). Left unwired deliberately rather
#           than guessed at — wire it here when the reviewer picks the source.
#
# THE THREE EXCLUDED UNITS ARE STILL REPORTED. Ruling 2-1 excludes
# nanoclaw.service, agent-os-kernel.service and docker.service from needrestart's
# AUTOMATIC restarts, via $nrconf{override_rc} = 0 in
# /etc/needrestart/conf.d/50-agent-os.conf. That is NOAUTO, not blacklist: in
# batch mode needrestart prints `NEEDRESTART-SVC: <unit>` and `next`s BEFORE it
# ever consults override_rc (needrestart 3.6, /usr/sbin/needrestart:1077), so
# those units still show up here as debt. If anyone ever moves them to
# $nrconf{blacklist_rc} instead, this probe goes blind to exactly the three
# units that matter most — don't.
#
# NOT INSTALLED. See deploy/nanoclaw-restart-debt.{service,timer}.
#
# Usage:
#   needrestart-probe.sh              run and PUT
#   needrestart-probe.sh --dry-run    print what would be sent; no PUT, no state write
#
set -euo pipefail

KERNEL_URL="${KERNEL_URL:-http://127.0.0.1:4100}"
HEALTH_KEY="${RESTART_DEBT_KEY:-restart-debt}"
STATE_FILE="${RESTART_DEBT_STATE:-/var/lib/nanoclaw/restart-debt.state}"
WARN_AFTER_DAYS="${RESTART_DEBT_WARN_DAYS:-7}"
NEEDRESTART_BIN="${NEEDRESTART_BIN:-/usr/sbin/needrestart}"
CURL_TIMEOUT="${RESTART_DEBT_CURL_TIMEOUT:-10}"

# Keep `detail` short — it is a dashboard string, not a report.
MAX_NAMES=8

DRY_RUN=0
case "${1:-}" in
  --dry-run) DRY_RUN=1 ;;
  '') ;;
  *) echo "usage: $(basename "$0") [--dry-run]" >&2; exit 64 ;;
esac

log() { echo "needrestart-probe: $*" >&2; }

if [ ! -x "$NEEDRESTART_BIN" ]; then
  log "needrestart not found at $NEEDRESTART_BIN"
  exit 2
fi
if [ "${EUID:-$(id -u)}" -ne 0 ]; then
  # Non-root needrestart only sees the caller's own processes, so the service
  # list would be wrong (and quietly short) rather than merely incomplete.
  log "must run as root to see system services"
  exit 3
fi

# needrestart exits non-zero in some modes; we only care about its stdout.
raw="$("$NEEDRESTART_BIN" -b 2>/dev/null || true)"
if [ -z "$raw" ]; then
  log "needrestart -b produced no output"
  exit 2
fi

# --- parse -------------------------------------------------------------------
# NEEDRESTART-KSTA: 0 unknown / 1 no upgrade / 2 ABI upgrade / 3 version upgrade
# (NeedRestart/Kernel.pm: NRK_UNKNOWN..NRK_VERUPGRADE).
ksta="$(printf '%s\n' "$raw" | awk -F': *' '/^NEEDRESTART-KSTA:/ {print $2; exit}')"
ksta="${ksta:-0}"

services=()
while IFS= read -r line; do
  [ -n "$line" ] && services+=("$line")
done < <(printf '%s\n' "$raw" | awk -F': *' '/^NEEDRESTART-SVC:/ {print $2}' | sort -u)
svc_count="${#services[@]}"

case "$ksta" in
  2) kernel_txt="kernel: ABI upgrade pending"; kernel_debt=1 ;;
  3) kernel_txt="kernel: version upgrade pending"; kernel_debt=1 ;;
  1) kernel_txt="kernel: up to date"; kernel_debt=0 ;;
  *) kernel_txt="kernel: unknown"; kernel_debt=0 ;;
esac

has_debt=0
[ "$svc_count" -gt 0 ] && has_debt=1
[ "$kernel_debt" -eq 1 ] && has_debt=1

# --- debt age ----------------------------------------------------------------
# One line, `first_seen=<epoch seconds>`. first_seen tracks when debt APPEARED
# and is held for as long as ANY debt is outstanding — ruling 2-4 bounds "the
# debt", not each individual package, so new debt arriving on top of old must
# not reset the clock. Cleared only when the debt reaches zero.
#
# The state file lives outside the repo and outside the backup set on purpose:
# losing it costs at most one reset of the age counter, which the next run
# re-establishes.
now="$(date +%s)"
first_seen="$now"
age_days=0

if [ "$has_debt" -eq 1 ]; then
  if [ -r "$STATE_FILE" ]; then
    prev="$(awk -F= '/^first_seen=/ {print $2; exit}' "$STATE_FILE" 2>/dev/null || true)"
    case "$prev" in
      ''|*[!0-9]*) prev="" ;;
    esac
    [ -n "$prev" ] && first_seen="$prev"
  fi
  age_days=$(( (now - first_seen) / 86400 ))
  [ "$age_days" -lt 0 ] && age_days=0
  if [ "$DRY_RUN" -eq 0 ]; then
    mkdir -p "$(dirname "$STATE_FILE")"
    tmp="$STATE_FILE.tmp.$$"
    {
      echo "first_seen=$first_seen"
      echo "last_seen=$now"
      echo "services=$(IFS=,; echo "${services[*]:-}")"
      echo "ksta=$ksta"
    } > "$tmp"
    mv -f "$tmp" "$STATE_FILE"
  fi
elif [ "$DRY_RUN" -eq 0 ]; then
  rm -f "$STATE_FILE"
fi

# --- status + detail ---------------------------------------------------------
if [ "$has_debt" -eq 0 ]; then
  status="ok"
  detail="no restart debt; $kernel_txt"
else
  if [ "$age_days" -ge "$WARN_AFTER_DAYS" ]; then
    status="warn"
  else
    status="ok"
  fi
  if [ "$svc_count" -gt 0 ]; then
    if [ "$svc_count" -gt "$MAX_NAMES" ]; then
      names="$(IFS=,; echo "${services[*]:0:$MAX_NAMES}"), +$((svc_count - MAX_NAMES)) more"
    else
      names="$(IFS=,; echo "${services[*]}")"
    fi
    svc_txt="$svc_count service(s) pending restart: $names"
  else
    svc_txt="0 services pending restart"
  fi
  detail="$kernel_txt; $svc_txt; debt age ${age_days}d (warn at ${WARN_AFTER_DAYS}d)"
fi

json_escape() { printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g'; }
payload="{\"status\":\"$status\",\"detail\":\"$(json_escape "$detail")\"}"

if [ "$DRY_RUN" -eq 1 ]; then
  echo "PUT $KERNEL_URL/system-health/$HEALTH_KEY"
  echo "$payload"
  exit 0
fi

if ! curl -fsS -m "$CURL_TIMEOUT" \
     -X PUT "$KERNEL_URL/system-health/$HEALTH_KEY" \
     -H 'content-type: application/json' \
     --data "$payload" >/dev/null; then
  # A kernel outage must not lose the reading: the state file already holds
  # first_seen, so tomorrow's run reports the same debt with a correct age.
  log "PUT failed (kernel unreachable?) — will report again on the next run"
  exit 1
fi

log "reported status=$status ($detail)"
