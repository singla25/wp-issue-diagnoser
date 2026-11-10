#!/usr/bin/env node
// Self-test of TEST-COPY-SPEC 6d-3 and the owner-approved 'Same fatal required' rule, offline (the fake `docker`, scripts/fixtures/issue/fake-docker.js; no daemon).
//   - 'Same fatal required': "NOT A PLUGIN CONFLICT" only when the no-plugin step of the bisection shows the SAME fatal as the reported cause; a different
//     fatal -> no banner and the "different error" sentence; no fatal recorded -> the "unknown error" sentence. Old bisect.json files render as before.
//   - issue/fidelity.js whole-segment fixes: 'wp-content' only as a whole path segment; pages compared by normalised path + query, never a bare suffix
//   - the report levels (1 tested on a copy, 2 not tested on a copy with what is missing, 3 the test copy could not confirm this), gate on only
//   - the "How close the copy is" box (Matched / Did not match / Not known / Not covered in this version) and no "Not looked at: nothing" next to it
//   - the wizard: no [y/N] deeper-test question; ONE optional question (the database file); the copy is built without asking with a file, Docker and a
//     site that is not live, after the exact notice with the time estimate; --no-replica switches it off; never for a live site
//   - the copy's own log as the report's log only after the fidelity check matched ("from a test copy of your site"), else the guided steps stay

const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const { PassThrough } = require('stream');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-6d3-'));
process.env.PLUGIN_GUARD_ISSUES = path.join(tmp, 'issues');
fs.mkdirSync(process.env.PLUGIN_GUARD_ISSUES, { mode: 0o700 });
const PG = path.join(__dirname, '..');
const fid = require('../issue/fidelity');
const phase = require('../issue/sandbox-phase');
const bisect = require('../issue/bisect');
const resultMod = require('../issue/result');
const caseFile = require('../issue/case-file');
const dumpIntake = require('../lib/dump-intake');
const store = require('../lib/issue-store');
const wizard = require('../lib/wizard');
const probe = require('../issue/probe');
const guard = require('./guard');
const trees = require('./fixtures/issue/trees');

let failures = 0;
const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`); if (!c) failures++; };
const group = t => console.log(`\n== ${t}`);
const write = (root, rel, body) => { const f = path.join(root, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, body); return f; };
const occurrences = (text, needle) => text.split(needle).length - 1;
const clone = x => JSON.parse(JSON.stringify(x));

const CAUSE = { kind: 'class', name: 'Elementor\\Core\\Schemes\\Color', file: 'themes/unicamp/elementor/widgets/heading.php', line: 48 };
const SAME = { ...CAUSE, line: 49 };   // a line shift alone is the same fatal
const OTHER = { kind: 'class', name: 'Zq\\Unrelated\\Thing', file: 'plugins/elementor/elementor.php', line: 7 };
const P = ['akismet', 'elementor', 'woocommerce'];

// a fake tester in the shape of sandbox-phase.js makeTester: one history entry per call, in call order
function fakeTester(result, fatalsFor, fiveFor = () => true) {
    async function test(set) { const rec = { fatals: fatalsFor(set), five: fiveFor(set) }; try { return result(set); } finally { test.history.push(rec); } }
    test.history = [];
    return test;
}
// the producer's way (sandbox-phase.js / sandbox-many.js): bareCheckFor(history) is handed to bisect.run, annotateBisect adds the fatals afterwards
async function bisectWith({ oracleType = 'http-5xx', cause = CAUSE, bareFatals, five = () => true, result = () => 'fail', mu = [] }) {
    const t = fakeTester(result, s => (s.plugins.length === 0 && s.theme === null && s.mu === null ? bareFatals : [SAME]), five);
    await t({ plugins: P, theme: null, mu: null });   // the baseline call of the producer, before the bisection
    const k0 = t.history.length;
    const res = await bisect.run({ plugins: P, mu, test: t, bareCheck: phase.bareCheckFor(t.history, { oracleType, cause }) });
    return phase.annotateBisect(res, { steps: t.history.slice(k0) });
}
const noConclusion = r => r.status === 'inconclusive' && !r.causes.length && r.theme === null && r.mu === null && !r.necessary.length;

(async () => {
    // ================================================================ 'Same fatal required'
    group("'Same fatal required': NOT A PLUGIN CONFLICT only with the same fatal in the no-plugin step");
    const same = await bisectWith({ bareFatals: [SAME] });
    ok(same.symptom_without_plugins === true && !('bare_different_failure' in same) && same.status !== 'inconclusive', `http-5xx, the no-plugin step logs the SAME fatal (another line): unchanged, symptom_without_plugins true (${same.status})`);
    ok(phase.bisectBanner(same).startsWith('NOT A PLUGIN CONFLICT') && /not plugin-related/.test(same.log.join('\n')), 'and the banner path is the old one (step banner, bisect.log "not plugin-related")');
    const diff = await bisectWith({ bareFatals: [OTHER], mu: ['hosting-agent'] });
    ok(diff.symptom_without_plugins === false && diff.bare_different_failure === true && noConclusion(diff), `a DIFFERENT fatal: status inconclusive, no cause, no theme, must-use, core, database or server conclusion (${diff.status}, ${diff.loads} loads)`);
    ok(diff.log.join('\n').includes(resultMod.BARE_DIFFERENT) && !/not plugin-related|core, the database|theme: /.test(diff.log.join('\n')) && /== result: inconclusive/.test(diff.log.join('\n')), 'bisect.log says the new sentence instead of "not plugin-related", and nothing about the theme or core');
    ok(!/NOT A PLUGIN CONFLICT/.test(phase.bisectBanner(diff)) && phase.bisectBanner(diff).trim() === resultMod.BARE_DIFFERENT && phase.bisectCause(diff) === 'no cause is named', `the step note: "${resultMod.BARE_DIFFERENT}" and "no cause is named"`);
    const none = await bisectWith({ bareFatals: [] });
    ok(none.bare_different_failure === 'unknown' && noConclusion(none) && none.log.join('\n').includes(resultMod.BARE_UNKNOWN) && phase.bisectBanner(none).trim() === resultMod.BARE_UNKNOWN, `no fatal recorded: inconclusive with the unknown wording ("${resultMod.BARE_UNKNOWN}")`);
    const noCause = await bisectWith({ bareFatals: [OTHER], cause: null });
    ok(noCause.bare_different_failure === 'unknown' && noConclusion(noCause), 'no reported cause to compare with: inconclusive, unknown (never "not a plugin conflict")');
    const bareTest = diff.tests.find(t => !t.plugins.length && t.theme === null && t.mu === null);
    ok(bareTest && JSON.stringify(bareTest.fatals) === JSON.stringify([OTHER]) && diff.tests.every(t => Array.isArray(t.fatals)) && diff.tests.filter(t => t.plugins.length).every(t => JSON.stringify(t.fatals) === JSON.stringify([SAME])), 'every bisect test carries its own fatals (class/function, file relative to wp-content, line), aligned with tests[] after the producer\'s baseline call');
    const diff2 = await bisectWith({ bareFatals: [OTHER], mu: ['hosting-agent'] });
    ok(JSON.stringify(diff2) === JSON.stringify(diff), 'deterministic: a second run gives the identical result and log');
    const js = await bisectWith({ oracleType: 'console-error', bareFatals: [] });
    ok(js.symptom_without_plugins === true && !('bare_different_failure' in js) && js.status !== 'inconclusive', 'a console-error oracle (a specific symptom, not "any 5xx"): unchanged');
    const gen = await bisectWith({ oracleType: 'generic', bareFatals: [], five: () => false });
    ok(gen.symptom_without_plugins === true && gen.status !== 'inconclusive', 'generic without a 5xx page in the no-plugin step: unchanged');
    const gen5 = await bisectWith({ oracleType: 'generic', bareFatals: [OTHER] });
    ok(gen5.bare_different_failure === true && noConclusion(gen5), 'generic WITH a 5xx page in the no-plugin step and a different fatal: inconclusive');
    const plug = await bisectWith({ bareFatals: [OTHER], result: s => (s.plugins.includes('elementor') ? 'fail' : 'pass') });
    ok(plug.status === 'cause-found' && !('bare_different_failure' in plug), 'a real plugin cause (the no-plugin step passes): unchanged, the check is not even asked');
    ok((await bisect.run({ plugins: P, test: async () => 'fail' })).status === 'not-explained', 'without a bareCheck (unit callers, older producers) the bisection is exactly as before');

    group('no hypothesis comes from an inconclusive bisection');
    {
        const evidence = require('../issue/evidence'), analysis = require('../issue/analysis');
        const root = path.join(tmp, 'hyp', 'wp'); const cfg = trees.duplicateFunction(root);
        fs.writeFileSync(path.join(root, 'plugin-guard.config.json'), JSON.stringify(cfg.config));
        const issue = store.create({ title: 'Inconclusive fixture', description: cfg.description || 'fixture', symptom: 'white-screen', environment: 'local', url: 'http://127.0.0.1:9/', root, pages: ['/'] });
        await evidence.run(issue.id, { root, probeOptions: { probe: false } });
        const an = analysis.run(issue.id, { root, config: path.join(root, 'plugin-guard.config.json') });
        const bisH = b => require('../issue/hypotheses').build({ ...an.ctxForHypotheses, bisect: b, sandboxReproduced: 'yes' }).hypotheses.filter(h => (h.supports || []).some(x => x.kind === 'bisect'));
        ok(bisH({ status: 'theme-is-the-cause', causes: [], theme: { involved: true }, loads: 5 }).length === 1, 'control: a theme-is-the-cause bisection adds the theme hypothesis');
        ok(bisH({ status: 'inconclusive', causes: [{ plugins: ['plugin-a'], required_by: {}, minimal: true }], theme: { involved: true }, loads: 5, bare_different_failure: true }).length === 0 && bisH({ ...diff }).length === 0, 'inconclusive: no bisect hypothesis at all (not even from a hand-made file naming a plugin or the theme)');
    }

    group('fatals of a piece of the copy\'s log (the parsing fidelity.js uses)');
    const logText = `[06-Nov-2026 10:00:05 UTC] PHP Fatal error:  Uncaught Error: Class "Zq\\Unrelated\\Thing" not found in /var/www/html/wp-content/plugins/elementor/elementor.php:7\n[06-Nov-2026 10:00:06 UTC] PHP Warning:  something in /var/www/html/wp-content/plugins/a/a.php on line 3\n`;
    ok(JSON.stringify(phase.fatalsOfText(logText)) === JSON.stringify([OTHER]), 'a fatal line becomes { kind, name, file relative to wp-content, line }; a warning is not a fatal');
    ok(phase.fatalsOfText('<script>alert(1)</script> Class "a;rm -rf" not found').length === 0 && phase.fatalsOfText('').length === 0, 'hostile or empty text gives no fatal (names are checked by pattern; text is data)');

    group('the report: verdict, findings.json, Markdown; old bisect.json files render as before');
    const val = { hypotheses: [], symptom_reproduced: 'yes' };
    const vOld = resultMod.verdict(val, [], { symptom_without_plugins: true });
    ok(vOld.notes.length === 1 && vOld.notes[0] === resultMod.NOT_PLUGIN && !('cautions' in vOld), 'an old bisect.json (symptom_without_plugins true, no new field): the NOT A PLUGIN CONFLICT note exactly as before, no cautions key');
    const vDiff = resultMod.verdict(val, [], { symptom_without_plugins: false, bare_different_failure: true });
    ok(!vDiff.notes.length && JSON.stringify(vDiff.cautions) === JSON.stringify([resultMod.BARE_DIFFERENT]), 'different fatal: no note (no banner), one caution with the sentence');
    const vUnk = resultMod.verdict(val, [], { symptom_without_plugins: false, bare_different_failure: 'unknown' });
    ok(JSON.stringify(vUnk.cautions) === JSON.stringify([resultMod.BARE_UNKNOWN]), 'unknown: the unknown wording');
    ok(!('cautions' in resultMod.verdict(val, [], { symptom_without_plugins: false })) && !('cautions' in resultMod.verdict(val, [], null)), 'nothing to say: no cautions key (gate-off output unchanged)');
    const mdOf = (bis, notes, cautions) => resultMod.markdown({ issue: { title: 'x', id: 'iss-x', symptom: 'white-screen', environment: 'local' }, verdict: { label: 'Probable cause', confidence: 'low', symptom_reproduced: 'yes', notes, ...(cautions ? { cautions } : {}) }, hypotheses: [], resolution: [], bisect: bis, sandbox: null, timeline: [], retests: [], limits: [] });
    const md1 = mdOf({ status: 'inconclusive', causes: [], loads: 4, cache_hits: 0, capped: null, symptom_without_plugins: false, bare_different_failure: true }, [], [resultMod.BARE_DIFFERENT]);
    ok(!md1.includes('NOT A PLUGIN CONFLICT') && occurrences(md1, resultMod.BARE_DIFFERENT) === 2 && md1.includes('Status `inconclusive`: no cause is named;'), 'ISSUE-REPORT.md: no banner; "inconclusive: no cause is named"; the sentence under the verdict and under the bisection');
    const mdOld = mdOf({ status: 'theme-is-the-cause', causes: [], loads: 4, cache_hits: 0, capped: null, symptom_without_plugins: true }, [resultMod.NOT_PLUGIN]);
    ok(mdOld.includes('Status `theme-is-the-cause`: no plugin set;'), 'an old stored status renders as before');
    const md0 = mdOf({ status: 'not-explained', causes: [], loads: 4, cache_hits: 0, capped: null, symptom_without_plugins: true }, [resultMod.NOT_PLUGIN]);
    ok(md0.includes('NOT A PLUGIN CONFLICT') && !md0.includes(resultMod.BARE_DIFFERENT) && !md0.includes(resultMod.BARE_UNKNOWN), 'the same fatal (or an old file): the banner as before, no new sentence');

    // ================================================================ fidelity.js whole-segment fixes
    group("fidelity.js: 'wp-content' only as a whole path segment; pages by normalised path + query, never a bare suffix");
    ok(fid.normFile('/srv/site/wp-content/plugins/a/a.php') === 'plugins/a/a.php' && fid.normFile('wp-content/plugins/a/a.php') === 'plugins/a/a.php', 'a whole wp-content segment is cut (absolute and relative)');
    ok(fid.normFile('/srv/xwp-content/plugins/a/a.php') !== 'plugins/a/a.php' && fid.normFile('/srv/my-wp-content/plugins/a.php') !== 'plugins/a.php' && fid.normFile('xwp-content/plugins/a.php') !== 'plugins/a.php', "'xwp-content/' and 'my-wp-content/' are not the wp-content folder");
    ok(fid.normFile('/srv/xwp-content/x/wp-content/plugins/a.php') === 'plugins/a.php', 'the first WHOLE segment counts, not an earlier partial one');
    ok(fid.normFile('/srv/wp-content/../../etc/passwd') === null && fid.normFile('wp-content/plugins/../../../x.php') === null && fid.normFile('') === null && fid.normFile('/x/wp-content/' + 'a/'.repeat(200) + 'b.php') === null, 'hostile: ".." after the segment, empty and over-long paths give null');
    ok(fid.sameFatal({ kind: 'class', name: 'A', file: fid.normFile('/s/xwp-content/plugins/a.php') }, { kind: 'class', name: 'A', file: 'plugins/a.php' }) === false, 'so a fatal in xwp-content/plugins/a.php is not the same as one in wp-content/plugins/a.php');
    ok(fid.stripPaths('failed in /srv/xwp-content/plugins/a.php') === 'failed in a folder on this computer' && fid.stripPaths('failed in /srv/site/wp-content/plugins/a.php') === 'failed in wp-content/plugins/a.php', 'stripPaths: only a whole wp-content segment is kept as a relative path');
    ok(fid.samePage('/x/cart', '/cart', '/') === false && fid.samePage('/shop/cart', '/cart', '/') === false && fid.samePage('/cart', '/cart', '/') === true, "'/x/cart' is NOT '/cart' (no suffix match); '/cart' is '/cart'");
    ok(fid.samePage('/shop?a=1', '/shop?a=2', '/') === false && fid.samePage('/shop?a=1', '/shop?a=1', '/') === true && fid.samePage('/shop', '/', '/shop') === true && fid.samePage('/other', '/', '/shop') === false, 'the query counts as written; the copy front page stands only for the page the issue is about');
    ok(fid.pageKeyOf('https://example.com/shop/?b=2&a=1#frag') === '/shop?b=2&a=1' && fid.pathOf('https://example.com/shop/?b=2&a=1') === '/shop', 'compared: path + query as written (no fragment); stored: the path only (a query may hold personal values)');
    const realX = fid.realFrom({ probe: { pages: [{ url: 'https://example.com/x/cart', status: 500, loaded: true }] }, issue: { url: 'https://example.com/' } });
    const copyC = fid.copyFrom({ pages: [{ url: 'http://127.0.0.1:38080/cart', status: 500, loaded: true }], copyLog: { available: true, last_fatals: [] } });
    const rX = fid.compare({ real: realX, copy: copyC });
    ok(rX.level !== 'matched' && rX.level !== 'status-only', `real /x/cart failing, copy /cart failing: not a match (${rX.level})`);
    const realQ = fid.realFrom({ probe: { pages: [{ url: 'https://example.com/shop?p=2', status: 500, loaded: true }] }, issue: { url: 'https://example.com/' } });
    const copyQ = q => fid.copyFrom({ pages: [{ url: `http://127.0.0.1:38080/shop${q}`, status: 500, loaded: true }], copyLog: { available: true, last_fatals: [] } });
    ok(fid.compare({ real: realQ, copy: copyQ('?p=2') }).level === 'status-only' && fid.compare({ real: realQ, copy: copyQ('?p=3') }).level !== 'status-only', 'the same path with the same query matches (status-only here, no cause); another query does not');
    ok(JSON.stringify(fid.compare({ real: realQ, copy: copyQ('?p=2') })).indexOf('p=2') < 0, 'the query is never written into the result');
    ok(fid.compare({ real: realQ, copy: copyQ('?p=2') }).real_page === true && fid.compare({ real: { failing_pages: [], cause_fatal: CAUSE }, copy: fid.copyFrom({ pages: [{ url: 'http://127.0.0.1/', status: 500, loaded: true }], copyLog: { available: true, last_fatals: [{ message: `PHP Fatal error: Uncaught Error: Class "${CAUSE.name}" not found in /var/www/html/wp-content/${CAUSE.file}:48`, file: CAUSE.file, line: 48 }] } }) }).real_page === false, 'real_page: whether a failing page of your site was part of the comparison');
    ok(fid.clean({ schema: 1, level: 'matched', reasons: ["the copy's log has the same error (class A in x.php) and / showed HTTP 5xx in the copy"] }).real_page === false && fid.clean({ schema: 1, level: 'matched', reasons: ['on /shop both showed HTTP 5xx'] }).real_page === true, 'an older fidelity.json without the field: real_page is read from its first reason');

    // ================================================================ report levels
    group('report levels (gate on only): 1 tested on a copy, 2 not tested on a copy (what is missing), 3 the test copy could not confirm this');
    const FD = (level, extra = {}) => ({ schema: 1, level, counts: level === 'matched' || level === 'status-only', page: '/shop', status_class: '5xx', real_fatal: CAUSE, copy_fatal: level === 'matched' ? SAME : null, reasons: [], likely_reasons: level === 'did-not-match' ? fid.LIKELY_REASONS.slice() : [], real_page: true, ...extra });
    const RP = (extra = {}) => ({ requested: true, database_file: true, docker: true, copy_built: true, ...extra });
    const lv = (fd, rp, facts = { hasCode: true }) => caseFile.copyLevel(fd ? fid.clean(fd) : null, rp, facts);
    ok(lv(FD('matched'), RP()).n === 1 && lv(FD('matched'), RP()).heading === 'Tested on a copy of your site' && lv(FD('matched'), RP()).lines[0] === caseFile.MATCHED_LINE, 'matched against a failing page of your site: level 1, "Tested on a copy of your site"');
    ok(lv(FD('status-only', { real_fatal: null }), RP()).n === 1 && !lv(FD('status-only', { real_fatal: null }), RP()).lines.length, 'status-only: level 1, its weaker sentence comes from the fidelity check');
    const noPage = lv(FD('matched', { real_page: false }), RP());
    ok(noPage.n === 2 && noPage.heading === 'Not tested on a copy' && JSON.stringify(noPage.missing) === JSON.stringify([caseFile.MISSING_TEXT.page]) && JSON.stringify(noPage.lines) === JSON.stringify([caseFile.NOT_CONFIRMED_LABEL]), 'your site had NO failing page to compare (owner: level 2), listed as missing; a copy WAS built, so the label is NOT CONFIRMED, not NOT TESTED');
    ok(caseFile.NOT_CONFIRMED_LABEL === 'NOT CONFIRMED: a test copy of your site was built and logged the reported error, but your site had no failing page to compare with, so the copy does not confirm this report. What this report says comes from reading your log and the code.', 'the exact NOT CONFIRMED label');
    ok(lv(FD('not-tested', { reasons: ['no failing page and no error message from your site to compare'] }), RP()).missing.join() === caseFile.MISSING_TEXT.page, 'not-tested for lack of a failing page: level 2, that is what is missing');
    ok(lv(FD('did-not-match'), RP()).n === 3 && lv(FD('did-not-match'), RP()).heading === 'The test copy could not confirm this', 'did not match: level 3');
    ok(lv(FD('could-not-test', { reasons: ['the containers did not start'] }), RP()).n === 3, 'could not run (Docker worked): level 3');
    const dock = lv(FD('could-not-test', { reasons: ['docker: permission denied'] }), RP({ docker: false, copy_built: false }));
    ok(dock.n === 2 && dock.missing.join() === caseFile.MISSING_TEXT.docker, 'Docker missing: level 2, "Docker" in the list');
    const plain = lv(null, RP({ requested: false, database_file: false, docker: null, copy_built: false }));
    ok(plain.n === 2 && plain.missing.join() === caseFile.MISSING_TEXT.database && plain.lines.includes(caseFile.NOT_TESTED_LABEL), 'no database file: level 2, the database file is listed, the log and code reading is labelled NOT TESTED');
    ok(lv(null, RP({ database_file: false, docker: false, copy_built: false }), { hasCode: false }).missing.length === 3, 'database file, Docker and code all missing: all three listed');
    ok(lv(FD('not-tested', { reasons: ['the test copy was not built'] }), RP({ copy_built: false }), { hasCode: false }).missing.includes(caseFile.MISSING_TEXT.code), 'no code (no --root): level 2, the code is listed');
    // the rendered case file
    const mkF = () => ({ issue: { title: 'The shop page is white', id: 'iss-x' }, issue_title_short: 'The shop page is white', hypotheses: [], findings: [], likely: [], advisories: [], reported: { images: [] }, checkpoints: null });
    const VERS = { schema: 1, php: { status: 'matched', text: 'PHP 8.2.30 (from Site Health): PHP 8.2 used (matched)' }, db: { status: 'nearest', text: 'MySQL 8.0.46 (from the database file header): MySQL 8.0.40 used (nearest available, same family)' }, wordpress: { status: 'unknown', text: 'WordPress version of your site unknown (wp-includes/version.php is not in the copy); WordPress 7.1.3 used' }, todos: [], commands: [] };
    const AP = { source: 'from the database', active: ['a/a.php', 'b/b.php', 'c/c.php'], active_count: 3, missing_files: ['c/c.php'], not_active_present: 0 };
    const facts = { hasLog: true, hasCode: true, probeRan: true, sandboxRan: true, sandboxReproduced: 'yes' };
    const cfM = caseFile.build(mkF(), { comps: [], facts, fidelity: FD('matched'), replica: RP(), versions: VERS, activePlugins: AP });
    const mdM = caseFile.markdown(cfM, t => String(t)).join('\n'), clM = caseFile.cli({ ...cfM, checked: null });
    ok(cfM.level.n === 1 && /^## Tested on a copy of your site$/m.test(mdM) && clM.includes('TESTED ON A COPY OF YOUR SITE') && mdM.indexOf('## Tested on a copy') < mdM.indexOf('## What you see') && mdM.indexOf('## Status') < mdM.indexOf('## Tested on a copy'), 'Markdown and command line: the level heading after Status, before What you see');
    ok(cfM.close && cfM.close.title === 'How close the copy is' && /^### How close the copy is$/m.test(mdM) && clM.includes('How close the copy is'), 'the box is shown when a copy was built from a database file');
    const order = ['- Matched:', '- Did not match:', '- Not known:', '- Not covered in this version:'].map(x => mdM.indexOf(x));
    ok(order.every(i => i > 0) && order.every((x, i) => !i || x > order[i - 1]), 'sub-lines in the order Matched, Did not match, Not known, Not covered in this version');
    ok(cfM.close.matched.includes(`PHP: ${VERS.php.text}`) && cfM.close.did_not_match.includes(`Database: ${VERS.db.text}`) && cfM.close.not_known.includes(`WordPress: ${VERS.wordpress.text}`), 'versions with their source, grouped by their status (matched / nearest / unknown)');
    ok(cfM.close.did_not_match.includes('Active plugins: 3 (from the database), 1 of them with no files in the copy') && cfM.close.matched.some(x => x.startsWith('The same error as on your site: class Elementor\\Core\\Schemes\\Color in themes/unicamp/')), 'active plugins (source, count, missing files) and the same fatal');
    ok(JSON.stringify(cfM.close.not_covered) === JSON.stringify(caseFile.NOT_COVERED) && caseFile.NOT_COVERED.length === 6 && /outbound traffic/.test(caseFile.NOT_COVERED[0]) && /Apache or Nginx rules, CDN, caching/.test(caseFile.NOT_COVERED[1]) && /uploads folder, unless it was included/.test(caseFile.NOT_COVERED[5]), 'Not covered in this version: the fixed list of section 7');
    ok(!/Not looked at: nothing/.test(mdM + clM + JSON.stringify(cfM)) && cfM.status.looked === 'Looked at: your log, the live page, the code, a throwaway test copy.', `no "Not looked at: nothing" where the box is shown (${cfM.status.looked})`);
    const cfU = caseFile.build(mkF(), { comps: [], facts, fidelity: FD('could-not-test', { reasons: ['x'] }), replica: RP(), versions: null, activePlugins: { source: 'unknown', active: [], active_count: null, missing_files: [] } });
    ok(cfU.close.not_known.includes('PHP version: not known') && cfU.close.not_known.some(x => /^Active plugins: not known/.test(x)) && cfU.close.not_known.some(x => /^The same error: not known/.test(x)) && !cfU.close.matched.length, 'nothing recorded: everything is "Not known", nothing invented');
    ok(caseFile.build(mkF(), { comps: [], facts }).status.looked === 'Looked at: your log, the live page, the code, a throwaway test copy. Not looked at: nothing.', 'without the box the line is as it was');
    const cf2 = caseFile.build(mkF(), { comps: [], facts: { hasLog: true, hasCode: true }, replica: RP({ requested: false, database_file: false, docker: null, copy_built: false }) });
    const md2 = caseFile.markdown(cf2, t => String(t)).join('\n');
    ok(/^## Not tested on a copy$/m.test(md2) && md2.includes(caseFile.MISSING_INTRO) && md2.includes(`- ${caseFile.MISSING_TEXT.database}`) && md2.includes(`**${caseFile.NOT_TESTED_LABEL}**`) && !cf2.close, 'level 2 in Markdown: the heading, what is missing, the NOT TESTED label; no box without a copy');
    const cf3 = caseFile.build(mkF(), { comps: [], facts, fidelity: FD('did-not-match'), replica: RP() });
    const md3 = caseFile.markdown(cf3, t => String(t)).join('\n');
    ok(/^## The test copy could not confirm this$/m.test(md3) && md3.indexOf(fid.MISMATCH) > md3.indexOf('## The test copy could not confirm this') && occurrences(md3, fid.MISMATCH) === 1, 'level 3: the existing owner-approved mismatch sentence, once, under the heading');
    ok(cf3.close.did_not_match.some(x => /^The same error: your site shows class Elementor/.test(x)), 'the box says the same fatal did not match');

    const cfNP = caseFile.build(mkF(), { comps: [], facts, fidelity: FD('matched', { real_page: false }), replica: RP(), versions: VERS, activePlugins: { ...AP, missing_files: [] } });
    ok(cfNP.level.n === 2 && cfNP.close.not_known.includes(caseFile.NO_PAGE_MATCH) && !cfNP.close.matched.some(x => /same error/i.test(x)) && cfNP.close.matched.includes(`PHP: ${VERS.php.text}`) && cfNP.close.matched.some(x => /^Active plugins: 3/.test(x)), `matched but NO failing page on your site: "${caseFile.NO_PAGE_MATCH}" under Not known; Matched lists only versions and plugins`);
    const mdNP = caseFile.markdown(cfNP, t => String(t)).join('\n'), clNP = caseFile.cli({ ...cfNP, checked: null });
    ok(mdNP.includes(`**${caseFile.NOT_CONFIRMED_LABEL}**`) && !mdNP.includes(caseFile.NOT_TESTED_LABEL) && clNP.includes(caseFile.NOT_CONFIRMED_LABEL) && !clNP.includes(caseFile.NOT_TESTED_LABEL) && /^## Not tested on a copy$/m.test(mdNP), 'Markdown and text: level 2 heading kept, the NOT CONFIRMED label, never "not tried on a copy"');
    ok(/\^NOT \(\?:TESTED\|CONFIRMED\)/.test(fs.readFileSync(path.join(PG, 'lib', 'issue-html-gate.js'), 'utf8')), 'the page shows the NOT CONFIRMED label as a strong note, like NOT TESTED');
    ok(cf2.level.lines.includes(caseFile.NOT_TESTED_LABEL) && !cf2.level.lines.includes(caseFile.NOT_CONFIRMED_LABEL), 'no copy built: NOT TESTED stays');
    ok(caseFile.NO_PAGE_MATCH === 'The copy logs the reported error, but your site had no failing page to compare with, so the match is not confirmed.', 'the exact sentence');

    group('the page (gate patch): the level and the box through textContent');
    const gate = fs.readFileSync(path.join(PG, 'lib', 'issue-html-gate.js'), 'utf8');
    const lvPart = gate.split('if (CF.level) {')[1].split('\n        }\n')[0];
    ok(/CF\.level\.heading/.test(lvPart) && /CF\.close/.test(lvPart) && !/innerHTML/.test(lvPart), 'issue-html-gate.js renders the level heading, what is missing and the box with el()/textContent, no innerHTML');
    ok(/el\('h4', \{ text: CF\.close\.title \}\)/.test(lvPart), 'the box title comes from the data (findings.json case_file.close)');

    // ================================================================ the copy's own log (spec 6.2)
    group("no log on the site: the copy's own log counts only after the fidelity check matched");
    const cfL = caseFile.build(mkF(), { comps: [], facts: { ...facts, hasLog: false }, fidelity: FD('matched'), replica: RP(), copyLogLines: ['No error log was found on this site. A test copy of your site showed the same problem and wrote its own log; the errors below are from a test copy of your site.', 'From a test copy of your site: PHP Fatal error: x'] });
    const mdL = caseFile.markdown(cfL, t => String(t)).join('\n');
    ok(cfL.status.copy_log && /from a test copy of your site/.test(mdL) && !cfL.status.log_help, 'the case file carries the copy\'s log lines, named "from a test copy of your site"');
    ok(/showed the same problem/.test(resultMod.COPY_LOG_INTRO) && !/same problem/.test(resultMod.COPY_LOG_INTRO_NO_PAGE) && /from a test copy of your site/.test(resultMod.COPY_LOG_INTRO_NO_PAGE) && /match is not confirmed/.test(resultMod.COPY_LOG_INTRO_NO_PAGE), 'no failing page on your site: the copy-log intro does not say "showed the same problem" (result.js picks COPY_LOG_INTRO_NO_PAGE when real_page is false)');
    ok(/fdNow\.real_page === false \? COPY_LOG_INTRO_NO_PAGE : COPY_LOG_INTRO/.test(fs.readFileSync(path.join(PG, 'issue', 'result.js'), 'utf8')), 'and result.js chooses it from the fidelity result');

    // ================================================================ time estimate
    group('the time estimate: max(2, 1 + ceil(MB / 50)) of the UNPACKED size');
    const MB = 1048576;
    ok([[0, 2], [null, 2], [10 * MB, 2], [50 * MB, 2], [51 * MB, 3], [200 * MB, 5], [1024 * MB, 22]].every(([b, m]) => dumpIntake.estimateMinutes(b) === m), 'the formula: 0 / unknown / 10 MB / 50 MB -> 2, 51 MB -> 3, 200 MB -> 5, 1 GB -> 22');
    const plainSql = write(tmp, 'est/site.sql', 'x'.repeat(3 * MB));
    const gz = path.join(tmp, 'est', 'big.sql.gz'); fs.writeFileSync(gz, zlib.gzipSync(Buffer.alloc(120 * MB, 0x41)));
    ok(dumpIntake.unpackedBytes(plainSql) === 3 * MB && dumpIntake.unpackedBytes(gz) === 120 * MB && fs.statSync(gz).size < MB, 'the unpacked size: a plain file is its size; a .gz is read from its trailer (120 MB from a small file), nothing unpacked');
    ok(dumpIntake.estimateMinutes(dumpIntake.unpackedBytes(gz)) === 4 && dumpIntake.unpackedBytes(path.join(tmp, 'nope.sql')) === null, '.gz of 120 MB -> 4 minutes; a missing file -> null (the minimum is printed)');
    ok(dumpIntake.buildNotice(3) === 'Building a test copy of your site with your database, about 3 minutes.', 'the notice text');
    ok(dumpIntake.DEFAULT_CAP_MB === 1024, 'the size cap stays (lib/dump-intake.js, default 1024 MB, --max-size-mb)');

    // ================================================================ the wizard
    group('the wizard: ONE optional question (the database file); built without asking; --no-replica; never for live');
    const src = fs.readFileSync(path.join(PG, 'lib', 'wizard.js'), 'utf8');
    ok(!/\[y\/N\]', \)/.test(src) && !/deeper test in a throwaway copy takes a few minutes/.test(src), 'the old "[y/N]" deeper-test question is gone from lib/wizard.js');
    ok(guard.parse(['--no-replica'])['no-replica'] === true, '--no-replica is a known flag (scripts/guard.js)');
    const cliSrc = fs.readFileSync(path.join(PG, 'lib', 'issue-cli.js'), 'utf8');
    ok(/sandbox: !!o\.sandbox && !noReplica/.test(cliSrc) && /sandbox: !!o\.sandbox && !o\['no-replica'\]/.test(cliSrc), 'issue investigate and issue retest read --no-replica where --sandbox / --db-dump are read');
    const WIZ_SITE = path.join(tmp, 'wsite', 'wp'); trees.duplicateFunction(WIZ_SITE); write(WIZ_SITE, 'wp-content/themes/acme/style.css', '/* Theme Name: Acme */');
    const SQL = write(tmp, 'in/site.sql', fs.readFileSync(path.join(__dirname, 'fixtures', 'issue', 'dump', 'tiny.sql.txt')));
    const TABLES = 'Tables_in_wordpress\npgf_options\npgf_users\npgf_usermeta\npgf_posts\n';
    const FAKE = [{ match: 'db query', stdin: 'SHOW TABLES', out: TABLES }, { match: 'db query', stdin: "option_name = 'siteurl'", out: 'option_value\nhttps://shop.example.com\n' }, { match: 'db query', stdin: "option_name = 'home'", out: 'option_value\nhttps://shop.example.com\n' },
        { match: 'db query', stdin: 'AS pg_admin FROM', out: 'pg_admin\n1\n' }, { match: 'db query', stdin: 'AS pg_admins FROM', out: 'pg_admins\n1\n' }];
    const realVerify = require('../issue/verify-fixes').run;
    require('../issue/verify-fixes').run = async () => ({ steps: [], results: 0 });   // no second sandbox in this test
    const realProbe = probe.runSandbox; probe.runSandbox = async () => ({ ok: true, pages: [], status_codes: [200], oracle: { result: 'no' } });
    let seq = 0;
    async function wiz(answers, flags, { tty = true, docker = true } = {}) {
        const name = `w${seq++}`, dir = path.join(tmp, 'fake-' + name), sbx = path.join(tmp, 'sbx-' + name);
        fs.mkdirSync(dir, { recursive: true }); fs.mkdirSync(sbx, { recursive: true, mode: 0o700 });
        fs.copyFileSync(path.join(__dirname, 'fixtures', 'issue', 'fake-docker.js'), path.join(dir, 'docker')); fs.chmodSync(path.join(dir, 'docker'), 0o755);
        fs.writeFileSync(path.join(dir, 'fake.json'), JSON.stringify({ wp: FAKE }));
        const input = new PassThrough(), output = new PassThrough();
        let text = ''; output.on('data', d => { text += d; });
        input.end(answers.join('\n') + (answers.length ? '\n' : ''));
        const saved = process.env.PLUGIN_GUARD_ISSUES, log = console.log; let logged = ''; console.log = (...a) => { logged += a.join(' ') + '\n'; };
        let error = null, preflights = 0;
        const out = path.join(tmp, 'out-' + name);
        try { await wizard.run({ _: [], description: 'The shop page is white since the update', root: WIZ_SITE, 'no-probe': true, 'no-questions': true, out, ...flags }, { input, output, tty, cwd: tmp, env: { HOME: tmp }, preflight: () => { preflights++; return { ok: docker }; }, siteRoots: [], sandboxOptions: { dockerBin: path.join(dir, 'docker'), sandboxesRoot: sbx, env: { PATH: process.env.PATH, HOME: process.env.HOME }, pageCheck: () => ({ status: 200 }) } }); }
        catch (e) { error = e; } finally { console.log = log; if (saved === undefined) delete process.env.PLUGIN_GUARD_ISSUES; else process.env.PLUGIN_GUARD_ISSUES = saved; }
        const fakeLog = fs.existsSync(path.join(dir, 'fake.log')) ? fs.readFileSync(path.join(dir, 'fake.log'), 'utf8').split('\n').filter(Boolean).map(JSON.parse) : [];
        const ids = fs.existsSync(out) ? fs.readdirSync(out).filter(x => store.ISSUE_RE.test(x)) : [];
        const idir = ids.length ? path.join(out, ids[0]) : null;
        const f = idir && fs.existsSync(path.join(idir, 'result', 'findings.json')) ? JSON.parse(fs.readFileSync(path.join(idir, 'result', 'findings.json'), 'utf8')) : null;
        return { text: text + logged, error, built: fakeLog.some(l => l.args[0] === 'compose'), f, preflights };
    }
    const Q = 'Optional: a database export file of the site (.sql or .sql.gz), to test the problem on a copy of your site. Enter its path, or press Enter for none';
    const NOTICE = 'Building a test copy of your site with your database, about 2 minutes.';
    {
        const r = await wiz(['', '', SQL, '1'], {});
        ok(!r.error && occurrences(r.text, Q) === 1 && !/deeper test|Run it\? \[y\/N\]/.test(r.text), `a terminal and Docker: ONE question (the database file), no [y/N] deeper-test question${r.error ? ` (${r.error.message})` : ''}`);
        ok(occurrences(r.text, NOTICE) === 1 && r.built && r.text.indexOf(NOTICE) > r.text.indexOf(Q), `a file given: built without asking again, after the exact notice ("${NOTICE}")`);
        ok(r.f && r.f.case_file && r.f.case_file.level && r.f.case_file.close && !/Not looked at: nothing/.test(JSON.stringify(r.f.case_file)), `the report has a level (${r.f && r.f.case_file.level && r.f.case_file.level.heading}) and the box`);
    }
    {
        const r = await wiz(['', '', ''], {});
        ok(!r.error && occurrences(r.text, Q) === 1 && !r.built && !r.text.includes('Building a test copy') && r.f && r.f.case_file.level.n === 2 && r.f.case_file.level.missing.includes(caseFile.MISSING_TEXT.database), 'Enter (no file): no copy question, nothing built, a level-2 report listing the database file');
    }
    {
        const r = await wiz(['', ''], { 'db-dump': SQL, 'no-replica': true });
        ok(!r.error && !r.text.includes(Q) && !r.built && !r.text.includes('Building a test copy') && !r.text.includes('Your database file contains user accounts'), '--no-replica: no question and nothing built, even with --db-dump');
    }
    {
        const r = await wiz([], { 'db-dump': SQL, yes: true });
        ok(!r.error && !r.text.includes(Q) && r.built && occurrences(r.text, NOTICE) === 1, '--yes with --db-dump (no --sandbox): no question, the copy is built after the notice (flags win)');
    }
    {
        const r = await wiz([], { 'db-dump': SQL }, { tty: false });
        ok(!r.error && !r.text.includes(Q) && r.built, 'no terminal with --db-dump: no question, built');
    }
    {
        const r = await wiz(['', ''], {}, { docker: false });
        ok(!r.error && !r.text.includes(Q) && !r.built, 'Docker not usable: the question is not asked');
    }
    {
        const r = await wiz([], { 'db-dump': SQL, yes: true, url: 'https://shop.example.net/', env: 'live', authorized: true });
        ok(!r.error && !r.text.includes(Q) && !r.built && !r.text.includes('Building a test copy') && r.text.includes(wizard.LIVE_NO_DB), 'a LIVE site: never built from a database file, no question, no notice, the plain line');
    }
    {
        const r = await wiz([], { 'db-dump': SQL, sandbox: true, yes: true, url: 'https://shop.example.net/', env: 'live', authorized: true });
        ok(!r.error && occurrences(r.text, wizard.LIVE_NO_DB) === 1 && wizard.LIVE_NO_DB === 'A live site is never copied with its database.' && !r.built && !r.text.includes('Building a test copy') && !r.text.includes('Your database file contains user accounts') && r.f, 'a LIVE site with --sandbox --db-dump: one plain line, nothing built, the check goes on without the copy');
    }
    group('a LIVE site is never copied with its database, in any path (issue/sandbox-phase.js, centrally)');
    {
        const cli = require('../lib/issue-cli'), phaseMod = require('../issue/sandbox-phase');
        const name = 'live-cli', dir = path.join(tmp, 'fake-' + name), sbx = path.join(tmp, 'sbx-' + name);
        fs.mkdirSync(dir, { recursive: true }); fs.mkdirSync(sbx, { recursive: true, mode: 0o700 });
        fs.copyFileSync(path.join(__dirname, 'fixtures', 'issue', 'fake-docker.js'), path.join(dir, 'docker')); fs.chmodSync(path.join(dir, 'docker'), 0o755);
        fs.writeFileSync(path.join(dir, 'fake.json'), JSON.stringify({ wp: FAKE }));
        const fakeLog = () => (fs.existsSync(path.join(dir, 'fake.log')) ? fs.readFileSync(path.join(dir, 'fake.log'), 'utf8').split('\n').filter(Boolean).map(JSON.parse) : []);
        const iss = store.create({ title: 'Live', description: 'white page', symptom: 'white-screen', environment: 'live', root: WIZ_SITE, pages: ['/'] });
        const log = console.log; let logged = ''; console.log = (...a) => { logged += a.join(' ') + '\n'; };
        let error = null;
        try { await cli.investigate(iss.id, { _: [], sandbox: true, 'db-dump': SQL, 'no-probe': true, 'no-questions': true, yes: true, gate: true }, 'investigate', { interactive: false, loginOut: { tty: false, write: () => {} }, sandboxOptions: { dockerBin: path.join(dir, 'docker'), sandboxesRoot: sbx, env: { PATH: process.env.PATH, HOME: process.env.HOME }, pageCheck: () => ({ status: 200 }) } }); }
        catch (e) { error = e; } finally { console.log = log; }
        const fl = fakeLog(), sj = JSON.parse(fs.readFileSync(path.join(store.dirOf(iss.id), 'work', 'sandbox.json'), 'utf8'));
        ok(!error && !fl.some(l => (l.args || []).includes('import') || /INSERT INTO|CREATE TABLE/i.test(l.stdin || '')) && !fs.existsSync(path.join(store.dirOf(iss.id), 'work', 'user-data.json')) && !sj.fidelity, `issue investigate --sandbox --db-dump --yes on a live issue: no database import in the fake docker, no user-data, no fidelity${error ? ` (${error.message})` : ''}`);
        const fL = JSON.parse(fs.readFileSync(path.join(store.dirOf(iss.id), 'result', 'findings.json'), 'utf8'));
        ok(sj.steps.some(x => x.id === 'sandbox-database' && x.reason === phaseMod.LIVE_NO_DB) && JSON.stringify(fL.timeline).includes(phaseMod.LIVE_NO_DB), `the sandbox step note (and the report timeline) says "${phaseMod.LIVE_NO_DB}"`);
        ok(sj.replica && sj.replica.db_dropped_live === true && sj.replica.database_file === false, 'sandbox.json records replica.db_dropped_live: true (database_file is not overloaded)');
        ok(!fL.case_file || (fL.case_file.level.n === 2 && fL.case_file.level.missing.includes(caseFile.MISSING_TEXT.live) && !fL.case_file.level.missing.includes(caseFile.MISSING_TEXT.database)), `the level-2 list says a database copy is never made for a live site, not that a database file is missing (${fL.case_file ? JSON.stringify(fL.case_file.level.missing) : 'no gate'})`);
        ok(caseFile.MISSING_TEXT.live === 'a copy built from your database is never made for a live site (try it on a local or staging copy of the site)', 'the exact wording');
        const lvLive = caseFile.copyLevel(null, { requested: true, database_file: false, docker: true, copy_built: true, db_dropped_live: true }, { hasCode: true });
        ok(JSON.stringify(lvLive.missing) === JSON.stringify([caseFile.MISSING_TEXT.live]), 'copyLevel: db_dropped_live replaces the database item');
        // issue retest (issue-cli.js -> issue/retest.js -> sandbox-phase.js): retest.js passes no sandbox options, so sandbox.create is watched instead
        const sbMod = require('../issue/sandbox'), realCreate = sbMod.create, realPf = sbMod.preflight, seen = [];
        sbMod.preflight = () => ({ ok: true }); sbMod.create = (id, so) => { seen.push(so); throw Object.assign(new Error('stopped by the test'), { name: 'SandboxUnavailable' }); };
        let rerr = null, sbr = null;
        try { await require('../issue/retest').run(iss.id, { root: WIZ_SITE, options: { sandbox: true, dump: SQL, exportDb: true }, env: process.env }); sbr = JSON.parse(fs.readFileSync(path.join(store.dirOf(iss.id), 'work', 'retest-1', 'sandbox.json'), 'utf8')); }
        catch (e) { rerr = e; } finally { sbMod.create = realCreate; sbMod.preflight = realPf; }
        ok(!rerr && seen.length === 1 && !seen[0].dump && !seen[0].exportDatabase && sbr && sbr.steps.some(x => x.id === 'sandbox-database' && x.reason === phaseMod.LIVE_NO_DB), `issue retest --sandbox --db-dump on a live issue: the sandbox is asked for WITHOUT the database file or an export, and the note is there${rerr ? ` (${rerr.message})` : ''}`);
        // a live issue without a database file: unchanged (no note)
        const iss2 = store.create({ title: 'Live nodb', description: 'white page', symptom: 'white-screen', environment: 'live', root: WIZ_SITE, pages: ['/'] });
        sbMod.preflight = () => ({ ok: false, reason: 'test' });
        try { const r2 = await phaseMod.run(iss2.id, { root: WIZ_SITE, options: { sandbox: true } }); ok(!r2.steps.some(x => x.id === 'sandbox-database'), 'a live issue without a database file: no new note, the existing path is unchanged'); } finally { sbMod.preflight = realPf; }
        // guard:auto's shared sandbox (sandbox-many.js) refuses it the same way
        const iss3 = store.create({ title: 'Live many', description: 'white page', symptom: 'white-screen', environment: 'live', root: WIZ_SITE, pages: ['/'] });
        const seen3 = []; sbMod.preflight = () => ({ ok: true }); sbMod.create = (id, so) => { seen3.push(so); throw new Error('stopped by the test'); };
        try { const rm = await require('../issue/sandbox-many').runMany([iss3.id], { root: WIZ_SITE, options: { dump: SQL } }); ok(seen3.length === 1 && !seen3[0].dump && rm.steps.some(x => x.id === 'sandbox-database' && x.reason === phaseMod.LIVE_NO_DB), 'sandbox-many.js: with a live issue the database file is not passed on, with the same note'); } finally { sbMod.create = realCreate; sbMod.preflight = realPf; }
    }
    require('../issue/verify-fixes').run = realVerify; probe.runSandbox = realProbe;

    group('the classic scan and the hygiene rules are untouched');
    ok(!/require\((['"])(?:https?|net|dns|tls)\1\)|\bfetch\(/.test(fs.readFileSync(path.join(PG, 'issue', 'case-file.js'), 'utf8') + fs.readFileSync(path.join(PG, 'lib', 'dump-intake.js'), 'utf8')), 'case-file.js and dump-intake.js: no network module');

    fs.rmSync(tmp, { recursive: true, force: true });
    console.log(`\n${failures ? `${failures} check(s) FAILED` : 'All checks passed'}`);
    process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
