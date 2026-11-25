#!/bin/bash
# tools/measure.sh <label>: runs every suite of `test:offline` ALONE, in the package.json order, and writes <run-logs>/ci/<label>.csv (suite,seconds,PASS,FAIL,SKIP,exit)
# and <run-logs>/ci/<label>.txt (every PASS / FAIL / SKIP line, prefixed with the suite name, sorted). <run-logs> is run-logs/ in the repository (git-ignored), or PG_RUN_LOGS.
# It works from any folder: the repository is the folder above this file. Nothing else may run meanwhile.
set -u
L=${1:?label}; REPO=$(cd "$(dirname "$0")/.." && pwd); OUT=${PG_RUN_LOGS:-$REPO/run-logs}/ci; mkdir -p "$OUT"; cd "$REPO" || exit 2
CSV=$OUT/$L.csv; RAW=$OUT/$L.raw; : > "$RAW"; echo "suite,seconds,PASS,FAIL,SKIP,exit" > "$CSV"
node -e "const s=require('./package.json').scripts['test:offline'].split('&&').map(x=>x.trim()).filter(x=>x.startsWith('npm run ')).map(x=>x.slice(8));console.log(s.join('\n'))" > "$OUT/$L.suites"
T0=$(date +%s.%N)
while read -r S; do
  A=$(date +%s.%N); OUTP=$(npm run -s "$S" 2>&1); RC=$?; B=$(date +%s.%N)
  P=$(printf '%s\n' "$OUTP" | grep -c '^PASS'); F=$(printf '%s\n' "$OUTP" | grep -c '^FAIL'); K=$(printf '%s\n' "$OUTP" | grep -c '^SKIP')
  printf '%s,%.1f,%s,%s,%s,%s\n' "$S" "$(echo "$B - $A" | bc)" "$P" "$F" "$K" "$RC" >> "$CSV"
  printf '%s\n' "$OUTP" | grep -E '^(PASS|FAIL|SKIP)' | sed "s|^|$S\t|" >> "$RAW"
  echo "$(date +%T) $S ${RC} $P/$F/$K" >> "$OUT/$L.progress"
done < "$OUT/$L.suites"
sort "$RAW" > "$OUT/$L.txt"
echo "total seconds: $(echo "$(date +%s.%N) - $T0" | bc)" > "$OUT/$L.total"
echo "PASS=$(grep -c "	PASS" "$OUT/$L.txt") FAIL=$(grep -c "	FAIL" "$OUT/$L.txt") SKIP=$(grep -c "	SKIP" "$OUT/$L.txt")" >> "$OUT/$L.total"
