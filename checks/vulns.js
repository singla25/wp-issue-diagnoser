// Known-vulnerability matching. Sources, in order:
//   1. data/advisories.json and any --advisories file(s): [{ id, slug, affected: "<=1.4.2" | ">=1.0 <1.5", fixedIn, severity, title, url }]
//   2. The WPScan lookup in lib/outside.js, when the project allows it and WPSCAN_API_TOKEN is set.
// The bundled data/advisories.json is deliberately empty: a stale list gives false comfort.
// Feed it from WPScan / Patchstack / the NVD export you trust.

const fs = require('fs');
const { finding } = require('../lib/finding');
const { inRange, compare } = require('../lib/version');

const SEV = { critical: 'P0', high: 'P1', medium: 'P2', low: 'P3' };

function loadFiles(files) {
    return files.flatMap(f => JSON.parse(fs.readFileSync(f, 'utf8')));
}

function match(versions, advisories) {
    const out = [];
    for (const adv of advisories) {
        const v = versions.get(adv.slug);
        if (!v || !v.version || !inRange(v.version, adv.affected)) continue;
        out.push(finding({
            rule: 'known-vuln', severity: SEV[String(adv.severity).toLowerCase()] || 'P1', category: 'vulnerability', confidence: 'certain',
            plugins: [adv.slug], key: adv.id,
            title: `${adv.slug} ${v.version}: ${adv.title || adv.id}`,
            detail: `${adv.id} affects ${adv.slug} ${adv.affected}. Version found via ${v.source}.${v.active === false ? ' The plugin is inactive, but its files are still web-reachable, so it can still be attacked.' : ''}`,
            evidence: [adv.url].filter(Boolean),
            fix: adv.fixedIn ? `Update to ${adv.fixedIn} or newer.${compare(v.version, adv.fixedIn) >= 0 ? '' : ''}` : 'No fixed version is known: remove the plugin, or block the vulnerable endpoint.',
            commands: adv.fixedIn ? [`wp plugin update ${adv.slug}`] : [`wp plugin delete ${adv.slug}`]
        }));
    }
    return out;
}

module.exports = { match, loadFiles };
