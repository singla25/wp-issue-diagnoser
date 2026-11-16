# Architecture

One read-only review tool for WordPress sites: wp-issue-diagnoser. Plain Node.js (20.12 or newer, CommonJS). The package is the repository root. The tool does not change the site it looks at; the rules for what it may write are in [SAFETY.md](SAFETY.md).

```
repo
├── scripts/      the CLI (guard.js, plugin-guard.js), setup scripts, every selftest-*.js suite, fixtures
├── lib/          shared code: config, findings, reports (md, html, pdf), the wizard, site intake, WP-CLI allow-list, hints
├── checks/       the classic scan: one file per area (dependencies, conflicts, exposure, integrity, database, lifecycle, ...)
├── agents/       the three-agent workflow: code.js (Agent 2) and validate.js (Agent 3)
├── issue/        issue mode: evidence, code analysis, hypotheses, oracles, sandbox, validation, results, retest
├── probe/        the read-only, paced live probe (worker, safety, recorder, layout, sandbox actions)
├── data/         pinned data (sandbox images, checkpoints, knowledge files, OCR pin)
├── projects/     per-project settings of the classic scan (git-ignored except `.gitkeep`)
└── docs/         this file, GUIDE.md (the detailed technical guide), SAFETY.md, WORKFLOW.md (working model), HANDOFF.md (memory), COVERAGE.md (what is detected),
                  REPORT-SPEC.md and TEST-COPY-SPEC.md (the approved report and test-copy designs), archive/ (old step logs)
```

`guard.js` at the root is a small entry shim for `scripts/guard.js`; the `wp-issue-diagnoser` command is `scripts/plugin-guard.js` (bin entry `wp-issue-diagnoser`).

## 1. Classic scan and the three-agent workflow

- `scripts/guard.js` is the CLI. Per-project state: `projects/<name>/project.json` (settings), `decisions.txt` (fix, ignore or accept per finding), `history/` (snapshots, git-ignored).
- `checks/*` each analyse one area (dependencies, conflicts, exposure, integrity, database, lifecycle, vulnerabilities, ...) and emit findings through `lib/finding.js`. `lib/wpcli.js` is an **allow-list** wrapper: listing commands and `SELECT` only, always `--skip-plugins --skip-themes`.
- Flow: `scan` gives a PDF, findings and `decisions.txt`; `fixfile` (refuses until every ignore or accept has a reason) writes `FIXES-FOR-CLAUDE.md`; `retest` shows Fixed, Still open or New.
- Three agents (`agents/`, `lib/workflow.js`): **Agent 1** (browser tests) is not part of this tool; there is only the plug-in hook `workflow.registerAgent1`, and without it a scan records Agent 1 as NOT_RUN ("this build has no browser-test stage"). **Agent 2** (`agents/code.js`) wraps `scan()` with an ad-hoc project plus `php -l` and `lib/wp-security.js`. **Agent 3** (`agents/validate.js`) re-verifies, correlates, and writes `findings.json`, from which the Markdown, the task file and `report.html` are all generated. Only Agent 3 assigns CONFIRMED / REPRODUCIBLE / REJECTED.
- **Ownership gate** (`lib/ownership.js`): what may become a fix task is decided by the `customPaths` allowlist; vendor, core, symbolic links and path traversal never. It is recomputed by every consumer, never trusted from another stage.

## 2. Issue mode (`issue/`, `lib/issue-*.js`)

Investigates **one** reported problem. Deterministic and offline: no model, and no network at run time except the read-only live probe of the address the reporter gives (step G). Every phase writes plain JSON into `issues/<id>/work/`; `result/` is generated from those files only.

```
issue new ──► issue.json (+ screenshots, checked, metadata stripped)
issue investigate
  B  evidence.js      logs.js, ocr.js/imgvariants.js, describe.js, clues.js        → work/evidence.json
  C  custom.js        phpast.js (php-parser), ownership gate, corehandles.js        → work/custom-code.json
  D  index.js         component + feature index (MiniSearch BM25)                    → work/components.json, feature-index.json
  E  graph.js, collide.js, kb.js                                                     → work/graph.json, slice.json, collisions.json, kb-hits.json
  F  hypotheses.js    transparent scoring table, up to 5 hypotheses with an oracle → work/hypotheses.json
  G  probe.js (+probe/worker.js, probe/safety.js, oracle.js, imgdiff.js)   read-only, paced live probe   → work/probe.json
     sandbox.js / sandbox-phase.js / bisect.js            Docker sandbox + delta debugging  → work/sandbox.json, bisect.json, bisect.log
  H  validate.js      the separate verifier (CONFIRMED / REPRODUCIBLE / REJECTED)   → work/validation.json
     resolve.js, patchgen.js, shim.js, verify-fixes.js    options; patches/shims tried in the sandbox
     result.js, lib/issue-html.js, index-page.js          → result/findings.json, issue.html, ISSUE-REPORT.md, tasks.md, patches/ ; issues/index.html
     checkpoints.js      PASS / FAIL / NOT CHECKED per checkpoint in data/checkpoints.json (gate report)
     gate.js, case-file.js, cause-detail.js, fidelity.js, fix-plan.js   the gate report (case file, cause detail, how close the test copy is, FIX-PLAN.md)
issue retest        retest.js: Fixed / Still failing / New problem / Could not test; the only source of FIXED_VERIFIED
issue cleanup       cleanup.js: lists, asks, removes old issue folders and leftover sandboxes
```

Design rules that hold across the issue-mode code:

- **One owner per verdict.** The hypothesis builder emits only UNVERIFIED / PROBABLE_NEEDS_REVIEW. `validate.js` alone assigns CONFIRMED / REPRODUCIBLE / REJECTED_FALSE_POSITIVE. `retest.js` alone assigns FIXED_VERIFIED (`canVerify`).
- **The verifier is wider than the scanner.** `validate.js` `KEYWORD` must accept every spelling `phpast.js` records; `selftest-issue-validate.js` derives its cases from `phpast.js` itself.
- **Reproducibility.** Every directory listing goes through `lib/sorted-dir.js`; plugin sets are sorted; no randomness; the bisection caches by plugin-set hash and has load and time caps. Two runs on the same input give identical `findings.json`, `bisect.json` and `bisect.log` apart from timestamps and ids.
- **Missing data is "Not run", never "clean".** Every step records PASSED / FAILED / BLOCKED / SKIPPED / NOT_RUN with a reason.
- **Text from the site is data.** It is escaped in every output; `issue.html` is one offline file (a Content-Security-Policy forbids loads, text goes in with `textContent`).
- **Oracles are data.** A reporter's pattern is plain text unless written `re:` and goes through `lib/safe-pattern.js`; selectors are only passed to `querySelector`.

### The `wp-issue-diagnoser` command (`scripts/plugin-guard.js`)

```
scripts/plugin-guard.js   flags (the option table of scripts/guard.js) or questions
  lib/wizard.js           the plain questions; lib/site-finder.js + lib/folder-browser.js (the numbered folder list), lib/log-finder.js
                          (the log inside the site), lib/env-guess.js (local / staging / live from a read-only DNS lookup)
  lib/site-intake.js      the redacted COPY of the site into issues/<id>/site-copy/ (chooseOutputRoot refuses a reports folder inside the site)
  issue pipeline          as above, on the copy, with the gate report; a test copy in Docker only from a database file (or --sandbox), never for live
```

### The sandbox (`issue/sandbox*.js`)

`sandbox-policy.js` builds the Compose project and `validateSpec()` rejects any specification that weakens a safeguard before anything starts. `sandbox-copy.js` copies the site without following symbolic links (skipping `.git`, `.env*`, backups, `wp-config.php`). `sandbox-config.js` generates `wp-config.php`, the must-use guard plugin, the anonymisation SQL and the payment-gateway check. `sandbox.js` owns the lifecycle (preflight, sweep, create, up, import, anonymise, ..., teardown that always runs). `sandbox-many.js` builds one sandbox for several plugin sets. `sandbox-wpcli.js` is the only way to run WP-CLI in a sandbox: a closed command table, argument arrays, no shell, a rebuilt environment, and the real path of the sandbox re-resolved on every call. `bisect.js` is pure (it takes a `test` function) and is tested without Docker.

### Data files (`data/`)

`sandbox-images.json` (images by digest) · `checkpoints.json` (generated from the table in `docs/COVERAGE.md` by `scripts/gen-checkpoints.js`) · `removed-wp-functions.json` (pinned list for the removed-function check) · `feature-taxonomy.json`, `known-conflicts.json`, `known-settings.json` (hand-written knowledge with official sources; `knowledge-verification.json` holds what `scripts/verify-knowledge.js` found; `KNOWLEDGE-REVIEW.md` is generated for a person to read) · `ocr-pin.json` (SHA-256 of the OCR language file, which itself is never committed; `.gitignore` does not list `data/ocr/` yet) · `advisories.json` (ships empty on purpose).

## 3. Report folders

Classic reports go to `plugin-guard-reports/` next to the package code (git-ignored), never the current folder; `PLUGIN_GUARD_REPORTS` / `PLUGIN_GUARD_RUNS` still win (`lib/project.js`, `lib/runs.js`; `lib/repo-layout.js` decides the default). Issue mode has its own folder (`issues/`, `--out`, `PLUGIN_GUARD_ISSUES`).

## 4. Tests

Standalone scripts, no framework: `scripts/selftest*.js`, each run as `npm run selftest:docs`, `npm run selftest:hygiene` and so on (the names are in `package.json`). Layers: pure logic (offline), then a fake `docker` (`scripts/fixtures/issue/fake-docker.js`: what is *sent* to Docker, teardown, sweep), then fixture sites on 127.0.0.1 (probe), then real containers (`*-docker.js`, they skip loudly when Docker is unusable), then the browser (`selftest-html*.js`: offline, hostile text, keyboard, 375 px, colour contrast). Fixture trees are hashed before and after to prove the original is never written. `selftest-docs.js` checks `README.md` and `docs/*.md` against the package itself (the npm scripts, node paths, links and flags they name exist); `selftest-hygiene.js` scans every file for secrets, real names and paths. `npm test` runs every suite and `scripts/run-full.sh` is the full run (see [TESTING.md](TESTING.md)); `isolated-copy` is left out of the chain until C7 (see `docs/HANDOFF.md`).
