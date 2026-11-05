#!/usr/bin/env node
// The wizard's folder browser (lib/folder-browser.js) and the PHP folder-name hint (lib/wizard.js).
// Offline; only a temp folder is touched; the web roots are injected so the real machine does not matter.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { PassThrough } = require('stream');

const PG = path.join(__dirname, '..');
const fb = require('../lib/folder-browser');
const intake = require('../lib/site-intake');
const finder = require('../lib/site-finder');
const wizard = require('../lib/wizard');
const store = require('../lib/issue-store');

let failures = 0;
const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`); if (!c) failures++; };
const group = t => console.log(`\n== ${t}`);
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pg-fbrowse-')));
const skeleton = d => { fs.mkdirSync(path.join(d, 'wp-content', 'plugins'), { recursive: true }); fs.mkdirSync(path.join(d, 'wp-content', 'themes'), { recursive: true }); return d; };
const w = (root, rel, body) => { const f = path.join(root, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, body); };
const head = n => `<?php\n/**\n * Plugin Name: ${n}\n * Version: 1.0.0\n */\n`;
function makeSite(root) {
    w(root, 'wp-content/plugins/plugin-a/plugin-a.php', head('Plugin a') + "function my_helper( $x ) {\n\treturn $x;\n}\n");
    fs.mkdirSync(path.join(root, 'wp-content/themes'), { recursive: true });
    w(root, 'wp-includes/version.php', "<?php\n$wp_version = '6.8.1';\n");
    w(root, 'wp-config.php', "<?php\ndefine( 'WP_DEBUG', true );\n$table_prefix = 'wp_';\n");
    return root;
}

// scripted io: answers in order; every said line and every asked prompt is kept
function script(answers) {
    const out = []; let i = 0;
    return { out, text: () => out.join('\n'), io: { say: t => out.push(t), ask: async q => { out.push(`${q}:`); if (i >= answers.length) throw new Error('INPUT ENDED'); return answers[i++]; } } };
}
async function drive(opts, answers) {
    const s = script(answers); let site = null, err = null;
    try { site = await fb.browse({ cwd: path.join(tmp, 'cwd-none'), io: s.io, abs: p => path.resolve(tmp, p), ...opts }); } catch (e) { err = e; }
    return { site, err, text: s.text(), used: answers.length };
}

(async () => {
    fs.mkdirSync(path.join(tmp, 'cwd-none'), { recursive: true });

    group('PHP hint from folder names');
    const hint = n => fb.phpHint(`/srv/${n}/blog`);
    const forms = { '74': '7.4', '80': '8.0', '81': '8.1', '82': '8.2', '83': '8.3', '84': '8.4', '8.3': '8.3', '7.4': '7.4', 'php83': '8.3', 'php8.3': '8.3', 'PHP74': '7.4', 'php-8.2': '8.2', 'php_81': '8.1' };
    for (const [n, v] of Object.entries(forms)) ok(hint(n) === v, `"${n}" is recognised as PHP ${v}`);
    for (const n of ['iAfrica', '2024', '85', '8.5', '75', 'php', 'site83', 'html', 'wp-83x', '183']) ok(hint(n) === null, `"${n}" is not a PHP version`);
    ok(fb.phpHint('/srv/php74/sites/php83/blog') === '8.3', 'the part closest to the site wins');
    ok(fb.phpHint('') === null && fb.phpHint(null) === null, 'an empty path gives no hint');

    group('site intake: a folder of sites is not a site (the /var/www/html case)');
    const html = path.join(tmp, 'html'); makeSite(path.join(html, 'blog')); makeSite(path.join(html, 'shop'));
    const rh = intake.resolveSite(html);
    ok(rh.error && /is not a WordPress folder/.test(rh.error), `resolveSite refuses a folder that only holds site folders: ${rh.error}`);
    const odd = path.join(tmp, 'odd'); fs.mkdirSync(path.join(odd, 'wp-content'), { recursive: true });
    ok(/no "plugins" and "themes"/.test(intake.resolveSite(odd).error || ''), 'a wp-content without plugins and themes is refused with the existing message');

    group('more than 9 sites: "9 of 21 shown", m shows the rest');
    const big = path.join(tmp, 'big'); for (let i = 1; i <= 21; i++) makeSite(path.join(big, `site-${String(i).padStart(2, '0')}`));
    const b1 = await drive({ roots: [big] }, ['m', 'm', '3']);
    ok(/9 of 21 shown/.test(b1.text) && /type m for the next 9/.test(b1.text), 'the first screen says "9 of 21 shown" and offers m');
    ok(/1\) site-01/.test(b1.text) && !/10\) /.test(b1.text), 'at most 9 entries are numbered');
    ok(/21 of 21 shown/.test(b1.text) && /18 of 21 shown/.test(b1.text) && /1\) .*site-19/.test(b1.text) && /3\) .*site-21/.test(b1.text), 'm, m reveals the last three');
    ok(b1.site && b1.site.root === path.join(big, 'site-21') && !b1.err, 'a number on the third screen picks that site');
    ok(/Opening .*big/.test(b1.text), 'a single root is opened by itself');
    const b1b = await drive({ roots: [big] }, ['m', 'm', 'm', '1']);
    ok(b1b.site && b1b.site.root === path.join(big, 'site-01'), 'm after the last screen starts again');

    group('several roots: the first screen is built from the roots, with counts');
    const rA = path.join(tmp, 'rootA'), rB = path.join(tmp, 'rootB'), rC = path.join(tmp, 'rootC'), rMissing = path.join(tmp, 'nope-root');
    for (let i = 1; i <= 6; i++) makeSite(path.join(rA, `a${i}`));
    for (let i = 1; i <= 5; i++) makeSite(path.join(rB, `b${i}`));
    makeSite(path.join(rC, 'only'));
    const list = finder.findSites({ cwd: path.join(tmp, 'cwd-none'), home: tmp, roots: [rA, rB, rC, rMissing] });
    ok(list.length === 12, `the finder sees all 12 sites (${list.length})`);
    const b2 = await drive({ list, roots: [rA, rB, rC, rMissing] }, ['2', '3']);
    ok(/3 of 3 shown/.test(b2.text) && /1\) .*rootA {2}\(6 WordPress sites\)/.test(b2.text) && /3\) .*rootC {2}\(1 WordPress site\)/.test(b2.text) && !/nope-root/.test(b2.text), 'roots that exist are listed with their site counts; a missing root is not');
    ok(/5 of 5 shown/.test(b2.text) && b2.site && b2.site.root === path.join(rB, 'b3'), 'choosing a root descends; a site number picks the site');
    const b2b = await drive({ list, roots: [rA, rB, rC] }, ['2', 'b', '3', '1']);
    ok(/type b to go back/.test(b2b.text) && b2b.site && b2b.site.root === path.join(rC, 'only'), 'b goes back one level');

    group('"at least N" when the scan is capped');
    const cap = path.join(tmp, 'cap'); for (let i = 1; i <= 8; i++) makeSite(path.join(cap, `c${i}`));
    const capB = path.join(tmp, 'capB'); makeSite(path.join(capB, 'x'));
    const b3 = await drive({ roots: [cap, capB], maxDirs: 4 }, ['2', '1']);
    ok(/at least 3 WordPress sites/.test(b3.text), `a capped scan is shown as "at least N" (${(b3.text.match(/\d\) .*WordPress sites?\)/g) || []).join(' | ')})`);
    ok(/2\) .*capB {2}\(1 WordPress site\)/.test(b3.text), 'an uncapped count has no "at least"');
    let t = 0;
    const b4 = await drive({ roots: [rA, rB], maxMs: 5, now: () => (t += 10) }, ['1']);
    ok(/at least/.test(b4.text), 'a timed-out scan is also "at least N"');

    group('typed paths');
    const b5 = await drive({ list, roots: [rA, rB, rC] }, [path.join(rB, 'b2')]);
    ok(b5.site && b5.site.root === path.join(rB, 'b2'), 'a typed path to a site is accepted on the first screen');
    const b5b = await drive({ list, roots: [rA, rB, rC] }, [path.join(rB, 'b4', 'wp-content')]);
    ok(b5b.site && b5b.site.root === path.join(rB, 'b4'), 'a typed wp-content folder is accepted (resolved to the site root)');
    const b6 = await drive({ list, roots: [rA, rB, rC] }, [html, path.join(tmp, 'does-not-exist'), odd, path.join(rA, 'a1')]);
    ok((b6.text.match(/is not a WordPress folder/g) || []).length === 1 && /does-not-exist does not exist/.test(b6.text) && /no "plugins" and "themes"/.test(b6.text), 'a folder with no wp-content (a /var/www/html-style folder of sites), a missing one and a half-site are refused with the plain messages');
    ok(b6.site && b6.site.root === path.join(rA, 'a1'), 'and the question is asked again until a real site is typed');
    const b6b = await drive({ list, roots: [rA, rB, rC] }, ['', '99', path.join(rC, 'only')]);
    ok(/This one is needed/.test(b6b.text) && /There is no number 99 in the list \(1 to 3\)/.test(b6b.text) && b6b.site, 'empty and out-of-range answers are explained');
    const b7 = await drive({ list, roots: [rA, rB, rC] }, ['1', html, path.join(rA, 'a2')]);
    ok(b7.site && b7.site.root === path.join(rA, 'a2') && /not a WordPress folder/.test(b7.text), 'typing works on a deeper screen too');
    const b8 = await drive({ list, roots: [rA, rB, rC] }, []);
    ok(b8.err && /INPUT ENDED/.test(b8.err.message), 'an ended input is passed on to the caller (it is never answered for the user)');

    group('symlinks and skipped folders are ignored');
    const sl = path.join(tmp, 'sl'); makeSite(path.join(sl, 'real1')); makeSite(path.join(sl, 'real2'));
    fs.symlinkSync(path.join(sl, 'real1'), path.join(sl, 'zlink'));
    makeSite(path.join(sl, 'node_modules', 'pkg')); makeSite(path.join(sl, '.hidden'));
    fs.symlinkSync(path.join(sl, 'real2'), path.join(tmp, 'linkroot'));
    const b9 = await drive({ roots: [sl] }, ['1']);
    ok(/real1/.test(b9.text) && /real2/.test(b9.text) && !/zlink|node_modules|\.hidden/.test(b9.text), 'a symlinked folder, node_modules and a dot-folder are not listed');
    const b9b = await drive({ roots: [path.join(tmp, 'linkroot'), sl] }, ['1']);
    ok(!/linkroot/.test(b9b.text), 'a symlinked root is ignored');

    group('static: the browser never reads file contents');
    const src = fs.readFileSync(path.join(PG, 'lib', 'folder-browser.js'), 'utf8').replace(/\/\/.*$/gm, '');
    ok(!/\b(readFile|readFileSync|openSync|readSync|createReadStream|readlinkSync|realpathSync|writeFile|writeFileSync|appendFile|mkdirSync|rmSync|unlinkSync|renameSync|copyFile|symlinkSync|chmodSync)\b/.test(src), 'no file is opened, read or written');
    ok(!/(?<!l)statSync/.test(src) && /lstatSync/.test(src) && /readdirSync/.test(src), 'only readdirSync and lstatSync are used');
    ok(!/require\('(child_process|http|https|net)'\)/.test(src), 'no process or network module');

    group('wizard: folder hint for PHP, and the report says "you confirmed"');
    const phpRoot = path.join(tmp, 'phproot'); const phpSite = makeSite(path.join(phpRoot, 'php83', 'blog'));
    const plainRoot = path.join(tmp, 'plainroot'); const plainSite = makeSite(path.join(plainRoot, 'iAfrica'));
    async function wiz(answers, flags, extra = {}) {
        const input = new PassThrough(), output = new PassThrough();
        let text = ''; output.on('data', d => { text += d; });
        input.end(answers.join('\n') + (answers.length ? '\n' : ''));
        const saved = process.env.PLUGIN_GUARD_ISSUES, log = console.log; let logged = ''; console.log = (...a) => { logged += a.join(' ') + '\n'; };
        let error = null, code = null;
        const work = path.join(tmp, 'work'); fs.mkdirSync(work, { recursive: true });
        try { code = await wizard.run({ _: [], 'no-probe': true, 'no-questions': true, ...flags }, { input, output, tty: true, cwd: work, env: { HOME: tmp }, preflight: () => ({ ok: false }), siteRoots: [], ...extra }); }
        catch (e) { error = e; } finally { console.log = log; if (saved === undefined) delete process.env.PLUGIN_GUARD_ISSUES; else process.env.PLUGIN_GUARD_ISSUES = saved; }
        return { text: text + logged, error, code };
    }
    const issuesOf = d => (fs.existsSync(d) ? fs.readdirSync(d).filter(x => store.ISSUE_RE.test(x)) : []);
    const readIssue = d => { const id = issuesOf(d)[0]; return { id, json: JSON.parse(fs.readFileSync(path.join(d, id, 'issue.json'), 'utf8')) }; };
    const allText = d => { const id = issuesOf(d)[0]; const res = path.join(d, id, 'result'); return fs.existsSync(res) ? fs.readdirSync(res).filter(f => /\.(md|json|html)$/.test(f)).map(f => fs.readFileSync(path.join(res, f), 'utf8')).join('\n') : ''; };

    const oY = path.join(tmp, 'oY');
    const hy = await wiz(['Pages break', '', '', '', 'Y'], { out: oY }, { siteRoots: [phpRoot] });
    ok(!hy.error && /This folder looks like PHP 8\.3\. Is that the version this site runs\? \[Y\/n\]:/.test(hy.text), 'the exact question is asked with the real version');
    const iy = readIssue(oY);
    ok(iy.json.php_version === '8.3' && iy.json.php_source === 'you confirmed', 'Y: the PHP version is set and its source is "you confirmed"');
    ok(/PHP 8\.3 \(you confirmed\)/.test(allText(oY) + hy.text) && !/PHP 8\.3 \(you told us\)/.test(allText(oY) + hy.text), 'the report reads "PHP 8.3 (you confirmed)"');
    const oN = path.join(tmp, 'oN');
    const hn = await wiz(['Pages break', '', '', '', 'n'], { out: oN }, { siteRoots: [phpRoot] });
    const inn = readIssue(oN);
    ok(!hn.error && inn.json.php_version === null && !inn.json.php_source, 'n: no PHP version is set (the later question may still ask)');
    const oE = path.join(tmp, 'oE');
    const he = await wiz(['Pages break', '', '', '', ''], { out: oE }, { siteRoots: [phpRoot] });
    ok(!he.error && readIssue(oE).json.php_version === '8.3', 'Enter means Y');
    const oP = path.join(tmp, 'oP');
    const hp = await wiz(['Pages break', '', ''], { out: oP, root: phpSite, php: '8.1' });
    ok(!hp.error && !/looks like PHP/.test(hp.text) && readIssue(oP).json.php_version === '8.1' && !readIssue(oP).json.php_source, '--php given: the hint is not asked, and the source is not "you confirmed"');
    const oM = path.join(tmp, 'oM');
    const hm = await wiz(['Pages break', '', '', ''], { out: oM }, { siteRoots: [plainRoot] });
    ok(!hm.error && !/looks like PHP/.test(hm.text) && readIssue(oM).json.php_version === null, 'a folder name without a version is not asked about');
    const oS = path.join(tmp, 'oS');
    const hs = await wiz([], { out: oS, root: phpSite, description: 'Pages break', yes: true, images: '' });
    ok(!hs.error && !/looks like PHP/.test(hs.text) && readIssue(oS).json.php_version === null, '--yes / --root without a terminal question: the hint is never asked and never sets PHP');
    const saved = path.join(tmp, 'oQ');
    const hq = await wiz(['Pages break', '', ''], { out: saved, root: phpSite, 'no-prompt': true });
    ok(!/looks like PHP/.test(hq.text), '--no-prompt: the hint is never asked');

    group('wizard: the browser inside the flow');
    const oB = path.join(tmp, 'oB');
    const hb = await wiz(['Pages break', '', '', 'm', '3'], { out: oB }, { siteRoots: [big] });
    ok(!hb.error && /9 of 21 shown/.test(hb.text) && /Using .*site-12/.test(hb.text), 'the wizard shows "9 of 21 shown", "m" reveals more, a number picks the site');
    const oH = path.join(tmp, 'oH');
    const hh = await wiz(['Pages break', '', '', html, path.join(html, 'blog')], { out: oH }, { siteRoots: [rA, rB] });
    ok(!hh.error && /is not a WordPress folder/.test(hh.text) && /Using .*blog/.test(hh.text), 'a typed folder that only holds site folders is refused in the wizard and asked again');

    fs.rmSync(tmp, { recursive: true, force: true });
    console.log(failures ? `\n${failures} FAILED` : '\nAll folder-browser checks passed.');
    process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
