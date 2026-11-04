// The cause detail for a developer (REPORT-SPEC 5.2), for a log fatal at a known file (hypothesis.fatal_recheck, re-checked by validate.js):
//   (1) the exact symbol and file:line; (2) a short, redacted excerpt of the lines around it, read from the issue's copy of the site;
//   (3) the call chain from the log's stack trace, ONLY when the log has one; (4) how many OTHER files of the same theme or plugin use the same symbol;
//   (5) classes with a similar name found in the installed provider plugin (a read-only search; worded "found in your installed X", never as a fix);
//   (6) what the tool cannot know (which provider version still has the class).
// Read-only (it only reads files of the copy), offline, deterministic (every directory listing goes through lib/sorted-dir, results are sorted, scans are capped).
// It decides nothing and assigns no status. Text taken from the site is data: it is redacted here and escaped by every renderer.

const fs = require('fs');
const path = require('path');
const readdir = require('../lib/sorted-dir');
const redact = require('../lib/redact');
const ownership = require('../lib/ownership');

const EXCERPT_BEFORE = 4, EXCERPT_AFTER = 4, LINE_CHARS = 200;   // about 9 lines around the cited line
const MAX_FILES = 20000, MAX_FILE_BYTES = 2 * 1024 * 1024, MAX_EXAMPLES = 5, MAX_CANDIDATES = 5, MAX_FRAMES = 8;
const KIND_WORD = { theme: 'theme', plugin: 'plugin', mu: 'must-use plugin' };

const clean = t => redact.text(String(t == null ? '' : t)).replace(/\t/g, '    ').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, ' ');
const cut = (t, n) => (t.length > n ? { text: `${t.slice(0, n - 1)}…`, cut: true } : { text: t, cut: false });
const escRe = s => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const shortOf = cls => String(cls).replace(/^\\/, '').split(/::|\\/).pop();
const readN = n => `${n} PHP ${n === 1 ? 'file' : 'files'} read`;
const words = name => String(name).replace(/([a-z0-9])([A-Z])/g, '$1 $2').split(/[\s_]+/).filter(Boolean).map(w => w.toLowerCase());

// the folder of the theme or plugin a file belongs to: wp-content/themes/<x> or wp-content/plugins/<x> (a must-use plugin: the mu-plugins folder)
function componentDir(file) {
    const m = /^(wp-content\/(?:themes|plugins)\/[^/]+)\//.exec(String(file || ''));
    if (m) return m[1];
    return /^wp-content\/mu-plugins\//.test(String(file || '')) ? 'wp-content/mu-plugins' : null;
}

// every PHP file below rel (no symlinks), sorted, capped. -> { files: [{ rel, abs }], complete }
function phpFiles(root, rel, max = MAX_FILES) {
    const out = { files: [], complete: true };
    const walk = (abs, r) => {
        let list; try { list = readdir(abs, { withFileTypes: true }); } catch { out.complete = false; return; }
        for (const e of list) {
            if (out.files.length >= max) { out.complete = false; return; }
            if (e.isSymbolicLink()) continue;
            const a = path.join(abs, e.name), rr = `${r}/${e.name}`;
            if (e.isDirectory()) walk(a, rr);
            else if (e.isFile() && /\.php$/i.test(e.name)) out.files.push({ rel: rr, abs: a });
        }
    };
    const res = ownership.resolveInside(root, rel);
    if (!res.ok || !fs.existsSync(res.abs) || res.symlink) { out.complete = false; return out; }
    walk(res.abs, rel);
    return out;
}
const readSmall = abs => { try { const st = fs.statSync(abs); if (st.size > MAX_FILE_BYTES) return null; return fs.readFileSync(abs, 'latin1'); } catch { return null; } };

// (2) the lines around the cited line
function excerptOf(root, file, line) {
    if (!root) return { available: false, reason: 'no copy of the site was given, so the code could not be shown' };
    const r = ownership.resolveInside(root, file);
    if (!r.ok || !fs.existsSync(r.abs) || r.symlink) return { available: false, reason: 'the file is not in the copy of the site' };
    const txt = readSmall(r.abs);
    if (txt === null) return { available: false, reason: 'the file is too large or could not be read' };
    const all = txt.split(/\r?\n/);
    if (all.length > 1 && all[all.length - 1] === '') all.pop();   // a final newline is not a line of its own
    if (!(line >= 1 && line <= all.length)) return { available: false, reason: `the file has ${all.length} lines, so line ${line} cannot be shown` };
    const from = Math.max(1, line - EXCERPT_BEFORE), to = Math.min(all.length, line + EXCERPT_AFTER);
    let capped = false;
    const lines = [];
    for (let n = from; n <= to; n++) { const c = cut(clean(all[n - 1]).replace(/\s+$/, ''), LINE_CHARS); capped = capped || c.cut; lines.push({ n, text: c.text, cited: n === line }); }
    return { available: true, file, from, to, cited: line, lines, capped };
}

// (3) the call chain: only frames the log itself wrote ("#N file.php(line): call"), from the log entry at the same file and line
function stackOf(logs, file, line) {
    const entries = ((logs && logs.entries) || []).filter(e => /fatal|parse/i.test(e.level || '') && e.file === file && Number(e.line) === Number(line));
    const withTrace = entries.find(e => (e.trace || []).length);
    // (work/logs.json keeps the parsed frames, not the raw text: a trace of only "#0 {main}" has no frame, and is reported the same way as no trace)
    if (!withTrace) return { available: false, frames: [], hooks: [], reason: entries.length ? 'the log has no stack trace with function or file names for this error' : 'the log entry for this error was not found among the saved log entries' };
    const frames = withTrace.trace.slice(0, MAX_FRAMES).map(t => ({ file: t.file, line: t.line, call: cut(clean(t.call), 160).text }));
    const hooks = [...new Set(frames.flatMap(f => [...String(f.call).matchAll(/\b(?:do_action|apply_filters|do_action_ref_array|apply_filters_ref_array)\(\s*'([^']{1,80})'/g)].map(m => m[1])))].sort();
    return { available: true, frames, hooks, more: withTrace.trace.length > frames.length ? withTrace.trace.length - frames.length : 0 };
}

// (3b) where each method of the call chain is registered: a frame "Class->method()" or "Class::method()" is looked up in the syntax-tree hook facts of the component that defines
// the class (custom-code.json `facts`, phpast.js: op, type, owner_class, hook, callback, priority, line, and the file the merge adds), with the same matching as the redirect map
// (issue/redirects.js hooksFor). Never a guessed hook name: a registration whose hook name is built at run time, a callback held in a variable, [$this, 'm'] written in another
// class (a parent or child may be meant) and a closure are "unknown". -> [{ frame, call, class, method, component, result: registered | not-registered | unknown | not-analysed, hooks, reason }]
const FRAME_CALL = /^\\?([A-Za-z_][\w\\]*)(->|::)([A-Za-z_]\w*)\(/;
const lastSeg = s => String(s || '').replace(/^\\+/, '').split('\\').pop().toLowerCase();
function registrationsOf(frames, facts, components) {
    if (!facts || typeof facts !== 'object') return [];
    const refs = Object.keys(facts).sort();
    const named = ref => { const c = (components || []).find(k => k.ref === ref); const kind = /^theme:/.test(ref) ? 'theme' : /^mu:/.test(ref) ? 'must-use plugin' : 'plugin'; return `the ${kind} ${c ? c.name || c.slug : ref.replace(/^(theme|mu|plugin):/, '')}`; };
    const out = [], seen = new Set();
    frames.forEach((f, i) => {
        const call = String(f.call || '');
        if (/\{closure/.test(call)) { if (!seen.has('{closure}')) { seen.add('{closure}'); out.push({ frame: i, call: '{closure}', class: null, method: null, component: null, result: 'unknown', hooks: [], reason: 'a closure cannot be matched to the add_action or add_filter that registers it' }); } return; }
        const m = FRAME_CALL.exec(call);
        if (!m) return;                                                  // a plain function (do_action, ...) is not a method of the site's code
        const cls = m[1].replace(/^\\/, ''), method = m[3], key = `${cls.toLowerCase()}${m[2]}${method.toLowerCase()}`;
        if (seen.has(key)) return;
        seen.add(key);
        const want = cls.toLowerCase();
        const byClass = refs.find(r => (facts[r].classes || []).some(c => String(c.name || '').replace(/^\\/, '').toLowerCase() === want));
        const ref = byClass || null;                                     // only the component whose analysed code defines the class: nothing is said about code that was not analysed
        const base = { frame: i, call: `${cls}${m[2]}${method}()`, class: cls, method, component: ref || null };
        if (!ref) { out.push({ ...base, result: 'not-analysed', hooks: [], reason: `the class ${cls} was not found in the code that was analysed` }); return; }
        const hooks = (facts[ref].hooks || []).filter(h => h.op === 'add');
        const hit = require('./redirects').hooksFor({ in: { kind: 'method', name: method, class: cls } }, hooks)
            .map(h => ({ hook: h.hook, type: h.type, priority: h.priority === undefined ? null : h.priority, file: h.file || null, line: h.line || null }))
            .sort((a, b) => (a.hook < b.hook ? -1 : a.hook > b.hook ? 1 : 0) || (a.priority || 0) - (b.priority || 0) || String(a.file).localeCompare(String(b.file)) || (a.line || 0) - (b.line || 0));
        if (hit.length) { out.push({ ...base, result: 'registered', hooks: hit, reason: null }); return; }
        // the method name is registered, but the class or the hook cannot be known from the code
        const maybe = hooks.filter(h => h.callback && h.callback.kind === 'method' && String(h.callback.name).toLowerCase() === method.toLowerCase() && (!h.hook
            || /^\$/.test(String(h.callback.class)) || h.callback.class === 'parent' || (['$this', 'self', 'static'].includes(h.callback.class) && lastSeg(h.owner_class) !== lastSeg(cls))));
        if (maybe.length) { out.push({ ...base, result: 'unknown', hooks: [], reason: `${named(ref)} registers a method called ${method}, but which class or which WordPress step it belongs to cannot be known from the code` }); return; }
        out.push({ ...base, result: 'not-registered', hooks: [], reason: `no add_action or add_filter names this method in ${named(ref)}` });
    });
    return out;
}
const regText = r => (r.result === 'registered' ? `registered on ${r.hooks.map(h => `${h.hook} at ${h.priority === null ? 'an unknown priority' : `priority ${h.priority}`} (${h.file ? `${h.file}, ` : ''}line ${h.line})`).join(' and on ')}` : r.result === 'unknown' ? `unknown (${r.reason})` : r.reason);

// (4) other files of the same theme or plugin that use the same symbol
function sameSymbol(root, fr, compName) {
    const dir = componentDir(fr.file);
    if (!root || !dir) return { searched: false, reason: !root ? 'no copy of the site was given' : 'the file does not belong to a theme or plugin folder' };
    const list = phpFiles(root, dir);
    const full = String(fr.class).replace(/^\\/, '').toLowerCase();
    const fnRe = fr.kind === 'function' ? new RegExp(`(?<![\\w$>:\\\\])${escRe(shortOf(fr.class))}\\s*\\(`, 'i') : null;
    const defRe = fr.kind === 'function' ? new RegExp(`function\\s+&?\\s*${escRe(shortOf(fr.class))}\\s*\\(`, 'i') : null;
    const hits = [];
    let read = 0, unread = 0;
    for (const f of list.files) {
        if (f.rel === fr.file) continue;
        const t = readSmall(f.abs);
        if (t === null) { unread++; continue; }
        read++;
        const uses = fnRe ? t.split('\n').some(l => fnRe.test(l) && !defRe.test(l)) : t.replace(/\\\\/g, '\\').toLowerCase().includes(full);
        if (uses) hits.push(f.rel);
    }
    return { searched: true, component_dir: dir, component_name: compName || null, files_read: read, files_unread: unread, complete: list.complete && !unread, count: hits.length, examples: hits.slice(0, MAX_EXAMPLES) };
}

// (5) classes with a similar name, defined in the installed provider plugin. "Similar": the same short name in another namespace, or a name whose words start with every word of
// the missing short name (Color -> Global_Colors). Ranked: same short name first, then the most shared namespace parts, then by name. Never a claim that it replaces the missing class.
function candidatesOf(root, fr) {
    const p = fr.provider || {};
    if (fr.kind === 'function') return { searched: false, reason: 'function' };
    if (!p.known) return { searched: false, reason: 'unknown-provider' };
    if (!p.installed) return { searched: false, reason: 'not-installed', provider: p.name };
    if (!root) return { searched: false, reason: 'no-copy', provider: p.name };
    const dir = `wp-content/${p.kind === 'theme' ? 'themes' : 'plugins'}/${p.slug}`;
    const list = phpFiles(root, dir);
    const missing = String(fr.class).replace(/^\\/, ''), mShort = shortOf(missing), mWords = words(mShort), mNs = missing.toLowerCase().split('\\').slice(0, -1);
    const defRe = /(?:^|[\s;{}])(?:(?:abstract|final|readonly)\s+)*(class|interface|trait|enum)\s+([A-Za-z_][A-Za-z0-9_]*)/gm;
    const found = new Map();
    let unread = 0;
    for (const f of list.files) {
        const t = readSmall(f.abs);
        if (t === null) { unread++; continue; }
        const ns = (/\bnamespace\s+([\w\\]+)\s*[;{]/.exec(t) || [])[1] || '';
        for (const m of t.matchAll(defRe)) {
            const name = m[2], w = words(name);
            const same = name.toLowerCase() === mShort.toLowerCase();
            const similar = same || (mWords.length && mWords.every(x => w.some(y => y.startsWith(x))));
            if (!similar) continue;
            const fullName = ns ? `${ns}\\${name}` : name;
            if (fullName.toLowerCase() === missing.toLowerCase() || found.has(fullName)) continue;
            const shared = ns.toLowerCase().split('\\').filter((s, i) => mNs[i] === s).length;
            found.set(fullName, { name: fullName, kind: m[1], file: f.rel, same_short_name: same, shared_namespace_parts: shared });
        }
    }
    const ranked = [...found.values()].sort((a, b) => (b.same_short_name - a.same_short_name) || (b.shared_namespace_parts - a.shared_namespace_parts) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    return { searched: true, provider: p.name, version: p.version || null, files_read: list.files.length - unread, complete: list.complete && !unread, found: ranked.slice(0, MAX_CANDIDATES).map(c => ({ ...c, verified: false })), more: Math.max(0, ranked.length - MAX_CANDIDATES) };
}

// fr: hypothesis.fatal_recheck. ctx: { root, logs (work/logs.json), components } -> the cause_detail object (findings.json) with its plain lines
function build(fr, { root = null, logs = null, components = [], facts = null } = {}) {
    if (!fr || !fr.file || !fr.line || !fr.class) return null;
    const isFn = fr.kind === 'function';
    const kind = KIND_WORD[fr.file_kind] || 'file';
    const dir = componentDir(fr.file), slug = dir ? dir.split('/').pop() : null;
    const comp = slug ? (components || []).find(c => c.slug === slug && (fr.file_kind === 'theme' ? c.kind === 'theme' : c.kind !== 'theme')) : null;
    const compName = comp ? (comp.name || comp.slug) : slug;
    const who = compName ? `the ${kind} ${compName}` : `the ${kind}`;
    const symbolText = isFn ? `the function ${fr.class}()` : `the class ${fr.class}`;
    const excerpt = excerptOf(root, fr.file, fr.line);
    const stack = stackOf(logs, fr.file, fr.line);
    if (stack.available) stack.registrations = registrationsOf(stack.frames, facts, components);
    const same = sameSymbol(root, fr, compName);
    const cand = candidatesOf(root, fr);
    const p = fr.provider || {};
    const L = [];
    L.push(`Symbol: ${symbolText}, at ${fr.file}:${fr.line}.`);
    L.push(excerpt.available ? `Code around line ${fr.line}, read from the copy of your site (lines ${excerpt.from} to ${excerpt.to}; anything that looks like a password or key is masked${excerpt.capped ? '; long lines are shortened' : ''}).` : `Code around line ${fr.line}: not shown, because ${excerpt.reason}.`);
    if (stack.available) {
        L.push(`Call chain from your log, most recent call first: ${stack.frames.map((f, i) => `#${i} ${f.call} (${f.file}:${f.line})`).join('; ')}${stack.more ? `; and ${stack.more} more` : ''}.`);
        const regs = (stack.registrations || []).filter(r => r.result !== 'not-analysed'), skippedRegs = (stack.registrations || []).filter(r => r.result === 'not-analysed');
        if (regs.length) L.push(`Where the methods in that call chain are registered: ${regs.map(r => `#${r.frame} ${r.call}: ${regText(r)}`).join('; ')}${skippedRegs.length ? `; not looked up, because their code was not analysed: ${skippedRegs.map(r => r.call).join(', ')}` : ''}.`);
        if (stack.hooks.length) L.push(`WordPress steps named in that call chain: ${stack.hooks.join(', ')}.`);
    } else L.push(`Call chain: ${stack.reason}, so the calls that led to it are not known.`);
    if (same.searched) {
        const incomplete = same.complete ? '' : ' (not every file could be read, so there may be more)';
        L.push(same.count ? `Other files of ${who} that use ${symbolText}: ${same.count} (${readN(same.files_read)}${same.count > same.examples.length ? `; the first ${same.examples.length} shown` : ''}): ${same.examples.join(', ')}${incomplete}.`
            : `Other files of ${who} that use ${symbolText}: none (${readN(same.files_read)})${incomplete}.`);
    } else L.push(`Other files that use ${symbolText}: not searched, because ${same.reason}.`);
    if (cand.searched) {
        const pv = `${cand.provider}${cand.version ? ` ${cand.version}` : ''}`;
        if (cand.found.length) L.push(`Classes with a similar name, found in your installed ${pv} (only a name match; not checked as a replacement and not a fix): ${cand.found.map(c => `${c.name} (${c.file})`).join('; ')}${cand.more ? `; and ${cand.more} more` : ''}.`);
        else L.push(`No class with a similar name was found in your installed ${pv} (${readN(cand.files_read)}${cand.complete ? '' : '; not every file could be read'}).`);
    } else if (cand.reason === 'not-installed') L.push(`${cand.provider} is not installed, so its files could not be searched for a class with a similar name.`);
    else if (cand.reason === 'no-copy') L.push(`No copy of the site was given, so ${cand.provider} could not be searched for a class with a similar name.`);
    else if (cand.reason === 'unknown-provider') L.push('Which plugin this class belongs to could not be identified, so no installed plugin was searched for a class with a similar name.');
    const unknown = [];
    if (!isFn && p.known) unknown.push(`Which version of ${p.name} still has ${fr.class} cannot be known from your copy: only the installed version${p.version ? ` (${p.version})` : ''} was read, and older versions are not available to the tool.`);
    else if (!isFn) unknown.push(`Which plugin or version still has ${fr.class} cannot be known from your copy.`);
    else unknown.push(`Which plugin or version provides ${fr.class}() cannot be known from your copy.`);
    L.push(...unknown);
    return { symbol: { kind: isFn ? 'function' : 'class', name: fr.class, short: shortOf(fr.class) }, location: { file: fr.file, line: fr.line, component: compName || null }, excerpt, stack, same_symbol: same, candidates: cand, unknown, lines: L };
}

// the excerpt as plain text lines ("  47 | code", the cited line marked with ">")
function excerptLines(ex) {
    if (!ex || !ex.available) return [];
    const w = String(ex.to).length;
    return ex.lines.map(l => `${l.cited ? '>' : ' '} ${String(l.n).padStart(w)} | ${l.text}`);
}

module.exports = { build, excerptLines, componentDir, registrationsOf, EXCERPT_BEFORE, EXCERPT_AFTER };
