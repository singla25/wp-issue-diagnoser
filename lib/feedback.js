// REPORT-SPEC Part 5: the optional feedback after the fix plan. Written only to <issue folder>/feedback.md (not under work/), never sent anywhere.
// Passwords, keys, tokens (lib/redact.js) and email / IP addresses (below) are removed first. Names and street addresses are NOT detected.
const fs = require('fs');
const path = require('path');
const redact = require('./redact');

const SAVED_NOTICE = 'Saved only on this computer, in the report folder. It is never sent anywhere. Passwords, keys, tokens, email addresses and IP addresses are removed first; names and street addresses are not, so please leave them out.';
const Q_TEXT = 'Anything we should improve? (type it, or Enter to skip)';
const Q_SCORE = 'How useful was this report? 1 = not useful, 5 = very useful (Enter to skip)';
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const H = '[0-9A-Fa-f]{1,4}';
const MASKS = [
    ['email address', /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g, '[email removed]'],
    ['IPv6 address', new RegExp(`(?<![\\w:])(?:(?:${H}:){7}${H}|(?:${H}:){1,7}:(?:${H}(?::${H}){0,6})?|::(?:${H}:){0,6}${H})(?![\\w])`, 'g'), '[IP address removed]'],
    ['IPv4 address', /(?<![\w.])(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)(?![\w])/g, '[IP address removed]']
];
// -> { text, removed: [kinds] }. Email first (an address may contain digits), then lib/redact.js for secrets.
function mask(s) {
    let t = String(s == null ? '' : s); const removed = [];
    for (const [kind, re, to] of MASKS) { const n = t.replace(re, to); if (n !== t) removed.push(kind); t = n; }
    const r = redact.text(t); if (r !== t) removed.push('secret');
    return { text: r, removed };
}

const parseScore = v => { const s = String(v).trim(); return /^[1-5]$/.test(s) ? Number(s) : null; };
const readable = d => `${d.getDate()} ${MON[d.getMonth()]} ${d.getFullYear()}, ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;

// io: { say, ask(prompt) -> string | null }. -> { asked, text, score, file, removed }
async function collect({ io, dir, now = new Date() }) {
    io.say(SAVED_NOTICE);
    let text = (await io.ask(Q_TEXT)) || '';
    text = text.trim();
    let score = null;
    for (;;) {
        const a = await io.ask(Q_SCORE);
        if (a === null || String(a).trim() === '') break;
        score = parseScore(a);
        if (score !== null) break;
        io.say('Please type a whole number from 1 to 5, or press Enter to skip.');
    }
    const m = mask(text);
    const res = { asked: true, text: m.text, score, file: null, removed: m.removed };
    if (!m.text && score === null) return res;
    const body = ['# Feedback on the report', '', `Date: ${readable(now)}`, ...(score !== null ? [`Score: ${score} of 5`] : []), ...(m.text ? ['', m.text] : []), ''].join('\n');
    res.file = path.join(dir, 'feedback.md');
    fs.writeFileSync(res.file, body, { mode: 0o600 });
    return res;
}

module.exports = { collect, mask, parseScore, SAVED_NOTICE, Q_TEXT, Q_SCORE };
