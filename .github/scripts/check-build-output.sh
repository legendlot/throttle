#!/usr/bin/env bash
# Fails the build on Next.js warnings that are actually RUNTIME CRASHES.
#
# `import { x } from '…'` where `x` isn't exported leaves `x` as **undefined**.
# Next.js reports "Attempted import error" as a WARNING and the build still
# EXITS 0, so turbo reports success, the deploy goes green, and the page throws
# a TypeError the moment `x` is called.
#
# This is not hypothetical. It white-screened three live financial documents for
# ~8 WEEKS: the printed GST invoice and both credit-note pages imported `fmtDate`
# from `@/lib/sales`, which never exported it (it lives in `@/lib/snorkelui`).
# Every deploy in that window reported "12 successful". Found 2026-07-29 only
# because someone happened to open the printed invoice.
#
# CORE.md's rule is "read the build output, don't just check the exit code" — this
# is that rule made mechanical, because a rule a human has to remember is exactly
# what failed here.
#
# Usage: bash .github/scripts/check-build-output.sh <build-log>

set -uo pipefail

LOG="${1:?usage: check-build-output.sh <build-log>}"

if [[ ! -f "$LOG" ]]; then
  echo "::warning title=Build check::build log '$LOG' not found — skipping the import-error check."
  exit 0
fi

# Patterns that Next.js/webpack emit as warnings while still exiting 0.
# Deliberately NOT including "Module not found" — that already fails the build
# on its own, so adding it here would only duplicate an existing hard error.
PATTERNS='Attempted import error|export .* was not found in'

if grep -nE "$PATTERNS" "$LOG" > /tmp/import-errors.txt 2>/dev/null; then
  echo "::error title=Build check::Attempted-import error detected — this exits 0 but CRASHES AT RUNTIME."
  echo
  echo "─────────────────────────────────────────────────────────────────"
  echo " These imports resolve to \`undefined\`. The page will throw a"
  echo " TypeError the first time the value is used — usually a white"
  echo " screen, and usually not on the path anyone tests."
  echo "─────────────────────────────────────────────────────────────────"
  cat /tmp/import-errors.txt
  echo "─────────────────────────────────────────────────────────────────"
  echo " Fix: import the symbol from the module that actually exports it,"
  echo " or add the missing export. Do not silence this check — an 8-week"
  echo " white-screen on the printed GST invoice is why it exists."
  echo "─────────────────────────────────────────────────────────────────"
  exit 1
fi

echo "Build output clean — no attempted-import errors."
