// The questions behind `plugin-guard`. It only COLLECTS answers and prepares a copy; the work itself is the existing issue pipeline (lib/issue-cli.js investigate):
// the same environment / --authorized rules (lib/issue-store.js authorization), the same probe safety, the same sandbox rules, the same follow-up questions.
// Order: 1 problem · 2 screenshots · 3 log file · 4 site address · 5 site folder · 6 environment · 7 PHP version.
// Flags always win over questions; with --yes (or no terminal, or --no-prompt) nothing is asked and a missing required value is an error (exit 2).

const fs = require('fs');
const path = require('path');
const store = require('./issue-store');
const intake = require('./site-intake');
const cli = require('./issue-cli');
const ocrData = require('./ocr-data');

const fail = (msg, code = 2) => Object.assign(new Error(msg), { exitCode: code });
const hostOf = u => { try { return new URL(u).hostname.toLowerCase(); } catch { return ''; } };
const IMG = /\.(png|jpe?g|webp|gif|pdf)$/i;

async function run(o, { input = process.stdin, output = process.stdout, tty, env = process.env, cwd = require('./config').userCwd(), preflight, pkgIssues } = {}) {
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
            for (;;) { description = await must('1/7 What is wrong? Say what you see, what you expected, and what changed just before'); if (description) break; say('    Please write at least a few words.'); }
        }
        if (!description || !String(description).trim()) throw fail('Missing required value: the problem description. Pass --description "<what is wrong>" (or run in a terminal and answer the questions).');

        // ---- 2 screenshots ----
        let images = o.images !== undefined ? String(o.images).split(',').map(s => s.trim()).filter(Boolean) : null;
        if (images === null) {
            images = [];
            if (interactive) for (;;) {
                const a = await io.askRaw('2/7 Screenshots: a file or folder path (several: separate with commas), or Enter to skip');
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

        // ---- 3 log file ----
        let logFile = o.log !== undefined ? abs(o.log) : null;
        if (logFile && !(fs.existsSync(logFile) && fs.statSync(logFile).isFile())) throw fail(`The log file ${logFile} does not exist or is not a file.`);
        if (o.log === undefined && interactive) for (;;) {
            const a = await io.askRaw('3/7 Log file (for example wp-content/debug.log), or Enter to skip');
            if (!a) break;
            const f = abs(a);
            if (fs.existsSync(f) && fs.statSync(f).isFile()) { logFile = f; break; }
            say(`    ${a} is not a file. Try again, or press Enter to skip.`);
        }

        // ---- 4 site address ----
        let url = o.url !== undefined ? String(o.url).trim() : null;
        const validUrl = u => { try { return /^https?:$/.test(new URL(u).protocol); } catch { return false; } };
        if (url !== null && url && !validUrl(url)) throw fail(`--url "${url}" is not a valid http(s) address.`);
        if (url === null && interactive) for (;;) {
            const a = await io.askRaw('4/7 Website address (https://...), or Enter to skip (the site is then not visited at all)');
            if (!a) break;
            if (validUrl(a)) { url = a; break; }
            say(`    "${a}" is not a web address (it must start with http:// or https://).`);
        }
        url = url || null;

        // ---- 5 site folder ----
        let site = null;
        if (o.root !== undefined) {
            site = intake.resolveSite(abs(o.root));
            if (site.error) throw fail(`--root: ${site.error}`);
        } else if (interactive) for (;;) {
            const a = await must('5/7 Folder of the WordPress site on this computer (the wp-content folder, or the folder that contains it)');
            if (!a) { say('    This one is needed: the code of the site is what gets analysed.'); continue; }
            site = intake.resolveSite(abs(a));
            if (!site.error) break;
            say(`    ${site.error}`); site = null;
        }
        if (!site) throw fail('Missing required value: the site folder. Pass --root <wp-content folder or WordPress root>.');
        say(`    Using ${site.root} (read-only; a copy is made).`);

        // ---- 6 environment ----
        let envName = o.env !== undefined ? String(o.env) : null;
        if (envName && !store.ENVIRONMENTS.includes(envName)) throw fail(`--env must be one of ${store.ENVIRONMENTS.join(', ')}.`);
        const askEnv = async () => {
            for (;;) {
                const a = (await must('6/7 Is this site local (on your computer), staging (a test copy online) or live (the real, public site)? [local / staging / live]')) || '';
                if (store.ENVIRONMENTS.includes(a.toLowerCase())) return a.toLowerCase();
                say('    Please type local, staging or live.');
            }
        };
        if (!envName) {
            if (interactive && url) envName = await askEnv();
            else if (url) throw fail(`Missing required value: say what kind of site ${url} is: --env local | staging | live. The tool will not guess that a public site may be visited.`);
            else envName = 'local';   // no address: the site is never visited, so the kind only labels the report
        }
        // "local" for a public name: ask once more when there is a terminal; otherwise say it (the existing rules are not changed)
        if (url && envName === 'local' && !intake.hostIsLocal(hostOf(url))) {
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

        // ---- 7 PHP version ----
        let php = o.php !== undefined ? String(o.php).trim() : null;
        const okPhp = v => /^\d{1,2}(\.\d{1,2}){0,2}$/.test(v);
        if (php && !okPhp(php)) throw fail('--php must look like 8.1 or 7.4.33.');
        if (php === null && interactive) for (;;) {
            const a = await io.askRaw('7/7 PHP version of the site, if you know it (for example 8.1), or Enter to skip');
            if (!a) break;
            if (okPhp(a)) { php = a; break; }
            say('    That should look like 8.1 or 7.4.33.');
        }

        // ---- a deeper test in a throwaway copy: only when Docker is already usable (it is never started), never for a live site, never without a terminal ----
        // With a database backup (.sql) the test can reproduce what depends on the data, so that is asked first; without one the test is only an optional extra (default no).
        // A sandbox that cannot run never changes what a finding is (issue/sandbox-phase.js): it is "no sandbox evidence".
        let sandbox = !!o.sandbox, dbDump = o['db-dump'] ? abs(o['db-dump']) : null;
        if (!o.sandbox && interactive && envName !== 'live') {
            const pf = (preflight || (() => require('../issue/sandbox').preflight()))();
            if (pf && pf.ok) {
                for (;;) {
                    const a = await io.askRaw('Do you have a database backup (an .sql file) of the site? Enter its path, or press Enter for none');
                    if (!a) break;
                    const f = abs(a);
                    if (fs.existsSync(f) && fs.statSync(f).isFile() && /\.sql(\.gz)?$/i.test(f)) { dbDump = f; break; }
                    say(`    ${a} is not an .sql (or .sql.gz) file that exists. Try again, or press Enter for none.`);
                }
                if (dbDump) {
                    say('    The backup is read only. It is imported into a throwaway copy, never into your site, and user names, e-mail addresses and passwords are made anonymous.');
                    const a = ((await io.askRaw('A deeper test in a throwaway copy takes a few minutes. Run it? [Y/n]')) || '').trim();
                    sandbox = !/^n/i.test(a);
                } else {
                    const a = ((await io.askRaw('Optional: a deeper test in a throwaway copy without your data takes a few minutes. Run it? [y/N]')) || '').trim();
                    sandbox = /^y/i.test(a);
                }
            }
        }

        // ---- where the files go, then the copy ----
        const out = intake.chooseOutputRoot({ out: o.out, env, cwd, defaultRoot: pkgIssues || path.join(__dirname, '..', 'issues'), siteRoot: site.root });
        process.env.PLUGIN_GUARD_ISSUES = out.dir;
        if (out.why !== 'default') say(`Reports go to ${out.dir} (${out.why}).`);
        const title = String(description).replace(/\s+/g, ' ').trim().slice(0, 100);
        const issue = store.create({ title, description, symptom: 'other', environment: envName, url, authorized, phpVersion: php, pages: [] });
        const dir = store.dirOf(issue.id), copyDir = path.join(dir, 'site-copy');
        // the site's own debug.log is offered when no log was given
        if (!logFile) {
            const own = path.join(site.wpContent, 'debug.log');
            if (fs.existsSync(own) && fs.statSync(own).isFile()) {
                let use = true;
                if (interactive) use = !/^n/i.test((await io.askRaw('    The site has its own wp-content/debug.log. Use it (a redacted copy is read; the file is not changed)? [Y/n]')) || '');
                if (use) logFile = own;
            }
        }
        let copied;
        try { copied = intake.copyForIssue({ site, issueDir: dir, destSite: copyDir, logFile, crash: require('../issue/logs').looksLikeCrash(description), limits: o['max-size-mb'] ? { maxBytes: Number(o['max-size-mb']) * 1048576 } : {} }); }
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

        const opts = { ...o, gate: true, sandbox, ...(sandbox && dbDump ? { 'db-dump': dbDump } : {}), authorized: undefined, root: undefined, yes: o.yes, 'no-prompt': o['no-prompt'] };
        const code = await cli.investigate(issue.id, opts, 'investigate', { io, interactive });
        say(`\nReport folder: ${path.join(dir, 'result')}\nOpen ${path.join(dir, 'result', 'issue.html')} in a browser. Your site folder was not changed.`);
        return code;
    } finally { io.close(); }
}

module.exports = { run };
