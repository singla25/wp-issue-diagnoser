// The case-file layout of the gate report (REPORT-SPEC 4, 4.1, 5.1): TITLE, STATUS, WHAT YOU SEE, one block per case, WHAT WAS CHECKED, FOR A DEVELOPER.
// ONE object (findings.json `case_file`) is built here and rendered three ways (the Markdown report, the command-line summary and the page), so the three agree.
// Pure and deterministic. It states facts that were already computed (box, findings, advisories, checkpoints, which steps ran); it assigns no status and decides nothing.
// Wording rules: "Likely cause (not confirmed)" is the one phrase; never "hacked" or "broken because of X"; "Not reproduced on a test copy of your site." replaces "confidence: low"
// (REPORT-SPEC Part 2, owner wording); where something was not looked at, it says so. Text taken from the site (file names, template names, code lines) is data: the renderers escape it.
// Part 2 adds: the cause detail under FOR A DEVELOPER (issue/cause-detail.js), the PHP version in "Looked at", "No likely cause was found for the crash." with unnumbered
// advisory cases, and the "How sure" sentences of a confirmed case derived from what was actually checked.

const plain = require('../lib/plain-names');
const causeDetail = require('./cause-detail');

const LIKELY = 'Likely cause (not confirmed)';
const CHECK = 'Something else to check (probably not the crash)';
const CHECK_NO_CRASH = 'Also noticed';   // the report is not about a crash (facts.crash === false): "probably not the crash" would make no sense
const CONFIRMED = 'Confirmed cause';
const SIGNS = 'Signs that a copy was modified';
const COMPROMISE = 'Possible compromise signs (a pattern match, not proof)';
const EMPTY_STATUS = '0 likely cause · 0 confirmed. This does not mean the site is healthy.';
const NOT_CONFIRMED_SENTENCE = 'Not reproduced on a test copy of your site.';
const NO_CAUSE_NOTE = 'No likely cause was found for the crash.';
const NOT_LIVE_SENTENCE = 'Not checked on the live site.';
const PHP_NOT_STATED = 'PHP: not stated.';
const NUM_WORD = ['zero', 'one', 'two', 'three', 'four', 'five', 'six'];
// "How sure" of a confirmed case: only what the data shows (n = validated independent checks; sandbox = 'yes' | 'no' | null)
function confirmedSentence(n, sandbox) {
    const copy = sandbox === 'yes' ? 'Reproduced on a test copy of your site.' : sandbox === 'no' ? 'A test on a copy of your site did not reproduce it.' : 'Not yet tested on a copy of your site.';
    return `Confirmed by ${NUM_WORD[n] || n} independent checks. ${copy}`;
}
// "How sure" of a cause that is not confirmed
const notConfirmedSentence = sandbox => (sandbox === 'yes' ? 'Reproduced on a test copy of your site, but not confirmed by the re-check of the code.' : NOT_CONFIRMED_SENTENCE);
// Case 3 (owner wording, REPORT-SPEC Part 3): what the signs mean, and the advice only as a condition (the tool cannot know where the copy came from)
const MODIFIED_NOTE = "This copy shows signs of being changed from the vendor's version. It cannot be verified against the vendor.";
const MODIFIED_ADVICE = 'If this copy did not come from the vendor, replace it with a licensed copy from the vendor.';
// no error log on the site (REPORT-SPEC Part 3, leftover L3): what to do to get one; a log that exists but could not be read is said separately (result.js)
const NO_LOG_HELP = ['No error log was found on this site.',
    'To see what is going wrong, turn error logging on. First make a backup with UpdraftPlus. Then, in the file wp-config.php, set WP_DEBUG to true, WP_DEBUG_LOG to true and WP_DEBUG_DISPLAY to false. Load the page that shows the problem once, then run this report again.',
    'This does not mean nothing went wrong.'];
const cap = s => String(s).replace(/^./, c => c.toUpperCase());
const plural = (n, one, many) => (n === 1 ? one : many);
const plural2 = (n, one, many) => (n > 1 ? many : one);   // the status line: "0 likely cause", "1 likely cause", "2 likely causes"
const itemName = c => `the ${c.kind === 'theme' ? 'theme' : c.kind === 'mu' ? 'must-use plugin' : 'plugin'} ${c.name}${c.version ? ` ${c.version}` : ''}`;
const base = f => String(f || '').split('/').pop();

function statusLine(n) {
    const signs = n.signs || 0;   // Case 3: counted only when present, so a line without signs is unchanged
    if (!n.likely && !n.confirmed && !n.check && !signs) return EMPTY_STATUS;
    const parts = [`${n.likely} likely ${plural2(n.likely, 'cause', 'causes')}${n.likely ? ' (not confirmed)' : ''}`];
    parts.push(`${n.check} ${plural2(n.check, 'thing', 'things')} to check`, `${n.confirmed} confirmed`);
    if (signs) parts.push(`${signs} ${plural(signs, 'sign', 'signs')} that a copy was modified`);
    return parts.join(' · ') + (!n.likely && !n.confirmed ? '. This does not mean the site is healthy.' : '');
}

// "12 PHP files were not read: 9 too large, 3 could not be parsed" (real counts and reasons); a reason that is not known is "for other reasons"; without counts the older short sentence
function skippedText(d) {
    if (!d || !(d.total > 0)) return 'some PHP files were not read';
    const parts = [];
    if (d.tooLarge) parts.push(`${d.tooLarge} too large`);
    if (d.unparsed) parts.push(`${d.unparsed} could not be parsed`);
    if (d.other) parts.push(`${d.other} for other reasons`);
    return `${d.total} PHP ${d.total === 1 ? 'file was' : 'files were'} not read: ${parts.join(', ')}`;
}
// what truly ran / did not run -> "Looked at: ... Not looked at: ..."
function lookedAt(facts) {
    const yes = [], no = [];
    (facts.hasLog ? yes : no).push('your log');
    (facts.probeRan ? yes : no).push('the live page');
    if (facts.hasCode) yes.push(facts.phpSkipped ? `the code (${skippedText(facts.phpSkippedDetail)})` : 'the code'); else no.push('the code');
    if (facts.sandboxRan) yes.push('a throwaway test copy'); else no.push(facts.sandboxFailed ? 'a throwaway test copy (it could not run)' : 'a throwaway test copy');
    // the PHP version only as the reporter stated it; the host's PHP (or the sandbox image's) is never claimed as the site's
    if (facts.php) yes.push(`PHP ${facts.php} (${facts.phpSource === 'you confirmed' ? 'you confirmed' : 'you told us'})`);
    return { yes, no, php: facts.php ? null : PHP_NOT_STATED, line: `Looked at: ${yes.length ? yes.join(', ') : 'nothing yet'}. Not looked at: ${no.length ? no.join(', ') : 'nothing'}.` };
}

function evidenceWhere(x) {
    const ev = (x.evidence || []).filter(e => e.file).slice(0, 4).map(e => `${e.file}${e.line ? `, line ${e.line}` : ''}`);
    return ev;
}

// f: the findings object (gate fields already set). ctx: { comps, facts: { hasLog, hasCode, phpSkipped, probeRan, sandboxRan, sandboxFailed, sandboxReproduced, php, crash }, probePages, templates, modified, causeDetail, logHelp }
// modified: issue/modified-signs.js scan() ({ lines, count, files }), or a plain list of sign texts
function build(f, ctx) {
    const box = f.what_is_wrong || null, bc = box && box.case ? box.case : null;
    const boxId = box ? ((f.likely || []).find(x => x.box === box) || (f.findings || []).find(x => x.box === box) || {}).id : null;
    const names = plain.namesOf(ctx.comps || []);
    const named = ref => { const c = (ctx.comps || []).find(k => k.ref === ref || k.slug === ref); return c ? itemName({ kind: c.kind, name: c.name || c.slug, version: c.version }) : plain.plainRef(ref, names); };
    const sent = t => cap(String(t || '').replace(/[.\s]+$/, ''));
    const nonComp = (f.findings || []).filter(x => x.label !== 'compromise');
    // Case 3 data: an eval-of-an-encoded-string match in a third-party theme or plugin file is listed once, under Case 3 (issue/modified-signs.js); the compromise case keeps the rest
    const mod = Array.isArray(ctx.modified) ? { lines: ctx.modified.map(String), count: ctx.modified.length, files: [] } : ctx.modified && ctx.modified.count ? ctx.modified : null;
    const modFiles = new Set((mod && mod.files) || []);
    const inCase3 = x => modFiles.size > 0 && (/obfuscated-exec/.test(String(x.type || '')) || /runs obfuscated code/.test(String(x.title || ''))) && (x.evidence || []).some(e => e.file) && (x.evidence || []).filter(e => e.file).every(e => modFiles.has(e.file));
    const compromise = (f.findings || []).filter(x => x.label === 'compromise' && !inCase3(x));
    const cases = [];
    const noCrash = (ctx.facts || {}).crash === false;
    const checkHeading = noCrash ? CHECK_NO_CRASH : CHECK;
    const sureLive = bc && bc.live ? bc.live : null;
    const facts = ctx.facts || {}, sbx = facts.sandboxReproduced === 'yes' || facts.sandboxReproduced === true ? 'yes' : facts.sandboxReproduced === 'no' || facts.sandboxReproduced === false ? 'no' : null;
    // validated independent checks of a hypothesis: its independent kinds, or the two supports of a fatal re-check rule (validate.js counts those as the two)
    const checksOf = id => { const h = (f.hypotheses || []).find(x => x.id === id) || {}; const fr = h.fatal_recheck; return Math.max((h.independent_kinds || []).length, fr && fr.rule && (fr.supports || []).length === 2 ? 2 : 0); };

    // a confirmed case: the evidence lines, the log entry's date on its own line, and whether the live site was looked at (no page loaded: "Not checked on the live site.")
    const confirmedSure = () => {
        const sure = bc.last_seen ? bc.sure.map(l => l.replace(`, last seen ${bc.last_seen}`, '')) : bc.sure;
        return [...sure, ...(sureLive ? [sureLive] : []), ...(bc.last_seen ? [`Last seen in your log on ${bc.last_seen}.`] : []), ...(facts.probeRan ? [] : [NOT_LIVE_SENTENCE])];
    };
    const addBox = () => {
        const likely = box.tier === 'likely';
        const nChecks = checksOf(boxId);
        const rows = [];
        const comps = (bc.comps || []).map(c => itemName({ kind: c.kind, name: c.name, version: c.version }));
        if (comps.length) rows.push(['Components', [comps.join(' and ')]]);
        rows.push(['Where', [`${bc.where.who}: ${bc.where.file}, line ${bc.where.line}`]]);
        rows.push(['Why', bc.why]);
        if (likely) rows.push(['How sure', [...bc.sure, ...(sureLive ? [sureLive] : []), notConfirmedSentence(sbx)]]);
        else if (nChecks >= 2) rows.push(['How sure', [confirmedSentence(nChecks, sbx), ...confirmedSure()]]);
        else rows.push(['How sure', [...confirmedSure(), 'Marked as confirmed; the details for a developer show what it rests on.']]);
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
        if (kind === 'confirmed' && checksOf(x.id) >= 2) sure.push(confirmedSentence(checksOf(x.id), sbx));
        if (x.status) sure.push(`${plain.statusWord(x.status)}.`);
        if (x.shown_because) sure.push(`Shown because: ${x.shown_because}.`);
        for (const b of x.breaking_because || []) sure.push(`Seen: ${b.reason}`);
        if (kind === 'likely') sure.push(notConfirmedSentence(sbx));
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
            rows.push(['What can break', ['Pages built from these templates (for example cart, checkout or layout) can look or behave wrongly after an update.' + (noCrash ? '' : ' This is probably not what stops the page from loading.')]]);
            rows.push(['How sure', ['Read from the files of the copy. Not confirmed as a cause of the problem.']]);
            rows.push(['What to do', ['Ask the theme author for an update, or compare each copy with the plugin\'s own file on a copy of the site.']]);
            cases.push({ kind: 'check', heading: checkHeading, rows, advisory: true });
        } else {
            const rows = [];
            const comps = (a.components || []).map(named);
            if (comps.length) rows.push(['Components', [comps.join(' and ')]]);
            const wh = evidenceWhere(a);
            if (wh.length) rows.push(['Where', wh]);
            rows.push(['What', [sent(a.cause) + (a.merged > 1 ? ` (${a.merged} times)` : '') + '.']]);
            rows.push(['How sure', [a.why_not_shown && a.why_not_shown.primary !== 'not-established' ? `It is ${a.why_not_shown.text}.` : 'Not confirmed.', ...(a.backed_by_log || []).map(b => `A log error names ${b.file}.`)]]);
            cases.push({ kind: 'check', heading: checkHeading, rows, advisory: true });
        }
    }
    // signs that a copy was modified (issue/modified-signs.js): the file and the sign, the "cannot be verified" sentence, and the advice as a condition
    if (mod) cases.push({ kind: 'signs', heading: SIGNS, rows: [['Signs', mod.lines], ['How sure', [MODIFIED_NOTE]], ['What to do', [MODIFIED_ADVICE]]] });
    const n = { likely: cases.filter(c => c.kind === 'likely').length, confirmed: cases.filter(c => c.kind === 'confirmed').length, check: cases.filter(c => c.kind === 'check').length, ...(mod ? { signs: mod.count } : {}) };
    // a crash with no likely and no confirmed cause: say so, and an advisory ("something else to check") carries no Case number, so Case 1 is never an advisory
    const noCause = !!facts.crash && !n.likely && !n.confirmed && cases.some(c => c.advisory);
    let k = 0;
    for (const c of cases) { c.n = noCause && c.advisory ? null : ++k; delete c.advisory; }
    const looked = lookedAt(facts);
    // what the reader sees: only what is known
    const see = [];
    const images = (f.reported && f.reported.images) || [];
    if (images.length) see.push(`${images.length} ${plural(images.length, 'screenshot', 'screenshots')} from you: ${images.map(i => i.name).join(', ')}.`);
    const five = (ctx.probePages || []).find(p => p && p.status >= 500 && p.status < 600);
    if (five) see.push(`The live page answered HTTP ${five.status}.`);
    else if (ctx.facts && ctx.facts.probeRan) see.push('The live pages that were loaded did not answer with an error.');
    else see.push('No live check was run, so nothing was seen on the live page.');
    const cp = f.checkpoints ? f.checkpoints.counts : null;
    // the counts are ONE dot line (the old "We looked at N things" sentence is gone); the full list only with --verbose
    const checked = cp ? { line: `${cp.pass} pass · ${cp.fail} fail · ${cp.not_checked} not checked · ${cp.also_noticed || 0} also noticed`,
        legend: noCrash ? 'Also noticed: a check found something, but nothing ties it to this problem.' : 'Also noticed, probably not the crash: a check found something, but nothing ties it to this problem.', items: f.checkpoint_text.lines,
        ...((ctx.vendorLines || []).length ? { notes: ctx.vendorLines.slice() } : {}) } : null;
    // FOR A DEVELOPER: the cause detail (issue/cause-detail.js) instead of the lines Case 1 already shows; the versions line and the large-log note stay
    const dev = [];
    const cd = ctx.causeDetail || null;
    if (box && cd) dev.push(...cd.lines, ...box.lines.filter(l => /^Versions: /.test(l)));
    else if (box) dev.push(...box.lines);
    if (f.log_note) dev.push(f.log_note);
    return {
        title: f.issue_title_short || f.issue.title,
        status: { ...n, line: statusLine(n), looked: looked.line, php: looked.php, note: f.log_note || null, sandbox_note: ctx.sandboxNote || null, ...(ctx.logHelp && ctx.logHelp.length ? { log_help: ctx.logHelp.slice() } : {}), empty: !n.likely && !n.confirmed && !n.check && !n.signs },
        see, no_cause_note: noCause ? NO_CAUSE_NOTE : null, cases, checked, developer: dev,
        excerpt: box && cd && cd.excerpt && cd.excerpt.available ? { title: `${cd.excerpt.file}, lines ${cd.excerpt.from} to ${cd.excerpt.to} (line ${cd.excerpt.cited} is marked with >)`, lines: causeDetail.excerptLines(cd.excerpt) } : null
    };
}

// ---- renderers. esc: the caller's text escaper (Markdown). ----
function markdown(cf, esc) {
    const L = [], e = esc || (t => String(t));
    L.push('## Status', '', `**${e(cf.status.line)}**`, '', e(cf.status.looked), '');
    if (cf.status.php) L.push(e(cf.status.php), '');
    if (cf.status.note) L.push(e(cf.status.note), '');
    if (cf.status.sandbox_note) L.push(e(cf.status.sandbox_note), '');
    if (cf.status.log_help) cf.status.log_help.forEach((t, i) => L.push(i ? e(t) : `**${e(t)}**`, ''));
    L.push('## What you see', '', ...cf.see.map(s => `- ${e(s)}`), '');
    if (cf.no_cause_note) L.push(`**${e(cf.no_cause_note)}**`, '');
    for (const c of cf.cases) {
        L.push(c.n ? `## Case ${c.n}: ${c.heading}` : `## ${c.heading}`, '');
        for (const [k, v] of c.rows) { if (v.length === 1) L.push(`- ${k}: ${e(v[0])}`); else { L.push(`- ${k}:`); for (const x of v) L.push(`    - ${e(x)}`); } }
        L.push('');
    }
    return L;
}
// the developer block in Markdown: the plain lines, then the code excerpt as a fenced block (site text is data: no fence can be closed from inside)
function markdownDeveloper(cf, esc) {
    const L = [], e = esc || (t => String(t));
    if (!cf.developer.length) return L;
    L.push('## For a developer', '', ...cf.developer.map(l => `- ${e(l)}`), '');
    if (cf.excerpt) L.push(e(cf.excerpt.title), '', '```php', ...cf.excerpt.lines.map(l => l.replace(/`/g, "'")), '```', '');
    return L;
}
function cli(cf) {
    const L = [cf.title, '', `STATUS  ${cf.status.line}`, `        ${cf.status.looked}`, ...(cf.status.php ? [`        ${cf.status.php}`] : []), ...(cf.status.note ? [`        ${cf.status.note}`] : []), ...(cf.status.sandbox_note ? [`        ${cf.status.sandbox_note}`] : []), ...(cf.status.log_help ? cf.status.log_help.map(t => `        ${t}`) : []), '', 'WHAT YOU SEE', ...cf.see.map(s => `  ${s}`)];
    if (cf.no_cause_note) L.push('', cf.no_cause_note);
    for (const c of cf.cases) {
        L.push('', c.n ? `CASE ${c.n}  ${c.heading.toUpperCase()}` : c.heading.toUpperCase());
        for (const [k, v] of c.rows) { if (v.length === 1) L.push(`  ${k}: ${v[0]}`); else { L.push(`  ${k}:`); for (const x of v) L.push(`    - ${x}`); } }
    }
    if (cf.checked) L.push('', 'WHAT WAS CHECKED', `  ${cf.checked.line}`, `  ${cf.checked.legend}`, ...(cf.checked.notes || []).map(n => `  ${n}`));
    if (cf.developer && cf.developer.length) {
        L.push('', 'FOR A DEVELOPER', ...cf.developer.map(l => `  ${l}`));
        if (cf.excerpt) L.push(`  ${cf.excerpt.title}`, ...cf.excerpt.lines.map(l => `    ${l}`));
    }
    return L.join('\n');
}

module.exports = { build, markdown, markdownDeveloper, cli, statusLine, lookedAt, skippedText, confirmedSentence, LIKELY, CHECK, CHECK_NO_CRASH, CONFIRMED, SIGNS, EMPTY_STATUS, NOT_CONFIRMED_SENTENCE, NO_CAUSE_NOTE, NOT_LIVE_SENTENCE, PHP_NOT_STATED, MODIFIED_NOTE, MODIFIED_ADVICE, NO_LOG_HELP };
