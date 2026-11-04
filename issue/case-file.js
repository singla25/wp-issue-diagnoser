// The case-file layout of the gate report (REPORT-SPEC 4, 4.1, 5.1): TITLE, STATUS, WHAT YOU SEE, one block per case, WHAT WAS CHECKED, FOR A DEVELOPER.
// ONE object (findings.json `case_file`) is built here and rendered three ways (the Markdown report, the command-line summary and the page), so the three agree.
// Pure and deterministic. It states facts that were already computed (box, findings, advisories, checkpoints, which steps ran); it assigns no status and decides nothing.
// Wording rules: "Likely cause (not confirmed)" is the one phrase; never "hacked" or "broken because of X"; "Not confirmed by a second, independent test." replaces "confidence: low";
// where something was not looked at, it says so. Text taken from the site (file names, template names) is data: the renderers escape it.

const plain = require('../lib/plain-names');

const LIKELY = 'Likely cause (not confirmed)';
const CHECK = 'Something else to check (probably not the crash)';
const CONFIRMED = 'Confirmed cause';
const SIGNS = 'Signs that a copy was modified';
const COMPROMISE = 'Possible compromise signs (a pattern match, not proof)';
const EMPTY_STATUS = '0 likely cause · 0 confirmed. This does not mean the site is healthy.';
const NOT_CONFIRMED_SENTENCE = 'Not confirmed by a second, independent test.';
const MODIFIED_NOTE = 'These are signs read from the copy; it cannot be verified against the vendor. Replace the copy with a licensed one from the vendor.';
const cap = s => String(s).replace(/^./, c => c.toUpperCase());
const plural = (n, one, many) => (n === 1 ? one : many);
const plural2 = (n, one, many) => (n > 1 ? many : one);   // the status line: "0 likely cause", "1 likely cause", "2 likely causes"
const itemName = c => `the ${c.kind === 'theme' ? 'theme' : c.kind === 'mu' ? 'must-use plugin' : 'plugin'} ${c.name}${c.version ? ` ${c.version}` : ''}`;
const base = f => String(f || '').split('/').pop();

function statusLine(n) {
    if (!n.likely && !n.confirmed && !n.check) return EMPTY_STATUS;
    const parts = [`${n.likely} likely ${plural2(n.likely, 'cause', 'causes')}${n.likely ? ' (not confirmed)' : ''}`];
    parts.push(`${n.check} ${plural2(n.check, 'thing', 'things')} to check`, `${n.confirmed} confirmed`);
    return parts.join(' · ') + (!n.likely && !n.confirmed ? '. This does not mean the site is healthy.' : '');
}

// what truly ran / did not run -> "Looked at: ... Not looked at: ..."
function lookedAt(facts) {
    const yes = [], no = [];
    (facts.hasLog ? yes : no).push('your log');
    (facts.probeRan ? yes : no).push('the live page');
    if (facts.hasCode) yes.push(facts.phpSkipped ? 'the code (some PHP files were not read)' : 'the code'); else no.push('the code');
    if (facts.sandboxRan) yes.push('a throwaway test copy'); else no.push(facts.sandboxFailed ? 'a throwaway test copy (it could not run)' : 'a throwaway test copy');
    return { yes, no, line: `Looked at: ${yes.length ? yes.join(', ') : 'nothing yet'}. Not looked at: ${no.length ? no.join(', ') : 'nothing'}.` };
}

function evidenceWhere(x) {
    const ev = (x.evidence || []).filter(e => e.file).slice(0, 4).map(e => `${e.file}${e.line ? `, line ${e.line}` : ''}`);
    return ev;
}

// f: the findings object (gate fields already set). ctx: { comps, facts: { hasLog, hasCode, phpSkipped, probeRan, sandboxRan, sandboxFailed }, probePages, templates, modified }
function build(f, ctx) {
    const box = f.what_is_wrong || null, bc = box && box.case ? box.case : null;
    const boxId = box ? ((f.likely || []).find(x => x.box === box) || (f.findings || []).find(x => x.box === box) || {}).id : null;
    const names = plain.namesOf(ctx.comps || []);
    const named = ref => { const c = (ctx.comps || []).find(k => k.ref === ref || k.slug === ref); return c ? itemName({ kind: c.kind, name: c.name || c.slug, version: c.version }) : plain.plainRef(ref, names); };
    const sent = t => cap(String(t || '').replace(/[.\s]+$/, ''));
    const nonComp = (f.findings || []).filter(x => x.label !== 'compromise');
    const compromise = (f.findings || []).filter(x => x.label === 'compromise');
    const cases = [];
    const sureLive = bc && bc.live ? bc.live : null;

    const addBox = () => {
        const likely = box.tier === 'likely';
        const kinds = ((f.hypotheses || []).find(h => h.id === boxId) || {}).independent_kinds || [];
        const rows = [];
        const comps = (bc.comps || []).map(c => itemName({ kind: c.kind, name: c.name, version: c.version }));
        if (comps.length) rows.push(['Components', [comps.join(' and ')]]);
        rows.push(['Where', [`${bc.where.who}: ${bc.where.file}, line ${bc.where.line}`]]);
        rows.push(['Why', bc.why]);
        rows.push(['How sure', [...bc.sure, ...(sureLive ? [sureLive] : []), likely ? NOT_CONFIRMED_SENTENCE : (kinds.length >= 2 ? `Confirmed by ${kinds.length} independent kinds of evidence.` : 'Marked as confirmed; the details for a developer show what it rests on.')]]);
        if (box.note) rows.push(['Note', [box.note]]);
        rows.push(['What to do', bc.todo]);
        cases.push({ kind: likely ? 'likely' : 'confirmed', heading: likely ? (box.age === 'old' ? `${LIKELY}, old log entry` : LIKELY) : CONFIRMED, rows });
    };
    const addGeneric = (x, kind, heading) => {
        const rows = [];
        const comps = (x.components || []).map(named);
        if (comps.length) rows.push(['Components', [comps.join(' and ')]]);
        const wh = evidenceWhere(x);
        if (wh.length) rows.push(['Where', wh]);
        rows.push(['Why', [sent(x.cause) + (x.type_text ? `. Kind of problem: ${x.type_text}.` : '.')]]);
        const sure = [];
        if (x.status) sure.push(`${plain.statusWord(x.status)}.`);
        if (x.shown_because) sure.push(`Shown because: ${x.shown_because}.`);
        for (const b of x.breaking_because || []) sure.push(`Seen: ${b.reason}`);
        if (kind === 'likely') sure.push(NOT_CONFIRMED_SENTENCE);
        rows.push(['How sure', sure]);
        if (x.rollback) rows.push(['What to do', [x.rollback.intro, ...x.rollback.options.map(o => `${o.title}: ${o.undo}`)].filter(Boolean)]);
        cases.push({ kind, heading, rows });
    };
    // order: the cause that has the box first, then other likely causes, other confirmed causes, compromise signs, then the things to check
    if (box && bc) addBox();
    for (const x of f.likely || []) if (x.id !== boxId) addGeneric(x, 'likely', LIKELY);
    for (const x of nonComp) if (x.id !== boxId) addGeneric(x, 'confirmed', CONFIRMED);
    for (const x of compromise) { addGeneric(x, 'check', COMPROMISE); cases[cases.length - 1].rows.push(['What to do', ['Do not delete files yourself; ask your host or a security professional to check, and keep a backup.']]); }
    const tpls = ctx.templates || [];
    for (const a of f.advisories || []) {
        if (a.type === 'template-override-outdated' && tpls.length) {
            const th = tpls.slice().sort((x, y) => (x.template < y.template ? -1 : x.template > y.template ? 1 : 0));
            const comps = (a.components || []).map(named);
            const list = th.slice(0, 6).map(t => `${t.template}: the theme has version ${t.theme_version || 'unknown'}, the plugin has version ${t.plugin_version || 'unknown'}`);
            if (th.length > 6) list.push(`and ${th.length - 6} more`);
            const rows = [];
            if (comps.length) rows.push(['Components', [comps.join(' and ')]]);
            rows.push(['What', [`${cap(comps[0] || 'The theme')} keeps its own copies of ${th.length} ${plural(th.length, 'template', 'templates')} that ${plural(th.length, 'is', 'are')} older than the ${plural(th.length, 'one', 'ones')} in ${comps[1] || 'the plugin'}.`]]);
            rows.push(['Files', list]);
            rows.push(['What can break', ['Pages built from these templates (for example cart, checkout or layout) can look or behave wrongly after an update. This is probably not what stops the page from loading.']]);
            rows.push(['How sure', ['Read from the files of the copy. Not confirmed as a cause of the problem.']]);
            rows.push(['What to do', ['Ask the theme author for an update, or compare each copy with the plugin\'s own file on a copy of the site.']]);
            cases.push({ kind: 'check', heading: CHECK, rows });
        } else {
            const rows = [];
            const comps = (a.components || []).map(named);
            if (comps.length) rows.push(['Components', [comps.join(' and ')]]);
            const wh = evidenceWhere(a);
            if (wh.length) rows.push(['Where', wh]);
            rows.push(['What', [sent(a.cause) + (a.merged > 1 ? ` (${a.merged} times)` : '') + '.']]);
            rows.push(['How sure', [a.why_not_shown && a.why_not_shown.primary !== 'not-established' ? `It is ${a.why_not_shown.text}.` : 'Not confirmed.', ...(a.backed_by_log || []).map(b => `A log error names ${b.file}.`)]]);
            cases.push({ kind: 'check', heading: CHECK, rows });
        }
    }
    // signs that a copy was modified: only a hook; the data arrives with the cracked-copy part and nothing here detects it
    if (Array.isArray(ctx.modified) && ctx.modified.length) cases.push({ kind: 'signs', heading: SIGNS, rows: [['Signs', ctx.modified.map(String)], ['How sure', [MODIFIED_NOTE]]] });
    cases.forEach((c, i) => { c.n = i + 1; });

    const n = { likely: cases.filter(c => c.kind === 'likely').length, confirmed: cases.filter(c => c.kind === 'confirmed').length, check: cases.filter(c => c.kind === 'check').length };
    const looked = lookedAt(ctx.facts || {});
    // what the reader sees: only what is known
    const see = [];
    const images = (f.reported && f.reported.images) || [];
    if (images.length) see.push(`${images.length} ${plural(images.length, 'screenshot', 'screenshots')} from you: ${images.map(i => i.name).join(', ')}.`);
    const five = (ctx.probePages || []).find(p => p && p.status >= 500 && p.status < 600);
    if (five) see.push(`The live page answered HTTP ${five.status}.`);
    else if (ctx.facts && ctx.facts.probeRan) see.push('The live pages that were loaded did not answer with an error.');
    else see.push('No live check was run, so nothing was seen on the live page.');
    const cp = f.checkpoints ? f.checkpoints.counts : null;
    const checked = cp ? { line: `${cp.pass} pass · ${cp.fail} fail · ${cp.not_checked} not checked · ${cp.also_noticed || 0} also noticed`,
        sentence: f.checkpoint_text.sentence, legend: 'Also noticed, probably not the crash: a check found something, but nothing ties it to this problem.', items: f.checkpoint_text.lines } : null;
    const dev = [];
    if (box) dev.push(...box.lines);
    if (f.log_note) dev.push(f.log_note);
    return {
        title: f.issue_title_short || f.issue.title,
        status: { ...n, line: statusLine(n), looked: looked.line, note: f.log_note || null, sandbox_note: ctx.sandboxNote || null, empty: !n.likely && !n.confirmed && !n.check },
        see, cases, checked, developer: dev
    };
}

// ---- renderers. esc: the caller's text escaper (Markdown). ----
function markdown(cf, esc) {
    const L = [], e = esc || (t => String(t));
    L.push('## Status', '', `**${e(cf.status.line)}**`, '', e(cf.status.looked), '');
    if (cf.status.note) L.push(e(cf.status.note), '');
    if (cf.status.sandbox_note) L.push(e(cf.status.sandbox_note), '');
    L.push('## What you see', '', ...cf.see.map(s => `- ${e(s)}`), '');
    for (const c of cf.cases) {
        L.push(`## Case ${c.n}: ${c.heading}`, '');
        for (const [k, v] of c.rows) { if (v.length === 1) L.push(`- ${k}: ${e(v[0])}`); else { L.push(`- ${k}:`); for (const x of v) L.push(`    - ${e(x)}`); } }
        L.push('');
    }
    return L;
}
function cli(cf) {
    const L = [cf.title, '', `STATUS  ${cf.status.line}`, `        ${cf.status.looked}`, ...(cf.status.note ? [`        ${cf.status.note}`] : []), ...(cf.status.sandbox_note ? [`        ${cf.status.sandbox_note}`] : []), '', 'WHAT YOU SEE', ...cf.see.map(s => `  ${s}`)];
    for (const c of cf.cases) {
        L.push('', `CASE ${c.n}  ${c.heading.toUpperCase()}`);
        for (const [k, v] of c.rows) { if (v.length === 1) L.push(`  ${k}: ${v[0]}`); else { L.push(`  ${k}:`); for (const x of v) L.push(`    - ${x}`); } }
    }
    if (cf.checked) L.push('', 'WHAT WAS CHECKED', `  ${cf.checked.line}`, `  ${cf.checked.sentence}`, `  ${cf.checked.legend}`);
    return L.join('\n');
}

module.exports = { build, markdown, cli, statusLine, lookedAt, LIKELY, CHECK, CONFIRMED, SIGNS, EMPTY_STATUS, NOT_CONFIRMED_SENTENCE, MODIFIED_NOTE };
