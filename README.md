# wp-issue-diagnoser

Command name: plugin-guard

To get it:

```bash
git clone https://github.com/singla25/wp-issue-diagnoser.git
cd wp-issue-diagnoser
npm ci
npm run plugin-guard
```

The first three sections are for anyone. They describe the `plugin-guard` command. The technical guide starts after them.

## What this does

- You tell it what is wrong with a WordPress site, for example "the shop page is blank". You also say where the site's folder is on this computer. You can add screenshots and the address of the website.
- It makes its own copy of the site's files. It reads that copy and the site's error log. It looks for the plugin, theme or setting that most likely causes the problem.
- With the website's address, it also loads a few pages of the site, to see the problem from the outside.
- With a database export file of the site and Docker on this computer, it can build a throwaway test copy of the site and try the problem there. The test copy is removed at the end.
- It writes a report you can open in your browser, and a short plan of what to do next.

To start it, open a terminal in this repository's folder and type `npm run plugin-guard`. It asks one question at a time.

## What it never does

- It never writes to your site folder. It only reads it. Its copy of the site and its reports go into its own report folder, and that folder is never inside your site folder.
- It reads your site's files. The only thing it runs on them is a PHP syntax check (`php -l`). Your site's own code is run only inside the Docker test copy.
- It never changes your website. With an address, it only loads pages, like a visitor's browser: read-only requests (GET), one page at a time, with a pause between pages. It never logs in, clicks, types or sends a form there, so it only sees what any visitor can see.
- It stops at the first sign that the website is protecting itself (a "too many requests" answer or a challenge page). It does not try again, and it sends nothing more to that website for 30 minutes.
- It never visits a live website without your confirmation: you type the website's name (its domain) when asked, or you give `--authorized`.
- A live site is never copied with its database. A test copy from a database file is built only for a local or staging site.
- It never applies a fix to your site. Suggested changes are written into files and a plan, and a person makes them, on a copy first. A fix may be tried inside a test copy, to see whether it helps.
- It never asks an AI. No AI service is called, and the same input gives the same report.
- It sends nothing to other services on its own. Checking plugin versions at wordpress.org or WPScan happens only when you switch it on for a project (`outsideLookups`, for the older scan commands below). Apart from loading your own website's pages, only these commands use the internet: the one-time setup commands (`npm ci`, `npm run setup-ocr`, `npm run setup-sandbox`) and `npm run verify-knowledge`.
- Your real user accounts are never put into a test copy. Every account becomes a dummy account. One dummy administrator gets a password that is shown once on the screen and never saved.

The test copy has limits on its network, but it is not cut off from it. Built from a database file, the WordPress in the copy has no route to the internet. Built without one (`--sandbox`), it can still open a direct connection to an internet address written as numbers (an IP address); only WordPress's own web requests and its e-mail are blocked. So build test copies only of sites you own, with plugins you trust. The full rules are in [the safety rules](./docs/SAFETY.md).

## How to read the report

- The top of the report is plain sentences, so you can forward it. Technical detail (files, lines, the error text) is further down, under "For a developer".
- The STATUS line counts what was found, for example "1 likely cause (not confirmed) · 1 thing to check · 0 confirmed". A "Likely cause (not confirmed)" comes from your log and the code, but no second, independent test proved it. A "Confirmed cause" is backed by two independent checks. "Something else to check (probably not the crash)" is worth a look, but probably did not cause the problem.
- A heading then says how far the testing went. There are three:
  - "Tested on a copy of your site": a test copy of your site showed the same problem as your site. This is the strongest result.
  - "Not tested on a copy": no test copy was used. The report lists what was missing (a database export file, Docker, the site's code, or a page that fails on your site to compare with), or says "You chose not to build a test copy." What the report says then comes from reading your log and the code; it is labelled NOT TESTED.
  - "The test copy could not confirm this": a test copy was tried, but it could not run, or it did not show the same problem.
- NOT CONFIRMED: this label means a test copy was built and showed the reported error in its log, but your site had no failing page to compare with. So the copy does not confirm the report.
- "How close the copy is": this box is shown when a test copy was built. It sorts what was compared into four groups: "Matched", "Did not match", "Not known", and "Not covered in this version". It covers the versions (PHP, database, WordPress), the active plugins, and whether the copy showed the same error. "Not covered in this version" lists what a copy cannot show yet, such as calls to outside services, the web server's own rules, file permissions and cron jobs.
- "What was checked" counts the checks: pass, fail, not checked, and also noticed (something was found, but nothing ties it to this problem).
- Nothing in the report is done for you. Each case has a "What to do" line, and the plan file (FIX-PLAN.md) lists the steps, each with how to undo it.

## Status

Plugin Guard is in active development. Things may change, and it has not been proven on a wide range of real sites. Its reports say how far each result was checked, and the "Limits" sections below list what it does not do.

## How it was built

It was designed and directed by the author, working with Claude Code and sub-agents. It is checked by an automated test suite, run with the `npm run selftest` commands listed under "Tests" below. Passing tests show that the checks do what the tests describe; they do not show that every WordPress site will be analysed correctly.

---

Checks how the plugins, themes and settings of a WordPress project depend on each other, conflict with each other, and what they leave open to attackers. **Read-only: it never changes a site.** It produces a PDF report for the admin and, after the admin decides, a Markdown task file for a Claude agent to do the fixing.

```
URL  ─┐                                     ┌─ decisions.txt  (admin marks each item: fix / ignore / accept)
      ├─►  scan  ─►  PDF report + findings ─┤
local ─┘                                     └─►  fixfile  ─►  FIXES-FOR-CLAUDE.md  ─►  Claude fixes  ─►  retest
copy
```

## Quick start

```bash
npm run selftest                                                  # offline check, no real site touched
npm run guard -- init acme --url https://acme.example/                  # creates projects/acme/project.json
npm run guard -- scan acme                                              # URL-only scan: what a visitor can see
npm run guard -- set acme --path ~/sites/acme                           # add the local copy later (other settings are kept)
npm run guard -- scan acme                                              # full scan
# open plugin-guard-reports/plugin-guard/acme/PLUGIN-GUARD-REPORT.pdf, then edit projects/acme/decisions.txt
npm run guard -- fixfile acme                                           # → plugin-guard-reports/plugin-guard/acme/FIXES-FOR-CLAUDE.md
npm run guard -- retest acme                                            # after Claude fixed things: Fixed / Still open / New
```

The PDF needs Chromium: run `npm ci` once (it installs Plugin Guard's own Playwright); if Chromium is missing, `npx playwright install chromium`. Without it you still get the HTML copy.

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

- **`schedule`** is the admin's approval: `none` (default) / `daily` / `weekly` / `monthly`. `npm run guard -- due` lists projects whose scan is due, `npm run guard -- run-due` scans them. **Nothing starts by itself**; to automate, put `run-due` in your own cron.
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

`fix` items go into `FIXES-FOR-CLAUDE.md` (with exact paths, the fix, commands, the code to add, and a "done when"). `ignore` and `accept` stay out, are listed under "do not change", and are remembered on later scans, even if the finding disappears and comes back. `fixfile` refuses to run until every `ignore`/`accept` has a reason.

**Deciding a whole rule at once.** `npm run guard -- bulk <project>` lists the rules in the last scan with counts. Then, for example:

```bash
npm run guard -- bulk acme --rule code-no-abspath,redeclare-class --as ignore --reason "Vendor libraries, not reachable directly"
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

Reports go to `plugin-guard-reports/runs/<run-id>/` (git-ignored). The older `scan <project>` flow above is unchanged.

```
Agent 1  user / frontend    browser tests of a URL. NOT part of this repository (see below)
Agent 2  code / security    inspects a local WordPress root (php -l, WP patterns, conflicts) ─►  02-code-test-report.md
Agent 3  validation         re-checks what ran, correlates, decides statuses, applies the ownership gate
                            ──►  03-final-validation-report.md · findings.json · claude-tasks.md · report.html
```

Agent 1 (the browser tests of a live URL) lived in a separate module that is not in this repository. Here, `qa-code` (Agent 2) and `qa-validate` (Agent 3) work on a local WordPress root, and a report without Agent 1 says it is PARTIAL. `qa-url` and `auto` only print a message that they belong to that other module.

### Local first

Open a terminal in the WordPress root (the folder with `wp-content`):

```bash
node /path/to/plugin-guard/scripts/guard.js scan --root .
# or, from this repository:  npm run guard -- scan --root /absolute/path/to/wordpress
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

`doctor [--root .]` prerequisites · `config --root .` validate settings · `show [--run id]` list a run's files and the open command. The classic scan never opens a report; the issue wizard opens its own report only after asking.

Exit codes of `qa-*` and `scan --root`: `0` done, nothing at/above `--fail-on` (default HIGH; counts neither BLOCKED, rejected nor verified-fixed) · `1` findings at/above it · `2` bad usage or configuration · `3` blocked (authorization missing, site protection, nothing could run).

### What needs what

| | Offline | Network / live target | Runtime WordPress | Credentials |
|---|---|---|---|---|
| Ownership gate, config validation, report generation, HTML | yes | | | |
| `php -l`, WordPress pattern checks, conflicts, dependencies, integrity patterns | yes | | | |
| Database / user checks | yes | | WP-CLI + imported DB | |
| wordpress.org checksums / lifecycle, vulnerability DB | | yes (opt-in per project) | | `WPSCAN_API_TOKEN` for WPScan |
| PHPCS / PHPStan / Semgrep / composer+npm audit | | | | **not run yet** (detected by `doctor`) |

### Tests

```bash
npm run selftest          # original offline suite (incl. PDF)
npm run selftest:agents   # ownership, config, regressions, Agents 2-3, reports, workflows, exit codes (offline)
npm run selftest:html     # report.html in Chromium from file://: search, filters, XSS, offline, mobile
```

The audit of the original module is in [`docs/plugin-guard-audit.md`](./docs/plugin-guard-audit.md). It was written during the first repair; some limits listed there have since been resolved (for example, `FIXED_VERIFIED` is now set by `issue/retest.js` only).

## Issue mode: investigate ONE reported problem

Give it a problem a person reported ("the cart button does nothing since last week", with screenshots) and it works out, **deterministically and offline** (no AI model, no network unless you run the setup commands), which component is the likely cause, how sure it is, and what to change. It never edits your site.

```bash
npm ci                               # once: install the dependencies (issue mode needs them; the classic scan does not)
npm run setup-ocr              # once, optional: the OCR language file for screenshots (SHA-256 pinned; the only download besides the next one)
npm run setup-sandbox          # once, optional: pulls the three Docker images BY DIGEST (needs Docker, ideally rootless)
npm run demo                   # the worked example on a fixture, offline, a few seconds   (--sandbox: with Docker, several minutes; --keep: keep the files)

node scripts/guard.js issue new                      # title, description, pages, symptom, oracle, screenshots (asks one question at a time; every answer is also a flag)
node scripts/guard.js issue investigate <id> --root <wp-copy> [--config <file with customPaths>] [--url ...] [--sandbox [--db-dump f.sql]] [--no-replica]
node scripts/guard.js issue retest <id> --root <fixed-copy> --sandbox
node scripts/guard.js issue show|list|open|index|cleanup [id]
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

A throwaway copy in three Docker containers (WordPress, WP-CLI, MariaDB), images pinned by digest, not privileged, no `docker.sock`, `cap_drop ALL`, memory/CPU/process limits, ports on `127.0.0.1` only, external HTTP and mail blocked, payment gateways in live mode refused (`--neutralise-payments` switches them off in the copy), the database **always anonymised** with dummy users only (every account rewritten in place, IDs kept; the lowest-ID administrator becomes the one dummy admin `pgadmin` with a password generated for that copy, printed once on a terminal and never saved; rows rewritten or removed are counted per table, numbers only; `--keep-real-data` is retired and exits 2, `--users` accepts only `dummy`; with a database file and a terminal the wizard asks the user-accounts question: 1 dummy users, 0 skip the test copy), `wp-config.php` regenerated with new salts, always torn down (also on Ctrl-C or a crash; leftovers are swept at start). The WordPress container **can still make raw outbound connections** to an IP address: run sandboxes only for sites you own and code you trust. Details in [`docs/SAFETY.md`](./docs/SAFETY.md).

### Clean-up

`issue cleanup` lists leftover sandboxes and issue folders older than `--older-than-days` (default 30), **asks before deleting** (or `--yes`; with no terminal and no `--yes` it only lists), refuses anything that is not a plain issue/sandbox folder directly inside the issues/sandboxes folder (symbolic links, other names, `..`), and never touches Docker resources that do not carry the Plugin Guard labels.

### Worked example

`npm run demo` builds a tiny fake site where Plugin A (third party) and Plugin B (yours) both declare `my_helper()`, files the report "white screen after activating Plugin B", investigates it and prints what it found:

```
verdict:  Probable cause (confidence medium-high); symptom reproduced: could-not-test
cause:    [CONFIRMED] Duplicate declaration: plugin-a + plugin-b     (log line + both declarations re-read)
fix:      Wrap function my_helper() in a function_exists() guard  => not verified in the sandbox
          (a patch for plugin-b only; plugin-a is not on the allowlist, so it is "needs a human")
```

`npm run demo -- --sandbox` runs a second example on real containers: two plugins hook `the_content` at the same priority and one empties the post. It reproduces the symptom, bisects it to the pair, tests both orderings of a shim (one is **VERIFIED IN SANDBOX**, the other "did not help"), applies the winner to a copy and ends with `FIXED_VERIFIED`.

### Tests for issue mode

```bash
npm run selftest:issue            # CLI, store, safe folders         ·  :issue-evidence (OCR, clues, logs)  ·  :issue-code (PHP syntax tree, ownership)
npm run selftest:issue-graph      # graph, collisions, knowledge base, hypotheses  ·  :issue-seeded (bugs seeded into real code, if a real site is configured)
npm run selftest:issue-probe      # live probe and oracle against a fixture site on 127.0.0.1
npm run selftest:issue-sandbox    # container safeguards, copy rules, SandboxWpCli refusals, bisection algorithm (offline)
npm run selftest:issue-sandbox-lifecycle  # create/teardown/sweep against a fake docker
npm run selftest:issue-validate | issue-resolve | issue-cleanup | doctor
npm run selftest:issue-sandbox-docker | issue-resolve-docker | issue-verify-docker   # REAL containers; they skip, loudly, when Docker is not usable
npm run selftest:docs             # this README and docs/*.md: the commands, paths, links and plugin-guard flags they name exist
npm run selftest:isolated-copy    # this folder copied alone to a temp folder, npm ci, doctor, issue + wizard, then its non-Docker suites
```

The safety rules are in [`docs/SAFETY.md`](./docs/SAFETY.md).

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

`npm run plugin-guard` (from the repo root), or after `npm pack` + `npm install ./wordpress-dev-agent-plugin-guard-*.tgz`: `npm exec -- plugin-guard`. It asks only plain questions: what is wrong, screenshots (optional), the website address (optional), and which WordPress folder. The folders found on this computer (here and above, and the usual web folders such as /var/www, ~/public_html, ~/Local Sites, XAMPP and MAMP; looked at read-only, three levels deep, never through symlinks) are shown as a numbered list; you type a number or a path. The site's own log (wp-content/debug.log, error_log, or the WP_DEBUG_LOG path in wp-config.php, always inside your site) is found by itself and a line says which one was used; logs outside the site such as /var/log are never read. There is no PHP question up front (use `--php`); when the site folder itself hints a PHP version, one `[Y/n]` line confirms it. With a website address the tool guesses local, staging or live from the name and asks you to confirm in one line (`--env` skips it). It then makes a redacted COPY of the site inside the report folder, and runs the issue pipeline with the gate and the follow-up questions. Nothing is written into your site folder. A live site is visited only after you type its domain (or pass `--authorized`). When Docker works and the site is not live, ONE optional question follows: a database export file of the site (.sql or .sql.gz; Enter = none). With a file (asked, or given with `--db-dump`) a test copy of the site is built without asking whether to build it (the wizard still asks the one user-accounts question: 1 dummy users, 0 skip the test copy), after one line: "Building a test copy of your site with your database, about N minutes." (N = max(2, 1 + ceil(MB / 50)) of the unpacked size, `lib/dump-intake.js` `estimateMinutes`). The size cap stays (`--max-size-mb`, default 1024 MB). `--no-replica` switches the test copy off (also for `issue investigate` and `issue retest`); a live site never gets one from a database file. The report then says at the top which of three levels it is: "Tested on a copy of your site", "Not tested on a copy" (with what was missing: a database file, Docker, the code, or a failing page on your site to compare) or "The test copy could not confirm this", and, when a copy was built, a "How close the copy is" box (Matched / Did not match / Not known / Not covered in this version). `plugin-guard --help` lists the flags (each one answers a question: `--description`, `--root`, `--url`, `--env`, `--authorized`, `--php`, `--images`, `--log`, `--sandbox`, `--db-dump`, `--max-size-mb`, `--no-replica`, `--out`, `--yes`); with `--yes` nothing is asked.
