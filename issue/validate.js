// Phase H, the "Agent 3" step of issue mode: a separate module that re-reads the evidence the producer cited and decides the final status.
// The producer (hypotheses.js) only ever emits UNVERIFIED / PROBABLE_NEEDS_REVIEW. This module alone assigns CONFIRMED, REPRODUCIBLE and
// REJECTED_FALSE_POSITIVE (FIXED_VERIFIED is assigned only by `issue retest`, see retest.js). It trusts neither the hypothesis nor the
// observation: it re-opens each cited file, looks for the construct near the cited line, re-runs `php -l`, recomputes ownership from the
// policy, re-reads work/bisect.json, and re-evaluates the oracle from the stored probe observations. Local and read-only; no network.

const fs = require('fs');
const path = require('path');
const ownership = require('../lib/ownership');
const phpast = require('./phpast');
const fatalRecheck = require('./fatal-recheck');

// What each cited evidence line must contain. THE KNOWN TRAP: this map must be at least as broad as what the scanner (phpast.js) records,
// otherwise true findings are rejected. Hence: a leading backslash and whitespace before "(" are allowed (\add_action ( ... )), the whole
// add/remove and register/enqueue/dequeue/deregister families are accepted, and admin_post_* / wp_ajax_* hooks are ordinary add_action calls.
const CALL = name => new RegExp(`(^|[^\\w$>:])\\\\?(?:${name})\\s*\\(`, 'i');
const KEYWORD = {
    removes: CALL('remove_(?:action|filter)'),
    adds: CALL('add_(?:action|filter)'),
    asset: CALL('wp_(?:enqueue|register|dequeue|deregister)_(?:script|style)'),
    localize: CALL('wp_localize_script|wp_add_inline_script'),
    registry: /->\s*add\s*\(/,                       // $scripts->add( ... ) in WordPress's own script-loader.php
    template: /@version|\bdo_action\b|<\?php|<[a-z]/i,
    shortcode: CALL('add_shortcode'),
    rest: CALL('register_rest_route')
};
// one entry per observation type that custom.js adds in step 5 (the scanner records shortcodes, AJAX hooks, REST routes, assets and define())
const TYPE_KEYWORD = {
    'duplicate-shortcode': KEYWORD.shortcode, 'duplicate-rest-route': KEYWORD.rest, 'duplicate-ajax-action': KEYWORD.adds,
    'duplicate-script-handle': KEYWORD.asset, 'duplicate-constant': CALL('define'),
    'redirect-on-hook': CALL('wp_redirect|wp_safe_redirect|header'), 'requires-php-mismatch': /Requires PHP/i, 'requires-wp-mismatch': /Requires at least/i, 'tested-up-to-older': /Tested up to/i
};
const ASSET_ROLES = /^(enqueue|register|dequeue|deregister|registers replacement)$/;
const declaration = (kind, name) => { const short = String(name).replace(/^.*\\/, '').replace(/[^\w]/g, ''); return kind === 'class' ? new RegExp(`\\b(?:class|interface|trait|enum)\\s+${short}\\b`, 'i') : new RegExp(`\\bfunction\\s+&?\\s*${short}\\s*\\(`, 'i'); };

// -> the regex the cited line must match, or null when this evidence has no checkable construct
function keywordFor(h, ev) {
    if (h.type === 'duplicate-declaration' && h.declaration) return declaration(h.declaration.kind, h.declaration.name);
    // step 5: the cross-component comparisons and the classic adapter. A pattern comes from checks/integrity.js (the tool's own data), never from the site.
    if (TYPE_KEYWORD[h.type]) return TYPE_KEYWORD[h.type];
    if (h.type === 'removed-function-call' && h.function) return CALL(String(h.function).replace(/[^\w]/g, ''));
    if (h.class === 'compromise' && h.pattern && h.pattern.source) { try { return new RegExp(h.pattern.source, h.pattern.flags || ''); } catch { return null; } }
    if (ev.role === 'removes') return KEYWORD.removes;
    if (ev.role === 'adds') return KEYWORD.adds;
    if (ev.role === 'declares' && h.callback) return declaration('function', h.callback);
    if (ASSET_ROLES.test(ev.role || '')) return KEYWORD.asset;
    if (h.type === 'localize-object-collision') return KEYWORD.localize;
    if (h.type === 'dependency-handle-not-registered') return KEYWORD.asset;
    if (h.type === 'template-override-outdated') return KEYWORD.template;
    return null;
}


const store = require('../lib/issue-store');
const cfgLib = require('../lib/config');
const oracleLib = require('./oracle');

const NEAR = 6;                                            // the construct must be within this many lines of the cited line
const DETERMINISTIC = new Set(['log', 'observation', 'collision', 'probe', 'bisect']);
const readJson = f => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
const check = (id, status, reason) => ({ id, status, reason });

function policyFor(root, config) {
    const cfg = cfgLib.resolve({ root, config: config || undefined });
    if (cfg.errors.length) { const e = new Error(cfg.errors.join('\n')); e.exitCode = 2; throw e; }
    return cfg.config.policy || ownership.loadPolicy(root, {}).policy;
}

// One cited file:line. -> { file, line, status: verified | missing | construct-absent | unchecked | rejected-path, ownership }
function verifyEvidence(h, ev, root, policy, lint) {
    const out = { file: ev.file, line: ev.line || null, role: ev.role || null, status: 'unchecked', reason: null, ownership: null };
    if (!ev.file) { out.reason = 'no file cited'; return out; }
    const cls = ownership.classify(policy, ev.file);
    out.ownership = cls.owner;
    const r = ownership.resolveInside(root, ev.file);
    if (!r.ok) { out.status = 'rejected-path'; out.reason = r.reason; return out; }
    if (!fs.existsSync(r.abs)) { out.status = 'missing'; out.reason = 'the cited file does not exist'; return out; }
    if (h.type === 'syntax-error') {
        const l = lint(r.abs);
        if (l === null) { out.reason = 'php is not installed, so php -l could not be re-run'; return out; }
        out.status = l.ok ? 'construct-absent' : 'verified'; out.reason = l.ok ? 'php -l now passes: the syntax error is gone (fixed since, or never real)' : `php -l re-run: ${l.message}`; return out;
    }
    let lines; try { if (fs.statSync(r.abs).size > 3 * 1024 * 1024) { out.reason = 'file too large to re-read'; return out; } lines = fs.readFileSync(r.abs, 'utf8').split('\n'); } catch { out.reason = 'file could not be read'; return out; }
    const kw = keywordFor(h, ev);
    if (!kw) { out.reason = 'file exists; this kind of evidence has no construct to look for'; out.status = 'verified-file-only'; return out; }
    const lo = ev.line ? Math.max(0, ev.line - 1 - NEAR) : 0, hi = ev.line ? Math.min(lines.length, ev.line + NEAR) : lines.length;
    const hit = lines.slice(lo, hi).findIndex(l => kw.test(l));
    if (hit < 0) { out.status = 'construct-absent'; out.reason = `no line within ${NEAR} lines of ${ev.line || 'the file'} matches ${kw}`; return out; }
    out.status = 'verified'; out.reason = `construct found at line ${lo + hit + 1}`; out.found_line = lo + hit + 1;
    return out;
}

// -> { hypotheses: [...with final status], checks, ... } and writes work/validation.json. Pure function of the files on disk.
function run(id, { root, config = null, lint = phpast.phpLint } = {}) {
    const issue = store.load(id), dir = store.dirOf(id);
    const W = f => path.join(dir, 'work', f);
    const hyp = readJson(W('hypotheses.json')), ev = readJson(W('evidence.json')) || { clues: [] }, bis = readJson(W('bisect.json')), sbx = readJson(W('sandbox.json')), probe = readJson(W('probe.json'));
    const checks = [];
    if (!hyp) return { hypotheses: [], checks: [check('hypotheses', 'NOT_RUN', 'work/hypotheses.json is missing: run issue investigate first')] };
    if (!root) checks.push(check('sources', 'NOT_RUN', 'no local copy of the site (--root): the cited files cannot be re-read, so nothing can be CONFIRMED from code'));
    const policy = root ? policyFor(root, config) : null;
    const clueById = new Map((ev.clues || []).map(c => [c.id, c]));

    // ---- the oracle, recomputed from the stored observations (never from the stored verdict) ----
    let oracle = { recomputed: null, stored: probe && probe.oracle ? probe.oracle.result : null, agrees: null };
    if (probe && probe.oracle && Array.isArray(probe.pages) && probe.pages.length && probe.pages.every(p => p.viewport && typeof p.loaded === 'boolean')) {
        const again = oracleLib.evaluate(issue.oracle, { pages: probe.pages.map(p => ({ console_errors: [], page_errors: [], error_responses: [], ...p })), planned: probe.planned || probe.pages.length, protection: probe.protection || null, debug_log: probe.debug_log || null }, { needsLogin: issue.needs_login, symptom: issue.symptom });
        oracle = { recomputed: again.result, stored: probe.oracle.result, agrees: again.result === probe.oracle.result };
        checks.push(check('oracle', oracle.agrees ? 'PASSED' : 'FAILED', oracle.agrees ? `recomputed from the stored page observations: ${again.result}` : `the stored answer was "${probe.oracle.result}" but the observations give "${again.result}"`));
    } else checks.push(check('oracle', 'NOT_RUN', probe ? 'work/probe.json holds no page observations to recompute from' : 'no live probe ran'));
    let symptom = oracle.agrees === false ? 'could-not-test' : (oracle.recomputed || (sbx && sbx.reproduced_in_sandbox === 'yes' ? 'yes' : sbx && sbx.reproduced_in_sandbox === 'no' ? 'no' : (hyp.symptom_reproduced && hyp.symptom_reproduced.result) || 'not-tested'));
    // "Not reproduced" is a real answer, with ONE exception: the problem is a crash AND a probed page the report is about answered HTTP 5xx. Then the page did fail, whatever the
    // oracle looked at (a debug-log oracle sees no new line when the fatal was logged earlier), so the symptom counts as reproduced and the cap that "not reproduced" puts on every
    // hypothesis does not apply. An unrelated 5xx (a page the report is not about) does not lift it, and "ran and did not reproduce" on a page that answered fine still downgrades.
    const symptomBefore = symptom;
    if ((symptom === 'no' || symptom === 'could-not-test') && issue.symptom === 'white-screen' && probe && Array.isArray(probe.pages)) {
        const pathOf = u => { try { return new URL(u, 'http://x/').pathname.replace(/\/+$/, '') || '/'; } catch { return null; } };
        // the pages the report names; with none named, the home page of the address given. A site in a sub-folder (/ews/) has its pages under that folder.
        const home = pathOf(issue.url || '/'), named = (issue.pages || []).map(pathOf).filter(Boolean);
        const isAbout = u => { const q = pathOf(u); return !!q && (named.length ? named.some(a => a === '/' ? q === home || q === '/' : q === a || q.endsWith(a)) : q === home || q === '/'); };
        const hit = probe.pages.find(p => p && p.status >= 500 && p.status < 600 && isAbout(p.url));
        if (hit) { symptom = 'yes'; checks.push(check('not-reproduced-cap', 'PASSED', `the oracle said "${symptomBefore === 'no' ? 'not reproduced' : 'could not test'}", but the problem is a crash and ${hit.url} (a page the report is about) answered HTTP ${hit.status}: the symptom counts as reproduced`)); }
    }

    // the hypothesis only carries a summary of its observation; the checks need the observation's own fields (declaration name, handle, ...)
    const ccJson = readJson(W('custom-code.json')) || {}, intake = readJson(W('intake.json'));
    const obsById = new Map((ccJson.observations || []).map(o => [o.id, o]));
    const out = [];
    for (const hSummary of hyp.hypotheses) {
        const obs = hSummary.supports.map(s => (s.kind === 'observation' ? obsById.get(s.ref) : null)).find(Boolean) || {};
        const h = { ...obs, ...hSummary, evidence: hSummary.evidence && hSummary.evidence.length ? hSummary.evidence : obs.evidence || [] };
        const notes = [], hchecks = [];
        const kinds = new Set(h.supports.map(s => s.kind.replace(/-(un)?verified$/, '')));
        // evidence files, recomputed
        const cited = (h.evidence || []).filter(e => e.file);
        const files = root ? cited.map(e => verifyEvidence(h, e, root, policy, lint)) : [];
        const bad = files.filter(f => ['missing', 'construct-absent', 'rejected-path'].includes(f.status));
        const good = files.filter(f => f.status === 'verified');
        for (const f of files) hchecks.push(check(`evidence:${f.file}:${f.line || '-'}`, f.status === 'verified' || f.status === 'verified-file-only' ? 'PASSED' : f.status === 'unchecked' ? 'NOT_RUN' : 'FAILED', f.reason));
        // log / probe supports: the clue must still be in evidence.json (re-read) and come from that source
        const clueOk = k => h.supports.filter(s => s.kind === k).some(s => { const c = clueById.get(s.ref); return c && c.source && c.source.kind === k; });
        for (const k of ['log', 'probe']) if (kinds.has(k)) { const yes = clueOk(k); hchecks.push(check(`support:${k}`, yes ? 'PASSED' : 'FAILED', yes ? `the ${k} clue is still in evidence.json` : `the ${k} clue cited by this hypothesis is not in evidence.json`)); if (!yes) kinds.delete(k); }
        // php -l on the (custom) PHP files the hypothesis touches
        for (const f of files.filter(x => /\.php$/.test(x.file || '') && x.status !== 'missing' && x.status !== 'rejected-path' && h.type !== 'syntax-error')) {
            const r = ownership.resolveInside(root, f.file), l = r.ok ? lint(r.abs) : null;
            if (l === null) hchecks.push(check(`php-l:${f.file}`, 'NOT_RUN', 'php is not installed')); else if (!l.ok) { hchecks.push(check(`php-l:${f.file}`, 'FAILED', l.message)); notes.push(`php -l fails for ${f.file}: ${l.message}`); } else hchecks.push(check(`php-l:${f.file}`, 'PASSED', 'no syntax error'));
        }
        // bisect, re-read from work/bisect.json
        let bisectOk = false;
        if (kinds.has('bisect')) {
            const comps = (h.components || []).map(c => String(c).replace(/^plugin:/, ''));
            const causes = bis && bis.causes ? bis.causes : [];
            const cause = causes.find(c => c.minimal && c.plugins.length && c.plugins.every(p => comps.includes(p)));
            bisectOk = !!cause && symptom !== 'no' && sbx && sbx.reproduced_in_sandbox === 'yes';
            hchecks.push(check('bisect', bisectOk ? 'PASSED' : 'FAILED', bisectOk ? `work/bisect.json: [${cause.plugins.join(', ')}] is a minimal set and the sandbox reproduced the symptom` : 'work/bisect.json does not hold a minimal cause matching this hypothesis, or the symptom was not reproduced in the sandbox'));
            if (!bisectOk) kinds.delete('bisect');
        }
        // a duplicate declaration that is fatal when both load: if EVERY cited site is re-read and still declares the name, the two sites are two
        // independent deterministic supports. One site (or a site that failed) is not enough.
        const siteKinds = [];
        if (h.type === 'duplicate-declaration' && /^fatal/.test(h.risk || '') && files.length >= 2 && good.length === files.length && new Set(good.map(f => `${f.file}:${f.found_line || f.line}`)).size >= 2) {
            siteKinds.push('declaration-site-1', 'declaration-site-2');
            hchecks.push(check('declaration-sites', 'PASSED', `all ${good.length} cited declarations were re-read and each still declares ${h.declaration && h.declaration.name}`));
            notes.push('both declaration sites were re-read and verified: they count as two deterministic supports');
        }
        // a "Class X not found" fatal at a known file (issue/fatal-recheck.js): re-read, and either the live page broke too (Rule A) or nothing in the copy defines X (Rule B).
        // When a rule holds, the log line is subsumed in the first support, so the two supports below are the TWO deterministic supports (not three).
        let fatal = null;
        if (h.type === 'missing-function' && root) {
            fatal = fatalRecheck.recheck({ h, clues: ev.clues, root, probe, issue, intake, components: ccJson.components || [], sandbox: sbx });
            if (fatal) for (const c of fatal.checks) hchecks.push(check(`fatal:${c.id}`, c.status, c.reason));
        }
        const fatalKinds = fatal && fatal.supports.length === 2 ? fatal.supports : [];
        if (fatalKinds.length) notes.push(`rule ${fatal.rule}: ${fatal.rule === 'A' ? 'the cited line was re-read, the fatal repeats, it is fresh, and the live page answered HTTP 5xx' : 'the cited line was re-read, the fatal repeats, and no PHP file of the copy defines the class'}: two deterministic supports`);
        const deterministic = fatalKinds.length ? [...kinds].filter(k => DETERMINISTIC.has(k) && k !== 'log').concat(siteKinds, fatalKinds) : [...kinds].filter(k => DETERMINISTIC.has(k)).concat(siteKinds);
        // ---- the verdict ----
        let status = h.status;
        if (bisectOk) status = 'REPRODUCIBLE';
        else if (files.length && good.length === 0 && bad.length === files.filter(f => f.status !== 'unchecked' && f.status !== 'verified-file-only').length && bad.length > 0) { status = 'REJECTED_FALSE_POSITIVE'; notes.push(`every cited location failed re-verification (${bad.map(b => `${b.file}:${b.line || '-'} ${b.status}`).join('; ')})`); }
        else if (bad.length) { status = h.status === 'UNVERIFIED' ? 'UNVERIFIED' : 'PROBABLE_NEEDS_REVIEW'; notes.push(`${bad.length} of ${files.length} cited location(s) failed re-verification, so it cannot be CONFIRMED`); }
        else if (deterministic.length >= 2 && (good.length > 0 || kinds.has('log') || kinds.has('probe') || fatalKinds.length)) status = 'CONFIRMED';
        else if (h.status === 'UNVERIFIED' || h.status === 'PROBABLE_NEEDS_REVIEW') status = deterministic.length ? 'PROBABLE_NEEDS_REVIEW' : 'UNVERIFIED';
        // an advisory (a version header, or a removed-function call nothing has corroborated) is never CONFIRMED or REPRODUCIBLE. One that a log fatal,
        // a probe observation or the bisection backs has advisory: false from hypotheses.js and takes the normal path above.
        if (h.advisory && ['CONFIRMED', 'REPRODUCIBLE'].includes(status)) { status = 'PROBABLE_NEEDS_REVIEW'; notes.push('advisory: nothing has been seen failing because of it, so it is never CONFIRMED'); }
        // a static match of a malware pattern is evidence of the pattern, not proof of a compromise: at most "needs review" (the gate always shows it)
        if (h.class === 'compromise' && status === 'CONFIRMED') { status = 'PROBABLE_NEEDS_REVIEW'; notes.push('compromise findings are never CONFIRMED from a pattern match alone; a person must look at the file'); }
        if (status === 'CONFIRMED' && symptom === 'no') { status = 'PROBABLE_NEEDS_REVIEW'; notes.push('the symptom was NOT reproduced on the probed pages / in the sandbox, so static agreement alone is not enough to confirm it'); }
        if (status === 'REPRODUCIBLE' && symptom === 'no') status = 'PROBABLE_NEEDS_REVIEW';
        if (oracle.agrees === false && ['CONFIRMED', 'REPRODUCIBLE'].includes(status)) { status = 'PROBABLE_NEEDS_REVIEW'; notes.push('the stored oracle answer did not match its recomputation'); }
        // ownership: recomputed; this alone says whether code may be named in a fix task
        const touched = [...new Set(cited.map(e => e.file))];
        const owners = touched.map(f => ({ file: f, owner: policy ? ownership.classify(policy, f).owner : 'unknown' }));
        out.push({ ...hSummary, status, ...(fatal ? { fatal_recheck: fatal } : {}), validation_notes: notes, checks: hchecks, evidence_checked: files, independent_kinds: [...kinds].sort(), ownership: owners, fix_eligible: !!owners.length && owners.every(o => o.owner === 'custom') });
    }
    const result = { schema: 1, issue_id: id, symptom_reproduced: symptom, oracle, hypotheses: out, checks };
    fs.writeFileSync(W('validation.json'), JSON.stringify(result, null, 2) + '\n', { mode: 0o600 });
    return result;
}

module.exports = { KEYWORD, TYPE_KEYWORD, keywordFor, CALL, declaration, verifyEvidence, run, policyFor };
