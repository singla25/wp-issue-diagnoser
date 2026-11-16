#!/bin/bash
# run-full.sh <label>: ONE full verification run, on a snapshot of the WORKING TREE.
#
# What it does
#   1. checks the Docker state against the KNOWN baseline (below); if it is not the baseline, it stops (exit 3) and runs nothing
#   2. snapshots the working tree (tracked + untracked files, .gitignore respected) with a temporary git index and `git archive`;
#      the real index and the working tree are not touched
#   3. puts a real copy of node_modules and data/ocr into the snapshot
#   4. runs `npm test` (test:offline, then test:docker) in the snapshot
#   5. checks the Docker state again and writes the verdict
#
# Docker baseline (this machine, known values): 5 containers, 0 labelled pg.sandbox=1, 11 volumes.
#   It is never learned from a run: ~/pg-runs/docker-baseline.txt is only created with exactly these values.
#   A run is VALID only if test.exit says "test exit 0" AND the state after the run equals the baseline.
#
# Where it logs: ~/pg-runs/<label>/  (started.txt, tree.sha, progress.txt, test.log, test.exit, result.txt; the snapshot is in tree/)
#
# ONE RUN AT A TIME. The Docker suites cannot overlap; it refuses to start while another run-full.sh holds the lock (~/pg-runs/.run-full.lock).
# Only the runner role starts it (docs/WORKFLOW.md). Run it in the background and wait for result.txt.
# Never run a docker prune: leftovers are looked at by hand.
#
# Optional, never stored in the repo: if ~/pg-runs/env.sh exists it is sourced first (for example the variables of the seeded-bug
# test on a real site; without them that test skips, loudly).
set -u
[ $# -ge 1 ] || { echo "usage: scripts/run-full.sh <label>" >&2; exit 2; }
L=$1
case "$L" in *[!A-Za-z0-9._-]*|"") echo "label: letters, digits, . _ - only" >&2; exit 2;; esac

# another run? One lock file for all runs; the lock is released when this script ends, for any reason.
mkdir -p "$HOME/pg-runs"
exec 9>"$HOME/pg-runs/.run-full.lock"
flock -n 9 || { echo "another run-full.sh is running: one run at a time" >&2; exit 3; }

[ -f "$HOME/pg-runs/env.sh" ] && . "$HOME/pg-runs/env.sh"
REPO=$(cd "$(dirname "$0")/.." && pwd); RUN=$HOME/pg-runs/$L; SNAP=$RUN/tree
BASE="5 0 11"
mkdir -p "$HOME/pg-runs"
[ -f "$HOME/pg-runs/docker-baseline.txt" ] || echo "containers=5 labelled=0 volumes=11" > "$HOME/pg-runs/docker-baseline.txt"
dstate() { echo "$(docker ps -aq 2>/dev/null | wc -l) $(docker ps -aq --filter label=pg.sandbox=1 2>/dev/null | wc -l) $(docker volume ls -q 2>/dev/null | wc -l)"; }

mkdir -p "$RUN"; rm -f "$RUN/test.exit" "$RUN/result.txt" "$RUN/test.log"; date -Is > "$RUN/started.txt"
BEFORE=$(dstate)
echo "docker before: containers/labelled/volumes = $BEFORE (baseline $BASE)" > "$RUN/progress.txt"
if [ "$BEFORE" != "$BASE" ]; then
  echo "docker state before the run is not the baseline: STOPPED, nothing was run" | tee -a "$RUN/progress.txt" >&2
  echo "run NOT started (docker before $BEFORE, baseline $BASE)" > "$RUN/result.txt"; exit 3
fi

rm -rf "$SNAP"; mkdir -p "$SNAP"
cd "$REPO"
export GIT_INDEX_FILE="$RUN/index.tmp"; rm -f "$GIT_INDEX_FILE"
git add -A >/dev/null 2>&1; TREE=$(git write-tree); echo "$TREE" > "$RUN/tree.sha"
git archive "$TREE" | tar -xf - -C "$SNAP"
unset GIT_INDEX_FILE; rm -f "$RUN/index.tmp"
cp -a node_modules "$SNAP/node_modules"
mkdir -p "$SNAP/data/ocr"; cp -a data/ocr/. "$SNAP/data/ocr/"
cd "$SNAP"
echo "test started $(date -Is)" >> "$RUN/progress.txt"
npm test > "$RUN/test.log" 2>&1; CODE=$?
echo "test exit $CODE" | tee -a "$RUN/test.log" > "$RUN/test.exit"
echo "test finished $(date -Is)" >> "$RUN/progress.txt"
AFTER=$(dstate)
echo "docker after: containers/labelled/volumes = $AFTER (baseline $BASE)" >> "$RUN/progress.txt"
if [ "$CODE" = 0 ] && [ "$AFTER" = "$BASE" ]; then echo "run VALID: test exit 0, docker back at baseline ($AFTER)" > "$RUN/result.txt"
else echo "run NOT valid: test exit $CODE, docker after $AFTER, baseline $BASE" > "$RUN/result.txt"; fi
echo "run finished $(date -Is)" >> "$RUN/progress.txt"
