// decisions.txt: the admin's choice for every finding. Plain text on purpose, easy to edit and to keep in git.
//
//   ## PG-3f9a1c2b2d | P1 | Title of the finding
//   decision: pending        <- change to: fix | ignore | accept
//   reason:                  <- required for ignore and accept
//   decided: 2026-10-26      <- filled in by the tool
//
// fix     goes into FIXES-FOR-CLAUDE.md
// ignore  not a real problem for this project (false alarm or irrelevant)
// accept  a real risk the admin knowingly keeps
// Decisions are remembered: a finding that is gone and comes back keeps its earlier decision.

const fs = require('fs');
const path = require('path');
const { dirOf } = require('./project');

const VALID = ['pending', 'fix', 'ignore', 'accept'];
const file = name => path.join(dirOf(name), 'decisions.txt');
const HEAD = [
    '# Plugin Guard decisions',
    '# For each finding below set "decision:" to one of:',
    '#   fix     = Claude should fix this (it goes into FIXES-FOR-CLAUDE.md)',
    '#   ignore  = not a real problem here; write why in "reason:"',
    '#   accept  = a real risk you knowingly keep; write why in "reason:"',
    '#   pending = not decided yet',
    '# Then run:  node scripts/guard.js fixfile <project>',
    ''
];

function parse(text) {
    const map = new Map();
    const problems = [];
    let cur = null;
    text.split('\n').forEach((raw, i) => {
        const line = raw.trim();
        const h = /^##\s+(PG-[0-9a-f]+)\s*\|\s*(P[0-3])\s*\|\s*(.*)$/.exec(line);
        if (h) { cur = { id: h[1].slice(3), severity: h[2], title: h[3], decision: 'pending', reason: '', decided: '', line: i + 1 }; map.set(cur.id, cur); return; }
        if (!cur || !line || line.startsWith('#')) return;
        const kv = /^(decision|reason|decided)\s*:\s*(.*)$/i.exec(line);
        if (!kv) return;
        const key = kv[1].toLowerCase();
        cur[key] = key === 'decision' ? kv[2].trim().toLowerCase() : kv[2].trim();
    });
    for (const d of map.values()) {
        if (!VALID.includes(d.decision)) problems.push(`line ${d.line}: PG-${d.id} has decision "${d.decision}"; use fix, ignore, accept or pending`);
        else if ((d.decision === 'ignore' || d.decision === 'accept') && !d.reason) problems.push(`line ${d.line}: PG-${d.id} is "${d.decision}" but has no reason`);
    }
    return { map, problems };
}

function load(name) {
    if (!fs.existsSync(file(name))) return { map: new Map(), problems: [] };
    return parse(fs.readFileSync(file(name), 'utf8'));
}

// Merge the current findings into the file: keep earlier decisions, add new ones as pending, keep
// decided-but-gone ones at the bottom so the decision is remembered if the finding comes back.
function sync(name, findings, now = new Date(), patch = null) {
    const { map: old } = load(name);
    const today = now.toISOString().slice(0, 10);
    const block = (d, f) => [`## PG-${d.id} | ${d.severity} | ${(f ? f.title : d.title).replace(/\s+/g, ' ').slice(0, 160)}`, `decision: ${d.decision}`, `reason: ${d.reason || ''}`, `decided: ${d.decided || ''}`, ''];
    const out = [...HEAD];
    const current = new Set(findings.map(f => f.id));
    for (const f of findings) {
        const d = old.get(f.id) || { id: f.id, severity: f.severity, decision: 'pending', reason: '', decided: '' };
        d.severity = f.severity;
        if (patch) patch(d, f);
        if (d.decision !== 'pending' && !d.decided) d.decided = today;
        out.push(...block(d, f));
    }
    const gone = [...old.values()].filter(d => !current.has(d.id) && d.decision !== 'pending');
    if (gone.length) {
        out.push('# ---- Findings no longer present (kept so your decision is remembered if they come back) ----', '');
        for (const d of gone) out.push(...block(d));
    }
    fs.mkdirSync(path.dirname(file(name)), { recursive: true });
    fs.writeFileSync(file(name), out.join('\n'));
    return file(name);
}

// Attach decisions to findings. Unknown / invalid values count as pending.
function apply(name, findings) {
    const { map, problems } = load(name);
    for (const f of findings) {
        const d = map.get(f.id);
        const ok = d && VALID.includes(d.decision) && !((d.decision === 'ignore' || d.decision === 'accept') && !d.reason);
        f.decision = ok ? d.decision : 'pending';
        f.decisionReason = ok ? d.reason : '';
        f.decidedOn = ok ? d.decided : '';
    }
    return problems;
}

// Set one decision for every finding of the given rule(s). Only "pending" ones change unless overwrite is set.
function bulk(name, findings, { rules, as, reason, overwrite }, now = new Date()) {
    if (!VALID.includes(as) || as === 'pending') throw new Error('--as must be fix, ignore or accept');
    if ((as === 'ignore' || as === 'accept') && !String(reason || '').trim()) throw new Error(`--as ${as} needs --reason "why"`);
    const known = new Set(findings.map(f => f.rule));
    const unknown = rules.filter(r => !known.has(r));
    if (unknown.length) throw new Error(`No finding has rule ${unknown.map(r => `"${r}"`).join(', ')}. Rules present: ${[...known].sort().join(', ')}`);
    const today = now.toISOString().slice(0, 10);
    let changed = 0, kept = 0;
    sync(name, findings, now, (d, f) => {
        if (!rules.includes(f.rule)) return;
        if (d.decision !== 'pending' && !overwrite) { kept++; return; }
        d.decision = as; d.reason = as === 'fix' ? '' : String(reason).trim(); d.decided = today; changed++;
    });
    return { changed, kept };
}

module.exports = { bulk, sync, apply, parse, load, file, VALID };
