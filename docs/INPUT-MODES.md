# Input modes and question phases

**PROPOSAL, not built.** This is a design for the owner to approve. No code was changed for it. Everything under "What exists today" was read in the code on 2026-11-17 and has a file and line; everything else is a proposal.

## Goal

Most people who have a WordPress problem cannot give a site folder or a database file. They can say what is wrong, show a screenshot and give the address of the site. The tool should:

- check what it can from the outside (the page, the console, the network, a public log if there is one);
- give the nearest possible causes and ask more about plugins, theme and the problem;
- say clearly that the code and the database were not given, so nothing was tested on a copy, so every cause is **possible, not confirmed**;
- never claim more than was tested.

## 1. What exists today

### 1a. The questions of the command today, in order

`lib/wizard.js` (comments at lines 1 to 5). A flag always wins over a question. With `--yes`, no terminal or `--no-prompt` nothing is asked and a missing value is an error (exit 2).

| # | Question | Shown when | Where |
|---|---|---|---|
| 1 | What is wrong? | always (one word is not enough) | `lib/wizard.js:45` |
| 2 | Screenshots (a file or folder, or Enter to skip) | always | `lib/wizard.js:54` |
| 3 | Website address, or Enter to skip ("the site is then not visited at all") | always | `lib/wizard.js:76` |
| 4 | The site folder: one found site "Use it? [Y/n]", or a numbered list or folder browser, or a typed path | always; **it cannot be skipped** ("This one is needed: the code of the site is what gets analysed.") | `lib/wizard.js:84` to `:117`, `:92` |
| 5 | Which log: none asked; the log is found inside the site | always | `lib/wizard.js:125` to `:129` (`lib/log-finder.js:11`) |
| 6 | Is it local, staging or live (one yes/no line when the tool guesses it; the live domain must be typed) | only with an address | `lib/wizard.js:130` to `:173` |
| 7 | "This folder looks like PHP 8.3. Is that the version this site runs? [Y/n]" | only if the folder name hints a version | `lib/wizard.js:180` to `:186` |
| 8 | A database export file (Enter for none) | only if Docker works, the site is not live and no copy flag was given | `lib/wizard.js:196` to `:204` |
| 9 | User accounts of the copy (1 dummy users, 0 skip the copy) | only with a database file | `lib/wizard.js:211` to `:220` |
| 10 | Follow-up questions: since when, which page, logged in, what it looks like, PHP, which page redirects, which screen (at most 5: 3 before the probe, 2 after the analysis) | only when the answer is missing and a terminal exists | `issue/questions.js:1` to `:15` |
| 11 | After the report: "Open it in your browser now?" (whenever a report exists, with a terminal and a display); then, only when there is a cause or a sign: can you update, do you have a licence, is this a copy with a backup, which plan | with a terminal | `lib/wizard.js:261` to `:275`, `issue/plan-questions.js:1` to `:8` |
| 12 | Feedback (free text, score 1 to 5) | with a terminal | `lib/wizard.js:280` |

So there is **one flat list**. There is no branch for people without a site folder.

### 1b. What the live probe and the browser capture

One page load at a time, GET only, paced, stops at the first sign of protection (`probe/safety.js`, `probe/worker.js:68` to `:110`). For each page it records:

- the HTTP status, the first status and whether it was retried, the page title, the final address and the redirect chain (`probe/worker.js:78` to `:80`);
- only two response headers, `server` and `x-powered-by` (`probe/worker.js:83`, `probe/recorder.js:73`);
- console messages of type **error** only (`probe/recorder.js:27` to `:29`), uncaught page errors with a short stack (`probe/worker.js:87`), failed requests and error responses (`:88`, `:89`);
- every script and stylesheet address with its status, the component it belongs to, and duplicate libraries (`probe/worker.js:90` to `:94`);
- jQuery present or not, the horizontal scroll, the text of the page (up to 200000 characters), the largest-contentful-paint time (`probe/worker.js:95` to `:98`);
- the page context (post id, type, template, page builders, theme and plugin slugs) (`probe/worker.js:103`, `probe/wp.js:48` to `:68`);
- a screenshot of the first screen (`probe/worker.js:106` to `:108`) and layout checks that only read the page (`:110` onwards);
- requests that the page tried to send that are not GET: they are blocked and counted (`probe/recorder.js:43`, `installReadOnlyGuard`).

It does not keep the page source, cookies or any other header. Nothing is clicked or typed outside a test copy.

### 1c. Plugins and themes from the public page

- **In issue mode:** the probe finds plugin and theme folder names from the asset addresses and the page's body classes, and the page builder (`probe/wp.js:48` to `:68`), and names the component of a failing file (`assetSource`, `probe/wp.js:71` onwards). It does **not** read versions. The slugs are saved in `probe.json` but nothing in the analysis uses them: the known-conflicts check works on the plugins found in the code (`issue/kb.js:12` to `:15`, `ctx.installed`).
- **In the older scan only** (`npm run guard -- scan <project>` with an address): `lib/live.js` reads plugin versions from `?ver=` (`lib/live.js:117` to `:118`, with the note that it may be a cache number), the generator tag (`:123`), REST namespaces (`:133` to `:140`) and plugin `readme.txt` files (`:175`). It is not part of the question flow.

### 1d. A public `debug.log`

- Issue mode never asks the site for `wp-content/debug.log`. The "debug log" check reads the growth of the **local** copy of the log (`issue/probe.js:34` to `:42`, `:155`).
- The older scan does: `lib/live.js:59` asks for `/wp-content/debug.log` with a GET and checks that the text looks like a PHP log, and reports "publicly readable" as a P0 finding. It is GET only. It does not use the live-site confirmation of the wizard.

### 1e. Screenshots and OCR

- `issue/ocr.js`: text in a screenshot is read locally (tesseract.js, language data checked by SHA-256), at most 20000 characters. The text is redacted (`lib/redact.js`).
- `issue/clues.js:1` to `:5`: the text becomes clues (error messages, file paths, function names). A clue from a screenshot or from prose is only **possible**; a parsed log line is **certain** about what the log says.
- Clues feed the hypotheses; they can never confirm a cause (only the log, the code, the live page and a test on a copy can: `issue/validate.js:59`).
- A screenshot named `expected-...` and one named `actual-...` can be compared with the probe screenshot (`issue/probe.js:65` on).

### 1f. Which of the 53 known-problem checks work without code

Case: a site folder with no code, a log and (second run) a live address, tested on 2026-11-17 with the current code (`~/pg-runs/s0/d4.txt`, `d5.txt`):

| Group | Count | Which |
|---|---|---|
| Work without code (log) | 2 | cp-30 (memory and execution limits), cp-31 (missing PHP extensions). They read the log. |
| Work without code (live page, with an address) | 7 | cp-38 white screen, cp-39 HTTP 5xx, cp-40, cp-41, cp-43, cp-44 and cp-45 (cp-45 is "Failed asset requests"). They can only give a result when the page probe ran to the end. With an address that answers 500 the probe stopped early: only 3 of the 7 gave a result (2 FAIL: cp-38 and cp-39, 1 ALSO NOTICED: cp-45); cp-40, cp-41, cp-43 and cp-44 stayed NOT CHECKED ("the live page probe stopped early"). |
| Need code | 29 | "the site folder holds no code files, so no code was read" (`issue/checkpoints.js:32`) |
| Only the older scan | 4 | "only the classic scan checks this" |
| Not built yet | 11 | for example REST invalid JSON, `.htaccess`, cron, the real plugin load order |

The 53 are in `data/checkpoints.json` (generated from `docs/COVERAGE.md`).

### 1g. What the report shows with no code and no database

From the runs of 2026-11-17 (`~/pg-runs/s0/`):

- The command **refuses** to start without a site folder: exit 2, "Missing required value: the site folder." (case e, thrown in `lib/wizard.js:116`, pinned by `selftest-plugin-guard.js:157`).
- With an empty folder and a log: "VERDICT: No confirmed breaking cause was found. How sure we are: not very.", "Looked at: your log. Not looked at: the live page, the code, a throwaway test copy.", "NOT TESTED ON A COPY", "NOT TESTED: what this report says comes from reading your log.", "2 pass, 0 fail, 51 not checked", and the cause "defined twice (the log says so; no code file was read to show where)".
- **Found while writing this:** the advanced command `issue investigate <id>` **crashes** when no folder is given ("Cannot read properties of undefined (reading 'components')", `lib/issue-cli.js:289`). The pipeline itself is written for a missing folder (`issue/evidence.js:91`, `issue/probe.js:156`), only this line does not handle it.
- **Found while writing this:** with a live address and no code, the label still says "comes from reading your log" although the live page was also looked at (`issue/case-file.js`, `notTestedLabel` knows only the log and the code).

## 2. The scenarios

| Mode | What the person gives | What the tool can honestly do | Report level and wording | What to ask next |
|---|---|---|---|---|
| **A** | site folder, database file, sandbox allowed | Read the code, build a test copy with dummy users, try the problem there, find the smallest set of plugins that causes it | Level 1 "Tested on a copy of your site", or level 3 "The test copy could not confirm this" | nothing more; the PHP version if unknown |
| **B** | site folder only | Read the code and the log, build a test site from the files without real data | Level 4 "Tested on a test site built from your files" (weaker: no real data), or level 2 | "Can you also give a database export?" |
| **C** | site folder, no copy wanted or no Docker | Read the code and the log | Level 2 "Not tested on a copy", with what was missing | what would allow a copy (Docker, a database file) |
| **D** | address, description, screenshots, maybe a log text; **no folder** | Look at the live page (status, console errors, failed files, which plugins and theme the page loads), read the log and the screenshots, match what it saw against the known-conflict list | Level 2, "possible causes, not confirmed"; "Looked at: the live page, your log"; "Not looked at: the code, a test copy" | plugins, theme, what changed last, which page, since when |
| **E** | only a description, or a log text | Read the text (log lines are certain about what the log says; prose is only a hint) | Level 2, very weak, says so in the first line | the address, a screenshot, the plugin list |

Today only A, B and C exist, and each needs a site folder. D and E are not available (1g). The wording for D and E can reuse the "no code" rules of 2026-11-17: "Looked at" names only what was really read, checks that need code are "not checked", and a mismatch sentence says what the confirmation rests on.

## 3. The question phases (proposed)

Written for a person who is not a developer. Every question can be skipped with Enter. Nothing is asked when there is no terminal or with `--yes`.

**Phase 1: everyone (a few minutes)**
1. What is wrong? Say what you see, what you expected, and what changed just before.
2. The address of the website (Enter to skip). If it is a public site: "Type the site's name to confirm that you may test it."
3. A screenshot of the problem (Enter to skip).
4. When did it start, and did you change anything just before (an update, a new plugin, a new theme)?
5. On which page and on which kind of screen do you see it?

**Phase 2: the branch**
6. "Can you give the tool the site's folder (the wp-content folder)?" This is a yes or no with a short explanation of what it changes: with the folder the tool can read the code; without it the tool can only look at the page from outside.
   - **Yes:** ask for the folder (as today), then phase 3a.
   - **No, or Enter:** phase 3b.

**Phase 3a: with a folder** (as today)
7a. Is that the right PHP version? A database export file (only if Docker works and the site is not live). The question about dummy user accounts.

**Phase 3b: without a folder**
7b. "Which plugins do you use? You can copy the list from Plugins in the WordPress admin, or paste the text of Tools, Site Health, Info, 'Copy site info to clipboard'." (see section 4)
8b. "Which theme do you use, and is it a child theme?"
9b. "Is there an error text? For example from the e-mail WordPress sent you, or from a debug log." (see section 4)

**Phase 4: confirm and run**
10. A short summary: "I will look at this address, read this text and these screenshots. I will not change anything on your site. I cannot test on a copy because I have no code and no database, so every cause will be marked possible, not confirmed. Go on? [Y/n]"
11. The report, the plan, and the questions after it (as today).

## 4. New input ideas, with risk and the safe way

| Idea | What it gives | Risk | The safe way |
|---|---|---|---|
| **Site Health "Copy site info"** text | PHP, database and WordPress versions, the list of active plugins and their versions, the theme | Exists as a flag (`--site-health <file>`, `lib/issue-cli.js:99` to `:102`, `lib/version-detect.js:92`): at most 256 KB, strict patterns, only the parsed values are kept. The text can hold the site address, paths and server names. Today the plugin list is read but not used to look for known conflicts. | Keep the strict parser; keep only the parsed values; show the person what was understood and let them confirm; map names to plugin folder names with a fixed table; label the result "from what you pasted". |
| **The "technical issue" e-mail** WordPress sends after a fatal error | The plugin or theme name and the error text. | The e-mail holds a **recovery-mode link with a secret key**. The current text redaction does **not** mask `rm_token=` or `rm_key=` (checked: `lib/redact.js:4` only masks words that end exactly at `token`, so `rm_token=...` passes). Pasting it would put a login key into a report. | Before this input exists: add masks for these keys and a test that the key is gone; ask the person to paste only the part with the error; refuse a text that still holds a link with `action=enter_recovery_mode`; never store the raw paste; treat the error line like a log line (certain about what it says). |
| **A screenshot of the Plugins page** | The list of plugins and versions, active or not, "update available" | OCR can misread names and numbers; the screenshot may show the admin e-mail or user name. | OCR runs locally already (`issue/ocr.js`); take only text that matches a plugin name from a fixed list; show the list and ask "Is this right?"; a clue from OCR stays "possible"; keep the screenshot like every other one (EXIF stripped, redacted text). |
| **A pasted plugin list** (WP-CLI `plugin list`, or typed names) | The same as above without OCR | Names typed wrongly. | The same fixed-table mapping and the same confirmation line. |
| **Console messages of type warning** (today only errors are kept, `probe/recorder.js:29`) | More clues for broken scripts | More noise, longer reports | Keep them out of the headline; show them only under "For a developer". |

## 5. Rules for all modes

- **Read-only.** Nothing is written to the site. A pasted text is data: cut, cleaned, never run.
- **GET only**, one request at a time, paced, stop at the first sign of protection. A request to a site is allowed only for an address the person confirmed. A live site needs the typed domain (or `--authorized`).
- **No claim stronger than the test.** Without code and without a copy every cause is labelled "possible, not confirmed". "Confirmed" stays reserved for the validator (two independent checks of the log, the code and the live page, `issue/validate.js`).
- **Say what was not done**, in plain words, in the first lines: no code, no database, no test copy.
- **Say what the person can give to get further** (the folder, a database export, the plugin list).
- No AI is called. The same input gives the same output.
- A public `debug.log` is read only with a GET, only on a site the person confirmed, and the content is treated as sensitive: redacted before it is stored, and the exposure itself is reported as a finding for the owner of the site.

## 6. What is missing, ranked by value for non-technical users

| # | Missing | Needs code change | Proof it is missing today |
|---|---|---|---|
| 1 | Run without a site folder (modes D and E) | yes: the question, the pipeline entry and the crash fix | the command refuses (`scripts/plugin-guard.js`, exit 2); `issue investigate` without a folder crashes at `lib/issue-cli.js:289` |
| 2 | Question phases with a branch | yes (`lib/wizard.js` only) | one flat list, the folder question cannot be skipped (`lib/wizard.js:92`) |
| 3 | Plugins, themes and versions from the public page, used to match known conflicts | yes | slugs are saved but unused (`issue/kb.js:12` to `:15`); no versions in issue mode |
| 4 | Honest wording for modes D and E (labels name every source that was read) | yes, small | `notTestedLabel` knows only the log and the code (`issue/case-file.js`) |
| 5 | A public `debug.log` check in issue mode | yes | only `lib/live.js:59` |
| 6 | Site Health list used as the plugin list | yes | parsed (`lib/version-detect.js:92`) and used only as the fallback list of active plugins compared with the files of a test copy (`issue/version-match.js:219`, `:230`, called from `issue/sandbox.js:443`); never used to look for known conflicts |
| 7 | Screenshot of the Plugins page, pasted plugin list, error e-mail text | yes (the e-mail needs the redaction first) | not in the code |
| 8 | Console warnings | yes, small | `probe/recorder.js:29` |

## 7. Proposed build order (small steps, each with tests)

| Step | What | Tests | Size |
|---|---|---|---|
| S1 | Allow a run without a folder: fix `lib/issue-cli.js:289`, accept "no folder" in the command, and make "Looked at", the NOT TESTED label and the counts name only what was read (the live page counts) | a fixture run with only a description and a log; the same with a local address | 0.5 day |
| S2 | The question phases in the terminal (phase 1, the branch, phase 4) | scripted answers for each branch, with and without a terminal | 0.5 to 1 day |
| S3 | Live observations in the report: plugin and theme slugs with `?ver=` versions from the page, the generator tag, console warnings under "For a developer"; feed the slugs to the known-conflicts check as "possible" | a fixture site with known plugins and a known conflict | 1 day |
| S4 | The report layout for D and E: ranked "possible causes, not confirmed", a "What I could not do" box, "What you can give to go further" | golden report for a fixture; the wording scan | 0.5 to 1 day |
| S5 | Site Health text and a pasted plugin list as the plugin source (names mapped by a fixed table, confirmed by the person) | parser tests with hostile text; the mapping table test | 0.5 day |
| S6 | A public `debug.log` check with a GET (redacted, reported as exposure) | fixture server with and without a log; the redaction test | 0.5 day |
| S7 | The error e-mail text (after masks for `rm_token` and `rm_key` and a test) and the Plugins-page screenshot | redaction tests; OCR fixture with a plugin list | 0.5 day each |

**Build status (2026-11-18):** S1a is built (commit `2abfccc`: the option `--no-files`, the crash fix at `lib/issue-cli.js:289`, refusals with `--root`, `--sandbox`, `--db-dump` and `--log`, the end-to-end suite `scripts/selftest-no-files.js`). S1b is built (commit `ee782f4`: the zero-checks verdict, no "on this site" wording without a folder, the true last line, the reason "no site files were given", the NOT TESTED label from what was really read). S1c is this documentation. **S1d (not built): `--log` together with `--no-files`** (log text without a site folder; today it is refused with a plain message), then case (b) of the S1 plan can be run.

The order is S1, S2, S3, S4, then S5 to S7. D1 itself (this file) makes no code change. A full run is needed after S1 to S4, before the owner pushes.
