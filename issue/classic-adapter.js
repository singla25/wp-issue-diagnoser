// Feeds the classic checks (checks/*) into issue mode as OBSERVATIONS, so hypotheses.js can rank them next to everything else.
// Offline and read-only: only the pure parts of the classic scan run (no WP-CLI, no wordpress.org, no live site, no database). Nothing here is a
// verdict: an observation becomes at most PROBABLE_NEEDS_REVIEW in hypotheses.js, and only validate.js can promote or reject it.
//
//   rules taken        conflicts (hook-priority, hook-contradiction, hook-removed, duplicate-feature, shared-table), dependencies (all five), themes,
//                      dropins (unrecognised, orphan), serversettings (cfg-http-url), integrity (the offline patterns: class "compromise")
//   rules NOT taken    redeclare-*, shared-constant / shortcode / ajax-action: issue/custom.js compares those with the syntax tree (and the adapter drops a
//                      result whose dup_key is already there); exposure, lifecycle, vulnerabilities, database, live checks: not about "what broke"
//   selection          sorted by (severity, type, component, file, line); each finding needs a clue (issue/clue-match.js) or P0; at most MAX_FINDINGS,
//                      compromise findings exempt from the cap; whatever is left out is listed with its reason, never silently dropped
//   activity           without a list of active plugins (WP-CLI is not used here) every finding is marked active_state "unknown"; with `activePlugins`
//                      a finding that involves only inactive plugins is left out

const path = require('path');
const components = require('../lib/components');
const { categoryOf } = require('../lib/categories');
const ownership = require('../lib/ownership');
const clueMatch = require('./clue-match');
const dependencies = require('../checks/dependencies');
const conflicts = require('../checks/conflicts');
const themesCheck = require('../checks/themes');
const dropins = require('../checks/dropins');
const serversettings = require('../checks/serversettings');
const integrity = require('../checks/integrity');

const MAX_FINDINGS = 3;
const RANK = { P0: 0, P1: 1, P2: 2, P3: 3 };
// rule -> family (hypotheses.js FAMILY_SYMPTOMS) and class ('compromise' is always shown by the gate of step 7)
const TAKEN = {
    'hook-priority': { family: 'hook' }, 'hook-contradiction': { family: 'hook' }, 'hook-removed': { family: 'hook' }, 'duplicate-feature': { family: 'hook' }, 'shared-table': { family: 'hook' },
    'dep-missing': { family: 'fatal' }, 'dep-inactive': { family: 'fatal' }, 'dep-implied': { family: 'fatal' }, 'dep-wp-version': { family: 'fatal' }, 'dep-php-version': { family: 'fatal' },
    'theme-parent-missing': { family: 'fatal' }, 'dropin-unrecognised': { family: 'cache' }, 'dropin-orphan': { family: 'cache' }, 'cfg-http-url': { family: 'redirect' }
};
const isCompromise = rule => /^integrity-/.test(rule);
const FAMILIES = { fatal: ['white-screen', 'login-admin', 'form-checkout', 'wrong-content'], hook: ['wrong-content', 'form-checkout', 'login-admin', 'js-error', 'white-screen', 'slow', 'redirect'],
    cache: ['wrong-content', 'form-checkout', 'login-admin', 'slow', 'js-error', 'layout', 'redirect'], redirect: ['redirect', 'login-admin', 'wrong-content'], compromise: ['white-screen', 'redirect', 'js-error', 'wrong-content', 'login-admin', 'other'] };

function context(root, { activePlugins = null, activeTheme = null, project = {} } = {}) {
    const found = components.discover(root);
    const ctx = { project: { url: project.url || null }, config: { precedence: [], prefer: {}, categories: [] }, record() {}, outside: null, wpRoot: root, plugins: found.plugins, themes: found.themes, mu: found.mu, dropins: found.dropins,
        wpVersion: components.wpVersion(root), phpVersion: null, activeKnown: !!activePlugins, themesKnown: !!activeTheme, bySlug: new Map(), allHooks: new Set(), prefixes: new Set() };
    for (const p of ctx.plugins) p.active = !activePlugins || activePlugins.includes(p.slug);
    for (const m of ctx.mu) m.active = true;
    for (const d of ctx.dropins) d.active = true;
    const actTheme = activeTheme ? new Set([activeTheme]) : null;
    if (actTheme) for (const t of ctx.themes) if (actTheme.has(t.slug) && t.template) actTheme.add(t.template);
    for (const t of ctx.themes) t.active = actTheme ? actTheme.has(t.slug) : true;
    ctx.components = [...ctx.plugins, ...ctx.mu, ...ctx.themes, ...ctx.dropins];
    for (const c of ctx.components) { ctx.bySlug.set(c.ref, c); c.category = categoryOf(c, ctx.config); }
    ctx.isActive = ref => { const c = ctx.bySlug.get(ref); return !!(c && c.active); };
    ctx.active = ctx.components.filter(c => c.active && c.kind !== 'dropin' && !(c.kind === 'theme' && !ctx.themesKnown));
    return ctx;
}

// "wp-content/plugins/x/y.php:12 (guarded)" -> { file, line }
function parseEvidence(e) {
    const m = /^(.*?\.\w+?)(?::(\d+))?(?:\s+priority \d+|\s+\(guarded\))?$/.exec(String(e).trim());
    return m ? { file: m[1], line: m[2] ? Number(m[2]) : null } : { file: String(e).trim(), line: null };
}
const componentOfFile = file => { const c = ownership.componentOf(file || ''); return c ? c.replace(/^plugin:/, '') : null; };

function collect(ctx, only) {
    const out = [];
    const run = (label, fn) => { try { out.push(...fn()); } catch (e) { out.push({ _crash: label, message: e.message }); } };
    run('dependencies', () => dependencies.run(ctx).findings);
    run('conflicts', () => conflicts.run(ctx));
    run('themes', () => themesCheck.run(ctx));
    run('dropins', () => dropins.run(ctx));
    run('serversettings', () => serversettings.run(ctx));
    run('integrity', () => integrity.localPatterns(ctx));
    return out;
}

// -> { observations: [...], skipped: [{ rule, title, reason }], crashed: [...], considered }
function adapt(root, { policy, issue = {}, evidence = {}, existing = [], activePlugins = null, activeTheme = null, max = MAX_FINDINGS } = {}) {
    const ctx = context(root, { activePlugins, activeTheme, project: { url: issue.url } });
    const raw = collect(ctx);
    const crashed = raw.filter(f => f._crash).map(f => ({ check: f._crash, message: f.message }));
    const findings = raw.filter(f => !f._crash && (TAKEN[f.rule] || isCompromise(f.rule)));
    const cx = clueMatch.context(evidence, issue, FAMILIES);
    const skipped = [], kept = [];
    for (const f of findings) {
        const compromise = isCompromise(f.rule);
        let ev = (f.evidence || []).map(parseEvidence);
        // integrity titles are "<file>:<line> <what>" and carry no evidence list
        if (compromise && !ev.length) { const m = /^(\S+?)(?::(\d+))?\s/.exec(`${f.title} `); if (m) ev = [{ file: m[1], line: m[2] ? Number(m[2]) : null }]; }
        const refs = (f.plugins || []).map(r => String(r).replace(/^plugin:/, ''));
        // a finding about a component as a whole (missing dependency, missing parent theme) cites that component's main file
        if (!ev.length) { const c = refs.map(r => ctx.bySlug.get(r)).find(Boolean); if (c) ev = [{ file: c.loc(c.main), line: null }]; }
        const components = [...refs];
        if (!components.length) for (const e of ev) { const c = componentOfFile(e.file); if (c && !components.includes(c)) components.push(c); }
        const evidenceList = ev.filter(e => e.file).map(e => ({ ...e, component: componentOfFile(e.file) || components[0] || null, ownership: policy ? ownership.classify(policy, e.file).owner : null }));
        const involved = components.filter(c => ctx.bySlug.has(c));
        const inactiveOnly = activePlugins && involved.length && involved.every(c => { const x = ctx.bySlug.get(c); return x.kind === 'plugin' && !x.active; });
        const obs = { type: `classic:${f.rule}`, classic_rule: f.rule, severity: f.severity, class: compromise ? 'compromise' : 'conflict', family: compromise ? 'compromise' : TAKEN[f.rule].family,
            components: [...new Set(components)].sort(), custom: false, evidence: evidenceList, message: f.title, detail: compromise ? 'This is a pattern match, not proof. Have a person look at the file before anything is changed.' : f.detail, active_state: activePlugins ? (inactiveOnly ? 'inactive' : 'active') : 'unknown',
            ...(compromise ? { pattern: patternOf(f.rule) } : {}), classic_id: f.id, key: f.key || '' };
        if (inactiveOnly) { skipped.push({ rule: f.rule, title: f.title, reason: 'it involves only inactive plugins' }); continue; }
        const m = clueMatch.matches({ components: obs.components, evidence: obs.evidence, severity: f.severity, family: obs.family }, cx);
        if (!m.ok) { skipped.push({ rule: f.rule, title: f.title, reason: m.why }); continue; }
        obs.matched = m.why;
        kept.push(obs);
    }
    const cmp = (a, b) => (RANK[a.severity] - RANK[b.severity]) || a.type.localeCompare(b.type) || String(a.components[0] || '').localeCompare(String(b.components[0] || '')) || String((a.evidence[0] || {}).file || '').localeCompare(String((b.evidence[0] || {}).file || '')) || ((a.evidence[0] || {}).line || 0) - ((b.evidence[0] || {}).line || 0);
    kept.sort(cmp);
    const compromised = kept.filter(o => o.class === 'compromise'), others = kept.filter(o => o.class !== 'compromise');
    const taken = others.slice(0, max);
    for (const o of others.slice(max)) skipped.push({ rule: o.classic_rule, title: o.message, reason: `over the cap of ${max} classic findings` });
    const observations = [...taken, ...compromised].sort(cmp).map(o => ({ id: require('../lib/schema').stableId('obs', o.type, o.components.join(','), o.evidence.map(e => `${e.file}:${e.line}`).join(';'), o.key), ...o }));
    return { observations, skipped, crashed, considered: findings.length, active_known: !!activePlugins };
}

function patternOf(rule) { const p = integrity.PATTERNS.find(x => `integrity-${x.id}` === rule); return p ? { id: p.id, source: p.re.source, flags: p.re.flags } : null; }

module.exports = { adapt, context, parseEvidence, TAKEN, MAX_FINDINGS, FAMILIES };
