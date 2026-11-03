# Plugin Guard

Checks how the plugins, themes and settings of a WordPress project depend on each other, conflict with each other, and what they leave open to attackers. **Read-only: it never changes a site.** It produces a PDF report for the admin and, after the admin decides, a Markdown task file for a Claude agent to do the fixing.

```
URL  ─┐                                     ┌─ decisions.txt  (admin marks each item: fix / ignore / accept)
      ├─►  scan  ─►  PDF report + findings ─┤
local ─┘                                     └─►  fixfile  ─►  FIXES-FOR-CLAUDE.md  ─►  Claude fixes  ─►  retest
copy
```

## Quick start

```bash
npm run guard:selftest                                                  # offline check, no real site touched
npm run guard:init -- acme --url https://acme.example/                  # creates projects/acme/project.json
npm run guard:scan -- acme                                              # URL-only scan: what a visitor can see
npm run guard:set -- acme --path ~/sites/acme                           # add the local copy later (other settings are kept)
npm run guard:scan -- acme                                              # full scan
# open reports/plugin-guard/acme/PLUGIN-GUARD-REPORT.pdf, then edit src/plugin-guard/projects/acme/decisions.txt
npm run guard:fixfile -- acme                                           # → reports/plugin-guard/acme/FIXES-FOR-CLAUDE.md
npm run guard:retest -- acme                                            # after Claude fixed things: Fixed / Still open / New
```

The PDF needs Chromium: run `npm run setup:guard` once (Plugin Guard's own Playwright). Without it you still get the HTML copy.

## The two modes

| | URL only | Local copy (`--path`, + optional `--url`) |
|---|---|---|
| Sees | what a visitor sees | the files, and the database through WP-CLI |
| Exposed files (`debug.log`, `.env`, `.git`, backups), user listing, `xmlrpc.php`, security headers, HTTPS/certificate, plugins and versions seen from outside | yes | yes (with `--url`) |
| Plugin / theme / mu-plugin code, conflicts, dependencies | no | yes |
| `wp-config.php`, permissions, stray files, drop-ins | no | yes |
| Core / plugin files vs the official wordpress.org copy, backdoor patterns, PHP in uploads | no | yes |
| Users, options, cron, injected code in posts, multisite | no | yes (needs the database imported into the local copy) |
| Abandoned / closed / outdated plugins, vulnerabilities | yes, for the plugins it can see | yes |

URL-only mode finishes what it can and lists every check it **could not** run, with the reason. It stops with an error (exit code 3) only if the site blocks it, cannot be reached, or is not WordPress; the error says to set the project up locally and run the scan with `--path`. It never tries to get around a firewall: the first 429 or challenge page ends the live probe.

## What it checks

- **Dependencies:** `Requires Plugins`, WordPress/PHP versions, code that calls another plugin without declaring it, child theme without parent, dependency table.
- **Conflicts** between plugins, themes and mu-plugins: same function/class declared twice (a PHP fatal), same-priority security hooks (`authenticate`, `rest_authentication_errors`…), contradicting filters, one plugin removing another's hook, shared constants/tables/shortcodes/AJAX actions, two plugins doing the same job (two firewalls, two 2FA…). Hook collisions come with a priority fix.
- **Unsafe code:** public AJAX/REST without nonce or permission check, unprepared SQL with request input, request input reaching `eval`/`exec`/`include`/`unserialize`, uploads without type check, no `ABSPATH` guard, **inactive plugins and unused themes left installed**.
- **Drop-ins and mu-plugins:** unknown `db.php` / `advanced-cache.php` / `object-cache.php`, orphans, mu-plugins with no header.
- **Core and server settings:** `WP_DEBUG`, file editor, salts, root DB user, default prefix, `WP_ALLOW_REPAIR`, auto-updates off, world-readable config, world-writable folders, backups/dumps/phpinfo/`.env`/`.git` in the web folder, PHP end-of-life.
- **Integrity:** PHP in `uploads`, PHP hidden behind an image extension, backdoor/web-shell patterns, core and plugin files compared with wordpress.org checksums, extra PHP files in core folders, pirated ("nulled") plugin markers.
- **Database and users (WP-CLI):** `admin` account, administrators outside your e-mail domains, **a new administrator since the last scan**, open registration with a powerful default role, cron jobs with no code behind them, injected code in posts/options, multisite super admins.
- **Lifecycle:** abandoned and closed plugins, outdated plugins/themes/core, updates waiting, auto-updates off.
- **Vulnerabilities:** versions matched against advisory files, or WPScan when allowed.

## Per-project settings (`projects/<name>/project.json`)

```json
{
  "url": "https://acme.example/",
  "path": "/home/me/sites/acme",
  "schedule": "weekly",
  "outsideLookups": { "wordpressOrg": true, "vulnerabilityDb": false },
  "advisories": ["/home/me/advisories.json"],
  "precedence": ["ninjafirewall", "wordfence"],
  "prefer": { "firewall": "ninjafirewall" },
  "expectedAdminDomains": ["acme.example"],
  "ignoreRules": [],
  "abandonedYears": 2,
  "phpVersion": "8.1.27",
  "dbExportedAt": "2026-10-20"
}
```

- **`schedule`** is the admin's approval: `none` (default) / `daily` / `weekly` / `monthly`. `guard:due` lists projects whose scan is due, `guard:run-due` scans them. **Nothing starts by itself**; to automate, put `guard:run-due` in your own cron.
- **`outsideLookups`** is off by default. `wordpressOrg` lets the tool send plugin/theme names and versions (and the WordPress version) to api.wordpress.org / downloads.wordpress.org for abandoned/closed/outdated checks and official checksums. `vulnerabilityDb` sends plugin names to wpscan.com and needs `WPSCAN_API_TOKEN` in the environment (never stored in project.json). The report lists every host contacted and how many requests. When a lookup is not allowed, the check shows as **Not run** with that reason.
- **`phpVersion`:** the PHP on this computer is not your server's. Set the server's version, or let a live `X-Powered-By` header supply it.
- **`precedence` / `prefer`:** how conflicts are resolved (see below).

## Decisions and the fix file

`scan` writes `projects/<name>/decisions.txt`, one block per finding:

```
## PG-3316529103 | P1 | ninjafirewall and wordfence both hook "authenticate" at priority 20
decision: fix          <- fix | ignore | accept | pending
reason:                <- required for ignore and accept
```

`fix` items go into `FIXES-FOR-CLAUDE.md` (with exact paths, the fix, commands, the code to add, and a "done when"). `ignore` and `accept` stay out, are listed under "do not change", and are remembered on later scans, even if the finding disappears and comes back. `guard:fixfile` refuses to run until every `ignore`/`accept` has a reason.

**Deciding a whole rule at once.** `guard:bulk -- <project>` lists the rules in the last scan with counts. Then, for example:

```bash
npm run guard:bulk -- acme --rule code-no-abspath,redeclare-class --as ignore --reason "Vendor libraries, not reachable directly"
```

Only `pending` findings change; earlier decisions stay unless you add `--overwrite`. `ignore`/`accept` need `--reason`.

## How conflicts get resolved

- **By priority:** colliding hooks get distinct priorities in the order of `precedence`, as a drop-in `mu-plugin` included in the fix file (`pg_reprioritize()` finds the callbacks by the file they live in, so closures and methods work). Contradicting `__return_true/false` filters are pinned to the hardened value.
- **By dependency:** missing or inactive requirements come with the `wp plugin install/activate` command.
- **Redeclared functions, duplicate jobs:** load order cannot fix these; the report names what to deactivate (`prefer` chooses).
- **Server rules:** `.htaccess` and nginx snippets close what the scan confirmed.

## History, retest, what is new

Every scan stores a snapshot (`projects/<name>/history/`, git-ignored). The next scan says what is **new**, what is **fixed**, and when a problem **appeared after a plugin was updated or installed**. `retest` compares with the last full scan and produces `RETEST-REPORT.pdf` (Fixed / Still open / New).

## Exit codes

`0` ok · `1` findings at or above `--fail-on` (open ones only) · `2` bad usage or invalid settings · `3` the site could not be read (blocked, unreachable, not WordPress): set up a local copy.

## Three-agent QA workflow (browser + source + validation)

Reports go to `reports/runs/<run-id>/` (git-ignored). The older `scan <project>` flow above is unchanged.

```
Agent 1  user / frontend    browser tests of a URL (provided by src/combined, not by this folder)  ──►  01-user-test-report.md, evidence/frontend/
Agent 2  code / security    inspects a local WordPress root (php -l, WP patterns, conflicts) ─►  02-code-test-report.md
Agent 3  validation         re-checks both, correlates, decides statuses, applies the ownership gate
                            ──►  03-final-validation-report.md · findings.json · claude-tasks.md · report.html
```

### Workflow A: URL first

```bash
node src/combined/scripts/combined.js qa-url --url https://staging.example.com/ --env staging     # Agent 1 (mode: --mode smoke|responsive|visual|seo|prelaunch)
node src/plugin-guard/scripts/guard.js qa-validate --run latest                                    # PARTIAL report (no source code yet), says so
# when you have the code:
node src/plugin-guard/scripts/guard.js qa-code --root /path/to/wordpress --run <run-id>            # Agent 2 into the same run
node src/plugin-guard/scripts/guard.js qa-validate --run <run-id>                                  # full report
```

`--env` is required (`staging`, `local` or `live`). A `live` site additionally needs `--authorized` (the owner's permission); without it nothing is sent and the result is recorded as `NEEDS_AUTHORIZATION`. Results older than `maxAgeHours` (24) or for a different site are refused unless `--allow-stale`.

### Workflow B: local first

Open a terminal in the WordPress root (the folder with `wp-content`):

```bash
node /path/to/wordpress-dev-agent/src/plugin-guard/scripts/guard.js scan --root . [--url https://staging.example.com/ --env staging]
# or, from this repository:  npm run guard:scan -- --root /absolute/path/to/wordpress
```

It checks prerequisites, loads the allowlist, runs Agent 2, runs Agent 1 only if a URL is given (a source checkout is not a running website), then Agent 3. Without a URL the report is labelled PARTIAL.

### Custom-code allowlist (what Claude may be told to change)

Create `plugin-guard.config.json` in the WordPress root (or pass `--config file`); see `plugin-guard.config.example.json`:

```json
{ "customPaths": ["wp-content/plugins/my-plugin", "wp-content/themes/my-theme"], "protectedPaths": [] }
```

- Only files under `customPaths` can become tasks in `claude-tasks.md` and `FIXES-FOR-CLAUDE.md`. With no allowlist there are **no** code tasks.
- Never allowed, even inside a custom folder: `vendor/`, `node_modules/`, minified files, WordPress core, anything in `protectedPaths`. Too-broad entries (`wp-content/plugins`), `..`, absolute paths outside the root and symlinks are refused. A plugin's name or location never implies ownership.
- Inspection is not limited: core and third-party code are still analysed (they explain behaviour), but their findings are only listed, grouped, under "Not tasks".
- Credentials are never read from files or flags. `PG_TEST_USER` / `PG_TEST_PASSWORD` may be set in the environment; the frontend agent is read-only and does not log in, so they are not used yet.

### Statuses, severities, schema

Statuses: `CONFIRMED`, `REPRODUCIBLE`, `PROBABLE_NEEDS_REVIEW`, `UNVERIFIED`, `BLOCKED`, `NEEDS_AUTHORIZATION`, `REJECTED_FALSE_POSITIVE`, `FIXED_VERIFIED` (defined, nothing sets it yet). Severities: `CRITICAL`..`INFO`; CRITICAL needs a confirmed/reproduced finding. A pattern in source is `PROBABLE_NEEDS_REVIEW` at best. Schema: `lib/schema.js` (version 1.0); `findings.json` is the single source for the Markdown, tasks and HTML.

### Other commands, exit codes

`doctor [--root .]` prerequisites · `config --root .` validate settings · `show [--run id]` list a run's files and the open command (reports are never opened automatically).

Exit codes of `qa-*` and `scan --root`: `0` done, nothing at/above `--fail-on` (default HIGH; counts neither BLOCKED, rejected nor verified-fixed) · `1` findings at/above it · `2` bad usage or configuration · `3` blocked (authorization missing, site protection, nothing could run).

### What needs what

| | Offline | Network / live target | Runtime WordPress | Credentials |
|---|---|---|---|---|
| Ownership gate, config validation, report generation, HTML | yes | | | |
| `php -l`, WordPress pattern checks, conflicts, dependencies, integrity patterns | yes | | | |
| Database / user checks | yes | | WP-CLI + imported DB | |
| wordpress.org checksums / lifecycle, vulnerability DB | | yes (opt-in per project) | | `WPSCAN_API_TOKEN` for WPScan |
| Agent 1 browser tests | | live target (staging preferred) | | none used |
| PHPCS / PHPStan / Semgrep / composer+npm audit | | | | **not run yet** (detected by `doctor`) |

### Tests

```bash
npm run guard:selftest          # original offline suite (incl. PDF)
npm run guard:selftest:agents   # ownership, config, regressions, Agents 2-3, reports, workflows, exit codes (offline)
npm run guard:selftest:html     # report.html in Chromium from file://: search, filters, XSS, offline, mobile
npm run guard:selftest:agent1   # Agent 1 through the real frontend agent against a fixture site on 127.0.0.1 (~30 s)
npm run guard:test              # all four
```

The audit of the original module is in [`reports/plugin-guard-audit.md`](../../reports/plugin-guard-audit.md).

## One command: `guard:auto`

```bash
npm run guard:auto -- --url https://staging.example/ --root /path/to/wordpress --env staging
#   --env local|staging|live   (required: the tool never guesses)       --authorized   (required for live, as for qa-url)
#   --max-issues 5             cap on auto-issues                        --sandbox-max-issues 3   how many get the sandbox bisection
#   --no-sandbox               static-only: no Docker at all             --db-dump f.sql          import a dump into the sandbox (anonymised by default)
#   --fail-on HIGH             as qa-validate
```

No question is asked. It composes the pieces described elsewhere in this README and does not rebuild any of them:

1. **Preflight.** The doctor checks run. If the sandbox is wanted (`--env local|staging`, not `--no-sandbox`) and the Docker daemon is not running, it tries **`systemctl --user start docker.service`** once (never `sudo`, never the system service, only if that user service exists) and waits up to 30 s. Otherwise it continues in **static-only mode** and says why.
2. **Agent 1**: the frontend QA in `visual` mode on `--url`, with the existing page caps, request governor, cooldown and authorization rules. **3. Agent 2**: the code and conflict scan of `--root`, with the custom-code allowlist from `plugin-guard.config.json`.
4. **Auto-issues.** Each distinct, reproducible failure Agent 1 observed becomes an issue with one *generic* oracle: a console/page error (its text, digits as `\d+`), a failed asset (its path), an HTTP 5xx page, or horizontal overflow (at the width it was seen). Duplicates are grouped by a fingerprint of (oracle, value), ranked by severity then class then how often, capped (`--max-issues`, default 5). They are marked `auto_generated`, have an empty description, and a title made only of the finding's own text. Third-party failures, protection/rate-limit answers and every other kind of finding (typography, SEO ...) are not turned into issues; the report lists them with the reason.
5. **One sandbox** (never for `--env live`): a single throwaway copy of `--root`, every existing safeguard unchanged. A plugin set is applied once and the *union* of all issues' pages is loaded once; the observation is cached by plugin-set hash and each issue's own oracle is evaluated on it, so issue 2 reuses the page loads of issue 1's bisection. The bisection runs once per issue (fixed order, fixed per-issue caps, so `bisect.json` is reproducible).
6. **Validation.** Agent 3 for the run; Phase H (`issue/validate.js`) for each auto-issue. Only validators assign statuses. Patches and shims are written but labelled "not verified in the sandbox" (verify one with `issue investigate <id> --sandbox`). Nothing is `FIXED_VERIFIED` by this command; only `issue retest` can do that.
7. **One report** in `reports/runs/<run-id>/`: `report.html` (offline; summary, frontend findings, code and conflict findings, auto-issues with causes and fixes, "not a plugin conflict" cases, what did not run and why), `report.pdf` (printed from it), `findings.json` (with an `auto` block), `auto.json`, `03-final-validation-report.md`, `claude-tasks.md`, and one full `issues/<id>/result/` per auto-issue.

**Safety.** Read-only on the original: the tree under `--root` is fingerprinted (path, size, modification time; logs and cache folders excluded) before and after and the report says whether it changed. The sandbox is built only from the local copy; the site at `--url` receives only what Agent 1 sends (GET page loads through the governor); the auto-issue analysis makes **no** further request to it. **Exit codes** as `qa-*`: `0` done, nothing at/above `--fail-on` · `1` findings at/above it · `2` bad usage or configuration · `3` a prerequisite was blocked (Agent 1 did not run, authorization missing, the original changed during the run).

**Limits.** Auto-issues only exist for what the frontend agent reports; its `visual` mode reports console errors and overflow, and failed assets and 5xx pages only where the frontend flags them (in one fixture its visual mode did not flag a 404 script). With no sandbox (live, `--no-sandbox`, no Docker) no issue can be "reproduced" or bisected. Only the first `--sandbox-max-issues` issues get the sandbox. A symptom that is present with every plugin off is reported as **NOT A PLUGIN CONFLICT**, not bisected into a plugin.

## Issue mode: investigate ONE reported problem

Give it a problem a person reported ("the cart button does nothing since last week", with screenshots) and it works out, **deterministically and offline** (no AI model, no network unless you run the setup commands), which component is the likely cause, how sure it is, and what to change. It never edits your site.

```bash
npm run setup:guard                  # once: npm ci in src/plugin-guard (issue mode needs it; the classic scan does not)
npm run guard:setup-ocr              # once, optional: the OCR language file for screenshots (SHA-256 pinned; the only download besides the next one)
npm run guard:setup-sandbox          # once, optional: pulls the three Docker images BY DIGEST (needs Docker, ideally rootless)
npm run guard:demo                   # the worked example on a fixture, offline, a few seconds   (--sandbox: with Docker, several minutes; --keep: keep the files)

node src/plugin-guard/scripts/guard.js issue new                      # title, description, pages, symptom, oracle, screenshots (asks one question at a time; every answer is also a flag)
node src/plugin-guard/scripts/guard.js issue investigate <id> --root <wp-copy> [--config <file with customPaths>] [--url ...] [--sandbox [--db-dump f.sql]]
node src/plugin-guard/scripts/guard.js issue retest <id> --root <fixed-copy> --sandbox
node src/plugin-guard/scripts/guard.js issue show|list|open|index|cleanup [id]
```

### What an investigation does

1. **Evidence**: reads `debug.log`, OCR text of the screenshots, the description; extracts clues (function names, file paths, error messages). Text from any of them is data: shown escaped, never executed.
2. **Custom code first**: parses the theme and the plugins you declared as yours (`customPaths`) with a real PHP parser (hooks, enqueues, declarations, `remove_action` calls ...).
3. **Component index, graph, collisions, knowledge base**: who provides which feature, how components relate, duplicate declarations, hooks removed at the wrong priority, scripts that depend on a handle nobody registers, known interaction patterns.
4. **Hypotheses** (at most five), ranked with a printed scoring table, each with the test that would prove or disprove it (the *oracle*).
5. **Live probe** (read-only, governed, stops at the first 429 or WAF challenge) and, with `--sandbox`, a **throwaway copy of the site in Docker** where the oracle is run again and the **bisection** (delta debugging over the active plugins, in a fixed order, cached, capped) finds the smallest set of plugins that causes the symptom.
6. **Validation** (a separate module, `issue/validate.js`): re-opens every cited file, re-runs `php -l`, recomputes ownership, `bisect.json` and the oracle. Only it assigns `CONFIRMED`, `REPRODUCIBLE`, `REJECTED_FALSE_POSITIVE`.
7. **Resolution options**, each labelled by who may do it: *You can do this* (a setting, a shim), *Send to Claude Code* (a patch of custom code, written to `tasks.md` for a separate session), *Needs a human*. With `--sandbox` each patch and shim is applied to the sandbox copy and marked **VERIFIED IN SANDBOX** only if the symptom is gone on the same page and screen size.
8. **`issue retest`**: after a fix is applied to a **copy**, runs the oracle again. Only a retest can produce `FIXED_VERIFIED`.

Output of one issue (`issues/<id>/`, outside the web root, owner-only, git-ignored): `result/findings.json` (the single source of truth), `result/issue.html` (one offline file: verdict, report as written, components, graph, timeline, bisect log, options with diffs, retest history), `ISSUE-REPORT.md`, `tasks.md`, `patches/`. `issues/index.html` lists all issues.

### Statuses, and who may set them

| Status | Meaning | Set by |
|---|---|---|
| `UNVERIFIED`, `PROBABLE_NEEDS_REVIEW` | a hypothesis nobody has re-checked, or one with some support | the producer |
| `CONFIRMED` | at least two independent deterministic sources agree *after* the code was re-read | validation only |
| `REPRODUCIBLE` | the sandbox reproduced the symptom and the bisection found a minimal set | validation only |
| `REJECTED_FALSE_POSITIVE` | the cited construct is not in the cited file | validation only |
| `FIXED_VERIFIED` | the original run reproduced the symptom in the sandbox, and a **sandbox** retest with at least the same active plugins passed on the same page and screen size | `issue retest` only |

### Sandbox

A throwaway copy in three Docker containers (WordPress, WP-CLI, MariaDB), images pinned by digest, not privileged, no `docker.sock`, `cap_drop ALL`, memory/CPU/process limits, ports on `127.0.0.1` only, external HTTP and mail blocked, payment gateways in live mode refused (`--neutralise-payments` switches them off in the copy), the database **anonymised by default** (`--keep-real-data` is explicit and warns), `wp-config.php` regenerated with new salts, always torn down (also on Ctrl-C or a crash; leftovers are swept at start). The WordPress container **can still make raw outbound connections** to an IP address: run sandboxes only for sites you own and code you trust. Details in [`docs/SAFETY.md`](../../docs/SAFETY.md).

### Clean-up

`issue cleanup` lists leftover sandboxes and issue folders older than `--older-than-days` (default 30), **asks before deleting** (or `--yes`; with no terminal and no `--yes` it only lists), refuses anything that is not a plain issue/sandbox folder directly inside the issues/sandboxes folder (symbolic links, other names, `..`), and never touches Docker resources that do not carry the Plugin Guard labels.

### Worked example

`npm run guard:demo` builds a tiny fake site where Plugin A (third party) and Plugin B (yours) both declare `my_helper()`, files the report "white screen after activating Plugin B", investigates it and prints what it found:

```
verdict:  Probable cause (confidence medium-high); symptom reproduced: could-not-test
cause:    [CONFIRMED] Duplicate declaration: plugin-a + plugin-b     (log line + both declarations re-read)
fix:      Wrap function my_helper() in a function_exists() guard  => not verified in the sandbox
          (a patch for plugin-b only; plugin-a is not on the allowlist, so it is "needs a human")
```

`npm run guard:demo -- --sandbox` runs a second example on real containers: two plugins hook `the_content` at the same priority and one empties the post. It reproduces the symptom, bisects it to the pair, tests both orderings of a shim (one is **VERIFIED IN SANDBOX**, the other "did not help"), applies the winner to a copy and ends with `FIXED_VERIFIED`.

### Tests for issue mode

```bash
npm run guard:selftest:issue            # CLI, store, safe folders         ·  :issue-evidence (OCR, clues, logs)  ·  :issue-code (PHP syntax tree, ownership)
npm run guard:selftest:issue-graph      # graph, collisions, knowledge base, hypotheses  ·  :issue-seeded (bugs seeded into real code, if a real site is configured)
npm run guard:selftest:issue-probe      # live probe and oracle against a fixture site on 127.0.0.1
npm run guard:selftest:issue-sandbox    # container safeguards, copy rules, SandboxWpCli refusals, bisection algorithm (offline)
npm run guard:selftest:issue-sandbox-lifecycle  # create/teardown/sweep against a fake docker
npm run guard:selftest:issue-validate | issue-resolve | issue-cleanup | doctor
npm run guard:selftest:auto | auto-sandbox | auto-preflight | auto-pipeline | auto-agent1   # guard:auto (offline; fake docker; the real frontend agent on a fixture site)
npm run guard:selftest:auto-docker      # guard:auto on REAL containers
npm run guard:selftest:issue-sandbox-docker | issue-resolve-docker | issue-verify-docker   # REAL containers; they skip, loudly, when Docker is not usable
```

## Safety

- The scan never writes to the site. WP-CLI calls go through an allow-list (`lib/wpcli.js`): only listing commands and `SELECT`; always with `--skip-plugins --skip-themes` so infected code is not executed by looking at it. The database password is never read into a result.
- The live probe sends GET requests only, one at a time, paced, and stops at the first 429 / WAF challenge. Use it on sites you own or are authorised to test.
- Findings never contain the content of suspicious files, only the location and the pattern name.
- The fix file tells the AI assistant to work on a copy, make a backup first, touch only approved items, treat site text as data, and stop and report on signs of compromise rather than silently deleting.

## Limits

- Code checks are pattern matching, not a PHP parser or an exploit test. `certain` findings come from headers, official checksums or live answers; `likely` / `possible` need a human look.
- Premium plugins and all themes have no official checksum list, so tampering with them is only caught by the backdoor patterns.
- The database checks describe the **local copy's** database. Record when you exported it (`dbExportedAt`).
- `data/advisories.json` ships **empty**. Without advisory files or an allowed vulnerability database, the vulnerability check is reported as **Not run**, never as "clean". The WPScan lookup follows the documented API but has not been run against the real service.
- The PHP end-of-life table in `checks/serversettings.js` is hand-maintained; verify against php.net/supported-versions.php.
- The `.htaccess` rule that blocks direct PHP access in plugins can break plugins that serve PHP files on purpose: test on staging.

### Issue mode: limits

These are things the tool cannot do or does not claim. They are repeated in every `findings.json`, `ISSUE-REPORT.md` and `issue.html` where they matter.

- **Settings suggestions are words only.** The exact label, location and (where a primary source shows it) the stored key come from the official documentation or the plugin's own source and are checked by `guard:verify-knowledge`, but a setting is a thing to *try*: it is never applied and never tested in the sandbox, and its version range is where it was *read*, not a promise for other versions.
- **WP Rocket stored keys are unknown.** WP Rocket is premium and its official documentation names settings by their label only, so no stored key is claimed for it.
- **Patch coverage is four patterns:** a `remove_action` / `remove_filter` at the wrong priority, a missing `function_exists` / `class_exists` guard, a custom copy replacing a WordPress core script or style, and a dependency on a handle nobody registers. Plus one shim (hook priority) and two-way hook-order candidates. Everything else is "needs a human". Patches are only ever offered for files on the `customPaths` allowlist.
- **Bisection cannot explain a symptom that is present with no plugins.** If the problem is still there with every plugin switched off, the report says so in plain words (**NOT A PLUGIN CONFLICT**) and no plugin is blamed; the cause is the theme, a must-use plugin, core, the database content or the server. Bisection also needs a symptom that *appears* when plugins are combined: "something is missing" is true with no plugins at all, so choose an oracle that fires on the broken page. It finds the smallest set among *active plugins* in a fixed order; with more than ~40 page loads or 15 minutes it stops and says the result is not proven minimal.
- **Without `--sandbox`, hook-order shims are candidates.** When two components use the same hook at the same priority, both orders are listed, each marked **test to choose**; neither is "the answer" until the sandbox ran both.
- **`FIXED_VERIFIED` is sandbox-only.** It needs the original run to have reproduced the symptom in the sandbox with a known set of active plugins, and a sandbox retest with at least those plugins on the same page and screen size. A retest with the live probe can say "Fixed" but never `FIXED_VERIFIED`.
- **The sandbox can still make raw outbound connections** to an IP address from the WordPress container (Docker cannot publish a port on a network with no route out). `WP_HTTP_BLOCK_EXTERNAL` stops WordPress's own HTTP API, host-name lookups fail, mail is intercepted, the database and WP-CLI containers have no route out; raw sockets to an IP are not blocked. Run sandboxes only for your own copies.
- **OCR** reads clean screenshots of text; it can misread small, low-contrast or photographed text, and every OCR clue stays "possible". **The knowledge base** covers WooCommerce, Elementor and cache/optimisation plugins and core handle problems, not the whole plugin ecosystem; a hit is a hypothesis. **Unscrubbed data**: tables of other plugins are not anonymised in a sandbox; they are listed in the report.
- Elementor "Improved Asset Loading" / "Improved CSS Loading" exist only in older versions (present in 3.20.0, not listed from 3.30.0 on); the release in between was not identified.

## The `plugin-guard` command

`npm run plugin-guard` (from the repo root), `npm exec --prefix src/plugin-guard -- plugin-guard`, or after `npm pack` + `npm install ./wordpress-dev-agent-plugin-guard-*.tgz`: `npm exec -- plugin-guard`. It asks only plain questions: what is wrong, screenshots (optional), the website address (optional), and which WordPress folder. The folders found on this computer (here and above, and the usual web folders such as /var/www, ~/public_html, ~/Local Sites, XAMPP and MAMP; looked at read-only, three levels deep, never through symlinks) are shown as a numbered list; you type a number or a path. The site's own log (wp-content/debug.log, error_log, or the WP_DEBUG_LOG path in wp-config.php, always inside your site) is found by itself and a line says which one was used; logs outside the site such as /var/log are never read. There is no PHP question (use `--php`). With a website address the tool guesses local, staging or live from the name and asks you to confirm in one line (`--env` skips it). It then makes a redacted COPY of the site inside the report folder, and runs the issue pipeline with the gate and the follow-up questions. Nothing is written into your site folder. A live site is visited only after you type its domain (or pass `--authorized`). `plugin-guard --help` lists the flags; with `--yes` nothing is asked.
