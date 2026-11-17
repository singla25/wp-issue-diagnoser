# Roadmap: wp-issue-diagnoser

Last updated: 2026-11-17, after tasks 1a, 1b and 1c (commits a14f3d3, 24e0a0e and the commit that adds this file). Update the status columns after every step.

## How to use this file

Read this file first after a break, after a new session starts, or after a long chat was compacted. It says what is done, what is running now, and what comes next. Then read `CLAUDE.md` (the rules), `docs/HANDOFF.md` (decisions and rows) and the last entries of the history file (kept outside the repository).

The roadmap is the plan. `docs/HANDOFF.md` is the detailed log. If they disagree, say so to the owner. Do not guess.

## Rules that never change

- One Coder agent, one step at a time, no parallel agents. Only the owner pushes.
- Explicit staging by path, one commit per step, no `docker prune`, never read the owner's private folder or any `.sql` or `.env` file.
- Never delete, skip or weaken a test. If an assertion text must change, STOP and list old and new for the owner.
- Never claim more than was tested. Every possible cause is labelled "possible, not confirmed" unless a test confirmed it.
- Real site or client names never go into files ("a real site"). Short, simple English.
- Opus review of every diff (factual errors only, a second round if round 1 found anything, max 2 rounds).
- Batch rule: a small step runs `npm run test:offline` and its quick suites. One full run (`scripts/run-full.sh <label>`) is done at the end of a batch, before the owner pushes. A run counts only if the exit is 0, the machine did not restart, and Docker is back at the known baseline (5 containers, 0 labelled, 11 volumes).

## Where we are

Last green full run: p-h1 on 2026-11-17. 75 suites (65 offline and 10 Docker), 4489 PASS, 0 FAIL, 7 SKIP, 43 minutes. The 7 SKIPs are known and loud (no network namespace here, two git checks in the snapshot, the hints suite in standalone mode, PHP 7.4 and 8.0 have no pinned image, PHP 8.1 is not pinned).

| Done | Commit |
|---|---|
| C1, C1b, C1c: maintainer docs, `.gitignore`, hygiene test, docs fixes | 7069f9f, bb5df4e, 4c7d1b4 |
| C3a, C3b, C3c: three tests made portable | a3437f1, 2cf04dc, cda986e |
| C2a, C2b: `npm test`, `run-full.sh`, first green baseline | e6f546a, 38c4517 |
| C4, C5: command names in messages and tests, `guard:auto` wording | f17bb0c, 8909198 |
| R1, R1b, R2, R3: README for other users, docs map, no-code limits | a24f6eb, f821ddd, b4470a2, b94f39c |
| N1: command renamed to `wp-issue-diagnoser`, script `diagnose` (Stage 1) | 5e890ad |
| H1: report wording, no code means not looked at, not checked | 0dfa3dc |
| H2: true sentence for a mismatch, code files found but not read | 93659c0 |

Push status: check with `git log origin/main..HEAD`. The owner pushes only a green state.

## Pipeline (pending), in order

| # | Task | Size | Why here | Status |
|---|---|---|---|---|
| 1a | Tighten `selftest-6d3.js:190` (it now checks a shorter prefix than before) | 15 min | A test must never get weaker. | done (a14f3d3) |
| 1b | P1: probe counts one connection error twice (`probe/safety.js`); remove the two extra `recordOutcome` calls, add a mock-page test | 45 min | A real bug in a safety rule. Small and low risk. | done (24e0a0e) |
| 1c | Add this roadmap to the repository and to the docs map | 20 min | The plan must survive a compacted chat. | done (the commit that adds this file) |
| 2 | D1: design of input modes and question phases (`docs/INPUT-MODES.md`, no code) | 1 to 2 h | Cheap, no code. It decides what we build and in which order. | waiting for 1a to 1c |
| 3 | Build the no-code mode in small steps with tests: (a) question phases in the terminal, (b) live observations (console, network, debug log if exposed), (c) plugin and theme detection from the public page, (d) Site Health text reader, (e) report layout with "possible, not confirmed" | 1.5 to 2.5 days | Most WordPress users cannot give files or a database. This is the widest audience. The exact order comes from D1. | waiting for 2 |
| 4 | Real-site runs by the owner on 2 or 3 real sites, then review of the reports | 1 to 2 h | Tests use made-up sites. Real sites find what tests miss. After 3, so the new mode is tested too. | waiting for 3 |
| 5a | C6: docs leftovers, naming, GET-only wording, git-skip message, comments, `.claude/scheduled_tasks.lock` line in `.gitignore`, case-file versus HEAD comparison | 1 to 1.5 h | Small and safe. | waiting |
| 5b | C7: clean-checkout test replaces the isolated-copy test, rewrite `selftest:hints` for standalone mode, fix the Stage 2 messages that tests still pin | 1.5 to 2.5 h | Proves that a fresh clone works. | waiting |
| 5c | C8: remove the local project name from tests, check files and history for real client names or domains | 1 to 1.5 h | Needed only before the repository can be public. | waiting |
| 5d | One full run at the end of the batch, then the owner pushes | 45 min | The Docker suites run only here. | waiting |
| 6a | Checkpoint step B (`wp_head`, `wp_footer`, `wp_body_open`, `DISABLE_WP_CRON`) | 0.5 to 1 day | Improves the sandbox mode, which matters less than the no-code mode. | waiting |
| 6b | 6c-3 masking | 0.5 to 1 day | Same reason. | waiting |
| 7 | Decision about going public: README review, leftover list, scan result, owner decision | owner | The repository stays private until the owner says otherwise. | waiting |

Why this order: (1) honesty of what exists comes before new features, (2) design is cheap and comes before building, (3) the widest audience first, (4) cleaning is needed only before the repository is public, and small fixes share one full run.

## Input modes the tool must handle (target, from the owner)

Users explain the error, give screenshots and the live URL. The tool checks what it can (console, network, debug log if exposed, other possible checks) and gives the nearest possible cause. It says clearly that code and database were not provided, so it could not test on a sandbox copy, and that the causes are possible, not confirmed. It asks more about plugins, theme and the bug. Questions come in phases: phase 1 is common to every user, then a branch for users who give files and a database and for users who do not.

| Mode | Inputs | Report level |
|---|---|---|
| A | files, database, sandbox allowed | 1, or 3 if the copy could not confirm |
| B | files only | 4 |
| C | files, no sandbox | 2, not tested on a copy |
| D | live URL, description, screenshots, logs, no files | 2, ranked possible causes |
| E | only a description or a log | 2, very weak, says so |

Today the tool needs a site folder (`--root`). An empty folder works and gives a weak result.

## Decisions made

- 2026-11-16: the repository is private until the owner decides. History is not rewritten. The local project name used in tests is not a client name, so C8 is small.
- 2026-11-16: the command is `wp-issue-diagnoser`, the npm script is `diagnose`, `npm run guard` stays as the advanced entry. Internal names (Docker labels, `PG_*` variables, the reports folder, the config file name, User-Agent strings, file names) stay until Stage 2.
- 2026-11-17: reports must never read stronger than the test: "Looked at" names the code only if code files were read; checks that need code are "not checked" when no code was read; a mismatch sentence says what the confirmation really rests on.
- 2026-11-17: all Coder work and full runs stay on one machine (the Linux PC). The Baseline is machine-specific.
- 2026-11-17: small fixes are batched, with one full run at the end of the batch.

## Leftovers (Stage 2 and later, not planned yet)

- Messages and test pins that still carry the old name: `scripts/guard.js:216`, `lib/workflow.js:138` and `:161`, `lib/playwright.js:21`, the SKIP texts in 14 suites, the install placeholder path in the guide.
- Internal names: Docker labels and project prefix, `PG_*` and `PLUGIN_GUARD_*` variables, the reports folder, the config file name, User-Agent strings, file names.
- A log-only mode (no site folder).
- A lighter reviewer for docs-only steps.
- Working from a second machine (needs its own baseline, key and history copy).

## Report levels (short)

1. Tested on a copy of your site (the copy shows the same problem).
2. Not tested on a copy.
3. The test copy could not confirm this.
4. Tested on a test site built from your files (no database file).
