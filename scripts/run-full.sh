#!/bin/bash
# run-full.sh <label> [--dry-run]: ONE full verification run, on a snapshot of the WORKING TREE.
#
# What it does
#   1. checks the Docker state against the KNOWN baseline (below); if it is not the baseline, it stops (exit 3) and runs nothing
#   2. snapshots the working tree (tracked + untracked files, .gitignore respected) with a temporary git index (GIT_INDEX_FILE, a SEPARATE file) and `git archive`;
#      the real index and the working tree are not touched. The folders run-logs/, issues/ and plugin-guard-reports/ are left out TWICE (the .gitignore of the
#      repository, and an explicit path rule), then removed from the snapshot once more if they are there: the snapshot never copies itself or client data
#   3. puts a real copy of node_modules and data/ocr into the snapshot
#   4. runs `npm test` (test:offline, then test:docker) in the snapshot
#   5. checks the Docker state again and writes the verdict
#
# Docker baseline (this machine, known values): 5 containers, 0 labelled pg.sandbox=1, 11 volumes.
#   The ONLY authority is BASE below. The file run-logs/docker-baseline.txt is written for a person to read and is never read back by this script.
#   A run is VALID only if test.exit says "test exit 0" AND the state after the run equals the baseline.
#
# Where it logs: <repo>/run-logs/<label>/  (git-ignored; started.txt, tree.sha, progress.txt, test.log, test.exit, result.txt; the snapshot is in tree/)
#   PG_RUN_LOGS=<folder> puts the logs somewhere else.
#
# Options
#   --dry-run   steps 1 to 3 only, then a tiny check instead of `npm test`: it proves the snapshot has no run-logs/, issues/, plugin-guard-reports/, .env or *.sql,
#               that the real git index was not touched, and that the log is written; result.txt says "DRY-RUN OK". It never judges the Docker state.
#   PG_TIMED=1  every line of test.log starts with the time (HH:MM:SS), so the time of each suite can be read
#
# ONE RUN AT A TIME. The Docker suites cannot overlap; it refuses to start while another run-full.sh holds the lock (run-logs/.run-full.lock).
# Only the runner role starts it (docs/WORKFLOW.md). Run it in the background and wait for result.txt.
# Never run a docker prune: leftovers are looked at by hand.
#
# Optional, never stored in the repo: if run-logs/env.sh exists it is read INSIDE the subshell that runs the tests, and nowhere else (for example the variables of the
# seeded-bug test on a real site; without them that test skips, loudly). The owner puts that file there by hand.
set -u
[ $# -ge 1 ] || { echo "usage: scripts/run-full.sh <label> [--dry-run]" >&2; exit 2; }
L=$1; OPT=${2:-}
case "$OPT" in ""|--dry-run) ;; *) echo "unknown option: $OPT (only --dry-run)" >&2; exit 2;; esac
case "$L" in *[!A-Za-z0-9._-]*|""|.|..) echo "label: letters, digits, . _ - only (and not . or ..)" >&2; exit 2;; esac

REPO=$(cd "$(dirname "$0")/.." && pwd -P)
# the log folder: an ABSOLUTE path with every symbolic link resolved (realpath -m: it need not exist yet, so nothing is created before the check);
# inside the repository only run-logs/ is allowed (it is git-ignored and left out of the snapshot), and never a folder that holds the repository (also not /)
WANT=${PG_RUN_LOGS:-$REPO/run-logs}; LOGS=$(realpath -m -- "$WANT") || exit 2
case "$LOGS/" in "$REPO/run-logs/"|"$REPO/run-logs/"*) ;; "$REPO/"*) echo "PG_RUN_LOGS must not be inside the repository (except run-logs/): $LOGS" >&2; exit 2;; esac
if [ "$LOGS" = / ]; then echo "PG_RUN_LOGS must not hold the repository: $LOGS" >&2; exit 2; fi
case "$REPO/" in "$LOGS/"*) echo "PG_RUN_LOGS must not hold the repository: $LOGS" >&2; exit 2;; esac
RUN=$LOGS/$L; SNAP=$RUN/tree
mkdir -p "$LOGS" || exit 2

# another run? One lock file for all runs; the lock is released when this script ends, for any reason.
exec 9>"$LOGS/.run-full.lock"
flock -n 9 || { echo "another run-full.sh is running: one run at a time" >&2; exit 3; }

# the baseline and the mode are fixed here, read-only. run-logs/env.sh is NOT read by this shell: it is read only inside the subshell that runs the tests (below), so
# nothing in it (an assignment, a "readonly", a function named docker) can change the Docker baseline, the Docker check or the mode
BASE="5 0 11"; DRY=0; [ "$OPT" = "--dry-run" ] && DRY=1
readonly BASE DRY
[ -f "$LOGS/docker-baseline.txt" ] || echo "containers=5 labelled=0 volumes=11" > "$LOGS/docker-baseline.txt"   # for a person to read; never read back here
dstate() { echo "$(docker ps -aq 2>/dev/null | wc -l) $(docker ps -aq --filter label=pg.sandbox=1 2>/dev/null | wc -l) $(docker volume ls -q 2>/dev/null | wc -l)"; }

mkdir -p "$RUN"; rm -f "$RUN/test.exit" "$RUN/result.txt" "$RUN/test.log"; date -Is > "$RUN/started.txt"
BEFORE=$(dstate)
echo "docker before: containers/labelled/volumes = $BEFORE (baseline $BASE)" > "$RUN/progress.txt"
if [ "$DRY" = 0 ] && [ "$BEFORE" != "$BASE" ]; then
  echo "docker state before the run is not the baseline: STOPPED, nothing was run" | tee -a "$RUN/progress.txt" >&2
  echo "run NOT started (docker before $BEFORE, baseline $BASE)" > "$RUN/result.txt"; exit 3
fi

rm -rf "$SNAP"; mkdir -p "$SNAP"
cd "$REPO"
INDEX_BEFORE=$(sha256sum "$(git rev-parse --git-dir)/index" 2>/dev/null | cut -d' ' -f1)
export GIT_INDEX_FILE="$RUN/index.tmp"; rm -f "$GIT_INDEX_FILE"
git add -A -- . ':!run-logs' ':!issues' ':!plugin-guard-reports' >/dev/null 2>&1; TREE=$(git write-tree); echo "$TREE" > "$RUN/tree.sha"
git archive "$TREE" | tar -xf - -C "$SNAP"
unset GIT_INDEX_FILE; rm -f "$RUN/index.tmp"
rm -rf "$SNAP/run-logs" "$SNAP/issues" "$SNAP/plugin-guard-reports"   # a second time, in case one of them was tracked
INDEX_AFTER=$(sha256sum "$(git rev-parse --git-dir)/index" 2>/dev/null | cut -d' ' -f1)
echo "git index of the repository: ${INDEX_BEFORE:-none} before, ${INDEX_AFTER:-none} after" >> "$RUN/progress.txt"
cp -a node_modules "$SNAP/node_modules"
mkdir -p "$SNAP/data/ocr"; cp -a data/ocr/. "$SNAP/data/ocr/"
cd "$SNAP"
echo "test started $(date -Is)" >> "$RUN/progress.txt"

if [ "$DRY" = 1 ]; then
  BAD=""
  for d in run-logs issues plugin-guard-reports; do [ -e "$SNAP/$d" ] && BAD="$BAD $d"; done
  [ -n "$(find "$SNAP" -path "$SNAP/node_modules" -prune -o \( -name '.env' -o -name '.env.*' -o -name '*.sql' -o -name '*.sql.gz' \) ! -name '.env.example' -print -quit 2>/dev/null)" ] && BAD="$BAD secrets-or-dumps"
  [ "$INDEX_BEFORE" = "$INDEX_AFTER" ] || BAD="$BAD real-git-index-changed"
  TINY="npm run selftest:hygiene"
else
  TINY="npm test"
fi
# the tests run in a subshell that first reads run-logs/env.sh (the variables of the seeded-bug test on a real site; without them that test skips, loudly)
# Three guards against an env.sh that does not behave (the file is the owner's own, so this is about mistakes, but the gate must not say VALID by mistake):
#   - `cd "$SNAP"` AFTER env.sh: the tests always run in the snapshot (npm looks for package.json upwards, so another folder would run them in the real repository);
#   - `builtin command` skips a function named npm; the marker file proves that env.sh did not end the subshell before the tests started (exit 97 if it did);
#   - a run is accepted only if test.log holds at least one PASS line (exit 98 if not): a function that fakes `command` or exits early leaves no suite output.
rm -f "$RUN/tests.started"
if [ "${PG_TIMED:-}" = 1 ]; then
  ( [ -f "$LOGS/env.sh" ] && . "$LOGS/env.sh"; cd "$SNAP" || exit 96; touch "$RUN/tests.started"; builtin command $TINY 2>&1 ) | awk '{ print strftime("%H:%M:%S"), $0; fflush() }' > "$RUN/test.log"; CODE=${PIPESTATUS[0]}
else
  ( [ -f "$LOGS/env.sh" ] && . "$LOGS/env.sh"; cd "$SNAP" || exit 96; touch "$RUN/tests.started"; builtin command $TINY ) > "$RUN/test.log" 2>&1; CODE=$?
fi
if [ ! -f "$RUN/tests.started" ]; then CODE=97; echo "the tests did not start: run-logs/env.sh ended the shell before them" >> "$RUN/test.log"
elif [ "$CODE" = 0 ] && ! grep -qE '(^|[0-9:]+ )PASS' "$RUN/test.log"; then CODE=98; echo "the test output holds no PASS line: the tests did not really run" >> "$RUN/test.log"; fi
echo "test exit $CODE" | tee -a "$RUN/test.log" > "$RUN/test.exit"
echo "test finished $(date -Is)" >> "$RUN/progress.txt"

if [ "$DRY" = 1 ]; then
  if [ -z "$BAD" ] && [ "$CODE" = 0 ]; then echo "DRY-RUN OK: snapshot clean, real git index untouched, tiny check exit 0 (docker state $BEFORE not judged)" > "$RUN/result.txt"
  else echo "DRY-RUN NOT OK:${BAD:- nothing found in the snapshot,} tiny check exit $CODE" > "$RUN/result.txt"; fi
  echo "run finished $(date -Is)" >> "$RUN/progress.txt"
  grep -q '^DRY-RUN OK' "$RUN/result.txt"; exit $?   # exit 0 only when the dry run is OK
fi
AFTER=$(dstate)
echo "docker after: containers/labelled/volumes = $AFTER (baseline $BASE)" >> "$RUN/progress.txt"
if [ "$CODE" = 0 ] && [ "$AFTER" = "$BASE" ]; then echo "run VALID: test exit 0, docker back at baseline ($AFTER)" > "$RUN/result.txt"
else echo "run NOT valid: test exit $CODE, docker after $AFTER, baseline $BASE" > "$RUN/result.txt"; fi
echo "run finished $(date -Is)" >> "$RUN/progress.txt"
