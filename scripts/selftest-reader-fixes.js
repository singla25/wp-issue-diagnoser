#!/usr/bin/env node
// Pre-Part-3 step (III) and (IV), gate on only:
//   (III) the call chain of a log fatal: each Class->method() / Class::method() frame is looked up in the syntax-tree hook facts of the component that defines the class
//         ("registered on <hook> at priority N (file, line L)"; "no add_action or add_filter names this method in <component>"; a closure, a callback in a variable,
//         [$this, 'm'] written in another class, a hook name built at run time: "unknown"). No hook name is invented.
//   (IV)  (1) the developer Verdict sentence agrees with Case 1 (a confirmed case with a seen 5xx never says "not seen failing"); (2) the provider plugin is in the
//         Involved components table; (3) empty "Dependency and conflict graph" and "Also found" sections are not on the page; (4) no raw timestamp in reader text.
// Main fixture: the real ews theme lines (scripts/fixtures/issue/names-class/heading.php; the add_action spans lines 23-26, the method name is on line 25) and the real
// shape of the ews stack trace (class-wp-hook.php calling Unicamp_Elementor\Modify_Widget_Heading->before_end_section_title_style()). Offline; fixtures only.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-readerfix-'));
process.env.PLUGIN_GUARD_ISSUES = path.join(tmp, 'issues');
const store = require('../lib/issue-store');
const evidence = require('../issue/evidence'), analysis = require('../issue/analysis'), validate = require('../issue/validate'), resolve = require('../issue/resolve'), result = require('../issue/result');
const oracle = require('../issue/oracle'), causeDetail = require('../issue/cause-detail'), phpast = require('../issue/phpast'), custom = require('../issue/custom');
const plain = require('../lib/plain-names'), gateHtml = require('../lib/issue-html-gate'), issueHtml = require('../lib/issue-html');
const cli = require('../lib/issue-cli');

let failures = 0, skipped = 0;
const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`); if (!c) failures++; };
const group = t => console.log(`\n== ${t}`);
const w = (root, rel, body = '<?php\n') => { const f = path.join(root, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, body); };
const CLASS = 'Elementor\\Core\\Schemes\\Color';
const FILE = 'wp-content/themes/unicamp/elementor/widgets/original/heading.php';
const HEADING = fs.readFileSync(path.join(__dirname, 'fixtures', 'issue', 'names-class', 'heading.php'), 'utf8');
const HOOK = 'elementor/element/heading/section_title_style/before_section_end';
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const stamp = d => `${String(d.getUTCDate()).padStart(2, '0')}-${MON[d.getUTCMonth()]}-${d.getUTCFullYear()} ${d.toISOString().slice(11, 19)}`;
const ISO = /\d{4}-\d{2}-\d{2}T\d{2}:/;
const EWS = 'http://localhost82.local.com/ews/';
const fingerprint = root => { const h = crypto.createHash('sha256'); const walk = d => { for (const n of fs.readdirSync(d).sort()) { const p = path.join(d, n), st = fs.lstatSync(p); h.update(path.relative(root, p) + ':' + st.size + ':'); if (st.isDirectory()) walk(p); else h.update(fs.readFileSync(p)); } }; walk(root); return h.digest('hex'); };

// the real ews trace shape: the hook runner calls the theme's method, Elementor's controls stack fires the hook
const TRACE = root => [
    `#0 ${root}/wp-includes/class-wp-hook.php(355): Unicamp_Elementor\\Modify_Widget_Heading->before_end_section_title_style(Object(Elementor\\Widgets\\Widget_Heading))`,
    `#1 ${root}/wp-includes/class-wp-hook.php(377): WP_Hook->apply_filters(NULL, Array)`,
    `#2 ${root}/wp-includes/plugin.php(523): WP_Hook->do_action(Array)`,
    `#3 ${root}/wp-content/plugins/elementor/includes/base/controls-stack.php(1677): do_action('${HOOK}', Object(Elementor\\Widget_Heading), Array)`,
    `#4 ${root}/wp-content/plugins/elementor/includes/widgets/heading.php(421): Elementor\\Controls_Stack->end_controls_section()`,
    '#5 {main}'
].join('\n') + '\n';
function build(root, o = {}) {
    w(root, 'wp-includes/version.php', "<?php\n$wp_version = '6.8.1';\n"); w(root, 'wp-config.php', '<?php\n');
    if (o.elementor !== false) w(root, 'wp-content/plugins/elementor/elementor.php', '<?php\n/**\n * Plugin Name: Elementor\n * Version: 3.35.7\n */\nnamespace Elementor;\nclass Plugin {}\n');
    w(root, 'wp-content/themes/unicamp/style.css', '/*\nTheme Name: Unicamp\nVersion: 2.2.0\n*/');
    w(root, FILE, HEADING);
    if (o.log === 'none') return;
    const d = o.at || new Date(Date.now() - 2 * 3600e3), d2 = new Date(d.getTime() + 1000);
    const one = t => `[${stamp(t)} UTC] PHP Fatal error:  Uncaught Error: Class "${CLASS}" not found in ${root}/${FILE}:48\nStack trace:\n${o.trace === false ? '#0 {main}\n' : TRACE(root)}  thrown in ${root}/${FILE} on line 48\n`;
    w(root, 'wp-content/debug.log', one(d) + one(d2));
}
const page = status => ({ console_errors: [], page_errors: [], error_responses: status >= 500 ? [{ url: EWS, status, type: 'document', same_site: true, source: { type: 'other', ref: null, name: 'localhost82.local.com' } }] : [], failed_requests: [], url: EWS, viewport: { name: 'laptop', width: 1280, height: 800 }, loaded: true, status, first_status: status, retried: false, outcome: status >= 500 ? 'server-error' : 'ok' });
const probeWrite = (dir, pages) => {
    const j = JSON.parse(fs.readFileSync(path.join(dir, 'issue.json'), 'utf8')); j.probe_ran_at = new Date().toISOString(); fs.writeFileSync(path.join(dir, 'issue.json'), JSON.stringify(j));
    const obs = { pages, planned: pages.length, protection: null, debug_log: { new_bytes: 0, lines: 0 } };
    fs.writeFileSync(path.join(dir, 'work', 'probe.json'), JSON.stringify({ schema: 1, planned: { pages: [EWS], viewports: ['laptop 1280x800'], loads: pages.length, notes: [] }, protection: null, pages, oracle: oracle.evaluate(j.oracle, obs, { needsLogin: j.needs_login, symptom: j.symptom }), debug_log: obs.debug_log }));
};
async function run(name, o = {}) {
    const root = path.join(tmp, name, 'wp'); build(root, o);
    const config = path.join(path.dirname(root), 'plugin-guard.config.json'); fs.writeFileSync(config, '{}');
    const before = fingerprint(root);
    const issue = store.create({ title: 'Critical error', description: 'The site shows a critical error', symptom: 'white-screen', environment: 'local', url: EWS, root, pages: [] });
    await evidence.run(issue.id, { root, probeOptions: { probe: false } });
    const dir = store.dirOf(issue.id);
    if (o.probe) probeWrite(dir, [page(o.probe)]);
    analysis.run(issue.id, { root, config });
    const val = validate.run(issue.id, { root, config, lint: () => ({ ok: true, message: '' }) });
    const policy = validate.policyFor(root, config), plans = resolve.build(issue.id, val, { root, policy, dir });
    const res = result.write(issue.id, { validation: val, plans, dir, root, policy, gate: true, verbose: !!o.verbose });
    const R = n => fs.readFileSync(path.join(dir, 'result', n), 'utf8');
    const out = []; cli.printGate(res, plans, { gate: true, verbose: !!o.verbose }, t => out.push(t), dir);
    return { dir, root, val, f: JSON.parse(R('findings.json')), md: R('ISSUE-REPORT.md'), html: R('issue.html'), cli: out.join('\n'), same: before === fingerprint(root), h: val.hypotheses.find(x => x.type === 'missing-function') };
}
// facts of one component from fixture files, as custom.js merges them (every entry carries its file)
const factsOf = files => custom.merge(Object.entries(files).map(([file, src]) => phpast.analyse(src, file)));
const fr0 = { kind: 'class', class: CLASS, file: 'wp-content/themes/demo/w.php', line: 5, file_kind: 'theme', provider: { known: false } };
const frames = calls => calls.map((call, i) => ({ file: 'wp-includes/class-wp-hook.php', line: 300 + i, call }));
const comps = [{ ref: 'theme:demo', kind: 'theme', slug: 'demo', name: 'Demo Theme' }];

(async () => {
    group('(III) the ews call chain: the multi-line add_action in heading.php, found through the syntax tree');
    const ews = await run('ews', { probe: 500 });
    const st = ews.f.cause_detail && ews.f.cause_detail.stack;
    ok(ews.h && ews.h.status === 'CONFIRMED' && ews.h.fatal_recheck.rule === 'A', `the ews fixture with its real trace shape: CONFIRMED by Rule A (${ews.h && ews.h.status})`);
    ok(st && st.available && st.frames.length >= 4, 'the call chain is read from the log');
    const reg = st && (st.registrations || []).find(r => r.method === 'before_end_section_title_style');
    ok(reg && reg.result === 'registered' && reg.component === 'theme:unicamp' && reg.hooks.length === 1 && reg.hooks[0].hook === HOOK && reg.hooks[0].priority === 10 && reg.hooks[0].line === 23 && reg.hooks[0].file === FILE && reg.hooks[0].type === 'action',
        `frame #0 Modify_Widget_Heading->before_end_section_title_style(): registered on ${reg && reg.hooks[0] && reg.hooks[0].hook} at priority ${reg && reg.hooks[0] && reg.hooks[0].priority}, the add_action call on line ${reg && reg.hooks[0] && reg.hooks[0].line} (the method name itself is on line 25)`);
    const line = (ews.f.cause_detail.lines || []).find(l => /^Where the methods in that call chain are registered: /.test(l)) || '';
    ok(line.includes(`#0 Unicamp_Elementor\\Modify_Widget_Heading->before_end_section_title_style(): registered on ${HOOK} at priority 10 (${FILE}, line 23)`), `the developer line: ${line.slice(0, 220)}`);
    ok(/not looked up, because their code was not analysed: WP_Hook->apply_filters\(\), WP_Hook->do_action\(\), Elementor\\Controls_Stack->end_controls_section\(\)\.$/.test(line) && !/do_action\(\):/.test(line), 'classes whose code was not analysed (WordPress core, Elementor) are listed as not looked up; a plain function frame (do_action) is not a method');
    ok(ews.f.case_file.developer.includes(line) && ews.md.includes('registered on ' + HOOK) && ews.cli.includes('registered on ' + HOOK), 'the line is under FOR A DEVELOPER in the Markdown and on the command line');
    const plainLog = await run('ews-notrace', { probe: 500, trace: false });
    ok(!plainLog.f.cause_detail.stack.available && !(plainLog.f.cause_detail.lines || []).some(l => /registered/.test(l)), 'a log with only "#0 {main}": no call chain, so no registration line is invented');

    group('(III) other ways to register, a negative, and what stays unknown');
    const multi = `<?php
namespace Demo;
class Widget {
    public function init() {
        add_action(
            '${HOOK}',
            [ $this, 'before_end' ],
            10,
            2
        );
        add_filter( 'the_title', [ __CLASS__, 'title_filter' ], 20 );
        add_action( 'init', 'Demo\\\\Widget::boot' );
        add_action( 'wp_footer', [ self::class, 'footer' ], 5 );
        add_action( 'dynamic_' . $this->slug, [ $this, 'dyn' ] );
        add_action( 'wp_head', [ $other, 'from_var' ] );
    }
    public function before_end() {}
    public static function title_filter( $t ) { return $t; }
    public static function boot() {}
    public static function footer() {}
    public function dyn() {}
    public function from_var() {}
    public function never_registered() {}
}
class Child_Widget extends Widget {
    public function init2() { add_action( 'admin_init', [ $this, 'inherited' ] ); }
}
`;
    const facts = { 'theme:demo': factsOf({ 'wp-content/themes/demo/w.php': multi }) };
    const regs = causeDetail.registrationsOf(frames(['Demo\\Widget->before_end(Object(X), Array)', 'Demo\\Widget::title_filter()', 'Demo\\Widget::boot()', 'Demo\\Widget::footer()', 'Demo\\Widget->never_registered()', 'Demo\\Widget->dyn()', 'Demo\\Widget->from_var()', 'Demo\\Widget->inherited()', '{closure}(Object(WP))', 'Demo\\{closure}()', 'Other\\Thing->run()']), facts, comps);
    const by = m => regs.find(r => r.method === m) || {};
    ok(by('before_end').result === 'registered' && by('before_end').hooks[0].hook === HOOK && by('before_end').hooks[0].priority === 10 && by('before_end').hooks[0].line === 5 && by('before_end').hooks[0].file === 'wp-content/themes/demo/w.php', 'an add_action( hook, [ $this, \'m\' ], 10, 2 ) split over six lines: registered, priority 10, the call\'s line');
    ok(by('title_filter').result === 'registered' && by('title_filter').hooks[0].hook === 'the_title' && by('title_filter').hooks[0].priority === 20 && by('title_filter').hooks[0].type === 'filter', '[ __CLASS__, \'m\' ]: registered on the_title at priority 20 (a filter)');
    ok(by('boot').result === 'registered' && by('boot').hooks[0].hook === 'init' && by('boot').hooks[0].priority === 10, "a 'Class::m' string: registered on init at priority 10");
    ok(by('footer').result === 'registered' && by('footer').hooks[0].hook === 'wp_footer' && by('footer').hooks[0].priority === 5, '[ self::class, \'m\' ]: registered on wp_footer at priority 5');
    ok(by('never_registered').result === 'not-registered' && by('never_registered').reason === 'no add_action or add_filter names this method in the theme Demo Theme', `negative: "${by('never_registered').reason}"`);
    ok(by('dyn').result === 'unknown' && !by('dyn').hooks.length, 'a hook name built at run time: unknown (no hook name is invented)');
    ok(by('from_var').result === 'unknown', "[ $other, 'm' ] (a callback held in a variable): unknown");
    ok(by('inherited').result === 'unknown' && /cannot be known/.test(by('inherited').reason), "[ $this, 'm' ] written in another class (Child_Widget): unknown");
    ok(regs.filter(r => r.call === '{closure}').length === 1 && regs.find(r => r.call === '{closure}').result === 'unknown', 'a closure frame: unknown (once)');
    ok((regs.find(r => r.class === 'Other\\Thing') || {}).result === 'not-analysed', 'a class nobody analysed: not looked up');
    ok(causeDetail.registrationsOf(frames(['Demo\\Widget->before_end()']), null, comps).length === 0, 'no syntax-tree facts: nothing is looked up (no line)');
    const hookNames = new Set(regs.flatMap(r => r.hooks.map(h => h.hook)));
    ok([...hookNames].every(h => multi.includes(`'${h}'`) || h === HOOK), `every hook name shown is written literally in the code (${[...hookNames].join(', ')})`);

    group('(IV-1) the developer Verdict sentence agrees with Case 1');
    ok(ews.f.confidence_text === 'How sure we are: fairly. The error is in your log, the code was re-read, and the live page answered HTTP 500.' && !/not seen failing/.test(ews.f.confidence_text), `a confirmed case with a seen 5xx: "${ews.f.confidence_text}"`);
    ok(ews.f.symptom_text === 'The problem was seen on the site.' && ews.html.includes('F.confidence_text'), 'and the sentence after it agrees ("The problem was seen on the site.")');
    const stale = await run('stale', { at: new Date(Date.UTC(2026, 2, 16, 13, 11, 38)) });
    ok(stale.h.status === 'CONFIRMED' && stale.f.confidence_text === 'How sure we are: fairly. The error is in your log and the code was re-read; it was not checked on the live site.' && stale.f.symptom_text === 'The problem was not tested on the site.', `Rule B, no live check: "${stale.f.confidence_text}"`);
    ok(plain.confidenceSentence('medium-high', 'Confirmed cause found in your logs') === 'How sure we are: fairly. The error is in your log and the code was re-read, but it was not seen failing on the site.', 'without a Case 1 to read from, the sentence of the tier is unchanged');

    group('(IV-2) the provider plugin in the Involved components table');
    const el = ews.f.components.find(c => c.ref === 'elementor');
    ok(el && el.label === 'the plugin Elementor' && el.version === '3.35.7' && el.ownership === 'third-party' && el.roles.includes(`expected to provide the class ${CLASS}`) && el.in_hypotheses.length === 1, `Elementor is listed: ${el && JSON.stringify({ label: el.label, roles: el.roles, in: el.in_hypotheses })}`);
    ok(ews.f.components.some(c => c.ref === 'theme:unicamp') && ews.f.components.map(c => c.ref).join() === ews.f.components.map(c => c.ref).sort().join(), 'the theme is still listed; the table stays sorted');
    const noEl = await run('no-elementor', { probe: 500, elementor: false });
    ok(!noEl.f.components.some(c => c.ref === 'elementor'), 'Elementor not installed: not added');

    group('(IV-4) no raw timestamp in reader text');
    const why = Object.values(ews.f.reader_why || {}).flat();
    const fresh = why.find(l => /^Passed: the fatal \(/.test(l)) || '';
    ok(/^Passed: the fatal \(\d{1,2} [A-Z][a-z]{2} \d{4}\) is within 24 hours of the probe run$/.test(fresh), `"Why this status": "${fresh}"`);
    ok(ews.h.checks.some(c => c.id === 'fatal:fatal-fresh' && ISO.test(c.reason)), 'findings.json keeps the producer\'s text (the timestamp) unchanged');
    for (const [name, r] of [['ews', ews], ['stale', stale]]) {
        const texts = { 'page why-lines': Object.values(r.f.reader_why || {}).flat().join('\n'), Markdown: r.md, 'command line': r.cli, 'not tested': Object.values(r.f.not_tested_text || {}).join('\n'), 'validation lines': plain.readerValidationLines(r.val).join('\n') };
        for (const [k, t] of Object.entries(texts)) ok(!ISO.test(t), `${name}: no raw timestamp in the ${k}${ISO.test(t) ? ' -> ' + (t.match(new RegExp('.{0,60}' + ISO.source + '.{0,20}')) || [''])[0] : ''}`);
    }
    ok(plain.readerDates('the fatal (2026-11-04T09:15:40.000Z) is old') === 'the fatal (4 Nov 2026) is old' && plain.readerDates('no date here') === 'no date here', 'readerDates: 2026-11-04T09:15:40.000Z -> 4 Nov 2026');

    group('(IV-3) empty sections are not on the page');
    let client = fs.readFileSync(path.join(__dirname, '..', 'lib', 'issue-html-client.js'), 'utf8');
    const patched = gateHtml.apply(client);
    ok(/if \(!F\.graph\.edges\.length && s4\.parentNode\) s4\.parentNode\.removeChild\(s4\);/.test(patched) && /if \(!n8 && s8\.parentNode\) s8\.parentNode\.removeChild\(s8\);/.test(patched) && /\.filter\(function \(p\) \{ return !F\.gate \|\| !!document\.getElementById\(p\.split\(':'\)\[0\]\); \}\)/.test(patched), 'the gate patch removes the two sections when empty and keeps the table of contents to the sections that exist');
    let threw = false; try { gateHtml.apply(client.replace("    // ---------------------------------------------------------------- 9. retests\n", '')); } catch (e) { threw = /does not fit the client script/.test(e.message); }
    ok(threw, 'the patch throws if its anchor no longer fits the client (the throw-if-no-fit contract)');
    ok(!/## (Dependency and conflict graph|Also found)/.test(ews.md) && !/DEPENDENCY AND CONFLICT GRAPH|ALSO FOUND/.test(ews.cli), 'the gate Markdown and the command line have no such section');
    let pw = null; try { pw = require('../lib/playwright').load(); } catch { /* not installed */ }
    const browser = pw && require('../lib/playwright').status().chromium ? await pw.chromium.launch() : null;
    if (!browser) { console.log("SKIP  plugin-guard's own browser is not installed: the rendered-page part did not run"); skipped++; }
    else {
        const open = async file => {
            const ctx = await browser.newContext({ serviceWorkers: 'block' }), pg = await ctx.newPage(), errs = [], reqs = [];
            pg.on('pageerror', e => errs.push(e.message));
            await pg.route('**/*', rt => { reqs.push(rt.request().url()); return rt.request().url().startsWith('file://') ? rt.continue() : rt.abort(); });
            await pg.goto('file://' + file);
            const o = { ids: await pg.evaluate(() => [...document.querySelectorAll('#content > section')].map(s => s.id)), toc: await pg.evaluate(() => [...document.querySelectorAll('#toc a')].map(a => a.getAttribute('href'))),
                why: await pg.evaluate(() => [...document.querySelectorAll('#resolution details li')].map(l => l.textContent)), errs, reqs, close: () => ctx.close() };
            return o;
        };
        const pe = await open(path.join(ews.dir, 'result', 'issue.html'));
        ok(ews.f.graph.edges.length === 0 && !pe.ids.includes('graph') && !pe.ids.includes('also') && !pe.toc.includes('#graph') && !pe.toc.includes('#also'), `ews: no relation and nothing else found, so neither section nor its link is on the page (sections: ${pe.ids.join(', ')})`);
        ok(pe.ids.includes('components') && pe.ids.includes('resolution') && pe.toc.every(h => pe.ids.includes(h.slice(1))) && !pe.errs.length && pe.reqs.every(u => u.startsWith('file://')), 'every link of the table of contents points at a section that exists; no script error; offline');
        ok(pe.why.length > 0 && pe.why.every(t => !ISO.test(t)) && pe.why.some(t => /^Passed: the fatal \(\d{1,2} [A-Z][a-z]{2} \d{4}\)/.test(t)), `page "Why this status": readable dates (${pe.why.find(t => /the fatal \(/.test(t)) || ''})`);
        // a graph with a relation and one item found elsewhere: both sections stay
        const f2 = JSON.parse(JSON.stringify(ews.f));
        f2.graph = { nodes: [{ ref: 'theme:unicamp', distance: 0 }, { ref: 'elementor', distance: 1 }], edges: [{ id: 'e1', type: 'calls', from: 'theme:unicamp', to: 'elementor', why: 'the theme calls a class of the plugin' }], dropped: 0 };
        f2.also_found = { observations: [{ id: 'o1', type: 'duplicate-shortcode', message: 'two plugins register [x]' }], collisions: [] };
        const file2 = path.join(tmp, 'with-graph.html'); fs.writeFileSync(file2, issueHtml.build(f2, []));
        const pg2 = await open(file2);
        ok(pg2.ids.includes('graph') && pg2.ids.includes('also') && pg2.toc.includes('#graph') && pg2.toc.includes('#also') && !pg2.errs.length, 'a graph with a relation and one item found elsewhere: both sections and their links stay');
        await pe.close(); await pg2.close(); await browser.close();
    }
    ok([ews, plainLog, stale, noEl].every(r => r.same), 'no site folder was written (fingerprint before and after)');
    const src = fs.readFileSync(path.join(__dirname, '..', 'issue', 'cause-detail.js'), 'utf8').replace(/\/\/.*$/gm, '');
    ok(!/writeFileSync|appendFileSync|mkdirSync|rmSync|unlinkSync|renameSync|require\(['"](https?|net|dns|child_process)['"]\)|fetch\(/.test(src) && !/status\s*=|CONFIRMED|REPRODUCIBLE|FIXED_VERIFIED/.test(src), 'cause-detail.js still only reads: no write, no network, no process, no status');

    fs.rmSync(tmp, { recursive: true, force: true });
    console.log(failures ? `\n${failures} FAILED` : `\nAll reader-fixes checks passed${skipped ? ` (${skipped} part(s) skipped)` : ''}.`);
    process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
