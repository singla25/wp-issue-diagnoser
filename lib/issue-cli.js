// `guard.js issue <new|investigate|show|list|retest|open> [id]`. Prompts one question at a time, but every answer is also a flag,
// so it runs without prompts (--no-prompt, or all answers given). Never opens a browser: it prints the dashboard path.

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const store = require('./issue-store');
const deps = require('./issue-deps');
const cfgLib = require('./config');

const log = s => console.log(s);
const SELF = 'node src/plugin-guard/scripts/guard.js';

function lineReader(input = process.stdin, output = process.stdout) {
    const rl = readline.createInterface({ input, terminal: false });
    const it = rl[Symbol.asyncIterator]();
    return {
        ask: async (q, def) => { output.write(`${q}${def ? ` [${def}]` : ''}: `); const r = await it.next(); output.write(r.done ? '\n' : ''); const v = r.done ? '' : String(r.value).trim(); return v || def || ''; },
        wait: async q => { output.write(q); await it.next(); },
        close: () => rl.close()
    };
}

function parseOracle(spec) {
    if (!spec) return null;
    const i = String(spec).indexOf(':');
    return i < 0 ? { type: spec, value: null } : { type: spec.slice(0, i), value: spec.slice(i + 1) };
}

async function gather(o, io) {
    const interactive = !o['no-prompt'];
    const q = async (flag, question, def) => (o[flag] !== undefined ? o[flag] : interactive ? io.ask(question, def) : (def || ''));
    const a = {};
    a.title = await q('title', '1/6 Short title');
    a.description = await q('description', '2/6 What is wrong, what was expected, since when, and what changed just before (an update, a new plugin, a migration)?');
    const pages = await q('pages', '3/6 Affected URL(s) or page path(s), comma-separated');
    a.pages = String(pages).split(',').map(s => s.trim()).filter(Boolean);
    const login = o.login ? 'y' : await q('login-flag-never', '    Does it need a logged-in user? (y/N)', 'n');
    a.needsLogin = /^y/i.test(login);
    let symptom = o.symptom;
    if (symptom === undefined) {
        if (interactive) {
            store.SYMPTOMS.forEach((s, i) => log(`  ${i + 1}) ${s[1]}`));
            const pick = await io.ask('4/6 Symptom type (number)', String(store.SYMPTOMS.length));
            symptom = (store.SYMPTOMS[Number(pick) - 1] || [])[0] || pick;
        } else symptom = 'other';
    }
    a.symptom = symptom;
    const def = store.DEFAULT_ORACLE[symptom];
    let oracle = parseOracle(o.oracle);
    if (!oracle && interactive && def) { const sp = await io.ask(`    Oracle: how can the tool tell the symptom is present? type[:value] (types: ${Object.keys(store.ORACLES).join(', ')})`, `${def} (default)`); if (!/\(default\)$/.test(sp)) oracle = parseOracle(sp); }
    a.oracle = oracle;
    a.images = o.images !== undefined ? String(o.images).split(',').map(s => s.trim()).filter(Boolean) : null;
    if (a.images === null && interactive) {
        const where = await io.ask('5/6 Screenshots: a folder or file path, or Enter to use the default folder', '');
        a.images = where ? where.split(',').map(s => s.trim()).filter(Boolean) : 'default';
    } else if (a.images === null) a.images = [];
    a.environment = o.env || (interactive ? await io.ask('6/6 Environment (local / staging / live)', o.url ? '' : 'local') : null) || null;
    return a;
}

async function newIssue(o, io) {
    const root = o.root ? cfgLib.userPath(o.root) : null;
    if (root && !fs.existsSync(path.join(root, 'wp-content'))) throw store.userError(`--root ${root} has no wp-content folder: it must be the WordPress root`);
    const a = await gather(o, io);
    const issue = store.create({ ...a, url: o.url, authorized: o.authorized, root, since: o.since, changedBefore: o['changed-before'] });
    log(`Issue ${issue.id} saved: ${path.join(store.dirOf(issue.id), 'issue.json')}`);

    let res = { accepted: [], refused: [], warnings: [] };
    if (a.images === 'default') {
        const dir = path.join(store.dirOf(issue.id), 'images');
        log(`\nDrop your screenshots (PNG/JPG/WEBP, up to ${store.LIMITS.images} files, ${store.LIMITS.imageBytes / 1048576} MB each) into:\n  ${dir}`);
        if (!o['no-prompt']) await io.wait('Press Enter when they are there (or just Enter for none)... ');
        res = store.adoptDropped(issue.id, { wpRoot: root });
    } else if (a.images.length) res = store.intakeImages(issue.id, a.images.map(p => path.resolve(cfgLib.userCwd(), p)), { wpRoot: root });
    if (res.accepted.length) log(`${res.accepted.length} image(s) copied into the issue folder (metadata removed where the format allows).`);
    for (const r of res.refused) log(`  refused ${path.basename(r.path)}: ${r.reason}`);
    for (const w of res.warnings) log(`Warning: ${w}`);
    if (!issue.oracle.defaulted) log(`Oracle: ${store.ORACLES[issue.oracle.type].label}`); else log(`Oracle: none given, the generic one for "${issue.symptom}" will be used (${issue.oracle.type}).`);

    log(`\nNext: ${SELF} issue investigate ${issue.id}`);
    return { issue, code: 0 };
}


async function run(o, { input = process.stdin, output = process.stdout } = {}) {
    const [, sub = 'help', id] = o._;
    if (sub !== 'help') deps.need();
    if (sub === 'new') {
        const io = o['no-prompt'] ? null : lineReader(input, output);
        try {
            const { issue } = await newIssue(o, io);
            if (o.investigate) { log(''); return investigate(issue.id, o); }
            return 0;
        } finally { if (io) io.close(); }
    }
    if (sub === 'sandbox') {   // issue sandbox create|destroy|status|sweep [id]
        const sbx = require('../issue/sandbox'), action = id, target = o._[3];
        if (action === 'sweep') { const r = sbx.sweep(); log(`Sweep: removed ${r.removed.length} leftover sandbox(es)${r.removed.length ? ` (${r.removed.map(x => x.project).join(', ')})` : ''}; ${r.dirs_removed.length} folder(s); kept ${r.kept.length} that are still running.`); return 0; }
        if (action === 'status') { const l = sbx.list(); if (!l.length) log('No sandbox folders.'); for (const s of l) log(`${s.issue}\t${s.project}\t${s.status}\t${s.alive ? 'owner running' : 'owner gone'}\t${s.url || ''}`); return 0; }
        if (action === 'destroy') { if (!target) throw store.userError('issue sandbox destroy needs an issue id'); const r = sbx.destroy(target); log(`Destroyed ${target}: containers ${r.containers || 0}, volumes ${r.volumes || 0}, networks ${r.networks || 0}, folder ${r.dir_removed ? 'removed' : 'not present'}${r.leftovers && r.leftovers.length ? `; LEFTOVERS: ${r.leftovers.join(', ')}` : ''}`); return r.leftovers && r.leftovers.length ? 1 : 0; }
        throw store.userError('usage: issue sandbox <destroy <id> | status | sweep>   (a sandbox is created and destroyed by: issue investigate <id> --sandbox)');
    }
    if (sub === 'index') { const f = require('../issue/index-page').write(); log(`Issues index: ${f}\nOpen it in a browser (file://). It lists ${require('../issue/index-page').collect().length} issue(s).`); return 0; }
    if (sub === 'cleanup') {
        const cl = require('../issue/cleanup');
        const days = o['older-than-days'] === undefined ? 30 : Number(o['older-than-days']);
        if (!Number.isFinite(days) || days < 0) throw store.userError('--older-than-days must be a number of days (0 or more)');
        if (id && !store.ISSUE_RE.test(id)) throw store.userError(`"${id}" is not an issue id`);
        let p; try { p = cl.plan({ olderThanDays: days, issues: !o['no-issues'], sandboxes: !o['no-sandboxes'], only: id || null }); } catch (e) { if (e.name === 'CleanupRefusal') throw store.userError(e.message, 2); throw e; }
        const mb = b => `${(b / 1048576).toFixed(1)} MB`;
        log(`Cleanup candidates (issues older than ${days} day(s)${id ? `, or the one named: ${id}` : ''}):`);
        for (const x of p.sandboxes) log(`  sandbox  ${x.id}  ${mb(x.bytes)}  ${x.reason}`);
        for (const x of p.issues) log(`  issue    ${x.id}  ${mb(x.bytes)}  ${x.age_days} day(s) old  ${x.reason}`);
        if (!p.sandboxes.length && !p.issues.length) log('  nothing to clean.');
        for (const x of p.skipped) log(`  skipped  ${x.path}: ${x.reason}`);
        if (!p.sandboxes.length && !p.issues.length) return 0;
        const confirm = async () => {
            if (o.yes) return true;
            if (!process.stdin.isTTY) { log('\nNothing was deleted: there is no terminal to ask on. Pass --yes to confirm.'); return false; }
            const rl = require('readline').createInterface({ input: process.stdin, output: process.stdout });
            const a = await new Promise(r => rl.question(`\nDelete these ${p.sandboxes.length + p.issues.length} item(s) for good? [y/N] `, r)); rl.close();
            return /^y(es)?$/i.test(a.trim());
        };
        const r = await cl.apply(p, { confirm });
        for (const x of r.removed) log(`  removed  ${x.kind} ${path.basename(x.path)}`);
        for (const x of r.failed) log(`  FAILED   ${x.path}: ${x.reason}`);
        if (r.asked && !r.confirmed) log('Nothing was deleted.');
        return r.failed.length ? 1 : 0;
    }
    if (sub === 'list') {
        const all = store.list();
        if (!all.length) { log('No issues yet. Create one with: issue new'); return 0; }
        for (const i of all) log(`${i.id}\t${i.status}\t${i.symptom}\t${i.title.replace(/\s+/g, ' ').slice(0, 80)}`);
        return 0;
    }
    if (sub === 'show') { if (!id) throw store.userError('issue show needs an issue id'); log(fs.readFileSync(path.join(store.dirOf(id), 'issue.md'), 'utf8')); return 0; }
    if (sub === 'open') {
        if (!id) throw store.userError('issue open needs an issue id');
        store.load(id);
        const html = path.join(store.dirOf(id), 'result', 'issue.html');
        if (!fs.existsSync(html)) { log(`No dashboard yet for ${id}: run  ${SELF} issue investigate ${id}`); return 0; }
        log(`Dashboard: ${html}\nOpen it yourself (this tool never opens it):  ${process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start ""' : 'xdg-open'} "${html}"`);
        return 0;
    }
    if (sub === 'investigate' || sub === 'retest') { if (!id) throw store.userError(`issue ${sub} needs an issue id`); store.load(id); return investigate(id, o, sub); }
    log(`Usage: ${SELF} issue <new|investigate|show|list|retest|index|cleanup|open> [id]\n  new flags: --title --description --pages /a,/b --symptom <${store.SYMPTOM_IDS.join('|')}> --login --oracle type[:value] --images <paths> --url <site> --env local|staging|live [--authorized] --root <wp-root> --since --changed-before --no-prompt --investigate`);
    return sub === 'help' ? 0 : 2;
}

async function investigate(id, o, sub = 'investigate') {
    if (sub === 'retest') {
        const root = o.root ? cfgLib.userPath(o.root) : store.load(id).root;
        if (root && !fs.existsSync(path.join(root, 'wp-content'))) throw store.userError(`root ${root} has no wp-content folder: it must be the (fixed) WordPress copy`);
        if (root) store.assertOutsideWebRoot(root);
        const r = await require('../issue/retest').run(id, { root, options: { sandbox: !!o.sandbox, probePages: o['probe-pages'], keepSandbox: false, maxSizeMb: o['max-size-mb'], dump: o['db-dump'] && cfgLib.userPath(o['db-dump']), neutralisePayments: !!o['neutralise-payments'] }, hypothesis: o.hypothesis || null, env: process.env });
        for (const st of r.steps) log(`  ${st.status.padEnd(8)} ${st.label}${st.reason ? `: ${st.reason}` : ''}`);
        log(`\nRETEST ${r.entry.n} (${r.entry.where}): ${r.entry.verdict.toUpperCase()}\n  ${r.entry.reason}`);
        if (r.entry.fixed_verified) log(`  Hypothesis ${r.entry.hypothesis} is now FIXED_VERIFIED: the oracle ran and passed on the same page(s) and screen size(s) that failed before.`);
        else log('  Nothing was marked FIXED_VERIFIED.');
        const val = require('../issue/validate').run(id, { root, config: o.config });
        const plans = require('../issue/resolve').build(id, val, { root, policy: root ? require('../issue/validate').policyFor(root, o.config) : null, dir: store.dirOf(id) });
        require('../issue/result').write(id, { validation: val, plans, dir: store.dirOf(id), root, policy: root ? require('../issue/validate').policyFor(root, o.config) : null });
        log(`  Updated: ${path.join(store.dirOf(id), 'result')}`);
        return r.entry.verdict === 'Fixed' ? 0 : r.entry.verdict === 'Could not test' ? 3 : 1;
    }
    const issue = store.load(id);
    const root = o.root ? cfgLib.userPath(o.root) : issue.root;
    if (root && !fs.existsSync(path.join(root, 'wp-content'))) throw store.userError(`root ${root} has no wp-content folder: it must be the WordPress root`);
    if (root) store.assertOutsideWebRoot(root);
    const probeOptions = { probe: o['no-probe'] ? false : undefined, probePages: o['probe-pages'], viewports: o.viewports, layout: o['no-layout'] ? false : undefined };
    const ev = await require('../issue/evidence').run(id, { root, probeOptions });
    log(`Evidence for ${id}: ${ev.summary.clues} clue(s) (certain ${ev.summary.by_confidence.certain} · likely ${ev.summary.by_confidence.likely} · possible ${ev.summary.by_confidence.possible})`);
    for (const st of ev.steps) log(`  ${st.status.padEnd(8)} ${st.label}${st.reason ? `: ${st.reason}` : ''}`);
    if (ev.reproduced) log(`SYMPTOM REPRODUCED: ${ev.reproduced.result.toUpperCase().replace(/-/g, ' ')}${ev.reproduced.result === 'could-not-test' ? ` (${ev.reproduced.reason})` : ev.reproduced.result === 'no' ? ' on the probed pages. Every conclusion below is unconfirmed.' : ' on the live page. That shows the problem is real; it does not say which component causes it.'}`);
    if (ev.features.length) log(`Features named in the description: ${ev.features.map(f => f.label).join(', ')} (taxonomy signals are not yet verified against their sources)`);
    if (ev.component_hints.length) log(`Components the clues point at: ${ev.component_hints.slice(0, 5).map(h => `${h.component} (${h.score})`).join(', ')}`);
    if (ev.notices.length) log(`Notice: ${ev.notices.length} piece(s) of text looked like markup, commands or instructions. They were kept as plain text and not acted on.`);
    log(`Saved: ${path.join(store.dirOf(id), 'work', 'evidence.json')}`);

    const an = require('../issue/analysis').run(id, { root, config: o.config });
    log('');
    for (const st of an.steps) log(`  ${st.status.padEnd(8)} ${st.label}${st.reason ? `: ${st.reason}` : ''}`);
    if (an.analysis) {
        const a = an.analysis, own = a.components.filter(c => !c.inspection_only);
        log(`Custom code: ${own.length ? own.map(c => `${c.ref} (${c.files.parsed}/${c.files.total} files parsed)`).join(', ') : 'none declared'}`);
        for (const ob of a.observations.slice(0, 12)) log(`  [${ob.type}] ${ob.message}${ob.evidence[0] && ob.evidence[0].file ? `  (${ob.evidence[0].file}:${ob.evidence[0].line})` : ''}`);
        if (a.observations.length > 12) log(`  ... and ${a.observations.length - 12} more in work/custom-code.json`);
        for (const p of an.index.providers) log(`  ${p.summary}`);
        log(`Graph: ${an.graph.nodes.length} components, ${an.graph.edges_total} relations; slice around the issue: ${an.slice.nodes.length} component(s), ${an.slice.also_found.observations.length + an.slice.also_found.collisions.length} finding(s) not related to it (kept in work/slice.json)`);
        for (const c of an.collide.collisions.slice(0, 6)) log(`  [${c.type}] ${c.message}`);
        for (const k of an.kb) log(`  [knowledge base${k.verified ? '' : ', unverified'}] ${k.title}: ${k.message}`);
        const H = an.hypotheses.hypotheses;
        log(`\nHypotheses (${H.length}; none is confirmed yet, a hypothesis is a thing to test):`);
        H.forEach((h, i) => { log(`  ${i + 1}. [${h.status}] ${h.title}  score ${h.score}${h.custom_involved ? '  (custom code)' : ''}\n     ${h.mechanism}\n     score: ${h.score_breakdown.map(b => `${b.points > 0 ? '+' : ''}${b.points} ${b.rule}`).join(', ')}`); });
        if (!H.length) log('  none: nothing in the evidence or the code analysis points at a specific cause.');
    }
    // ---- Phase G: the sandbox (throwaway copy in Docker) and the bisection ----
    const sbOpts = { sandbox: !!o.sandbox, dump: o['db-dump'] && cfgLib.userPath(o['db-dump']), exportDb: !!o['export-db'], keepRealData: !!o['keep-real-data'], neutralisePayments: !!o['neutralise-payments'], withUploads: !!o['with-uploads'], maxSizeMb: o['max-size-mb'], keepSandbox: !!o['keep-sandbox'], maxLoads: o['max-loads'], maxMinutes: o['max-minutes'], noBisect: !!o['no-bisect'], viewports: o.viewports, probePages: o['probe-pages'] };
    if (sbOpts.keepRealData) log('\nWARNING: --keep-real-data keeps the real user names, e-mail addresses and password hashes of the original site in the sandbox database. Without this flag they are scrubbed. API keys and payment settings are blanked either way.');
    const sb = await require('../issue/sandbox-phase').run(id, { root, options: sbOpts, analysis: { ...an.analysis, components: an.analysis.components, top: an.analysis.top }, env: process.env });
    log('');
    for (const st of sb.steps) log(`  ${st.status.padEnd(8)} ${st.label}${st.reason ? `: ${st.reason}` : ''}`);
    if (sb.sandbox) log(`Sandbox limits, stated plainly:\n${sb.sandbox.limits.map(l => `  - ${l}`).join('\n')}`);
    if (sb.bisect || sb.reproduced_in_sandbox) {
        const h2 = require('../issue/analysis').applyBisect(id, an, { bisect: sb.bisect, sandboxReproduced: sb.reproduced_in_sandbox });
        log(`\nHypotheses after the sandbox (${h2.hypotheses.length}):`);
        h2.hypotheses.forEach((h, i) => log(`  ${i + 1}. [${h.status}] ${h.title}  score ${h.score}`));
    }
    // ---- Phase H: validation (a separate module re-checks everything), then the resolution plans and the result files ----
    const validate = require('../issue/validate');
    const policy = root ? validate.policyFor(root, o.config) : null;
    const val = validate.run(id, { root, config: o.config });
    log('\nValidation (re-reads the cited files; php -l; ownership and the oracle are recomputed):');
    for (const c of val.checks) log(`  ${c.status.padEnd(8)} ${c.id}: ${c.reason}`);
    for (const h of val.hypotheses) log(`  ${h.status.padEnd(24)} ${h.title}${h.validation_notes.length ? '\n      ' + h.validation_notes.join('\n      ') : ''}`);
    const plans = require('../issue/resolve').build(id, val, { root, policy, dir: store.dirOf(id) });
    // ---- patches and shims: tried on the sandbox copy, and marked "verified in sandbox" only if the symptom is gone ----
    const vf = await require('../issue/verify-fixes').run(id, { root, plans, options: { sandbox: !!o.sandbox, ...sbOpts, keepSandbox: false }, env: process.env });
    for (const st of vf.steps) log(`  ${st.status.padEnd(8)} ${st.label}: ${st.reason}`);
    for (const p of plans) for (const op of p.options) if (op.sandbox_verification) log(`    ${op.verified_in_sandbox === true ? 'VERIFIED IN SANDBOX' : op.verified_in_sandbox === false ? 'TESTED, DID NOT HELP' : 'not verified'}: ${op.title}${op.verified_in_sandbox === null ? ' (' + op.sandbox_verification.reason.slice(0, 100) + ')' : ''}`);
    const res = require('../issue/result').write(id, { validation: val, plans, dir: store.dirOf(id), root, policy });
    log(`\nVERDICT: ${res.findings.verdict.label} (confidence ${res.findings.verdict.confidence})`);
    for (const p of plans) for (const op of p.options.slice(0, 4)) log(`  [${op.who}] ${op.type}: ${op.title}${op.verification && op.verification.length ? '  (' + op.verification.map(v => v.id + ' ' + v.status).join(', ') + ')' : ''}`);
    log(`Saved: ${res.dir} (findings.json, issue.html, ISSUE-REPORT.md, tasks.md with ${res.tasks} task(s), patches/). Issues index: ${path.join(store.issuesRoot(), 'index.html')}. Nothing was changed on the site.`);
    return 0;
}

module.exports = { run, parseOracle, newIssue };
