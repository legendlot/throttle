#!/usr/bin/env bash
# Post-deploy guard: a green gh-pages push is NOT a live deploy.
#
# PATTERN-168. The deploy action pushes the export to the target repo's gh-pages
# branch and reports success. GitHub Pages then runs its OWN build, asynchronously,
# and that build can silently ERROR — leaving the last-good version live while every
# signal we look at says the deploy worked.
#
# It has happened twice:
#   2026-07-02  one push-wave errored Pages for FIVE targets at once (redline, depot,
#               ignition, podium, docket) -> 2 days of stale live sites. Reported by
#               the floor as "Attendance & OT not showing", not by any alert.
#   2026-07-23  relay: gh-pages HEAD updated, Pages silently didn't build it. Caught
#               only because that one deploy happened to be live-verified by hand.
# Both were fixed the same way: re-request the Pages build. So this script detects
# and then applies exactly that remediation, in the same run that caused it.
#
# Usage:  bash .github/scripts/verify-pages.sh <owner/repo>
# Needs:  GH_TOKEN with Pages access to <owner/repo>.
#
# ⚠️ FAIL-SOFT ON AUTH, BY DESIGN. If the token cannot read the Pages API this warns
# and exits 0. A monitoring gap must never become a deployment outage — the deploy
# itself already succeeded by the time we run, and failing here would only make the
# Actions run red without changing what is live.

set -uo pipefail

TARGET="${1:?usage: verify-pages.sh <owner/repo>}"
: "${GH_TOKEN:?GH_TOKEN not set}"

API="https://api.github.com/repos/${TARGET}/pages/builds"
MAX_POLLS=20        # x 15s = up to 5 minutes
SLEEP=15

# To STDERR, deliberately. settle()'s status is read via $(settle), which captures
# stdout — so anything logged on stdout would be swallowed by that capture instead of
# appearing in the Actions log, silently losing every diagnostic this script exists to
# produce. stderr still shows in the log and stays out of the captured value.
note()  { echo "::notice title=Pages::$*"  >&2; }
warn()  { echo "::warning title=Pages::$*" >&2; }
fail()  { echo "::error title=Pages::$*"   >&2; }

# Echoes "<http_code>|<status>|<error_message>"
probe() {
  local body code
  body="$(curl -sS -w $'\n%{http_code}' \
    -H "Authorization: Bearer ${GH_TOKEN}" \
    -H "Accept: application/vnd.github+json" \
    -H "X-GitHub-Api-Version: 2022-11-28" \
    "${API}/latest" 2>/dev/null)" || { echo "000||curl failed"; return; }
  code="$(printf '%s' "$body" | tail -n1)"
  body="$(printf '%s' "$body" | sed '$d')"
  local status msg
  status="$(printf '%s' "$body" | python3 -c 'import sys,json
try: print(json.load(sys.stdin).get("status") or "")
except Exception: print("")' 2>/dev/null)"
  msg="$(printf '%s' "$body" | python3 -c 'import sys,json
try:
    d=json.load(sys.stdin); e=d.get("error") or {}
    print((e.get("message") or d.get("message") or "").replace("\n"," "))
except Exception: print("")' 2>/dev/null)"
  echo "${code}|${status}|${msg}"
}

rebuild() {
  curl -sS -o /dev/null -X POST \
    -H "Authorization: Bearer ${GH_TOKEN}" \
    -H "Accept: application/vnd.github+json" \
    -H "X-GitHub-Api-Version: 2022-11-28" \
    "${API}" 2>/dev/null
}

# Wait for Pages to settle, then report. Echoes the terminal status.
settle() {
  local i out code status msg
  for ((i = 1; i <= MAX_POLLS; i++)); do
    out="$(probe)"
    code="${out%%|*}"; out="${out#*|}"
    status="${out%%|*}"; msg="${out#*|}"

    case "$code" in
      200) ;;
      401|403)
        warn "cannot read the Pages API for ${TARGET} (HTTP ${code}). Skipping the check — the deploy itself was fine. If this persists, give DEPLOY_TOKEN Pages access."
        echo "skipped"; return ;;
      404)
        warn "no Pages build found for ${TARGET} (HTTP 404). Either Pages is not enabled there, or it has never built. Skipping."
        echo "skipped"; return ;;
      000)
        warn "network error reaching the Pages API (attempt ${i}/${MAX_POLLS}); retrying."
        sleep "$SLEEP"; continue ;;
      *)
        warn "unexpected HTTP ${code} from the Pages API; retrying (${i}/${MAX_POLLS})."
        sleep "$SLEEP"; continue ;;
    esac

    case "$status" in
      built)   note "${TARGET}: Pages build succeeded — the push is genuinely live."
               echo "built"; return ;;
      errored) fail "${TARGET}: Pages build ERRORED${msg:+ — $msg}"
               echo "errored"; return ;;
      building|queued|"")
               sleep "$SLEEP"; continue ;;
      *)       warn "${TARGET}: unrecognised Pages status '${status}'; treating as pending."
               sleep "$SLEEP"; continue ;;
    esac
  done
  warn "${TARGET}: Pages build did not finish within $((MAX_POLLS * SLEEP))s. Not failing the deploy — check https://github.com/${TARGET}/deployments"
  echo "timeout"
}

echo "Verifying GitHub Pages actually published for ${TARGET}…" >&2
result="$(settle | tail -n1)"

case "$result" in
  built|skipped|timeout)
    exit 0 ;;
  errored)
    warn "${TARGET}: re-requesting the Pages build (this is the fix applied by hand on 2026-07-02 and 2026-07-23)."
    rebuild
    sleep "$SLEEP"
    retry="$(settle | tail -n1)"
    if [[ "$retry" == "built" ]]; then
      note "${TARGET}: recovered — the re-requested Pages build succeeded. Live is current."
      exit 0
    fi
    fail "${TARGET}: Pages STILL not built after a re-request (${retry}). LIVE IS STALE — it is serving the previous build. Open https://github.com/${TARGET}/deployments"
    exit 1 ;;
  *)
    warn "${TARGET}: unexpected verifier result '${result}'; not failing the deploy."
    exit 0 ;;
esac
