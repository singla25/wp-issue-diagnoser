#!/usr/bin/env node
// The plain `plugin-guard` wizard: sites found on this computer (lib/site-finder.js), logs found inside the site (lib/log-finder.js),
// the site kind guessed and confirmed in one line (lib/env-guess.js), and no log / PHP / counter questions (lib/wizard.js).
// Offline; nothing outside the temp folder is read or written; the web roots are injected so the real machine does not matter.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { PassThrough } = require('stream');
const { spawnSync } = require('child_process');

const PG = path.join(__dirname, '..');
const BIN = path.join(PG, 'scripts', 'plugin-guard.js');
const finder = require('../lib/site-finder');
const logFinder = require('../lib/log-finder');
const { envGuess } = require('../lib/env-guess');
const wizard = require('../lib/wizard');
const store = require('../lib/issue-store');

let failures = 0;
const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`); if (!c) failures++; };
const group = t => console.log(`\n== ${t}`);
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pg-plain-')));
const w = (root, rel, body) => { const f = path.join(root, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, body); };
const skeleton = d => { fs.mkdirSync(path.join(d, 'wp-content', 'plugins'), { recursive: true }); fs.mkdirSync(path.join(d, 'wp-content', 'themes'), { recursive: true }); return d; };
const head = n => `<?php\n/**\n * Plugin Name: ${n}\n * Version: 1.0.0\n */\n`;
function makeSite(root, { log = true } = {}) {
    for (const n of ['a', 'b']) w(root, `wp-content/plugins/plugin-${n}/plugin-${n}.php`, head('Plugin ' + n) + "defined( 'ABSPATH' ) || exit;\nfunction my_helper( $x ) {\n\treturn $x;\n}\n");
    fs.mkdirSync(path.join(root, 'wp-content/themes'), { recursive: true });
    w(root, 'wp-includes/version.php', "<?php\n$wp_version = '6.8.1';\n");
    w(root, 'wp-config.php', "<?php\ndefine( 'DB_PASSWORD', 'hunter2secret' );\ndefine( 'WP_DEBUG', true );\n$table_prefix = 'wp_';\n");
    if (log) w(root, 'wp-content/debug.log', '[01-Nov-2026 10:00:00 UTC] PHP Fatal error:  Cannot redeclare my_helper() in ' + root + '/wp-content/plugins/plugin-b/plugin-b.php on line 4\n');
    return root;
}
function fingerprint(root) {
    const h = crypto.createHash('sha256');
    (function walk(d) {
        for (const n of fs.readdirSync(d).sort()) {
            const f = path.join(d, n), st = fs.lstatSync(f);
            h.update(`${path.relative(root, f)}|${st.isDirectory() ? 'd' : st.size}|${st.mode}|${Math.round(st.mtimeMs)}\n`);
            if (st.isDirectory()) walk(f); else if (st.isFile()) h.update(fs.readFileSync(f));
        }
    })(root);
    return h.digest('hex');
}
const issuesOf = d => (fs.existsSync(d) ? fs.readdirSync(d).filter(x => store.ISSUE_RE.test(x)) : []);
const jl = (d, id) => JSON.parse(fs.readFileSync(path.join(d, id, 'issue.json'), 'utf8'));
const work = fs.mkdirSync(path.join(tmp, 'work'), { recursive: true }) || path.join(tmp, 'work');

async function wiz(answers, flags, extra = {}) {
    const input = new PassThrough(), output = new PassThrough();
    let text = ''; output.on('data', d => { text += d; });
    input.end(answers.join('\n') + (answers.length ? '\n' : ''));
    const saved = process.env.PLUGIN_GUARD_ISSUES, log = console.log; let logged = ''; console.log = (...a) => { logged += a.join(' ') + '\n'; };
    let error = null, code = null;
    try { code = await wizard.run({ _: [], 'no-probe': true, 'no-questions': true, ...flags }, { input, output, tty: true, cwd: work, env: { HOME: tmp }, preflight: () => ({ ok: false }), siteRoots: [], ...extra }); }
    catch (e) { error = e; } finally { console.log = log; if (saved === undefined) delete process.env.PLUGIN_GUARD_ISSUES; else process.env.PLUGIN_GUARD_ISSUES = saved; }
    return { text: text + logged, error, code };
}

(async () => {
    group('site-finder');
    const web = path.join(tmp, 'web'), decoy = path.join(tmp, 'decoy');
    skeleton(path.join(web, 'zeta')); skeleton(path.join(web, 'alpha'));
    skeleton(path.join(web, 'n1', 'n2', 'nested3'));          // site at depth 3: found
    skeleton(path.join(web, 'd1', 'd2', 'd3', 'too-deep'));   // site at depth 4: not found
    skeleton(path.join(web, 'node_modules', 'npm-site')); skeleton(path.join(web, '.hidden', 'dot-site'));
    skeleton(path.join(decoy, 'secret-site'));
    fs.symlinkSync(path.join(decoy, 'secret-site'), path.join(web, 'linked'));
    const seen = [];
    const rec = { lstatSync: p => { seen.push(p); return fs.lstatSync(p); }, readdirSync: (p, o) => { seen.push(p); return fs.readdirSync(p, o); } };
    const f1 = finder.findSites({ cwd: work, home: tmp, roots: [web], fsi: rec }).map(s => s.path);
    ok(JSON.stringify(f1) === JSON.stringify([path.join(web, 'alpha'), path.join(web, 'n1', 'n2', 'nested3'), path.join(web, 'zeta')]), 'two sites and a depth-3 nested one are found, sorted by path');
    ok(!f1.some(p => /too-deep/.test(p)), 'a site at depth 4 is not found');
    ok(!f1.some(p => /linked|secret-site|npm-site|dot-site/.test(p)), 'a symlinked site, node_modules and dot-folders are skipped');
    ok(!seen.some(p => p === decoy || p.startsWith(decoy + path.sep)), 'nothing outside the injected roots (and the current folder and its parents) was looked at');
    ok(JSON.stringify(finder.findSites({ cwd: work, home: tmp, roots: [web] }).map(s => s.path)) === JSON.stringify(f1), 'the order is the same on a second run');
    const many = path.join(tmp, 'many'); for (let i = 0; i < 10; i++) skeleton(path.join(many, 'site' + String(i).padStart(2, '0')));
    ok(finder.findSites({ cwd: work, home: tmp, roots: [many] }).length === 10, 'ten sites are all found without a cap');
    let t = 0;
    const capped = finder.findSites({ cwd: work, home: tmp, roots: [many], maxMs: 5500, now: () => (t += 1000) });
    ok(capped.length > 0 && capped.length < 10, `the time cap stops the search early (found ${capped.length} of 10)`);
    const cnt = finder.findSites({ cwd: work, home: tmp, roots: [many], maxDirs: 3 });
    ok(cnt.length === 2, `the directory cap (3 listed per root) limits the result (found ${cnt.length})`);
    const near = skeleton(path.join(tmp, 'proj', 'site')); const inner = path.join(near, 'wp-content', 'plugins');
    const fn = finder.findSites({ cwd: inner, home: tmp, roots: [web] });
    ok(fn[0].path === near && fn[0].group === 'near' && fn.slice(1).every(s => s.group === 'common'), 'a site above the current folder comes first, before the common roots');
    ok(finder.defaultRoots('/h').includes('/var/www') && finder.defaultRoots('/h').includes('/h/Local Sites') && finder.defaultRoots('/h').includes('/opt/lampp/htdocs') && finder.defaultRoots('/h').includes('/Applications/MAMP/htdocs'), 'the common web roots are the ones agreed');

    group('log-finder');
    const ls = skeleton(path.join(tmp, 'logsite')); fs.mkdirSync(path.join(ls, 'wp-content', 'custom'));
    for (const rel of ['wp-content/debug.log', 'error_log', 'wp-content/error_log', 'wp-content/custom/dbg.log']) w(ls, rel, 'x\n');
    const cfg = `<?php\ndefine( 'WP_DEBUG_LOG', '${ls}/wp-content/custom/dbg.log' );\n`;
    ok(logFinder.findLogs(ls, '').map(l => l.rel).join() === 'wp-content/debug.log,error_log,wp-content/error_log', 'each candidate is found in the agreed order');
    const lc = logFinder.findLogs(ls, cfg);
    ok(lc[0].rel === 'wp-content/custom/dbg.log' && lc.length === 4 && lc[0].bytes === 2 && typeof lc[0].mtime === 'string', 'a literal WP_DEBUG_LOG path inside the site comes first (path, rel, bytes, mtime)');
    const outside = path.join(tmp, 'elsewhere.log'); fs.writeFileSync(outside, 'x');
    ok(!logFinder.findLogs(ls, `<?php define('WP_DEBUG_LOG', '${outside}');`).some(l => l.path === outside), 'a WP_DEBUG_LOG path outside the site is rejected');
    ok(logFinder.findLogs(ls, "<?php\n// define('WP_DEBUG_LOG', '" + ls + "/wp-content/custom/dbg.log');\n").length === 3, 'a commented-out define is ignored');
    ok(logFinder.findLogs(ls, "<?php define('WP_DEBUG_LOG', true);").length === 3, 'WP_DEBUG_LOG true adds no extra path');
    const ls2 = skeleton(path.join(tmp, 'logsite2')); fs.symlinkSync(outside, path.join(ls2, 'wp-content', 'debug.log')); fs.symlinkSync(outside, path.join(ls2, 'error_log'));
    ok(logFinder.findLogs(ls2, '').length === 0, 'a symlinked log (even to a real file) is rejected; none found gives an empty list');
    const ls3 = skeleton(path.join(tmp, 'logsite3')); fs.mkdirSync(path.join(ls3, 'wp-content', 'debug.log'));
    ok(logFinder.findLogs(ls3, '').length === 0, 'a folder called debug.log is not a log');
    ok(!/\/var\/log/.test(fs.readFileSync(path.join(PG, 'lib', 'log-finder.js'), 'utf8')), 'log-finder.js never mentions /var/log (system logs are not read)');

    group('env-guess');
    const g = u => envGuess({ url: u }).kind;
    ok(['http://localhost:8080/', 'http://192.168.1.5/', 'https://shop.test/'].every(u => g(u) === 'local'), 'localhost, 192.168.x and .test are local');
    ok(g('https://staging.example.com/') === 'staging' && g('https://dev.example.com/') === 'staging' && g('https://shop-stg.example.com/') === 'staging', 'staging., dev. and -stg words are staging');
    ok(g('https://shop.example.com/') === 'live' && g('https://latest.example.com/') === 'live', 'a public name without a test word is live (no match inside a longer word)');
    ok(envGuess({}).kind === 'local' && envGuess({ url: '' }).kind === 'local', 'no address is local');

    group('wizard flow: the folder');
    const one = path.join(tmp, 'one-root'); const oneSite = makeSite(path.join(one, 'blog'));
    const r1 = await wiz(['Pages break', '', '', ''], { out: path.join(tmp, 'o1') }, { siteRoots: [one] });
    ok(!r1.error && new RegExp(`I found this WordPress site: ${oneSite.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\. Use it\\? \\[Y/n\\]`).test(r1.text) && /VERDICT/.test(r1.text), 'one site found: it is offered with [Y/n]; Enter accepts it');
    const r1n = await wiz(['Pages break', '', '', 'n', oneSite], { out: path.join(tmp, 'o1n') }, { siteRoots: [one] });
    ok(!r1n.error && /Type the folder of the WordPress site/.test(r1n.text) && /VERDICT/.test(r1n.text), '"n" to the offered site asks for a path');
    const sev = path.join(tmp, 'sev-root'); const sA = makeSite(path.join(sev, 'a-site')); makeSite(path.join(sev, 'b-site'));
    const r2 = await wiz(['Pages break', '', '', '7', '0', '2'], { out: path.join(tmp, 'o2') }, { siteRoots: [sev] });
    ok(!r2.error && /1\) .*a-site/.test(r2.text) && /2\) .*b-site/.test(r2.text) && /Type the number, or type a path:/.test(r2.text), 'several sites: a numbered list and "Type the number, or type a path"');
    ok((r2.text.match(/There is no number/g) || []).length === 2 && /Using .*b-site/.test(r2.text), 'a bad number is explained and asked again; a good number picks that site');
    const r2p = await wiz(['Pages break', '', '', path.join(tmp, 'nope'), sA], { out: path.join(tmp, 'o2p') }, { siteRoots: [sev] });
    ok(!r2p.error && /nope does not exist/.test(r2p.text) && /Using .*a-site/.test(r2p.text), 'a typed path that does not exist is explained and asked again');
    const empty = path.join(tmp, 'empty-root'); fs.mkdirSync(empty);
    const r3 = await wiz(['Pages break', '', '', tmp, oneSite], { out: path.join(tmp, 'o3') }, { siteRoots: [empty] });
    ok(!r3.error && /I did not find a WordPress site/.test(r3.text) && /is not a WordPress folder/.test(r3.text) && /VERDICT/.test(r3.text), 'none found: it says so and asks for a path (a bad one is asked again)');
    ok(!/\d\/7/.test(r1.text + r2.text + r3.text), 'no "n/7" counters anywhere');
    const r4 = await wiz(['Pages break', '', ''], { out: path.join(tmp, 'o4'), root: oneSite });
    ok(!r4.error && !/I found this|Type the number|Type the folder/.test(r4.text), '--root: no folder question is asked');

    group('wizard flow: log and PHP are not asked; the log line');
    ok(!/Log file \(for example|Use it \(a redacted copy/.test(r1.text) && !/PHP version/.test(r1.text + r2.text + r3.text), 'no log question and no PHP question appear');
    ok(/Log used: wp-content\/debug\.log \(1 KB, last written \d{1,2} [A-Z][a-z]{2} \d{4}\)\./.test(r1.text), 'the log line names the file, size and date');
    const id1 = issuesOf(path.join(tmp, 'o1'))[0];
    ok(id1 && fs.existsSync(path.join(tmp, 'o1', id1, 'site-copy', 'wp-content', 'debug.log')), 'the found log is used (redacted copy in the site copy)');
    const nolog = makeSite(path.join(tmp, 'nolog-root', 'x'), { log: false });
    const r5 = await wiz(['Pages break', '', '', ''], { out: path.join(tmp, 'o5') }, { siteRoots: [path.join(tmp, 'nolog-root')] });
    ok(!r5.error && /No log was found in your site\. Turning on WP_DEBUG_LOG in wp-config\.php would let this tool see the error next time\./.test(r5.text), 'no log: the plain message is shown');
    const multi = makeSite(path.join(tmp, 'multi-root', 'm'));
    w(multi, 'wp-content/custom/dbg.log', 'LITERAL-MARK\n'); w(multi, 'error_log', 'ERRLOG-MARK\n');
    w(multi, 'wp-config.php', `<?php\ndefine( 'WP_DEBUG_LOG', '${multi}/wp-content/custom/dbg.log' );\n`);
    const r6 = await wiz(['Pages break', '', '', ''], { out: path.join(tmp, 'o6') }, { siteRoots: [path.join(tmp, 'multi-root')] });
    const id6 = issuesOf(path.join(tmp, 'o6'))[0], c6 = path.join(tmp, 'o6', id6 || 'none', 'site-copy');
    ok(/Log used: wp-content\/custom\/dbg\.log/.test(r6.text) && /Also used: error_log/.test(r6.text) && /LITERAL-MARK/.test(fs.readFileSync(path.join(c6, 'wp-content', 'debug.log'), 'utf8')) && /ERRLOG-MARK/.test(fs.readFileSync(path.join(c6, 'error_log'), 'utf8')), 'several logs: the first lands as wp-content/debug.log, the others at their own path');
    const mine = path.join(tmp, 'mine.log'); fs.writeFileSync(mine, 'MINE-MARK\n');
    const r7 = await wiz(['Pages break', '', '', ''], { out: path.join(tmp, 'o7'), log: mine }, { siteRoots: [one] });
    const id7 = issuesOf(path.join(tmp, 'o7'))[0];
    ok(!r7.error && !/Log used: wp-content/.test(r7.text) && id7 && /MINE-MARK/.test(fs.readFileSync(path.join(tmp, 'o7', id7, 'site-copy', 'wp-content', 'debug.log'), 'utf8')), '--log overrides the discovery');
    const r8 = await wiz(['Pages break', '', ''], { out: path.join(tmp, 'o8'), root: oneSite, php: '8.2' });
    const id8 = issuesOf(path.join(tmp, 'o8'))[0];
    ok(!r8.error && id8 && jl(path.join(tmp, 'o8'), id8).php_version === '8.2', '--php still works and asks nothing');

    group('wizard flow: the site kind in one line');
    const k = async (url, ans, extra = {}) => wiz(['Pages break', '', url, oneSite, ...ans], { out: path.join(tmp, 'ok' + Math.random().toString(36).slice(2, 7)), ...extra });
    const kl = await k('https://shop.example.net/', ['', 'shop.example.net']);
    ok(/This looks like a LIVE site \(shop\.example\.net\)\. Is that right\? \[Y\/n\]/.test(kl.text) && !/Is it 1\) local/.test(kl.text), 'live guess: one plain line');
    const ks = await k('https://staging.example.net/', ['']);
    ok(!ks.error && /This looks like a STAGING site \(staging\.example\.net\)\. Is that right\? \[Y\/n\]/.test(ks.text), 'staging guess line');
    const kc = await k('http://localhost:8080/', ['y']);
    ok(!kc.error && /This looks like a LOCAL site \(localhost\)\. Is that right\? \[Y\/n\]/.test(kc.text), 'local guess line');
    const kn = await k('https://shop.example.net/', ['n', '2']);
    ok(!kn.error && /Is it 1\) local \(on this computer\), 2\) staging \(a test copy online\) or 3\) live \(the real, public site\)\?/.test(kn.text), '"n" asks the three-way question and accepts a number');
    const kn2 = await k('https://shop.example.net/', ['n', 'bogus', 'staging']);
    ok(!kn2.error && /Please type 1, 2 or 3/.test(kn2.text) && /VERDICT/.test(kn2.text), 'the three-way question also accepts the word and asks again on nonsense');
    const kenv = await k('https://shop.example.net/', [], { env: 'staging' });
    ok(!kenv.error && !/Is that right|Is it 1\)/.test(kenv.text), '--env wins and asks nothing');
    const knone = await wiz(['Pages break', '', '', oneSite].slice(0, 2).concat(['', '']), { out: path.join(tmp, 'o9') }, { siteRoots: [one] });
    ok(!knone.error && !/Is that right|Is it 1\)/.test(knone.text), 'no address: the kind is not asked (nothing is visited)');
    const outL = path.join(tmp, 'oL');
    const wrong = await k('https://shop.example.net/', ['', 'wrong.example.org'], { out: outL });
    ok(wrong.error && wrong.error.exitCode === 3 && /was NOT visited/.test(wrong.error.message) && issuesOf(outL).length === 0, 'live: a wrong typed domain exits 3 and creates nothing');
    const right = await k('https://shop.example.net/', ['', 'SHOP.example.net'], { out: outL });
    const rid = issuesOf(outL)[0];
    ok(!right.error && /type the site's domain exactly \(shop\.example\.net\)/.test(right.text) && rid && jl(outL, rid).authorized_live === true, 'live: the typed domain is still required, and then authorises');
    const noTty = spawnSync(process.execPath, [BIN, '--description', 'x', '--root', oneSite, '--url', 'https://shop.example.net/', '--env', 'live', '--no-probe', '--out', path.join(tmp, 'oN')], { input: '', encoding: 'utf8', cwd: tmp, env: { ...process.env, PLUGIN_GUARD_ISSUES: '' } });
    ok(noTty.status === 3 && /not visited unless you pass --authorized/.test(noTty.stderr), 'no terminal and no --authorized: exit 3');
    const noEnv = spawnSync(process.execPath, [BIN, '--description', 'x', '--root', oneSite, '--url', 'https://shop.example.net/', '--no-probe', '--out', path.join(tmp, 'oN2')], { input: '', encoding: 'utf8', cwd: tmp, env: { ...process.env, PLUGIN_GUARD_ISSUES: '' } });
    ok(noEnv.status === 2 && /--env local \| staging \| live/.test(noEnv.stderr), 'no terminal, an address and no --env: still exit 2 (never guessed)');

    group('the site folder is never written to');
    const fsite = makeSite(path.join(tmp, 'fp-root', 'f'));
    const before = fingerprint(fsite);
    const rf = await wiz(['Pages break', '', '', ''], { out: path.join(tmp, 'oF') }, { siteRoots: [path.join(tmp, 'fp-root')] }).then(async x => { await wiz(['Pages break', '', 'https://staging.example.net/', fsite, ''], { out: path.join(tmp, 'oF2') }); return x; });
    if (rf.error) console.log(rf.error.message);
    ok(!rf.error && fingerprint(fsite) === before, 'the site folder is byte-identical before and after, with the finder, the log copy and the kind question');

    // ---- S2: the no-files branch of the wizard (type none), the log question and the honest summary before go. Fake values only. ----
    const HINT = 'If you have no site files and only the website address, type none.';
    const STATEMENT = 'Without the site folder the tool cannot read your code or test on a copy. It can only use what you give it: the description, screenshots, a log and the public page.';
    const LOGQ = 'Do you have an error log file (for example debug.log)? Type its path, or press Enter to skip';
    const TAIL4 = 'I will not change anything on your site. I have no code and no database, so I cannot test on a copy and no cause can be confirmed: at most I can say what looks possible. Go on? [Y/n]';
    const STOPPED = 'Stopped. Nothing was saved, and no request was sent to the website.';
    const countOf = (t, needle) => t.split(needle).length - 1;
    const s2logs = path.join(tmp, 's2logs'); fs.mkdirSync(s2logs, { recursive: true });
    const s2log = path.join(s2logs, 'debug.log'); fs.writeFileSync(s2log, '[19-Nov-2026 10:00:01 UTC] PHP Fatal error:  Uncaught Error: Call to undefined function acme_missing() in /srv/example/wp-content/plugins/acme-slider/acme.php:12\n');
    const s2sql = path.join(s2logs, 'dump.sql'); fs.writeFileSync(s2sql, 'DB_PASSWORD=FAKEmarker0003\n');
    const s2shots = [path.join(s2logs, 'a.png'), path.join(s2logs, 'b.png')]; for (const f of s2shots) fs.writeFileSync(f, 'x');
    const idsIn = d => issuesOf(d);

    group('S2 (a) none at the found list, at the typed prompt and after "n": a no-files run');
    const oA = path.join(tmp, 'oS2a');
    const na = await wiz(['Pages break', '', '', 'none', '', ''], { out: oA }, { siteRoots: [sev] });
    ok(!na.error && na.text.includes(STATEMENT) && !/Using /.test(na.text) && /NOT TESTED ON A COPY/.test(na.text), `none at the found list: the statement, no site, a level-2 report (${na.error ? na.error.message : 'ok'})`);
    const iaId = idsIn(oA)[0], iaJson = iaId ? jl(oA, iaId) : {};
    ok(idsIn(oA).length === 1 && !iaJson.root && !fs.existsSync(path.join(oA, iaId || 'x', 'site-copy')), 'one issue was made, with no site folder and no site copy');
    const nb = await wiz(['Pages break', '', '', 'None', '', ''], { out: path.join(tmp, 'oS2b') }, { siteRoots: [sev] });
    const nc = await wiz(['Pages break', '', '', '  none  ', '', ''], { out: path.join(tmp, 'oS2c') }, { siteRoots: [sev] });
    ok(!nb.error && nb.text.includes(STATEMENT) && !nc.error && nc.text.includes(STATEMENT), '"None" and "  none  " work (case and spaces do not matter)');
    const nd = await wiz(['Pages break', '', '', 'n', 'none', '', ''], { out: path.join(tmp, 'oS2d') }, { siteRoots: [one] });
    ok(!nd.error && nd.text.includes(STATEMENT) && !/Using /.test(nd.text), 'one site found, "n", then none at the typed prompt');
    const ne = await wiz(['Pages break', '', '', 'none', '', ''], { out: path.join(tmp, 'oS2e') }, { siteRoots: [one] });
    ok(!ne.error && ne.text.includes(STATEMENT), 'one site found: none typed straight at the "Use it?" question works too');
    const nf = await wiz(['Pages break', '', '', 'none', '', ''], { out: path.join(tmp, 'oS2f') }, { siteRoots: [empty] });
    ok(!nf.error && nf.text.includes(STATEMENT), 'no site found on this computer: none at the typed prompt works');
    // a REAL folder that is called none is typed with a slash: ./none is a path, not the word
    const realNone = skeleton(path.join(work, 'none')); makeSite(realNone);
    const ng = await wiz(['Pages break', '', '', './none'], { out: path.join(tmp, 'oS2g') }, { siteRoots: [sev] });
    ok(!ng.error && /Using .*[\\/]none \(read-only/.test(ng.text) && !ng.text.includes(STATEMENT), './none is a normal path: the folder named none is used and the no-files branch is not taken');
    fs.rmSync(realNone, { recursive: true, force: true });
    const nh = await wiz(['Pages break', '', '', './none', 'none', '', ''], { out: path.join(tmp, 'oS2h') }, { siteRoots: [sev] });
    ok(!nh.error && /none does not exist/.test(nh.text) && nh.text.includes(STATEMENT), 'without such a folder ./none is explained as a path ("does not exist") and the question is asked again');

    group('S2 (b) the hint is visible: in the prompt, in the list and after an empty answer');
    ok(na.text.includes(`${HINT}\nType the number, or type a path: `) && /\n  none\) I have no site files, only the website address\n/.test(na.text), 'the list prompt says the hint right above "Type the number, or type a path:", and the list ends with "none) ..."');
    const nz = await wiz(['Pages break', '', '', '', 'none', '', ''], { out: path.join(tmp, 'oS2z') }, { siteRoots: [sev] });
    ok(nz.text.includes(`This one is needed: the code of the site is what gets analysed. ${HINT}`), 'an empty answer at the list: "This one is needed" plus the hint');
    ok(nd.text.includes(`${HINT}\nType the folder of the WordPress site (the wp-content folder, or the folder that contains it): `), 'the typed prompt says the hint right above "Type the folder of the WordPress site ..."');
    const ny = await wiz(['Pages break', '', '', '', 'none', '', ''], { out: path.join(tmp, 'oS2y') }, { siteRoots: [empty] });
    ok(ny.text.includes(`This one is needed: the code of the site is what gets analysed. ${HINT}`), 'an empty answer at the typed prompt: "This one is needed" plus the hint');

    group('S2 (c) the log question: used like --log, the S1d refusals, Enter skips, an ended input skips');
    const oL = path.join(tmp, 'oS2L');
    const lcq = await wiz(['Pages break', '', '', 'none', s2log, ''], { out: oL }, { siteRoots: [sev] });
    ok(!lcq.error && lcq.text.includes(LOGQ) && lcq.text.includes(`Log used: ${s2log} (you gave it).`) && /Looked at: your log\./.test(lcq.text) && /The log shows a possible cause/.test(lcq.text), 'a valid path is used: "Log used ... (you gave it)", "Looked at: your log", the S1d possible-cause verdict');
    ok(fs.existsSync(path.join(oL, idsIn(oL)[0] || 'x', 'log-only', 'wp-content', 'debug.log')), 'the masked copy is under <issue>/log-only/ (the S1d path, not a second one)');
    ok(countOf(na.text, LOGQ) === 1, 'Enter at the log question skips it (and it is asked once)');
    const lrq = await wiz(['Pages break', '', '', 'none', s2sql, '', ''], { out: path.join(tmp, 'oS2R') }, { siteRoots: [sev] });
    ok(!lrq.error && countOf(lrq.text, LOGQ) === 2 && /The file dump\.sql is not read: a database export, an environment file or wp-config is not a log\. Give an error log, for example debug\.log\./.test(lrq.text) && !/FAKEmarker0003/.test(lrq.text), 'a .sql name is refused with the S1d message (no file content) and the question is asked again');
    const lmq = await wiz(['Pages break', '', '', 'none', path.join(s2logs, 'missing.log'), '', ''], { out: path.join(tmp, 'oS2M') }, { siteRoots: [sev] });
    ok(!lmq.error && /The log file .*missing\.log does not exist or is not a file\./.test(lmq.text) && countOf(lmq.text, LOGQ) === 2, 'a missing file is explained and the question is asked again');
    const oE = path.join(tmp, 'oS2E');
    const leq = await wiz(['Pages break', '', '', 'none'], { out: oE }, { siteRoots: [sev] });
    ok(countOf(leq.text, LOGQ) === 1 && !/Log used/.test(leq.text) && leq.error && /input ended before all questions/.test(leq.error.message) && idsIn(oE).length === 0 && !fs.existsSync(oE), 'when the scripted input ends at the log question it counts as skip; the next question ends the run and nothing was made');

    group('S2 (d) phase 4: the summary is built from the data; Y and Enter go on; n stops, with nothing made and no request sent');
    let hits = 0; const srv = require('http').createServer((q, r) => { hits++; r.writeHead(200); r.end('x'); });
    await new Promise(r => srv.listen(0, '127.0.0.1', r)); const addr = `http://127.0.0.1:${srv.address().port}/`;
    const p4 = async (flags, answers, tag) => wiz(answers, { out: path.join(tmp, `oP4${tag}`), env: 'local', 'no-probe': false, ...flags }, { siteRoots: [sev] });
    const hostTxt = '127.0.0.1';
    const headTxt = `load the page of ${hostTxt} a few times (GET requests only, nothing is clicked or submitted), and `;
    const A1 = await p4({ url: addr }, ['Pages break', '', 'none', '', 'n'], 'A1');
    ok(A1.text.includes(`I will ${headTxt}read your description. ${TAIL4}`), 'address only: "I will load the page of <host> a few times (GET requests only, ...), and read your description. I will not change ..."');
    const A2 = await p4({ url: addr, images: s2shots.join(',') }, ['Pages break', 'none', '', 'n'], 'A2');
    ok(A2.text.includes(`I will ${headTxt}read your description and your 2 screenshots. ${TAIL4}`), 'address and 2 screenshots: "... and read your description and your 2 screenshots."');
    const A3 = await p4({}, ['Pages break', '', '', 'none', s2log, 'n'], 'A3');
    ok(A3.text.includes(`I will read your description and your log. ${TAIL4}`), 'log only: no address part, "... read your description and your log."');
    const A4 = await p4({ url: addr, images: s2shots.join(',') }, ['Pages break', 'none', s2log, 'n'], 'A4');
    ok(A4.text.includes(`I will ${headTxt}read your description, your 2 screenshots and your log. ${TAIL4}`), 'all three: "... and read your description, your 2 screenshots and your log."');
    ok([A1, A2, A3, A4].every((x, i) => x.text.includes(STOPPED) && x.code === 0 && !x.error && !fs.existsSync(path.join(tmp, `oP4${['A1', 'A2', 'A3', 'A4'][i]}`))), `"n" says "${STOPPED}", ends with exit code 0 and made no issue folder and no reports folder`);
    ok(hits === 0, `no request reached the address while "n" was answered (the address was hit ${hits} times)`);
    const Y1 = await p4({ 'no-probe': true }, ['Pages break', '', '', 'none', '', 'Y'], 'Y1');
    const Y2 = await p4({ 'no-probe': true }, ['Pages break', '', '', 'none', '', ''], 'Y2');
    ok(!Y1.error && !Y2.error && Y1.text.includes('NOT TESTED ON A COPY') && Y2.text.includes('NOT TESTED ON A COPY') && !Y2.text.includes('load the page'), '"Y" and Enter go on (and with --no-probe the summary does not promise a page load)');
    const Yx = await wiz(['Pages break', '', '', 'none', '', 'maybe', 'n'], { out: path.join(tmp, 'oP4X') }, { siteRoots: [sev] });
    ok(countOf(Yx.text, 'Go on? [Y/n]') === 2 && /Please type Y or n\./.test(Yx.text) && Yx.text.includes(STOPPED), 'an answer that is neither y nor n is asked again');
    const F1 = await wiz(['Pages break', '', '', '', ''], { out: path.join(tmp, 'oP4F'), 'no-files': true }, {});
    ok(!F1.error && /No site folder was given \(--no-files\)/.test(F1.text) && countOf(F1.text, LOGQ) === 1 && /Go on\? \[Y\/n\]/.test(F1.text), 'an interactive run with the --no-files flag gets the log question and the summary too');
    srv.close();

    group('S2 (e) nothing is asked with --yes, with --log on the command line, or without a terminal');
    const Q1 = await wiz([], { out: path.join(tmp, 'oQ1'), 'no-files': true, yes: true, description: 'Pages break', images: '' }, {});
    ok(!Q1.error && !Q1.text.includes(LOGQ) && !Q1.text.includes('Go on? [Y/n]') && /NOT TESTED ON A COPY/.test(Q1.text), '--yes: neither the log question nor the summary is asked');
    const Q2 = await wiz(['Pages break', '', '', 'none', ''], { out: path.join(tmp, 'oQ2'), log: s2log }, { siteRoots: [sev] });
    ok(!Q2.error && !Q2.text.includes(LOGQ) && /Go on\? \[Y\/n\]/.test(Q2.text) && /read your description and your log\./.test(Q2.text) && /Log used: .*\(given with --log\)\./.test(Q2.text), '--log on the command line: the log question is not asked, the log is used (given with --log), the summary says your log');
    const Q3 = await wiz([], { out: path.join(tmp, 'oQ3'), 'no-files': true, description: 'Pages break', images: '', url: '' }, { tty: false });
    ok(!Q3.error && !Q3.text.includes(LOGQ) && !Q3.text.includes('Go on? [Y/n]'), 'without a terminal: nothing is asked');
    const Q4 = await wiz([], { out: path.join(tmp, 'oQ4'), yes: true, description: 'Pages break', images: '' }, { siteRoots: [sev] });
    ok(Q4.error && /Missing required value: the site folder\. Pass --root <wp-content folder or WordPress root>\./.test(Q4.error.message), '--yes without a folder and without --no-files: the old refusal, unchanged');

    group('S2 (f) --sandbox or --db-dump plus none is refused');
    const R1 = await wiz(['Pages break', '', '', 'none'], { out: path.join(tmp, 'oR1'), sandbox: true }, { siteRoots: [sev] });
    const R2 = await wiz(['Pages break', '', '', 'none'], { out: path.join(tmp, 'oR2'), 'db-dump': path.join(s2logs, 'x.sql') }, { siteRoots: [sev] });
    ok(R1.error && R1.error.exitCode === 2 && /--sandbox and --db-dump need the site files, so they cannot be used when you type none\./.test(R1.error.message) && R2.error && R2.error.exitCode === 2 && /--sandbox and --db-dump need the site files/.test(R2.error.message), '--sandbox and --db-dump with none: refused with a plain message (exit 2)');
    ok(idsIn(path.join(tmp, 'oR1')).length === 0 && idsIn(path.join(tmp, 'oR2')).length === 0, 'and no issue was made');

    fs.rmSync(tmp, { recursive: true, force: true });
    console.log(`\n${failures ? 'FAILED' : 'OK'}: ${failures} failure(s)`);
    process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
