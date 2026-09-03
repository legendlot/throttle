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

# ⚠️ RE-REQUEST BACKOFF. This used to be a single `sleep 15` after the rebuild, which is far
# too soon to work: measured 2026-08-27 (S317) on pitstop, the auto-retry fired 16s after the
# first failure and errored identically, burning the only retry — then the IDENTICAL request,
# issued by hand ~10 minutes later with no other change, built first time. Detection was never
# the problem; remediation was sampling the same transient window.
# ⚠️ Two tries with real gaps, NOT a tight loop: the S313 ignition case had 12 Pages runs queued
# against 0 in progress, so hammering makes it worse. Bounded post-retry polling keeps the
# worst-case Action time sane (~13 min) rather than 3 full 5-minute settles.
RETRY_BACKOFFS=(90 240)   # seconds to wait AFTER each re-request before looking again
RETRY_POLLS=8             # x 15s = 2 min of polling per retry attempt

# To STDERR, deliberately. settle()'s status is read via $(settle), which captures
# stdout — so anything logged on stdout would be swallowed by that capture instead of
# appearing in the Actions log, silently losing every diagnostic this script exists to
# produce. stderr still shows in the log and stays out of the captured value.
note()  { echo "::notice title=Pages::$*"  >&2; }
warn()  { echo "::warning title=Pages::$*" >&2; }
fail()  { echo "::error title=Pages::$*"   >&2; }

# ⛔ THE RACE THIS SCRIPT USED TO LOSE, AND THE WHOLE REASON IT WATCHES A SHA NOW.
#
# It polled `${API}/latest` and asked only "is the newest Pages build green?" — never "is the
# newest Pages build MINE?". Pages does not create the build for a push instantly, so the first
# probe lands while /latest is still the PREVIOUS, successful build. The script reads `built`,
# announces "the push is genuinely live", and exits 0. Pages then builds our commit and errors.
#
# Measured 2026-08-06 on relay: Action green, gh-pages holding the new chunk, Pages build
# `errored` with duration 0 — live served the previous day's bundle for ~25 minutes with nothing
# red anywhere. The verifier did not miss the failure; it reported success BEFORE the failure
# existed, which is worse, because the retry/rebuild machinery below never got a chance to run.
#
# Fix: resolve the gh-pages HEAD sha we just pushed, then evaluate ONLY the build whose `commit`
# equals it. A green build for someone else's commit is now "still pending", not proof.
# Verified 2026-09-03: `pages/builds[].commit` is the full gh-pages sha and matches
# `commits/gh-pages.sha` exactly.
EXPECTED_SHA="$(curl -sS \
  -H "Authorization: Bearer ${GH_TOKEN}" \
  -H "Accept: application/vnd.github+json" \
  -H "X-GitHub-Api-Version: 2022-11-28" \
  "https://api.github.com/repos/${TARGET}/commits/gh-pages" 2>/dev/null \
  | python3 -c 'import sys,json
try: print(json.load(sys.stdin).get("sha") or "")
except Exception: print("")' 2>/dev/null)"

if [ -n "$EXPECTED_SHA" ]; then
  note "${TARGET}: watching gh-pages commit ${EXPECTED_SHA:0:8} — a build for any other commit does not count."
else
  # Never harden a monitoring gap into an outage: if we cannot read the sha we fall back to the
  # old newest-build behaviour, but say plainly that the race is back for this run.
  warn "${TARGET}: could not resolve the gh-pages HEAD sha; falling back to the NEWEST build, which can race (a previous green build may be reported as ours). Give DEPLOY_TOKEN contents access to remove this."
fi

# Echoes "<http_code>|<status>|<error_message>"
# `status` is the status of OUR build; "pending_ours" means Pages has not created it yet.
probe() {
  local body code
  body="$(curl -sS -w $'\n%{http_code}' \
    -H "Authorization: Bearer ${GH_TOKEN}" \
    -H "Accept: application/vnd.github+json" \
    -H "X-GitHub-Api-Version: 2022-11-28" \
    "${API}?per_page=20" 2>/dev/null)" || { echo "000||curl failed"; return; }
  code="$(printf '%s' "$body" | tail -n1)"
  body="$(printf '%s' "$body" | sed '$d')"
  local parsed
  parsed="$(printf '%s' "$body" | EXPECTED_SHA="$EXPECTED_SHA" python3 -c '
import sys, json, os
want = os.environ.get("EXPECTED_SHA") or ""
try:
    builds = json.load(sys.stdin)
    if not isinstance(builds, list): raise ValueError
except Exception:
    print("|"); sys.exit()
# newest-first, so the FIRST match is the most recent build of our commit — which is what we
# want after a re-request, since a rebuild produces a second build for the same sha.
pick = None
if want:
    for b in builds:
        if (b.get("commit") or "") == want:
            pick = b; break
    if pick is None:
        print("pending_ours|"); sys.exit()
else:
    pick = builds[0] if builds else None
    if pick is None:
        print("pending_ours|"); sys.exit()
err = pick.get("error") or {}
msg = (err.get("message") or "").replace("\n", " ")
# ⚠️ Plain concatenation, NOT an f-string with escaped quotes. `f"{d.get(\"k\")}"` is a syntax
# error on Python < 3.12, and with stderr suppressed it fails silently: the parse returns empty,
# empty reads as "pending", and the verifier polls to timeout on a build that is already green.
# Cost one full 300s false timeout while testing this very fix on 2026-09-03.
status = pick.get("status") or ""
print(status + "|" + msg)
' 2>/dev/null)"
  local status="${parsed%%|*}" msg="${parsed#*|}"
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
  local budget="${1:-$MAX_POLLS}"
  local i out code status msg
  for ((i = 1; i <= budget; i++)); do
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
        warn "network error reaching the Pages API (attempt ${i}/${budget}); retrying."
        sleep "$SLEEP"; continue ;;
      *)
        warn "unexpected HTTP ${code} from the Pages API; retrying (${i}/${budget})."
        sleep "$SLEEP"; continue ;;
    esac

    case "$status" in
      built)   note "${TARGET}: Pages build succeeded — the push is genuinely live."
               echo "built"; return ;;
      errored) fail "${TARGET}: Pages build ERRORED${msg:+ — $msg}"
               echo "errored"; return ;;
      building|queued|"")
               sleep "$SLEEP"; continue ;;
      # Pages has not created OUR build yet. This is the state that used to be invisible: the
      # newest build was someone else's green one and the script called it a pass. Keep waiting.
      pending_ours)
               sleep "$SLEEP"; continue ;;
      *)       warn "${TARGET}: unrecognised Pages status '${status}'; treating as pending."
               sleep "$SLEEP"; continue ;;
    esac
  done
  warn "${TARGET}: no COMPLETED Pages build for ${EXPECTED_SHA:0:8} within $((budget * SLEEP))s. Not failing the deploy (a monitoring gap must not become an outage) — but LIVE MAY BE STALE: check https://github.com/${TARGET}/deployments"
  echo "timeout"
}

echo "Verifying GitHub Pages actually published for ${TARGET}…" >&2
result="$(settle | tail -n1)"

case "$result" in
  built|skipped|timeout)
    exit 0 ;;
  errored)
    attempt=0
    for backoff in "${RETRY_BACKOFFS[@]}"; do
      attempt=$((attempt + 1))
      warn "${TARGET}: re-requesting the Pages build (attempt ${attempt}/${#RETRY_BACKOFFS[@]}; this is the fix applied by hand on 2026-07-02 and 2026-07-23)."
      rebuild
      # Waiting BEFORE looking is the whole fix — see RETRY_BACKOFFS above. A re-request
      # checked seconds later just re-observes the same bad window and wastes the attempt.
      note "${TARGET}: waiting ${backoff}s before re-checking (a re-request needs time to leave the failing window)."
      sleep "$backoff"
      retry="$(settle "$RETRY_POLLS" | tail -n1)"
      if [[ "$retry" == "built" ]]; then
        note "${TARGET}: recovered on attempt ${attempt} — the re-requested Pages build succeeded. Live is current."
        exit 0
      fi
      warn "${TARGET}: attempt ${attempt} did not recover (${retry})."
    done
    fail "${TARGET}: Pages STILL not built after ${#RETRY_BACKOFFS[@]} re-requests with backoff. LIVE IS STALE — it is serving the previous build. Re-run this workflow, or re-request the build at https://github.com/${TARGET}/deployments — by hand it has always succeeded once the failing window passed."
    exit 1 ;;
  *)
    warn "${TARGET}: unexpected verifier result '${result}'; not failing the deploy."
    exit 0 ;;
esac
