#!/usr/bin/env node
// REPORT-SPEC Part 3: the choice step after the report (issue/plan-questions.js) and FIX-PLAN.md (issue/fix-plan.js), plus three leftovers:
//   P1  the questions (owner wording), numbered, "0) Skip", "not sure" always accepted; asked only with a terminal and never with --yes / --no-questions / --no-prompt
//       (the flags win over a supplied reader); answers saved only through store.applyPlanAnswers (whitelist) in issue.json `plan_answers`; they NEVER change a status
//   P2  FIX-PLAN.md: the six plain headings, summary on top, the ranked default, the pruning by each answer, an undo for every step, "Not yet tested on a copy of your site." /
//       "Not reproduced on a test copy of your site.", an older provider version only with evidence from the copy, no step that edits a third-party file, no file without a cause
//   L2  the page header shows when the report was made in readable words ("4 Nov 2026, 17:58"); findings.json keeps the raw value
//   L3  no error log on the site: "No error log was found on this site." and how to turn logging on (Markdown, command line, page); a --log file that cannot be read is said apart
//   L4  the empty Resolution text (gate on): "No fix is suggested, because no cause was found."
// Every cause case uses the exact ews log line (Class "Elementor\Core\Schemes\Color" not found in .../themes/unicamp/elementor/widgets/original/heading.php:48).
// Offline, fixtures only; the site folder is fingerprinted before and after.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { PassThrough } = require('stream');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-fixplan-'));
process.env.PLUGIN_GUARD_ISSUES = path.join(tmp, 'issues');
const store = require('../lib/issue-store');
const evidence = require('../issue/evidence'), analysis = require('../issue/analysis'), validate = require('../issue/validate'), resolve = require('../issue/resolve'), result = require('../issue/result');
const oracle = require('../issue/oracle'), fixPlan = require('../issue/fix-plan'), PQ = require('../issue/plan-questions'), caseFile = require('../issue/case-file');
const cli = require('../lib/issue-cli');
const wizard = require('../lib/wizard');

let failures = 0, skipped = 0;
const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`); if (!c) failures++; };
const group = t => console.log(`\n== ${t}`);
const w = (root, rel, body = '<?php\n') => { const f = path.join(root, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, body); };
const CLASS = 'Elementor\\Core\\Schemes\\Color';
const FILE = 'wp-content/themes/unicamp/elementor/widgets/original/heading.php';
const PFILE = 'wp-content/plugins/unicamp-addons/widgets/heading.php';
const EWS = 'http://localhost82.local.com/ews/';
const HEADING = fs.readFileSync(path.join(__dirname, 'fixtures', 'issue', 'names-class', 'heading.php'), 'utf8');
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const stamp = d => `${String(d.getUTCDate()).padStart(2, '0')}-${MON[d.getUTCMonth()]}-${d.getUTCFullYear()} ${d.toISOString().slice(11, 19)}`;
const fingerprint = root => { const h = crypto.createHash('sha256'); const walk = d => { for (const n of fs.readdirSync(d).sort()) { const p = path.join(d, n), st = fs.lstatSync(p); h.update(path.relative(root, p) + ':' + st.size + ':'); if (st.isDirectory()) walk(p); else h.update(fs.readFileSync(p)); } }; walk(root); return h.digest('hex'); };
const hashDir = d => { const h = crypto.createHash('sha256'); for (const n of fs.readdirSync(d).sort()) { const p = path.join(d, n); if (fs.lstatSync(p).isFile()) h.update(n + ':' + fs.readFileSync(p)); } return h.digest('hex'); };

// o: log ('ews' | 'none'), where ('theme' | 'plugin'), compat (a "tested up to" header in the theme), signs (a nulled plugin too)
function build(root, o = {}) {
    w(root, 'wp-includes/version.php', "<?php\n$wp_version = '6.8.1';\n"); w(root, 'wp-config.php', '<?php\n');
    w(root, 'wp-content/plugins/elementor/elementor.php', '<?php\n/**\n * Plugin Name: Elementor\n * Version: 3.35.7\n */\nnamespace Elementor;\nclass Plugin {}\n');
    w(root, 'wp-content/themes/unicamp/style.css', `/*\nTheme Name: Unicamp\nVersion: 2.2.0\n${o.compat ? 'Elementor tested up to: 3.4.2\n' : ''}*/`);
    w(root, 'wp-content/plugins/woocommerce/woocommerce.php', '<?php\n/**\n * Plugin Name: WooCommerce\n * Version: 10.6.1\n */\n');
    const file = o.where === 'plugin' ? PFILE : FILE;
    if (o.where === 'plugin') w(root, 'wp-content/plugins/unicamp-addons/unicamp-addons.php', '<?php\n/**\n * Plugin Name: Unicamp Addons\n * Version: 1.4.0\n */\n');
    if (o.log !== 'none') w(root, file, HEADING);
    if (o.signs) w(root, 'wp-content/plugins/gallery-pro/gallery-pro.php', '<?php\n/**\n * Plugin Name: Gallery Pro Nulled\n * Version: 2.0\n */\n');
    if (o.log === 'none') return;
    const d = new Date(Date.now() - 2 * 3600e3), d2 = new Date(d.getTime() + 1000);
    const one = t => `[${stamp(t)} UTC] PHP Fatal error:  Uncaught Error: Class "${CLASS}" not found in ${root}/${file}:48\nStack trace:\n#0 {main}\n  thrown in ${root}/${file} on line 48\n`;
    w(root, 'wp-content/debug.log', one(d) + one(d2));
}
const page = status => ({ console_errors: [], page_errors: [], error_responses: status >= 500 ? [{ url: EWS, status, type: 'document', same_site: true, source: { type: 'other', ref: null, name: 'localhost82.local.com' } }] : [], failed_requests: [], url: EWS, viewport: { name: 'laptop', width: 1280, height: 800 }, loaded: true, status, first_status: status, retried: false, outcome: status >= 500 ? 'server-error' : 'ok' });
const probeWrite = (dir, pages, stored = null) => {
    const j = JSON.parse(fs.readFileSync(path.join(dir, 'issue.json'), 'utf8')); j.probe_ran_at = new Date().toISOString(); if (stored) j.oracle = stored.spec; fs.writeFileSync(path.join(dir, 'issue.json'), JSON.stringify(j));
    const obs = { pages, planned: pages.length, protection: null, debug_log: { new_bytes: 0, lines: 0 } };
    const ans = stored ? { ...stored.spec, symptom: j.symptom, result: stored.result, reason: 'stored' } : oracle.evaluate(j.oracle, obs, { needsLogin: j.needs_login, symptom: j.symptom });
    fs.writeFileSync(path.join(dir, 'work', 'probe.json'), JSON.stringify({ schema: 1, planned: { pages: [EWS], viewports: ['laptop 1280x800'], loads: pages.length, notes: [] }, protection: null, pages, oracle: ans, debug_log: obs.debug_log }));
};
const STORED = { spec: { type: 'debug-log', value: 'Fatal error', defaulted: false }, result: 'yes' };   // the old oracle: the same fatal stays "likely" (not confirmed)
async function run(name, o = {}) {
    const root = path.join(tmp, name, 'wp'); build(root, o);
    const config = path.join(path.dirname(root), 'plugin-guard.config.json'); fs.writeFileSync(config, '{}');
    const before = fingerprint(root);
    const issue = store.create({ title: 'Home page shows a critical error', description: 'The home page shows a critical error', symptom: o.symptom || 'white-screen', environment: 'local', url: EWS, root, pages: [] });
    await evidence.run(issue.id, { root, probeOptions: { probe: false } });
    const dir = store.dirOf(issue.id);
    if (o.probe) probeWrite(dir, [page(o.probe)], o.likely ? STORED : null);
    analysis.run(issue.id, { root, config });
    const val = validate.run(issue.id, { root, config, lint: () => ({ ok: true, message: '' }) });
    const policy = validate.policyFor(root, config), plans = resolve.build(issue.id, val, { root, policy, dir });
    const res = result.write(issue.id, { validation: val, plans, dir, root, policy, gate: true });
    const R = n => fs.readFileSync(path.join(dir, 'result', n), 'utf8');
    const out = []; cli.printGate(res, plans, { gate: true }, t => out.push(t), dir);
    const planFile = path.join(dir, 'result', 'FIX-PLAN.md');
    return { id: issue.id, dir, root, config, val, f: res.findings, md: R('ISSUE-REPORT.md'), html: R('issue.html'), cli: out.join('\n'), plan: fs.existsSync(planFile) ? R('FIX-PLAN.md') : null, planFile, same: () => before === fingerprint(root) };
}
const sec = (md, h) => { const i = md.indexOf(`\n## ${h}\n`); if (i < 0) return ''; const j = md.indexOf('\n## ', i + 4); return md.slice(i, j < 0 ? undefined : j); };
const HEADINGS = ['The problem', 'The plan we suggest, and why', 'Before you start', 'Steps', 'You are done when', 'Please do not'];
const stepLines = md => sec(md, 'Steps').split('\n').filter(l => /^- \[ \] \d+\. /.test(l));
const undoOk = md => { const L = sec(md, 'Steps').split('\n').filter(Boolean).slice(1); return L.length > 0 && L.every((l, i) => (i % 2 === 0 ? /^- \[ \] \d+\. \S/.test(l) : /^ {2}Undo: \S/.test(l))); };
// a step that tells someone to change a third-party file
const EDITS = /\b(edit|modify|open (and|the file)|change the (code|file)|replace the line|add a line|delete the line|comment out)\b/i;
// internal words and machine values that never reach a reader
const INTERNAL = [/\b(theme|mu|plugin):[a-z0-9._-]+/i, /PROBABLE[ _]NEEDS[ _]REVIEW/i, /\boracle\b/i, /\brecomput\w*/i, /\bNOT_RUN\b/, /\bgate\b/i, /\bnull\b/, /\bundefined\b/, /\.json\b/, /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/, /\b(CONFIRMED|REPRODUCIBLE|UNVERIFIED|REJECTED_FALSE_POSITIVE|FIXED_VERIFIED)\b/];
const badWords = t => INTERNAL.filter(re => re.test(t)).map(String);

// in-process wizard with scripted answers and a pretend terminal (the harness of selftest-plugin-guard.js)
async function wiz(answers, flags, extra = {}) {
    const input = new PassThrough(), output = new PassThrough();
    // one buffer for the terminal output and the printed report, in the order they happen
    let text = ''; output.on('data', d => { text += d; });
    input.end(answers.join('\n') + (answers.length ? '\n' : ''));
    const saved = process.env.PLUGIN_GUARD_ISSUES, log = console.log, logged = ''; console.log = (...a) => { text += a.join(' ') + '\n'; };
    let error = null, code = null;
    try { code = await wizard.run({ _: [], ...flags }, { input, output, tty: true, cwd: tmp, env: { HOME: tmp }, preflight: () => ({ ok: false }), siteRoots: [], ...extra }); }
    catch (e) { error = e; } finally { console.log = log; if (saved === undefined) delete process.env.PLUGIN_GUARD_ISSUES; else process.env.PLUGIN_GUARD_ISSUES = saved; }
    return { text: text + logged, error, code };
}
const issuesIn = d => (fs.existsSync(d) ? fs.readdirSync(d).filter(x => store.ISSUE_RE.test(x)).sort() : []);

(async () => {
    group('P2. the ews case (confirmed): FIX-PLAN.md');
    const ews = await run('ews', { probe: 500 });
    const h = ews.val.hypotheses.find(x => x.type === 'missing-function');
    ok(h && h.status === 'CONFIRMED' && ews.f.case_file.cases[0].kind === 'confirmed', 'fixture: the ews fatal is confirmed (Rule A) and is Case 1');
    ok(!!ews.plan && ews.planFile === path.join(ews.dir, 'result', 'FIX-PLAN.md'), 'FIX-PLAN.md is written into the issue folder (result/) at the end of the run');
    const heads = (ews.plan || '').split('\n').filter(l => /^## /.test(l)).map(l => l.slice(3));
    ok(JSON.stringify(heads) === JSON.stringify(HEADINGS), `the six plain headings, in order: ${heads.join(' / ')}`);
    const top = (ews.plan || '').split('\n## ')[0];
    ok(/^# Fix plan: Home page shows a critical error\n\nIn short: Confirmed cause: the file asks for the class Elementor\\Core\\Schemes\\Color, and the log says it was not found\. The plan: update the theme Unicamp\./.test(top) && /did not change your site and does not apply this plan/.test(top) && /Claude Code, can follow the steps below on a copy after a backup/.test(top), 'a short plain summary on top (the cause, the plan, copy and backup, nothing applied, usable as a brief)');
    const prob = sec(ews.plan, 'The problem').split('\n').filter(Boolean).slice(1);
    ok(prob.length === 2 && prob[0] === 'The file asks for the class Elementor\\Core\\Schemes\\Color, and the log says it was not found.' && prob[1] === 'Where: the theme Unicamp 2.2.0: wp-content/themes/unicamp/elementor/widgets/original/heading.php, line 48.', 'the problem in two lines');
    const plan = sec(ews.plan, 'The plan we suggest, and why');
    ok(plan.includes('Ranked default (nothing was chosen): Update the theme Unicamp.') && /1\. Test with a default theme to confirm the cause\./.test(plan) && /2\. Ask a developer for a change, written as text for review\./.test(plan), 'nothing answered: the ranked default (update the theme), then the default-theme test, then a developer change as text');
    ok(plan.includes('Not suggested: An older version of Elementor: which version still has this is not known'), 'an older Elementor without evidence from the copy: "which version still has this is not known", not suggested');
    const bef = sec(ews.plan, 'Before you start');
    ok(/- \[ \] Make a backup with UpdraftPlus/.test(bef) && /- \[ \] Work on a copy or a staging site, not on the live site\./.test(bef) && bef.includes('- [ ] Note the current versions: theme Unicamp 2.2.0 · Elementor 3.35.7 · WooCommerce 10.6.1.'), 'before you start: an UpdraftPlus backup, a copy or staging, the current versions from the report');
    ok(bef.includes('\nNot yet tested on a copy of your site.\n') && !bef.includes('Not reproduced'), 'a confirmed cause without a test copy: exactly "Not yet tested on a copy of your site."');
    ok(undoOk(ews.plan) && stepLines(ews.plan).length === 3, 'numbered, checkable steps ("- [ ] 1."), each followed by its "Undo:" line');
    ok(sec(ews.plan, 'You are done when').includes('- [ ] The page that showed the problem loads normally on the copy.') && sec(ews.plan, 'You are done when').includes('- [ ] Run this report again on the changed copy and it no longer lists this cause.'), 'done when: the page loads, and the report run again on the changed copy no longer lists this cause');
    const dont = sec(ews.plan, 'Please do not');
    ok(/- Edit files of themes or plugins you did not write\./.test(dont) && /- Use or look for cracked or nulled versions\./.test(dont) && /- Apply this on the live site before testing it on a copy\./.test(dont), 'please do not: edit third-party files, cracked or nulled versions, the live site before a copy');
    ok(!/\b(applied|was fixed|has been fixed|we changed|we updated)\b/i.test(ews.plan), 'the plan never says it applied anything');
    ok(!badWords(ews.plan).length, `no internal word in FIX-PLAN.md${badWords(ews.plan).length ? ' -> ' + badWords(ews.plan).join(' ') : ''}`);

    group('P2. a likely cause (not confirmed), a plugin file, evidence for an older version');
    const lk = await run('likely', { probe: 500, likely: true });
    ok(lk.f.case_file.cases[0].kind === 'likely' && !!lk.plan && sec(lk.plan, 'Before you start').includes('\nNot reproduced on a test copy of your site.\n') && /^In short: Likely cause \(not confirmed\): /m.test(lk.plan), 'a likely cause: "Not reproduced on a test copy of your site." and "Likely cause (not confirmed)"');
    const cp = await run('compat', { probe: 500, compat: true });
    const cpo = sec(cp.plan, 'The plan we suggest, and why');
    ok(/Use an older version of Elementor for a while\. The theme's own file wp-content\/themes\/unicamp\/style\.css states: "Elementor tested up to: 3\.4\.2"\./.test(cpo) && !/Not suggested: An older version/.test(cpo), 'a compatible version stated in the theme\'s own header: the older-version option with that evidence');
    const cpOpt = fixPlan.options(fixPlan.context(cp.f), { plan: 'older-provider' }, fixPlan.compatEvidence(cp.root, fixPlan.context(cp.f)));
    ok(cpOpt.chosen.id === 'older-provider' && /install Elementor 3\.4\.2 from its vendor's own download/.test(cpOpt.chosen.steps[0][0]) && /Update Elementor back to 3\.35\.7/.test(cpOpt.chosen.steps[0][1]), 'chosen: install Elementor 3.4.2 from the vendor, undo: back to 3.35.7');
    const pl = await run('plugin', { probe: 500, where: 'plugin' });
    ok(!!pl.plan && /Ranked default \(nothing was chosen\): Update the plugin Unicamp Addons\./.test(pl.plan) && /Test with the plugin Unicamp Addons switched off on the copy/.test(pl.plan) && !/default theme/.test(pl.plan), 'a file in a plugin: update the plugin, test with it switched off (no default-theme test)');
    ok(!PQ.questionsFor(pl.f).some(q => q.id === 'licence') && PQ.questionsFor(ews.f).some(q => q.id === 'licence'), 'the licence question only when the top cause involves a theme');

    group('P2. every answer combination');
    const V = [undefined, 'yes', 'no', 'not-sure'];
    let combos = 0, bad = [];
    const ctxE = fixPlan.context(ews.f);
    for (const update of V) for (const licence of V) for (const copy of V) {
        const base0 = { ...(update ? { update } : {}), ...(licence ? { licence } : {}), ...(copy ? { copy } : {}) };
        const avail = fixPlan.options(ctxE, base0).options.map(x => x.id);
        for (const choice of [undefined, 'not-sure', ...avail]) {
            const a = { ...base0, ...(choice ? { plan: choice } : {}) };
            const t = fixPlan.build(ews.f, a), o = fixPlan.options(ctxE, a);
            combos++;
            const ids = o.options.map(x => x.id), steps = stepLines(t), problems = [];
            if (update === 'no' && ids.includes('update-theme')) problems.push('update=no kept the update');
            if (licence === 'no' && ids[0] !== 'get-licence') problems.push('licence=no did not put "get a licence or a replacement" first');
            if (licence === 'no' && ids.includes('update-theme')) problems.push('licence=no kept the plain update');
            if (licence !== 'no' && update !== 'no' && ids[0] !== 'update-theme') problems.push('the update is not first');
            if ((update === 'not-sure' || licence === 'not-sure') && ids.includes('update-theme') && !/Check first whether/.test(t)) problems.push('not sure: no "check first" note');
            if ((copy === 'no' || copy === 'not-sure') && !/^- \[ \] 1\. Make a backup with UpdraftPlus and set up a copy or a staging site before anything else\./.test(steps[0] || '')) problems.push('no backup-first step');
            if (copy === 'yes' && /before anything else/.test(t)) problems.push('copy=yes still asks for a copy first');
            if (!/- Apply this on the live site before testing it on a copy\./.test(t)) problems.push('the live-site warning is gone');
            if (!undoOk(t)) problems.push('a step without its undo');
            if (choice && choice !== 'not-sure' && !t.includes(`You chose: ${o.options.find(x => x.id === choice).title}.`)) problems.push('the choice is not used');
            if ((!choice || choice === 'not-sure') && !t.includes('Ranked default (nothing was chosen)')) problems.push('no ranked default');
            if (EDITS.test(sec(t, 'Steps'))) problems.push('a step edits a file');
            if (t !== fixPlan.build(ews.f, a)) problems.push('not deterministic');
            if (badWords(t).length) problems.push('internal words: ' + badWords(t).join(' '));
            if (problems.length) bad.push(`${JSON.stringify(a)}: ${problems.join('; ')}`);
        }
    }
    ok(combos >= 64 && !bad.length, `${combos} combinations of the four answers: pruning, the "check first" note, the backup-first step, the live warning, an undo for every step, the choice, determinism${bad.length ? ' -> ' + bad.slice(0, 3).join(' | ') : ''}`);
    const nl = fixPlan.options(ctxE, { update: 'no', licence: 'no' });
    ok(nl.options[0].title === 'Get a licence or a replacement for the theme Unicamp from the vendor' && !nl.options.some(x => x.id === 'update-theme'), '"no licence": the update becomes "get a licence or a replacement from the vendor"');
    ok(fixPlan.options(ctxE, { update: 'no' }).options.map(x => x.id).join() === 'default-theme,developer-text', '"cannot update": the update is removed');
    ok(fixPlan.options(ctxE, { plan: 'older-provider' }).chosenBy === 'default', 'a choice that is not possible (no evidence for an older version) falls back to the ranked default');
    const steps3 = [ews, lk, cp, pl].map(r => sec(r.plan, 'Steps')).join('\n') + Object.values({ a: fixPlan.build(ews.f, { plan: 'developer-text' }), b: fixPlan.build(ews.f, { plan: 'default-theme' }), c: fixPlan.build(cp.f, { plan: 'older-provider' }) }).map(t => sec(t, 'Steps')).join('\n');
    ok(!EDITS.test(steps3) && /stay as they are/.test(steps3) && /child-theme override or a small separate plugin/.test(steps3), 'no step tells anyone to edit a third-party file; the developer change is text for a child-theme override or a small plugin');

    group('P2. no cause: no file, and nothing mentions it');
    const healthy = await run('healthy', { log: 'none', probe: 200 });
    ok(!healthy.plan && !fs.existsSync(healthy.planFile) && !/FIX-PLAN/.test(healthy.md + healthy.cli + JSON.stringify(healthy.f)), 'a healthy site: no FIX-PLAN.md; the report, the command line and findings.json do not mention it');
    fs.writeFileSync(healthy.planFile, 'stale');
    ok(fixPlan.writeFor(healthy.id, healthy.dir, healthy.f) === null && !fs.existsSync(healthy.planFile), 'an old FIX-PLAN.md is removed when there is nothing to plan for');
    ok(!/FIX-PLAN/.test(ews.md + ews.cli + JSON.stringify(ews.f)), 'findings.json and the report never name the file (the wizard says where it is)');
    ok(PQ.questionsFor(healthy.f).length === 0 && PQ.planQuestion(healthy.f) === null, 'no cause: no question is asked');
    const sg = await run('signs', { log: 'none', signs: true });
    ok(sg.f.case_file.cases.some(c => c.kind === 'signs') && !!sg.plan && /Ranked default \(nothing was chosen\): Replace the plugin Gallery Pro Nulled with a licensed copy from the vendor\./.test(sg.plan) && sec(sg.plan, 'You are done when').includes('no longer lists these signs'), 'signs that a copy was modified (no cause): a plan to replace it with a licensed copy');
    ok(PQ.questionsFor(sg.f).map(q => q.id).join() === 'copy' && PQ.planQuestion(sg.f).choices.length === 3, 'signs only: the copy question and the plan question (no update / licence question)');

    group('P2. determinism');
    const ews2 = await run('ews-again', { probe: 500 });
    ok(ews2.plan === ews.plan, 'two runs of the same input: FIX-PLAN.md is byte-identical');

    group('P1. the questions');
    const qs = PQ.questionsFor(ews.f);
    ok(qs.map(q => q.text).join(' | ') === 'Can you update the theme and plugins? | Do you have a licence for the theme? | Is this a copy, and do you have a backup?', 'the owner\'s wording for questions 1-3');
    ok(qs[0].choices.map(c => c.label).join('/') === 'Yes/No/Not sure' && qs[1].choices.map(c => c.label).join('/') === 'Yes/No/Not sure' && qs[2].choices.map(c => c.label).join('/') === 'Yes/No', 'yes / no / not sure; yes / no / not sure; yes / no');
    const pq = PQ.planQuestion(ews.f);
    ok(pq.text === 'Which plan do you want?' && pq.choices[0].value === 'update-theme' && /\(suggested\)$/.test(pq.choices[0].label) && pq.choices[pq.choices.length - 1].value === 'not-sure' && !pq.choices.some(c => c.value === 'older-provider'), 'question 4: only the options still possible, the ranked default first, "not sure" last');
    ok(PQ.planQuestion(ews.f, { update: 'no' }).choices[0].value === 'default-theme' && PQ.planQuestion(ews.f, { licence: 'no' }).choices[0].value === 'get-licence', 'question 4 follows the earlier answers');
    const rq = PQ.render(qs[0], 1, 4);
    ok(rq === 'Question 1 of up to 4: Can you update the theme and plugins?\n  1) Yes\n  2) No\n  3) Not sure\n  0) Skip this question\n  (type a number, or \'not sure\'; or \'stop\' to stop all questions)', 'numbered choices and "0) Skip this question"');
    ok(PQ.parse(qs[2], 'not sure').value === 'not-sure' && PQ.parse(qs[2], '?').value === 'not-sure' && PQ.parse(qs[0], '2').value === 'no' && PQ.parse(qs[0], 'y').value === 'yes' && PQ.parse(qs[0], '0').kind === 'skip' && PQ.parse(qs[0], '').kind === 'skip' && PQ.parse(qs[0], 'stop').kind === 'stop' && PQ.parse(qs[0], '7').kind === 'invalid', '"not sure" is always accepted (also on the yes / no question); numbers, skip, stop, invalid');
    const qText = [...qs, pq].map((q, i) => PQ.render(q, i + 1, 4)).join('\n');
    ok(!badWords(qText).length && !/\b(oracle|hypothes\w*|verdict|bisect\w*|sandbox)\b/i.test(qText), 'plain words, no jargon in the questions');

    group('P1. never without a terminal, never with --yes / --no-questions / --no-prompt (the flags win over a supplied reader)');
    ok(PQ.interactiveNow({}, { tty: true }) && !PQ.interactiveNow({ yes: true }, { tty: true }) && !PQ.interactiveNow({ 'no-questions': true }, { tty: true }) && !PQ.interactiveNow({ 'no-prompt': true }, { tty: true }) && !PQ.interactiveNow({}, { tty: false }), 'interactiveNow: only a terminal, and every flag switches it off');
    let asked = 0; const io0 = { say: () => {}, ask: async () => { asked++; return '1'; } };
    const r0 = await PQ.run({ f: ews.f, io: io0, interactive: false, save: () => { throw new Error('no save'); } });
    ok(asked === 0 && !r0.asked.length, 'interactive false with a reader supplied: nothing is asked, nothing is saved');
    const said = []; const script = ['2', 'not sure', '1', '1']; let k = 0;
    const r1 = await PQ.run({ f: ews.f, io: { say: t => said.push(t), ask: async () => script[k++] ?? null }, interactive: true, save: a => store.applyPlanAnswers(ews.id, a) });
    ok(JSON.stringify(r1.answers) === JSON.stringify({ update: 'no', licence: 'not-sure', copy: 'yes', plan: 'default-theme' }) && said.join('\n').includes('Question 4 of up to 4: Which plan do you want?'), `a scripted terminal: ${JSON.stringify(r1.answers)}`);
    const saved = store.load(ews.id).plan_answers;
    ok(saved && saved.update === 'no' && saved.licence === 'not-sure' && saved.copy === 'yes' && saved.plan === 'default-theme' && saved.schema === 1, 'saved in issue.json under plan_answers');
    ok(!fs.readdirSync(path.join(ews.dir, 'work')).some(n => /plan/i.test(n)), 'nothing is written under work/');
    const r2 = await PQ.run({ f: ews.f, io: { say: () => {}, ask: async () => null }, interactive: true, save: () => { throw new Error('no save'); } });
    ok(r2.stopped && !Object.keys(r2.answers).length, 'the input ends: the questions stop, nothing is saved');

    group('P1. the whitelist, and answers never change a status');
    const issueBefore = fs.readFileSync(path.join(ews.dir, 'issue.json'), 'utf8');
    const refuse = a => { try { store.applyPlanAnswers(ews.id, a); return false; } catch (e) { return e.exitCode === 2 || /cannot set|is not an answer|must be an object/.test(e.message); } };
    ok(refuse({ status: 'CONFIRMED' }) && refuse({ verdict: 'Fixed' }) && refuse({ symptom: 'layout' }) && refuse({ plan: 'apply-patch' }) && refuse({ update: 'maybe' }) && refuse(['yes']) && refuse({ oracle: { type: 'generic' } }), 'a status, a verdict, a field of the issue, an unknown plan or an unknown value is refused');
    ok(fs.readFileSync(path.join(ews.dir, 'issue.json'), 'utf8') === issueBefore, 'a refused answer leaves issue.json as it was');
    // the same issue: findings, validation and the case file with and without answers
    const fresh = await run('status-check', { probe: 500 });
    const workBefore = hashDir(path.join(fresh.dir, 'work'));
    const strip = f => JSON.stringify({ ...f, generated_at: 'T' });
    store.applyPlanAnswers(fresh.id, { update: 'no', licence: 'no', copy: 'no', plan: 'get-licence' });
    const planAfter = fixPlan.writeFor(fresh.id, fresh.dir, fresh.f);
    ok(planAfter && /You chose: Get a licence or a replacement for the theme Unicamp from the vendor\./.test(fs.readFileSync(planAfter, 'utf8')) && /^- \[ \] 1\. Make a backup with UpdraftPlus and set up a copy/m.test(fs.readFileSync(planAfter, 'utf8')), 'FIX-PLAN.md is written again with the answers (the choice, and the backup first)');
    ok(workBefore === hashDir(path.join(fresh.dir, 'work')), 'saving the answers and writing the plan change no file under work/');
    const val2 = validate.run(fresh.id, { root: fresh.root, config: fresh.config, lint: () => ({ ok: true, message: '' }) });
    const plans2 = resolve.build(fresh.id, val2, { root: fresh.root, policy: validate.policyFor(fresh.root, fresh.config), dir: fresh.dir });
    const res2 = result.write(fresh.id, { validation: val2, plans: plans2, dir: fresh.dir, root: fresh.root, policy: validate.policyFor(fresh.root, fresh.config), gate: true });
    ok(JSON.stringify(val2.hypotheses.map(x => [x.id, x.status])) === JSON.stringify(fresh.val.hypotheses.map(x => [x.id, x.status])) && JSON.stringify(val2.checks) === JSON.stringify(fresh.val.checks), 'the validation (every status and check) is the same with the answers');
    ok(strip(res2.findings) === strip(fresh.f) && JSON.stringify(res2.findings.case_file) === JSON.stringify(fresh.f.case_file) && res2.findings.verdict.label === fresh.f.verdict.label, 'findings.json (cases, statuses, verdict) is identical with and without answers, apart from the time');
    ok(!/plan_answers|plan-questions|fix-plan/.test(['issue/validate.js', 'issue/gate.js', 'issue/hypotheses.js', 'issue/case-file.js', 'issue/checkpoints.js'].map(f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8')).join('\n')), 'nothing that computes a status, a verdict or the case file reads the answers');
    const src = ['issue/fix-plan.js', 'issue/plan-questions.js'].map(f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8').replace(/\/\/.*$/gm, '')).join('\n');
    ok(!/require\(['"](https?|net|dns|child_process)['"]\)|fetch\(|status\s*=\s*['"]|CONFIRMED|REPRODUCIBLE|FIXED_VERIFIED/.test(src), 'fix-plan.js and plan-questions.js: no network, no process, no status');

    group('P1. the plugin-guard command: after the report, only with a terminal');
    const site = path.join(tmp, 'wiz-site', 'wp'); build(site, {});
    const siteFp = fingerprint(site);
    const outA = path.join(tmp, 'outA');
    const A = await wiz(['', '', 'stop', '2', '2', '2', '1'], { description: 'The home page shows a critical error', root: site, out: outA });
    const idA = issuesIn(outA)[0], dirA = idA ? path.join(outA, idA) : null;
    const textA = A.text;
    ok(!A.error && dirA && textA.indexOf('Which plan do you want?') > textA.indexOf('STATUS ') && textA.indexOf('STATUS ') > 0, `the choice questions come after the report is printed${A.error ? ' (' + A.error.message + ')' : ''}`);
    ok(dirA && JSON.stringify(JSON.parse(fs.readFileSync(path.join(dirA, 'issue.json'), 'utf8')).plan_answers) === JSON.stringify({ schema: 1, update: 'no', licence: 'no', copy: 'no', plan: 'get-licence' }), 'the answers are saved in issue.json');
    const planA = dirA ? fs.readFileSync(path.join(dirA, 'result', 'FIX-PLAN.md'), 'utf8') : '';
    ok(/You chose: Get a licence or a replacement for the theme Unicamp from the vendor\./.test(planA) && /^- \[ \] 1\. Make a backup with UpdraftPlus and set up a copy/m.test(planA) && textA.includes(`Fix plan: ${path.join(dirA, 'result', 'FIX-PLAN.md')}`), 'FIX-PLAN.md is rewritten with the answers, and its place is printed');
    const outB = path.join(tmp, 'outB');
    const B = await wiz([], { description: 'The home page shows a critical error', root: site, out: outB, yes: true, images: '' });
    const idB = issuesIn(outB)[0];
    ok(!B.error && idB && !/Which plan do you want\?|Can you update the theme/.test(B.text) && /Ranked default/.test(fs.readFileSync(path.join(outB, idB, 'result', 'FIX-PLAN.md'), 'utf8')) && !JSON.parse(fs.readFileSync(path.join(outB, idB, 'issue.json'), 'utf8')).plan_answers, '--yes: no choice question, the ranked-default plan is still written, no answers saved');
    const outC = path.join(tmp, 'outC');
    const C = await wiz([], { description: 'The home page shows a critical error', root: site, out: outC, images: '', url: '' }, { tty: false });
    ok(!C.error && !/Which plan do you want\?|Can you update the theme/.test(C.text), 'no terminal: no choice question');
    const outD = path.join(tmp, 'outD');
    const D = await wiz(['', '', '1', '1', '1', '1'], { description: 'The home page shows a critical error', root: site, out: outD, 'no-questions': true });
    ok(!D.error && !/Which plan do you want\?|Can you update the theme/.test(D.text), '--no-questions with a terminal: no choice question');
    ok(fingerprint(site) === siteFp, 'the site folder is unchanged by the command, the questions and the plan');

    group('L3. no error log on the site');
    const nolog = path.join(tmp, 'nolog-site', 'wp'); build(nolog, { log: 'none' });
    const outN = path.join(tmp, 'outN');
    const N = await wiz([], { description: 'The home page shows a critical error', root: nolog, out: outN, yes: true, images: '' });
    const idN = issuesIn(outN)[0], dN = idN ? path.join(outN, idN, 'result') : null;
    const mdN = dN ? fs.readFileSync(path.join(dN, 'ISSUE-REPORT.md'), 'utf8') : '', fN = dN ? JSON.parse(fs.readFileSync(path.join(dN, 'findings.json'), 'utf8')) : {};
    ok(!N.error && fN.case_file && JSON.stringify(fN.case_file.status.log_help) === JSON.stringify(caseFile.NO_LOG_HELP), 'the case file carries the log help');
    ok(caseFile.NO_LOG_HELP[0] === 'No error log was found on this site.' && caseFile.NO_LOG_HELP[1] === 'To see what is going wrong, turn error logging on. First make a backup with UpdraftPlus. Then, in the file wp-config.php, set WP_DEBUG to true, WP_DEBUG_LOG to true and WP_DEBUG_DISPLAY to false. Load the page that shows the problem once, then run this report again.' && caseFile.NO_LOG_HELP[2] === 'This does not mean nothing went wrong.', 'the exact owner text');
    ok(mdN.includes('**No error log was found on this site.**') && mdN.includes(caseFile.NO_LOG_HELP[1]) && mdN.includes('This does not mean nothing went wrong.') && !/no log file was given/.test(mdN), 'Markdown: the new text, and not "no log file was given"');
    ok(N.text.includes('No error log was found on this site.') && N.text.includes('set WP_DEBUG to true, WP_DEBUG_LOG to true and WP_DEBUG_DISPLAY to false') && !/no log file was given/.test(N.text), 'command line: the new text, and not "no log file was given"');
    ok(!/no log file was given/.test(JSON.stringify(fN)) && /What was checked[\s\S]*Not done: Your log file: No error log was found on this site\. This does not mean nothing went wrong\./.test(mdN), 'the log step says the same in "What was checked" (and findings.json no longer says "no log file was given")');
    const mdA = dirA ? fs.readFileSync(path.join(dirA, 'result', 'ISSUE-REPORT.md'), 'utf8') : '';
    ok(mdA && !/No error log was found|no log file was given/.test(mdA + textA), 'a site with a log: neither text');
    if (typeof process.getuid === 'function' && process.getuid() !== 0) {
        const lockedLog = path.join(tmp, 'locked.log'); fs.writeFileSync(lockedLog, 'x'); fs.chmodSync(lockedLog, 0);
        const outL = path.join(tmp, 'outL');
        const Lr = await wiz([], { description: 'The home page shows a critical error', root: nolog, out: outL, yes: true, images: '', log: lockedLog });
        const idL = issuesIn(outL)[0], fL = idL ? JSON.parse(fs.readFileSync(path.join(outL, idL, 'result', 'findings.json'), 'utf8')) : {};
        const lh = (fL.case_file && fL.case_file.status.log_help) || [];
        ok(!Lr.error && lh.length === 1 && lh[0] === 'The log file locked.log could not be read (EACCES), so no error message from it was used. This does not mean nothing went wrong.' && !/No error log was found/.test(JSON.stringify(fL.case_file)), `a --log file that cannot be read: its own accurate sentence (${lh[0] || (Lr.error && Lr.error.message)})`);
        fs.chmodSync(lockedLog, 0o600);
    } else { console.log('SKIP  running as root: an unreadable file cannot be made'); skipped++; }
    ok(!badWords(caseFile.NO_LOG_HELP.join('\n')).length, 'the log help has no internal word');

    group('L2, L4 and L3 on the page (offline, textContent only)');
    let pw = null; try { pw = require('../lib/playwright').load(); } catch { /* not installed */ }
    const browser = pw && require('../lib/playwright').status().chromium ? await pw.chromium.launch() : null;
    if (!browser) { console.log("SKIP  plugin-guard's own browser is not installed: the rendered-page part did not run"); skipped++; }
    else {
        const open = async (file, tz = 'UTC') => {
            const ctx = await browser.newContext({ serviceWorkers: 'block', timezoneId: tz }), pg = await ctx.newPage(), reqs = [], errs = [];
            pg.on('pageerror', e => errs.push(e.message));
            await pg.route('**/*', rt => { reqs.push(rt.request().url()); return rt.request().url().startsWith('file://') ? rt.continue() : rt.abort(); });
            await pg.goto('file://' + file);
            const get = id => pg.evaluate(i => { const s = document.getElementById(i); return s ? s.textContent : null; }, id);
            return { ctx, get, reqs, errs };
        };
        const pe = await open(path.join(ews.dir, 'result', 'issue.html'));
        const meta = await pe.get('meta'), g = new Date(ews.f.generated_at);
        const want = `${g.getUTCDate()} ${MON[g.getUTCMonth()]} ${g.getUTCFullYear()}, ${String(g.getUTCHours()).padStart(2, '0')}:${String(g.getUTCMinutes()).padStart(2, '0')}`;
        ok(meta.endsWith(` · generated ${want}`) && !/\d{4}-\d{2}-\d{2}T/.test(meta) && /^\d{4}-\d{2}-\d{2}T/.test(ews.f.generated_at), `the header: "generated ${want}" (readable, 24-hour); findings.json keeps the raw value`);
        await pe.ctx.close();
        const pt = await open(path.join(ews.dir, 'result', 'issue.html'), 'Asia/Kolkata');
        const gl = new Date(g.getTime() + 330 * 60000);
        ok((await pt.get('meta')).endsWith(` · generated ${gl.getUTCDate()} ${MON[gl.getUTCMonth()]} ${gl.getUTCFullYear()}, ${String(gl.getUTCHours()).padStart(2, '0')}:${String(gl.getUTCMinutes()).padStart(2, '0')}`), 'in local time of the reader (a +05:30 time zone)');
        await pt.ctx.close();
        const ph = await open(path.join(healthy.dir, 'result', 'issue.html'));
        ok((await ph.get('resolution')).includes('No fix is suggested, because no cause was found.') && !(await ph.get('resolution')).includes('There is nothing to resolve'), 'the empty Resolution: "No fix is suggested, because no cause was found."');
        const st = await ph.get('status');
        ok(st.includes('No error log was found on this site.') && st.includes('set WP_DEBUG to true') && st.includes('This does not mean nothing went wrong.') && !/no log file was given/.test(st), 'the page Status shows the log help');
        ok(ph.reqs.every(u => u.startsWith('file://')) && !ph.errs.length, 'no request left the file; no script error');
        await ph.ctx.close();
        const pa = await open(path.join(dirA, 'result', 'issue.html'));
        ok(!(await pa.get('status')).includes('No error log was found'), 'a site with a log: no log help on the page');
        await pa.ctx.close();
        await browser.close();
    }
    ok(healthy.html.includes("'No fix is suggested, because no cause was found.'") && healthy.html.includes("'There is nothing to resolve: no hypothesis survived validation.'"), 'the empty Resolution text changes only with the gate on (the gate-off text stays in the page script)');

    group('read-only');
    ok([ews, lk, cp, pl, healthy, sg, ews2, fresh].every(r => r.same()), 'no site folder was written (fingerprint before and after)');

    fs.rmSync(tmp, { recursive: true, force: true });
    console.log(failures ? `\n${failures} FAILED` : `\nAll fix-plan checks passed${skipped ? ` (${skipped} part(s) skipped)` : ''}.`);
    process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
