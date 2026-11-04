// The choice step after the report (REPORT-SPEC 5.3, 6): plain multiple-choice questions in the terminal that shape FIX-PLAN.md (issue/fix-plan.js). Pure question
// builder, parser and a runner that takes a reader, in the style of issue/questions.js: numbered choices, "0) Skip this question", "not sure" always accepted, "stop".
//   1 update    "Can you update the theme and plugins?"                 yes / no / not sure
//   2 licence   "Do you have a licence for the theme?"                  yes / no / not sure   (only when the top cause involves a theme)
//   3 copy      "Is this a copy, and do you have a backup?"             yes / no              ("not sure" typed is kept as not sure, and is treated like no)
//   4 plan      "Which plan do you want?"                               the options still possible, the ranked default first (only when there is a cause or a sign)
// Nothing is asked without a terminal on both input and output, or with --yes, --no-questions or --no-prompt: the flags win over a supplied reader. Nothing is asked when
// there is nothing to plan for. Answers are saved ONLY through lib/issue-store.js applyPlanAnswers (issue.json `plan_answers`, whitelisted); they never change a status
// or a verdict: nothing that computes one reads them.

const fixPlan = require('./fix-plan');

const YNU = [{ label: 'Yes', value: 'yes' }, { label: 'No', value: 'no' }, { label: 'Not sure', value: 'not-sure' }];
const TEXT = { update: 'Can you update the theme and plugins?', licence: 'Do you have a licence for the theme?', copy: 'Is this a copy, and do you have a backup?', plan: 'Which plan do you want?' };

// the questions that apply to these findings, given the answers so far (the plan choices depend on the first three) -> [{ id, text, choices }]
function questionsFor(f, answers = {}) {
    const ctx = fixPlan.context(f);
    if (!ctx) return [];
    const out = [];
    if (ctx.kind === 'cause') {
        out.push({ id: 'update', text: TEXT.update, choices: YNU });
        if (fixPlan.involvesTheme(ctx)) out.push({ id: 'licence', text: TEXT.licence, choices: YNU });
    }
    out.push({ id: 'copy', text: TEXT.copy, choices: YNU.slice(0, 2) });
    return out;
}
// the last question, built from the options still possible after the first answers; the ranked default first
function planQuestion(f, answers = {}, evidence = null) {
    const ctx = fixPlan.context(f);
    if (!ctx) return null;
    const o = fixPlan.options(ctx, { ...answers, plan: undefined }, evidence);
    if (!o.options.length) return null;
    return { id: 'plan', text: TEXT.plan, choices: [...o.options.map((x, i) => ({ label: `${x.title}${i === 0 ? ' (suggested)' : ''}`, value: x.id })), { label: 'Not sure (use the suggested plan)', value: 'not-sure' }] };
}

function render(q, n, of) {
    const lines = [`Question ${n} of up to ${of}: ${q.text}`];
    q.choices.forEach((c, i) => lines.push(`  ${i + 1}) ${c.label}`));
    lines.push('  0) Skip this question', "  (type a number, or 'not sure'; or 'stop' to stop all questions)");
    return lines.join('\n');
}
// -> { kind: 'skip' | 'stop' | 'choice' | 'invalid', value? }   "not sure" (or "?") is always allowed
function parse(q, text) {
    const t = String(text == null ? '' : text).trim().toLowerCase();
    if (t === '' || t === '0' || t === 'skip' || t === 's') return { kind: 'skip' };
    if (t === 'stop' || t === 'q' || t === 'quit') return { kind: 'stop' };
    if (/^(not sure|not-sure|unsure|\?|dont know|don't know|i don't know)$/.test(t)) return { kind: 'choice', value: 'not-sure' };
    if (/^\d+$/.test(t) && Number(t) >= 1 && Number(t) <= q.choices.length) return { kind: 'choice', value: q.choices[Number(t) - 1].value };
    const byWord = q.choices.find(c => c.label.toLowerCase() === t || c.value === t || (t === 'y' && c.value === 'yes') || (t === 'n' && c.value === 'no'));
    return byWord ? { kind: 'choice', value: byWord.value } : { kind: 'invalid' };
}

// the flags win, whatever reader was supplied
const interactiveNow = (o, { stdin = process.stdin, stdout = process.stdout, tty } = {}) => !o.yes && !o['no-questions'] && !o['no-prompt'] && (tty !== undefined ? !!tty : !!(stdin && stdin.isTTY && stdout && stdout.isTTY));

// io: { say(text), ask(prompt) -> string | null }. save(answers) writes them (store.applyPlanAnswers). -> { asked: [{ id, value | null }], answers, stopped }
async function run({ f, io, interactive, save, evidence = null }) {
    const res = { asked: [], answers: {}, stopped: false };
    if (!interactive || !io || !fixPlan.context(f)) return res;
    const first = questionsFor(f);
    const total = first.length + 1;
    io.say('\nA few questions to shape the fix plan (FIX-PLAN.md). They change nothing in the report.');
    const askOne = async (q, n) => {
        io.say(`\n${render(q, n, total)}`);
        for (let tries = 0; tries < 2; tries++) {
            const raw = await io.ask('Your answer');
            if (raw === null || raw === undefined) { res.stopped = true; return null; }          // the input ended
            const p = parse(q, raw);
            if (p.kind === 'stop') { res.stopped = true; return null; }
            if (p.kind === 'skip') return null;
            if (p.kind === 'choice') return p.value;
            io.say("Please type one of the numbers above, 'not sure', or 0 to skip.");
        }
        return null;
    };
    let n = 0;
    for (const q of first) {
        const v = await askOne(q, ++n);
        res.asked.push({ id: q.id, value: v });
        if (v) res.answers[q.id] = v;
        if (res.stopped) break;
    }
    if (!res.stopped) {
        const pq = planQuestion(f, res.answers, evidence);
        if (pq) { const v = await askOne(pq, ++n); res.asked.push({ id: 'plan', value: v }); if (v) res.answers.plan = v; }
    }
    if (Object.keys(res.answers).length && save) save(res.answers);
    return res;
}

module.exports = { questionsFor, planQuestion, render, parse, run, interactiveNow, TEXT };
