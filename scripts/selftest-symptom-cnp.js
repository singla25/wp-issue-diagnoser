#!/usr/bin/env node
// Self-test of step 4i-c: the symptom answer "The browser says the connection is not private" (id connection-not-private).
// The value says what the browser showed, not which part of the site is at fault, so it is treated EXACTLY like "other" (lib/symptoms.js): no score, no known-pattern
// filter and no verdict may differ from "other". Covered here:
//   - the store: the new id and its generic default oracle; the older ids and their numbers are unchanged; a wrong id is still refused;
//   - the "What does the problem look like?" question: the first 8 choices are unchanged, the new one comes right before "None of these", an answer rewrites the symptom;
//   - every comparison with 'other' in the issue code goes through isOtherLike (a source scan: a future raw comparison fails here);
//   - clue-match and kb treat the new id like "other" (and "layout" differently: the control that proves the check can fail);
//   - two real runs (no site files, with a site folder): the verdict, the confidence text, the symptom text and the counts are IDENTICAL to a run with "other";
//   - the generic oracle on a page that loads fine says what "other" says; retest cannot give FIXED_VERIFIED for it (a saved failing page, then a page that loads fine: the comparison says "Fixed", and the conditions still refuse FIXED_VERIFIED);
//   - the interactive "Symptom type (number)" default is "Other" (it had moved to the last symptom of the list).
// Fixture servers on 127.0.0.1 only. Never touches a real site.
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pg-cnp-')));
process.env.PLUGIN_GUARD_ISSUES = path.join(tmp, 'issues');
const ENVX = { PG_PROBE_NAV_DELAY_MS: '0', PG_PROBE_REQUEST_DELAY_MS: '0', PG_PROBE_5XX_RETRY_DELAY_MS: '0', PG_PROBE_COOLDOWN_FILE: path.join(tmp, 'cool.json') };
Object.assign(process.env, ENVX);
let failures = 0;
const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`); if (!c) failures++; };
const group = t => console.log(`\n== ${t}`);
const store = require('../lib/issue-store'), Q = require('../issue/questions');
const GUARD = path.join(__dirname, 'guard.js');
const CNP = 'connection-not-private', LABEL = 'The browser says the connection is not private';
const OLD = ['white-screen', 'js-error', 'layout', 'form-checkout', 'login-admin', 'slow', 'wrong-content', 'other', 'redirect'];
const OK200 = '<!doctype html><html><head><title>Fixture</title></head><body><h1>Fixture shop</h1><p>The page works and has enough text to look like a real page.</p></body></html>';
const runAsync = (args, extra = {}) => new Promise(resolve => { const c = spawn(process.execPath, [GUARD, ...args], { cwd: tmp, env: { ...process.env, ...extra } }); let so = '', se = ''; c.stdout.on('data', d => { so += d; }); c.stderr.on('data', d => { se += d; }); c.on('close', code => resolve({ status: code, stdout: so, stderr: se })); });
const write = (root, rel, text) => { const f = path.join(root, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); };

(async () => {
    group('the store');
    ok(OLD.every((id, i) => store.SYMPTOMS[i] && store.SYMPTOMS[i][0] === id), 'the nine older symptom ids keep their numbers');
    ok(store.SYMPTOMS[9] && store.SYMPTOMS[9][0] === CNP && store.SYMPTOMS[9][1] === LABEL && store.SYMPTOM_IDS.includes(CNP), 'the new id is the 10th and has the plain label');
    ok(store.DEFAULT_ORACLE[CNP] === 'generic' && store.DEFAULT_ORACLE.other === 'generic', 'its default oracle is "generic", the same as "other"');
    const mk = (symptom, extra = {}) => store.create({ title: 't', description: 'The browser says the connection is not private', symptom, environment: 'local', pages: [], ...extra });
    let made = null; try { made = mk(CNP); } catch { /* old code refuses */ }
    ok(!!made && made.symptom === CNP && made.oracle.type === 'generic', 'create() accepts the new id');
    let refused = false; try { mk('nope'); } catch { refused = true; }
    ok(refused, 'a wrong symptom id is still refused');

    group('the question "What does the problem look like?"');
    ok(Q.SYMPTOM_CHOICES.slice(0, 8).map(c => c[0]).join() === 'white-screen,js-error,layout,form-checkout,login-admin,slow,redirect,wrong-content', 'the first 8 choices keep their order (so the numbers 1 to 8 do not change)');
    const q = Q.RULES.what.build({ issue: { symptom: 'other' }, clues: [] });
    ok(q.choices.length === 10 && q.choices[8].value === CNP && q.choices[8].label === LABEL && q.choices[9].unknown === true && q.choices[9].label === 'None of these', 'the new choice (9) comes right before "None of these" (10)');
    const patch = Q.toPatch(q, q.choices[8], null, { issue: { symptom: 'other', oracle: { defaulted: true } }, clues: [] });
    ok(patch.fields.symptom === CNP, 'answering it rewrites the symptom');
    ok(Q.RULES.what.applies({ issue: { symptom: 'other' }, clues: [] }) && !Q.RULES.what.applies({ issue: { symptom: CNP }, clues: [] }), 'the question is asked for "other" and is not asked again when the symptom is already this one');

    group('every comparison with "other" goes through isOtherLike');
    const S = require('../lib/symptoms');
    ok(S.isOtherLike('other') && S.isOtherLike(CNP) && !S.isOtherLike('layout') && !S.isOtherLike('white-screen') && !S.isOtherLike(undefined), 'isOtherLike: other and the new id only');
    const files = [];
    for (const d of ['issue', 'lib', 'probe', 'checks', 'agents']) { try { for (const n of fs.readdirSync(path.join(__dirname, '..', d))) if (/\.js$/.test(n)) files.push(path.join(d, n)); } catch { /* folder missing */ } }
    const raw = [];
    const RAW = /\b(?:symptom|sym)\b[^\n]*(?:===|!==|==|!=)\s*['"]other['"]|['"]other['"]\s*(?:===|!==|==|!=)[^\n]*\b(?:symptom|sym)\b|\bsymptoms?\b[^\n]*\.includes\(\s*['"]other['"]|case\s+['"]other['"]/;
    for (const rel of files) fs.readFileSync(path.join(__dirname, '..', rel), 'utf8').split('\n').forEach((l, i) => { if (RAW.test(l) && !/isOtherLike/.test(l)) raw.push(`${rel}:${i + 1}`); });
    // allowed raw comparisons: the question rule (asked only for "other"), the wizard default and the store default are about the stored value "other" itself
    const allowed = raw.filter(x => /^issue\/questions\.js:|^lib\/issue-store\.js:|^lib\/wizard\.js:|^lib\/issue-cli\.js:/.test(x));
    ok(raw.length === allowed.length, `no raw "symptom === 'other'" comparison is left outside questions, store, wizard and the issue command (${raw.filter(x => !allowed.includes(x)).join(', ') || 'none'})`);
    const cm = require('../issue/clue-match');
    const fam = { fatal: ['white-screen'], hook: ['wrong-content'] };
    const mkcx = symptom => cm.context({ component_hints: [], clues: [] }, { symptom }, fam);
    const finding = { components: ['plugin:x'], evidence: [], severity: 'P2', family: 'fatal' };
    ok(cm.matches(finding, mkcx('other')).ok === cm.matches(finding, mkcx(CNP)).ok && cm.matches(finding, mkcx('white-screen')).ok === true && cm.matches(finding, mkcx(CNP)).ok === false, 'clue-match: the new id answers like "other"; a real symptom of the family still matches (the control)');
    const kb = require('../issue/kb');
    const entry = { id: 'e1', title: 'T', detector: 'installed-set', params: { slugs: ['pa', 'pb'], min: 2 }, symptoms: ['white-screen'] };
    const kbRun = symptom => kb.evaluate({ components: [{ kind: 'plugin', slug: 'pa', path: 'a' }, { kind: 'plugin', slug: 'pb', path: 'b' }], facts: {}, observations: [], collisions: [], symptom, clues: [] }, [entry]);
    const kOther = kbRun('other'), kCnp = kbRun(CNP), kLay = kbRun('layout');
    const sh = r => JSON.stringify({ hits: r.map(h => h.id), na: r.not_applicable.map(h => h.id) });
    const kbOk = sh(kOther) === '{"hits":["e1"],"na":[]}' && sh(kCnp) === sh(kOther) && sh(kLay) === '{"hits":[],"na":["e1"]}';
    ok(kbOk, 'the known-patterns filter: the new id keeps the entry exactly like "other"; "layout" drops it as not applicable (the control)');

    group('hypotheses: the same score as "other" (the one place where a score could differ)');
    const evidenceMod = require('../issue/evidence'), analysisMod = require('../issue/analysis'), crypto = require('crypto');
    const hdr = (n, v = '1.0') => `<?php\n/**\n * Plugin Name: ${n}\n * Version: ${v}\n */\n`;
    const dup = path.join(tmp, 'dupsite');
    write(dup, 'wp-config.php', '<?php // fixture'); write(dup, 'wp-includes/version.php', "<?php $wp_version = '6.6';");
    write(dup, 'wp-content/plugins/plugin-a/plugin-a.php', hdr('Plugin A') + 'function my_helper() { return "a"; }\n');
    write(dup, 'wp-content/plugins/plugin-b/plugin-b.php', hdr('Plugin B') + 'function my_helper() { return "b"; }\n');
    write(dup, 'wp-content/debug.log', '[27-Oct-2026 10:11:12 UTC] PHP Fatal error:  Cannot redeclare my_helper() (previously declared in /srv/s/wp-content/plugins/plugin-a/plugin-a.php:8) in /srv/s/wp-content/plugins/plugin-b/plugin-b.php on line 7\n');
    const hypsOf = async symptom => {
        const cfg = path.join(tmp, `cfg-${crypto.randomBytes(3).toString('hex')}.json`); fs.writeFileSync(cfg, JSON.stringify({ customPaths: ['wp-content/plugins/plugin-a', 'wp-content/plugins/plugin-b'] }));
        const issue = store.create({ title: 'Problem', description: 'The browser says the connection is not private', symptom, root: dup });
        await evidenceMod.run(issue.id, { root: dup, recognizer: async fl => fl.map(() => ({ text: '', confidence: 90, variants: [{ variant: 'original', text: '', confidence: 90 }], notes: [] })) });
        const an = analysisMod.run(issue.id, { root: dup, config: cfg });
        return an.hypotheses.hypotheses.map(h => ({ title: h.title, type: h.type, family: h.family, score: h.score, bd: h.score_breakdown }));
    };
    const hO = await hypsOf('other'), hC = await hypsOf(CNP), hL = await hypsOf('layout');
    ok(hO.length > 0 && JSON.stringify(hC) === JSON.stringify(hO), `the new id gives the same ${hO.length} hypotheses, scores and score breakdowns as "other"`);
    ok(!hC.some(h => h.bd.some(b => b.rule === 'symptom-mismatch')) && hL.some(h => h.bd.some(b => b.rule === 'symptom-mismatch')), 'no "symptom-mismatch" line for the new id; "layout" gets one on the same fixture (the control: the check can fail)');

    group('the generic oracle: the new id answers like "other"');
    const oracleMod = require('../issue/oracle');
    const pg = (status, text) => ({ url: 'http://127.0.0.1:1/', viewport: { name: 'laptop', width: 1280, height: 800 }, loaded: true, status, text, text_flags: oracleMod.textFlags(text), console_errors: [], page_errors: [], failed_requests: [], error_responses: [], redirects: [], measure: {} });
    const evalFor = (symptom, page) => { const { symptom: _s, ...r } = oracleMod.evaluate({ type: 'generic', value: null }, { pages: [page], planned: 1 }, { symptom }); return JSON.stringify(r); };   // the echoed symptom name is the only allowed difference
    const crit = pg(200, 'There has been a critical error on this website.');
    ok(evalFor(CNP, crit) === evalFor('other', crit) && evalFor('layout', crit) !== evalFor('other', crit), 'a critical-error page with status 200: the same answer as "other"; "layout" answers differently (the control)');
    ok(evalFor(CNP, pg(200, 'A fine page with plenty of ordinary text on it.')) === evalFor('other', pg(200, 'A fine page with plenty of ordinary text on it.')), 'a page that loads fine: the same answer as "other"');

    group('two real runs: the result is the same as with "other"');
    const sv = http.createServer((q2, res) => { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(OK200); });
    await new Promise(r => sv.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${sv.address().port}/`;
    const site = path.join(tmp, 'site');
    write(site, 'wp-config.php', '<?php // fixture');
    write(site, 'wp-includes/version.php', "<?php $wp_version = '6.6';");
    write(site, 'wp-content/plugins/acme/acme.php', '<?php\n/**\n * Plugin Name: Acme\n * Version: 1.0\n */\nfunction acme_helper() { return 1; }\n');
    write(site, 'wp-content/plugins/beta/beta.php', '<?php\n/**\n * Plugin Name: Beta\n * Version: 1.0\n */\nfunction acme_helper() { return 2; }\n');
    const findingsOf = async (symptom, withSite) => {
        const args = ['issue', 'new', '--title', 't', '--description', 'The browser says the connection is not private', '--symptom', symptom, '--no-prompt', '--no-questions', '--env', 'local', '--url', url];
        const n = await runAsync(withSite ? [...args, '--root', site] : [...args, '--no-files'], ENVX);
        const id = (/iss-[0-9]{8}-[0-9]{6}-[0-9a-f]{6}/.exec(n.stdout + n.stderr) || [])[0];
        const inv = await runAsync(['issue', 'investigate', id, '--no-prompt', '--gate', ...(withSite ? ['--root', site] : [])], ENVX);
        const fj = path.join(tmp, 'issues', id || 'none', 'result', 'findings.json');
        const f = fs.existsSync(fj) ? JSON.parse(fs.readFileSync(fj, 'utf8')) : null;
        return { id, f, inv };
    };
    const pick = f => f && JSON.stringify({ verdict: f.verdict, confidence_text: f.confidence_text, symptom_text: f.symptom_text, counts: f.counts, hyp: (f.hypotheses || []).map(h => [h.title, h.status]), cp: f.checkpoints && f.checkpoints.counts, live: f.live_checks && f.live_checks.sentence, tested: f.tested_text });
    for (const withSite of [false, true]) {
        const a = await findingsOf('other', withSite), b = await findingsOf(CNP, withSite);
        const label = withSite ? 'with a site folder' : 'no site files';
        ok(!!a.f && !!b.f && pick(a.f) === pick(b.f), `${label}: verdict, confidence text, symptom text, counts, hypotheses and checks are IDENTICAL to a run with "other" (label "${b.f && b.f.verdict.label}", confidence "${b.f && b.f.verdict.confidence}")`);
        ok(b.f && !/CONFIRMED|REPRODUCIBLE|FIXED_VERIFIED/.test(JSON.stringify(b.f.verdict)) && b.f.verdict.symptom_reproduced === a.f.verdict.symptom_reproduced, `${label}: nothing is stronger (symptom_reproduced "${b.f && b.f.verdict.symptom_reproduced}", the same as "other")`);
        if (withSite) console.log(`INFO  with a site folder, page loads fine, symptom ${CNP}: symptom_reproduced "${b.f && b.f.verdict.symptom_reproduced}", text "${b.f && b.f.symptom_text}" (the same for "other": "${a.f && a.f.symptom_text}")`);
        if (!withSite) {
            console.log(`INFO  generic oracle on a page that loads fine, symptom ${CNP}: symptom_reproduced "${b.f && b.f.verdict.symptom_reproduced}", text "${b.f && b.f.symptom_text}", oracle line "${b.f && b.f.oracle_text || ''}"`);
        }
    }
    group('retest: a "Fixed" comparison for the new symptom still cannot become FIXED_VERIFIED');
    const retestMod = require('../issue/retest');
    const rt = store.create({ title: 'rt', description: 'The browser says the connection is not private', symptom: CNP, environment: 'local', url, pages: [] });
    fs.mkdirSync(path.join(store.dirOf(rt.id), 'work'), { recursive: true });
    // the saved state of the ORIGINAL run: the symptom was seen on this page at this screen size (a live probe; no sandbox result was ever saved)
    fs.writeFileSync(path.join(store.dirOf(rt.id), 'work', 'probe.initial.json'), JSON.stringify({ oracle: { result: 'yes', matches: [{ page: url, viewport: 'laptop' }] }, pages: [] }));
    const rr = await retestMod.run(rt.id, { root: null, options: { viewports: 'laptop' }, env: { ...process.env, ...ENVX }, now: () => 'T' });
    const cond = id => ((rr.entry || {}).conditions || []).find(x => x.id === id) || {};
    ok(rr.entry && rr.entry.verdict === 'Fixed' && cond('same-page-and-size').status === 'PASSED', `the comparison itself says "Fixed" (verdict "${rr.entry && rr.entry.verdict}"), so the check below is not vacuous`);
    ok(rr.entry && rr.entry.fixed_verified === false && cond('sandbox-retest').status === 'FAILED' && cond('original-reproduced').status === 'FAILED' && /NOT marked FIXED_VERIFIED/.test(rr.entry.reason), 'but it is NOT FIXED_VERIFIED: a live probe is no sandbox retest, and the original run never reproduced the symptom in a sandbox');
    const allGood = { cmp: { verdict: 'Fixed', reason: 'x' }, where: 'sandbox', original: { result: 'yes', reproduced_in_sandbox: 'yes', active_plugins: ['a'] }, now: { active_plugins: ['a'] }, target: 'hyp-1' };
    ok(retestMod.canVerify(allGood).ok === true && retestMod.canVerify({ ...allGood, original: { ...allGood.original, reproduced_in_sandbox: 'could-not-test' } }).ok === false && retestMod.canVerify({ ...allGood, where: 'live probe' }).ok === false, 'canVerify can say yes (all conditions met) and says no when the original did not reproduce in the sandbox or the retest was a live probe');

    group('the interactive "Symptom type (number)" default');
    const { PassThrough } = require('stream');
    const cli = require('../lib/issue-cli');
    const input = new PassThrough(), output = new PassThrough(); let shown = ''; output.on('data', d => { shown += d; });
    const before = new Set(store.list().map(i => i.id));
    input.end('\n'.repeat(12));   // every question after the flags is answered with Enter
    const realLog = console.log; console.log = () => {};
    let code = null; try { code = await cli.run({ _: ['issue', 'new'], title: 'default test', description: 'd', pages: '/', env: 'local', 'no-files': true, 'no-questions': true }, { input, output }); } finally { console.log = realLog; }
    const made2 = store.list().map(i => store.load(i.id)).find(i => !before.has(i.id) && i.title === 'default test');
    ok(code === 0 && !!made2, 'issue new asked its questions through the reader and made the issue');
    const otherNo = store.SYMPTOMS.findIndex(x => x[0] === 'other') + 1;
    ok(made2 && made2.symptom === 'other' && new RegExp(`Symptom type \\(number\\)[^\\n]*\\[${otherNo}\\]`).test(shown), `pressing Enter at "Symptom type (number)" gives "Other" (number ${otherNo}), not the last symptom of the list (${made2 && made2.symptom})`);

    sv.close();
    fs.rmSync(tmp, { recursive: true, force: true });
    console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll symptom checks passed');
    process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ } process.exit(1); });
