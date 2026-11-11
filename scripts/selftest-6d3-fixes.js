#!/usr/bin/env node
// Self-test of the 6d-3 fix step (owner-approved), offline, against the fake `docker` (scripts/fixtures/issue/fake-docker.js). No daemon, no network.
// Three causes seen on real runs, each with a test (gate on only; gate off is unchanged and its golden files are checked by selftest-gate-output.js):
//   1. a wrong address that answered 404: the report said "The live pages that were loaded did not answer with an error". Now the STATUS area and
//      "What you see" say "Your address answered HTTP 404 (page not found), so it may not be the address of your site. Check the address and run again."
//      (the real code, a short description for common codes), never "did not answer with an error"; when the page of the fidelity comparison answered 4xx,
//      that is the one likely reason (the generic list is dropped)
//   2. a test copy that did not match said "Not looked at: a throwaway test copy" although a copy was built: now it says the copy was built, at every level
//   3. the first question listed every plugin "last changed on" the day of the copy: the copy now keeps the original file times (lutimes, links never followed)

const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-6d3fix-'));
process.env.PLUGIN_GUARD_ISSUES = path.join(tmp, 'issues');
fs.mkdirSync(process.env.PLUGIN_GUARD_ISSUES, { mode: 0o700 });
const fid = require('../issue/fidelity');
const phase = require('../issue/sandbox-phase');
const store = require('../lib/issue-store');
const caseFile = require('../issue/case-file');
const resultMod = require('../issue/result');
const probe = require('../issue/probe');
const intake = require('../lib/site-intake');
const sbCopy = require('../issue/sandbox-copy');
const cli = require('../lib/issue-cli');

let failures = 0;
const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`); if (!c) failures++; };
const group = t => console.log(`\n== ${t}`);
const write = (root, rel, body) => { const f = path.join(root, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, body); return f; };
const ser = list => `a:${list.length}:{${list.map((s, i) => `i:${i};s:${Buffer.byteLength(s)}:"${s}";`).join('')}}`;
const hex = s => Buffer.from(s, 'utf8').toString('hex').toUpperCase();

const ADDR404 = 'Your address answered HTTP 404 (page not found), so it may not be the address of your site. Check the address and run again.';
const FINE = 'did not answer with an error';
const PROT403 = 'Your address answered HTTP 403 (access refused). The site may be protecting itself, so the address could be right. Wait a while, then run again; the check only looked at a few public pages.';
const PROT429 = 'Your address answered HTTP 429 (too many requests). The site may be protecting itself, so the address could be right. Wait a while, then run again; the check stopped at once and nothing else was requested.';
const GENERIC = fid.LIKELY_REASONS;
const CLASS = 'Elementor\\Core\\Schemes\\Color';
const THEME_FILE = 'wp-content/themes/unicamp/elementor/widgets/original/heading.php';

(async () => {
    group('1. the sentence for a 4xx answer (owner wording, the real code)');
    ok(caseFile.addressSentence(404) === ADDR404, `404: "${caseFile.addressSentence(404)}"`);
    ok(caseFile.addressSentence(410) === 'Your address answered HTTP 410 (page removed), so it may not be the address of your site. Check the address and run again.' && caseFile.addressSentence(400).includes('HTTP 400 (bad request), so it may not be the address'), '410 and 400: the wrong-address sentence with a short plain description');
    ok(caseFile.addressSentence(418) === 'Your address answered HTTP 418 (an error), so it may not be the address of your site. Check the address and run again.', 'an uncommon code: the real code, a generic description, the wrong-address sentence');
    // owner: 401, 403 and 429 are the site protecting itself; never "check the address"
    ok(caseFile.addressSentence(403) === PROT403, `403: "${caseFile.addressSentence(403)}"`);
    ok(caseFile.addressSentence(401) === PROT403.replace('403 (access refused)', '401 (login required)'), '401 (login required): the protection sentence, "only looked at a few public pages"');
    ok(caseFile.addressSentence(429) === PROT429, `429: "${caseFile.addressSentence(429)}"`);
    // "stopped at once" is a fact only while the first 429 ends the probe: pinned to probe/config.js and probe/safety.js
    ok(require('../probe/config').resolve().stopAfter429 === 1 && /else if \(s\.status429 >= c\.stopAfter429\) this\.tripBreaker/.test(fs.readFileSync(path.join(__dirname, '..', 'probe', 'safety.js'), 'utf8')), 'the first 429 ends the probe (stopAfter429 is 1 and trips the breaker), so the 429 sentence is true');
    ok([401, 403, 429].every(c => !/Check the address|may not be the address/.test(caseFile.addressSentence(c))), 'no "check the address" claim for 401, 403 and 429');

    group('1. the case file with a probed page that answered 404 (unit)');
    {
        const mkF = () => ({ issue: { title: 'The site is white', id: 'iss-x' }, issue_title_short: 'The site is white', hypotheses: [], findings: [], likely: [], advisories: [], reported: { images: [] }, checkpoints: null });
        const facts = { hasLog: true, hasCode: true, probeRan: true };
        const cf = caseFile.build(mkF(), { comps: [], facts, probePages: [{ url: 'http://127.0.0.1:9/', status: 404, loaded: true }] });
        const md = caseFile.markdown(cf, t => String(t)).join('\n'), cl = caseFile.cli({ ...cf, checked: null });
        ok(cf.see.includes(ADDR404) && !cf.see.some(s => s.includes(FINE)), `"What you see" has the sentence and not "${FINE}"`);
        ok((cf.status.cautions || [])[0] === ADDR404 && md.indexOf(ADDR404) > md.indexOf('## Status') && md.indexOf(ADDR404) < md.indexOf('## What you see') && cl.indexOf(ADDR404) < cl.indexOf('WHAT YOU SEE'), 'the STATUS area says it too (Markdown and command line), before "What you see"');
        ok(!md.includes(FINE) && !cl.includes(FINE), `never "${FINE}" in the Markdown or the command line`);
        const both = caseFile.build(mkF(), { comps: [], facts, probePages: [{ url: 'http://127.0.0.1:9/', status: 404, loaded: true }, { url: 'http://127.0.0.1:9/shop', status: 500, loaded: true }] });
        ok(both.see.includes('The live page answered HTTP 500.') && both.see.includes(ADDR404) && !both.see.some(s => s.includes(FINE)), 'a 404 and a 500: both are said, never "did not answer with an error"');
        const fine = caseFile.build(mkF(), { comps: [], facts, probePages: [{ url: 'http://127.0.0.1:9/', status: 200, loaded: true }] });
        ok(fine.see.includes('The live pages that were loaded did not answer with an error.') && !fine.status.cautions, 'every page answered 200: the sentence is as before and there is no address sentence');
        const fd = { schema: 1, level: 'did-not-match', counts: false, page: '/', status_class: '4xx', real_fatal: null, copy_fatal: null, reasons: ['on / your site showed HTTP 4xx, the test copy showed no error'], likely_reasons: GENERIC.slice(), real_page: true };
        const cfd = caseFile.build(mkF(), { comps: [], facts, probePages: [{ url: 'http://127.0.0.1:9/', status: 404, loaded: true }], fidelity: fd, replica: { requested: true, database_file: true, docker: true, copy_built: true } });
        ok(JSON.stringify(cfd.status.fidelity.reasons) === JSON.stringify([ADDR404]), 'the compared page answered 404: the address is the one likely reason, the generic list is dropped');
        const cf403 = caseFile.build(mkF(), { comps: [], facts, probePages: [{ url: 'http://127.0.0.1:9/', status: 403, loaded: true }], fidelity: fd, replica: { requested: true, database_file: true, docker: true, copy_built: true } });
        const cf429 = caseFile.build(mkF(), { comps: [], facts, probePages: [{ url: 'http://127.0.0.1:9/', status: 429, loaded: true }], fidelity: fd });
        ok(JSON.stringify(cf429.status.fidelity.reasons) === JSON.stringify([PROT429]) && cf429.status.cautions[0] === PROT429, 'the compared page answered 429: the 429 sentence alone in Likely reasons and in STATUS');
        ok(JSON.stringify(cf403.status.fidelity.reasons) === JSON.stringify([PROT403]) && cf403.see.includes(PROT403) && cf403.status.cautions[0] === PROT403 && !cf403.see.some(x => x.includes(FINE)), 'the compared page answered 403: the protection sentence alone in Likely reasons, in STATUS and in "What you see"');
        // THE ADDRESS PAGE decides (owner): a subpage 404 with the home page 200 gets no address advice, only "The page <path> answered ..."
        const U = 'http://127.0.0.1:9/';
        const sub = caseFile.build(mkF(), { comps: [], facts, issueUrl: U, probePages: [{ url: U, status: 200, loaded: true }, { url: `${U}shop/`, status: 404, loaded: true }] });
        ok(sub.see.includes('The page /shop answered HTTP 404 (page not found).') && !sub.see.some(x => /Your address|Check the address/.test(x)) && !sub.status.cautions && !sub.see.some(x => x.includes(FINE)), 'home 200, /shop 404: "The page /shop answered HTTP 404 (page not found).", no address advice, nothing in STATUS, never "did not answer with an error"');
        const subFd = caseFile.build(mkF(), { comps: [], facts, issueUrl: U, probePages: [{ url: U, status: 200, loaded: true }, { url: `${U}shop/`, status: 404, loaded: true }], fidelity: { ...fd, page: '/shop' } });
        ok(JSON.stringify(subFd.status.fidelity.reasons) === JSON.stringify(GENERIC), 'the compared page is a subpage that answered 404: the generic likely reasons stay');
        const home = caseFile.build(mkF(), { comps: [], facts, issueUrl: U, probePages: [{ url: U, status: 404, loaded: true }, { url: `${U}shop/`, status: 200, loaded: true }] });
        ok(home.see.includes(ADDR404) && home.status.cautions[0] === ADDR404, 'home 404: the address advice in STATUS and "What you see"');
        const notProbed = caseFile.build(mkF(), { comps: [], facts, issueUrl: U, probePages: [{ url: `${U}shop/`, status: 404, loaded: true }] });
        ok(!notProbed.status.cautions && notProbed.see.includes('The page /shop answered HTTP 404 (page not found).'), 'the address itself was not probed: no advice, the page is named');
        ok(caseFile.addressPageOf([{ url: 'http://127.0.0.1:9/a' }, { url: 'http://127.0.0.1:9' }], 'http://127.0.0.1:9/').url === 'http://127.0.0.1:9' && caseFile.addressPageOf([{ url: 'http://127.0.0.1:9/a' }], null).url === 'http://127.0.0.1:9/a', 'the address page: same origin, path (trailing slash ignored) and query; without the address, the first probed page');
        // a 5xx next to a 4xx: BOTH sentences, in the case file and in the "What is wrong" box (issue/whats-wrong.js)
        const mix = [{ url: U, status: 404, loaded: true }, { url: `${U}shop/`, status: 500, loaded: true }];
        const cfMix = caseFile.build(mkF(), { comps: [], facts, issueUrl: U, probePages: mix });
        ok(cfMix.see.includes('The live page answered HTTP 500.') && cfMix.see.includes(ADDR404) && !cfMix.see.some(x => x.includes(FINE)), 'case file: a 500 and the address 404, both said');
        const ww = require('../issue/whats-wrong');
        const fr = { class: 'Elementor\\Core\\Schemes\\Color', kind: 'class', file: 'wp-content/themes/unicamp/x.php', line: 3, file_kind: 'theme', provider: {}, scan: {} };
        const box = ww.build(fr, { components: [], issue: { url: U, title: 't' }, probePages: mix, advisories: [], templateTotal: 0, ran: { probe: true }, fileComponent: '' }, 'likely');
        const liveL = box.lines.filter(l => /^Live check:/.test(l));
        ok(Array.isArray(box.case.live) && box.case.live.includes('The live page answered HTTP 500.') && box.case.live.includes(ADDR404) && liveL.length === 2 && !box.lines.some(l => l.includes(FINE)), `whats-wrong.js: both sentences ("${liveL.join(' | ')}")`);
        const box2 = ww.build(fr, { components: [], issue: { url: U, title: 't' }, probePages: [{ url: U, status: 200, loaded: true }, { url: `${U}shop/`, status: 404, loaded: true }], advisories: [], templateTotal: 0, ran: { probe: true }, fileComponent: '' }, 'likely');
        ok(box2.case.live === 'The page /shop answered HTTP 404 (page not found).' && !box2.lines.some(l => l.includes(FINE) || /Check the address/.test(l)), 'whats-wrong.js: a subpage 404 is named without advice, never "did not answer with an error"');
        const cfBox = caseFile.build({ ...mkF(), what_is_wrong: box, likely: [{ id: 'h1', box }] }, { comps: [], facts, issueUrl: U, probePages: mix });
        const sure = (cfBox.cases[0].rows.find(r => r[0] === 'How sure') || [])[1] || [];
        ok(sure.includes('The live page answered HTTP 500.') && !sure.includes(ADDR404), 'Case 1 "How sure" has the 500 line, not the address sentence');
        const cf5 = caseFile.build(mkF(), { comps: [], facts, fidelity: { ...fd, status_class: '5xx' } });
        ok(JSON.stringify(cf5.status.fidelity.reasons) === JSON.stringify(GENERIC), 'a 5xx comparison page: the generic list stays');
    }

    group('2. "Looked at": a copy that was built is never "Not looked at"');
    {
        const L = (facts, o) => caseFile.lookedAt(facts, o).line;
        const facts = { hasLog: true, hasCode: true, probeRan: true, sandboxRan: false };
        ok(L(facts, { copyBuilt: true }) === 'Looked at: your log, the live page, the code, a throwaway test copy (it was built). Not looked at: nothing.', `built, its result not used: "${L(facts, { copyBuilt: true })}"`);
        ok(L(facts, {}) === 'Looked at: your log, the live page, the code. Not looked at: a throwaway test copy.', 'no copy built: as before');
        ok(L({ ...facts, sandboxRan: true }, { copyBuilt: true }) === 'Looked at: your log, the live page, the code, a throwaway test copy. Not looked at: nothing.', 'a copy whose result counted: as before');
    }

    // ================================================================ the pipeline on the fake docker (a copy built from a database file)
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
    function classSite(root) {
        write(root, 'wp-includes/version.php', "<?php\n$wp_version = '6.8.1';\n"); write(root, 'wp-config.php', '<?php\n');
        write(root, 'wp-content/plugins/elementor/elementor.php', '<?php\n/**\n * Plugin Name: Elementor\n * Version: 3.35.7\n */\nnamespace Elementor;\nclass Plugin {}\n');
        write(root, 'wp-content/themes/unicamp/style.css', '/*\nTheme Name: Unicamp\nVersion: 1.0\n*/');
        write(root, THEME_FILE, '<?php\n' + '// filler\n'.repeat(46) + `$c = \\${CLASS}::get_type();\n`);
        const one = t => `[${t} UTC] PHP Fatal error:  Uncaught Error: Class "${CLASS}" not found in ${root}/${THEME_FILE}:48\nStack trace:\n#0 {main}\n  thrown in ${root}/${THEME_FILE} on line 48\n`;
        write(root, 'wp-content/debug.log', one('06-Nov-2026 09:00:00') + one('06-Nov-2026 09:00:59'));
    }
    // one investigation: the live probe's observation (realStatus on /), the copy from a database file (copyStatus on /), validation and the gate report
    async function pipeline(name, { realStatus, copyStatus = 200 }) {
        const root = path.join(tmp, 'pipe-' + name, 'wp'); classSite(root);
        const config = path.join(root, 'plugin-guard.config.json'); fs.writeFileSync(config, '{}');
        const iss = store.create({ title: 'Critical error', description: 'The site shows a critical error', symptom: 'white-screen', environment: 'local', url: 'http://127.0.0.1:9/', root, pages: ['/'] });
        const dir = store.dirOf(iss.id);
        await require('../issue/evidence').run(iss.id, { root, probeOptions: { probe: false } });
        const anz = require('../issue/analysis').run(iss.id, { root, config });
        const ij = path.join(dir, 'issue.json'), j = JSON.parse(fs.readFileSync(ij, 'utf8')); j.probe_ran_at = '2026-11-06T09:01:00.000Z'; fs.writeFileSync(ij, JSON.stringify(j));
        fs.writeFileSync(path.join(dir, 'work', 'probe.json'), JSON.stringify({ schema: 1, pages: [{ url: 'http://127.0.0.1:9/', status: realStatus, viewport: { name: 'laptop' }, loaded: true }] }));
        const F = fakeEnv({ wp: wpRules });
        const real = probe.runSandbox;
        probe.runSandbox = async (id, o) => ({ ok: true, pages: [{ url: `${o.url}/`, status: copyStatus, loaded: true, viewport: { name: 'laptop' }, text_flags: { blank: false, critical: false } }], status_codes: [copyStatus], oracle: { result: 'no' } });
        try { await phase.run(iss.id, { root, options: { sandbox: true, noBisect: true, dump: SQL }, analysis: { ...anz.analysis, components: anz.analysis.components, top: anz.analysis.top }, sandboxOptions: F.opts() }); } finally { probe.runSandbox = real; }
        const validate = require('../issue/validate'), resolve = require('../issue/resolve');
        const val = validate.run(iss.id, { root, config, lint: () => ({ ok: true, message: '' }) }), pol = validate.policyFor(root, config);
        resultMod.write(iss.id, { validation: val, plans: resolve.build(iss.id, val, { root, policy: pol, dir }), dir, root, policy: pol, gate: true });
        const rd = f => { try { return JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { return null; } };
        return { id: iss.id, dir, val, F, f: rd('result/findings.json'), sbx: rd('work/sandbox.json'), fd: rd('work/fidelity.json'), md: fs.readFileSync(path.join(dir, 'result', 'ISSUE-REPORT.md'), 'utf8'), html: fs.readFileSync(path.join(dir, 'result', 'issue.html'), 'utf8') };
    }

    group('1 + 2. a wrong address (404) and a copy that did not match (fixture through the whole pipeline)');
    const w = await pipeline('wrong-address', { realStatus: 404 });
    const cf = w.f.case_file, txt = w.f.summary.text_report;
    ok(w.fd && w.fd.level === 'did-not-match' && w.fd.status_class === '4xx' && w.sbx.sandbox, `the copy was built and did not match; the compared page answered 4xx (${w.fd && w.fd.reasons[0]})`);
    ok(cf.see.includes(ADDR404) && w.md.includes(`- ${ADDR404}`), '"What you see" has the address sentence');
    ok((cf.status.cautions || [])[0] === ADDR404 && txt.indexOf(ADDR404) < txt.indexOf('WHAT YOU SEE') && w.md.indexOf(ADDR404) < w.md.indexOf('## What you see'), 'the STATUS area has it (findings.json, the text summary, the Markdown report)');
    ok(!w.md.includes(FINE) && !txt.includes(FINE) && !JSON.stringify(w.f).includes(FINE) && !w.html.includes(FINE), `never "${FINE}" (Markdown, text summary, findings.json, page)`);
    ok(JSON.stringify(cf.status.fidelity.reasons) === JSON.stringify([ADDR404]) && !GENERIC.some(g => w.md.includes(`- ${g}`)), 'Likely reasons: the address first and alone; the generic list is dropped');
    ok(/a throwaway test copy \(it was built\)/.test(cf.status.looked) && !/Not looked at:[^.]*a throwaway test copy/.test(cf.status.looked) && txt.includes(cf.status.looked) && w.md.includes(cf.status.looked), `STATUS says a copy was built: "${cf.status.looked}"`);
    ok(cf.level && cf.level.n === 3, 'the level is "The test copy could not confirm this" (unchanged)');
    ok(w.html.includes(ADDR404) && /CF\.status\.cautions/.test(w.html), 'the page carries the sentence and renders it in the STATUS area');
    ok(w.F && leftovers(w.F) === 0, 'torn down');

    group('1. the site protecting itself (403) through the whole pipeline');
    const pr = await pipeline('protected', { realStatus: 403 });
    ok(pr.f.case_file.see.includes(PROT403) && pr.f.case_file.status.cautions[0] === PROT403 && JSON.stringify(pr.f.case_file.status.fidelity.reasons) === JSON.stringify([PROT403]), 'STATUS, "What you see" and Likely reasons: the protection sentence');
    ok(!/Check the address|may not be the address/.test(pr.md) && !pr.md.includes(FINE) && !GENERIC.some(g => pr.md.includes(`- ${g}`)), 'no "check the address", no "did not answer with an error", no generic list');
    ok(pr.F && leftovers(pr.F) === 0, 'torn down');

    group('2. a copy that did not match on a 500 page: STATUS says a copy was built; the generic reasons stay');
    const m = await pipeline('mismatch-500', { realStatus: 500 });
    const cfm = m.f.case_file;
    ok(m.fd && m.fd.level === 'did-not-match' && m.sbx.reproduced_in_sandbox === null && m.sbx.sandbox, 'did not match, reproduced_in_sandbox null, a copy was built');
    ok(/a throwaway test copy \(it was built\)/.test(cfm.status.looked) && !/Not looked at:[^.]*a throwaway test copy/.test(m.md) && !/Not looked at:[^.]*a throwaway test copy/.test(m.f.summary.text_report), `never "Not looked at: a throwaway test copy" after a build: "${cfm.status.looked}"`);
    ok(JSON.stringify(cfm.status.fidelity.reasons) === JSON.stringify(GENERIC) && !m.md.includes('Your address answered'), 'a 500 page: the generic likely reasons as before, no address sentence');
    ok(JSON.stringify(m.f.verdict) === JSON.stringify(w.f.verdict) || m.f.verdict.label === w.f.verdict.label, `the verdict does not depend on the wording (${m.f.verdict.label})`);
    ok(m.F && leftovers(m.F) === 0, 'torn down');

    group('gate off: no new text');
    {
        const f0 = resultMod.build(w.id, { validation: w.val, plans: [], dir: w.dir, gate: false });
        const m0 = resultMod.markdown(f0);
        ok(!f0.case_file && !m0.includes('Your address answered') && !m0.includes('(it was built)'), 'gate off: no address sentence and no new "Looked at" text (the golden files are checked by selftest-gate-output.js)');
    }

    group('3. the copy keeps the original file times (real-run evidence: every plugin showed the day of the copy)');
    {
        const orig = path.join(tmp, 'mt', 'wp'), N = 8;
        write(orig, 'wp-includes/version.php', "<?php\n$wp_version = '6.8.1';\n");
        const when = i => new Date(Date.UTC(2024, 2, 1 + i, 12, 0, 0));
        for (let i = 0; i < N; i++) {
            const f = write(orig, `wp-content/plugins/p${i}/p${i}.php`, `<?php\n/**\n * Plugin Name: P${i}\n * Version: 1.${i}.0\n */\n`);
            fs.utimesSync(f, when(i), when(i));
        }
        const css = write(orig, 'wp-content/themes/acme/style.css', '/*\nTheme Name: Acme\nVersion: 1.0\n*/'); fs.utimesSync(css, when(20), when(20));
        fs.symlinkSync(path.join(orig, 'wp-content', 'plugins', 'p0', 'p0.php'), path.join(orig, 'wp-content', 'plugins', 'p1', 'link.php'));
        const before = Object.fromEntries([...Array(N).keys()].map(i => [i, fs.statSync(path.join(orig, `wp-content/plugins/p${i}/p${i}.php`)).mtimeMs]));
        const issueDir = path.join(tmp, 'mt-intake'), dest = path.join(issueDir, 'site-copy'); fs.mkdirSync(issueDir, { recursive: true, mode: 0o700 });
        intake.copyForIssue({ site: { root: orig }, issueDir, destSite: dest });
        const copied = [...Array(N).keys()].map(i => fs.statSync(path.join(dest, `wp-content/plugins/p${i}/p${i}.php`)).mtimeMs);
        ok(copied.every((t, i) => t === when(i).getTime()), 'every plugin file in the copy has the original modification time');
        ok([...Array(N).keys()].every(i => fs.statSync(path.join(orig, `wp-content/plugins/p${i}/p${i}.php`)).mtimeMs === before[i]), 'the original files are unchanged (only read)');
        ok(!fs.existsSync(path.join(dest, 'wp-content/plugins/p1/link.php')), 'a symbolic link is still never followed or copied');
        const vsrc = path.join(orig, 'wp-includes/version.php'); fs.utimesSync(vsrc, when(9), when(9));
        const dest2 = path.join(issueDir, 'site-copy-2'); intake.copyForIssue({ site: { root: orig }, issueDir, destSite: dest2 });
        ok(fs.statSync(path.join(dest2, 'wp-includes/version.php')).mtimeMs === when(9).getTime(), 'the core file copied by the intake keeps its time too');
        const sbDir = path.join(tmp, 'mt-sbx'); fs.mkdirSync(sbDir, { recursive: true, mode: 0o700 });
        sbCopy.copySite(orig, path.join(sbDir, 'site'), { sandboxDir: sbDir });
        ok([...Array(N).keys()].every(i => fs.statSync(path.join(sbDir, 'site', `wp-content/plugins/p${i}/p${i}.php`)).mtimeMs === when(i).getTime()), 'the sandbox copy (issue/sandbox-copy.js) keeps them as well');

        // the first question, through `issue investigate` on the copy (as the wizard runs it): the real dates, not the day of the copy
        const iss = store.create({ title: 'Dates fixture', description: '', symptom: 'other', environment: 'local', url: 'http://127.0.0.1:9/', pages: [], root: dest });
        const said = [], lines = [];
        const io = { say: t => said.push(t), askRaw: async () => null };
        const old = console.log; console.log = (...a) => lines.push(a.join(' '));
        try { await cli.investigate(iss.id, { 'no-probe': true }, 'investigate', { io, interactive: true }); } finally { console.log = old; }
        const q = said.join('\n');
        const today = new Date().toISOString().slice(0, 10);
        const dated = [...q.matchAll(/last changed on (\d{4}-\d{2}-\d{2})/g)].map(x => x[1]);
        ok(/what changed on your website/.test(q) && dated.length >= 7, `the first question was asked and lists the plugins with a date (${dated.length} dates)`);
        const listed = [...q.matchAll(/"P(\d)" \(version 1\.\d\.0\), its files last changed on (\d{4}-\d{2}-\d{2})/g)].map(x => [Number(x[1]), x[2]]);
        ok(listed.length >= 7 && listed.every(([i, d]) => d === when(i).toISOString().slice(0, 10)), `each listed plugin shows ITS original date (${listed.length} listed, at most seven choices)`);
        ok(!dated.some(d => d === today) && new Set(dated).size === dated.length, `no plugin with the day of the copy (${today}); ${new Set(dated).size} different dates`);
        const ij = JSON.parse(fs.readFileSync(path.join(store.dirOf(iss.id), 'issue.json'), 'utf8'));
        ok(!('times_preserved' in ij), 'times kept: nothing extra recorded');

        // forced failure: setting the times fails -> recorded on the copy result, and the first question says nothing about dates
        let calls = 0; const failing = () => { calls++; throw Object.assign(new Error('not supported'), { code: 'ENOTSUP' }); };
        const issF = store.create({ title: 'Dates lost fixture', description: '', symptom: 'other', environment: 'local', url: 'http://127.0.0.1:9/', pages: [] });
        const dirF = store.dirOf(issF.id), destF = path.join(dirF, 'site-copy');
        const rF = intake.copyForIssue({ site: { root: orig }, issueDir: dirF, destSite: destF, setTimes: failing });
        ok(rF.times_preserved === false && rF.times_failed === calls && calls >= N, `the copy result records it: times_preserved false, times_failed ${rF.times_failed}`);
        const rS = sbCopy.copySite(orig, path.join(sbDir, 'site-2'), { sandboxDir: sbDir, setTimes: failing });
        ok(rS.times_preserved === false && rS.times_failed >= N, 'the sandbox copy records it too');
        const rOk = sbCopy.copySite(orig, path.join(sbDir, 'site-3'), { sandboxDir: sbDir });
        ok(!('times_preserved' in rOk) && !('times_failed' in rOk), 'times kept: the copy result is unchanged (no new field)');
        // the wizard writes work/intake.json from the copy result (lib/wizard.js); the same fields here
        fs.mkdirSync(path.join(dirF, 'work'), { recursive: true });
        fs.writeFileSync(path.join(dirF, 'work', 'intake.json'), JSON.stringify({ steps: rF.steps, files: rF.files, times_preserved: rF.times_preserved, times_failed: rF.times_failed }));
        const sv = store.load(issF.id); sv.root = destF; store.save(sv);
        const saidF = []; const linesF = [];
        const ioF = { say: t => saidF.push(t), askRaw: async () => null };
        const oldF = console.log; console.log = (...a) => linesF.push(a.join(' '));
        try { await cli.investigate(issF.id, { 'no-probe': true }, 'investigate', { io: ioF, interactive: true }); } finally { console.log = oldF; }
        const qF = saidF.join('\n');
        ok(/what changed on your website/.test(qF) && /I updated or installed "P\d" \(version 1\.\d\.0\)/.test(qF), 'the first question is still asked with the plugins');
        ok(!/last changed on/.test(qF) && !qF.includes(today), 'times not kept: no date at all in the first question (never the day of the copy)');
        // hostile file times on fixture files: far future, 0 (1970), negative (before 1970), a fraction of a second: copied as they are, no crash, nothing recorded
        const hostile = [['future', new Date(Date.UTC(2100, 0, 1))], ['zero', new Date(0)], ['negative', new Date(-86400000 * 400)], ['odd', new Date(1234567891.5)]];
        const hroot = path.join(tmp, 'mt-hostile', 'wp'); write(hroot, 'wp-includes/version.php', "<?php\n$wp_version = '6.8.1';\n");
        const set = [];
        for (const [n, d] of hostile) { const f = write(hroot, `wp-content/plugins/${n}/${n}.php`, `<?php\n/**\n * Plugin Name: ${n}\n */\n`); let okSet = true; try { fs.utimesSync(f, d, d); } catch { okSet = false; } set.push([n, okSet, fs.statSync(f).mtimeMs]); }
        const hDir = path.join(tmp, 'mt-hostile-intake'); fs.mkdirSync(hDir, { recursive: true, mode: 0o700 });
        let hr = null, crash = null; try { hr = intake.copyForIssue({ site: { root: hroot }, issueDir: hDir, destSite: path.join(hDir, 'site-copy') }); } catch (e) { crash = e; }
        ok(!crash && hr && !('times_preserved' in hr), `hostile times: no crash, nothing recorded (times preserved)${crash ? `: ${crash.message}` : ''}`);
        ok(set.every(([n, , t]) => fs.statSync(path.join(hDir, 'site-copy', `wp-content/plugins/${n}/${n}.php`)).mtimeMs === t), `each copied as it is (${set.map(([n, s1]) => `${n}${s1 ? '' : ' (could not be set on this file system)'}`).join(', ')})`);
        // an injected NaN time: the call fails (or sets nothing usable) -> a failure, recorded, and the first question shows no dates
        const nanSet = (to) => fs.lutimesSync(to, NaN, NaN);
        const issN = store.create({ title: 'NaN fixture', description: '', symptom: 'other', environment: 'local', url: 'http://127.0.0.1:9/', pages: [] });
        const dirN = store.dirOf(issN.id), destN = path.join(dirN, 'site-copy');
        const rN = intake.copyForIssue({ site: { root: orig }, issueDir: dirN, destSite: destN, setTimes: nanSet });
        ok(rN.times_preserved === false && rN.times_failed >= N, `an injected NaN counts as a failure: times_preserved false, times_failed ${rN.times_failed}`);
        fs.mkdirSync(path.join(dirN, 'work'), { recursive: true });
        fs.writeFileSync(path.join(dirN, 'work', 'intake.json'), JSON.stringify({ steps: rN.steps, files: rN.files, times_preserved: rN.times_preserved, times_failed: rN.times_failed }));
        const svN = store.load(issN.id); svN.root = destN; store.save(svN);
        const saidN = []; const oldN = console.log; console.log = () => {};
        try { await cli.investigate(issN.id, { 'no-probe': true }, 'investigate', { io: { say: t => saidN.push(t), askRaw: async () => null }, interactive: true }); } finally { console.log = oldN; }
        ok(/what changed on your website/.test(saidN.join('\n')) && !/last changed on/.test(saidN.join('\n')), 'NaN: the first question shows no dates');
        // a file system that ignores the call (no error, the time unchanged) is caught by the check afterwards
        const rQ = sbCopy.copySite(orig, path.join(sbDir, 'site-4'), { sandboxDir: sbDir, setTimes: () => {} });
        ok(rQ.times_preserved === false && rQ.times_failed >= N, 'a silent no-op is a failure too (the copy is checked after setting)');
        const wz = fs.readFileSync(path.join(__dirname, '..', 'lib', 'wizard.js'), 'utf8');
        ok(/times_preserved: false, times_failed: copied\.times_failed/.test(wz), 'the wizard writes the record into work/intake.json');
    }

    // ================================================================ 6d-3 fix step 2 (HANDOFF row 59): "0) Skip the test copy" / --no-replica
    // Rule: an explicit choice not to build a copy (the wizard's answer 0, or --no-replica) says "You chose not to build a test copy." and lists NOTHING
    // as missing, whatever else was missing (no file, no Docker, no code, live). Without that choice the missing list is as before.
    group('4. the person chose not to build a test copy: the sentence, nothing listed as missing');
    {
        const CHOSE = 'You chose not to build a test copy.';
        ok(caseFile.CHOSE_NO_COPY === CHOSE, `the exact sentence ("${caseFile.CHOSE_NO_COPY}")`);
        const RP = (x = {}) => ({ requested: false, database_file: false, docker: null, copy_built: false, ...x });
        const sk = caseFile.copyLevel(null, RP({ skipped: true }), { hasCode: true });
        ok(sk.n === 2 && sk.heading === 'Not tested on a copy' && sk.missing.length === 0 && sk.lines[0] === CHOSE && sk.lines.includes(caseFile.NOT_TESTED_LABEL), 'skipped: level 2, the sentence first, no missing item (not "a database export file")');
        const skAll = caseFile.copyLevel(null, RP({ skipped: true, docker: false, database_file: true }), { hasCode: false });
        ok(skAll.missing.length === 0 && skAll.lines[0] === CHOSE, 'skipped AND no Docker, no code: the explicit choice wins, nothing listed');
        // owner: the live-site reason always wins over the skip sentence
        for (const [rp, what] of [[RP({ skipped: true, live: true }), 'replica.live'], [RP({ skipped: true, db_dropped_live: true, docker: false }), 'db_dropped_live']]) {
            const l = caseFile.copyLevel(null, rp, { hasCode: true });
            ok(JSON.stringify(l.missing) === JSON.stringify([caseFile.MISSING_TEXT.live]) && !l.lines.includes(CHOSE), `skipped on a LIVE site (${what}): the live item, not the skip sentence`);
        }
        const plainLv = caseFile.copyLevel(null, RP(), { hasCode: true });
        ok(JSON.stringify(plainLv.missing) === JSON.stringify([caseFile.MISSING_TEXT.database]) && !plainLv.lines.includes(CHOSE), 'not skipped, no file: the database file is still listed, no choice sentence');
        ok(JSON.stringify(caseFile.copyLevel(null, RP({ docker: false, database_file: true }), { hasCode: true }).missing) === JSON.stringify([caseFile.MISSING_TEXT.docker]), 'not skipped, a file but no Docker: Docker is listed as before');
        const mkF = () => ({ issue: { title: 'The site is white', id: 'iss-x' }, issue_title_short: 'The site is white', hypotheses: [], findings: [], likely: [], advisories: [], reported: { images: [] }, checkpoints: null });
        const cfS = caseFile.build(mkF(), { comps: [], facts: { hasLog: true, hasCode: true, probeRan: false }, replica: RP({ skipped: true }) });
        const mdS = caseFile.markdown(cfS, t => String(t)).join('\n'), clS = caseFile.cli({ ...cfS, checked: null });
        ok(mdS.includes(CHOSE) && !mdS.includes(caseFile.MISSING_INTRO) && !mdS.includes(caseFile.MISSING_TEXT.database), 'Markdown: the sentence, no "was missing" list, no database file');
        ok(/NOT TESTED ON A COPY/.test(clS) && clS.includes(CHOSE) && !clS.includes(caseFile.MISSING_INTRO) && !clS.includes(caseFile.MISSING_TEXT.database), 'command line: "NOT TESTED ON A COPY" with the sentence and nothing listed');
        // the wizard, end to end: a database file given, then "0) Skip the test copy" (no Docker is used: nothing is built)
        const { PassThrough } = require('stream');
        const wizard = require('../lib/wizard'), trees = require('./fixtures/issue/trees');
        const WS = path.join(tmp, 'skip-site', 'wp'); trees.duplicateFunction(WS); write(WS, 'wp-content/themes/acme/style.css', '/* Theme Name: Acme */');
        const vf = require('../issue/verify-fixes'), realVf = vf.run; vf.run = async () => ({ steps: [], results: 0 });
        async function wizRun(name, answers, flags) {
            const input = new PassThrough(), output = new PassThrough(); let text = ''; output.on('data', d => { text += d; });
            input.end(answers.join('\n') + (answers.length ? '\n' : ''));
            const saved = process.env.PLUGIN_GUARD_ISSUES, log = console.log; console.log = (...a) => { text += a.join(' ') + '\n'; };
            const out = path.join(tmp, 'skip-out-' + name); let error = null;
            try { await wizard.run({ _: [], description: 'The shop page is white since the update', root: WS, 'no-probe': true, out, ...flags }, { input, output, tty: true, cwd: tmp, env: { HOME: tmp }, preflight: () => ({ ok: true }), siteRoots: [] }); }
            catch (e) { error = e; } finally { console.log = log; if (saved === undefined) delete process.env.PLUGIN_GUARD_ISSUES; else process.env.PLUGIN_GUARD_ISSUES = saved; }
            const ids = fs.existsSync(out) ? fs.readdirSync(out).filter(x => store.ISSUE_RE.test(x)) : [];
            const idir = ids.length ? path.join(out, ids[0]) : null;
            const rd = rel => (idir && fs.existsSync(path.join(idir, rel)) ? JSON.parse(fs.readFileSync(path.join(idir, rel), 'utf8')) : null);
            return { text, error, f: rd('result/findings.json'), sj: rd('work/sandbox.json') };
        }
        try {
            const r0 = await wizRun('zero', ['', '', '0'], { sandbox: true, 'db-dump': SQL });
            const lv0 = r0.f && r0.f.case_file && r0.f.case_file.level;
            ok(!r0.error && r0.text.includes('0) Skip the test copy') && r0.sj && r0.sj.replica && r0.sj.replica.skipped === true, `answer 0: sandbox.json records replica.skipped${r0.error ? ` (${r0.error.message})` : ''}`);
            ok(lv0 && lv0.n === 2 && lv0.missing.length === 0 && lv0.lines[0] === CHOSE && !JSON.stringify(r0.f.case_file).includes(caseFile.MISSING_TEXT.database), `answer 0 with a database file: "${CHOSE}" and nothing listed as missing (${lv0 ? JSON.stringify(lv0.missing) : 'no level'})`);
            const rN = await wizRun('norep', [], { 'db-dump': SQL, 'no-replica': true, yes: true });
            const lvN = rN.f && rN.f.case_file && rN.f.case_file.level;
            ok(!rN.error && lvN && lvN.missing.length === 0 && lvN.lines[0] === CHOSE, `--no-replica (the same meaning): the sentence, nothing listed${rN.error ? ` (${rN.error.message})` : ''}`);
            // a LIVE site with --no-replica (the wizard), and with the skip choice (cli.investigate with the wizard's 'copy-skipped'): the live item wins
            const rL = await wizRun('live-norep', [], { 'db-dump': SQL, 'no-replica': true, yes: true, url: 'https://shop.example.net/', env: 'live', authorized: true });
            const lvL = rL.f && rL.f.case_file && rL.f.case_file.level;
            ok(!rL.error && lvL && JSON.stringify(lvL.missing) === JSON.stringify([caseFile.MISSING_TEXT.live]) && !lvL.lines.includes(CHOSE) && rL.sj.replica.skipped === true && rL.sj.replica.live === true, `live + --no-replica: the "never made for a live site" item, not the skip sentence (${lvL ? JSON.stringify(lvL.missing) : 'no level'})${rL.error ? ` (${rL.error.message})` : ''}`);
            const issL = store.create({ title: 'Live skip', description: 'The shop page is white', symptom: 'white-screen', environment: 'live', url: 'https://shop.example.net/', authorized: true, root: WS, pages: ['/'] });
            const logL = console.log; console.log = () => {}; let eL = null;
            try { await cli.investigate(issL.id, { _: [], 'copy-skipped': true, 'db-dump': SQL, sandbox: true, 'no-probe': true, 'no-questions': true, yes: true, gate: true }, 'investigate', { interactive: false, loginOut: { tty: false, write: () => {} } }); } catch (e) { eL = e; } finally { console.log = logL; }
            const fLs = fs.existsSync(path.join(store.dirOf(issL.id), 'result', 'findings.json')) ? JSON.parse(fs.readFileSync(path.join(store.dirOf(issL.id), 'result', 'findings.json'), 'utf8')) : null;
            const lvLs = fLs && fLs.case_file && fLs.case_file.level;
            ok(!eL && lvLs && JSON.stringify(lvLs.missing) === JSON.stringify([caseFile.MISSING_TEXT.live]) && !lvLs.lines.includes(CHOSE), `live + the skip choice: the live item, not the skip sentence (${lvLs ? JSON.stringify(lvLs.missing) : 'no level'})${eL ? ` (${eL.message})` : ''}`);
            const rE = await wizRun('enter', ['', '', ''], {});
            const lvE = rE.f && rE.f.case_file && rE.f.case_file.level;
            ok(!rE.error && lvE && lvE.missing.includes(caseFile.MISSING_TEXT.database) && !lvE.lines.includes(CHOSE) && !(rE.sj && rE.sj.replica && 'skipped' in rE.sj.replica), 'Enter (no file, no choice to skip): the database file is still listed, no sentence, no skipped field');
        } finally { vf.run = realVf; }
    }

    group('5. the address sentence is never in a case\'s "How sure" list (owner); STATUS and "What you see" keep it');
    {
        const U = 'http://127.0.0.1:9/';
        const mkF = () => ({ issue: { title: 'The site is white', id: 'iss-x' }, issue_title_short: 'The site is white', hypotheses: [], findings: [], likely: [], advisories: [], reported: { images: [] }, checkpoints: null });
        const facts = { hasLog: true, hasCode: true, probeRan: true };
        const ww = require('../issue/whats-wrong');
        const fr = { class: CLASS, kind: 'class', file: 'wp-content/themes/unicamp/x.php', line: 3, file_kind: 'theme', provider: {}, scan: {} };
        const howSure = cf => cf.cases.flatMap(c => c.rows.filter(r => r[0] === 'How sure').flatMap(r => r[1]));
        for (const [code, sentence] of [[404, ADDR404], [403, PROT403], [429, PROT429]]) {
            for (const tier of ['likely', 'confirmed']) {
                const pages = [{ url: U, status: code, loaded: true }];
                const box = ww.build(fr, { components: [], issue: { url: U, title: 't' }, probePages: pages, advisories: [], templateTotal: 0, ran: { probe: true }, fileComponent: '' }, tier);
                const f = tier === 'likely' ? { ...mkF(), what_is_wrong: box, likely: [{ id: 'h1', box }] } : { ...mkF(), what_is_wrong: box, findings: [{ id: 'h1', box }] };
                const cf = caseFile.build(f, { comps: [], facts, issueUrl: U, probePages: pages });
                ok(cf.cases.length > 0 && !howSure(cf).some(x => x.startsWith('Your address answered HTTP ')) && cf.status.cautions[0] === sentence && cf.see.includes(sentence), `${code}, ${tier} case: not in "How sure"; in STATUS and "What you see"`);
            }
        }
    }

    fs.rmSync(tmp, { recursive: true, force: true });
    console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll checks passed');
    process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
