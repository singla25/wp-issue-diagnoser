// Dependency checks: declared ("Requires Plugins", "Requires at least", "Requires PHP") and implied
// (code that calls into another plugin) dependencies, plus the dependency graph.

const { finding } = require('../lib/finding');
const { compare } = require('../lib/version');

function run(ctx) {
    const out = [];
    const bySlug = new Map(ctx.plugins.map(p => [p.ref, p]));
    const what = p => (p.kind === 'theme' ? 'theme' : 'plugin');
    const isActive = s => ctx.isActive(s);
    const graph = { nodes: ctx.components.map(p => ({ slug: p.ref, version: p.version, active: isActive(p.ref) })), edges: [] };

    for (const p of ctx.active) {
        for (const dep of p.requiresPlugins) {
            graph.edges.push({ from: p.ref, to: dep, kind: 'declared' });
            if (!bySlug.has(dep)) {
                out.push(finding({
                    rule: 'dep-missing', severity: 'P1', category: 'dependency', confidence: 'certain', plugins: [p.ref, dep], key: `${p.ref}>${dep}`,
                    title: `${p.name || p.ref} requires "${dep}", which is not installed`,
                    detail: `${p.ref} declares "Requires Plugins: ${dep}". Without it the plugin can fatal, or silently skip the features that protect the site.`,
                    owner: 'admin', done: `${dep} is installed and active.`,
                    fix: `Install and activate ${dep}, or remove ${p.ref}.`, commands: [`wp plugin install ${dep} --activate`]
                }));
            } else if (!isActive(dep)) {
                out.push(finding({
                    rule: 'dep-inactive', severity: 'P1', category: 'dependency', confidence: 'certain', plugins: [p.ref, dep], key: `${p.ref}>${dep}`,
                    title: `${p.name || p.ref} requires "${dep}", which is installed but inactive`,
                    detail: `${p.ref} is active but its required plugin ${dep} is not.`,
                    owner: 'admin', done: `${dep} is active.`,
                    fix: `Activate ${dep}.`, commands: [`wp plugin activate ${dep}`]
                }));
            }
        }
        if (p.requiresWp && ctx.wpVersion && compare(ctx.wpVersion.version, p.requiresWp) < 0) {
            out.push(finding({
                rule: 'dep-wp-version', severity: 'P1', category: 'dependency', confidence: 'certain', plugins: [p.ref], key: p.ref,
                title: `${p.name || p.ref} needs WordPress ${p.requiresWp}+, site runs ${ctx.wpVersion.version}`,
                detail: `Running a ${what(p)} on an older WordPress than it was written for risks missing security APIs it relies on.`,
                owner: 'admin', done: `WordPress is ${p.requiresWp} or newer.`,
                fix: `Update WordPress to ${p.requiresWp} or newer.`, commands: ['wp core update']
            }));
        }
        if (p.requiresPhp && ctx.phpVersion && compare(ctx.phpVersion.version, p.requiresPhp) < 0) {
            out.push(finding({
                rule: 'dep-php-version', severity: 'P0', category: 'dependency', confidence: 'certain', plugins: [p.ref], key: p.ref,
                title: `${p.name || p.ref} needs PHP ${p.requiresPhp}+, server has ${ctx.phpVersion.version} (${ctx.phpVersion.source})`,
                detail: `The ${what(p)} will fatal-error on load.`, owner: 'hosting', done: `The server runs PHP ${p.requiresPhp} or newer.`,
                fix: `Upgrade PHP to ${p.requiresPhp} or newer, or remove the ${what(p)}.`
            }));
        }

        // implied dependencies
        const seen = new Set();
        for (const s of p.scans) {
            if (s.bundled) continue;
            for (const raw of s.implied || []) {
                const imp = { ...raw, ref: raw.ref || raw.slug };
                if (imp.ref === p.ref || seen.has(imp.ref)) continue;
                seen.add(imp.ref);
                graph.edges.push({ from: p.ref, to: imp.ref, kind: imp.soft ? 'optional' : 'implied' });
                if (!imp.soft && !p.requiresPlugins.includes(imp.ref) && !isActive(imp.ref)) {
                    out.push(finding({
                        rule: 'dep-implied', severity: 'P2', category: 'dependency', plugins: [p.ref, imp.ref], key: `${p.ref}>${imp.ref}`,
                        title: `${p.name || p.ref} uses ${imp.ref} code, but ${imp.ref} is ${bySlug.has(imp.ref) ? 'inactive' : 'not installed'}`,
                        detail: `Found in ${s.file}. It does not declare "Requires Plugins: ${imp.ref}", so WordPress will not stop you deactivating it, and calls into it can fatal.`,
                        evidence: [p.loc(s.file)], fix: `Activate ${imp.ref}, or confirm the plugin guards these calls.`
                    }));
                }
            }
        }
    }

    // hook-level coupling for the graph: plugin removes/replaces another plugin's callback
    for (const a of ctx.active) {
        for (const r of a.scans.flatMap(s => s.removals)) {
            for (const b of ctx.active) {
                if (a !== b && b.scans.some(s => s.hooks.some(h => h.hook === r.hook && h.callback && h.callback === r.callback))) {
                    graph.edges.push({ from: a.slug, to: b.slug, kind: 'removes-hook', via: r.hook });
                }
            }
        }
    }
    return { findings: out, graph };
}

module.exports = { run };
