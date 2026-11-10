#!/usr/bin/env node
// Self-test of TEST-COPY-SPEC 6d-2, the FIDELITY CHECK of a test copy built from a database file (issue/fidelity.js), offline, against the fake `docker`
// (scripts/fixtures/issue/fake-docker.js). No daemon, no network.
//   - compare(): every level (matched, status-only, did-not-match, could-not-test, not-tested)
//   - fatal matching: class OR function name (case, leading backslash) + the file RELATIVE TO wp-content (the real site's root and the sandbox's
//     /var/www/html removed); a line shift alone is not a mismatch; another file or another class is; the copy is compared with the fatal the report
//     calls the CAUSE, never with any fatal in the copy's log; hostile log text stays data
//   - the producer rule (issue/sandbox-phase.js, issue/sandbox-many.js): unless matched / status-only, reproduced_in_sandbox is null (never 'no') and the
//     copy is not bisected; findings statuses and verdicts are then IDENTICAL to a run without a test copy; a matched run keeps 'yes' and the copy log is 'verified'
//   - the report text (gate on only, exact owner wording) and the confirmed sentence that names the checks that actually counted
//   - validate.js, retest.js and fatal-recheck.js are not modified (git), and gate off is unchanged
// The real-container proof is selftest-6d2-docker.js.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-6d2-'));
process.env.PLUGIN_GUARD_ISSUES = path.join(tmp, 'issues');
fs.mkdirSync(process.env.PLUGIN_GUARD_ISSUES, { mode: 0o700 });
const fid = require('../issue/fidelity');
const phase = require('../issue/sandbox-phase');
const store = require('../lib/issue-store');
const caseFile = require('../issue/case-file');
const resultMod = require('../issue/result');
const probe = require('../issue/probe');

let failures = 0;
const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`); if (!c) failures++; };
const group = t => console.log(`\n== ${t}`);
const write = (root, rel, body) => { const f = path.join(root, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, body); return f; };
const ser = list => `a:${list.length}:{${list.map((s, i) => `i:${i};s:${Buffer.byteLength(s)}:"${s}";`).join('')}}`;
const hex = s => Buffer.from(s, 'utf8').toString('hex').toUpperCase();

const CLASS = 'Elementor\\Core\\Schemes\\Color';
const THEME_FILE = 'wp-content/themes/unicamp/elementor/widgets/original/heading.php';
// the real site in a numbered sub-folder, as on the acceptance site (TEST-COPY-SPEC 11); a placeholder root, because the hygiene suite bans real web-root paths
const REAL_ABS = '/var/www/example/82/shop/wp-content/themes/unicamp/elementor/widgets/original/heading.php';
const COPY_ABS = '/var/www/html/wp-content/themes/unicamp/elementor/widgets/original/heading.php';
const REL = 'themes/unicamp/elementor/widgets/original/heading.php';
const MISMATCH = 'The test copy did not show the same problem as your site, so nothing from it is used. The cause stays not confirmed.';
const STATUS_ONLY = 'The test copy showed the same kind of failure (HTTP 5xx on the same page). No error message was available on either side to compare, so this is weaker evidence.';
const NOT_TESTED = 'The test copy could not be compared with your site, because no failing page or error message was available to compare. Nothing from it is used.';
const REASONS = ['different versions', 'missing data', 'server settings', 'calls to outside services'];

// ---- the two sides, built by hand ----
const realOf = ({ pages = [['/', '5xx']], cause = { kind: 'class', name: CLASS, file: REL, line: 48 } } = {}) => ({ failing_pages: pages.map(([p, c]) => ({ path: p, status_class: c })), cause_fatal: cause, home: '/' });
const copyOf = ({ pages = [['/', '5xx']], fatals = [], error = null, built = true, log = true } = {}) => ({ built, error, pages: pages.map(([p, c, l = true]) => ({ path: p, status_class: c, loaded: l })), fatals, log_available: log });
const cls = (name, file, line = 48) => ({ kind: 'class', name, file, line });

(async () => {
    // ================================================================ the levels
    group('compare(): every level');
    const L = (real, copy) => fid.compare({ real, copy });
    let r = L(realOf(), copyOf({ fatals: [cls(CLASS, REL)] }));
    ok(r.level === 'matched' && r.counts === true && r.page === '/' && r.status_class === '5xx' && r.copy_fatal && r.copy_fatal.name === CLASS && r.likely_reasons.length === 0, `same page, same status class, the same fatal -> matched (${r.reasons[0]})`);
    r = L(realOf({ cause: null }), copyOf());
    ok(r.level === 'status-only' && r.counts === true && r.status_class === '5xx', 'same page, same status class, no cause fatal on the real side -> status-only (it counts, labelled weaker)');
    r = L(realOf({ cause: null }), copyOf({ fatals: [cls('Other\\Thing', 'plugins/x/x.php')] }));
    ok(r.level === 'status-only' && !JSON.stringify(r).includes('Other'), 'a fatal in the copy is not compared with anything when the report names no cause: status-only, the copy\'s fatal is not carried');
    r = L(realOf(), copyOf({ pages: [['/', null]], fatals: [cls(CLASS, REL)] }));
    ok(r.level === 'did-not-match' && r.counts === false && JSON.stringify(r.likely_reasons) === JSON.stringify(REASONS) && /the test copy showed no error/.test(r.reasons[0]), `the copy loads fine where the real site fails -> did-not-match with the likely reasons (${r.reasons[0]})`);
    r = L(realOf({ cause: null }), copyOf({ pages: [['/', '4xx']] }));
    ok(r.level === 'did-not-match' && /HTTP 5xx.*HTTP 4xx/.test(r.reasons[0]), 'another status class on the same page -> did-not-match');
    r = L(realOf(), copyOf({ error: 'Docker is not installed or not on PATH.' }));
    ok(r.level === 'could-not-test' && r.counts === false && r.reasons[0] === 'Docker is not installed or not on PATH.', 'the copy did not start -> could-not-test (never "no")');
    r = L(realOf(), copyOf({ pages: [['/', '5xx', false]] }));
    ok(r.level === 'could-not-test' && /could not be loaded/.test(r.reasons[0]), 'the copy could not load its pages -> could-not-test');
    r = L(realOf({ pages: [], cause: null }), copyOf());
    ok(r.level === 'not-tested' && r.counts === false, 'no failing page and no cause fatal on the real side -> not-tested');
    r = L(realOf(), copyOf({ built: false }));
    ok(r.level === 'not-tested' && /not built/.test(r.reasons[0]), 'the copy was not built -> not-tested');
    r = L(realOf({ pages: [['/shop', '5xx']], cause: null }), copyOf({ pages: [['/', null]] }));
    ok(r.level === 'not-tested' && /did not load the page/.test(r.reasons[0]), 'the copy did not load the failing page (and loaded another one fine), no fatal to compare -> not-tested');
    group('a failing page IS known on the real site: matched only on that page (review A)');
    r = L(realOf({ pages: [['/shop', '5xx']] }), copyOf({ pages: [['/', '4xx']], fatals: [cls(CLASS, REL)] }));
    ok(r.level === 'did-not-match' && r.counts === false && /did not load that page and failed on \/ instead/.test(r.reasons[0]), `real /shop 5xx, the copy fails only on another page (4xx) with the same fatal -> did-not-match (${r.reasons[0]})`);
    r = L(realOf({ pages: [['/shop', '5xx']] }), copyOf({ pages: [['/', null]], fatals: [cls(CLASS, REL)] }));
    ok(r.level === 'not-tested' && r.counts === false, 'real /shop 5xx, the copy never loaded /shop (its other page loads fine), the same fatal -> not-tested, never matched');
    r = L(realOf({ pages: [['/shop', '5xx']] }), copyOf({ pages: [['/shop', '5xx'], ['/', '4xx']], fatals: [cls(CLASS, REL)] }));
    ok(r.level === 'matched' && r.page === '/shop', 'real /shop 5xx, the copy /shop 5xx with the same fatal -> matched on /shop');
    r = L(realOf({ pages: [['/shop', '5xx']] }), copyOf({ pages: [['/shop', '4xx']], fatals: [cls(CLASS, REL)] }));
    ok(r.level === 'did-not-match', 'the same page with another status class and the same fatal -> did-not-match');
    group('the copy\'s log could not be read (review C)');
    r = L(realOf(), copyOf({ log: false }));
    ok(r.level === 'could-not-test' && r.counts === false && /log could not be read/.test(r.reasons[0]), `the page matches but the copy's log could not be read -> could-not-test (${r.reasons[0]})`);
    r = L(realOf(), copyOf({ log: true }));
    ok(r.level === 'did-not-match' && /has no error like/.test(r.reasons[0]), 'the log was read and has no such error -> did-not-match');
    group('reasons carry no absolute host path (review D)');
    r = L(realOf(), copyOf({ error: 'copying /home/user/private/site/wp-content/plugins/a/a.php failed; see /home/user/private/notes.txt' }));
    ok(!JSON.stringify(r).includes('/home/') && r.reasons[0].includes('wp-content/plugins/a/a.php') && r.reasons[0].includes('a folder on this computer'), `compare(): ${r.reasons[0]}`);
    const cr = fid.clean({ schema: 1, level: 'could-not-test', reasons: ['failed in /home/user/private/x and /srv/www/real/wp-content/themes/t/f.php'] });
    ok(!JSON.stringify(cr).includes('/home/') && !JSON.stringify(cr).includes('/srv/') && cr.reasons[0] === fid.stripPaths('failed in /home/user/private/x and /srv/www/real/wp-content/themes/t/f.php') && cr.reasons[0].includes('wp-content/themes/t/f.php'), `clean() (what findings.json carries): ${cr.reasons[0]}`);
    r = L(realOf({ pages: [] }), copyOf({ pages: [['/', '5xx']], fatals: [cls(CLASS, REL)] }));
    ok(r.level === 'matched' && r.page === '/', 'no live check on the real site: the cause fatal in the copy\'s log AND a failing copy page -> matched');
    r = L(realOf({ pages: [] }), copyOf({ pages: [['/', null]], fatals: [cls(CLASS, REL)] }));
    ok(r.level === 'did-not-match', 'no live check: the cause fatal in the copy\'s log but every copy page loaded fine -> did-not-match');
    r = L(realOf({ pages: [['/', 'white']], cause: null }), copyOf({ pages: [['/', 'white']] }));
    ok(r.level === 'status-only' && r.status_class === 'white', 'a white screen on both sides is the same status class');
    ok(fid.LEVELS.every(l => typeof l === 'string') && fid.LEVELS.length === 5 && [...fid.COUNTS].sort().join() === 'matched,status-only', 'five levels; only matched and status-only count');

    // ================================================================ fatal matching
    group('fatal matching: name + file relative to wp-content; a line shift alone is not a mismatch');
    ok(fid.normFile(REAL_ABS) === REL && fid.normFile(COPY_ABS) === REL && fid.normFile(THEME_FILE) === REL, `the sub-folder pair of absolute paths (real site in a sub-folder, sandbox /var/www/html) and the clue path all normalise to ${REL}`);
    const realEws = fid.realFrom({ probe: { pages: [{ url: 'https://example.com/shop/', status: 500, loaded: true }] }, hypotheses: { hypotheses: [{ id: 'h1', status: 'PROBABLE_NEEDS_REVIEW', supports: [{ kind: 'log', ref: 'c1' }] }] }, evidence: { clues: [{ id: 'c1', type: 'php-class-not-found', value: CLASS, source: { kind: 'log', ref: 'wp-content/debug.log', line: 1 }, snippet: `Class "${CLASS}" not found in ${REAL_ABS}:48`, detail: {} }, { id: 'c2', type: 'php-location', value: `${THEME_FILE}:48`, source: { kind: 'log', ref: 'wp-content/debug.log', line: 1 }, detail: { file: THEME_FILE, line: 48 } }] }, issue: { url: 'https://example.com/shop/' } });
    ok(realEws.cause_fatal && realEws.cause_fatal.kind === 'class' && realEws.cause_fatal.name === CLASS && realEws.cause_fatal.file === REL && JSON.stringify(realEws.failing_pages) === '[{"path":"/shop","status_class":"5xx"}]' && realEws.home === '/shop', `the real side from the files: the top hypothesis' log clue (class + file) and the probe's failing page (${JSON.stringify(realEws.failing_pages)})`);
    const copyEws = n => fid.copyFrom({ pages: [{ url: 'http://127.0.0.1:38080/', status: 500, loaded: true }], copyLog: { available: true, last_fatals: [{ message: `PHP Fatal error: Uncaught Error: Class "\\${CLASS.toLowerCase()}" not found in ${COPY_ABS.replace('/var/www/html/wp-content/', '')}:${n}`, file: REL, line: n }] } });
    r = fid.compare({ real: realEws, copy: copyEws(48) });
    ok(r.level === 'matched' && r.page === '/shop', `the sub-folder pair: real ${REAL_ABS} vs copy ${COPY_ABS}, class ${CLASS} (copy: lower case, leading backslash; real site in /shop/, copy at /) -> matched`);
    r = fid.compare({ real: realEws, copy: copyEws(52) });
    ok(r.level === 'matched' && r.copy_fatal.line === 52 && r.real_fatal.line === 48, 'the same file on another line (48 vs 52) -> matched');
    const fromMsg = fid.fatalOf(`PHP Fatal error:  Uncaught Error: Class "${CLASS}" not found in ${COPY_ABS}:49`, null, null);
    ok(fromMsg && fromMsg.file === REL && fromMsg.line === 49 && fromMsg.kind === 'class', 'without the parser\'s file field, the file is read from the message and normalised');
    r = L(realOf(), copyOf({ fatals: [cls(CLASS, 'themes/unicamp/elementor/widgets/original/other.php')] }));
    ok(r.level === 'did-not-match' && /same class name in another file/.test(r.reasons[0]) && r.copy_fatal.file.endsWith('other.php'), 'a different file with the same class -> did-not-match (the compared fatal is named)');
    r = L(realOf(), copyOf({ fatals: [cls('Elementor\\Core\\Schemes\\Typography', REL)] }));
    ok(r.level === 'did-not-match' && r.copy_fatal === null, 'a different class in the same file -> did-not-match');
    r = L(realOf({ cause: { kind: 'function', name: 'my_helper', file: 'plugins/plugin-b/plugin-b.php', line: 5 } }), copyOf({ fatals: [{ kind: 'class', name: 'my_helper', file: 'plugins/plugin-b/plugin-b.php', line: 5 }] }));
    ok(r.level === 'did-not-match', 'a class and a function of the same name are different fatals');
    r = L(realOf({ cause: { kind: 'function', name: '\\My_Helper', file: 'plugins/plugin-b/plugin-b.php', line: 5 } }), copyOf({ fatals: [fid.fatalOf('PHP Fatal error: Cannot redeclare my_helper() (previously declared in /var/www/html/wp-content/plugins/plugin-a/plugin-a.php:5) in /var/www/html/wp-content/plugins/plugin-b/plugin-b.php on line 5', null, null)] }));
    ok(r.level === 'matched', 'a function fatal (redeclare): the declaring file, not the "previously declared in" one, is the place; name case and backslash are ignored');
    group('the copy is compared with the fatal the REPORT CALLS THE CAUSE, not with any fatal in the copy\'s log');
    const unrelated = { message: 'PHP Fatal error: Uncaught Error: Class "Acme\\Thing" not found in plugins/plugin-a/plugin-a.php:7', file: 'plugins/plugin-a/plugin-a.php', line: 7 };
    r = fid.compare({ real: realEws, copy: fid.copyFrom({ pages: [{ url: 'http://127.0.0.1:1/', status: 500, loaded: true }], copyLog: { available: true, last_fatals: [unrelated] } }) });
    ok(r.level === 'did-not-match' && r.copy_fatal === null && !JSON.stringify(r).includes('Acme') && /different error/.test(r.reasons[0]), 'the copy log has an unrelated fatal and not the cause -> did-not-match; the unrelated fatal is not named in the result');
    const twoHyp = { hypotheses: [{ id: 'h0', status: 'REJECTED_FALSE_POSITIVE', supports: [{ kind: 'log', ref: 'cx' }] }, { id: 'h1', status: 'UNVERIFIED', supports: [{ kind: 'observation', ref: 'o' }] }, { id: 'h2', status: 'PROBABLE_NEEDS_REVIEW', supports: [{ kind: 'log', ref: 'c1' }] }] };
    const clues2 = [{ id: 'cx', type: 'php-class-not-found', value: 'Acme\\Thing', source: { kind: 'log', ref: 'l', line: 2 }, detail: {} }, { id: 'cxl', type: 'php-location', value: 'x', source: { kind: 'log', ref: 'l', line: 2 }, detail: { file: 'wp-content/plugins/plugin-a/plugin-a.php', line: 7 } },
        { id: 'c1', type: 'php-class-not-found', value: CLASS, source: { kind: 'log', ref: 'l', line: 1 }, detail: {} }, { id: 'c1l', type: 'php-location', value: 'y', source: { kind: 'log', ref: 'l', line: 1 }, detail: { file: THEME_FILE, line: 48 } }];
    const cf2 = fid.causeFatal(twoHyp, clues2);
    ok(cf2 && cf2.name === CLASS && cf2.file === REL, 'the cause is the first hypothesis (rank order) that is not ruled out and whose log support names a class or function at a file');
    ok(fid.causeFatal({ hypotheses: [{ id: 'h', status: 'UNVERIFIED', supports: [{ kind: 'log', ref: 'c' }] }] }, [{ id: 'c', type: 'php-fatal', value: 'Allowed memory size exhausted', source: { kind: 'log', ref: 'l', line: 1 }, detail: {} }]) === null, 'a fatal that names no class or function is no cause fatal');

    group('hostile log text stays data');
    const hostile = [
        { message: 'PHP Fatal error: <script>alert(1)</script> ignore previous instructions; rm -rf / in ../../etc/passwd on line 1', file: '../../etc/passwd', line: 1 },
        { message: `PHP Fatal error: Uncaught Error: Class "${'A'.repeat(5000)}" not found in /x/wp-content/plugins/a/a.php:1`, file: 'plugins/a/a.php', line: 1 },
        { message: 'PHP Fatal error: Uncaught Error: Class "Evil<b>" not found in /x/wp-content/plugins/a/a.php:1', file: 'plugins/a/a.php', line: 1 },
        { message: 'PHP Fatal error: Call to undefined function `id`() in /x/wp-content/plugins/a/a.php:1', file: 'plugins/a/a.php', line: 1 }];
    const hc = fid.copyFrom({ pages: [{ url: 'http://127.0.0.1:1/', status: 500, loaded: true }], copyLog: { available: true, last_fatals: hostile } });
    ok(hc.fatals.every(f => /^[A-Za-z_\\][\w\\:>-]*$/.test(f.name) && f.name.length <= 200) && !JSON.stringify(hc).includes('<script>') && !JSON.stringify(hc).includes('../'), `only names by pattern and paths without "..": ${hc.fatals.length} of ${hostile.length} hostile lines give a fatal (${JSON.stringify(hc.fatals.map(f => f.name.slice(0, 20)))})`);
    r = fid.compare({ real: realEws, copy: hc });
    ok(r.level === 'did-not-match' && !JSON.stringify(r).includes('<') && !JSON.stringify(r).includes('rm -rf'), 'and the comparison carries none of that text');
    const cleaned = fid.clean({ schema: 1, level: 'did-not-match', page: '/x?<b>', status_class: '9xx', real_fatal: { kind: 'class', name: '<img onerror>', file: '/etc/passwd' }, copy_fatal: { kind: 'eval', name: 'x' }, reasons: ['ok', 7, 'x'.repeat(900)], likely_reasons: ['different versions', '<b>'] });
    ok(cleaned && cleaned.status_class === null && cleaned.real_fatal === null && cleaned.copy_fatal === null && cleaned.reasons.length === 2 && cleaned.reasons[1].length === 300 && JSON.stringify(cleaned.likely_reasons) === '["different versions"]', 'clean(): unknown classes, kinds, names and reasons are dropped or cut');
    ok(fid.clean({ schema: 1, level: 'trusted' }) === null && fid.clean({ schema: 2, level: 'matched' }) === null && fid.clean(null) === null, 'clean(): an unknown level or schema is not shown');
    ok(fid.pathOf('https://example.com/shop/?email=a@example.invalid#x') === '/shop' && fid.pathOf('/') === '/', 'a page is its path only (no query string, no fragment)');

    // ================================================================ reader text
    group('the reader\'s words (exact owner wording)');
    ok(fid.readerText({ schema: 1, level: 'did-not-match', likely_reasons: REASONS }).line === MISMATCH && JSON.stringify(fid.readerText({ schema: 1, level: 'did-not-match', likely_reasons: REASONS }).reasons) === JSON.stringify(REASONS), 'did-not-match: the sentence, then the four likely reasons');
    ok(fid.readerText({ schema: 1, level: 'status-only', status_class: '5xx' }).line === STATUS_ONLY, 'status-only (5xx): exact sentence');
    ok(fid.readerText({ schema: 1, level: 'status-only', status_class: '4xx' }).line === STATUS_ONLY.replace('5xx', '4xx'), 'status-only: the real status class in place of 5xx');
    ok(fid.readerText({ schema: 1, level: 'not-tested' }).line === NOT_TESTED, 'not-tested: exact sentence');
    ok(fid.readerText({ schema: 1, level: 'could-not-test', reasons: ['Docker is not installed or not on PATH. Static-only mode: not reproduced.'] }).line === 'The test copy could not be started (Docker is not installed or not on PATH), so no test was done. This does not mean the problem is absent.', 'could-not-test: one plain sentence of the failure text in the brackets');
    ok(fid.readerText({ schema: 1, level: 'could-not-test', reasons: ['copying failed at /home/user/sites/x/wp-content/plugins/a/a.php and /home/user/private/notes'] }).line.includes('wp-content/plugins/a/a.php and a folder on this computer'), 'could-not-test: an absolute host path is not shown (a wp-content path is kept relative)');
    ok(fid.readerText({ schema: 1, level: 'matched' }) === null, 'matched: no extra sentence (the "How sure" lines say it)');

    // ================================================================ the confirmed sentence
    group('the confirmed sentence names the checks that actually counted; the copy only when it contributed');
    const mkF = (kinds, status = 'REPRODUCIBLE') => ({ issue: { title: 't' }, findings: [{ id: 'h1', label: 'plugin-plugin', status, cause: 'the cause', components: [], evidence: [] }], hypotheses: [{ id: 'h1', independent_kinds: kinds }], advisories: [] });
    const sureOf = (kinds, fidelity, sbx = 'yes') => ((caseFile.build(mkF(kinds), { comps: [], facts: { sandboxReproduced: sbx, hasCode: true }, fidelity }).cases[0].rows.find(x => x[0] === 'How sure') || [])[1] || []);
    const M = fid.clean({ schema: 1, level: 'matched' }), S = fid.clean({ schema: 1, level: 'status-only', status_class: '5xx' }), D = fid.clean({ schema: 1, level: 'did-not-match' });
    ok(sureOf(['bisect', 'log'], M)[0] === 'Confirmed by two independent checks: your log, and a test on a copy of your site.', `matched + the bisect kind counted: "${sureOf(['bisect', 'log'], M)[0]}"`);
    ok(sureOf(['bisect', 'log', 'probe'], S)[0] === 'Confirmed by three independent checks: your log, the live page, and a test on a copy of your site.', 'status-only + bisect + log + probe: three, the copy named last');
    // the producer writes reproduced_in_sandbox null when the copy did not count: the sentence then has no copy part at all (review B)
    for (const lv of ['did-not-match', 'could-not-test', 'not-tested']) {
        const sx = sureOf(['bisect', 'log'], fid.clean({ schema: 1, level: lv }), null)[0];
        ok(sx === 'Confirmed by two independent checks.' && !/test copy|copy of your site/.test(sx), `${lv} (reproduced_in_sandbox null): "${sx}" (no "Not yet tested on a copy" next to the fidelity sentence)`);
    }
    ok(sureOf(['bisect', 'log'], null, null)[0] === 'Confirmed by two independent checks. Not yet tested on a copy of your site.', 'no test copy at all: the existing text, unchanged');
    ok(sureOf(['log', 'observation'], M)[0] === caseFile.confirmedSentence(2, 'yes'), 'matched but the bisect kind did not count for this hypothesis: the existing sentence');
    ok(sureOf(['bisect', 'log'], null)[0] === caseFile.confirmedSentence(2, 'yes'), 'no fidelity result (a build without a database file): the existing sentence, unchanged');
    ok(caseFile.countedChecks(['bisect'], M) === null && caseFile.countedChecks(['bisect', 'description'], M) === null, 'the copy alone is not "two independent checks": the existing sentence');

    // ================================================================ status block rendering + gate off
    group('the status block: Markdown, command line and page (gate on only)');
    const cfM = caseFile.build(mkF(['log']), { comps: [], facts: {}, fidelity: D });
    const md = caseFile.markdown(cfM, t => String(t)).join('\n'), cl = caseFile.cli({ ...cfM, checked: null });
    ok(cfM.status.fidelity && cfM.status.fidelity.line === MISMATCH && md.includes(MISMATCH) && REASONS.every(x => md.includes(`- ${x}`)) && cl.includes(MISMATCH) && REASONS.every(x => cl.includes(`- ${x}`)), 'the mismatch sentence and the likely reasons as a short list, in Markdown and on the command line');
    ok(!caseFile.build(mkF(['log']), { comps: [], facts: {}, fidelity: M }).status.fidelity && !caseFile.build(mkF(['log']), { comps: [], facts: {} }).status.fidelity, 'matched, or no fidelity result: no status sentence');
    const gate = fs.readFileSync(path.join(__dirname, '..', 'lib', 'issue-html-gate.js'), 'utf8');
    ok(/CF\.status\.fidelity/.test(gate) && !/innerHTML/.test(gate.split('CF.status.fidelity')[1].split('\n')[0]), 'the page renders it through textContent (lib/issue-html-gate.js), no innerHTML');

    // ================================================================ the pipeline on the fake docker
    const SQL = write(tmp, 'in/site.sql', fs.readFileSync(path.join(__dirname, 'fixtures', 'issue', 'dump', 'tiny.sql.txt')));
    const TABLES = 'Tables_in_wordpress\npgf_options\npgf_users\npgf_usermeta\npgf_posts\npgf_postmeta\npgf_comments\n';
    const wpRules = [{ match: 'db query', stdin: 'SHOW TABLES', out: TABLES }, { match: 'db query', stdin: "option_name = 'siteurl'", out: 'option_value\nhttps://shop.example.com\n' }, { match: 'db query', stdin: "option_name = 'home'", out: 'option_value\nhttps://shop.example.com\n' },
        { match: 'db query', stdin: 'AS pg_admin FROM', out: 'pg_admin\n1\n' }, { match: 'db query', stdin: 'AS pg_admins FROM', out: 'pg_admins\n1\n' }, { match: 'db query', stdin: 'AS pg_active FROM', out: `pg_active\n${hex(ser(['elementor/elementor.php']))}\n` },
        { match: 'plugin list', out: 'elementor\n' }, { match: 'theme list', out: 'unicamp\ntwentytwentysix\n' }, { match: 'option get stylesheet', out: 'unicamp\n' }];
    let nFake = 0;
    function fakeEnv(fake = {}) {
        const dir = path.join(tmp, `fake-${++nFake}`); fs.mkdirSync(dir, { recursive: true });
        fs.copyFileSync(path.join(__dirname, 'fixtures', 'issue', 'fake-docker.js'), path.join(dir, 'docker')); fs.chmodSync(path.join(dir, 'docker'), 0o755);
        const sbx = path.join(tmp, `sbx-${nFake}`); fs.mkdirSync(sbx, { recursive: true, mode: 0o700 });
        fs.writeFileSync(path.join(dir, 'fake.json'), JSON.stringify(fake));
        return { dir, opts: (extra = {}) => ({ dockerBin: path.join(dir, 'docker'), sandboxesRoot: sbx, env: { PATH: process.env.PATH, HOME: process.env.HOME }, pageCheck: () => ({ status: 200 }), ...extra }),
            state: () => { try { return JSON.parse(fs.readFileSync(path.join(dir, 'fake.state.json'), 'utf8')); } catch { return { containers: [], volumes: [], networks: [] }; } } };
    }
    const leftovers = F => { const s = F.state(); return s.containers.length + s.volumes.length + s.networks.length; };
    // the acceptance-like site (TEST-COPY-SPEC 11): a theme file calls an Elementor class that the installed Elementor does not have; the log has the fatal twice
    function classSite(root) {
        write(root, 'wp-includes/version.php', "<?php\n$wp_version = '6.8.1';\n"); write(root, 'wp-config.php', '<?php\n');
        write(root, 'wp-content/plugins/elementor/elementor.php', '<?php\n/**\n * Plugin Name: Elementor\n * Version: 3.35.7\n */\nnamespace Elementor;\nclass Plugin {}\n');
        write(root, 'wp-content/themes/unicamp/style.css', '/*\nTheme Name: Unicamp\nVersion: 1.0\n*/');
        write(root, THEME_FILE, '<?php\n' + '// filler\n'.repeat(46) + `$c = \\${CLASS}::get_type();\n`);
        const one = t => `[${t} UTC] PHP Fatal error:  Uncaught Error: Class "${CLASS}" not found in ${root}/${THEME_FILE}:48\nStack trace:\n#0 {main}\n  thrown in ${root}/${THEME_FILE} on line 48\n`;
        write(root, 'wp-content/debug.log', one('06-Nov-2026 09:00:00') + one('06-Nov-2026 09:00:59'));
    }
    const NOW = '2026-11-06T09:01:00.000Z';
    // one investigation: evidence + analysis, the live probe's observation (HTTP 500 on /), the sandbox phase (or none), validation and the gate report
    async function pipeline(name, { sandbox = null, copyStatus = 500, copyLog = null, oracle = 'yes', bisect = false } = {}) {
        const root = path.join(tmp, 'pipe-' + name, 'wp'); classSite(root);
        const config = path.join(root, 'plugin-guard.config.json'); fs.writeFileSync(config, '{}');
        const iss = store.create({ title: 'Critical error', description: 'The site shows a critical error', symptom: 'white-screen', environment: 'local', url: 'http://127.0.0.1:9/', root, pages: ['/'] });
        const dir = store.dirOf(iss.id);
        await require('../issue/evidence').run(iss.id, { root, probeOptions: { probe: false } });
        const anz = require('../issue/analysis').run(iss.id, { root, config });
        const ij = path.join(dir, 'issue.json'), j = JSON.parse(fs.readFileSync(ij, 'utf8')); j.probe_ran_at = NOW; fs.writeFileSync(ij, JSON.stringify(j));
        fs.writeFileSync(path.join(dir, 'work', 'probe.json'), JSON.stringify({ schema: 1, pages: [{ url: 'http://127.0.0.1:9/', status: 500, viewport: { name: 'laptop' }, loaded: true }] }));
        let sb = null, F = null;
        if (sandbox) {
            F = fakeEnv({ wp: wpRules });
            const real = probe.runSandbox;
            probe.runSandbox = async (id, o) => { if (copyLog) fs.appendFileSync(path.join(o.stateDir, '..', 'logs', 'debug.log'), copyLog); return { ok: true, pages: [{ url: `${o.url}/`, status: copyStatus, loaded: true, viewport: { name: 'laptop' }, text_flags: { blank: false, critical: false } }], status_codes: [copyStatus], oracle: { result: oracle } }; };
            try { sb = await phase.run(iss.id, { root, options: { sandbox: true, noBisect: !bisect, ...(sandbox === 'dump' ? { dump: SQL } : {}) }, analysis: { ...anz.analysis, components: anz.analysis.components, top: anz.analysis.top }, sandboxOptions: F.opts() }); } finally { probe.runSandbox = real; }
        } else sb = await phase.run(iss.id, { root, options: {}, analysis: anz.analysis });
        const validate = require('../issue/validate'), resolve = require('../issue/resolve');
        const val = validate.run(iss.id, { root, config, lint: () => ({ ok: true, message: '' }) }), pol = validate.policyFor(root, config);
        resultMod.write(iss.id, { validation: val, plans: resolve.build(iss.id, val, { root, policy: pol, dir }), dir, root, policy: pol, gate: true });
        const rd = f => { try { return JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { return null; } };
        return { id: iss.id, dir, sb, val, F, f: rd('result/findings.json'), sbx: rd('work/sandbox.json'), fd: rd('work/fidelity.json'), cl: rd('work/copy-log.json'), md: fs.readFileSync(path.join(dir, 'result', 'ISSUE-REPORT.md'), 'utf8'), html: fs.readFileSync(path.join(dir, 'result', 'issue.html'), 'utf8') };
    }
    const COPY_FATAL = n => `[06-Nov-2026 10:00:0${n} UTC] PHP Fatal error:  Uncaught Error: Class "${CLASS}" not found in ${COPY_ABS}:49\nStack trace:\n#0 {main}\n  thrown in ${COPY_ABS} on line 49\n`;
    const UNRELATED = '[06-Nov-2026 10:00:05 UTC] PHP Fatal error:  Uncaught Error: Class "Zq\\Unrelated\\Thing" not found in /var/www/html/wp-content/plugins/elementor/elementor.php:7\n';

    group('pipeline (fake docker): a copy that DID NOT MATCH writes null and changes no status or verdict');
    const none = await pipeline('none');
    const miss = await pipeline('miss', { sandbox: 'dump', copyStatus: 200, oracle: 'no', copyLog: UNRELATED });
    ok(none.sbx && none.sbx.reproduced_in_sandbox === null && !none.fd && !('fidelity' in (none.f.sandbox || {})), 'the run without a test copy: reproduced_in_sandbox null, no fidelity result');
    ok(miss.sb.reproduced_in_sandbox === null && miss.sbx.reproduced_in_sandbox === null && miss.sbx.baseline && miss.sbx.baseline.result === 'no', `the copy loads (HTTP 200) where the site fails and its log has an unrelated fatal: reproduced_in_sandbox is null, NOT "no" (the oracle said "${miss.sbx.baseline && miss.sbx.baseline.result}")`);
    ok(miss.fd && miss.fd.level === 'did-not-match' && (fs.statSync(path.join(miss.dir, 'work', 'fidelity.json')).mode & 0o777) === 0o600 && miss.sbx.fidelity && miss.sbx.fidelity.level === 'did-not-match', 'work/fidelity.json (0600) and sandbox.json carry did-not-match');
    ok(miss.f.sandbox.fidelity && miss.f.sandbox.fidelity.level === 'did-not-match' && miss.f.sandbox.fidelity.real_fatal.name === CLASS && miss.f.sandbox.fidelity.real_fatal.file === REL && !JSON.stringify(miss.f.sandbox.fidelity).includes('Unrelated'), 'findings.json sandbox.fidelity: level, the compared cause fatal (relative path), no unrelated copy fatal');
    ok(miss.cl && miss.cl.label === 'unverified' && miss.f.sandbox.copy_log.label === 'unverified', 'the copy log stays "unverified"');
    ok(miss.sb.bisect === null && !fs.existsSync(path.join(miss.dir, 'work', 'bisect.json')) && miss.sbx.steps.some(s => s.id === 'sandbox-fidelity' && s.level === 'did-not-match'), 'no bisection on a copy that did not match; the fidelity step is in the timeline');
    // stripped: the sandbox block, the timeline and the reader texts built from it (tested_text counts the steps), and fatal_recheck.provider.active:
    // that one is the DATABASE's own active-plugin list (read from the dump, not something the copy showed), which issue/fatal-recheck.js reads from
    // sandbox.json `baseline`; it changes no rule and no status (checked right below)
    const STRIP = new Set(['generated_at', 'sandbox', 'timeline', 'not_tested', 'not_tested_text', 'case_file', 'summary', 'limits_text', 'tested_text', 'fidelity']);
    const strip = (f, id) => JSON.parse(JSON.stringify(f, function (k, v) { return STRIP.has(k) || (k === 'active' && this && 'installed' in this && 'known' in this) ? undefined : v; }).split(id).join('ISSUE'));
    const A = strip(none.f, none.id), B = strip(miss.f, miss.id);
    const diff = Object.keys(A).filter(k => JSON.stringify(A[k]) !== JSON.stringify(B[k]));
    ok(diff.length === 0, `findings.json is identical to the run without a test copy, except the sandbox, timeline and report-text fields and the provider's active flag${diff.length ? ` (differs: ${diff.join(', ')})` : ''}`);
    ok(JSON.stringify(none.f.verdict) === JSON.stringify(miss.f.verdict) && JSON.stringify(none.val.hypotheses.map(h => [h.status, h.independent_kinds])) === JSON.stringify(miss.val.hypotheses.map(h => [h.status, h.independent_kinds])) && none.val.symptom_reproduced === miss.val.symptom_reproduced, `verdict, statuses, independent kinds and symptom_reproduced are equal (${none.f.verdict.label}; ${miss.val.hypotheses.map(h => h.status).join(', ')})`);
    ok(miss.md.includes(MISMATCH) && REASONS.every(x => miss.md.includes(`- ${x}`)) && !none.md.includes(MISMATCH), 'ISSUE-REPORT.md: the mismatch sentence and the likely reasons; not in the run without a copy');
    ok(!/independent checks: [^.]*a test on a copy of your site/.test(miss.md) && !/Reproduced on a test copy/.test(miss.md), 'the report does not claim that the copy counted');
    ok(!/Not yet tested on a copy/.test(miss.md) && !/Not yet tested on a copy/.test(JSON.stringify(miss.f.case_file)), 'no "Not yet tested on a copy" text together with the fidelity sentence (Markdown and case file)');
    ok(/"fidelity":\{"line":"The test copy did not show the same problem/.test(miss.html) && /CF\.status\.fidelity/.test(miss.html) && !/<script>alert/.test(miss.html), 'issue.html carries the sentence (embedded data) and renders it (gate patch)');
    ok(miss.F && leftovers(miss.F) === 0, 'the sandbox was torn down');

    group('pipeline: a copy that MATCHED keeps "yes" and its log becomes "verified"');
    const hit = await pipeline('hit', { sandbox: 'dump', copyStatus: 500, oracle: 'yes', copyLog: UNRELATED + COPY_FATAL(1) + COPY_FATAL(2) });
    ok(hit.sb.reproduced_in_sandbox === 'yes' && hit.sbx.reproduced_in_sandbox === 'yes' && hit.fd.level === 'matched' && hit.fd.page === '/' && hit.fd.status_class === '5xx', `same page (/), same status class (5xx), the same fatal on line 49 instead of 48: matched, reproduced "yes" (${hit.fd.reasons[0]})`);
    ok(hit.cl.label === 'verified' && hit.f.sandbox.copy_log.label === 'verified' && hit.f.sandbox.fidelity.level === 'matched' && hit.f.sandbox.fidelity.copy_fatal.line === 49, 'work/copy-log.json and findings.json sandbox.copy_log are "verified"; findings.json sandbox.fidelity names the matched fatal');
    ok(!hit.md.includes(MISMATCH) && !hit.md.includes(NOT_TESTED), 'no mismatch / not-tested sentence');
    ok(hit.F && leftovers(hit.F) === 0, 'torn down');

    group('pipeline: the same class in another file of the copy -> did not match');
    const other = await pipeline('other', { sandbox: 'dump', copyLog: COPY_FATAL(1).split(COPY_ABS).join('/var/www/html/wp-content/themes/unicamp/elementor/widgets/original/other.php') });
    ok(other.fd.level === 'did-not-match' && other.sbx.reproduced_in_sandbox === null && other.cl.label === 'unverified', 'did-not-match, null, the copy log stays unverified (the oracle said "yes", the bisection is not run)');
    ok(other.sbx.steps.some(s => s.id === 'bisect' && /did not show the same problem/.test(s.reason || '')), 'the bisection step says why it was not run');

    group('pipeline: no copy log in the copy and HTTP 500 on the same page, the site names a cause -> could not test');
    const nolog = await pipeline('nolog', { sandbox: 'dump', copyLog: null });
    ok(nolog.fd.level === 'could-not-test' && /could not be read/.test(nolog.fd.reasons[0]) && nolog.sbx.reproduced_in_sandbox === null, `could-not-test, null (${nolog.fd.reasons[0]})`);

    group('pipeline: a build WITHOUT a database file has no fidelity check (unchanged)');
    const nodump = await pipeline('nodump', { sandbox: 'nodump', copyStatus: 200, oracle: 'no' });
    ok(nodump.sbx.reproduced_in_sandbox === 'no' && !nodump.fd && !('fidelity' in nodump.sbx) && !('fidelity' in nodump.f.sandbox) && !nodump.cl && !nodump.sbx.steps.some(s => s.id === 'sandbox-fidelity'), 'reproduced_in_sandbox "no" as before, no fidelity.json, no field, no step');

    group('pipeline: Docker unusable with a database file -> could not test (never "no")');
    {
        const root = path.join(tmp, 'pipe-nodocker', 'wp'); classSite(root);
        const iss = store.create({ title: 'x', description: 'x', symptom: 'white-screen', environment: 'local', root, pages: ['/'] });
        const F = fakeEnv({ info: { fail: true } });
        const r0 = await phase.run(iss.id, { root, options: { sandbox: true, dump: SQL }, analysis: { components: [], top: [] }, sandboxOptions: F.opts() });
        const fd = JSON.parse(fs.readFileSync(path.join(store.dirOf(iss.id), 'work', 'fidelity.json'), 'utf8'));
        const t = fid.readerText(fd);
        ok(r0.reproduced_in_sandbox === null && fd.level === 'could-not-test' && /^The test copy could not be started \(.+\), so no test was done\. This does not mean the problem is absent\.$/.test(t.line), `could-not-test: "${t.line}"`);
        // the hostile reason path: a failure text with markup is escaped in the Markdown report, never markup in the page
        const sbj = path.join(store.dirOf(iss.id), 'work', 'sandbox.json'), sj = JSON.parse(fs.readFileSync(sbj, 'utf8'));
        sj.fidelity = { ...sj.fidelity, reasons: ['<img src=x onerror=alert(1)> failed in /home/user/secret/folder'] }; fs.writeFileSync(sbj, JSON.stringify(sj));
        const validate = require('../issue/validate'), val = validate.run(iss.id, { root, lint: () => ({ ok: true, message: '' }) });
        resultMod.write(iss.id, { validation: val, plans: [], dir: store.dirOf(iss.id), root, policy: null, gate: true });
        const md2 = fs.readFileSync(path.join(store.dirOf(iss.id), 'result', 'ISSUE-REPORT.md'), 'utf8'), html2 = fs.readFileSync(path.join(store.dirOf(iss.id), 'result', 'issue.html'), 'utf8');
        ok(md2.includes('\\<img src=x onerror=alert(1)> failed in a folder on this computer') && !md2.includes('/home/user/'), 'a hostile failure text is escaped in the Markdown report and the host path is not shown');
        ok(!html2.includes('<img src=x') && html2.includes('\\u003cimg src=x'), 'and it is embedded as data in issue.html (no markup)');
    }

    group('gate off: findings.json carries the result, the classic report has no new text');
    {
        const f0 = resultMod.build(miss.id, { validation: miss.val, plans: [], dir: miss.dir, gate: false });
        const m0 = resultMod.markdown(f0);
        ok(f0.sandbox.fidelity.level === 'did-not-match' && !f0.case_file && !m0.includes(MISMATCH) && !m0.includes('Likely reasons'), 'gate off: sandbox.fidelity in findings.json only; no reader sentence (the existing gate-off golden files are checked by selftest-gate-output.js)');
    }

    // ================================================================ sandbox-many (guard:auto)
    group('one shared sandbox (sandbox-many.js) with a database file: the same producer rule');
    {
        const root = path.join(tmp, 'many', 'wp'); classSite(root);
        const mk = n => store.create({ title: `many ${n}`, description: 'x', symptom: 'white-screen', environment: 'local', url: 'http://127.0.0.1:9/', root, pages: ['/'] });
        const A2 = mk(1), B2 = mk(2);
        // A: the real site failed with HTTP 500 on / (probe.json); B: nothing known about the real site
        fs.writeFileSync(path.join(store.dirOf(A2.id), 'work', 'probe.json'), JSON.stringify({ schema: 1, pages: [{ url: 'http://127.0.0.1:9/', status: 500, viewport: { name: 'laptop' }, loaded: true }] }));
        const F = fakeEnv({ wp: wpRules });
        let loads = 0;
        const out = await require('../issue/sandbox-many').runMany([A2.id, B2.id], { root, options: { dump: SQL, noBisect: true }, sandboxOptions: F.opts(), observe: async ({ base, pages, vp }) => { loads++; return { ok: true, planned: pages.length * vp.length, protection: null, login: null, pagesFull: vp.flatMap(v => pages.map(u => ({ url: u, viewport: { name: v.name, width: v.width }, loaded: true, status: 500, text: 'There has been a critical error on this website.', console_errors: [], page_errors: [], error_responses: [] }))) }; } });
        const fA = JSON.parse(fs.readFileSync(path.join(store.dirOf(A2.id), 'work', 'fidelity.json'), 'utf8')), fB = JSON.parse(fs.readFileSync(path.join(store.dirOf(B2.id), 'work', 'fidelity.json'), 'utf8'));
        ok(fA.level === 'status-only' && out.per[A2.id].reproduced_in_sandbox === 'yes', `issue A (HTTP 500 on / on both sides, no cause fatal named): status-only, it counts, "${out.per[A2.id].reproduced_in_sandbox}"`);
        ok(fB.level === 'not-tested' && out.per[B2.id].reproduced_in_sandbox === null && out.per[B2.id].bisect === null, 'issue B (nothing known about the real site): not-tested, reproduced_in_sandbox null');
        const sB = JSON.parse(fs.readFileSync(path.join(store.dirOf(B2.id), 'work', 'sandbox.json'), 'utf8'));
        ok(sB.reproduced_in_sandbox === null && sB.fidelity && sB.fidelity.level === 'not-tested' && sB.steps.some(s => s.id === 'sandbox-fidelity'), 'and its sandbox.json says so (the last write, after the teardown)');
        ok(leftovers(F) === 0 && loads === 1, `torn down; one shared page load (${loads})`);
    }

    // ================================================================ the owners of the verdicts
    group('validate.js reads null as "no sandbox evidence"; the verdict owners are not modified');
    const vsrc = fs.readFileSync(path.join(__dirname, '..', 'issue', 'validate.js'), 'utf8');
    ok(/sbx && sbx\.reproduced_in_sandbox === 'yes' \? 'yes' : sbx && sbx\.reproduced_in_sandbox === 'no' \? 'no' : \(hyp\.symptom_reproduced/.test(vsrc) && /bisectOk = !!cause && symptom !== 'no' && sbx && sbx\.reproduced_in_sandbox === 'yes'/.test(vsrc), 'validate.js: null falls through to the analysis\' own answer (as without a sandbox) and the bisect kind needs "yes"');
    const git = spawnSync('git', ['-C', path.join(__dirname, '..'), 'diff', '--quiet', 'HEAD', '--', 'issue/validate.js', 'issue/retest.js', 'issue/fatal-recheck.js'], { encoding: 'utf8' });
    if (git.error || git.status > 1) console.log('SKIP  validate.js / retest.js / fatal-recheck.js unmodified: git is not available here (nothing claimed)');
    else ok(git.status === 0, 'issue/validate.js, issue/retest.js and issue/fatal-recheck.js have no change against HEAD');
    const nodeps = ['issue/fidelity.js'].every(f => !/require\((['"])(?!\.{1,2}\/)(?!fs|path)/.test(fs.readFileSync(path.join(__dirname, '..', f), 'utf8')));
    ok(nodeps && !/require\((['"])(?:https?|net|dns|tls|child_process)\1\)|\bfetch\(/.test(fs.readFileSync(path.join(__dirname, '..', 'issue', 'fidelity.js'), 'utf8')), 'issue/fidelity.js: no package, no network, no child process');

    fs.rmSync(tmp, { recursive: true, force: true });
    console.log(failures ? `\n${failures} FAILED` : '\nAll checks passed');
    process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
