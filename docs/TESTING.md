# Testing

## The commands

- `npm test` runs every suite: `npm run test:offline`, then `npm run test:docker`. It stops at the first failing suite.
- `npm run test:offline`: 81 suites that need no Docker (about 14 to 17 minutes on a quiet machine, measured on 2026-11-24 and 25; the 10 Docker suites make 91 in all) (pure logic, a fake `docker`, fixture sites on 127.0.0.1, the browser report checks, the docs and hygiene checks). The newest ones: `selftest:run-full` (`scripts/run-full.sh --dry-run` in a throw-away repository, with a fake `docker`), `selftest:leftovers`, `selftest:report-mask-run` and `selftest:report-mask` (the masking of the shareable files), `selftest:symptom-cnp`, `selftest:browser-error`, `selftest:load-error` (the 4i load-error and browser-error lines) and `selftest:address` (the address check).
- `npm run test:docker`: the 10 suites that start real containers (`selftest:issue-sandbox-docker`, `issue-resolve-docker`, `issue-verify-docker`, `6a-docker`, `6b-docker`, `6c1-docker`, `6c2-docker`, `6d1-docker`, `6d2-docker`, `second-site-docker`). When Docker is not usable they skip, loudly (a SKIP line says why). They need the sandbox images from `npm run setup-sandbox`.
- One suite: a script named `selftest:` plus the suite name (the names are in `package.json`), for example `npm run selftest:docs` or `npm run selftest:hygiene`. Each suite is a standalone script, `scripts/selftest-<name>.js`.

## Not in the chain

- `selftest:isolated-copy` is NOT part of `npm test`. Its premise (copying `src/plugin-guard` out of a larger repository) is gone, because the package is the repository root. C7 replaces it by a clean-checkout test: `git archive` of HEAD in a temp folder, `npm ci`, then the suites. The script stays in `package.json` and is not deleted.
- The suites of the combined tool (`agent1`, `qa-url`, `combined-doctor`, `auto`, `auto-pipeline`, `auto-agent1`, `auto-docker`, `auto-retired-flag`, `auto-diagnosis`) and the old root check `selftest:repo` do not exist in this repository.
- `selftest:hints` skips as a whole here: it compares the hint texts of the old repository layout and says so in one SKIP line.

## The full run

Full runs are done by the runner role only (see [WORKFLOW.md](WORKFLOW.md)), with `scripts/run-full.sh <label>`, in the background, ONE at a time (the Docker suites cannot overlap; the script refuses to start while another run-full.sh is going).

1. It checks the Docker state against the KNOWN baseline of this machine: **5 containers, 0 labelled `pg.sandbox=1`, 11 volumes**. If the state before is different it stops and runs nothing. The baseline is never learned from a run.
2. It snapshots the working tree (tracked and untracked files, `.gitignore` respected) with a temporary git index and `git archive`; the real index is not touched. `node_modules` and `data/ocr/` are copied into the snapshot.
3. It runs `npm test` in the snapshot. There is no `.git` in the snapshot, so the two git checks of `selftest:case-file` and `selftest:6d2` skip there (a reviewer checks that those files are unmodified).
4. It checks the Docker state again.

Logs are in `run-logs/<label>/` in the repository (git-ignored; the snapshot never copies it, nor `issues/` or `plugin-guard-reports/`; `PG_RUN_LOGS` can name another absolute folder, but never one inside the repository except `run-logs/`): `started.txt`, `tree.sha`, `progress.txt` (Docker before and after), `test.log`, `test.exit` ("test exit N") and `result.txt`. An optional `run-logs/env.sh` (copied there by hand by the owner, never committed) is read INSIDE the subshell that runs the tests, never by the script itself: nothing in it can change the Docker baseline or the mode. The lock file is `run-logs/.run-full.lock`; because it is per log folder, two clones (or two `PG_RUN_LOGS` values) could run the Docker suites at the same time: start only one run per machine. Options: `PG_TIMED=1` puts the time before every log line; `--dry-run` does steps 1 to 3 and a tiny check (`DRY-RUN OK` in `result.txt`), so a change of the script can be checked without the long run. A run whose tests did not start (an `env.sh` that ends the shell) or whose output has no PASS line is never valid (exit 97 or 98).

A run is **valid** only if `test.exit` says `test exit 0` AND the Docker state after the run equals the baseline. A computer restart during a run makes it invalid; start a new run instead of repairing the old one.

## Timing (CI-1 and CI-2, 2026-11-23)

- `tools/measure.sh <label>` runs every suite of `test:offline` alone, in the `package.json` order, and writes `run-logs/ci/<label>.csv` (suite, seconds, PASS, FAIL, SKIP, exit) and the sorted PASS, FAIL and SKIP lines of every suite in `run-logs/ci/<label>.txt`. Nothing else may run on the machine while it runs.
- `PG_TIMED=1 scripts/run-full.sh <label>` puts the time before every line of `test.log` (it replaces the old outside copy `run-full-timed.sh`); the next full run gives the Docker suite times with it. It has not been run on a full run yet.
- Measured on one machine: the offline chain took 815 s before and 714 s after CI-2 (about 12 to 13.6 minutes), with the same 5063 PASS, 0 FAIL, 2 SKIP and the same check lines (30 lines differ only in ports, random temp folder names, timestamps and millisecond timings). The slowest suite is `no-files` (about 150 to 194 s); the next are `6c2`, `issue-probe`, `6d3-fixes` and `second-site` (about 43 to 68 s).
- `PG_PROBE_5XX_RETRY_DELAY_MS=0` is set inside `scripts/selftest-no-files.js` and `scripts/selftest-redact.js` (where they build the environment of their child processes), so a 5xx fixture page does not wait the default 5 seconds before the probe's one retry. `selftest-issue-probe.js` keeps the default: its pacing check measures the gaps between page requests.

## The baseline (the last valid full run with written numbers: p-s4)

The latest valid full run is `p-af` (HEAD `3ceda08`, 2026-11-27; `result.txt`: "run VALID: test exit 0, docker back at baseline (5 0 11)"; counted from its `test.log`: 91 suites, 5837 PASS, 0 FAIL, 4 SKIP, 47 min 19 s; the SKIPs are the repository-text comparison and PHP 7.4, 8.0 and 8.1). `p-ad` (HEAD `6fba210`) was valid too. The run `p-ac` was NOT valid: one check failed (the snapshot is inside the repository and found its `node_modules`) and was fixed in `6fba210` (HANDOFF rows 105 and 106). The numbers below are those of `p-s4`, the last valid run whose numbers are written; they stay as the history of that run.

Run `p-s4`, 2026-11-23, on the working tree at HEAD `79ae3de` (S4c-fix; snapshot tree `e9e9c9e`; the docs of S4-docs were edited only after the snapshot was made), valid: `test exit 0` and Docker back at 5/0/11 (5 containers, 0 labelled, 11 volumes, before and after). The machine was not restarted during the run (up since 2026-11-23 10:35, before the run started 18:30:31).

- Suites: 81 (71 offline + 10 Docker). Duration: 47 min 4 s (18:30:31 to 19:17:35).
- Checks: **5466 PASS, 0 FAIL, 6 SKIP** (3061 PASS in the offline part, 2405 PASS and the 6 SKIP lines in the Docker part). The 6 SKIPs are the same as in `p-s0` and are loud: the two git checks of the snapshot (it is not a git work tree), the hints suite in standalone mode, and PHP 7.4, 8.0 and 8.1 (no pinned image).
- Times: the log of that run (the owner's old folder `~/pg-runs/p-s4/test.log`, outside the repository and not part of it any more) has only two time stamps, because the output of each part reaches the stamping step in one block: the offline part ends at 18:39:19 (about 8 min 49 s) and the Docker part at 19:17:35 (about 38 min 16 s). **Per-suite times are NOT in this log**, so no list of the 10 slowest suites including the Docker ones can be given from it. The slowest OFFLINE suites, from the separate one-by-one measurement after CI-2 (the owner's old measurement `after.csv`, a different run, 70 suites): `no-files` 147.9 s, `6c2` 63.1 s, `issue-probe` 59.6 s, `6d3-fixes` 48.3 s, `second-site` 47.0 s, `6a-fake` 41.6 s, `6d1` 35.7 s, `issue-evidence` 28.9 s, `issue-sandbox-lifecycle` 27.0 s, `6d2` 18.3 s. The Docker suites have no per-suite figure yet; a timed run that stamps each suite is a later CI step.
- Earlier baseline: `p-s0` (2026-11-18, HEAD `68e8f62`): 76 suites, 4692 PASS, 0 FAIL, 6 SKIP, 38 min 56 s.
- History: `p-h1` (2026-11-17, honest wording): 4489 PASS, 0 FAIL, 7 SKIP, 43 min 34 s (75 suites). `p-n1` (2026-11-16, the rename): 4478 PASS, 0 FAIL, 7 SKIP, 38 min 12 s. `p-c2b` (the first valid run): 4468 PASS, 0 FAIL, 7 SKIP, 38 min 43 s. `p-c2` was not valid. The 11 more checks than `p-n1` are the new no-code tests (7 in `selftest-case-file.js`, 4 in `selftest-checkpoints.js`).

Every SKIP, with its reason (all are loud skips that name their reason):

1. `unshare -rn is not available here: only the in-process network guard was used`: (`selftest:issue-evidence`) this machine has no user network namespace, so one extra network proof is replaced by the in-process guard.
2. `not inside a git work tree: the validate.js unmodified check did not run` (`selftest:case-file`): the snapshot has no `.git`.
3. `validate.js / retest.js / fatal-recheck.js unmodified: git is not available here (nothing claimed)` (`selftest:6d2`): same cause, the snapshot has no `.git` (the message says "git is not available"; the real reason is that there is no work tree).
4. `this is not the repository ... the repository texts cannot be compared` (`selftest:hints`): the whole suite skips here (see "Not in the chain").
5. to 7. `PHP 7.4`, `PHP 8.0` and `PHP 8.1` (`selftest:6b-docker`): no pinned image for these versions (no tag chosen, or the registry does not know the tag).

The seeded-bug test (`selftest:issue-seeded`) takes its real-site settings from the optional `run-logs/env.sh`, which the owner copies there by hand and which is never stored in the repository. Without that file the test skips, loudly (the line "PG_REAL_SITE / PG_REAL_PLUGIN are not set"). The hygiene scan does not walk `run-logs/`.

## Rules

- Never delete, skip or weaken a test. A new behaviour gets a suite that fails without it. If the text of an assertion has to change, STOP and list the old and the new text for the owner first.
- Gate-off output stays byte-identical to the golden files in `scripts/fixtures/issue/gate-off/`.
- Never run a docker prune of any kind. Leftover containers or volumes are looked at by hand.
- One full run per commit.
