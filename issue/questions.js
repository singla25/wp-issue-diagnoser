// Follow-up questions for the reporter. Pure, rule-based, deterministic, offline: no AI, no network, no clock. The engine looks at what is MISSING from the issue
// and asks a plain-language question, at most once per rule, in a fixed priority order, at most 5 per run (3 before the page probe, 2 after the code analysis).
//
//   1 since       nothing about when it started / what changed just before        choices: the installed components (header version, then name)
//   2 page        no page and the address has no path                              a path, or an address on the SAME host as the issue's
//   3 login       a login or checkout problem and nobody said logged in or out
//   4 what        symptom "other", or an error symptom with no error clue          the answer may rewrite the symptom (and a default oracle), never a reporter's oracle
//   5 php         a compatibility observation exists and the PHP version is unknown
//   6 redirect    the code redirects on a hook, nothing redirected on the probe, and the report is about redirects: which page?
//   7 screen      a layout problem and no word about phone or desktop
// An answer can only fill the whitelisted fields of the issue (lib/issue-store.js applyQuestionAnswers, validated by the same normalise()). It can never set a status
// or a verdict. Nothing is asked without a terminal, or with --yes, --no-questions or --no-prompt: the caller decides `interactive`.

const RULE_ORDER = ['since', 'page', 'login', 'what', 'php', 'redirect', 'screen'];
const GROUP = { since: 'A', page: 'A', login: 'A', what: 'A', screen: 'A', php: 'B', redirect: 'B' };
const LIMITS = { A: 3, B: 2 };           // before the probe / after the analysis: 5 in all
const MAX_COMPONENT_CHOICES = 8;
const ERROR_SYMPTOMS = ['white-screen', 'js-error'];
const ERROR_CLUES = new Set(['php-fatal', 'php-redeclare', 'php-undefined-function', 'php-class-not-found', 'wp-critical-error', 'js-not-defined', 'js-error', 'http-request-failed', 'http-status']);
const SYMPTOM_CHOICES = [   // plain words for the symptom ids of lib/issue-store.js
    ['white-screen', 'A blank white page, or an error message instead of the page'], ['js-error', 'A button or feature does nothing'], ['layout', 'The page looks broken or messy'],
    ['form-checkout', 'A form or the checkout does not work'], ['login-admin', 'I cannot log in, or the admin area is broken'], ['slow', 'The page is very slow'],
    ['redirect', 'The page jumps to the wrong place, or keeps loading in circles'], ['wrong-content', 'The wrong text or email appears']
];
const PHP_CHOICES = ['7.4', '8.0', '8.1', '8.2', '8.3', '8.4'];
const SCREEN_CHOICES = [['mobile', 'On my phone'], ['tablet', 'On a tablet'], ['laptop', 'On a computer'], ['laptop,mobile', 'On both a phone and a computer']];

const semverKey = v => { const m = /^(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(String(v || '')); return m ? [Number(m[1]), Number(m[2] || 0), Number(m[3] || 0)] : null; };
// header version (newest first; no version last), then name. File times are only ever display text: they never decide the order.
function orderComponents(list) {
    return list.slice().sort((a, b) => {
        const x = semverKey(a.version), y = semverKey(b.version);
        if (x && y) { for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return y[i] - x[i]; } else if (x || y) return x ? -1 : 1;
        return String(a.name || a.ref).localeCompare(String(b.name || b.ref)) || String(a.ref).localeCompare(String(b.ref));
    });
}

const asked = (ctx, id) => (((ctx.issue.questions || {}).asked || {})[id]) || null;
const hasWords = (ctx, re) => re.test([ctx.issue.description, ctx.issue.since, ctx.issue.changed_before, ctx.issue.title].filter(Boolean).join(' '));
const clueTypes = ctx => new Set((ctx.clues || []).map(c => c.type));
const hostOf = u => { try { return new URL(u).host.toLowerCase(); } catch { return null; } };

// the oracle a clue suggests for a symptom; null = keep the default for that symptom.
// A crash (white screen) keeps its default oracle even with a PHP fatal in the log: a "debug-log" oracle looks only at NEW log lines, so a fatal logged earlier gives no answer,
// and its stored answer cannot be recomputed from the saved page observations (they keep no log text), which made the re-check disagree and kept a real crash from being
// confirmed (REPORT-SPEC Part 2). The default oracle judges the 5xx page itself and recomputes to the same answer.
function proposeOracle(symptom, clues) {
    const by = t => (clues || []).find(c => c.type === t);
    if (symptom === 'js-error') { const c = by('js-not-defined') || by('js-error'); return c && c.detail && c.detail.symbol ? { type: 'console-error', value: String(c.detail.symbol).slice(0, 80) } : null; }
    return null;
}
function suggestedSymptom(clues) {
    const t = new Set((clues || []).map(c => c.type));
    if ([...t].some(x => /^php-(fatal|redeclare|undefined-function|class-not-found)$/.test(x)) || t.has('wp-critical-error')) return 'white-screen';
    if (t.has('js-not-defined') || t.has('js-error')) return 'js-error';
    return null;
}

const RULES = {
    since: {
        applies: ctx => !ctx.issue.since && !ctx.issue.changed_before && !asked(ctx, 'since'),
        build: ctx => {
            const comps = orderComponents(ctx.components || []).slice(0, MAX_COMPONENT_CHOICES);
            const choices = comps.map(c => ({ label: `I updated or installed "${c.name || c.ref}"${c.version ? ` (version ${c.version})` : ''}${c.updated_text ? `, its files last changed on ${c.updated_text}` : ''}`, value: `Updated or installed: ${c.name || c.ref}${c.version ? ` ${c.version}` : ''}` }));
            choices.push({ label: 'Something else (I will type it)', typed: true }, { label: "I don't know", unknown: true });
            return { id: 'since', text: 'Do you remember what changed on your website just before the problem started? For example an update, or a new plugin.', choices, typedPrompt: 'Type what changed, in your own words' };
        }
    },
    page: {
        applies: ctx => !(ctx.issue.pages || []).length && (() => { try { const p = new URL(ctx.issue.url).pathname; return !p || p === '/'; } catch { return true; } })() && !asked(ctx, 'page'),
        build: () => ({ id: 'page', text: 'Which page of your website shows the problem?', choices: [{ label: 'The home page', value: '/' }, { label: 'Another page (I will type its address, for example /contact/)', typed: true }], typedPrompt: 'Type the address of the page, for example /contact/' })
    },
    login: {
        applies: ctx => ['login-admin', 'form-checkout'].includes(ctx.issue.symptom) && !asked(ctx, 'login'),
        build: () => ({ id: 'login', text: 'When the problem happens, are you logged in to the website?', choices: [{ label: 'Yes, I am logged in', value: 'yes' }, { label: 'No, I am not logged in', value: 'no' }, { label: 'I am not sure', unknown: true }] })
    },
    what: {
        applies: ctx => !asked(ctx, 'what') && (ctx.issue.symptom === 'other' || (ERROR_SYMPTOMS.includes(ctx.issue.symptom) && ![...clueTypes(ctx)].some(t => ERROR_CLUES.has(t)))),
        build: ctx => {
            const hint = suggestedSymptom(ctx.clues);
            const choices = SYMPTOM_CHOICES.map(([id, label]) => ({ label: `${label}${id === hint ? ' (your logs point to this)' : ''}`, value: id }));
            choices.push({ label: 'None of these', unknown: true });
            return { id: 'what', text: 'What does the problem look like?', choices };
        }
    },
    php: {
        applies: ctx => !ctx.issue.php_version && !asked(ctx, 'php') && (ctx.observations || []).some(o => ['removed-function-call', 'requires-php-mismatch'].includes(o.type)),
        build: () => ({ id: 'php', text: 'Do you know which PHP version your website runs? Your hosting control panel usually shows it (look for "PHP version"). Some code on a site stops working on newer versions.',
            choices: [...PHP_CHOICES.map(v => ({ label: `PHP ${v}`, value: v })), { label: 'Another version (I will type it, for example 8.1)', typed: true }, { label: "I don't know", unknown: true }], typedPrompt: 'Type the PHP version, for example 8.1' })
    },
    redirect: {
        applies: ctx => !asked(ctx, 'redirect') && (ctx.redirect_map || []).some(e => e.context === 'hook') && !ctx.redirect_observed
            && (ctx.issue.symptom === 'redirect' || hasWords(ctx, /redirect|sent to the wrong|wrong (page|place|address)|keeps? (re)?loading|loop/i)),
        build: () => ({ id: 'redirect', text: 'Which page sends you to the wrong place?', choices: [{ label: 'The home page', value: '/' }, { label: 'Another page (I will type its address, for example /shop/)', typed: true }], typedPrompt: 'Type the address of the page, for example /shop/' })
    },
    screen: {
        applies: ctx => ctx.issue.symptom === 'layout' && !asked(ctx, 'screen') && !ctx.viewports_given && !hasWords(ctx, /mobile|phone|tablet|desktop|laptop|computer|screen|ipad|iphone|android/i),
        build: () => ({ id: 'screen', text: 'On which kind of screen do you see the problem?', choices: [...SCREEN_CHOICES.map(([value, label]) => ({ label, value })), { label: 'I am not sure', unknown: true }] })
    }
};

// the next question of `ids` that applies, or null. state: { used: { A, B }, stopped }
function next(ctx, ids, state) {
    if (state.stopped) return null;
    for (const id of RULE_ORDER.filter(r => ids.includes(r))) {
        const g = GROUP[id];
        if ((state.used[g] || 0) >= LIMITS[g]) continue;
        if (RULES[id].applies(ctx)) return RULES[id].build(ctx);
    }
    return null;
}

function render(q, n, of) {
    const lines = [`Question ${n} of up to ${of}: ${q.text}`];
    q.choices.forEach((c, i) => lines.push(`  ${i + 1}) ${c.label}`));
    lines.push('  0) Skip this question', "  (type a number; or 'stop' to stop all questions)");
    return lines.join('\n');
}

// -> { kind: 'skip' | 'stop' | 'choice' | 'invalid', index?, choice? }
function parse(q, text) {
    const t = String(text == null ? '' : text).trim().toLowerCase();
    if (t === '' || t === '0' || t === 'skip' || t === 's') return { kind: 'skip' };
    if (t === 'stop' || t === 'q' || t === 'quit') return { kind: 'stop' };
    if (/^\d+$/.test(t) && Number(t) >= 1 && Number(t) <= q.choices.length) return { kind: 'choice', index: Number(t) - 1, choice: q.choices[Number(t) - 1] };
    return { kind: 'invalid' };
}

// The fields an answer may fill, and the record of the answer. `typed` is the text of a "type it" choice. Validation happens in the store (same normalise()).
function toPatch(q, choice, typed, ctx) {
    const rec = { answer: choice.unknown ? 'unknown' : choice.typed ? String(typed) : String(choice.value), skipped: false };
    const fields = {};
    switch (q.id) {
        case 'since': if (!choice.unknown) fields.changedBefore = choice.typed ? String(typed) : choice.value; break;
        case 'page': fields.pages = [...(ctx.issue.pages || []), choice.typed ? String(typed) : choice.value]; break;
        case 'login': if (!choice.unknown) fields.needsLogin = choice.value === 'yes'; break;
        case 'what':
            if (!choice.unknown && choice.value !== ctx.issue.symptom) {
                fields.symptom = choice.value;
                const o = proposeOracle(choice.value, ctx.clues);
                if (ctx.issue.oracle && ctx.issue.oracle.defaulted && o) fields.oracle = o;       // never over a reporter's own oracle
            }
            break;
        case 'php': if (!choice.unknown) fields.phpVersion = choice.typed ? String(typed) : choice.value; break;
        case 'redirect': fields.pages = [...(ctx.issue.pages || []), choice.typed ? String(typed) : choice.value]; break;
        case 'screen': if (!choice.unknown) rec.viewports = choice.value; break;
        default: break;
    }
    return { fields, rec };
}

// The loop for one pass. io: { say(text), ask(prompt) } ; apply(patch) -> { ok, message? } writes through the store ; ctxOf() -> the current context (re-read after each answer).
// Returns the questions that were asked, in order. Nothing is asked unless `interactive` is true.
async function runPass({ ids, ctxOf, state, io, interactive, apply }) {
    const out = [];
    if (!interactive || !io) return out;
    for (;;) {
        const ctx = ctxOf();
        const q = next(ctx, ids, state);
        if (!q) return out;
        const g = GROUP[q.id];
        const total = LIMITS.A + LIMITS.B;
        io.say(`\n${render(q, (state.used.A || 0) + (state.used.B || 0) + 1, total)}`);
        state.used[g] = (state.used[g] || 0) + 1;
        let done = false, tries = 0;
        while (!done && tries < 2) {
            tries++;
            const raw = await io.ask('Your answer');
            if (raw === null || raw === undefined) { state.stopped = true; break; }          // the input ended
            const p = parse(q, raw);
            if (p.kind === 'stop') { state.stopped = true; out.push({ id: q.id, skipped: true, stopped: true }); apply({ record: { [q.id]: { answer: null, skipped: true } }, stopped: true }); done = true; break; }
            if (p.kind === 'skip') { out.push({ id: q.id, skipped: true }); apply({ record: { [q.id]: { answer: null, skipped: true } } }); done = true; break; }
            if (p.kind === 'invalid') { io.say('Please type one of the numbers above, or 0 to skip.'); continue; }
            let typed = null;
            if (p.choice.typed) { typed = await io.ask(q.typedPrompt || 'Type it'); if (typed === null || String(typed).trim() === '') { out.push({ id: q.id, skipped: true }); apply({ record: { [q.id]: { answer: null, skipped: true } } }); done = true; break; } }
            const patch = toPatch(q, p.choice, typed, ctx);
            const r = apply({ fields: patch.fields, record: { [q.id]: patch.rec }, viewports: patch.rec.viewports });
            if (r.ok) { out.push({ id: q.id, skipped: false, answer: patch.rec.answer }); done = true; }
            else io.say(`That does not work: ${r.message}. Try again, or type 0 to skip.`);
        }
        if (!done && !state.stopped) { out.push({ id: q.id, skipped: true }); apply({ record: { [q.id]: { answer: null, skipped: true } } }); }
        if (state.stopped) return out;
    }
}

const newState = () => ({ used: { A: 0, B: 0 }, stopped: false });
const interactiveNow = (o, { stdin = process.stdin, stdout = process.stdout } = {}) => !!(stdin && stdin.isTTY && stdout && stdout.isTTY) && !o.yes && !o['no-questions'] && !o['no-prompt'];

module.exports = { RULE_ORDER, GROUP, LIMITS, RULES, next, render, parse, toPatch, runPass, newState, interactiveNow, orderComponents, proposeOracle, suggestedSymptom, hostOf, SYMPTOM_CHOICES };
