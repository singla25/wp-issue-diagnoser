// FIX-PLAN.md (REPORT-SPEC 5.3): a plain, checkable plan for the top cause of the report, written to issues/<id>/result/FIX-PLAN.md.
// Deterministic text from findings.json (case_file, cause_detail, the re-checked fatal's provider and versions) and the reporter's saved plan answers (issue.json
// `plan_answers`, issue/plan-questions.js). It is written at the end of a gate-on run and written again after the answers; with no likely cause, no confirmed cause and
// no sign that a copy was modified there is no file. Pure apart from writeFor(), which reads the issue's COPY of the site (a compatible version stated in the theme's own
// files) and writes only into the issue folder.
// Rules (REPORT-SPEC 2): the tool never applies anything and never writes a patch for third-party code; themes and plugins are changed only by an update, a theme switch or
// a child-theme override; every step has an undo; an older version of the provider is suggested ONLY when the copy itself states a compatible version.

const fs = require('fs');
const path = require('path');
const ownership = require('../lib/ownership');

const HEAD = { problem: 'The problem', plan: 'The plan we suggest, and why', before: 'Before you start', steps: 'Steps', done: 'You are done when', dont: 'Please do not' };
const DONE_CAUSE = 'Run this report again on the changed copy and it no longer lists this cause.';
const DONT = ['Edit files of themes or plugins you did not write. They are changed only by an update, a theme switch or a child-theme override.',
    'Use or look for cracked or nulled versions.',
    'Apply this on the live site before testing it on a copy.'];
const NOT_YET = 'Not yet tested on a copy of your site.';
const NOT_REPRODUCED = 'Not reproduced on a test copy of your site.';
const ANSWER_WORD = { yes: 'yes', no: 'no', 'not-sure': 'not sure' };
const esc = t => String(t ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/&(?=#?\w+;)/g, '\\&').replace(/</g, '\\<').replace(/`/g, "'").trim();
const cap = s => String(s).replace(/^./, c => c.toUpperCase());
const rowOf = (c, k) => ((c && c.rows || []).find(r => r[0] === k) || [0, []])[1];

// ---- what the plan is about: the top case of the report ----
// -> null (nothing to plan for) or { kind: 'cause' | 'signs', case, confirmed, sandbox, fr, comp: { kind, name, version, ref, rel }, provider, versions, signs }
function context(f) {
    const cf = f && f.case_file;
    if (!cf) return null;
    const top = cf.cases.find(c => c.kind === 'likely' || c.kind === 'confirmed') || null;
    const signsCase = cf.cases.find(c => c.kind === 'signs') || null;
    if (!top && !signsCase) return null;
    const ms = f.modified_signs || null;
    const signs = ms ? ms.signs || [] : [];
    if (!top) return { kind: 'signs', case: signsCase, signs, signsCase };
    const boxItem = (f.likely || []).find(x => x.box) || (f.findings || []).find(x => x.box) || null;
    const isBox = !!(boxItem && f.what_is_wrong && top === cf.cases[0]);
    const h = isBox ? (f.hypotheses || []).find(x => x.id === boxItem.id) : null;
    const fr = h && h.fatal_recheck ? h.fatal_recheck : null;
    let comp = null;
    if (fr && fr.file) {
        const ref = (ownership.componentOf(fr.file) || '').replace(/^plugin:/, '');
        const row = (f.components || []).find(c => c.ref === ref) || null;
        const kind = fr.file_kind === 'theme' ? 'theme' : fr.file_kind === 'mu' ? 'must-use plugin' : 'plugin';
        const slug = ref.replace(/^(theme|mu):/, '');
        comp = { kind, ref, slug, name: (row && row.name) || cap(slug), version: (row && row.version) || null, rel: fr.file_kind === 'theme' ? `wp-content/themes/${slug}` : fr.file_kind === 'mu' ? 'wp-content/mu-plugins' : `wp-content/plugins/${slug}` };
    }
    const sure = rowOf(top, 'How sure');
    const sandbox = sure.some(t => /Reproduced on a test copy of your site/.test(t)) ? 'yes' : sure.some(t => /did not reproduce it/.test(t)) ? 'no' : null;
    return { kind: 'cause', case: top, confirmed: top.kind === 'confirmed', sandbox, fr, comp, provider: fr && fr.kind === 'class' && fr.provider && fr.provider.known && fr.provider.installed ? fr.provider : null,
        versions: (f.what_is_wrong && f.what_is_wrong.case && f.what_is_wrong.case.versions) || [], components: rowOf(top, 'Components'), signs, signsCase };
}
const involvesTheme = ctx => !!(ctx && ctx.kind === 'cause' && (ctx.comp ? ctx.comp.kind === 'theme' : (ctx.components || []).some(t => /\bthe theme\b/.test(t))));

// ---- the evidence for an older provider version: only what the theme's (or plugin's) OWN files of the copy state. Read-only. -> { file, text, version } | null ----
function compatEvidence(root, ctx) {
    if (!root || !ctx || !ctx.comp || !ctx.provider) return null;
    const dir = path.join(root, ctx.comp.rel);
    const name = ctx.provider.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const head = new RegExp(`^[ \\t/*#@]*(${name}\\s+(?:tested up to|requires at least))\\s*:\\s*(\\d+\\.\\d+(?:\\.\\d+)?)`, 'mi');
    const line = new RegExp(`compatib\\w*\\s+with\\s+${name}\\s+(?:version\\s+|v)?(\\d+\\.\\d+(?:\\.\\d+)?)`, 'i');
    const read = f => { try { const st = fs.lstatSync(f); return st.isFile() && st.size < 2 * 1024 * 1024 ? fs.readFileSync(f, 'utf8') : null; } catch { return null; } };
    const main = ctx.comp.kind === 'theme' ? 'style.css' : null;
    if (main) { const t = read(path.join(dir, main)); const m = t && head.exec(t); if (m) return { file: `${ctx.comp.rel}/${main}`, text: `${m[1].trim()}: ${m[2]}`, version: m[2] }; }
    for (const n of ['changelog.txt', 'changelog.md', 'CHANGELOG.md', 'readme.txt']) {
        const t = read(path.join(dir, n));
        if (!t) continue;
        const l = t.split('\n').find(x => line.test(x));
        if (l) return { file: `${ctx.comp.rel}/${n}`, text: l.trim().slice(0, 160), version: line.exec(l)[1] };
    }
    return null;
}

// ---- the options, in the default order, pruned by the answers ----
// -> { options: [{ id, title, why, steps: [[text, undo]], note? }], unavailable: [text], chosen, chosenBy: 'you' | 'default' }
function options(ctx, answers = {}, evidence = null) {
    const a = answers || {};
    const out = [], unavailable = [];
    if (ctx.kind === 'signs') {
        const comps = [...new Map((ctx.signs || []).map(s => [`${s.component.kind}:${s.component.slug}`, s.component])).values()];
        const names = comps.length ? comps.map(c => `the ${c.kind} ${c.name}`).join(' and ') : 'the theme or plugin named under the signs';
        out.push({ id: 'replace-licensed', title: `Replace ${names} with a licensed copy from the vendor`, why: "This copy shows signs of being changed from the vendor's version. It cannot be verified against the vendor. If this copy did not come from the vendor, replace it with a licensed copy from the vendor.",
            steps: (comps.length ? comps : [null]).map(c => [c ? `On the copy, download ${`the ${c.kind} ${c.name}`} again from its vendor with your licence, and replace the folder wp-content/${c.kind === 'theme' ? 'themes' : 'plugins'}/${c.slug} with it.` : 'On the copy, download the theme or plugin again from its vendor with your licence, and replace its folder with it.', 'Put the old folder back from the backup.']) });
        out.push({ id: 'remove-unused', title: `Remove ${names} from the copy if it is not used`, why: 'What is not installed cannot run. Only do this when nothing on the site needs it.',
            steps: [[`On the copy, switch off and delete ${names} (Plugins, or Appearance > Themes).`, 'Restore it from the backup.']] });
    } else {
        const c = ctx.comp, who = c ? `the ${c.kind} ${c.name}` : 'the theme or plugin named in the case';
        const whoV = c ? `${who}${c.version ? ` ${c.version}` : ''}` : who;
        const prov = ctx.provider;
        const theme = involvesTheme(ctx);
        const upd = { id: c && c.kind === 'theme' ? 'update-theme' : 'update-component', title: `Update ${who}`, why: `The file that fails belongs to ${whoV}. A newer version from the vendor may no longer ask for what is missing. Do this only if the vendor offers a legitimate update.`,
            steps: [[`On the copy, update ${who} to the newest version its vendor offers (${c && c.kind === 'theme' ? 'Appearance > Themes, or the vendor\'s own updater' : 'Plugins, or the vendor\'s own updater'}).`, `Restore the backup${c && c.version ? `, or install ${who} ${c.version} again from the vendor's download` : ''}.`]] };
        const notes = [];
        if (a.update === 'not-sure') notes.push('Check first whether you can update the theme and plugins.');
        if (theme && a.licence === 'not-sure') notes.push('Check first whether you have a licence for the theme: an update usually needs one.');
        if (notes.length) upd.note = notes.join(' ');
        const lic = { id: 'get-licence', title: `Get a licence or a replacement for ${who} from the vendor`, why: 'Without a licence the vendor\'s updates are usually not available. A licensed copy or a replacement from the vendor brings a version that matches your plugins.',
            steps: [[`Contact the vendor of ${who} for a licence or a licensed replacement, then install it on the copy.`, 'Restore the backup.']] };
        if (theme && a.licence === 'no') out.push(lic); else if (a.update !== 'no') out.push(upd);
        if (theme && c && c.kind === 'theme') out.push({ id: 'default-theme', title: 'Test with a default theme to confirm the cause', why: `If the error goes away with a default theme (for example Twenty Twenty-Five), the cause is in ${who}. This is a test that shows where the cause is; it is not the fix.`,
            steps: [['On the copy, switch to a default theme under Appearance > Themes (for example Twenty Twenty-Five; install it from WordPress.org first if it is missing).', `Switch back to ${c.name} under Appearance > Themes.`]] });
        else if (c) out.push({ id: 'switch-off', title: `Test with ${who} switched off on the copy`, why: `If the error goes away with ${who} switched off, the cause is in it. This is a test that shows where the cause is; it is not the fix.`,
            steps: [[`On the copy, switch off ${who} (Plugins).`, `Switch ${who} on again.`]] });
        if (prov) {
            if (evidence) out.push({ id: 'older-provider', title: `Use an older version of ${prov.name} for a while`, why: `The ${c ? c.kind : 'theme'}'s own file ${evidence.file} states: "${evidence.text}". A version of ${prov.name} in that range may still have what the file asks for. This is temporary: plan the update of ${who} as well.`,
                steps: [[`On the copy, install ${prov.name} ${evidence.version} from its vendor's own download (for a plugin on WordPress.org: its page, Advanced View, Previous versions).`, `Update ${prov.name} back to ${prov.version || 'the version you had'}, or restore the backup.`]] });
            else unavailable.push(`An older version of ${prov.name}: which version still has this is not known (the ${c ? c.kind : 'theme'}'s own files of the copy state no compatible version), so it is not suggested.`);
        }
        out.push({ id: 'developer-text', title: 'Ask a developer for a change, written as text for review', why: `A developer can write the change as text for you to review, to be used as a child-theme override or a small separate plugin. Plugin Guard does not write a patch for the code of ${who} or of any plugin.`,
            steps: [[`Give a developer this plan and ask for the change as text for review, to be used on the copy as a child-theme override or a small separate plugin. The files of ${who} stay as they are.`, 'Switch off the child theme or the small plugin.']] });
    }
    const pick = a.plan && a.plan !== 'not-sure' ? out.find(o => o.id === a.plan) : null;
    return { options: out, unavailable, chosen: pick || out[0] || null, chosenBy: pick ? 'you' : 'default' };
}

// ---- the text ----
// f: findings.json; answers: issue.json plan_answers (or null); evidence: compatEvidence() -> string | null (null: nothing to plan for)
function build(f, answers = null, evidence = null) {
    const ctx = context(f);
    if (!ctx) return null;
    const a = (answers && typeof answers === 'object') ? answers : {};
    const o = options(ctx, a, evidence);
    const ch = o.chosen;
    const L = [];
    const title = (f.case_file && f.case_file.title) || (f.issue && f.issue.title) || 'the problem';
    L.push(`# Fix plan: ${esc(title)}`, '');
    // the short plain summary on top
    const what = ctx.kind === 'signs' ? 'This copy of your site shows signs that a theme or plugin was changed from the vendor\'s version.' : `${ctx.confirmed ? 'Confirmed cause' : 'Likely cause (not confirmed)'}: ${esc(firstWhy(ctx)).replace(/^./, x => x.toLowerCase())}`;
    L.push(`In short: ${what} The plan: ${esc(ch.title.replace(/^./, x => x.toLowerCase()))}. Work on a copy of your site, after a backup. Plugin Guard did not change your site and does not apply this plan; a developer, or Claude Code, can follow the steps below on a copy after a backup.`, '');
    // the problem, in two lines
    L.push(`## ${HEAD.problem}`, '');
    if (ctx.kind === 'signs') { L.push(esc((ctx.signsCase && rowOf(ctx.signsCase, 'Signs')[0]) || 'Signs that a copy was modified were found.')); L.push(esc("This copy shows signs of being changed from the vendor's version. It cannot be verified against the vendor.")); }
    else { L.push(esc(firstWhy(ctx))); L.push(esc(whereLine(ctx))); }
    L.push('');
    // the plan and why
    L.push(`## ${HEAD.plan}`, '');
    L.push(o.chosenBy === 'you' ? `You chose: ${esc(ch.title)}.` : `Ranked default (nothing was chosen): ${esc(ch.title)}.`, '', esc(ch.why), '');
    if (ch.note) L.push(esc(ch.note), '');
    const answered = ['update', 'licence', 'copy'].filter(k => a[k]).map(k => `${{ update: 'can update the theme and plugins', licence: 'has a licence for the theme', copy: 'this is a copy with a backup' }[k]}: ${ANSWER_WORD[a[k]] || a[k]}`);
    if (answered.length) L.push(`Your answers: ${answered.join('; ')}.`, '');
    const rest = o.options.filter(x => x !== ch);
    if (rest.length) { L.push('Other options, in order:', ''); rest.forEach((x, i) => L.push(`${i + 1}. ${esc(x.title)}. ${esc(x.why)}${x.note ? ` ${esc(x.note)}` : ''}`)); L.push(''); }
    for (const u of o.unavailable) L.push(`Not suggested: ${esc(u)}`, '');
    // before you start
    L.push(`## ${HEAD.before}`, '');
    L.push('- [ ] Make a backup with UpdraftPlus (or your host\'s backup) and keep it somewhere other than the site.');
    L.push('- [ ] Work on a copy or a staging site, not on the live site.');
    const vers = ctx.kind === 'cause' ? (ctx.versions.length ? ctx.versions : ctx.components) : [...new Set((ctx.signs || []).map(s => `${s.component.kind} ${s.component.name}`))];
    L.push(`- [ ] Note the current versions${vers.length ? `: ${esc(vers.join(' · '))}` : ' of the theme and plugins'}.`);
    if (ctx.kind === 'cause') L.push('', esc(ctx.confirmed ? (ctx.sandbox === 'yes' ? 'Reproduced on a test copy of your site.' : ctx.sandbox === 'no' ? 'A test on a copy of your site did not reproduce it.' : NOT_YET) : ctx.sandbox === 'yes' ? 'Reproduced on a test copy of your site, but not confirmed by the re-check of the code.' : NOT_REPRODUCED));
    if (ctx.kind === 'cause' && ctx.signsCase) L.push('', 'This copy also shows signs that a theme or plugin was changed from the vendor\'s version (see the report). If it did not come from the vendor, replace it with a licensed copy from the vendor first.');
    L.push('');
    // steps, numbered and checkable, each with its undo
    L.push(`## ${HEAD.steps}`, '');
    const steps = [];
    if (a.copy === 'no' || a.copy === 'not-sure') steps.push(['Make a backup with UpdraftPlus and set up a copy or a staging site before anything else. Do every step below on that copy.', 'Nothing to undo; a backup and a copy do not change the live site.']);
    steps.push(...ch.steps);
    steps.push([ctx.kind === 'signs' ? 'Load the pages of the copy that use it, and check that they work.' : 'Load the page that showed the problem, on the copy.', 'Nothing to undo; this only loads the page.']);
    steps.push(['Run this report again on the changed copy.', 'Nothing to undo; the report only reads the copy.']);
    steps.forEach(([t, u], i) => L.push(`- [ ] ${i + 1}. ${esc(t)}`, `  Undo: ${esc(u)}`));
    L.push('');
    // done when
    L.push(`## ${HEAD.done}`, '');
    if (ctx.kind === 'signs') L.push('- [ ] The pages that use it load normally on the copy.', '- [ ] Run this report again on the changed copy and it no longer lists these signs.');
    else L.push('- [ ] The page that showed the problem loads normally on the copy.', `- [ ] ${DONE_CAUSE}`);
    if (ch.id === 'default-theme') L.push('', 'Testing with a default theme only shows where the cause is. Switch back afterwards and choose one of the other options as the fix.');
    L.push('');
    // please do not
    L.push(`## ${HEAD.dont}`, '', ...DONT.map(t => `- ${t}`), '');
    return L.join('\n');
}
function firstWhy(ctx) {
    const why = rowOf(ctx.case, 'Why');
    return String(why[0] || ctx.case.heading).replace(/\s+$/, '');
}
function whereLine(ctx) {
    const w = rowOf(ctx.case, 'Where');
    return w.length ? `Where: ${w.join('; ')}.`.replace(/\.\.$/, '.') : ctx.components && ctx.components.length ? `Involved: ${ctx.components.join('; ')}.` : 'Where: see the report.';
}

// writes result/FIX-PLAN.md for this issue from its findings and saved answers, or removes a stale one when there is nothing to plan for. -> the path, or null
function writeFor(id, dir, f) {
    const store = require('../lib/issue-store');
    const file = path.join(dir, 'result', 'FIX-PLAN.md');
    let issue = null; try { issue = store.load(id); } catch { /* no issue file: no answers */ }
    const ctx = context(f);
    const text = ctx ? build(f, issue && issue.plan_answers ? issue.plan_answers : null, compatEvidence(issue && issue.root, ctx)) : null;
    if (!text) { try { if (fs.lstatSync(file).isFile()) fs.rmSync(file); } catch { /* none */ } return null; }
    fs.writeFileSync(file, text, { mode: 0o600 });
    return file;
}

module.exports = { build, context, options, compatEvidence, writeFor, involvesTheme, HEAD, DONT, DONE_CAUSE, NOT_YET, NOT_REPRODUCED };
