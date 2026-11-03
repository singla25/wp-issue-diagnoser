#!/usr/bin/env node
// A log fatal "Class X not found" at a file of the site, re-checked in validate.js (issue/fatal-recheck.js):
//   Rule A  the cited line names X, the fatal repeats, it is within 24 h of the probe run, and the live page answered 5xx
//   Rule B  the same first three facts, and no PHP file of a COMPLETE copy defines X (copy skipped no PHP, every file readable)
// plus the deep log scan for a fatal that is not in the last 2 MB of a large log. Real case: Elementor\Core\Schemes\Color called from a theme file (ews).
// Offline; no network. Every rule is shown to FAIL when its evidence is missing.
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-fatal-'));
process.env.PLUGIN_GUARD_ISSUES = path.join(tmp, 'issues');
const store = require('../lib/issue-store');
const evidence = require('../issue/evidence'), analysis = require('../issue/analysis'), validate = require('../issue/validate'), resolve = require('../issue/resolve'), result = require('../issue/result');
const logsLib = require('../issue/logs'), intake = require('../lib/site-intake'), copy = require('../issue/sandbox-copy'), fr = require('../issue/fatal-recheck');

let failures = 0;
const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`); if (!c) failures++; };
const group = t => console.log(`\n== ${t}`);
const w = (root, rel, body = '<?php\n') => { const f = path.join(root, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, body); };
const CLASS = 'Elementor\\Core\\Schemes\\Color';
const THEME_FILE = 'wp-content/themes/unicamp/elementor/widgets/original/heading.php';

// opts: elementor: 'absent'|'present'|'defines' | 'no-version'; line: text of line 48; repeats; at: log time (UTC string); extra(root); cls
function build(root, o = {}) {
    const cls = o.cls || CLASS;
    w(root, 'wp-includes/version.php', "<?php\n$wp_version = '6.8.1';\n"); w(root, 'wp-config.php', '<?php\n');
    if (o.elementor !== 'absent') {
        w(root, 'wp-content/plugins/elementor/elementor.php', `<?php\n/**\n * Plugin Name: Elementor\n${o.elementor === 'no-version' ? '' : ' * Version: 3.35.7\n'} */\nnamespace Elementor;\nclass Plugin {}\n`);
        if (o.elementor === 'defines') w(root, 'wp-content/plugins/elementor/core/schemes/color.php', '<?php\nnamespace Elementor\\Core\\Schemes;\nclass Color {}\n');
    }
    w(root, 'wp-content/themes/unicamp/style.css', '/*\nTheme Name: Unicamp\nVersion: 1.0\n*/');
    const file = o.file || THEME_FILE;
    if (file !== 'missing') w(root, file, '<?php\n' + '// filler\n'.repeat(46) + (o.line || `$c = \\${cls}::get_type();`) + '\n');
    const at = o.at || '16-Mar-2026 13:11:38', one = t => `[${t} UTC] PHP Fatal error:  Uncaught Error: Class "${cls}" not found in ${root}/${o.file && o.file !== 'missing' ? o.file : THEME_FILE}:48\nStack trace:\n#0 {main}\n  thrown in ${root}/${o.file && o.file !== 'missing' ? o.file : THEME_FILE} on line 48\n`;
    w(root, 'wp-content/debug.log', one(at) + (o.repeats === 1 ? '' : one(at.replace(/:\d\d$/, ':59'))));
    if (o.extra) o.extra(root);
    return cls;
}

// the stages of `issue investigate --gate`; prep(dir, issue) may write work files (probe.json, intake.json, sandbox.json) before validation
async function run(name, o = {}, prep = null) {
    const root = path.join(tmp, name, 'wp'); build(root, o);
    const config = path.join(root, 'plugin-guard.config.json'); fs.writeFileSync(config, JSON.stringify({}));
    const issue = store.create({ title: 'Critical error', description: 'The site shows a critical error', symptom: 'white-screen', environment: 'local', url: 'http://127.0.0.1:9/', root, pages: ['/'] });
    await evidence.run(issue.id, { root, probeOptions: { probe: false } });
    analysis.run(issue.id, { root, config });
    const dir = store.dirOf(issue.id);
    if (prep) prep(dir, issue, root);
    const val = validate.run(issue.id, { root, config, lint: () => ({ ok: true, message: '' }) });
    const policy = validate.policyFor(root, config), plans = resolve.build(issue.id, val, { root, policy, dir });
    result.write(issue.id, { validation: val, plans, dir, root, policy, gate: true });
    const f = JSON.parse(fs.readFileSync(path.join(dir, 'result', 'findings.json'), 'utf8'));
    const h = val.hypotheses.find(x => x.type === 'missing-function');
    const fin = f.hypotheses.find(x => x.fatal_recheck) || f.hypotheses[0];
    return { f, h, fin, val, dir, root, issue, text: (h && h.fatal_recheck && h.fatal_recheck.text.lines.join(' ')) || '', md: fs.readFileSync(path.join(dir, 'result', 'ISSUE-REPORT.md'), 'utf8'), chk: id => ((h && h.checks) || []).find(c => c.id === `fatal:${id}`) };
}
const setRan = (dir, ranAt) => { const f = path.join(dir, 'issue.json'), j = JSON.parse(fs.readFileSync(f, 'utf8')); j.probe_ran_at = ranAt; fs.writeFileSync(f, JSON.stringify(j)); };
const probe5xx = (ranAt, status = 500) => (dir, issue) => { setRan(dir, ranAt); fs.writeFileSync(path.join(dir, 'work', 'probe.json'), JSON.stringify({ schema: 1, pages: [{ url: issue.url, status, viewport: { name: 'laptop' }, loaded: true }] })); };
const intakeJson = o => (dir) => fs.writeFileSync(path.join(dir, 'work', 'intake.json'), JSON.stringify(o));

(async () => {
    group('Rule B: nothing defines the class (the ews case: an old fatal, no probe)');
    const b = await run('b-base');
    ok(b.h.status === 'CONFIRMED' && b.h.fatal_recheck.rule === 'B' && b.h.fatal_recheck.supports.join() === 'fatal-site,class-undefined', 'the hypothesis is CONFIRMED by rule B with the two supports fatal-site + class-undefined');
    ok(b.h.fatal_recheck.provider.known && b.h.fatal_recheck.provider.slug === 'elementor' && b.h.fatal_recheck.provider.version === '3.35.7' && b.h.fatal_recheck.provider.installed, 'the provider is Elementor 3.35.7 (known, installed)');
    ok(/^the theme file wp-content\/themes\/unicamp\/.*heading\.php:48 calls the class Elementor\\Core\\Schemes\\Color, which Elementor 3\.35\.7 does not contain$/.test(b.fin.fatal_recheck.text.cause) || b.f.summary.text.includes('which Elementor 3.35.7 does not contain'), 'wording: "...calls the class Elementor\\Core\\Schemes\\Color, which Elementor 3.35.7 does not contain"');
    ok(b.text.includes('This usually means the theme was written for an older version of Elementor.') && !/used to|no longer|removed|previously/i.test(b.text), 'the "older version" sentence is there (version known) and never says the class used to exist');
    ok(b.text.includes('Seen in your log on 16 Mar 2026, not checked live.'), 'no probe: "seen in your log on 16 Mar 2026, not checked live"');
    ok(b.f.findings.length === 1 && b.f.findings[0].label === 'theme-plugin' && b.f.findings[0].status === 'CONFIRMED', 'the gate shows it as a finding, labelled theme-plugin');
    ok(b.f.summary.lines.some(l => /does not contain/.test(l)) && b.f.summary.lines.some(l => /older version of Elementor/.test(l)) && /does not contain/.test(b.md), 'the summary and the Markdown report carry the text');
    ok(b.f.verdict.label === 'Confirmed cause found in your logs', `verdict: ${b.f.verdict.label}`);

    group('Rule B fails without its evidence');
    const once = await run('b-once', { repeats: 1 });
    ok(once.h.status !== 'CONFIRMED' && once.chk('fatal-repeats').status === 'FAILED' && once.f.findings.length === 0, 'a fatal seen only once: not confirmed');
    const noMention = await run('b-nomention', { line: '$c = 1;' });
    ok(noMention.h.status !== 'CONFIRMED' && noMention.chk('fatal-line').status === 'FAILED', 'the cited line does not mention the class: not confirmed');
    const noFile = await run('b-nofile', { file: 'missing' });
    ok(noFile.h.status !== 'CONFIRMED' && /not in the copy/.test(noFile.chk('fatal-file').reason), 'the file named in the log is not in the copy: not confirmed, and it says so');
    const other = await run('b-other', { elementor: 'defines' });
    ok(other.h.status !== 'CONFIRMED' && other.chk('class-undefined').status === 'FAILED' && /defined in elementor/.test(other.text), 'the class is defined in another component: not confirmed ("is defined in elementor")');
    const skipped = await run('b-skipped', {}, intakeJson({ php_skipped: 1, php_skipped_examples: ['wp-content/plugins/x/.github/a.php'] }));
    ok(skipped.h.status !== 'CONFIRMED' && /could not check all code/.test(skipped.chk('class-undefined').reason) && /Could not check all code/.test(skipped.text), 'the copy skipped a PHP file: "could not check all code", stays PROBABLE');
    const noSkip = await run('b-noskip', {}, intakeJson({ php_skipped: 0, php_skipped_examples: [] }));
    ok(noSkip.h.status === 'CONFIRMED', 'an intake report with no skipped PHP does not block');
    const unread = await run('b-unread', { extra: r => w(r, 'wp-content/plugins/elementor/huge.php', '<?php\n// ' + 'x'.repeat(2.2 * 1024 * 1024)) });
    ok(unread.h.status !== 'CONFIRMED' && /could not be read/.test(unread.chk('class-undefined').reason), 'a PHP file too large to read blocks rule B');
    const plain = await run('b-plain', { cls: 'Imagick', line: '$i = new \\Imagick();' });
    ok(plain.h.status !== 'CONFIRMED' && /no namespace/.test(plain.chk('class-undefined').reason), 'a class without a namespace (PHP or WordPress may own it): rule B does not apply');
    const brokenParse = await run('b-parse', {}, (dir) => { const f = path.join(dir, 'work', 'custom-code.json'); const j = JSON.parse(fs.readFileSync(f, 'utf8')); j.components[0].files = { total: 3, parsed: 2, failed: 1 }; fs.writeFileSync(f, JSON.stringify(j)); });
    ok(brokenParse.h.status !== 'CONFIRMED' && /could not be fully parsed/.test(brokenParse.chk('class-undefined').reason), 'a component that failed to parse blocks rule B');

    group('Rule A: the fatal is fresh and the live page answered 5xx');
    const NOW = '2026-11-02T13:11:38.000Z', FRESH = '02-Nov-2026 12:30:00';
    const a = await run('a-fresh', { elementor: 'defines', at: FRESH }, probe5xx(NOW));
    ok(a.h.status === 'CONFIRMED' && a.h.fatal_recheck.rule === 'A' && a.h.fatal_recheck.supports.join() === 'fatal-site,probe-5xx', 'fresh fatal + HTTP 500 (class defined elsewhere, so rule B cannot apply): CONFIRMED by rule A');
    ok(!/not checked live/.test(a.text) && /is defined in elementor/.test(a.text), 'rule A text: no "not checked live"');
    const stale = await run('a-stale', { elementor: 'defines' }, probe5xx(NOW));
    ok(stale.h.status !== 'CONFIRMED' && stale.chk('fatal-fresh').status === 'FAILED' && /more than 24 hours/.test(stale.chk('fatal-fresh').reason), 'an old fatal plus a new, unrelated 5xx: not paired, not confirmed');
    const no5 = await run('a-no5xx', { elementor: 'defines', at: FRESH }, probe5xx(NOW, 200));
    ok(no5.h.status !== 'CONFIRMED' && no5.chk('probe-5xx').status === 'FAILED', 'fresh fatal but the probe saw no 5xx: not confirmed');
    const noProbe = await run('a-noprobe', { elementor: 'defines', at: FRESH });
    ok(noProbe.h.status !== 'CONFIRMED' && noProbe.chk('probe-5xx').status === 'NOT_RUN', 'no probe at all: rule A does not apply');
    const created = await run('a-created', { elementor: 'defines', at: new Date(Date.now() - 3600e3).toISOString().replace(/^(\d{4})-(\d\d)-(\d\d)T(\d\d:\d\d:\d\d).*/, (m, y, mo, d, t) => `${d}-${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][Number(mo) - 1]}-${y} ${t}`) }, (dir, issue) => fs.writeFileSync(path.join(dir, 'work', 'probe.json'), JSON.stringify({ schema: 1, pages: [{ url: issue.url, status: 503, viewport: { name: 'laptop' }, loaded: true }] })));
    ok(created.h.status === 'CONFIRMED' && created.h.fatal_recheck.rule === 'A' && /issue creation/.test(created.chk('fatal-fresh').reason), 'without a probe run time, the issue creation time is the reference (a fatal an hour ago + HTTP 503)');
    const otherHost = await run('a-host', { elementor: 'defines', at: FRESH }, (dir) => { setRan(dir, NOW); fs.writeFileSync(path.join(dir, 'work', 'probe.json'), JSON.stringify({ schema: 1, pages: [{ url: 'http://another-site.example/', status: 500, viewport: { name: 'laptop' }, loaded: true }] })); });
    ok(otherHost.h.status !== 'CONFIRMED', 'a 5xx on another site does not count');

    group('provider: installed / active / not installed / guessed / unknown');
    const off = await run('p-off', { elementor: 'defines', at: FRESH }, (dir, issue) => { probe5xx(NOW)(dir, issue); fs.writeFileSync(path.join(dir, 'work', 'sandbox.json'), JSON.stringify({ steps: [], reproduced_in_sandbox: null, baseline: { active_plugins: ['hello-dolly'] } })); });
    ok(off.h.fatal_recheck.provider.active === false && off.text.includes('Elementor is installed but switched off.'), 'installed but not in the sandbox\'s active list: "Elementor is installed but switched off."');
    const unknownActive = await run('p-unknown', { elementor: 'defines' });
    ok(unknownActive.h.fatal_recheck.provider.active === null && unknownActive.text.includes('Whether Elementor is switched on is not known.'), 'active list not known: "Whether Elementor is switched on is not known."');
    const noProvider = await run('p-notinstalled', { elementor: 'absent' });
    ok(noProvider.h.status === 'CONFIRMED' && noProvider.h.fatal_recheck.provider.installed === false && noProvider.text.includes('which comes from Elementor, which is not installed.') && !/does not contain/.test(noProvider.text), 'provider not installed: "...comes from Elementor, which is not installed." (and no "does not contain")');
    const noVer = await run('p-nover', { elementor: 'no-version' });
    ok(noVer.h.status === 'CONFIRMED' && /which Elementor does not contain\./.test(noVer.text) && !/older version/.test(noVer.text), 'provider version not known: no version and no "older version" sentence');
    const guess = await run('p-guess', { cls: 'Foobarwidgets\\Core\\Thing', line: '$c = new \\Foobarwidgets\\Core\\Thing();', elementor: 'absent', extra: r => w(r, 'wp-content/plugins/foobarwidgets-pro/foobarwidgets-pro.php', '<?php\n/**\n * Plugin Name: Foobar Widgets Pro\n * Version: 2.0\n */\n') });
    ok(guess.h.fatal_recheck.provider.known === false && guess.h.fatal_recheck.provider.source === 'guess' && /might belong to Foobar Widgets Pro \(a guess from its name, not checked\)/.test(guess.text) && !/does not contain/.test(guess.text), 'a guessed provider NEVER produces "does not contain"');
    ok((guess.f.findings[0] || guess.f.advisories[0] || {}).label !== 'theme-plugin', 'and a guessed provider does not set the theme-plugin label');
    const unk = await run('p-unknown-owner', { cls: 'Zzqx\\Thing', line: '$c = new \\Zzqx\\Thing();', elementor: 'absent' });
    ok(/The class's owner could not be identified\./.test(unk.text), '"The class\'s owner could not be identified."');
    const pp = await run('p-pluginplugin', { file: 'wp-content/plugins/addon/widgets/a.php', cls: 'WooCommerce\\Admin\\Foo', line: '$c = new \\WooCommerce\\Admin\\Foo();', extra: r => { w(r, 'wp-content/plugins/addon/addon.php', '<?php\n/**\n * Plugin Name: Addon\n * Version: 1\n */\n'); w(r, 'wp-content/plugins/woocommerce/woocommerce.php', '<?php\n/**\n * Plugin Name: WooCommerce\n * Version: 9.1.0\n */\n'); } });
    ok(pp.h.status === 'CONFIRMED' && pp.f.findings[0] && pp.f.findings[0].label === 'plugin-plugin' && /The plugin file wp-content\/plugins\/addon\/widgets\/a\.php:48 calls the class WooCommerce\\Admin\\Foo, which WooCommerce 9\.1\.0 does not contain/.test(pp.text), 'a plugin file calling a WooCommerce class: label plugin-plugin');
    ok(fr.providerOf('ET_Builder_Module', [{ slug: 'divi', kind: 'theme', name: 'Divi', version: '4.0' }], null).slug === 'divi' && fr.providerOf('Yoast\\WP\\SEO\\X', [], null).slug === 'wordpress-seo' && fr.providerOf('ACF\\Foo', [], null).slug === 'advanced-custom-fields' && fr.providerOf('Automattic\\WooCommerce\\Utilities\\X', [], null).slug === 'woocommerce', 'the fixed map: ET_ -> divi, Yoast\\WP -> wordpress-seo, ACF\\ -> advanced-custom-fields, Automattic\\WooCommerce\\ -> woocommerce');

    group('definitions: class, interface, trait, enum, class_alias');
    for (const [kind, src] of [['interface', 'interface Color {}'], ['trait', 'trait Color {}'], ['enum', 'enum Color {}'], ['final class', 'final class Color {}']]) {
        const r = path.join(tmp, 'def-' + kind.replace(/\W/g, '')); w(r, 'wp-content/plugins/e/c.php', `<?php\nnamespace Elementor\\Core\\Schemes;\n${src}\n`);
        ok(fr.findDefinition(r, CLASS).defined.length === 1, `${kind} is found as a definition`);
    }
    const ra = path.join(tmp, 'def-alias'); w(ra, 'wp-content/plugins/e/a.php', "<?php\nclass_alias( 'Elementor\\\\Other\\\\Color', 'Elementor\\\\Core\\\\Schemes\\\\Color' );\n");
    ok(fr.findDefinition(ra, CLASS).defined.length === 1, 'class_alias( ..., \'Elementor\\\\Core\\\\Schemes\\\\Color\' ) is found');
    const rn = path.join(tmp, 'def-other-ns'); w(rn, 'wp-content/plugins/e/c.php', '<?php\nnamespace Acme;\nclass Color {}\n');
    ok(fr.findDefinition(rn, CLASS).defined.length === 0, 'a class of the same short name in another namespace is not a definition');

    group('the copy reports skipped PHP');
    const cs = path.join(tmp, 'copyskip'); w(cs, 'wp-content/plugins/p/a.php'); w(cs, 'wp-content/plugins/p/.github/hook.php'); w(cs, 'wp-content/plugins/p/wp-config-sample.php'); w(cs, 'wp-content/plugins/p/node_modules/x/i.js', 'x'); w(cs, 'wp-content/themes/t/style.css', '/* x */'); w(cs, 'wp-content/object-cache.php');
    const sc = copy.scan(cs);
    ok(sc.phpSkipped.join() === 'wp-content/plugins/p/.github,wp-content/object-cache.php', 'a skipped folder that holds PHP and a skipped drop-in are counted; wp-config*.php and a folder with no PHP are not');
    const rep = copy.copySite(cs, path.join(tmp, 'copyskip-out', 'site'), { sandboxDir: path.join(tmp, 'copyskip-out') });
    ok(rep.php_skipped === 2 && rep.php_skipped_examples.length === 2, 'copySite returns php_skipped and examples');

    group('deep log scan: a fatal that is not in the last 2 MB');
    const noise = '[02-Nov-2026 12:49:04 UTC] PHP Deprecated:  Creation of dynamic property X::$label is deprecated in /v/wp-content/plugins/p/a.php on line 291\n';
    const fatalLine = t => `[${t} UTC] PHP Fatal error:  Uncaught Error: Class "${CLASS}" not found in /v/${THEME_FILE}:48\nStack trace:\n#0 {main}\n  thrown in /v/${THEME_FILE} on line 48\n`;
    const big = (name, parts) => { const f = path.join(tmp, name); const fd = fs.openSync(f, 'w'); for (const p of parts) fs.writeSync(fd, p); fs.closeSync(fd); return f; };
    const fileEarly = big('early.log', [noise.repeat(100), fatalLine('16-Mar-2026 13:11:38'), fatalLine('16-Mar-2026 13:14:46'), noise.repeat(40000)]);   // ~6 MB, fatal near the start
    const sz = fs.statSync(fileEarly).size;
    const d1 = logsLib.deepScan(fileEarly, { cap: 4 * 1024 * 1024 });
    ok(sz > 5 * 1048576 && d1.found && d1.entries === 2 && d1.passes.some(p => p.direction === 'forwards') && d1.read_bytes <= 4 * 1048576, `a fatal at the start of a ${Math.round(sz / 1048576)} MB log is found by the forwards pass within a 4 MB cap (read ${(d1.read_bytes / 1048576).toFixed(1)} MB)`);
    const fileMid = big('mid.log', [noise.repeat(20000), fatalLine('16-Mar-2026 13:11:38'), noise.repeat(40000)]);
    const d2 = logsLib.deepScan(fileMid, { cap: 2 * 1024 * 1024 });
    ok(!d2.found && d2.read_bytes <= 2 * 1048576 && /no fatal error found in the part read/.test(logsLib.describeDeep(d2)), 'a fatal outside the cap is not found, and the report says no fatal was found in the part read');
    ok(/\(\d+(\.\d)? MB of \d+(\.\d)? MB\)/.test(logsLib.describeDeep(d1)), 'the description says "read N MB of M MB"');
    const long = big('long.log', [fatalLine('16-Mar-2026 13:11:38').replace('Uncaught Error', 'Uncaught Error: ' + 'y'.repeat(5000)), noise.repeat(40000)]);
    ok(logsLib.deepScan(long, { cap: 4 * 1048576 }).text.split('\n').every(l => l.length <= 1200), 'a kept line is cut at 1200 characters');

    // end to end through evidence.run: crash symptom, a fatal at the head of a big log
    const e2e = async (name, { symptom, description, logParts, cap }) => {
        const root = path.join(tmp, name, 'wp'); w(root, 'wp-includes/version.php', "<?php\n$wp_version = '6.8.1';\n"); w(root, 'wp-content/plugins/elementor/elementor.php', '<?php\n/**\n * Plugin Name: Elementor\n * Version: 3.35.7\n */\n'); w(root, 'wp-content/themes/unicamp/style.css', '/*\nTheme Name: Unicamp\n*/'); w(root, THEME_FILE, '<?php\n' + '//\n'.repeat(46) + '$c = \\' + CLASS + '::x();\n');
        fs.mkdirSync(path.join(root, 'wp-content'), { recursive: true }); fs.writeFileSync(path.join(root, 'wp-content/debug.log'), logParts.join(''));
        const issue = store.create({ title: 'Problem', description, symptom, environment: 'local', url: 'http://127.0.0.1:9/', root, pages: ['/'] });
        const ev = await evidence.run(issue.id, { root, probeOptions: { probe: false }, deepLogCap: cap });
        const logStep = ev.steps.find(s => s.id === 'logs');
        return { ev, logStep, found: ev.clues.some(c => c.type === 'php-class-not-found'), note: (logStep && logStep.reason) || '' };
    };
    const parts = [noise.repeat(100), fatalLine('16-Mar-2026 13:11:38'), fatalLine('16-Mar-2026 13:14:46'), noise.repeat(40000)];
    const crash = await e2e('e2e-crash', { symptom: 'white-screen', description: 'White screen after an update', logParts: parts, cap: 4 * 1048576 });
    ok(crash.found && /MB of \d/.test(crash.note) && /fatal-like line/.test(crash.note), `crash symptom: the fatal beyond the first 2 MB is read and the report step says how much (${crash.note.slice(0, 150)}...)`);
    const layout = await e2e('e2e-layout', { symptom: 'layout', description: 'The header looks wrong on mobile', logParts: parts, cap: 4 * 1048576 });
    ok(!layout.found && !/MB of/.test(layout.note), 'not a crash: the log is NOT scanned deeper (only the last 2 MB)');
    const worded = await e2e('e2e-words', { symptom: 'layout', description: 'We get a critical error on the homepage', logParts: parts, cap: 4 * 1048576 });
    ok(worded.found, 'a crash described in words ("critical error") also triggers the deep scan');
    const tailFatal = await e2e('e2e-tail', { symptom: 'white-screen', description: 'White screen', logParts: [noise.repeat(40000), fatalLine('16-Mar-2026 13:11:38')], cap: 4 * 1048576 });
    ok(tailFatal.found && !/MB of/.test(tailFatal.note), 'a fatal already in the last 2 MB: no deep scan');

    // the wizard's copy of the log
    const lc = intake.readLogRedacted(fileEarly, { crash: true, cap: 4 * 1048576 });
    ok(lc.deep && lc.deep.found && lc.text.includes(`Class "${CLASS}" not found`) && Buffer.byteLength(lc.text) <= 2 * 1048576 + 1024 && /MB of/.test(lc.deep.text), 'the wizard\'s copy keeps the deep-scan fatal inside 2 MB and records how much was read');
    const lc2 = intake.readLogRedacted(fileEarly, { crash: false });
    ok(!lc2.deep && !lc2.text.includes('not found in'), 'not a crash: the wizard\'s copy is the last 2 MB only');

    fs.rmSync(tmp, { recursive: true, force: true });
    console.log(failures ? `\n${failures} FAILED` : '\nAll checks passed');
    process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
