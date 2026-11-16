# Testing

## The commands

- `npm test` runs every suite: `npm run test:offline`, then `npm run test:docker`. It stops at the first failing suite.
- `npm run test:offline`: 65 suites that need no Docker (pure logic, a fake `docker`, fixture sites on 127.0.0.1, the browser report checks, the docs and hygiene checks).
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

Logs are in `~/pg-runs/<label>/`: `started.txt`, `tree.sha`, `progress.txt` (Docker before and after), `test.log`, `test.exit` ("test exit N") and `result.txt`. An optional `~/pg-runs/env.sh` is read first; it is never stored in the repository.

A run is **valid** only if `test.exit` says `test exit 0` AND the Docker state after the run equals the baseline. A computer restart during a run makes it invalid; start a new run instead of repairing the old one.

## Status of the baseline

Baseline pending. The first full run, `p-c2` (2026-11-16), was not valid: test exit 1 (the chain stopped at the first failing suite, `selftest:issue`; a survey of the offline suites one by one found nine failing, seven on old command wording, one on a golden file of `selftest:gate-output`, and one caused by wording in the docs, now fixed), Docker back at the known state. No green baseline exists yet. Do not read this file as saying the chain is green.

## Rules

- Never delete, skip or weaken a test. A new behaviour gets a suite that fails without it. If the text of an assertion has to change, STOP and list the old and the new text for the owner first.
- Gate-off output stays byte-identical to the golden files in `scripts/fixtures/issue/gate-off/`.
- Never run a docker prune of any kind. Leftover containers or volumes are looked at by hand.
- One full run per commit.
