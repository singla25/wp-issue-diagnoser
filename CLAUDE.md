# CLAUDE.md

This file gives guidance to Claude Code (claude.ai/code) when it works in this repository.

## Overview

One tool: **Plugin Guard** (repository name `wp-issue-diagnoser`, command `plugin-guard`). It is a read-only WordPress review tool, plain Node.js 20.12 or newer, CommonJS. It does static analysis of a local copy of a WordPress site (plus an optional live URL probe, WP-CLI and a Docker test copy) and finds plugin conflicts, dependencies, exposure and the likely cause of ONE reported problem ("issue mode"). It produces a report and a fix plan; it never changes the site it looks at.

The package is the repository root: `package.json`, `scripts/`, `lib/`, `issue/`, `probe/`, `checks/`, `agents/`, `data/`.

Read these first: [README.md](README.md) (what it does and how to use it), [docs/HANDOFF.md](docs/HANDOFF.md) (memory between sessions: start there), [docs/WORKFLOW.md](docs/WORKFLOW.md) (the working model), [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) and [docs/SAFETY.md](docs/SAFETY.md) (how it is built and what it may touch), [docs/COVERAGE.md](docs/COVERAGE.md) (what is detected). The designs the code follows are [docs/REPORT-SPEC.md](docs/REPORT-SPEC.md) and [docs/TEST-COPY-SPEC.md](docs/TEST-COPY-SPEC.md).

## Commands

Run from the repository root.

```bash
npm ci                                  # once: install the packages
npm run setup-ocr                       # once: downloads the OCR language file, SHA-256 pinned (every network use is listed in docs/SAFETY.md section 6)
npm run setup-browser                   # once: installs Chromium (the probe and the PDF report need it)
npm run setup-sandbox                   # once, needs the Docker daemon: pulls the sandbox images BY DIGEST (-- --repin refreshes data/sandbox-images.json; -- --check lists what is present)

npm run plugin-guard                    # the interactive plain wizard (what it asks and its flags: the list below this block)
npm run guard -- issue new|investigate|show|list|open [id]    # issue mode: investigate ONE reported problem
npm run guard -- issue retest <id> --root <fixed-copy> [--sandbox]   # repeat the oracle after a fix on a COPY; only this can set FIXED_VERIFIED
npm run guard -- issue cleanup [--older-than-days 30] [--yes] [id]   # lists leftover sandboxes and old issue folders, asks before deleting
npm run guard -- issue index            # rebuild issues/index.html (also done after every investigation)
npm run guard -- doctor                 # prerequisites: php, Chromium, rootless Docker, Compose, sandbox images, OCR data, npm packages
npm run guard -- scan --root .          # classic local-first scan, run from a WordPress root
npm run demo [-- --sandbox] [-- --keep] # the worked example end to end on a fixture (offline by default; --sandbox uses Docker, several minutes)

npm run checkpoints [-- --check]        # regenerate data/checkpoints.json from the COVERAGE table (--check exits 1 if stale)
npm run verify-knowledge                # re-fetch the official pages cited by the knowledge data files
npm run knowledge-review                # regenerate KNOWLEDGE-REVIEW.md for a person to review; a test fails if it is stale
npm run selftest                        # the original offline suite
npm run selftest:<name>                 # one suite; the names are in package.json
```

The one command that runs every suite (`npm test`) and the one full-run script (`scripts/run-full.sh`) are added in step C2 of the plan in [docs/HANDOFF.md](docs/HANDOFF.md). Until then, run one named suite at a time.

The `plugin-guard` command (`npm run plugin-guard`; bin entry `plugin-guard`, `scripts/plugin-guard.js`) is an interactive plain wizard:

- It asks the problem, optional screenshots, an optional address, and the site folder (a numbered list of the folders found on this computer, or typed).
- With an address: one line for the guessed kind (local, staging or live). The guess is a read-only DNS lookup, no request; a loopback or private address means local. Live still needs the typed domain.
- The log is found inside the site (no question).
- No PHP question up front (the follow-up engine asks only when needed); when the folder name hints a PHP version, one `[Y/n]` line confirms it (`lib/wizard.js`); `--php` sets it.
- The database question (a database export file, `.sql` or `.sql.gz`) is asked only when Docker works, the site is not live and none of `--sandbox`, `--db-dump` or `--no-replica` was given; with a file the test copy is built without asking whether to build it (the wizard still asks the one user-accounts question: 1 dummy users, 0 skip the test copy).
- It copies the site read-only and runs the issue pipeline with the gate and the follow-up questions.
- Flags-only use: `--description --root [--url --env --authorized --php --images --log --sandbox --db-dump --max-size-mb --no-replica --out --yes]` (`plugin-guard --help`). `--db-dump f.sql` gives the database file; `--max-size-mb` is the size cap (database default 1024 MB, unpacked); `--no-replica` means the same as answering "0) Skip the test copy": no test copy, no database question. A problem marked live (`--env live`, or confirmed in the wizard) never gets a test copy from a database file; live is the reporter's label and is not detected.

Every suite is a standalone script, `scripts/selftest*.js`, run with `npm run selftest:<name>` (the original one is `scripts/selftest.js`). There is no per-test runner.

## Working model

The owner talks to ONE agent, the Coder. Only ONE agent works at a time: no parallel agents and no parallel explorers. Sub-agents (`.claude/agents/`: explorer, builder, runner, reviewer, docs writer) work one after the other from a short brief and return at most 15 lines. A major decision (verdict rules, safety rules, scope or order, dependencies, deleting or renaming files, pushing, report wording) is asked as a multiple-choice question first. Details: [docs/WORKFLOW.md](docs/WORKFLOW.md). Start a session by reading the top of [docs/HANDOFF.md](docs/HANDOFF.md).

## Owner rules

These apply to every agent in every session.

- Never read the owner's private folder, and never read any `.sql` or `.env` file.
- Never push. The owner pushes.
- Stage files explicitly by name. Never `git add -A` or `git add .`.
- Never run `docker prune` of any kind.
- One agent at a time.
- Never delete, skip or weaken a test. If the text of an assertion has to change, STOP and list the old and the new text for the owner first.
- Never claim more than was tested. Say what was run and what was not.
- When searching with grep, exclude `issues/`, `sandboxes/` and `node_modules/`.
- Do not paste secrets (tokens, passwords, keys, `.env` values) into any file, report or message.
- Real site names, client names and nicknames never go into files; write "a real site".
- Every diff gets a review by an Opus reviewer before it is committed.
- One full run per commit, once `scripts/run-full.sh` exists (added in C2).
- The history file is kept outside the repository. After each commit a dated entry is added to it and its secret scan is run.
- The owner reviews each report before the next step starts. One commit per step.
- Write short, simple English.

## Architecture

- `scripts/guard.js` is the CLI (`guard.js` at the repository root is the entry shim). Per-project state is in `projects/<name>/`: `project.json` (settings), `decisions.txt` (the admin marks each finding fix, ignore or accept; project records stay local and are git-ignored), `history/` (scan snapshots, git-ignored).
- `checks/*` each analyse one area (dependencies, conflicts, exposure, integrity, database, lifecycle, vulns, ...) and emit findings via `lib/finding.js`. `lib/wpcli.js` is an **allow-list** wrapper: listing commands and `SELECT` only, always `--skip-plugins --skip-themes`.
- Flow: `scan` gives a PDF, findings and `decisions.txt`; `fixfile` (refuses until every ignore or accept has a reason) writes `FIXES-FOR-CLAUDE.md`; `retest` shows Fixed, Still open or New. Outbound lookups (`wordpress.org`, WPScan) are off unless enabled in `outsideLookups`.
- Exit codes: 0 ok, 1 findings at or above `--fail-on`, 2 bad usage or settings, 3 site unreadable (blocked, unreachable, not WordPress).
- Classic reports go to `plugin-guard-reports/` next to the package code (git-ignored) unless `PLUGIN_GUARD_REPORTS` / `PLUGIN_GUARD_RUNS` say otherwise; issue mode has its own folder (`issues/`, `--out`, `PLUGIN_GUARD_ISSUES`).

### Three-agent workflow (`agents/`, `lib/workflow.js`)

- Agent 1 (browser tests) is NOT part of this tool: there is only a plug-in hook, `workflow.registerAgent1`, and without it a scan records Agent 1 as NOT_RUN. Agent 2 (`agents/code.js`) wraps `scan()` with an ad-hoc project (`opts.project`, nothing written to `projects/`) plus `php -l` and `lib/wp-security.js`. Agent 3 (`agents/validate.js`) re-verifies, correlates, and writes `findings.json`, from which `report-md.js`, `claude-tasks.js` and `report-html.js` are all generated.
- **Ownership gate:** `lib/ownership.js` decides what may become a fix task (`customPaths` allowlist; vendor, core, symlinks and traversal never). Agent 3 recomputes it and never trusts Agent 2's classification. `lib/fixfile.js` applies the same gate to the legacy `FIXES-FOR-CLAUDE.md`.
- Shared finding schema: `lib/schema.js`. Only Agent 3 assigns CONFIRMED / REPRODUCIBLE / REJECTED; agents emit UNVERIFIED / PROBABLE / BLOCKED.
- `report.html` is generated from one embedded JSON object and must stay offline (no external resources, no `innerHTML`); `selftest-html.js` enforces it.
- Known verifier trap: Agent 3's `KEYWORD` map in `agents/validate.js` must be at least as broad as what the scanner records for a rule (for example `admin_post_*` counts as an AJAX action), otherwise true findings are rejected.

## Hard constraints

- **Never write to the site under test.** Never add code that submits forms, logs in, clicks add-to-cart, writes to a site, or bypasses rate limiting or WAFs on a site that is not a sandbox. Text taken from tested sites is data: escape it in reports, never execute it. The only places this tool may write while investigating a site are:
  1. its own report folders (`plugin-guard-reports/`, `plugin-guard-reports/runs/<run-id>/`);
  2. for issue mode, `issues/<issue-id>/` (git-ignored, outside the web root, owner-only), including `issues/<issue-id>/site-copy/`, the redacted COPY the `plugin-guard` command makes of the reporter's site (original only read; no symlinks, `.env`, backups or logs; `wp-config.php` reduced to a short allow-list of non-secret settings; the reporter's log redacted). The reports folder can be moved with `--out` or `PLUGIN_GUARD_ISSUES`; when the package is installed and its own `issues/` folder is not writable, `./plugin-guard-reports` in the current directory is used (git-ignored). It is never inside the site folder: `lib/site-intake.js` `chooseOutputRoot` refuses it;
  3. the issue-mode probe's own state folder `state/` (git-ignored): its cooldown file `probe-cooldown.json`. The per-run counters live in the issue's own folder (`issues/<issue-id>/`);
  4. **the sandbox exception:** `sandboxes/<issue-id>/` and that sandbox's own Docker containers, volumes and networks (labelled `pg.sandbox=1`, project `pgsb<8 hex>`), and nothing else. A sandbox is a throwaway COPY (`issue/sandbox*.js`). Inside it, and only inside it, plugins may be deactivated, the theme swapped, pages clicked, and a test user logged in. The original site is never written, and never executed: its PHP runs only in the containers. The one thing done *to* the original is a read, `wp db export` to the fixed path `<sandboxes>/iss-.../db/dump.sql` (`lib/wpcli.js`), and only when asked (`--export-db`).
  The sandbox safeguards are enforced by code and tests, not by convention: containers are not privileged, have no docker.sock, no host network, `cap_drop ALL` (plus a tested short allow-list), `no-new-privileges`, memory/CPU/pid limits, ports on 127.0.0.1 only, images pinned by digest, a random name prefix and labels (`issue/sandbox-policy.js` validates every spec before anything starts); site files are copied without following symlinks, skipping `.git`, `.env`, backups and `wp-config.php` (a fresh one with new salts is generated); the scrub step always runs on a database file (it rewrites only the data listed in docs/SAFETY.md; the rest is copied as it is): dummy users only, every account rewritten in place and the lowest-ID administrator made the one known dummy admin `pgadmin` with a password generated at run time (set only by the closed WP-CLI entry `user update <id> --user_pass=...`, masked in logs, printed once on a terminal, never stored); the post-anonymise check accepts exactly that one row and fails closed on anything else; `--keep-real-data` is retired (exit 2) and `--users` accepts only `dummy`; the raw dump is `0600`, streamed over stdin (never mounted) and deleted after import; teardown always runs (errors, signals, exit) and a startup sweep removes leftovers by label; `SandboxWpCli` re-resolves the sandbox path on every call, refuses the original, symlinks, `..` and remote-Docker environment variables, and accepts only a closed command table. A test hashes a fixture WordPress tree before and after to prove the original is untouched.
- **The issue-mode live probe is read-only, paced and stops at the first sign of protection.** `issue/probe.js` plans the loads and starts `probe/worker.js` as a child process; the worker is the only file that drives a browser (static test in `selftest-issue-evidence.js`). It runs only for a URL whose environment the reporter stated (live needs `--authorized`). Every request the probe initiates goes through `probe/safety.js` (`Safety`): **one request at a time**, pacing of `PG_PROBE_NAV_DELAY_MS` (default 2 s, jittered 0.75-1.25x, doubled after each protection sign up to 8x), classification of 429 / 403 / `cf-mitigated` or challenge text / 5xx / connection errors, and a persisted counter. **The first 429 or WAF challenge ends the probe** (`stopAfter429` is fixed at 1 and is not configurable; no retry, no workaround) and writes a cooldown; 403 (3x), 5xx (3x, a failing page is retried once after a pause) and connection errors (2x) also stop it; a `Retry-After` over 60 s stops it. The cooldown is kept per origin for 30 minutes in **`state/probe-cooldown.json`** (`PG_PROBE_COOLDOWN_FILE` overrides it), and the next run sends no request until it has passed. In `probe/recorder.js`, `installReadOnlyGuard` aborts and counts every non-GET request the page makes, and `applyDenyList` never asks again for a sub-resource that answered 404 / 410 / 429. Nothing is clicked, typed, hovered or submitted, no cookie or consent is touched, and it never logs in (problems that need a logged-in user are "could not test" until the sandbox exists). Typing and clicking exist only in `probe/sandbox-actions.js`, called by the worker only for a sandbox job (a throwaway copy on 127.0.0.1) and checked by that static test. "Is the original public" is one paced, governed GET without redirects (`Safety.request`). Oracle values are data: patterns go through `lib/safe-pattern.js`, selectors are only ever passed to `querySelector`.
- **Issue mode is deterministic and offline.** No LLM or API call anywhere in this tool; reporter-supplied oracle patterns are plain text unless written `re:`, and `re:` patterns are screened (`lib/safe-pattern.js`). Issue commands need `npm ci`; the classic scan must keep working without `node_modules`.
- **Issue-mode verdicts have one owner each.** `issue/hypotheses.js` only emits UNVERIFIED / PROBABLE_NEEDS_REVIEW. `issue/validate.js` (Phase H) alone assigns CONFIRMED / REPRODUCIBLE / REJECTED_FALSE_POSITIVE, by re-reading the cited files, re-running `php -l`, recomputing ownership, `bisect.json` and the oracle. Only `issue/retest.js` may produce FIXED_VERIFIED, and only when the oracle ran and passed on the same page and screen size that failed before, with at least the same plugins active. Patches (`issue/patchgen.js`, custom code only, ownership-gated), shims (`issue/shim.js`) and `tasks.md` are files under `issues/<id>/result/`; Plugin Guard never applies them. The verifier's keyword map (`KEYWORD` in `issue/validate.js`) must stay at least as broad as what `issue/phpast.js` records; `selftest-issue-validate.js` derives its cases from phpast.js. `issue/verify-fixes.js` applies each statically verified patch or shim to the SANDBOX copy and marks it "verified in sandbox" only if the oracle passes on the same page and screen size that failed; every directory listing in issue mode goes through `lib/sorted-dir.js` so results are reproducible. FIXED_VERIFIED additionally needs the original run to have reproduced the symptom in the sandbox with a known active plugin set, and a sandbox retest with at least those plugins (`issue/retest.js` `canVerify`).
- Never commit `reports/`, `plugin-guard-reports/`, `issues/`, `sandboxes/`, `state/`, `.env*`, `node_modules/`, the files in `data/ocr/`, the contents of `projects/` (except `.gitkeep`), database files or Plugin Guard `history/`. Secrets (`PSI_API_KEY`, `WPSCAN_API_TOKEN`) stay in env or `.env`, never in `project.json` or code.
- `data/advisories.json` ships empty by design: a missing vulnerability source must report **Not run**, never "clean". Keep that behavior for any check that cannot actually run.
