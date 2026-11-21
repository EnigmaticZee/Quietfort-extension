#!/usr/bin/env bash
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.
#
# Monthly health check for the Quietfort browser extensions. Run from the repo
# root: `scripts/monthly-check.sh` (add --e2e to also run the Chrome suite).
# Reports only; it never updates or changes anything. Writes a plain-language
# summary to reports/monthly-check-<date>.md and the full logs next to it.
set -uo pipefail
cd "$(dirname "$0")/.."
DATE=$(date +%F)
LOGS="reports/monthly-check-$DATE-logs"
OUT="reports/monthly-check-$DATE.md"
mkdir -p "$LOGS"
rows=()
add() { rows+=("| $1 | $2 | $3 | $4 |"); }
run() { local name=$1; shift; bash -c "$*" >"$LOGS/$name.log" 2>&1; }

# 1. Security advisories in what we ship (npm, production dependencies only)
if run npm-audit "cd extensions && npm audit --omit=dev"; then add "Security" "npm audit (shipped deps)" OK "no advisories"
else add "Security" "npm audit (shipped deps)" ATTENTION "advisory found: update or replace the package (see $LOGS/npm-audit.log)"; fi

# 2. Licences (no GPL code bundled)
if run licenses "cd extensions && npm run -s licenses"; then add "Licences" "bundled code licences" OK "permissive only"
else add "Licences" "bundled code licences" ATTENTION "a dependency has a licence we can't ship ($LOGS/licenses.log)"; fi

# 3. Updates available (report only)
run npm-outdated "cd extensions && npm outdated" || true
n=$(grep -cvE '^Package' "$LOGS/npm-outdated.log" 2>/dev/null || echo 0)
add "Updates" "npm packages with newer versions" NOTE "$n (see $LOGS/npm-outdated.log)"

# 4. Tests
if run unit "cd extensions && npm test"; then add "Tests" "unit tests + typecheck + build" OK "$(grep -E '^ℹ (pass|fail)' "$LOGS/unit.log" | paste -sd ' ' -)"
else add "Tests" "unit tests + typecheck + build" ATTENTION "failing ($LOGS/unit.log)"; fi
if run lint-firefox "cd extensions && npm run -s lint:firefox"; then add "Tests" "Firefox add-on lint" OK ""
else add "Tests" "Firefox add-on lint" ATTENTION "$LOGS/lint-firefox.log"; fi
if [[ " $* " == *" --e2e "* ]]; then
  if run e2e-chrome "cd extensions && npm run test:e2e:chrome"; then add "Tests" "Chrome end-to-end" OK "$(tail -1 "$LOGS/e2e-chrome.log")"
  else add "Tests" "Chrome end-to-end" ATTENTION "$(tail -1 "$LOGS/e2e-chrome.log")"; fi
fi

# 5. Filter-list health: every catalogue URL still downloads
(cd extensions && node --experimental-strip-types -e "import('./src/shared/catalogue.ts').then(m => { for (const e of m.CATALOGUE) console.log(e.id + '\t' + e.url) })") > "$LOGS/catalogue.tsv" 2>&1
bad=0; total=0
while IFS=$'\t' read -r id url; do
  [ -z "$url" ] && continue; total=$((total+1))
  code=$(curl -4 -sS -o /dev/null -w '%{http_code}' --max-time 30 -A 'quietfort-monthly-check' "$url" 2>/dev/null)
  echo "$code $id $url" >> "$LOGS/list-downloads.log"
  [ "$code" = 200 ] || bad=$((bad+1))
done < "$LOGS/catalogue.tsv"
if [ "$bad" = 0 ]; then add "Filter lists" "catalogue downloads" OK "$total of $total lists download"
else add "Filter lists" "catalogue downloads" ATTENTION "$bad of $total failed: find the list's new URL or drop it ($LOGS/list-downloads.log)"; fi

# 6. Versions (information only)
add "Versions" "tools" NOTE "Node $(node --version 2>/dev/null), Chrome $(defaults read '/Applications/Google Chrome.app/Contents/Info' CFBundleShortVersionString 2>/dev/null), Firefox $(defaults read /Applications/Firefox.app/Contents/Info CFBundleShortVersionString 2>/dev/null)"

{
  echo "# Monthly check, $DATE"
  echo
  echo "| Area | Check | Status | Details |"
  echo "|---|---|---|---|"
  printf '%s\n' "${rows[@]}"
} > "$OUT"
cat "$OUT"
grep -q ATTENTION "$OUT" && exit 1 || exit 0
