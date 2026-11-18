# Roadmap: wp-issue-diagnoser

Last updated: 2026-11-18, after the full run p-s0 on the state after S0c (commit 68e8f62) and the baseline commit. Update the status columns after every step.

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

Last green full run: p-s0 on 2026-11-18 (HEAD 68e8f62). 76 suites (66 offline and 10 Docker), 4692 PASS, 0 FAIL, 6 SKIP, 39 minutes. The 6 SKIPs are known and loud (two git checks in the snapshot, the hints suite in standalone mode, PHP 7.4 and 8.0 have no pinned image, PHP 8.1 is not pinned). Commits since the earlier green run p-h1 (after 0dfa3dc): 93659c0, a14f3d3, 24e0a0e, 786646a, 566d1e1, 90c09cc, f1a794c, 0053fd9, 83d952b, f49a796, e130f73, a490e22, 68e8f62; all are covered by p-s0.

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
| 1a: the 6d3 mismatch check tightened | a14f3d3 |
| 1b: probe counts one connection error once (P1) | 24e0a0e |
| 1c: this roadmap added to the repository and the docs map | 786646a |
| 2 (D1): design of input modes and question phases, `docs/INPUT-MODES.md` (a proposal, nothing built) | 566d1e1 |
| Roadmap status after D1 | 90c09cc |
| 3a-S0: recovery-mode keys masked in `lib/redact.js`, new suite `selftest-redact.js` | f1a794c |
| Roadmap: build batch S0 to S4 | 0053fd9 |
| 3a-S0b: the other WordPress secrets masked, a last pass over the report files, the probe stores masked | 83d952b |
| 3a-S0b docs: what is masked, screenshots are not (SAFETY.md, README) | f49a796 |
| 3a-S0c: redact defects D1 to D4 and the minor items (retest compares masked pages, probe output masked and fail closed, whole-run masks, JSON / colon / PHP-dump forms) | a490e22, 68e8f62 |
| FR1: full run p-s0 after S0c, baseline updated (TESTING.md) | the baseline commit after 68e8f62 |

Push status: check with `git log origin/main..HEAD`. The owner pushes only a green state.

## Pipeline (pending), in order

| # | Task | Size | Why here | Status |
|---|---|---|---|---|
| 1a | Tighten `selftest-6d3.js:190` (it now checks a shorter prefix than before) | 15 min | A test must never get weaker. | done (a14f3d3) |
| 1b | P1: probe counts one connection error twice (`probe/safety.js`); remove the two extra `recordOutcome` calls, add a mock-page test | 45 min | A real bug in a safety rule. Small and low risk. | done (24e0a0e) |
| 1c | Add this roadmap to the repository and to the docs map | 20 min | The plan must survive a compacted chat. | done (786646a) |
| 2 | D1: design of input modes and question phases (`docs/INPUT-MODES.md`, no code) | 1 to 2 h | Cheap, no code. It decides what we build and in which order. | done (566d1e1) |
| 3a | Build the no-code mode, part 1, in small steps with tests (order from `docs/INPUT-MODES.md`, section 7; S0 was added by the owner): **S0** redact fix for `rm_token` and `rm_key` (done, f1a794c) and **S0b** the other WordPress secrets and a last pass (done, 83d952b and f49a796); **S0c** the defects found in the extra review of S0b, D1 to D4 and the minor items (done, a490e22 and the docs commit after it); **S1** run without a folder and honest labels (includes the crash at `lib/issue-cli.js:289` and the label that says "reading your log" only), 0.5 day; **S2** question phases, 0.5 to 1 day; **S3** live observations, plugin versions, feed known conflicts (must handle a 500 answer where the probe stops early and only 3 of 7 live checks gave a result), 1 day; **S4** report layout for modes D and E, 0.5 to 1 day; then ONE full run | 2.5 to 3.5 days | Most WordPress users cannot give files or a database. This is the widest audience. | S0, S0b and S0c done (f1a794c, 83d952b, f49a796, a490e22); S1 next, only when the owner sends its prompt |
| 3b | Build the no-code mode, part 2: **S5** Site Health text and pasted plugin list, 0.5 day; **S6** public `debug.log` check, 0.5 day; **S7** error e-mail text (after the masks of S0) and Plugins-page screenshot, 0.5 day each | about 2 days | Extra inputs for people who can copy a text but not give files. | waiting for 3a |
| 4 | Real-site runs by the owner on 2 or 3 real sites, then review of the reports | 1 to 2 h | Tests use made-up sites. Real sites find what tests miss. After 3a, so the new mode is tested too. | waiting for 3a and 3b |
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
