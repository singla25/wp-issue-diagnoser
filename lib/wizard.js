// The questions behind `plugin-guard`. It only COLLECTS answers and prepares a copy; the work itself is the existing issue pipeline (lib/issue-cli.js investigate):
// the same environment / --authorized rules (lib/issue-store.js authorization), the same probe safety, the same sandbox rules, the same follow-up questions.
// Order: problem · screenshots · site address (optional) · site folder (found on this computer, or typed) · site kind (only with an address, guessed and confirmed in one line).
// The log is found inside the site by itself (lib/log-finder.js) and the PHP version is not asked here (--php still works). No question carries a counter.
// Flags always win over questions; with --yes (or no terminal, or --no-prompt) nothing is asked and a missing required value is an error (exit 2).

const fs = require('fs');
const path = require('path');
const store = require('./issue-store');
const intake = require('./site-intake');
const cli = require('./issue-cli');
const ocrData = require('./ocr-data');
const finder = require('./site-finder');
const logFinder = require('./log-finder');
const envGuessLib = require('./env-guess');

const fail = (msg, code = 2) => Object.assign(new Error(msg), { exitCode: code });
const hostOf = u => { try { return new URL(u).hostname.toLowerCase(); } catch { return ''; } };
const IMG = /\.(png|jpe?g|webp|gif|pdf)$/i;

async function run(o, { resolveHost, input = process.stdin, output = process.stdout, tty, env = process.env, cwd = require('./config').userCwd(), preflight, pkgIssues, siteRoots = null, findOpts = {}, spawn } = {}) {
    const hasTty = tty !== undefined ? !!tty : !!(input && input.isTTY && output && output.isTTY);
    const interactive = hasTty && !o.yes && !o['no-prompt'];
    const io = cli.lineReader(input, output);
    const say = t => io.say(t);
    const must = async q => { const r = await io.askRaw(q); if (r === null) throw fail('The input ended before all questions were answered.'); return r; };
    const abs = p => path.resolve(cwd, String(p).replace(/^~(?=\/|$)/, env.HOME || '~'));
    try {
        // ---- 1 the problem ----
        let description = o.description;
        if (description === undefined && interactive) {
            say('Plugin Guard looks at a copy of your WordPress site and tells you what is probably causing a problem. Your site is only read, never changed.\n');
            for (;;) { description = await must('What is wrong? Say what you see, what you expected, and what changed just before'); if (description) break; say('    Please write at least a few words.'); }
        }
        if (!description || !String(description).trim()) throw fail('Missing required value: the problem description. Pass --description "<what is wrong>" (or run in a terminal and answer the questions).');

        // ---- 2 screenshots ----
        let images = o.images !== undefined ? String(o.images).split(',').map(s => s.trim()).filter(Boolean) : null;
        if (images === null) {
            images = [];
            if (interactive) for (;;) {
                const a = await io.askRaw('Screenshots: a file or folder path (several: separate with commas), or Enter to skip');
                if (!a) break;
                const list = a.split(',').map(s => s.trim()).filter(Boolean), bad = list.filter(p => !fs.existsSync(abs(p)));
                if (!bad.length) { images = list; break; }
                say(`    Not found: ${bad.join(', ')}. Try again, or press Enter to skip.`);
            }
        }
        images = images.map(abs);
        if (images.length) {
            const st = ocrData.status('eng');
            if (!st.ok) say('Note: text in screenshots cannot be read yet, because the text-reading data (OCR) is not installed. The screenshots are still kept with the report. To enable it, run once:  npm run guard:setup-ocr');
        }

        // ---- log: --log wins; otherwise it is found inside the site later (no question) ----
        let logFile = o.log !== undefined ? abs(o.log) : null;
        if (logFile && !(fs.existsSync(logFile) && fs.statSync(logFile).isFile())) throw fail(`The log file ${logFile} does not exist or is not a file.`);

        // ---- 4 site address ----
        let url = o.url !== undefined ? String(o.url).trim() : null;
        const validUrl = u => { try { return /^https?:$/.test(new URL(u).protocol); } catch { return false; } };
        if (url !== null && url && !validUrl(url)) throw fail(`--url "${url}" is not a valid http(s) address.`);
        if (url === null && interactive) for (;;) {
            const a = await io.askRaw('Website address (https://...), or Enter to skip (the site is then not visited at all)');
            if (!a) break;
            if (validUrl(a)) { url = a; break; }
            say(`    "${a}" is not a web address (it must start with http:// or https://).`);
        }
        url = url || null;

        // ---- site folder ----
        let site = null;
        if (o.root !== undefined) {
            site = intake.resolveSite(abs(o.root));
            if (site.error) throw fail(`--root: ${site.error}`);
        } else if (interactive) {
            const askPath = async () => {
                for (;;) {
                    const a = await must('Type the folder of the WordPress site (the wp-content folder, or the folder that contains it)');
                    if (!a) { say('    This one is needed: the code of the site is what gets analysed.'); continue; }
                    const s = intake.resolveSite(abs(a));
                    if (!s.error) return s;
                    say(`    ${s.error}`);
                }
            };
            const list = finder.findSites({ cwd, home: env.HOME, ...(siteRoots ? { roots: siteRoots } : {}), ...findOpts });
            if (list.length === 1) {
                for (;;) {
                    const a = (await must(`I found this WordPress site: ${list[0].path}. Use it? [Y/n]`)).trim();
                    if (!a || /^y(es)?$/i.test(a)) { site = intake.resolveSite(list[0].path); break; }
                    if (/^n(o)?$/i.test(a)) { site = await askPath(); break; }
                    const s = intake.resolveSite(abs(a));   // a path typed instead of y/n
                    if (!s.error) { site = s; break; }
                    say(`    ${s.error}`);
                }
            } else if (list.length > 1) {
                // a drill-down (lib/folder-browser.js): at most 9 entries per screen, "N of M shown", "m" for more, a typed path at any time
                site = await require('./folder-browser').browse({ list, roots: siteRoots || finder.defaultRoots(env.HOME), cwd, abs, io: { say, ask: must }, ...findOpts });
            } else {
                say('I did not find a WordPress site in the usual places on this computer.');
                site = await askPath();
            }
        }
        if (!site) throw fail('Missing required value: the site folder. Pass --root <wp-content folder or WordPress root>.');
        say(`    Using ${site.root} (read-only; a copy is made).`);
        // the site's own log files, found inside the site; system logs (/var/log ...) are never looked at
        let cfgText = '';
        try { const cf = path.join(site.root, 'wp-config.php'); if (fs.lstatSync(cf).isFile()) cfgText = fs.readFileSync(cf, 'utf8'); } catch { /* no wp-config.php */ }
        const logsFound = logFile ? [] : logFinder.findLogs(site.root, cfgText).slice(0, 3);
        const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
        const sizeOf = b => (b >= 1048576 ? `${Math.round(b / 1048576)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`);
        const dateOf = iso => { const d = new Date(iso); return `${d.getUTCDate()} ${MON[d.getUTCMonth()]} ${d.getUTCFullYear()}`; };
        if (logFile) say(`Log used: ${logFile} (given with --log).`);
        else if (logsFound.length) {
            say(`Log used: ${logsFound[0].rel} (${sizeOf(logsFound[0].bytes)}, last written ${dateOf(logsFound[0].mtime)}).`);
            for (const l of logsFound.slice(1)) say(`Also used: ${l.rel} (${sizeOf(l.bytes)}, last written ${dateOf(l.mtime)}).`);
        } else say('No log was found in your site. Turning on WP_DEBUG_LOG in wp-config.php would let this tool see the error next time.');

        // ---- site kind ----
        let envName = o.env !== undefined ? String(o.env) : null;
        if (envName && !store.ENVIRONMENTS.includes(envName)) throw fail(`--env must be one of ${store.ENVIRONMENTS.join(', ')}.`);
        const askEnv = async () => {
            for (;;) {
                const a = ((await must('Is it 1) local (on this computer), 2) staging (a test copy online) or 3) live (the real, public site)?')) || '').trim().toLowerCase();
                const byNumber = { 1: 'local', 2: 'staging', 3: 'live' }[a];
                if (byNumber) return byNumber;
                if (store.ENVIRONMENTS.includes(a)) return a;
                say('    Please type 1, 2 or 3 (or local, staging, live).');
            }
        };
        let localByLookup = false;   // the name points at this computer or the own network (a DNS lookup only; the site is not visited)
        if (!envName) {
            if (interactive && url) {
                const g = await envGuessLib.envGuessResolved({ url, root: site.root }, resolveHost ? { resolve: resolveHost } : {});
                const a = ((await must(`This looks like a ${g.kind.toUpperCase()} site (${hostOf(url)}). Is that right? [Y/n]`)) || '').trim();
                envName = /^n/i.test(a) ? await askEnv() : g.kind;
                localByLookup = !/^n/i.test(a) && !!g.resolved_local;
            }
            else if (url) throw fail(`Missing required value: say what kind of site ${url} is: --env local | staging | live. The tool will not guess that a public site may be visited.`);
            else envName = 'local';   // no address: the site is never visited, so the kind only labels the report
        }
        // "local" for a public name: ask once more when there is a terminal; otherwise say it (the existing rules are not changed)
        if (url && envName === 'local' && !localByLookup && !intake.hostIsLocal(hostOf(url))) {
            if (interactive) {
                for (;;) {
                    const a = (await must(`    ${hostOf(url)} does not look like a local address (localhost, a private address, or a .local / .test name). Is it really on this computer or your own network? [y/N]`)) || '';
                    if (/^y(es)?$/i.test(a)) break;
                    say('    Then it is staging or live.'); envName = await askEnv(); break;
                }
            } else say(`Warning: ${hostOf(url)} does not look like a local address, but --env local was given. It will be treated as local as you said; if it is a public site, use --env staging or --env live.`);
        }
        // live: the reporter types the domain, or --authorized was given. Nothing else unlocks a live probe.
        let authorized = !!o.authorized;
        if (url && envName === 'live' && !authorized) {
            const host = hostOf(url);
            if (!interactive) throw fail(`${url} is marked live. Without a terminal to confirm on, a live site is not visited unless you pass --authorized (prefer a staging copy).`, 3);
            say(`    ${host} is a LIVE site. It will only be read: a few paced page loads, nothing clicked or submitted, and it stops at the first sign of protection.`);
            const a = ((await must(`    To confirm you may test it, type the site's domain exactly (${host})`)) || '').trim().toLowerCase();
            if (a !== host) throw fail(`That is not ${host}, so the live site was NOT visited. Run again and type the domain exactly, or use a staging copy.`, 3);
            authorized = true;
        }

        // ---- PHP version: only from --php (the pipeline's own later question covers the rest) ----
        let php = o.php !== undefined ? String(o.php).trim() : null;
        if (php && !/^\d{1,2}(\.\d{1,2}){0,2}$/.test(php)) throw fail('--php must look like 8.1 or 7.4.33.');
        // a folder name such as php83 or 8.3 is only a HINT: it is asked, never set silently (and never when --php was given or there is no terminal)
        let phpSource = null;
        if (!php && interactive) {
            const hint = require('./folder-browser').phpHint(site.root);
            if (hint) {
                const a = ((await must(`This folder looks like PHP ${hint}. Is that the version this site runs? [Y/n]`)) || '').trim();
                if (!/^n/i.test(a)) { php = hint; phpSource = 'you confirmed'; }
            }
        }

        // ---- a deeper test in a throwaway copy: only when Docker is already usable (it is never started), never for a live site, never without a terminal ----
        // The deeper test is asked first (default no); only when the person says yes is a database backup (.sql) asked, because the test can then reproduce what depends on the data.
        // A sandbox that cannot run never changes what a finding is (issue/sandbox-phase.js): it is "no sandbox evidence".
        let sandbox = !!o.sandbox, dbDump = o['db-dump'] ? abs(o['db-dump']) : null;
        if (!o.sandbox && interactive && envName !== 'live') {
            const pf = (preflight || (() => require('../issue/sandbox').preflight()))();
            if (pf && pf.ok) {
                // the sandbox is asked first; a database backup (.sql) is asked ONLY when the person chooses it (flags-only paths are unchanged)
                const a0 = ((await io.askRaw('Optional: a deeper test in a throwaway copy takes a few minutes. Run it? [y/N]')) || '').trim();
                sandbox = /^y/i.test(a0);
                if (sandbox) {
                    for (;;) {
                        const a = await io.askRaw('Do you have a database backup (an .sql file) of the site? Enter its path, or press Enter for none');
                        if (!a) break;
                        const f = abs(a);
                        if (fs.existsSync(f) && fs.statSync(f).isFile() && /\.sql(\.gz)?$/i.test(f)) { dbDump = f; break; }
                        say(`    ${a} is not an .sql (or .sql.gz) file that exists. Try again, or press Enter for none.`);
                    }
                    if (dbDump) say('    The backup is read only. It is imported into a throwaway copy, never into your site, and user names, e-mail addresses and passwords are made anonymous.');
                }
            }
        }

        // ---- where the files go, then the copy ----
        const out = intake.chooseOutputRoot({ out: o.out, env, cwd, defaultRoot: pkgIssues || path.join(__dirname, '..', 'issues'), siteRoot: site.root });
        process.env.PLUGIN_GUARD_ISSUES = out.dir;
        if (out.why !== 'default') say(`Reports go to ${out.dir} (${out.why}).`);
        const titleRaw = String(description).replace(/\s+/g, ' ').trim();
        const title = require('./plain-names').clipTitle(titleRaw, 100);
        const issue = store.create({ title, description, symptom: 'other', environment: envName, url, authorized, phpVersion: php, phpSource, pages: [] });
        const dir = store.dirOf(issue.id), copyDir = path.join(dir, 'site-copy');
        const logFiles = logsFound.map((l, i) => ({ src: l.path, dest: i === 0 ? 'wp-content/debug.log' : l.rel })).filter((l, i, all) => i === 0 || l.dest !== all[0].dest);
        let copied;
        try { copied = intake.copyForIssue({ site, issueDir: dir, destSite: copyDir, logFile, logFiles, crash: require('../issue/logs').looksLikeCrash(description), limits: o['max-size-mb'] ? { maxBytes: Number(o['max-size-mb']) * 1048576 } : {} }); }
        catch (e) {
            if (e.cap) { if (store.ISSUE_RE.test(path.basename(dir))) fs.rmSync(dir, { recursive: true, force: true }); }   // our own, still empty issue folder
            if (e.cap) throw fail(`The site is too big to copy for analysis: ${e.message}\n  What to do: give the wp-content folder itself (not the whole WordPress folder), or a copy without large backups, caches and uploads, and run again.`);
            throw e;
        }
        fs.writeFileSync(path.join(dir, 'work', 'intake.json'), JSON.stringify({ steps: copied.steps, wp_config: copied.wp_config, log: copied.log, files: copied.files, php_skipped: copied.php_skipped, php_skipped_examples: copied.php_skipped_examples }, null, 2), { mode: 0o600 });
        const saved = store.load(issue.id); saved.root = copyDir; store.save(saved);
        if (images.length) {
            const r = store.intakeImages(issue.id, images, { wpRoot: copyDir });
            say(`${r.accepted.length} screenshot(s) kept${r.refused.length ? `; refused: ${r.refused.map(x => `${path.basename(x.path)} (${x.reason})`).join(', ')}` : ''}.`);
        }
        for (const st of copied.steps) say(`  ${st.status === 'PASSED' ? 'done   ' : 'skipped'} ${st.label}: ${st.reason}`);
        say('');

        // --site-health <file> (Part 6b) is passed through as given (no question), made absolute against the folder the command was started in
        const opts = { ...o, gate: true, sandbox, ...(sandbox && dbDump ? { 'db-dump': dbDump } : {}), ...(typeof o['site-health'] === 'string' && o['site-health'].trim() ? { 'site-health': abs(o['site-health']) } : {}), authorized: undefined, root: undefined, yes: o.yes, 'no-prompt': o['no-prompt'] };
        const code = await cli.investigate(issue.id, opts, 'investigate', { io, interactive });
        // ---- the choice step (issue/plan-questions.js), AFTER the report: only with a terminal, never with --yes / --no-questions / --no-prompt; then FIX-PLAN.md is written again ----
        let planFile = null;
        const askTerminal = require('../issue/plan-questions').interactiveNow(o, { tty: hasTty });
        const reportHtml = path.join(dir, 'result', 'issue.html');
        if (askTerminal && fs.existsSync(reportHtml)) {   // Part 5: status line + link, then the offer to open it
            const openReport = require('./open-report');
            let label = ''; try { label = JSON.parse(fs.readFileSync(path.join(dir, 'result', 'findings.json'), 'utf8')).case_file.status.line || ''; } catch { /* no status line */ }
            const chk = openReport.check(reportHtml, store.issuesRoot());
            const url = openReport.fileUrl(chk.ok ? chk.real : path.resolve(reportHtml));
            say(`\n${label ? `${label}\n` : ''}Full report: ${url}`);
            if (chk.ok && openReport.hasDisplay(env)) {
                const a = await io.askRaw('Open it in your browser now? [Y/n]');
                if (a !== null && !/^n/i.test(a)) {
                    const r = await openReport.open(reportHtml, { issuesRoot: store.issuesRoot(), env, tty: true, spawn: spawn });
                    if (!r.opened) say(openReport.FALLBACK(url));
                }
            } else say(openReport.FALLBACK(url));
        }
        const findingsFile = path.join(dir, 'result', 'findings.json');
        if (fs.existsSync(findingsFile)) {
            const fixPlan = require('../issue/fix-plan'), planQ = require('../issue/plan-questions');
            const f = JSON.parse(fs.readFileSync(findingsFile, 'utf8'));
            if (planQ.interactiveNow(o, { tty: hasTty }) && fixPlan.context(f)) {
                await planQ.run({ f, io: { say, ask: q => io.askRaw(q) }, interactive: true, save: a => store.applyPlanAnswers(issue.id, a), evidence: fixPlan.compatEvidence(store.load(issue.id).root, fixPlan.context(f)) });
                planFile = fixPlan.writeFor(issue.id, dir, f);
            } else if (fs.existsSync(path.join(dir, 'result', 'FIX-PLAN.md'))) planFile = path.join(dir, 'result', 'FIX-PLAN.md');
        }
        if (askTerminal && fs.existsSync(reportHtml)) {   // Part 5: feedback after the plan
            await require('./feedback').collect({ io: { say, ask: q => io.askRaw(q) }, dir });
            const pf = path.join(dir, 'result', 'FIX-PLAN.md');
            if (fs.existsSync(pf)) say(`Plan saved at ${pf}. To have Claude Code carry it out on a copy, give it that file.`);
        }
        say(`\nReport folder: ${path.join(dir, 'result')}\nOpen ${path.join(dir, 'result', 'issue.html')} in a browser. Your site folder was not changed.${planFile ? `\nFix plan: ${planFile}` : ''}`);
        return code;
    } finally { io.close(); }
}

module.exports = { run };
