// Deterministic patch generators for custom code. No AI and no guessing: each generator handles ONE known pattern, edits only the source text
// it was pointed at, produces a unified diff, and is proven before it is offered:
//   1. the diff applies cleanly to the original text and gives exactly the new text (our own applier, not `patch`),
//   2. the patched file passes `php -l`,
//   3. the PHP scanner (phpast) run on the patched text no longer shows the problem.
// Nothing here writes to the site: the patched copy of ONE file goes to the issue folder (work/patch-test/) and the diff to result/patches/.
// Generators: hook-priority, function-guard (function_exists / class_exists), core-library-replacement, missing-dependency.
// Not generated (needs a person): outdated template overrides, JavaScript object collisions, anything in protected or unknown-owner code.

const fs = require('fs');
const path = require('path');
const Engine = require('php-parser');
const ownership = require('../lib/ownership');
const phpast = require('./phpast');

const parser = new Engine({ parser: { php8: true, suppressErrors: true }, ast: { withPositions: true } });

// ---------------------------------------------------------------- unified diff (one hunk per change region, 3 lines of context)
function unifiedDiff(rel, a, b) {
    const A = a.split('\n'), B = b.split('\n');
    let s = 0; while (s < A.length && s < B.length && A[s] === B[s]) s++;
    let e = 0; while (e < A.length - s && e < B.length - s && A[A.length - 1 - e] === B[B.length - 1 - e]) e++;
    if (s === A.length && s === B.length) return '';
    const ctx = 3, from = Math.max(0, s - ctx), aEnd = Math.min(A.length, A.length - e + ctx), bEnd = Math.min(B.length, B.length - e + ctx);
    const lines = [];
    for (let i = from; i < s; i++) lines.push(' ' + A[i]);
    for (let i = s; i < A.length - e; i++) lines.push('-' + A[i]);
    for (let i = s; i < B.length - e; i++) lines.push('+' + B[i]);
    for (let i = A.length - e; i < aEnd; i++) lines.push(' ' + A[i]);
    return `--- a/${rel}\n+++ b/${rel}\n@@ -${from + 1},${aEnd - from} +${from + 1},${bEnd - from} @@\n${lines.join('\n')}\n`;
}
// applies a diff made by unifiedDiff (a single hunk); throws when the context does not match
function applyUnified(text, diff) {
    const L = diff.split('\n'), h = L.findIndex(l => l.startsWith('@@'));
    const m = /^@@ -(\d+),(\d+) \+(\d+),(\d+) @@/.exec(L[h]);
    if (!m) throw new Error('no hunk header');
    const start = Number(m[1]) - 1, src = text.split('\n'), body = L.slice(h + 1).filter((l, i, all) => !(i === all.length - 1 && l === ''));
    const before = body.filter(l => l[0] !== '+').map(l => l.slice(1)), after = body.filter(l => l[0] !== '-').map(l => l.slice(1));
    if (src.slice(start, start + before.length).join('\n') !== before.join('\n')) throw new Error('the context does not match the file');
    return [...src.slice(0, start), ...after, ...src.slice(start + before.length)].join('\n');
}

// ---------------------------------------------------------------- source helpers
const offsetOfLine = (text, line) => { let off = 0; for (let i = 1; i < line; i++) { const n = text.indexOf('\n', off); if (n < 0) return text.length; off = n + 1; } return off; };
const lineOfOffset = (text, off) => text.slice(0, off).split('\n').length;
// text of a call starting at `from`: -> { start, open, close, args: [{start,end,text}] } (arguments split at top-level commas, quotes and brackets respected)
function callAt(text, from, nameRe) {
    nameRe.lastIndex = from;
    const m = nameRe.exec(text); if (!m) return null;
    const open = m.index + m[0].length - 1;
    let depth = 0, q = null, i = open, argStart = open + 1; const args = [];
    for (; i < text.length; i++) {
        const c = text[i];
        if (q) { if (c === '\\') i++; else if (c === q) q = null; continue; }
        if (c === '\'' || c === '"') q = c;
        else if ('([{'.includes(c)) depth++;
        else if (')]}'.includes(c)) { depth--; if (depth === 0) { args.push({ start: argStart, end: i, text: text.slice(argStart, i) }); return { start: m.index, open, close: i, args }; } }
        else if (c === ',' && depth === 1) { args.push({ start: argStart, end: i, text: text.slice(argStart, i) }); argStart = i + 1; }
    }
    return null;
}
const strLit = t => { const m = /^\s*(['"])(.*)\1\s*$/s.exec(t); return m ? m[2] : null; };

// ---------------------------------------------------------------- the generators. Each: (h, ev, source) -> { new_text, summary, why, after } | { skipped: reason }
const G = {};

// remove_action( 'hook', 'cb', 5 ) while the callback was added at 10: make the removal use the priority it was added with
G['hook-priority'] = (h, ev, src) => {
    if (h.type !== 'remove-wrong-priority' || ev.role !== 'removes') return null;
    if (!Number.isInteger(h.added_priority)) return { skipped: 'the priority the callback was added with is not a plain number' };
    const call = callAt(src, offsetOfLine(src, ev.line), /\\?remove_(?:action|filter)\s*\(/gi);
    if (!call || lineOfOffset(src, call.start) > ev.line + NEAR) return { skipped: 'the remove_action / remove_filter call was not found near the cited line' };
    if (call.args.length < 2 || call.args.length > 3) return { skipped: 'unexpected argument list' };
    const a = call.args, newArg = a.length === 3 ? a[2].text.replace(/\d+/, String(h.added_priority)) : ` ${h.added_priority}`;
    if (a.length === 3 && !/^\s*\d+\s*$/.test(a[2].text)) return { skipped: 'the priority is not a literal number' };
    const out = a.length === 3 ? src.slice(0, a[2].start) + newArg + src.slice(a[2].end) : src.slice(0, a[1].end) + ',' + newArg + src.slice(a[1].end);
    return { new_text: out, summary: `Remove the callback at priority ${h.added_priority}, the priority it was added with`, why: `${h.callback} was added to "${h.hook}" at priority ${h.added_priority}, but this code removes it at priority ${h.removed_priority === null ? 10 : h.removed_priority}, so the removal never matches.`,
        after: facts => !facts.hooks.some(x => x.op === 'remove' && x.hook === h.hook && x.line >= ev.line - 1 && x.priority !== h.added_priority && x.callback && x.callback.name === h.callback) };
};
const NEAR = 6;

// function / class declared in custom code without a guard: wrap it so a second declaration elsewhere cannot be a fatal error
G['function-guard'] = (h, ev, src) => {
    if (h.type !== 'duplicate-declaration' || !h.declaration) return null;
    let ast; try { ast = parser.parseCode(src, ev.file); } catch { return { skipped: 'the file could not be parsed' }; }
    const want = String(h.declaration.name).replace(/^.*\\/, '').toLowerCase(), kind = h.declaration.kind;
    let hit = null, ns = '';
    for (const n of ast.children || []) {
        if (n.kind === 'namespace') { for (const c of n.children || []) if (matches(c)) { hit = c; ns = typeof n.name === 'string' ? n.name : (n.name && n.name.name) || ''; } }
        else if (matches(n)) hit = n;
    }
    function matches(n) { const nm = n && n.name && (typeof n.name === 'string' ? n.name : n.name.name); return n && ((kind === 'function' && n.kind === 'function') || (kind === 'class' && ['class', 'interface', 'trait'].includes(n.kind))) && String(nm).toLowerCase() === want && n.loc.start.line === ev.line; }
    if (!hit) return { skipped: 'the declaration is not a top-level function/class at the cited line (it may already be inside an if block or a class)' };
    if (hit.kind === 'interface' || hit.kind === 'trait') return { skipped: 'interfaces and traits are not wrapped automatically' };
    const L = src.split('\n'), a = hit.loc.start.line, b = hit.loc.end.line, indent = (/^\s*/.exec(L[a - 1]) || [''])[0];
    if (hit.leadingComments && hit.leadingComments.length) { /* docblock stays above the guard */ }
    const full = (ns ? ns + '\\' : '') + String(hit.name.name || hit.name), esc = full.replace(/\\/g, '\\\\');
    const fnName = kind === 'class' ? 'class_exists' : 'function_exists';
    const wrapped = [`${indent}if ( ! ${fnName}( '${esc}' ) ) {`, ...L.slice(a - 1, b).map(l => (l.length ? '\t' + l : l)), `${indent}}`];
    const out = [...L.slice(0, a - 1), ...wrapped, ...L.slice(b)].join('\n');
    return { new_text: out, summary: `Wrap ${kind} ${full}() in a ${fnName}() guard`, why: `${full} is declared here and also elsewhere; if both files load, PHP stops with "Cannot redeclare". The guard makes the first one that loads win. It does NOT decide which copy should win: that is a decision for the owner (see the other resolution options). Note that a guarded function is defined when the line runs, not at compile time.`,
        after: facts => (kind === 'class' ? facts.classes : facts.functions).some(x => String(x.name).toLowerCase().endsWith(want) && x.guarded) };
};

// the custom theme/plugin deregisters a WordPress core handle (jquery ...) and registers its own, older copy: comment those statements out
G['core-library-replacement'] = (h, ev, src) => {
    if (h.type !== 'handle-replaced' || !h.core_handle || ev.role !== 'deregister' && ev.role !== 'dequeue' && ev.role !== 'registers replacement') return null;
    const call = callAt(src, offsetOfLine(src, ev.line), /\\?wp_(?:deregister|dequeue|register|enqueue)_(?:script|style)\s*\(/gi);
    if (!call || lineOfOffset(src, call.start) > ev.line + NEAR) return { skipped: 'the statement was not found near the cited line' };
    const semi = src.indexOf(';', call.close); if (semi < 0) return { skipped: 'the statement has no ";"' };
    const a = lineOfOffset(src, call.start), b = lineOfOffset(src, semi), L = src.split('\n');
    for (let i = a - 1; i < b; i++) if (L[i].slice(0, call.start - offsetOfLine(src, a)).trim() !== '' && i === a - 1) return { skipped: 'other code shares the line with the statement' };
    for (let i = a - 1; i < b; i++) L[i] = L[i].replace(/^(\s*)/, '$1// [Plugin Guard suggestion] ');
    return { new_text: L.join('\n'), summary: `Stop replacing WordPress's own "${h.handle}" ${h.handle_type} (lines ${a}-${b})`, why: `This code removes WordPress's bundled "${h.handle}"${h.core_version ? ` (version ${h.core_version})` : ''} and loads its own copy${h.replacement && h.replacement.ver ? ` (${h.replacement.ver})` : ''}. Other components then get a different version than they were written for. Check that nothing in this theme/plugin needs the old version before applying.`,
        after: facts => !facts.assets.some(x => x.handle === h.handle && x.line >= a && x.line <= b) };
};

// "x" depends on a handle nobody registers: WordPress then never prints "x" at all. Remove the dead dependency from the array.
G['missing-dependency'] = (h, ev, src) => {
    if (h.type !== 'dependency-handle-not-registered') return null;
    const call = callAt(src, offsetOfLine(src, ev.line), /\\?wp_(?:enqueue|register)_(?:script|style)\s*\(/gi);
    if (!call || lineOfOffset(src, call.start) > ev.line + NEAR || call.args.length < 3) return { skipped: 'the enqueue/register call with a dependency array was not found near the cited line' };
    if (strLit(call.args[0].text) !== h.handle) return { skipped: 'the call near the cited line is for a different handle' };
    const deps = call.args[2];
    const re = new RegExp(`\\s*(['"])${String(h.missing).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\1\\s*,?`);
    const arr = deps.text; if (!re.test(arr)) return { skipped: 'the dependency array is not a literal list containing that handle' };
    const fixed = arr.replace(re, ' ').replace(/,\s*(\]|\))/, ' $1').replace(/(\[|array\()\s+/, '$1').replace(/\s+(\]|\))/, '$1');
    return { new_text: src.slice(0, deps.start) + fixed + src.slice(deps.end), summary: `Remove the unregistered dependency "${h.missing}" from "${h.handle}"`, why: `"${h.handle}" lists "${h.missing}" as a dependency, but nothing registers a handle of that name. WordPress skips a script whose dependency is missing, so "${h.handle}" is never loaded. If the dependency is really needed, register it instead.`,
        after: facts => !facts.assets.some(x => x.handle === h.handle && Array.isArray(x.deps) && x.deps.includes(h.missing)) };
};

const GENERATORS = Object.keys(G);

// -> { generator, file, rel, diff, summary, why, validation: [{id,status,reason}], ok } | { skipped, generator }
function generate(h, ev, { root, policy, workDir }) {
    const cls = ownership.classify(policy, ev.file);
    if (cls.owner !== 'custom') return { skipped: `not custom code (${cls.owner}: ${cls.reason})`, owner: cls.owner };
    const r = ownership.resolveInside(root, ev.file);
    if (!r.ok || !/\.php$/i.test(r.abs)) return { skipped: r.ok ? 'only PHP files are patched' : r.reason };
    let src; try { src = fs.readFileSync(r.abs, 'utf8'); } catch { return { skipped: 'file could not be read' }; }
    for (const name of GENERATORS) {
        const g = G[name](h, ev, src);
        if (!g) continue;
        if (g.skipped) return { skipped: g.skipped, generator: name };
        const diff = unifiedDiff(r.rel, src, g.new_text), v = [];
        let round = false; try { round = applyUnified(src, diff) === g.new_text; } catch { /* fails below */ }
        v.push({ id: 'diff-applies', status: round ? 'PASSED' : 'FAILED', reason: round ? 'the diff applies cleanly to the original text and gives exactly the new text' : 'the diff did not round-trip' });
        let lint = null;
        if (workDir) {
            const tp = path.join(workDir, 'patch-test', r.rel); fs.mkdirSync(path.dirname(tp), { recursive: true, mode: 0o700 }); fs.writeFileSync(tp, g.new_text, { mode: 0o600 });
            lint = phpast.phpLint(tp);
        }
        v.push({ id: 'php-l', status: lint === null ? 'NOT_RUN' : lint.ok ? 'PASSED' : 'FAILED', reason: lint === null ? 'php is not installed' : lint.ok ? 'the patched file has no syntax error' : lint.message });
        const facts = phpast.analyse(g.new_text, r.rel);
        const gone = facts.parsed && g.after(facts);
        v.push({ id: 'scanner-rerun', status: gone ? 'PASSED' : 'FAILED', reason: gone ? 'the PHP scanner no longer reports the problem in the patched text' : 'the scanner still sees the problem in the patched text' });
        return { generator: name, file: ev.file, rel: r.rel, diff, summary: g.summary, why: g.why, validation: v, ok: v.every(x => x.status === 'PASSED' || x.status === 'NOT_RUN') && round && gone };
    }
    return { skipped: 'no deterministic generator exists for this pattern', generator: null };
}

module.exports = { generate, unifiedDiff, applyUnified, callAt, GENERATORS };
