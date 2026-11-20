# Project history: wp-issue-diagnoser

Written 2026-11-18 for a new chat that knows nothing. Every fact has its source in brackets. Short names for sources: **[git]** = `git log` of this repository; **[ROADMAP]** = docs/ROADMAP.md; **[HANDOFF n]** = row n of docs/HANDOFF.md (the decisions log); **[IM]** = docs/INPUT-MODES.md; **[SAFETY]** = docs/SAFETY.md; **[RS]** = docs/REPORT-SPEC.md; **[README]** = README.md; **[TESTING]** = docs/TESTING.md; **[WORKFLOW]** = docs/WORKFLOW.md; **[history]** = the dated history file kept outside the repository (it is not linked from the docs on purpose [docs/README.md]). Anything not found in these files is listed in section 8, never guessed.

## 1. What the tool is and what it does today

**One tool.** wp-issue-diagnoser (package `wp-issue-diagnoser`, version 0.3.0 [package.json]) is a read-only WordPress review tool: plain Node.js 20.12 or newer, CommonJS. It looks at a local copy of a WordPress site (plus an optional live address, WP-CLI and a Docker test copy) and finds plugin conflicts, dependencies, exposure and the likely cause of ONE reported problem ("issue mode"). It makes a report and a fix plan. It never changes the site it looks at [CLAUDE.md, Overview].

**Commands** [CLAUDE.md, Commands]:

| Command | What it does |
|---|---|
| `npm run diagnose` (bin `wp-issue-diagnoser`) | The plain wizard: asks the problem, screenshots, an address and the site folder; copies the site read-only; runs the issue pipeline with the gate and the follow-up questions. Flags-only use is possible. |
| `npm run guard -- issue new / investigate / show / list / open / index / cleanup` | Issue mode in steps. |
| `npm run guard -- issue retest <id> --root <fixed copy> [--sandbox]` | Repeats the oracle after a fix on a COPY. Only this can set FIXED_VERIFIED. |
| `npm run guard -- doctor`, `scan --root .`, `npm run demo` | Prerequisite check, the older classic scan, a worked example. |
| `npm test`, `npm run test:offline`, `scripts/run-full.sh <label>` | All suites; the offline suites (68); the ONE full run on a snapshot with a Docker baseline check [CLAUDE.md; TESTING]. |

**New since 2026-11-18:** `--no-files` runs the wizard with NO site folder (description, screenshots and an address only). It is refused together with `--root`, `--sandbox`, `--db-dump` and `--log`. Without either `--root` or `--no-files` the old refusal stays: "Missing required value: the site folder." [HANDOFF 87; git 2abfccc, ee782f4].

**Input modes** (the target list) [ROADMAP, "Input modes"; IM section 3]:

| Mode | Inputs | Exists today? |
|---|---|---|
| A | files, database file, sandbox allowed | Yes: test copy from a database file in Docker, with a fidelity check [HANDOFF 47 to 54] |
| B | files only | Yes: a test site built from the files, report level 4 [git 88d8b9b] |
| C | files, no sandbox | Yes: report level 2 [README] |
| D | live address, description, screenshots, log, no files | Partly: `--no-files` (or typing `none` at the folder question) with a description, screenshots, an address and a log file (`--log <file>`, or the one log question); the page is loaded with GET only; the log is read as masked text and may give a possible cause, not confirmed [HANDOFF 87, 90] |
| E | only a description or a log | Partly: a description only gives "Nothing could be checked"; a log file alone gives "The log shows a possible cause" or "No cause could be named from the log" (a file path, not pasted text) [HANDOFF 87, 90] |

**Report levels** [ROADMAP, "Report levels"; HANDOFF 54]: 1 "Tested on a copy of your site"; 2 "Not tested on a copy"; 3 "The test copy could not confirm this"; 4 "Tested on a test site built from your files" (no database file).

**Verdict owners** (one each) [CLAUDE.md, Hard constraints]: `issue/hypotheses.js` only proposes; `issue/validate.js` alone assigns CONFIRMED, REPRODUCIBLE or REJECTED_FALSE_POSITIVE; only `issue/retest.js` can give FIXED_VERIFIED. Issue mode is deterministic and offline: no LLM or API call.

**What is NOT built** [ROADMAP; IM section 7; HANDOFF 87]: live observations such as plugin versions from the page and known-conflict matching (S3); the report layout for modes D and E (S4); pasted log text (a log is given as a file path only); Site Health text, a pasted plugin list, a public debug.log check, the error e-mail text and a Plugins-page screenshot as inputs (S5 to S7); masking of real user accounts in a test copy (6c-3); checkpoint step B (`wp_head`, `wp_footer`, `wp_body_open`, `DISABLE_WP_CRON`); real-site runs by the owner.

## 2. Timeline, oldest first

Dates are commit dates [git]. Hashes are from this repository's history; HANDOFF rows may quote older hashes from the source repository the work came from, so they can differ.

### Before this repository (the Plugin Guard module and its tiers)

| Date | Step | Commit | Why / what was tested |
|---|---|---|---|
| 2026-10-28 | Plugin Guard module and project docs added | 4283b6a | Start of the history in this repository [git]. |
| 2026-10-29 | Own probe and Playwright resolver; code that needs the frontend module moved to `src/combined` (steps 0 to 3) | 3ad6d9e, 7a748eb | Make issue mode a standalone flow with no dependency on the frontend module (decision 1) [HANDOFF 1; git]. |
| 2026-11-02 | Oracle judges redirect loops and 200-status white screens; classic checks and duplicates feed issue mode; static compatibility advisories; redirect caller map; follow-up question engine (steps 5 to 6) | d95fa4c, ef6431e, 5a4a568, ab1fe42, 954e894 | Gather evidence and ask only what is needed [git]. |
| 2026-11-02 | Conflict-type labels, the confirmed-and-breaking gate, causes, rollback; gate wired into reports; the interactive command and the redacted site copy (steps 7, 7b, 8) | dc7d4bb, d93c75e, 002b72f | Show only confirmed, breaking causes; the rest are advisories (decision 3) [HANDOFF 3; git]. |
| 2026-11-03 | Log fatals re-checked in `validate.js` (rules A and B); "Most likely cause" tier; plain wizard; report polish for a non-technical reader; checkpoint step A | 6f39bcf, 14a5c14, 78ac9d3, f5bbf9e, 9e3dea6, dc9ba22 | Plain wizard: numbered folder list, logs found by itself, no PHP question (decisions 16 to 19) [HANDOFF 16 to 19; git]. |
| 2026-11-04 | Checkpoint FAIL only when tied to the crash; REPORT-SPEC Part 1 (case-file layout), Part 2 (cause detail), `namesClass` rule, Part 3 (choice questions and FIX-PLAN.md) | 76d3da3, 3c1e858, c2d5f1e, 9e04705, 8e54602 | The approved report design [RS; HANDOFF 24 to 39]. |
| 2026-11-05 | Step 7a (core options list, per-use guards); polarity of guard recognition; REPORT-SPEC Part 5 (status line, file link, feedback); test copy 6a (real database import, web container stopped until the rewrite is done); 6b (version detection with sources) | 2897b83, b0cf12f, 2f06985, fb1cb02, b610763 | Runs `p-7ab`, `p-part5`, `p-6a`, `p-6b` were green; the 6a real-container suite had 34 PASS [HANDOFF 42, 44, 46 to 48]. |
| 2026-11-06 | 6c-1 (the web container has no route out); reduced 6c-2 (dummy users only); 6d-1 (active plugins from the imported database) | 04cc3dc, 2033a32, 190bb2d | Runs `p-6c1`, `p-6c2b` (3895 PASS), `p-6d1` (4020 PASS) green [HANDOFF 49 to 52]. |
| 2026-11-10 | 6d-2 (fidelity check of the test copy against the real site); 6d-3 (three report levels, the "How close the copy is" box, one wizard question) | 0eb6402, 88537cf | Runs `p-6d2` (4121 PASS) and `p-6d3b` (4222 PASS) green, every real-container suite ran [HANDOFF 53, 54]. |
| 2026-11-11 | Wrong-address wording (401, 403, 404, 429); "You chose not to build a test copy."; step 9 (isolation suite) | 908b6cf, 4f60ce0, ef34767 | Faults seen on two real runs were fixed in gate-on output only [HANDOFF 57, 59, 60]. |
| 2026-11-12 | Step 10 docs; standalone repository prepared; package renamed to wp-issue-diagnoser; second-site tests; fourth report state; command hints | 8991fae, 443c54d, 4907deb, 4c39caf, 88d8b9b, b64d75e | A second, made-up site checks that the tool is not tuned to one site [HANDOFF 62, 63; git]. |
| 2026-11-13 | Standalone polish; docs without contradictions; exact claims about the database scrub and what "live" means | df2be7c, b25a829, e5088b4, d9a68d8 | Wording made exact [HANDOFF 64, 65; git]. |

### This repository's own plan (from 2026-11-16)

| Date | Step | Commit | Why / what was tested |
|---|---|---|---|
| 2026-11-16 | New working repository; maintainer docs; `.gitignore` and hygiene fixes; three tests made portable | db0206f, 7069f9f, bb5df4e, 4c7d1b4, a3437f1, 2cf04dc, cda986e | The work moved to a clean clone; the old repository became a read-only backup [HANDOFF 67 to 71]. |
| 2026-11-16 | C2: `npm test`, `scripts/run-full.sh`; C4, C5 wording; first green baseline | e6f546a, f17bb0c, 8909198, 38c4517 | `p-c2` was not valid; `p-c2b` was valid: 75 suites, 4468 PASS, 0 FAIL, 7 SKIP, 38 min 43 s [HANDOFF 75, 76; TESTING]. |
| 2026-11-16 | README for other users, docs map, command renamed to `wp-issue-diagnoser` (Stage 1) | a24f6eb, f821ddd, b4470a2, 5e890ad | `p-n1`: 4478 PASS, 0 FAIL, 7 SKIP, 38 min 12 s [HANDOFF 77 to 79; TESTING]. |
| 2026-11-17 | Honest wording when no code was read (H1, H2); README limits; tighten a test; probe counts one connection error once; roadmap added; input modes designed (D1) | b94f39c, 0dfa3dc, 93659c0, a14f3d3, 24e0a0e, 786646a, 566d1e1, 90c09cc | `p-h1`: 4489 PASS, 0 FAIL, 7 SKIP, 43 min 34 s [HANDOFF 80; TESTING; git]. |
| 2026-11-17 | S0 and S0b: recovery keys, nonces, cookies, passwords, tokens and URL passwords are masked; a last pass over the report files | f1a794c, 83d952b, f49a796, 0053fd9, e130f73 | New suite `selftest-redact` (63 checks); the extra review of 83d952b then found four real defects (D1 to D4) [HANDOFF 81 to 83; history]. |
| 2026-11-18 | S0c: the four defects fixed (retest compares masked pages; probe output masked and fail closed; whole-run masks; JSON, colon and PHP-dump forms) | a490e22, 68e8f62 | `selftest-redact` grew to 181 checks; `test:offline` 4354 PASS, 0 FAIL, 3 SKIP [HANDOFF 84]. |
| 2026-11-18 | Full run `p-s0` and the baseline | 0c27ded | Valid: 76 suites, 4692 PASS, 0 FAIL, 6 SKIP, 38 min 56 s, Docker 5/0/11 before and after [TESTING; history]. |
| 2026-11-18 | M1: roles, models, step size and token budget (a second reviewer agent for docs-only diffs) | 809f1ed | Docs and one agent file; the light reviewer found 5 wording defects in two rounds [HANDOFF 85]. |
| 2026-11-18 | S0d: masking corpus test (173 secret forms, 137 benign texts) and the short-value rule; exact exception for the database error text | 3a85421, a9528dc, f0badde, 9ea0480, 020c778 | `test:offline` 4670 PASS, 0 FAIL, 2 SKIP [HANDOFF 86; history]. |
| 2026-11-18 | S1a, S1b, S1c: `--no-files`, honest wording without a site folder, docs | 2abfccc, ee782f4, 9383889, 5c2174e | `test:offline` 4717 PASS, 0 FAIL, 2 SKIP [HANDOFF 87]. |
| 2026-11-19 | S1b-fix: honest log reason ("no site files were given") and honest verdict for an error page or a failed live check, no site files | 0d1a11a, f68a266 | `test:offline` 4732 PASS, 0 FAIL, 2 SKIP; the one allowed assertion change at `selftest-issue-evidence.js:173` [HANDOFF 89] |
| 2026-11-19 | S1d: `--no-files --log <file>`, a log without a site folder, possible causes only | 7a9952a | `selftest-no-files` 60 -> 111 checks; `test:offline` 4783 PASS, 0 FAIL, 2 SKIP; deep review 2 rounds [HANDOFF 90] |
| 2026-11-19 | S1d-fix: the log refusal as a rule (packed files, dotted dump names, trailing junk) | 4e56cd0 | 138 checks; `test:offline` 4810 PASS, 0 FAIL, 2 SKIP [HANDOFF 90] |
| 2026-11-19 | S1d-docs: docs for S1d, and the commit that records its hash | 51d77b4, 27c4c17 | docs only [HANDOFF 90; git] |
| 2026-11-20 | S2: the no-files branch in the wizard (type `none`), one optional log question, the summary before go | 109bc49 | `selftest-wizard-plain` 49 -> 82, `selftest-folder-browser` 63 -> 71; `test:offline` 4851 PASS, 0 FAIL, 2 SKIP; deep review PASS in round 1 [HANDOFF 91] |

## 3. Decision log

Decisions 1 to 19 and 21 to 27 are recorded as "approved by the owner" without a date in HANDOFF; their dates are not in the files read (section 8).

| Decision | Why | Date | Source |
|---|---|---|---|
| Issue mode is the main standalone flow, with no dependency on the frontend module; that code moved to `src/combined` | One tool, one command | not dated | [HANDOFF 1] |
| Live probe: read-only, one request at a time, paced, stops at the first 429 or challenge, own cooldown file | Never harm a live site | not dated | [HANDOFF 2; CLAUDE.md] |
| Live site needs the typed domain in the wizard or `--authorized` on the command line; no terminal means refuse | Owner confirmation | not dated | [HANDOFF 8] |
| Plain wizard: folders found by itself, logs only inside the site, no PHP question, one line for the site-kind guess | Fewer questions for a non-technical person | not dated | [HANDOFF 16 to 19] |
| Checkpoint FAIL only when tied to the crash; the rest "Also noticed" | Do not blame a plugin without evidence | not dated | [HANDOFF 25, 30] |
| Report design REPORT-SPEC; Part 1 first | A non-technical reader | 2026-11-04 | [HANDOFF 24, 28, 31, 32] |
| `namesClass`: the cited line must name the class; a `use` line never counts | Fewer false confirmations | 2026-11-04 | [HANDOFF 34, 36] |
| Test copy: dummy users only; `--keep-real-data` retired; named and real accounts later (6c-3) | Never keep real user data | after 6c-1 (date not stated) | [HANDOFF 50, 51] |
| A live site is NEVER copied with its database; `--no-replica` equals "skip the test copy" | Privacy | 2026-11-10 | [HANDOFF 55, 59] |
| A bisect with a different fatal is "inconclusive", never "not a plugin conflict" | A wrong verdict is worse than none | 2026-11-10 | [HANDOFF 55] |
| Work moves to a new repository; history is not rewritten; the repository stays private until the owner decides | Clean start | 2026-11-16 | [HANDOFF 67; ROADMAP, Decisions] |
| Command is `wp-issue-diagnoser`, script `diagnose`; internal names stay until Stage 2 | Clear name | 2026-11-16 | [HANDOFF 79; ROADMAP] |
| Reports must never read stronger than the test: "Looked at" names only what was read | Honesty | 2026-11-17 | [ROADMAP, Decisions; HANDOFF 80] |
| All Coder work and full runs stay on one machine; small fixes are batched with one full run at the end | The Docker baseline is machine-specific | 2026-11-17 | [ROADMAP, Decisions] |
| Masking is best effort and pattern based; e-mail and IP addresses are not masked; screenshots cannot be masked | Be honest about limits | 2026-11-17 | [HANDOFF 82, 83; SAFETY 6] |
| Masking: any non-empty value of a secret name is masked; placeholders only empty, `[REDACTED]` and a run of `*`; exact exception for "(using password: YES)" and "(using password: NO)" | Short passwords such as `admin` leaked | 2026-11-18 | [HANDOFF 86; SAFETY 6] |
| "ONE agent at a time" means one agent that edits files, runs tests or commits; read-only helpers may run in parallel; reviewer-deep and reviewer-light; 3 review rounds for security code, 2 otherwise; step sizes S, M, L | Cost and safety | 2026-11-18 | [HANDOFF 85; WORKFLOW] |
| After a restart or in a new session do not start the next roadmap row; wait for the owner's prompt | The owner decides the order | 2026-11-18 | [CLAUDE.md] |
| S1 split into S1a, S1b, S1c; `--no-files` with `--env live` gets no new rule | Size L became three steps | 2026-11-18 | [HANDOFF 87] |

## 4. Current status

- **Last green full run:** `p-s0`, 2026-11-18, HEAD 68e8f62: 76 suites (66 offline and 10 Docker), 4692 PASS, 0 FAIL, 6 SKIP, 38 min 56 s; Docker 5/0/11 before and after; no restart [TESTING; ROADMAP]. The 6 SKIPs are loud: two git checks of the snapshot, the hints suite in standalone mode, PHP 7.4, 8.0 and 8.1 images.
- **Since that run:** M1, S0d, S1, S1b-fix, S1d, S1d-fix and S2 are covered by `test:offline` only (68 offline suites, last result 4851 PASS, 0 FAIL, 2 SKIP, 2026-11-20) [HANDOFF 85 to 91]. A new full run is still to be done after S4 [IM section 7].
- **Pushed:** the owner pushed up to commit 27c4c17 (the remote-tracking branch points there, as last fetched) [git]. **Not pushed:** the S2 commit (109bc49) and the S2-docs commits (see git log) [git].
- **In progress:** nothing is running. S2 and S2-docs are finished; the Coder waits for the owner's next prompt [CLAUDE.md; HANDOFF 91].

## 5. What is left (roadmap rows in order) [ROADMAP]

| Row | Task | Status |
|---|---|---|
| 3a | No-code mode, part 1: S3 live observations, plugin versions and known conflicts, S4 report layout for modes D and E, then ONE full run | S0 to S0d, S1a to S1d and S2 done; S3 and S4 waiting |
| 3b | No-code mode, part 2: S5 Site Health text and pasted plugin list, S6 public debug.log check, S7 error e-mail text and Plugins-page screenshot | waiting for 3a |
| 4 | Real-site runs by the owner on 2 or 3 real sites, then review | waiting for 3a and 3b |
| 5a | C6: docs leftovers, naming, GET-only wording, git-skip message, comments | waiting |
| 5b | C7: clean-checkout test replaces the isolated-copy test; hints suite for standalone mode; Stage 2 messages | waiting |
| 5c | C8: remove the local project name from tests; check files and history for real client names | waiting |
| 5d | One full run at the end of the batch, then the owner pushes | waiting |
| 6a | Checkpoint step B | waiting |
| 6b | 6c-3 masking (named and real accounts, a known-tables list) | waiting |
| 7 | Decision about going public | waiting (the repository stays private until the owner says otherwise) |

## 6. Known limits and open items

- **Masking** (best effort): an unquoted password with a space keeps the part after the first space; `session` and `cookie` values under 6 characters are not masked; unquoted `pass:` is not masked; `password=ab:1:2:3:4` can leave a tail; `Error: password: field missing` is masked (over-masking); `issue.json` and `issue.md` keep page addresses as typed; `sandbox.json` is not masked; e-mail and IP addresses and screenshots are not masked [SAFETY 6; HANDOFF 86].
- **Reviews not repeated:** the last fixes of S0c round 3 and of S0d round 4 were not reviewed again, because the round limit was reached [HANDOFF 84, 86].
- **Fixed in S1b-fix (0d1a11a):** the log step reason without site files is now "no site files were given, so no log could be read" (`issue/evidence.js:91`, `issue/analysis.js:34`); the assertion `scripts/selftest-issue-evidence.js:173` was changed with the owner's approval [HANDOFF 87, 89].
- **Fixed in S1b-fix (0d1a11a):** without site files, a live page that answered an error status or a failed live check now gets the verdict "A problem was seen on the live page" with only true parts (the status, the number of failed live checks, "No cause could be found from what was given", what is missing); it no longer says "No confirmed breaking cause was found" [HANDOFF 89; REPORT-SPEC 4.0]. A run with a site folder keeps the old wording.
- **Sandbox:** only PHP 8.2, 8.3 and 8.4 images are pinned; 7.4, 8.0 and 8.1 have none [TESTING; HANDOFF 48]. An inconclusive bisect skips the default-theme step [HANDOFF 58].
- **Name leftovers:** internal names (Docker labels, `PG_*` variables, the reports folder, the config file name) still use the old product name until Stage 2 [ROADMAP, Leftovers]. A local project nickname is still in tests and in old commits (C8) [HANDOFF 72].
- **Test chain:** the `isolated-copy` suite is left out of the chain until C7 [CLAUDE.md; HANDOFF 69].
- **Probe:** the live probe sends only GET requests, never logs in, and stops at the first 429 or challenge [CLAUDE.md].
- **Wizard, no-files branch (S2):** with exactly one site found, the "Use it?" question does not show the `none` hint (typing `none` still works, and the hint shows after `n`); the plugin and theme questions are not asked yet (they move to S3 and S5 to S7) [HANDOFF 91].
- **Log without site files:** a leading space in the file name, a trailing `~` and a hard link are not caught by the name rule; `env.log` is refused (accepted false refusal); a log is read as a file path only (no pasted text); the masking is best effort [SAFETY 6; HANDOFF 90].

## 7. Where to find things

| What | Where |
|---|---|
| Rules, commands, hard safety constraints | `CLAUDE.md` |
| Map of every document | `docs/README.md` |
| The plan and what is done | `docs/ROADMAP.md` |
| Decisions and the progress log | `docs/HANDOFF.md` (older step logs: `docs/archive/`) |
| Working model, roles, reviews, step size | `docs/WORKFLOW.md` |
| How it is built and what it may touch | `docs/ARCHITECTURE.md`, `docs/SAFETY.md` |
| What is detected | `docs/COVERAGE.md` (the table behind `data/checkpoints.json`) |
| Designs | `docs/REPORT-SPEC.md`, `docs/TEST-COPY-SPEC.md`, `docs/INPUT-MODES.md` |
| Tests and the baseline | `docs/TESTING.md`; suites are `scripts/selftest*.js` |
| Code | `lib/`, `issue/`, `probe/`, `checks/`, `agents/`, `data/`, `scripts/` |
| Agent roles | `.claude/agents/*.md` |
| The dated history file | a folder outside the repository, kept on purpose; each step adds one dated entry and a secret scan |
| Run logs (full runs and scratch copies) | `~/pg-runs/<label>/` |
| Reports of one investigation | `issues/<issue-id>/result/` (git-ignored) |

## 8. Not found in the files

- The dates of decisions 1 to 19 and 21 to 27 in HANDOFF (they carry no date).
- Which tests ran for the steps 0 to 5 of the early commits (2026-10-28 to 2026-11-02); HANDOFF keeps only the later run labels, and the archive was not read for this file.
- How many commits the source repository had before the history in this repository began; the commits of 2026-10-28 onwards are all that [git] shows.
- The dates of the "two real runs" mentioned in HANDOFF 57 (only 2026-11-11, the day of the fix, is known); the planned real-site runs of roadmap row 4 are not done.
- The date the owner pushed (only the remote branch position is known [git]).
- The exact model versions behind `haiku`, `sonnet` and `opus` in the agent files; the repository does not set them [WORKFLOW].
- Anything about the owner's usage limit; the agent cannot see it [WORKFLOW].
