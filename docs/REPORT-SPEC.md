# REPORT-SPEC: the case-file report, the fix plan and the feedback step

Status: built. Parts 1 (`612c624`), 2 (`cb3630d`), 3 (`0ca5d01`), 4 (the checkpoint list, `a75963f`) and 5 (`698a282`) are done; see docs/HANDOFF.md rows 24-41 and 46. Owner decisions are in section 9. Follow docs/WORKFLOW.md (CEO protocol) and CLAUDE.md "Hard constraints". This file only adds to them.

## 1. Goal

A non-technical person who runs `wp-issue-diagnoser` must be able to read ONE page that answers, for each problem: what do I see, where is it, why does it happen, how sure are we, and what do I do. Today the page has overlapping sections (What is wrong, Summary, Findings, Verdict) that disagree. The detection and the "confirmed needs two independent checks" rules are correct and stay; only the page and the steps after it change.

Real case used as the acceptance example: a real site. `debug.log` repeats `PHP Fatal error: Uncaught Error: Class "Elementor\Core\Schemes\Color" not found in themes/unicamp/elementor/widgets/original/heading.php:48`; the live page answers HTTP 500; theme Unicamp 2.2.0, Elementor 3.35.7, WooCommerce 10.6.1; plus an advisory "outdated template override, 5 templates, Unicamp + WooCommerce".

## 2. Non-negotiable rules

- The tool recommends and writes plans. It NEVER applies a fix and never writes into the site. Third-party code (themes, plugins) is changed only through updates, a theme switch or a child-theme override, never by editing its files: the tool writes text, not patches, for third-party code.
- `validate.js` stays the only owner of CONFIRMED / REPRODUCIBLE / REJECTED_FALSE_POSITIVE. This work changes no status and no verdict rule. If a part seems to need a change there, stop and show the owner the diff first.
- Gate-off output stays byte-identical. The new layout appears only with the gate on.
- `findings.json` keeps every internal field and label. Internal words (ids like `theme:unicamp`, PROBABLE NEEDS REVIEW, oracle, recomputation, NOT_RUN, "gate", "null") never appear in reader-facing text. A scan test covers the reader-facing areas (whole terms, a short visible allow-list).
- The report stays a static, offline HTML page: no external resources, no `innerHTML`, no network, no server.
- Honest wording: never "your site is hacked" or "broken because of X"; "not confirmed" wherever it is true; never claim a class or function "used to exist"; a replacement for a missing class is shown only as "found in your installed <plugin>", never as a verified fix; where the tool cannot know something it says so.
- Never delete or weaken an existing test. Explicit staging, never `state/`, `reports/` or `projects/`. No push. One full run (runner, `scripts/run-full.sh <label>`) per part.

## 3. Order of work (build order)

1. Case-file layout, status line, the nine reader fixes (3.1)
2. Cause detail (3.2)
3. Choice step and FIX-PLAN.md, including the cracked-copy case (3.3)
4. Checkpoint list underneath (3.4, this is "step A")
5. Browser link and the feedback question (3.5): built LAST

Each part: plan (15 lines or fewer), multiple-choice questions for any wording, owner "go", builder, reviewer, runner, one commit, report back with the real output for the real-site case.

What the person experiences when it runs (differs from the build order): summary and link are printed, then "open in browser? [Y/n]", then the report is read, then the choice questions, then FIX-PLAN.md is written, then the improvement question.

## 4. The report page

```
TITLE      written by the tool, short, ends at a word boundary
           (a real site: "Home page shows a critical error"); never a cut of the person's text
STATUS     1 likely cause - 1 thing to check - 0 confirmed
           Looked at: your log, the live page, the code. Not looked at: a throwaway test copy.

WHAT YOU SEE        screenshot (if any) and the live check: "The live page answered HTTP 500"

CASE 1  LIKELY CAUSE (not confirmed)
  Where       theme Unicamp 2.2.0, heading.php, line 48 (code lines shown)
  Why         plain sentence: what the code asks for, what the installed plugin has,
              what happens next. Say plainly when it is NOT a hook or two-plugin conflict.
  How sure    found in your log N times, last seen <date>; file and line re-read; live page
              result. "Not confirmed by a second, independent test."
  What to do  ranked options, each with how to undo it (3.3)
CASE 2  SOMETHING ELSE TO CHECK (probably not the crash)
  e.g. the template override: which files, which versions, what can break (cart, checkout, layout)
CASE 3  (only when present) SIGNS THAT A COPY WAS MODIFIED (3.3)

WHAT WAS CHECKED   counts, e.g. 38 pass - 2 fail - 11 not checked - 3 also noticed (3.4); full list with --verbose
FOR A DEVELOPER    collapsed: stack trace, other files using the same symbol, replacement
                   candidates, timeline, technical evidence
```

The old "Findings", "Verdict" and "What is wrong" headings are replaced by STATUS and the cases. The counts have four states; the fourth is worded "Also noticed, probably not the crash": a check found something, but nothing ties it to this problem (5.4). The STATUS line of an empty case reads "0 likely cause - 0 confirmed. This does not mean the site is healthy." Case 3 is rendered only when data for it exists (Part 3). Components are listed inside the case they belong to (Elementor and Unicamp in Case 1, WooCommerce and Unicamp in Case 2).

### 4.1 Wording that must agree everywhere
One phrase for the top cause: "Likely cause (not confirmed)" in STATUS, the case heading and the Markdown report. "Confidence: low" becomes a plain sentence ("Not confirmed by a second, independent test"). Item names use plain words: "the theme Unicamp", "the plugin WooCommerce".

## 5. Part details and acceptance

### 5.1 Part 1: layout, status line, nine reader fixes
(a) no "Nothing passed the gate"; (b) the cause sentence is identical in the case and in any summary line; (c) no internal values ("sandbox reproduction: null"); (d) never tell an HTML reader to "run with --verbose": name the advisory or show it collapsed; (e) resolution options agree with "What to do"; (f) confidence explained in a sentence; (g) "Not tested" lists only items tied to the problem; (h) title cut at a word boundary or written by the tool; (i) a very large log mostly noise: say what was read and skipped ("read 50 MB of 261 MB; your error log is very large, consider cleaning or rotating it"). Add the reader-facing term scan test.
Acceptance: the real-site report shows one status line, Case 1 with Elementor, Case 2 with WooCommerce, no contradiction, symptom reproduced agrees with the live check.

### 5.2 Part 2: cause detail
Under "For a developer" and summarised in Case 1: the exact symbol, file:line, a capped and redacted excerpt of the lines around it read from the copy, the call chain from the log's stack trace (function and hook names) when the trace has them, how many other files of the same component use the same symbol, and replacement candidates found in the installed provider plugin (read-only search; "found in your installed Elementor", with `verified: false` never shown as a fix). A small data file of known removed-to-replacement APIs may be added in the style of `data/removed-wp-functions.json` (source URL and claim phrase per entry). The report must say "this is not two pieces of code fighting over a hook" when that is true. Not known to the tool, so the report says so: which provider version still has the class.
Unverified assumptions to CHECK in the repo before relying on them: whether the real-site log contains a stack trace, and whether the installed Elementor has a replacement class (a guess is `Global_Colors`; do not state it unless found).

### 5.3 Part 3: choice step, FIX-PLAN.md, cracked copies
After the report, in the terminal (never with `--yes` or without a terminal): plain multiple-choice questions, "not sure" always allowed.
- Can you update the theme and plugins? yes / no / not sure
- Do you have a licence for the theme? yes / no / not sure
- Is this a copy, and do you have a backup? yes / no
- Which plan do you want? Only options still possible.
Default ranking when nothing is answered: (1) update the theme, if a legitimate update exists; (2) test with a default theme to confirm the cause; (3) a temporary older version of the provider, ONLY with evidence from the copy (a stated compatible version in the theme's own headers or changelog), otherwise "which version still has this is not known"; (4) a developer patch written as text for review.
FIX-PLAN.md contains: the problem in two lines; the chosen option and why (or "ranked default"); before you start (UpdraftPlus backup, work on a copy or staging, note current versions); numbered, checkable steps; an undo for every step; "done when" (page loads and re-running wp-issue-diagnoser no longer lists this cause); do-not list (no editing third-party files, no cracked-version workarounds). Written for a developer, with a short plain summary on top, and usable as a brief for Claude Code to follow on a COPY after a backup.
Cracked or nulled copies, as a visible case even when it is not the crash: report only SIGNS read from the copy (license-check code removed or pointing to an unknown domain, "nulled" or "cracked" in names or headers, obfuscated blocks, files not matching WordPress.org checksums where those exist, calls to unexpected domains). Wording: "signs that this copy was modified; it cannot be verified against the vendor". Advice: replace it with a licensed copy from the vendor. The tool never patches such code to make it run and never helps bypass a licence.

### 5.4 Part 4: checkpoint list (step A)
`data/checkpoints.json` generated from, and tested against, `docs/COVERAGE.md`: each of the 53 rows gets id, group, how (code, log, probe, config), breaks_site (yes / no / depends), and the name of its checker. A test fails if the two disagree or a claimed checker has no passing test. Every checkpoint ends as PASS, FAIL, ALSO NOTICED or NOT CHECKED with a reason ("no log", "probe not run", "copy skipped PHP"): ran and found nothing is PASS with a plain note; ran and found something that the crash evidence does not tie to this problem is ALSO NOTICED ("Also noticed, probably not the crash", never counted as FAIL); did not run or source missing is NOT CHECKED, never PASS. The page shows counts; the full list only with `--verbose`. Map existing checks onto it; add no new detection in this part (later: missing wp_head/wp_footer check, DISABLE_WP_CRON). No change to validate.js.

### 5.5 Part 5: browser link and feedback (built last)
After the run the tool prints a short summary and a link (`file:///.../issue.html`). With a terminal and not `--yes`: "Open it in your browser now? [Y/n]". It opens only a file from its own report folder. After FIX-PLAN.md: "Anything we should improve? (type it, or Enter to skip)" and an optional 1 to 5 score, saved as `feedback.md` in the same issue folder. Feedback stays on this computer and is never sent; it is redacted like logs (people paste private details). Last line: "Plan saved at <path>. To have Claude Code carry it out on a copy, give it that file."

## 6. Where questions are asked
Terminal first (reuses the existing question engine, skippable, no terminal mode). Buttons inside the HTML page or a local web server are NOT part of this work: the report must stay offline.

## 7. Tests
Every part: positive, negative and clean-site cases, using the exact real-site log line; the reader-facing scan; gate-off byte-identical; nothing written into the site (fingerprint before and after); `validate.js` untouched (or its diff approved first).

## 8. What stays out of scope
New detection beyond the nine fixes and the cause detail; the sandbox; a "guided local test" command; `.htaccess` reading; a REST probe; applying fixes automatically.

## 9. Owner decisions already made
- Questions in the terminal first, browser buttons later; ask before opening the browser, print the link either way.
- Open the page with what the visitor sees; the template override is its own case marked "probably not the crash"; the status line replaces Findings and Verdict; code lines and the stack trace sit collapsed under "For a developer".
- Default fix ranking as in 5.3; a downgrade only with evidence from the copy.
- Cracked-copy signs are an always-visible case with the "cannot be verified" wording.
- The tool never applies a fix.
- Feedback: a 1 to 5 score plus free text, saved locally as feedback.md; a closing line pointing to FIX-PLAN.md for Claude Code.
- Build order: the feedback step (Part 5) comes after the checkpoint list (Part 4).
