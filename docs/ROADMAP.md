# Roadmap: wp-issue-diagnoser

Last updated: 2026-11-24, after S3 (S3a-fix, S3a, S3a2, S3a2-fix, S3b, S3c, S3c-fix), CI-1, CI-2, the S3-docs step, V1 (2a3a189) and S4 (S4ab b44ab8a, S4ab-fix 8818ff8, S4c f576c7f, S4c-fix 79ae3de). The address check (eeab1d1) came after S4-docs. origin/main was 07a6929 when this was written; the address check and its docs step are not pushed. The next step is the owner's real-site runs; the owner decides the order. The full run after S4 (`p-s4`) is done and valid (5466 PASS). Update the status columns after every step.

## How to use this file

Read this file first after a break, after a new session starts, or after a long chat was compacted. It says what is done, what is running now, and what comes next. Then read `CLAUDE.md` (the rules), `docs/HANDOFF.md` (decisions and rows) and the last entries of the history file (kept outside the repository).

The roadmap is the plan. `docs/HANDOFF.md` is the detailed log. If they disagree, say so to the owner. Do not guess.

## Rules that never change

- One Coder agent, one step at a time. Only ONE agent that edits files, runs tests or commits works at a time; read-only helpers may run in parallel (changed in M1, see `docs/WORKFLOW.md`). Only the owner pushes.
- Explicit staging by path, one commit per step, no `docker prune`, never read the owner's private folder or any `.sql` or `.env` file.
- Never delete, skip or weaken a test. If an assertion text must change, STOP and list old and new for the owner.
- Never claim more than was tested. Every possible cause is labelled "possible, not confirmed" unless a test confirmed it.
- Real site or client names never go into files ("a real site"). Short, simple English.
- Review of every diff, by the Opus reviewer, or by reviewer-light for a docs-only diff (owner decision in M1) (factual errors only, a second round if round 1 found anything; max 2 rounds, and max 3 for security code since M1).
- Batch rule: a small step runs `npm run test:offline` and its quick suites. One full run (`scripts/run-full.sh <label>`) is done at the end of a batch, before the owner pushes. A run counts only if the exit is 0, the machine did not restart, and Docker is back at the known baseline (5 containers, 0 labelled, 11 volumes).

## Where we are

Last green full run: p-s4 on 2026-11-23 (ran at HEAD 79ae3de; the later commits ddff184 and a432c98 are docs only; everything is pushed). 81 suites (71 offline and 10 Docker), 5466 PASS, 0 FAIL, 6 SKIP, 47 minutes; Docker 5/0/11 before and after (the earlier one was p-s0, 2026-11-18, 76 suites, 4692 PASS, 38 min 56 s). The 6 SKIPs are known and loud (two git checks in the snapshot, the hints suite in standalone mode, PHP 7.4 and 8.0 have no pinned image, PHP 8.1 is not pinned). Commits since the earlier green run p-h1 (after 0dfa3dc): 93659c0, a14f3d3, 24e0a0e, 786646a, 566d1e1, 90c09cc, f1a794c, 0053fd9, 83d952b, f49a796, e130f73, a490e22, 68e8f62; all are covered by p-s0 (it ran on HEAD 68e8f62; the baseline commit 0c27ded only records it). Since then M1 (809f1ed), S0d (3a85421 and its docs commit), S1 (2abfccc to 5c2174e), S1b-fix (0d1a11a), S1d (7a9952a), S1d-fix (4e56cd0) S2 (109bc49), S3 (c611e59, 4bc32b5, 05da294, 716993c, 0327d15, 050c1d4, 688ee6d) and CI-2 (55c5433), V1 (2a3a189) and S4 (b44ab8a, 8818ff8, f576c7f, 79ae3de) are covered by the full run p-s4 (HEAD 79ae3de); the last `test:offline` result was 5129 PASS, 0 FAIL, 2 SKIP, 2026-11-23, at 79ae3de (owner figures). Pushed: everything up to a432c98 (origin/main = HEAD).

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
| FR1: full run p-s0 after S0c, baseline updated (TESTING.md) | 0c27ded |
| FR2: full run p-s4 after S4, baseline updated (TESTING.md) | ddff184 |
| AC: address check: an address with hidden characters or spaces is refused, a saved one is never probed (`lib/address-check.js`, `selftest-address.js`; docs in the step after it) | eeab1d1 |
| M1: roles, models, step size and token budget (docs/WORKFLOW.md, CLAUDE.md, reviewer-light agent; docs only, no full run) | 809f1ed |
| 3a-S0d: masking corpus test (173 secret forms, 137 benign texts), the short-value rule, the exact exception for "(using password: YES or NO)" | 3a85421, a9528dc, f0badde (round 4 fix) |
| 3a-S1a: `--no-files` (run without a site folder) and the crash fix | 2abfccc |
| 3a-S1b: honest wording without a site folder (zero-checks verdict, no "on this site" wording, reason, label) | ee782f4 |
| 3a-S1c: docs for S1 (README, INPUT-MODES, REPORT-SPEC, HANDOFF row 87, suite count 68) | 9383889 |
| Docs: `docs/PROJECT-HISTORY.md`, one file for a new chat (the whole project, with sources) | de0ec6f |
| 3a-S1b-fix: honest log reason ("no site files were given") and honest verdict for an error page or a failed live check, no site files | 0d1a11a, f68a266 |
| 3a-S1d: `--no-files --log <file>`, a log without a site folder, possible causes only | 7a9952a |
| 3a-S1d-fix: the `--log` refusal as a rule (packed files, dotted dump names, trailing junk) | 4e56cd0 |
| 3a-S1d-docs: docs for S1d (README, CLAUDE.md, REPORT-SPEC, INPUT-MODES, SAFETY, HANDOFF row 90, PROJECT-HISTORY) | 51d77b4, 27c4c17 |
| 3a-S2: the no-files branch in the wizard (type `none`), one optional log question, the summary before go | 109bc49 |
| 3a-S2-docs: docs for S2 (README, CLAUDE.md, INPUT-MODES, SAFETY, HANDOFF row 91, PROJECT-HISTORY, this roadmap) | e083252 |
| 3a-S3a-fix: the probe's planned page loads read in their real shape (a complete probe gives live check results) | c611e59 |
| 3a-S3a: "<N> of 7 live page checks gave a result ..." (no site files) | 4bc32b5 |
| 3a-S3a2 and S3a2-fix: the true reason on the live check rows after a stop; the stop wording follows the reason text | 05da294, 716993c |
| 3a-S3b: plugin, theme and WordPress version from what the probe already loaded (no site files, no new request) | 0327d15 |
| 3a-S3c and S3c-fix: the plugins the page loaded matched by name against three known conflicts, "possible, not confirmed" | 050c1d4, 688ee6d |
| CI-1 (timing wrapper outside the repository) and CI-2 (5xx retry delay 0 in two suites; offline 815 s to 714 s) | 55c5433 |
| 3a-S3-docs: docs for S3 and CI (README, CLAUDE.md, INPUT-MODES, REPORT-SPEC, SAFETY, TESTING, HANDOFF rows 92 to 96, PROJECT-HISTORY, this roadmap) | 88b3049 |
| V1: one place for the planned page loads (`issue/probe-plan.js`); the oracle gets the number the probe stored (new suite `selftest-probe-plan`) | 2a3a189 |
| 3a-S4ab: honest verdict after a stop, for a 4xx page, a 500 page with a conflict line, a 4xx page with a log; one live line instead of two | b44ab8a |
| 3a-S4ab-fix: a site that could not be reached gives a short plain reason (no raw error text, no address) | 8818ff8 |
| 3a-S4c: a quiet live page says what was looked at ("The live page checks found nothing wrong"), never a clean bill of health | f576c7f |
| 3a-S4c-fix: "listed in this report", the page count, the noticed sentence says why it could not be linked | 79ae3de |

Push status: check with `git log origin/main..HEAD`. The owner pushes only a green state.

## Pipeline (pending), in order

| # | Task | Size | Why here | Status |
|---|---|---|---|---|
| 1a | Tighten `selftest-6d3.js:190` (it now checks a shorter prefix than before) | 15 min | A test must never get weaker. | done (a14f3d3) |
| 1b | P1: probe counts one connection error twice (`probe/safety.js`); remove the two extra `recordOutcome` calls, add a mock-page test | 45 min | A real bug in a safety rule. Small and low risk. | done (24e0a0e) |
| 1c | Add this roadmap to the repository and to the docs map | 20 min | The plan must survive a compacted chat. | done (786646a) |
| 2 | D1: design of input modes and question phases (`docs/INPUT-MODES.md`, no code) | 1 to 2 h | Cheap, no code. It decides what we build and in which order. | done (566d1e1) |
| 3a | Build the no-code mode, part 1, in small steps with tests (order from `docs/INPUT-MODES.md`, section 7; S0 was added by the owner): **S0** redact fix for `rm_token` and `rm_key` (done, f1a794c) and **S0b** the other WordPress secrets and a last pass (done, 83d952b and f49a796); **S0c** the defects found in the extra review of S0b, D1 to D4 and the minor items (done, a490e22 and the docs commit after it); **S0d** masking corpus test and the short-value rule (done, 3a85421, a9528dc and f0badde); **S1** run without a folder and honest labels (includes the crash at `lib/issue-cli.js:289` and the label that says "reading your log" only), 0.5 day (done: S1a `2abfccc`, S1b `ee782f4`, S1c 9383889, S1b-fix 0d1a11a, S1d 7a9952a, S1d-fix 4e56cd0, S1d-docs 51d77b4; `--log` with `--no-files` works now, so the S1 case (b) run is possible); **S2** question phases, 0.5 to 1 day (done: the branch is the typed answer `none` at the folder prompt, plus the log question and the summary before go, `109bc49`, docs e083252; the plugin and theme questions go to S5); **S3** live observations, plugin versions, feed known conflicts, 1 day (done 2026-11-20: S3a-fix c611e59, S3a 4bc32b5, S3a2 05da294, S3a2-fix 716993c, S3b 0327d15, S3c 050c1d4, S3c-fix 688ee6d; the 500 case gives 3 of 7 with the true reason; console warnings and the cache-folder source were not built); **S4** report layout for modes D and E, 0.5 to 1 day (S4 wording points: (1) a 200 page with only 'also noticed' rows still gets the old sentence 'No confirmed breaking cause was found'; (2) for a plain 403 or 404 use a neutral headline such as 'The live page answered with an error' (today "A problem was seen on the live page" is a bit strong); (3) the combined label; (4) after a 429 stop the verdict still says "no live check was run" (`zeroChecksSentence`); (5) the line "N of 7 live page checks gave a result ..." under WHAT YOU SEE and the older line "No live check was run, so nothing was seen on the live page." are redundant; (6) on a 500 page the verdict "No cause could be found from what was given" sits next to a possible-conflict line; (7) "Repeated rate limiting (1 x HTTP 429)" at `probe/safety.js:91` says "Repeated" for one 429 (a safety file: its own small step); (8) the headline "No confirmed breaking cause was found" for a quiet no-files 200 page may read stronger than it should); then ONE full run | 2.5 to 3.5 days | Most WordPress users cannot give files or a database. This is the widest audience. | S0 to S0d, S1a to S1d and the S1 fixes done (f1a794c, 83d952b, f49a796, a490e22, 3a85421, 2abfccc, ee782f4, 0d1a11a, 7a9952a, 4e56cd0); S2 done (109bc49); S3 done (c611e59 to 688ee6d; S3-docs 88b3049 and a590893); V1 done (2a3a189); S4 done in code (S4ab b44ab8a, S4ab-fix 8818ff8, S4c f576c7f, S4c-fix 79ae3de; S4-docs ddff184 and a432c98). Point 7 (the "Repeated" label, `probe/safety.js:91`) is NOT done: it is its own small step (row 4b). The ONE full run after S4 (`p-s4`) is done and valid |
| 3b | Build the no-code mode, part 2: **S5** Site Health text and pasted plugin list, 0.5 day; **S6** public `debug.log` check, 0.5 day; **S7** error e-mail text (after the masks of S0) and Plugins-page screenshot, 0.5 day each | about 2 days | Extra inputs for people who can copy a text but not give files. | waiting (3a is done in code; the owner's real-site runs come first) |
| V1 | Plan (plan only first) for the `issue/validate.js:107` defect: the oracle gets `probe.planned || probe.pages.length`; in real data `planned` is an object (`issue/probe.js:178`), so the oracle never sees "partial". The helper `plannedLoads` (`issue/checkpoints.js`) reads both shapes. Verdict code: the owner decides first | S/M | A partial probe must not give a stronger verdict than it should. | done (2a3a189; new suite `selftest-probe-plan`; no verdict rule changed) |
| CI-C | Docker suites: set `PG_PROBE_NAV_DELAY_MS` and `PG_PROBE_REQUEST_DELAY_MS` to 0 in the test environment of the 9 Docker suites that do not set them. Only after the timed full run (`~/pg-runs/ci/run-full-timed.sh`) shows where the Docker time goes; the probe pacing is a safety rule for real sites, a sandbox is a throwaway copy on 127.0.0.1 | M | Possibly several minutes of the 27 Docker minutes. Not measured. | open |
| CI-D | A parallel offline runner as an extra command (`test:offline` stays): at most 3 workers, at most 2 Chromium suites at once, suites that read the whole tree (hygiene, docs, knowledge-review, checkpoints) alone at the end; same check lines in the same order, 3 repeats | M | Offline about 12 to 13.6 min now. | open |
| CI-E | A direct `node` loop instead of about 80 `npm run` start-ups | S | Estimated 0.5 to 1 min. Not measured. | open |
| 4 | Real-site runs by the owner on 2 or 3 real sites, then review of the reports | 1 to 2 h | Tests use made-up sites. Real sites find what tests miss. After 3a, so the new mode is tested too. | next: the owner's step (3a is done in code; the full run `p-s4` after S4 is valid) |
| 4a | Masking of e-mail addresses, IP addresses and the website address in the reports. Now unmasked: the address and the raw step text in `ISSUE-REPORT.md`, `issue.html`, the steps of `findings.json`, `evidence.json`, `probe/result.json` (text and address); the address alone in `probe.json`, `issue.json`, `issue.md` (see SAFETY 6, HANDOFF 92) | size to set by the owner | Reports may be shared; a client's address must not leak. | own step, not started |
| 4b | The label "Repeated rate limiting (1 x HTTP 429)" at `probe/safety.js:91`: one 429 says "Repeated" (a safety file; the stop itself is correct) | S | Wording must be true. | own step, not started |
| 4c | The classic scan `--url` check (`lib/config.js:52`): the address check did not change it; an address with hidden characters or spaces should be refused there too (found by the deep review of the address check) | S | The same rule for every address that enters the tool. | own step, not started |
| 4d | The oracle line "symptom reproduced: no" for a 404 page that the verdict itself reports (found on a real run) | S | One report must not say two things about the same page. | own step, not started; to be looked at |
| 4e | The sentence "Your address answered HTTP 404" is shown twice in the report (found on a real run) | S | A sentence once. | own step, not started; to be looked at |
| 4f | The message shown after Enter at the folder question (found on a real run) | S | The wording must be plain and true. | own step, not started; to be looked at |
| 4g | A `%20` in a screenshot path is not decoded (found on a real run) | S | A screenshot path with an encoded space should be found. | own step, not started; to be looked at |
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

Since S1 and S2 the tool also runs without a site folder (`--no-files`, or typing `none` in the wizard); with a site folder nothing changed. An empty site folder still works and gives a weak result.

## Decisions made

- 2026-11-16: the repository is private until the owner decides. History is not rewritten. The local project name used in tests is not a client name, so C8 is small.
- 2026-11-16: the command is `wp-issue-diagnoser`, the npm script is `diagnose`, `npm run guard` stays as the advanced entry. Internal names (Docker labels, `PG_*` variables, the reports folder, the config file name, User-Agent strings, file names) stay until Stage 2.
- 2026-11-17: reports must never read stronger than the test: "Looked at" names the code only if code files were read; checks that need code are "not checked" when no code was read; a mismatch sentence says what the confirmation really rests on.
- 2026-11-17: all Coder work and full runs stay on one machine (the Linux PC). The Baseline is machine-specific.
- 2026-11-17: small fixes are batched, with one full run at the end of the batch.

## Leftovers (Stage 2 and later, not planned yet)

- Messages and test pins that still carry the old name: `scripts/guard.js:216`, `lib/workflow.js:138` and `:161`, `lib/playwright.js:21`, the SKIP texts in 14 suites, the install placeholder path in the guide.
- Internal names: Docker labels and project prefix, `PG_*` and `PLUGIN_GUARD_*` variables, the reports folder, the config file name, User-Agent strings, file names.
- Pasted log text without a site folder (a log-only mode with a file path was built in S1d, 7a9952a).
- A lighter reviewer for docs-only steps.
- Working from a second machine (needs its own baseline, key and history copy).

## Report levels (short)

1. Tested on a copy of your site (the copy shows the same problem).
2. Not tested on a copy.
3. The test copy could not confirm this.
4. Tested on a test site built from your files (no database file).
