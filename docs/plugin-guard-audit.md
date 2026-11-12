# Plugin Guard audit

Audit of `src/plugin-guard/` and its integration with `src/frontend/`. Written during the repair; the code and tests it cites are in the repository. (This file is the one exception to the git-ignored `reports/` folder because it holds no client data.)

## 1. Architecture found

| Part | What it does |
|---|---|
| `scripts/guard.js` | CLI: `init/set/scan/retest/decisions/bulk/fixfile/schedule/due/run-due/list`, always keyed by a *project name* (`projects/<name>/project.json`) |
| `guard.js` | Orchestrator: live URL probe (`lib/live.js`) -> component discovery (`lib/components.js`, `lib/php.js` regex scanner) -> `checks/*` -> findings -> history + `decisions.txt` |
| `lib/wpcli.js` | Read-only WP-CLI allow-list |
| `lib/report-pdf.js`, `lib/fixfile.js` | PDF/HTML report, `FIXES-FOR-CLAUDE.md` |
| `src/frontend/` | Separate Playwright QA agent (governor, pacing, WAF stop). Plugin Guard only borrowed its Chromium for the PDF |

What worked: the original self-test (`npm run guard:selftest`) passed in full before any change (it did, including PDF rendering), the WP-CLI allow-list, the pacing/stop-on-block behaviour of the live probe and of `src/frontend`.

## 2. Why it "behaved incorrectly": reproduced defects

Reproduced by scanning the two real local sites already configured (`site A`: 380 findings, `site B`: 2002 findings in the stored reports) and reading the cited code.

| # | Defect | Evidence | Root cause | Fix |
|---|---|---|---|---|
| D1 | **No notion of which code is the project's own.** Everything in `wp-content` was treated as fixable; `FIXES-FOR-CLAUDE.md` could tell Claude to edit Elementor, WooCommerce, vendor libraries. 85-95 % of findings were third-party noise (site A: 134 `code-no-abspath`, 97 `redeclare-class`, ...). | `reports/plugin-guard/site-a/findings.json` | No ownership model | `lib/ownership.js` (allowlist `customPaths`, built-in protected paths, traversal/symlink checks) + gate in `lib/fixfile.js` + Agent 3 recomputes ownership |
| D2 | **`hook-removed` false positives (50 of 380 on site A).** `remove_action('admin_notices', [$this,'admin_notices'])` in ACF was reported as ACF removing *Elementor's* callback | `advanced-custom-fields/includes/admin/admin-upgrade.php:180` vs `elementor/core/admin/admin-notices.php:848` | `callbackName()` kept only the last quoted word (the *method name*), so any two classes with a method of the same name "matched" | `callbackIdentity()` in `lib/php.js`: only function names and `Class::method` are comparable; `$this`, `self`, closures and variables are not. Regression tests in `selftest-agents.js` |
| D3 | `integrity-create-function` reported as likely malware inside a vendor library's **test fixture** (`php_codesniffer/.../Tests/DeprecatedFunctionsUnitTest.inc`); `integrity-heavy-hex` on phpseclib's crypto tables | site A report | Pattern scan ignored that vendor code and its test fixtures legitimately contain these | `checks/integrity.js`: skip create_function in vendor `tests/` and hex tables in vendor folders; real plugin code is still flagged (tested) |
| D4 | **False "pass": multisite check recorded as done / "not a multisite" when the database could not be read.** `wp core is-installed --network` fails on a dead DB and the `else` branch recorded success | `checks/database.js` | Failure of the probe was read as the answer "no" | Skipped with a reason when the user query failed. Found while testing the new `runtime` check |
| D5 | **Relative `--path` resolved against the wrong folder** when run through `npm --prefix` (npm changes the cwd) | `guard.js set x --path ./site` | `path.resolve` used `process.cwd()` | `lib/config.js userPath()` uses `INIT_CWD`. Limits below |
| D6 | Scan could only run against a *named project* stored in `projects/`; no way to scan the folder you are standing in, and an ad-hoc scan would write history/decision files | `scripts/guard.js` | | `scan({project})` ad-hoc mode: writes nothing into `projects/` |
| D7 | No link at all between browser tests and source analysis; no shared finding schema; no Agent 1/3 | | | Sections 4-5 |

### Defects introduced and caught by the new tests during this work (fixed)

- New SQL rule flagged `{$this->table}` interpolation (4 false positives on site A's own code) -> table-name variables are ignored.
- Agent 3 rejected a *true* finding on `site B` because the verifier for `shared-ajax-action` looked only for `wp_ajax_`, while the scanner also records `admin_post_*` handlers -> keyword widened, regression test added. Found by reading the 2 `REJECTED_FALSE_POSITIVE` results on real data instead of trusting them.
- Dashboard overflowed horizontally at 375 px when a component name was long (select width) -> fixed, covered by the browser test.
- `spawnSync` for the frontend run froze the parent process (the test fixture server lived in it) -> async `spawn`.

## 3. Result on the real sites (no allowlist configured = nothing is "custom")

| Site | Raw scanner findings | After grouping + validation | Fix tasks |
|---|---|---|---|
| site A | 380 | 42 (1 Critical: `.git` in web folder, confirmed on disk) | 0 with no allowlist; 0 with `site A` plugin + theme allowlisted after the SQL fix (the four earlier tasks were false positives) |
| site B | 2002 | 101 | 0 |

"Fewer" is not the goal in itself: 7 findings per site are re-verified on disk (CONFIRMED), the rest stay `PROBABLE_NEEDS_REVIEW`/`UNVERIFIED` and are still listed.

## 4. Implemented

- `lib/ownership.js`, `lib/config.js`, `lib/schema.js` (v1 finding schema), `lib/runs.js`, `lib/redact.js`
- `agents/frontend.js` (Agent 1, runs the existing `src/frontend` agent, converts `qa-report.json`), `agents/code.js` (Agent 2), `agents/validate.js` (Agent 3)
- `lib/report-md.js`, `lib/claude-tasks.js`, `lib/report-html.js`, `lib/workflow.js`
- CLI: `scan --root`, `qa-url`, `qa-code`, `qa-validate`, `doctor`, `config`, `show`
- Tests: `selftest-agents.js` (offline, 85 checks), `selftest-html.js` (Chromium, `file://`), `selftest-agent1.js` (real frontend run against a fixture site and a simulated WAF challenge)

## 5. Tools: what was selected and why

| Tool | Status here | Offline | Used? |
|---|---|---|---|
| `php -l` | installed (PHP 8.3) | yes | **yes**: syntax check of custom code, re-run by Agent 3 -> `REPRODUCIBLE` |
| Built-in WordPress pattern checks (`lib/wp-security.js`, `lib/php.js`) | built in | yes | **yes**: pattern matching only; never proves exploitability |
| WP-CLI (read-only allow-list) | installed | yes (needs the DB) | yes (existing) |
| PHPCS + WPCS, PHPStan (+wordpress stubs) | **not installed** | yes | **no**: detected and reported `NOT_RUN` with install hint. Need project-specific config; not run by Plugin Guard yet |
| Semgrep | not installed | only with local rule files (`--config auto` downloads rules) | no (`NOT_RUN`) |
| `composer audit`, `npm audit` | npm present, composer not | **no (network)** | no (`NOT_RUN`); would send package names to a registry |

Nothing was installed globally.

## 6. Not implemented / limits (honest list)

- PHPCS, PHPStan, Semgrep, `composer/npm audit` are **detected but not executed**.
- Login / registration / search typing and form *submission* are not tested: `src/frontend` is read-only by design. They are reported `NEEDS_AUTHORIZATION` / `NOT_RUN` / forms "NOT VERIFIED". The five form outcomes requested (cannot submit / validation / WAF / success / unverifiable) are therefore all reported as unverified.
- Agent 3 does not reload the website: browser findings are checked for usable evidence (stored screenshots) but not re-reproduced. It does re-run `php -l` and re-stat files.
- `FIXED_VERIFIED` is a defined status, but nothing sets it yet: the tool never applies fixes. Verification of a fix is the user running `qa-code` + `qa-validate` again; a finding that disappears is not automatically marked verified.
- Playwright traces are only kept for failed tests (the existing `retain-on-failure` setting); they are copied when present.
- Live-URL security probes (user enumeration, `xmlrpc`, `debug.log`) remain in the classic `scan <project>` command; the 3-agent flow does not call them.
- `npm --prefix <agent> run ...` from a different directory reports the agent's folder as the user's directory (npm behaviour), so `--root .` cannot work that way; use the direct `node .../guard.js scan --root .` form or an absolute `--root`.
- The dashboard was tested in Chromium via Playwright; not in Firefox/Safari, no screen-reader test. Contrast was designed, not measured.
- `npm run qa:frontend:e2e` (12 min) was not run; the other four frontend self-tests were.

## 7. Preserved

All original commands, the PDF/HTML report, `decisions.txt` flow, `FIXES-FOR-CLAUDE.md` (now with the allowlist gate), history/retest, exit codes 0-3 of the classic commands. `src/frontend/` is unchanged.
