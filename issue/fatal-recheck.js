// Re-checks one kind of log fatal on the files of the site: "Class X not found" raised at file F, line L. Called ONLY by issue/validate.js, which alone turns the result
// into a status. Read-only, offline, deterministic; nothing here writes a file or assigns a verdict.
//
//   Rule A  (the fatal is fresh and the live page broke): F is re-read, line L (+-2) names X, the fatal repeats (>= 2 identical log entries), the fatal's timestamp is within
//           24 hours of the probe run (`probe_ran_at` in the issue file; the issue's creation if there was no probe) and the probe saw HTTP 5xx on the same site   -> supports "fatal-site" + "probe-5xx"
//   Rule B  (nothing defines the class): same first three facts, and a full scan of every PHP file of the copy finds no class / interface / trait / enum / class_alias for X.
//           Only if the copy skipped NO PHP file (wp-config*.php excepted), every file could be read, and no component failed to parse; X must carry a namespace (an
//           unnamespaced name may be PHP's or WordPress's own, which a plugin copy does not contain)                           -> supports "fatal-site" + "class-undefined"
//   Provider: a fixed map of well-known namespaces to a plugin. A guess from the first namespace segment is only a hint and never produces "does not contain".
//   "does not contain" is said only for a known provider that is installed and whose files were part of a complete scan that found no definition.

const fs = require('fs');
const path = require('path');
const readdir = require('../lib/sorted-dir');
const ownership = require('../lib/ownership');

const DAY = 24 * 3600 * 1000;
const MAX_FILE = 2 * 1024 * 1024, MAX_FILES = 120000;
const WINDOW = 2;                                            // lines around the cited line in which the class must be named

// longest prefix first. kind: what the provider is. Divi is a theme (or the divi-builder plugin).
const PROVIDERS = [
    { re: /^automattic\\woocommerce\\/i, slug: 'woocommerce', name: 'WooCommerce', kind: 'plugin' },
    { re: /^woocommerce\\/i, slug: 'woocommerce', name: 'WooCommerce', kind: 'plugin' },
    { re: /^elementorpro\\/i, slug: 'elementor-pro', name: 'Elementor Pro', kind: 'plugin' },
    { re: /^elementor\\/i, slug: 'elementor', name: 'Elementor', kind: 'plugin' },
    { re: /^yoast\\wp\\/i, slug: 'wordpress-seo', name: 'Yoast SEO', kind: 'plugin' },
    { re: /^acf\\/i, slug: 'advanced-custom-fields', name: 'Advanced Custom Fields', kind: 'plugin' },
    { re: /^et_/i, slug: 'divi', name: 'Divi', kind: 'theme', alt: ['divi-builder'] },
    { re: /^et\\/i, slug: 'divi', name: 'Divi', kind: 'theme', alt: ['divi-builder'] }
];

const esc = s => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const shortOf = cls => String(cls).replace(/^.*\\/, '');
const kindOfFile = f => (/^wp-content\/themes\//.test(f) ? 'theme' : /^wp-content\/mu-plugins\//.test(f) ? 'mu' : 'plugin');
const KIND_WORD = { theme: 'theme', plugin: 'plugin', mu: 'must-use plugin' };

// ---------- definition scan ----------
// -> { defined: [{ file, component }], scanned, unread: [rel], complete }
function findDefinition(root, cls, { maxFiles = MAX_FILES } = {}) {
    const out = { defined: [], scanned: 0, unread: [], complete: true };
    const wanted = String(cls).replace(/^\\/, '').toLowerCase(), short = shortOf(wanted);
    const defRe = new RegExp(`(?:^|[\\s;{}])(?:(?:abstract|final|readonly)\\s+)*(?:class|interface|trait|enum)\\s+${esc(short)}\\b`, 'im');
    const aliasRe = new RegExp(`class_alias\\s*\\([^;]*?['"]\\\\?${esc(wanted)}['"]`, 'i');
    const roots = ['wp-content/plugins', 'wp-content/themes', 'wp-content/mu-plugins', 'wp-includes'];
    let seen = 0;
    const walk = (abs, rel) => {
        let list; try { list = readdir(abs, { withFileTypes: true }); } catch { out.unread.push(rel); out.complete = false; return; }
        for (const e of list) {
            const a = path.join(abs, e.name), r = `${rel}/${e.name}`;
            if (e.isSymbolicLink()) continue;
            if (e.isDirectory()) { walk(a, r); continue; }
            if (!e.isFile() || !/\.php$/i.test(e.name)) continue;
            if (++seen > maxFiles) { out.complete = false; return; }
            let st; try { st = fs.statSync(a); } catch { out.unread.push(r); out.complete = false; continue; }
            if (st.size > MAX_FILE) { out.unread.push(r); out.complete = false; continue; }
            let txt; try { txt = fs.readFileSync(a, 'latin1'); } catch { out.unread.push(r); out.complete = false; continue; }
            out.scanned++;
            const low = txt.toLowerCase();
            if (!low.includes(short)) continue;
            const flat = txt.replace(/\\\\/g, '\\');
            if (aliasRe.test(flat.toLowerCase())) { out.defined.push({ file: r, component: ownership.componentOf(r) || null }); continue; }
            if (!defRe.test(txt)) continue;
            const spaces = [...txt.matchAll(/\bnamespace\s+([\w\\]+)\s*[;{]/gi)].map(m => m[1].toLowerCase());
            const hit = spaces.length ? spaces.some(ns => `${ns}\\${short}` === wanted) : wanted === short;
            if (hit) out.defined.push({ file: r, component: ownership.componentOf(r) || null });
        }
    };
    for (const base of roots) { const abs = path.join(root, base); if (fs.existsSync(abs)) walk(abs, base); }
    return out;
}

// ---------- provider ----------
// components: custom-code.json components ({ ref, kind, slug, name, version }); active: Set of slugs, or null when not known
function providerOf(cls, components, active) {
    const name = String(cls).replace(/^\\/, '');
    const find = (slug, kind) => components.find(c => c.slug === slug && (!kind || c.kind === kind)) || null;
    for (const p of PROVIDERS) {
        if (!p.re.test(name)) continue;
        const comp = find(p.slug, p.kind) || (p.alt || []).map(s => find(s)).find(Boolean) || null;
        return { known: true, source: 'map', slug: comp ? comp.slug : p.slug, name: p.name, kind: p.kind, installed: !!comp, version: comp && comp.version ? String(comp.version) : null,
            active: comp && active ? active.has(comp.slug) : null };
    }
    // a guess from the first namespace segment (or the prefix before "_"): a hint only
    const seg = (name.includes('\\') ? name.split('\\')[0] : name.split('_')[0]).toLowerCase().replace(/[^a-z0-9]/g, '');
    if (seg.length >= 4) {
        const hit = components.find(c => { const s = String(c.slug || '').toLowerCase().replace(/[^a-z0-9]/g, ''); return s === seg || s.startsWith(seg) || String(c.name || '').toLowerCase().replace(/[^a-z0-9]/g, '').startsWith(seg); });
        if (hit) return { known: false, source: 'guess', slug: hit.slug, name: hit.name || hit.slug, kind: hit.kind, installed: true, version: hit.version ? String(hit.version) : null, active: null };
    }
    return { known: false, source: null, slug: null, name: null, kind: null, installed: null, version: null, active: null };
}

const dateOf = iso => { const d = new Date(iso); return Number.isNaN(d.getTime()) ? null : `${d.getUTCDate()} ${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getUTCMonth()]} ${d.getUTCFullYear()}`; };
const hostOf = u => { try { return new URL(u).host.toLowerCase(); } catch { return ''; } };

// -> null when the hypothesis is not a "class not found" fatal at a known file, else { ... } (see the bottom of the function)
function recheck({ h, clues, root, probe, issue, intake, components = [], sandbox = null, scan = findDefinition }) {
    const logSupport = (h.supports || []).find(s => s.kind === 'log');
    const byId = new Map((clues || []).map(c => [c.id, c]));
    const clue = logSupport && byId.get(logSupport.ref);
    if (!clue || !['php-class-not-found', 'php-undefined-function'].includes(clue.type)) return null;
    const isFn = clue.type === 'php-undefined-function';
    const loc = require('./clues').locationOf(clue, clues);
    if (!loc) return null;
    const cls = clue.value, file = loc.detail.file, line = loc.detail.line;   // `cls` is the class, or the function / method for a "Call to undefined" fatal
    const fileKind = kindOfFile(file);
    const checks = [], log = (clue.detail && clue.detail.log) || {};
    const res = { kind: isFn ? 'function' : 'class', class: cls, file, line, file_kind: fileKind, count: log.count || 1, last_seen: log.last_seen || null, checks, rule: null, supports: [], line_ok: false, repeated: false, provider: null, scan: null, blocked: null, text: null };
    const add = (id, status, reason) => checks.push({ id, status, reason });

    // 1. the cited file and line, re-read
    const r = root ? ownership.resolveInside(root, file) : { ok: false, reason: 'no local copy of the site' };
    let lines = null;
    if (!r.ok) add('fatal-file', 'FAILED', `the file named in the log is not in the copy (${r.reason})`);
    else if (!fs.existsSync(r.abs)) add('fatal-file', 'FAILED', 'the file named in the log is not in the copy');
    else { try { if (fs.statSync(r.abs).size > 3 * 1024 * 1024) add('fatal-file', 'NOT_RUN', 'the file is too large to re-read'); else lines = fs.readFileSync(r.abs, 'utf8').split('\n'); } catch { add('fatal-file', 'NOT_RUN', 'the file could not be read'); } }
    if (lines) {
        if (!(line >= 1 && line <= lines.length)) add('fatal-line', 'FAILED', `the file has ${lines.length} lines, so line ${line} does not exist`);
        else {
            const short = isFn ? String(cls).split(/::|\\/).pop() : shortOf(cls), full = cls.replace(/^\\/, '');
            const named = lines.slice(Math.max(0, line - 1 - WINDOW), Math.min(lines.length, line + WINDOW)).some(l => l.replace(/\\\\/g, '\\').toLowerCase().includes(full.toLowerCase()) || new RegExp(`(^|[^\\w$])${esc(short)}\\b`, 'i').test(l));
            res.line_ok = named;
            add('fatal-line', named ? 'PASSED' : 'FAILED', named ? `line ${line} of ${file} (re-read) names ${short}` : `no line within ${WINDOW} lines of ${line} in ${file} names ${short}`);
        }
    }
    res.repeated = res.count >= 2;
    add('fatal-repeats', res.repeated ? 'PASSED' : 'FAILED', res.repeated ? `the same fatal is in the log ${res.count} times` : 'the fatal is in the log only once');
    const sound = res.line_ok && res.repeated;
    res.sound = !!sound;                          // what the "most likely cause" tier needs: file and line re-read, class / function named there, fatal repeated
    if (isFn) { res.provider = { known: false, source: null, slug: null, name: null, kind: null, installed: null, version: null, active: null }; res.text = wording(res, { probeSaw5xx: false, fresh: null }); return res; }

    // 2. the provider
    const active = sandbox && sandbox.baseline && Array.isArray(sandbox.baseline.active_plugins) ? new Set(sandbox.baseline.active_plugins) : null;
    res.provider = providerOf(cls, components, active);

    // 3. Rule A: the live page broke, and the fatal is fresh enough to be about the same breakage
    const pages = (probe && Array.isArray(probe.pages) ? probe.pages : []).filter(p => p && p.status >= 500 && p.status < 600 && (!issue.url || !p.url || hostOf(p.url) === hostOf(issue.url)));
    const refTime = issue.probe_ran_at || issue.created_at || null;
    if (!pages.length) add('probe-5xx', probe && probe.pages && probe.pages.length ? 'FAILED' : 'NOT_RUN', probe && probe.pages && probe.pages.length ? 'the live probe saw no HTTP 5xx' : 'no live probe ran');
    else add('probe-5xx', 'PASSED', `the live probe saw HTTP ${pages[0].status} on ${pages[0].url || 'the site'}`);
    let fresh = null;
    if (res.last_seen && refTime) { const dt = Math.abs(new Date(res.last_seen) - new Date(refTime)); fresh = Number.isFinite(dt) && dt <= DAY; }
    add('fatal-fresh', fresh === null ? 'NOT_RUN' : fresh ? 'PASSED' : 'FAILED', fresh === null ? 'the fatal or the reference time has no timestamp' : fresh ? `the fatal (${res.last_seen}) is within 24 hours of the ${issue.probe_ran_at ? 'probe run' : 'issue creation'}` : `the fatal (${res.last_seen}) is more than 24 hours away from the ${issue.probe_ran_at ? 'probe run' : 'issue creation'}, so it is not paired with the live ${pages.length ? 'HTTP ' + pages[0].status : 'page'}`);
    const ruleA = sound && pages.length > 0 && fresh === true;

    // 4. Rule B: nothing in the copy defines the class
    let ruleB = false;
    const namespaced = cls.replace(/^\\/, '').includes('\\') || PROVIDERS.some(p => p.kind === 'theme' && p.re.test(cls));
    if (sound) {
        const php = intake && Number(intake.php_skipped) > 0 ? intake : null;
        const failedParse = components.filter(c => c.files && (c.files.failed > 0 || c.files.lint_broken > 0)).map(c => c.ref)   // a file the code analysis could not parse; its own file cap (`truncated`) does not matter here: the definition search below reads every file itself;
        if (!namespaced) res.blocked = 'the class has no namespace, so it may be built into PHP or WordPress, which the copy does not contain';
        else if (php) res.blocked = `could not check all code: the copy left out ${intake.php_skipped} PHP file(s) (${(intake.php_skipped_examples || []).slice(0, 3).join(', ')})`;
        else if (failedParse.length) res.blocked = `could not check all code: ${failedParse.slice(0, 3).join(', ')} could not be fully parsed`;
        if (res.blocked) add('class-undefined', 'NOT_RUN', res.blocked);
        else {
            const d = scan(root, cls);
            res.scan = { scanned: d.scanned, complete: d.complete, unread: d.unread.length, defined: d.defined };
            if (!d.complete) { res.blocked = `could not check all code: ${d.unread.length} PHP file(s) could not be read`; add('class-undefined', 'NOT_RUN', res.blocked); }
            else if (d.defined.length) add('class-undefined', 'FAILED', `${shortOf(cls)} is defined in ${[...new Set(d.defined.map(x => String(x.component || x.file).replace(/^plugin:/, '')))].slice(0, 3).join(', ')}`);
            else { ruleB = true; add('class-undefined', 'PASSED', `${d.scanned} PHP files of the copy were read and none defines ${cls}`); }
        }
    }

    // 5. result
    if (ruleA) { res.rule = 'A'; res.supports = ['fatal-site', 'probe-5xx']; }
    else if (ruleB) { res.rule = 'B'; res.supports = ['fatal-site', 'class-undefined']; }
    res.text = wording(res, { probeSaw5xx: pages.length > 0, fresh, probe: !!(probe && probe.pages && probe.pages.length) });
    return res;
}

// the plain words. `cause` completes "The cause: ..." (no capital, no full stop); `lines` are whole sentences for the report.
function wording(r, { probeSaw5xx, fresh }) {
    const p = r.provider, kind = KIND_WORD[r.file_kind], where = `${r.file}:${r.line}`;
    const defined = r.scan && r.scan.defined && r.scan.defined.length ? r.scan.defined : null;
    const absent = r.scan && r.scan.complete && !defined;
    const lines = [], head = `The ${kind} file ${where} calls the class ${r.class}`;
    let cause;
    if (r.kind === 'function') {
        cause = `the ${kind} file ${where} calls the function ${r.class}(), which was not defined when it ran`;
        lines.push(`The ${kind} file ${where} calls the function ${r.class}(), which was not defined when it ran.`);
        return { cause, lines };
    }
    if (p.known && p.installed && absent) {
        cause = `the ${kind} file ${where} calls the class ${r.class}, which ${p.name}${p.version ? ` ${p.version}` : ''} does not contain`;
        lines.push(`${head}, which ${p.name}${p.version ? ` ${p.version}` : ''} does not contain.`);
        if (p.version) lines.push(`This usually means the ${kind} was written for an older version of ${p.name}.`);
        if (p.active === false) lines.push(`${p.name} is installed but switched off.`);
    } else if (p.known && p.installed === false) {
        cause = `the ${kind} file ${where} calls the class ${r.class}, which comes from ${p.name}, which is not installed`;
        lines.push(`${head}, which comes from ${p.name}, which is not installed.`);
    } else if (defined) {
        const who = [...new Set(defined.map(x => String(x.component || x.file).replace(/^plugin:/, '')))].slice(0, 2).join(', ');
        cause = `the ${kind} file ${where} calls the class ${r.class}, which is defined in ${who} but was not available when it ran`;
        lines.push(`${head}, which is defined in ${who}.`);
        if (p.known && p.installed) lines.push(p.active === false ? `${p.name} is installed but switched off.` : p.active === true ? `${p.name} is installed and active.` : `Whether ${p.name} is switched on is not known.`);
    } else {
        cause = `the ${kind} file ${where} calls the class ${r.class}, which was not found when it ran`;
        lines.push(`${head}, which was not found when it ran.`);
        if (p.source === 'guess') lines.push(`This class normally comes from ${p.name || p.slug} (a guess from its name, not checked).`);
        else if (!p.known) lines.push("The class's owner could not be identified.");
        else if (p.known && p.installed) lines.push(`This class normally comes from ${p.name}${p.version ? ` ${p.version}` : ''}; whether it contains the class was not checked.`);
    }
    if (r.blocked && /could not check all code/.test(r.blocked)) lines.push(r.blocked.replace(/^could not check all code: ?/, 'Could not check all code: ').replace(/^Could not check all code: (?!$)/, 'Could not check all code: ') + '.');
    else if (r.blocked) lines.push(`${r.blocked.charAt(0).toUpperCase()}${r.blocked.slice(1)}.`);
    if (r.rule === 'B' && !probeSaw5xx) lines.push(`Seen in your log on ${dateOf(r.last_seen) || 'an unknown date'}, not checked live.`);
    else if (r.rule === 'B' && fresh === false) lines.push(`Seen in your log on ${dateOf(r.last_seen) || 'an unknown date'}; the live page answered HTTP 5xx, but that is more than 24 hours away from the log entry, so the two are not paired.`);
    return { cause, lines };
}

module.exports = { recheck, findDefinition, providerOf, wording, PROVIDERS, kindOfFile };
