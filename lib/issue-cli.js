// `guard.js issue <new|investigate|show|list|retest|open> [id]`. Prompts one question at a time, but every answer is also a flag,
// so it runs without prompts (--no-prompt, or all answers given). Report opening is done by lib/wizard.js, after asking; this file only prints the path/link.

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
        say: text => output.write(`${text}\n`),
        askRaw: async q => { output.write(`${q}: `); const r = await it.next(); output.write(r.done ? '\n' : ''); return r.done ? null : String(r.value).trim(); },   // null = the input ended
        ask: async (q, def) => { output.write(`${q}${def ? ` [${def}]` : ''}: `); const r = await it.next(); output.write(r.done ? '\n' : ''); const v = r.done ? '' : String(r.value).trim(); return v || def || ''; },
        wait: async q => { output.write(q); await it.next(); },
        close: () => rl.close()
    };
}

// TEST-COPY-SPEC 6c-2: the fixed lines about user data (the wizard asks the question; these are printed by every command that builds from a database file)
const OTHER_TABLES_NOTE = 'Email addresses and IP addresses in other tables (form entries, order notes, plugin settings) are not hidden in this version.';
const uncheckedLine = n => `${n} tables could not be checked and are copied as they are.`;
const testLoginLine = l => `Test login for the copy: ${l.user} / ${l.password}  (shown only here, never saved)`;
// work/user-data.json written by issue/sandbox.js: numbers and fixed words only
function readUserData(id) {
    try { const f = path.join(store.dirOf(id), 'work', 'user-data.json'); if (!fs.lstatSync(f).isFile()) return null; const d = JSON.parse(fs.readFileSync(f, 'utf8')); return d && d.schema === 1 ? d : null; } catch { return null; }
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
    const issue = store.create({ ...a, url: o.url, authorized: o.authorized, root, since: o.since, changedBefore: o['changed-before'], phpVersion: o.php });
    log(`Issue ${issue.id} saved: ${path.join(store.dirOf(issue.id), 'issue.json')}`);
    const sh = siteHealthFlag(issue.id, o);
    if (sh) log(`Site Health text read: ${sh.found ? 'versions and active plugins taken from it' : 'nothing recognisable in it'} (only the parsed values are kept).`);

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


// --site-health <file> (TEST-COPY-SPEC Part 6b): the text of Site Health > Info > "Copy site info to clipboard", saved as a file. Read once (a plain
// file, at most 256 KB), parsed with strict patterns, and only the parsed values are kept in work/site-health.json; the paste itself is not stored.
function siteHealthFlag(id, o) {
    if (o['site-health'] === undefined) return null;
    if (o['site-health'] === true || !String(o['site-health']).trim()) throw store.userError('--site-health needs a file: the text copied from Site Health > Info > "Copy site info to clipboard"');
    const vm = require('../issue/version-match');
    try { return vm.saveSiteHealth(store.dirOf(id), cfgLib.userPath(String(o['site-health']))); }
    catch (e) { if (e.name === 'SiteHealthRefused') throw store.userError(`--site-health: ${e.message}`); throw e; }
}

async function run(o, { input = process.stdin, output = process.stdout } = {}) {
    const [, sub = 'help', id] = o._;
    if (sub !== 'help') deps.need();
    if (sub === 'new') {
        const io = o['no-prompt'] ? null : lineReader(input, output);
        try {
            const { issue } = await newIssue(o, io);
            if (o.investigate) { log(''); return investigate(issue.id, o, 'investigate', { io }); }
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
        log(`Dashboard: ${html}\nOpen it in your browser:  ${process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start ""' : 'xdg-open'} "${html}"`);
        return 0;
    }
    if (sub === 'investigate' || sub === 'retest') { if (!id) throw store.userError(`issue ${sub} needs an issue id`); store.load(id); return investigate(id, o, sub); }
    log(`Usage: ${SELF} issue <new|investigate|show|list|retest|index|cleanup|open> [id]\n  new flags: --gate (show only confirmed, breaking causes; the rest are Advisories) --verbose (with --gate: list the Advisories too) --no-questions (skip the follow-up questions) --php <site PHP version, e.g. 8.1> --site-health <file: Site Health > Info > Copy site info> --title --description --pages /a,/b --symptom <${store.SYMPTOM_IDS.join('|')}> --login --oracle type[:value] --images <paths> --url <site> --env local|staging|live [--authorized] --root <wp-root> --since --changed-before --no-prompt --investigate`);
    return sub === 'help' ? 0 : 2;
}

// the gate branch of the command line: what is wrong first (the summary), then the counts, the full list of checks only with --verbose, then what to try
function printGate(res, plans, o, log, dir) {
        let comps = [];
        try { comps = (JSON.parse(fs.readFileSync(path.join(dir, 'work', 'components.json'), 'utf8')).components) || []; } catch { /* no component list: folder names are capitalised */ }
        log(`\n${res.findings.summary.text_report || res.findings.summary.text}`);
        const shownIds = new Set(res.findings.findings.map(x => x.id));
        const plainName = require('./plain-names');
        // the checkpoints: the counts are in the summary above; the full list only with --verbose
        const cpt = res.findings.checkpoint_text;
        if (cpt && o.verbose) { log('\nAll checks:'); for (const l of cpt.lines) log(`  ${l}`); }
        const resOf = new Map(res.findings.resolution.map(r => [r.hypothesis, r]));
        for (const p of plans) {
            const r = resOf.get(p.hypothesis) || { options: [] };
            if (r.what_to_try && r.what_to_try.length) { log('\nWhat to try:'); r.what_to_try.forEach((t, i) => log(`  ${i + 1}. ${t}`)); }
            if (o.verbose || shownIds.has(p.hypothesis) || (r.what_to_try && r.what_to_try.length)) p.options.slice(0, 4).forEach((op, i) => log(`  [${op.who}] ${op.type}: ${plainName.plainText((r.options[i] && r.options[i].reader_title) || op.title, comps)}`));
        }
        if (!o.verbose && res.findings.advisories.length) log('(run again with --verbose to list the Advisories)');
        if (cpt && !o.verbose) log('(run again with --verbose to list every check)');
}

async function investigate(id, o, sub = 'investigate', opt = {}) {
    if (sub === 'retest') {
        const root = o.root ? cfgLib.userPath(o.root) : store.load(id).root;
        if (root && !fs.existsSync(path.join(root, 'wp-content'))) throw store.userError(`root ${root} has no wp-content folder: it must be the (fixed) WordPress copy`);
        if (root) store.assertOutsideWebRoot(root);
        const r = await require('../issue/retest').run(id, { root, options: { sandbox: !!o.sandbox && !o['no-replica'], probePages: o['probe-pages'], keepSandbox: false, maxSizeMb: o['max-size-mb'], dump: !o['no-replica'] && o['db-dump'] ? cfgLib.userPath(o['db-dump']) : undefined, neutralisePayments: !!o['neutralise-payments'] }, hypothesis: o.hypothesis || null, env: process.env });
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
    siteHealthFlag(id, o);   // a Site Health file given now replaces the one given before (parsed values only)
    const probeOptions = { probe: o['no-probe'] ? false : undefined, probePages: o['probe-pages'], viewports: o.viewports, layout: o['no-layout'] ? false : undefined };
    // ---- follow-up questions (issue/questions.js): plain-language, at most 5, never without a terminal, never with --yes / --no-questions / --no-prompt ----
    const Q = require('../issue/questions');
    // --gate without --verbose: the technical log lines are hidden; the plain summary at the end says what matters
    const quiet = !!o.gate && !o.verbose, say = (...a) => { if (!quiet) log(...a); };
    // the flags always win, whatever reader was supplied: --yes, --no-questions and --no-prompt each switch the questions off
    const interactive = !o.yes && !o['no-questions'] && !o['no-prompt'] && (opt.interactive !== undefined ? !!opt.interactive : Q.interactiveNow(o));
    let qio = opt.io || null, ownIo = false;
    if (interactive && !qio) { qio = lineReader(process.stdin, process.stdout); ownIo = true; }
    const qstate = Q.newState(), io2 = qio ? { say: t => qio.say(t), ask: p => qio.askRaw(p) } : null;
    // the copy could not keep the original file times (work/intake.json times_preserved: false): no date at all, never the day of the copy
    const timesLost = (() => { try { return JSON.parse(fs.readFileSync(path.join(store.dirOf(id), 'work', 'intake.json'), 'utf8')).times_preserved === false; } catch { return false; } })();
    const installed = () => { try { return require('../lib/components').discover(root).plugins.concat(require('../lib/components').discover(root).themes).map(c => { let t = null; if (!timesLost) try { t = fs.statSync(path.join(c.dir, c.main)).mtime.toISOString().slice(0, 10); } catch { /* display only */ } return { ref: c.ref, name: c.name || c.slug, version: c.version || null, updated_text: t }; }); } catch { return []; } };
    const comps = root ? installed() : [];
    const baseCtx = clues => ({ issue: store.load(id), clues, components: comps, viewports_given: !!o.viewports });
    const apply = patch => store.applyQuestionAnswers(id, patch);
    await Q.runPass({ ids: ['since', 'page', 'login'], ctxOf: () => baseCtx([]), state: qstate, io: io2, interactive, apply });
    const ev = await require('../issue/evidence').run(id, { root, probeOptions, beforeProbe: async ({ clues }) => {
        await Q.runPass({ ids: ['what', 'screen'], ctxOf: () => baseCtx(clues), state: qstate, io: io2, interactive, apply });
        const qq = store.load(id).questions;
        return { probeOptions: !o.viewports && qq && qq.viewports ? { viewports: qq.viewports } : {} };
    } });
    say(`Evidence for ${id}: ${ev.summary.clues} clue(s) (certain ${ev.summary.by_confidence.certain} · likely ${ev.summary.by_confidence.likely} · possible ${ev.summary.by_confidence.possible})`);
    for (const st of ev.steps) say(`  ${st.status.padEnd(8)} ${st.label}${st.reason ? `: ${st.reason}` : ''}`);
    if (ev.reproduced) say(`SYMPTOM REPRODUCED: ${ev.reproduced.result.toUpperCase().replace(/-/g, ' ')}${ev.reproduced.result === 'could-not-test' ? ` (${ev.reproduced.reason})` : ev.reproduced.result === 'no' ? ' on the probed pages. Every conclusion below is unconfirmed.' : ' on the live page. That shows the problem is real; it does not say which component causes it.'}`);
    if (ev.features.length) say(`Features named in the description: ${ev.features.map(f => f.label).join(', ')} (taxonomy signals are not yet verified against their sources)`);
    if (ev.component_hints.length) say(`Components the clues point at: ${ev.component_hints.slice(0, 5).map(h => `${h.component} (${h.score})`).join(', ')}`);
    if (ev.notices.length) say(`Notice: ${ev.notices.length} piece(s) of text looked like markup, commands or instructions. They were kept as plain text and not acted on.`);
    say(`Saved: ${path.join(store.dirOf(id), 'work', 'evidence.json')}`);

    let an = require('../issue/analysis').run(id, { root, config: o.config });
    // pass B (needs the code analysis): the PHP version and the redirecting page. Answers change what the analysis says, so it is run again: offline, the probe is NOT
    // repeated, every file it writes is overwritten (never appended), and it happens before the sandbox.
    if (interactive) {
        const readJson = f => { try { return JSON.parse(fs.readFileSync(path.join(store.dirOf(id), 'work', f), 'utf8')); } catch { return null; } };
        const ctxB = () => { const cc = readJson('custom-code.json') || {}, evd = readJson('evidence.json') || { clues: [] }; return { issue: store.load(id), clues: evd.clues, observations: cc.observations || [], redirect_map: cc.redirect_map || [], redirect_observed: evd.clues.some(c => c.type === 'probe-redirect'), components: comps, viewports_given: !!o.viewports }; };
        const answered = await Q.runPass({ ids: ['php', 'redirect'], ctxOf: ctxB, state: qstate, io: io2, interactive, apply });
        if (answered.some(a => !a.skipped)) { log('\nThank you. Re-reading the code with your answers (nothing is loaded from the website again)...'); an = require('../issue/analysis').run(id, { root, config: o.config }); }
    }
    if (ownIo) qio.close();
    say('');
    for (const st of an.steps) say(`  ${st.status.padEnd(8)} ${st.label}${st.reason ? `: ${st.reason}` : ''}`);
    if (an.analysis) {
        const a = an.analysis, own = a.components.filter(c => !c.inspection_only);
        say(`Custom code: ${own.length ? own.map(c => `${c.ref} (${c.files.parsed}/${c.files.total} files parsed)`).join(', ') : 'none declared'}`);
        for (const ob of a.observations.slice(0, 12)) say(`  [${ob.type}] ${ob.message}${ob.evidence[0] && ob.evidence[0].file ? `  (${ob.evidence[0].file}:${ob.evidence[0].line})` : ''}`);
        if (a.observations.length > 12) say(`  ... and ${a.observations.length - 12} more in work/custom-code.json`);
        for (const p of an.index.providers) say(`  ${p.summary}`);
        say(`Graph: ${an.graph.nodes.length} components, ${an.graph.edges_total} relations; slice around the issue: ${an.slice.nodes.length} component(s), ${an.slice.also_found.observations.length + an.slice.also_found.collisions.length} finding(s) not related to it (kept in work/slice.json)`);
        for (const c of an.collide.collisions.slice(0, 6)) say(`  [${c.type}] ${c.message}`);
        for (const k of an.kb) say(`  [knowledge base${k.verified ? '' : ', unverified'}] ${k.title}: ${k.message}`);
        const H = an.hypotheses.hypotheses;
        say(`\nHypotheses (${H.length}; none is confirmed yet, a hypothesis is a thing to test):`);
        H.forEach((h, i) => { say(`  ${i + 1}. [${h.status}] ${h.title}  score ${h.score}${h.custom_involved ? '  (custom code)' : ''}\n     ${h.mechanism}\n     score: ${h.score_breakdown.map(b => `${b.points > 0 ? '+' : ''}${b.points} ${b.rule}`).join(', ')}`); });
        if (!H.length) say('  none: nothing in the evidence or the code analysis points at a specific cause.');
    }
    // ---- Phase G: the sandbox (throwaway copy in Docker) and the bisection ----
    // --no-replica: no test copy at all (TEST-COPY-SPEC 6), whatever --sandbox, --db-dump or --export-db say
    // skipped (6d-3 wording): --no-replica, or the wizard's "0) Skip the test copy" ('copy-skipped'): the report says the person chose no copy, lists nothing missing
    const noReplica = !!o['no-replica'];
    const sbOpts = { sandbox: !!o.sandbox && !noReplica, dump: !noReplica && o['db-dump'] ? cfgLib.userPath(o['db-dump']) : undefined, exportDb: !!o['export-db'] && !noReplica, neutralisePayments: !!o['neutralise-payments'], withUploads: !!o['with-uploads'], maxSizeMb: o['max-size-mb'], keepSandbox: !!o['keep-sandbox'], maxLoads: o['max-loads'], maxMinutes: o['max-minutes'], noBisect: !!o['no-bisect'], viewports: o.viewports, probePages: o['probe-pages'], ...(noReplica || o['copy-skipped'] === true ? { skipped: true } : {}) };
    // user accounts of a copy built from a database file (TEST-COPY-SPEC 5, 6c-2): dummy users only; --users dummy is the only accepted value
    // (scripts/guard.js parse() refuses every other one). The test password of the dummy admin is printed ONCE, only on a terminal, and kept nowhere.
    // with --gate the summary's developer block carries the other-tables note and the unchecked-tables line (issue/case-file.js userDataLines), so they are printed once
    const withDump = sbOpts.sandbox && !!sbOpts.dump;
    if (withDump && !o.gate) log(`\n${OTHER_TABLES_NOTE}`);
    const loginOut = opt.loginOut || { tty: !!process.stdout.isTTY, write: log };
    let loginShown = false;
    const onTestLogin = l => {
        if (loginShown || !withDump) return;
        loginShown = true;
        if (l && l.user && l.password) { if (loginOut.tty) loginOut.write(testLoginLine(l)); }
        else loginOut.write(`The test copy has no test login: ${(l && l.reason) || 'no administrator account was found in your database file'}.`);
    };
    const sb = await require('../issue/sandbox-phase').run(id, { root, options: sbOpts, analysis: { ...an.analysis, components: an.analysis.components, top: an.analysis.top }, env: process.env, sandboxOptions: { ...(opt.sandboxOptions || {}), onTestLogin } });
    if (withDump && sb.sandbox && !o.gate) { const ud = readUserData(id); if (ud && Number.isInteger(ud.unchecked_tables)) log(uncheckedLine(ud.unchecked_tables)); }
    say('');
    for (const st of sb.steps) say(`  ${st.status.padEnd(8)} ${st.label}${st.reason ? `: ${st.reason}` : ''}`);
    if (sb.sandbox) say(`Sandbox limits, stated plainly:\n${sb.sandbox.limits.map(l => `  - ${l}`).join('\n')}`);
    if (sb.bisect || sb.reproduced_in_sandbox) {
        const h2 = require('../issue/analysis').applyBisect(id, an, { bisect: sb.bisect, sandboxReproduced: sb.reproduced_in_sandbox, sandboxRedirect: !!sb.redirect_observed });
        say(`\nHypotheses after the sandbox (${h2.hypotheses.length}):`);
        h2.hypotheses.forEach((h, i) => say(`  ${i + 1}. [${h.status}] ${h.title}  score ${h.score}`));
    }
    // ---- Phase H: validation (a separate module re-checks everything), then the resolution plans and the result files ----
    const validate = require('../issue/validate');
    const policy = root ? validate.policyFor(root, o.config) : null;
    const val = validate.run(id, { root, config: o.config });
    say('\nValidation (re-reads the cited files; php -l; ownership and the oracle are recomputed):');
    if (o.gate) for (const l of require('./plain-names').readerValidationLines(val)) say(l);   // reader words: no check ids, no oracle wording (findings.json keeps them)
    else {
        for (const c of val.checks) say(`  ${c.status.padEnd(8)} ${c.id}: ${c.reason}`);
        for (const h of val.hypotheses) say(`  ${h.status.padEnd(24)} ${h.title}${h.validation_notes.length ? '\n      ' + h.validation_notes.join('\n      ') : ''}`);
    }
    const plans = require('../issue/resolve').build(id, val, { root, policy, dir: store.dirOf(id) });
    // ---- patches and shims: tried on the sandbox copy, and marked "verified in sandbox" only if the symptom is gone ----
    const vf = await require('../issue/verify-fixes').run(id, { root, plans, options: { sandbox: !!o.sandbox, ...sbOpts, keepSandbox: false }, env: process.env });
    for (const st of vf.steps) say(`  ${st.status.padEnd(8)} ${st.label}: ${st.reason}`);
    for (const p of plans) for (const op of p.options) if (op.sandbox_verification) say(`    ${op.verified_in_sandbox === true ? 'VERIFIED IN SANDBOX' : op.verified_in_sandbox === false ? 'TESTED, DID NOT HELP' : 'not verified'}: ${op.title}${op.verified_in_sandbox === null ? ' (' + op.sandbox_verification.reason.slice(0, 100) + ')' : ''}`);
    const res = require('../issue/result').write(id, { validation: val, plans, dir: store.dirOf(id), root, policy, gate: !!o.gate, verbose: !!o.verbose });
    log(o.gate && res.findings.confidence_text ? `\nVERDICT: ${res.findings.verdict.label}\n  ${res.findings.confidence_text}` : `\nVERDICT: ${res.findings.verdict.label} (confidence ${res.findings.verdict.confidence})`);
    if (o.gate) printGate(res, plans, o, log, store.dirOf(id));
    else for (const p of plans) for (const op of p.options.slice(0, 4)) log(`  [${op.who}] ${op.type}: ${op.title}${op.verification && op.verification.length ? '  (' + op.verification.map(v => v.id + ' ' + v.status).join(', ') + ')' : ''}`);
    log(`Saved: ${res.dir} (findings.json, issue.html, ISSUE-REPORT.md, tasks.md with ${res.tasks} task(s), patches/). Issues index: ${path.join(store.issuesRoot(), 'index.html')}. Nothing was changed on the site.`);
    return 0;
}

module.exports = { printGate, run, parseOracle, newIssue, investigate, lineReader, siteHealthFlag, readUserData, OTHER_TABLES_NOTE, uncheckedLine, testLoginLine };
