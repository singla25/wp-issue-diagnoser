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
// a probed live page answered 4xx: the address the user typed may be wrong (owner wording). The real status code in the sentence, a short plain description for common codes.
const STATUS_WORDS = { 400: 'bad request', 401: 'login required', 403: 'access refused', 404: 'page not found', 405: 'method not allowed', 408: 'request timed out', 410: 'page removed', 429: 'too many requests', 451: 'blocked for legal reasons' };
const PROTECT_CODES = new Set([401, 403, 429]);
function addressSentence(status) {
    const st = Number(status);
    const code = Number.isInteger(st) && st >= 400 && st < 500 ? String(st) : '4xx';
    // 401, 403, 429 (owner): the site may be protecting itself, so the address could be right; no "check the address" claim.
    // 429: the probe stops at the FIRST 429 (probe/config.js stopAfter429 is fixed at 1; probe/safety.js trips the breaker, no retry), so "stopped at once" is a fact.
    if (st === 429) return 'Your address answered HTTP 429 (too many requests). The site may be protecting itself, so the address could be right. Wait a while, then run again; the check stopped at once and nothing else was requested.';
    if (PROTECT_CODES.has(st)) return `Your address answered HTTP ${code} (${STATUS_WORDS[st]}). The site may be protecting itself, so the address could be right. Wait a while, then run again; the check only looked at a few public pages.`;
    return `Your address answered HTTP ${code} (${STATUS_WORDS[st] || 'an error'}), so it may not be the address of your site. Check the address and run again.`;
}
const is4 = p => !!p && Number(p.status) >= 400 && Number(p.status) < 500;
const is5 = p => !!p && Number(p.status) >= 500 && Number(p.status) < 600;
// a page address -> origin + path without trailing slashes + query (no fragment); null when it is not a usable address
const addrKey = u => { try { const x = new URL(String(u)); return `${x.origin}${x.pathname.replace(/\/+$/, '')}${x.search}`; } catch { return null; } };
// THE ADDRESS PAGE (owner): the probed page for the address the reporter gave. With the issue's address known: the first probed page whose address
// (origin, path without trailing slash, query) is that address; none probed -> null. Without it (older callers): the first probed page, which
// issue/probe.js plans from the address itself when no other page was named.
function addressPageOf(pages, issueUrl) {
    const list = (pages || []).filter(p => p && p.url);
    if (!issueUrl) return list[0] || null;
    const k = addrKey(issueUrl);
    return k ? list.find(p => addrKey(p.url) === k) || null : null;
}
const pathText = u => { try { return (new URL(String(u)).pathname.replace(/\/+$/, '') || '/').slice(0, 300); } catch { return '/'; } };
const pageSentence = p => `The page ${pathText(p.url)} answered HTTP ${Number(p.status)} (${STATUS_WORDS[Number(p.status)] || 'an error'}).`;
// What the probed pages answered, in sentences: { five, address (the address page answered 4xx), others (other 4xx pages, at most 5, no advice), lines, any }
function liveAnswers(pages, issueUrl) {
    const five = (pages || []).find(is5) || null;
    const ap = addressPageOf(pages, issueUrl);
    const address = is4(ap) ? addressSentence(ap.status) : null;
    const seen = new Set(), others = [];
    for (const p of pages || []) {
        if (!is4(p) || (address && p === ap) || (address && ap && addrKey(p.url) === addrKey(ap.url))) continue;
        const t = pageSentence(p);
        if (!seen.has(t) && others.length < 5) { seen.add(t); others.push(t); }
    }
    const lines = [...(five ? [`The live page answered HTTP ${five.status}.`] : []), ...(address ? [address] : []), ...others];
    return { five, address, addressPage: ap, others, lines, any: lines.length > 0 };
}
const NUM_WORD = ['zero', 'one', 'two', 'three', 'four', 'five', 'six'];
// "How sure" of a confirmed case: only what the data shows (n = validated independent checks; sandbox = 'yes' | 'no' | null)
// 6d-2: a test copy from a database file that did not count (fidelity did-not-match / could-not-test / not-tested): no copy sentence at all, because
// the fidelity sentence of the report already says what happened (never "Not yet tested on a copy" next to it). Without a test copy: unchanged.
function confirmedSentence(n, sandbox, fidelity = null) {
    if (fidelity && fidelity.level && !fidelity.counts) return `Confirmed by ${NUM_WORD[n] || n} independent checks.`;
    const copy = sandbox === 'yes' ? 'Reproduced on a test copy of your site.' : sandbox === 'no' ? 'A test on a copy of your site did not reproduce it.' : 'Not yet tested on a copy of your site.';
    return `Confirmed by ${NUM_WORD[n] || n} independent checks. ${copy}`;
}
// 6d-2: the checks that ACTUALLY counted, named. Only the deterministic kinds the validator kept (independent_kinds); the test copy is named only
// when its fidelity check passed (matched or status-only) AND the bisection on it counted for this hypothesis (the 'bisect' kind). Otherwise null.
const KIND_WORDS = { log: 'your log', probe: 'the live page', observation: 'the code', collision: 'the code', bisect: 'a test on a copy of your site' };
function countedChecks(kinds, fidelity) {
    const k = Array.isArray(kinds) ? kinds : [];
    if (!fidelity || !fidelity.counts || !k.includes('bisect')) return null;
    const list = [...new Set(['log', 'probe', 'observation', 'collision', 'bisect'].filter(x => k.includes(x)).map(x => KIND_WORDS[x]))];
    return list.length >= 2 ? list : null;
}
const listWords = l => (l.length <= 1 ? l.join('') : `${l.slice(0, -1).join(', ')}, and ${l[l.length - 1]}`);
const countedSentence = list => `Confirmed by ${NUM_WORD[list.length] || list.length} independent checks: ${listWords(list)}.`;
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
// copyBuilt: a test copy WAS built (sandbox.json replica.copy_built): it is never "Not looked at", even when its result is not used
function lookedAt(facts, { box = false, copyBuilt = false } = {}) {
    const yes = [], no = [];
    (facts.hasLog ? yes : no).push('your log');
    (facts.probeRan ? yes : no).push('the live page');
    if (facts.hasCode) yes.push(facts.phpSkipped ? `the code (${skippedText(facts.phpSkippedDetail)})` : 'the code'); else no.push('the code');
    if (facts.sandboxRan) yes.push('a throwaway test copy'); else if (copyBuilt) yes.push('a throwaway test copy (it was built)'); else no.push(facts.sandboxFailed ? 'a throwaway test copy (it could not run)' : 'a throwaway test copy');
    // the PHP version only as the reporter stated it; the host's PHP (or the sandbox image's) is never claimed as the site's
    if (facts.php) yes.push(`PHP ${facts.php} (${facts.phpSource === 'you confirmed' ? 'you confirmed' : 'you told us'})`);
    // 6d-3: where the "How close the copy is" box is shown, an empty "Not looked at" is left out (never "Not looked at: nothing")
    const notLine = no.length ? ` Not looked at: ${no.join(', ')}.` : box ? '' : ' Not looked at: nothing.';
    return { yes, no, php: facts.php ? null : PHP_NOT_STATED, line: `Looked at: ${yes.length ? yes.join(', ') : 'nothing yet'}.${notLine}` };
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
    // the live line(s) of the box: one sentence, or several (a 5xx and a 4xx are both said)
    const liveRows = l => (Array.isArray(l) ? l.filter(x => typeof x === 'string') : l ? [l] : []);
    const facts = ctx.facts || {}, sbx = facts.sandboxReproduced === 'yes' || facts.sandboxReproduced === true ? 'yes' : facts.sandboxReproduced === 'no' || facts.sandboxReproduced === false ? 'no' : null;
    // validated independent checks of a hypothesis: its independent kinds, or the two supports of a fatal re-check rule (validate.js counts those as the two)
    const checksOf = id => { const h = (f.hypotheses || []).find(x => x.id === id) || {}; const fr = h.fatal_recheck; return Math.max((h.independent_kinds || []).length, fr && fr.rule && (fr.supports || []).length === 2 ? 2 : 0); };
    // the confirmed sentence: the named list when the test copy counted (6d-2), else the sentence as before
    const sureOf = id => { const counted = countedChecks(((f.hypotheses || []).find(x => x.id === id) || {}).independent_kinds, ctx.fidelity || null); return counted ? countedSentence(counted) : confirmedSentence(checksOf(id), sbx, ctx.fidelity || null); };

    // a confirmed case: the evidence lines, the log entry's date on its own line, and whether the live site was looked at (no page loaded: "Not checked on the live site.")
    const confirmedSure = () => {
        const sure = bc.last_seen ? bc.sure.map(l => l.replace(`, last seen ${bc.last_seen}`, '')) : bc.sure;
        return [...sure, ...liveRows(sureLive), ...(bc.last_seen ? [`Last seen in your log on ${bc.last_seen}.`] : []), ...(facts.probeRan ? [] : [NOT_LIVE_SENTENCE])];
    };
    const addBox = () => {
        const likely = box.tier === 'likely';
        const nChecks = checksOf(boxId);
        const rows = [];
        const comps = (bc.comps || []).map(c => itemName({ kind: c.kind, name: c.name, version: c.version }));
        if (comps.length) rows.push(['Components', [comps.join(' and ')]]);
        rows.push(['Where', [`${bc.where.who}: ${bc.where.file}, line ${bc.where.line}`]]);
        rows.push(['Why', bc.why]);
        if (likely) rows.push(['How sure', [...bc.sure, ...liveRows(sureLive), notConfirmedSentence(sbx)]]);
        else if (nChecks >= 2) rows.push(['How sure', [sureOf(boxId), ...confirmedSure()]]);
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
        if (kind === 'confirmed' && checksOf(x.id) >= 2) sure.push(sureOf(x.id));
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
    // 6d-3: the report level (TEST-COPY-SPEC 8) and the "How close the copy is" box (section 7)
    const fdc = ctx.fidelity ? require('./fidelity').clean(ctx.fidelity) : null;
    const level = copyLevel(fdc, ctx.replica || null, facts);
    const close = ctx.replica && ctx.replica.copy_built && fdc ? closeness({ versions: ctx.versions, activePlugins: ctx.activePlugins, fidelity: fdc }) : null;
    const looked = lookedAt(facts, { box: !!close, copyBuilt: !!(ctx.replica && ctx.replica.copy_built) });
    // a probed live page answered 4xx: said plainly in the STATUS area and under "What you see"; never "did not answer with an error"
    const answers = liveAnswers(ctx.probePages, ctx.issueUrl || null);
    const address = answers.address;
    // what the reader sees: only what is known
    const see = [];
    const images = (f.reported && f.reported.images) || [];
    if (images.length) see.push(`${images.length} ${plural(images.length, 'screenshot', 'screenshots')} from you: ${images.map(i => i.name).join(', ')}.`);
    // every error answer is said (5xx, the address page's 4xx with its advice, other 4xx pages without advice); never "did not answer with an error" then
    if (answers.any) see.push(...answers.lines);
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
    // Part 6b: the 'Versions' block (issue/version-match.js), only when a test copy was built: each version with its source and how close the copy is
    const vers = versionLines(ctx.versions);
    if (vers.length) dev.push(...vers);
    // 6c-2: the user data of the test copy (dummy users, counts per table, tables that could not be checked), only when one was built from a database file
    dev.push(...userDataLines(ctx.userData));
    // 6d-1: active plugins of the real site whose files are not in the copy (the list itself is in findings.json sandbox.summary.active_plugins)
    dev.push(...activePluginLines(ctx.activePlugins));
    return {
        title: f.issue_title_short || f.issue.title,
        status: { ...n, line: statusLine(n), looked: looked.line, php: looked.php, note: f.log_note || null, sandbox_note: ctx.sandboxNote || null, ...(ctx.logHelp && ctx.logHelp.length ? { log_help: ctx.logHelp.slice() } : {}), ...(ctx.copyLogLines && ctx.copyLogLines.length ? { copy_log: ctx.copyLogLines.slice() } : {}), ...((ctx.cautions || []).length || address ? { cautions: [...(address ? [address] : []), ...(ctx.cautions || [])] } : {}), ...fidelityPart(ctx.fidelity, answers), empty: !n.likely && !n.confirmed && !n.check && !n.signs },
        level, ...(close ? { close } : {}),
        see, no_cause_note: noCause ? NO_CAUSE_NOTE : null, cases, checked, developer: dev,
        excerpt: box && cd && cd.excerpt && cd.excerpt.available ? { title: `${cd.excerpt.file}, lines ${cd.excerpt.from} to ${cd.excerpt.to} (line ${cd.excerpt.cited} is marked with >)`, lines: causeDetail.excerptLines(cd.excerpt) } : null
    };
}

// ---- 6d-3: the report level (TEST-COPY-SPEC 8; owner headings) ----
//   1 Tested on a copy of your site          the fidelity check matched (or status-only, with its weaker sentence) against a failing page of your site
//   2 Not tested on a copy                   a database file, Docker or the code is missing, or your site had no failing page to compare: with that list
//   3 The test copy could not confirm this   the copy could not run, or did not show the same problem (the existing owner sentences say which)
// Wording only: no status and no verdict changes with the level.
const LEVEL_HEADING = { 1: 'Tested on a copy of your site', 2: 'Not tested on a copy', 3: 'The test copy could not confirm this' };
const MISSING_TEXT = { database: 'a database export file of your site (.sql or .sql.gz)', docker: 'Docker on this computer, to build the test copy', code: 'the code of your site (its wp-content folder)', page: 'a page that fails on your site, to compare with the test copy', live: 'a copy built from your database is never made for a live site (try it on a local or staging copy of the site)' };
const MISSING_INTRO = 'What a test on a copy of your site needs, and was missing:';
const NOT_TESTED_LABEL = 'NOT TESTED: what this report says comes from reading your log and the code. It was not tried on a copy of your site.';
// a copy WAS built and logged the reported error, but your site had no failing page to compare (level 2): not "not tried on a copy"
const NOT_CONFIRMED_LABEL = 'NOT CONFIRMED: a test copy of your site was built and logged the reported error, but your site had no failing page to compare with, so the copy does not confirm this report. What this report says comes from reading your log and the code.';
const MATCHED_LINE = 'A test copy of your site, built from your database, showed the same problem as your site: the same page, the same kind of failure and the same error.';
const NO_PAGE_REASON = 'no failing page and no error message from your site to compare';
// fd: issue/fidelity.js clean() or null; rp: sandbox.json `replica` ({ requested, database_file, docker }) plus copy_built, or null (older runs)
function copyLevel(fd, rp, facts = {}) {
    const r = rp || {};
    const two = keys => ({ n: 2, heading: LEVEL_HEADING[2], missing: [...new Set(keys)].map(k => MISSING_TEXT[k]), lines: [NOT_TESTED_LABEL] });
    // a database file given for a LIVE site was dropped (sandbox.json replica.db_dropped_live): it is not "missing", it is never used for live
    const inputsMissing = () => [...(r.db_dropped_live ? ['live'] : r.database_file ? [] : ['database']), ...(r.docker === false ? ['docker'] : []), ...(facts.hasCode === false ? ['code'] : [])];
    if (fd && fd.counts) return fd.real_page === false ? { ...two(['page']), lines: [NOT_CONFIRMED_LABEL] } : { n: 1, heading: LEVEL_HEADING[1], missing: [], lines: fd.level === 'matched' ? [MATCHED_LINE] : [] };
    if (fd && fd.level === 'did-not-match') return { n: 3, heading: LEVEL_HEADING[3], missing: [], lines: [] };
    if (fd && fd.level === 'could-not-test') return r.docker === false ? two(['docker', ...inputsMissing()]) : { n: 3, heading: LEVEL_HEADING[3], missing: [], lines: [] };
    if (fd && fd.level === 'not-tested') {
        if (facts.hasCode === false || (fd.reasons || []).includes('the test copy was not built')) return two(['code']);
        if ((fd.reasons || []).some(x => x === NO_PAGE_REASON)) return two(['page']);
        return { n: 3, heading: LEVEL_HEADING[3], missing: [], lines: [] };
    }
    return two(inputsMissing());
}

// ---- 6d-3: "How close the copy is" (TEST-COPY-SPEC 7; owner title and sub-lines). Built only from data that exists; unknown is "Not known". ----
const CLOSE_TITLE = 'How close the copy is';
const NO_PAGE_MATCH = 'The copy logs the reported error, but your site had no failing page to compare with, so the match is not confirmed.';
const CLOSE_GROUPS = [['matched', 'Matched'], ['did_not_match', 'Did not match'], ['not_known', 'Not known'], ['not_covered', 'Not covered in this version']];
const NOT_COVERED = ['Calls to outside services (outbound traffic from the test copy is blocked)', 'The web server layer (Apache or Nginx rules, CDN, caching)', 'File permissions', 'PHP extensions of the real server', 'Cron jobs', 'The uploads folder, unless it was included'];
const V_GROUP = { matched: 'matched', nearest: 'did_not_match', 'not matched': 'did_not_match', assumed: 'not_known', unknown: 'not_known' };
function closeness({ versions, activePlugins, fidelity } = {}) {
    const out = { title: CLOSE_TITLE, matched: [], did_not_match: [], not_known: [], not_covered: NOT_COVERED.slice() };
    const v = versions && versions.schema === 1 ? versions : null;
    for (const [k, word] of [['php', 'PHP'], ['db', 'Database'], ['wordpress', 'WordPress']]) {
        const x = v && v[k];
        if (x && V_GROUP[x.status] && typeof x.text === 'string') out[V_GROUP[x.status]].push(`${word}: ${x.text.slice(0, 300)}`);
        else out.not_known.push(`${word} version: not known`);
    }
    const a = activePlugins || null;
    if (!a || a.source === 'unknown' || !Number.isInteger(a.active_count)) out.not_known.push('Active plugins: not known (no list from your database or from Site Health)');
    else {
        const miss = (a.missing_files || []).length;
        if (miss) out.did_not_match.push(`Active plugins: ${a.active_count} (${a.source}), ${miss} of them with no files in the copy`);
        else out.matched.push(`Active plugins: ${a.active_count} (${a.source}), all of them in the copy`);
    }
    const fd = fidelity, rf = fd && fd.real_fatal, cf = fd && fd.copy_fatal;
    const name = f => `${f.kind} ${f.name}${f.file ? ` in ${f.file}` : ''}`;
    // your site had no failing page to compare (level 2): the copy logging the reported error is NOT a confirmed match
    if (fd && fd.counts && fd.real_page === false) out.not_known.push(NO_PAGE_MATCH);
    else if (fd && fd.level === 'matched' && rf) out.matched.push(`The same error as on your site: ${name(rf)}`);
    else if (fd && fd.level === 'did-not-match' && rf) out.did_not_match.push(`The same error: your site shows ${name(rf)}; ${cf ? `the test copy shows it in ${cf.file || 'another file'}` : 'the test copy did not show it'}`);
    else if (fd && fd.level === 'did-not-match') out.did_not_match.push(`The same problem: ${(fd.reasons || [])[0] || 'the test copy did not show it'}`);
    else out.not_known.push(rf ? 'The same error: not known (the test copy could not be compared)' : 'The same error: not known (no error message from your site to compare)');
    return out;
}

// 6d-2: the fidelity check of the test copy in the reader's words (issue/fidelity.js readerText): { line, reasons }, only when there is something to say
// The page used for the comparison is THE ADDRESS PAGE and it answered 4xx: its sentence (wrong address, or protection) is the one likely reason and the
// generic list is dropped. A 4xx on any other page does not change the list. answers: liveAnswers() of the case file.
function fidelityPart(fd, answers = null) {
    const fid = fd ? require('./fidelity') : null;
    const t = fd ? fid.readerText(fd) : null;
    if (!t) return {};
    const c = fid.clean(fd);
    if (c && c.status_class === '4xx' && answers && answers.address && c.page && fid.pathOf(answers.addressPage.url) === c.page) return { fidelity: { line: t.line, reasons: [answers.address] } };
    return { fidelity: { line: t.line, reasons: t.reasons.slice() } };
}

// the cleaned user-data object (issue/result.js cleanUserData) -> the lines of the developer block. Numbers and fixed words only.
const OTHER_TABLES_NOTE = 'Email addresses and IP addresses in other tables (form entries, order notes, plugin settings) are not hidden in this version.';
function userDataLines(u) {
    if (!u || u.users !== 'dummy' || !Number.isInteger(u.unchecked_tables)) return [];
    const counts = Object.entries(u.removal_counts || {}).filter(([k, v]) => /^[A-Za-z0-9_]{1,64}$/.test(k) && (v === null || Number.isInteger(v))).map(([k, v]) => `${k} ${v === null ? 'not counted' : v}`);
    return [
        `Test copy users: dummy users only, your real users were not copied; ${u.dummy_admin ? 'one dummy administrator (pgadmin) with a test password that was shown once and not saved' : 'no dummy administrator'}.`,
        `Test copy, rewritten or removed: ${counts.length ? counts.join(', ') : 'nothing'}.`,
        `${u.unchecked_tables} tables could not be checked and are copied as they are.`,
        OTHER_TABLES_NOTE
    ];
}

// the cleaned active-plugins object (issue/result.js cleanActivePlugins) -> the one fixed sentence, only when an active plugin has no file in the copy
// After the sentence, the missing plugins by FOLDER name (plugin file names are not personal data): at most MISSING_SHOWN, then "and N more".
// Database source: the folder of "slug/file.php" (or the single file name); Site Health source: the plugin name as Site Health shows it.
const MISSING_SHOWN = 20;
function activePluginLines(a) {
    if (!a || !Array.isArray(a.missing_files) || !a.missing_files.length) return [];
    const vm = require('./version-match');
    const names = [...new Set(a.missing_files.filter(s => typeof s === 'string' && s).map(s => (a.source === 'from the database' ? (s.includes('/') ? s.split('/')[0] : s) : s)))];
    const more = names.length - MISSING_SHOWN;
    return [vm.MISSING_FILES_NOTE, `Active plugins with no files in the copy: ${names.slice(0, MISSING_SHOWN).join(', ')}${more > 0 ? ` and ${more} more` : ''}.`];
}

// versions.json -> the lines of the 'Versions' block. The texts are rebuilt from the checked fields only (status from the closed list, versions by pattern).
const V_STATUS = ['matched', 'nearest', 'assumed', 'not matched', 'unknown'];
function versionLines(v) {
    if (!v || v.schema !== 1 || !v.php || !v.db || !v.wordpress) return [];
    const ok = x => x && V_STATUS.includes(x.status) && typeof x.text === 'string';
    if (![v.php, v.db, v.wordpress].every(ok)) return [];
    const L = [`Versions of the test copy: ${v.php.text.slice(0, 300)}`, `Versions of the test copy: ${v.db.text.slice(0, 300)}`, `Versions of the test copy: ${v.wordpress.text.slice(0, 300)}`];
    for (const t of Array.isArray(v.todos) ? v.todos.slice(0, 4) : []) if (typeof t === 'string' && /^(PHP \d{1,2}\.\d{1,2}|MySQL|MariaDB): (no image tag is chosen yet|there is no image for it)/.test(t)) L.push(`Versions of the test copy: ${t.slice(0, 300)}`);
    if (Array.isArray(v.commands) && v.commands.length) L.push(`Versions of the test copy: to test with the same versions, the images can be fetched once: ${v.commands.filter(c => /^npm run guard:setup-sandbox -- [a-z0-9 .&:-]+$/i.test(c)).join('  ;  ')}`);
    return L;
}

// the "How close the copy is" box as plain lines: the title, then each sub-line that has something, in the fixed order
function closeLines(close) {
    if (!close) return [];
    const L = [close.title];
    for (const [k, word] of CLOSE_GROUPS) if ((close[k] || []).length) { L.push(`${word}:`); for (const x of close[k]) L.push(`  - ${x}`); }
    return L;
}

// ---- renderers. esc: the caller's text escaper (Markdown). ----
function markdown(cf, esc) {
    const L = [], e = esc || (t => String(t));
    L.push('## Status', '', `**${e(cf.status.line)}**`, '', e(cf.status.looked), '');
    if (cf.status.php) L.push(e(cf.status.php), '');
    if (cf.status.note) L.push(e(cf.status.note), '');
    if (cf.status.sandbox_note) L.push(e(cf.status.sandbox_note), '');
    for (const c of cf.status.cautions || []) L.push(e(c), '');
    if (!cf.level && cf.status.fidelity) { L.push(e(cf.status.fidelity.line), ''); if (cf.status.fidelity.reasons.length) L.push('Likely reasons:', '', ...cf.status.fidelity.reasons.map(r => `- ${e(r)}`), ''); }
    if (cf.status.log_help) cf.status.log_help.forEach((t, i) => L.push(i ? e(t) : `**${e(t)}**`, ''));
    for (const t of cf.status.copy_log || []) L.push(e(t), '');
    // 6d-3: the level heading, the fidelity sentence under it, what is missing, and the "How close the copy is" box
    if (cf.level) {
        L.push(`## ${cf.level.heading}`, '');
        if (cf.status.fidelity) { L.push(e(cf.status.fidelity.line), ''); if (cf.status.fidelity.reasons.length) L.push('Likely reasons:', '', ...cf.status.fidelity.reasons.map(r => `- ${e(r)}`), ''); }
        if (cf.level.missing.length) L.push(MISSING_INTRO, '', ...cf.level.missing.map(m => `- ${e(m)}`), '');
        for (const t of cf.level.lines) L.push(t === NOT_TESTED_LABEL || t === NOT_CONFIRMED_LABEL ? `**${e(t)}**` : e(t), '');
        if (cf.close) {
            L.push(`### ${cf.close.title}`, '');
            for (const [k, word] of CLOSE_GROUPS) if ((cf.close[k] || []).length) { L.push(`- ${word}:`); for (const x of cf.close[k]) L.push(`    - ${e(x)}`); }
            L.push('');
        }
    }
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
    const fid = cf.status.fidelity ? [`        ${cf.status.fidelity.line}`, ...(cf.status.fidelity.reasons.length ? ['        Likely reasons:', ...cf.status.fidelity.reasons.map(r => `          - ${r}`)] : [])] : [];
    // 6d-3: the level heading with the fidelity sentence, what is missing and the box (without a level, as before)
    const lev = cf.level ? ['', cf.level.heading.toUpperCase(), ...fid, ...(cf.level.missing.length ? [`        ${MISSING_INTRO}`, ...cf.level.missing.map(m => `          - ${m}`)] : []), ...cf.level.lines.map(t => `        ${t}`), ...closeLines(cf.close).map(t => `        ${t}`)] : [];
    const L = [cf.title, '', `STATUS  ${cf.status.line}`, `        ${cf.status.looked}`, ...(cf.status.php ? [`        ${cf.status.php}`] : []), ...(cf.status.note ? [`        ${cf.status.note}`] : []), ...(cf.status.sandbox_note ? [`        ${cf.status.sandbox_note}`] : []), ...(cf.status.cautions || []).map(t => `        ${t}`), ...(cf.level ? [] : fid), ...(cf.status.log_help ? cf.status.log_help.map(t => `        ${t}`) : []), ...(cf.status.copy_log || []).map(t => `        ${t}`), ...lev, '', 'WHAT YOU SEE', ...cf.see.map(s => `  ${s}`)];
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

module.exports = { addressSentence, STATUS_WORDS, PROTECT_CODES, addressPageOf, liveAnswers, pageSentence, NOT_CONFIRMED_LABEL, NO_PAGE_MATCH, copyLevel, closeness, closeLines, LEVEL_HEADING, MISSING_TEXT, MISSING_INTRO, NOT_TESTED_LABEL, MATCHED_LINE, CLOSE_TITLE, CLOSE_GROUPS, NOT_COVERED, countedChecks, countedSentence, fidelityPart, MISSING_SHOWN, userDataLines, activePluginLines, versionLines, build, markdown, markdownDeveloper, cli, statusLine, lookedAt, skippedText, confirmedSentence, LIKELY, CHECK, CHECK_NO_CRASH, CONFIRMED, SIGNS, EMPTY_STATUS, NOT_CONFIRMED_SENTENCE, NO_CAUSE_NOTE, NOT_LIVE_SENTENCE, PHP_NOT_STATED, MODIFIED_NOTE, MODIFIED_ADVICE, NO_LOG_HELP };
