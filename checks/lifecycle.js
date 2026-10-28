// Is the software kept alive? Abandoned or closed plugins, outdated plugins/themes/core, auto-updates.
// The wordpress.org lookups send slugs and versions only and need the project's permission.

const { finding } = require('../lib/finding');
const { compare } = require('../lib/version');

const yearsSince = dateText => {
    const m = /(\d{4})-(\d{2})-(\d{2})/.exec(dateText || '');
    return m ? (Date.now() - Date.UTC(+m[1], +m[2] - 1, +m[3])) / (365.25 * 86400000) : null;
};

async function run(ctx) {
    const out = [];
    const base = { category: 'lifecycle', confidence: 'certain', owner: 'admin' };

    // ---- auto-updates (WP-CLI inventory, no outside lookup) ----
    if (!ctx.inventory) ctx.record('lifecycle-autoupdate', 'Auto-updates', 'skipped', 'needs a local copy with a working database (WP-CLI)');
    else {
        ctx.record('lifecycle-autoupdate', 'Auto-updates', 'done');
        const waiting = ctx.inventory.plugins.filter(p => /^active/.test(p.status) && p.update === 'available');
        const off = waiting.filter(p => p.auto_update === 'off');
        if (waiting.length) out.push(finding({ ...base, rule: 'update-waiting', severity: 'P2', plugins: waiting.map(p => p.name), key: 'waiting', title: `${waiting.length} active plugin(s) have an update waiting`, detail: 'Most plugin hacks use flaws that were already fixed in a newer version.', evidence: waiting.map(p => `${p.name} ${p.version}${p.auto_update === 'off' ? ' (auto-update off)' : ''}`), fix: 'Update on staging, check the site, then update live. Turn on auto-updates for plugins you trust (Plugins screen → Enable auto-updates).', commands: waiting.map(p => `wp plugin update ${p.name}`), done: 'No active plugin has an update waiting.' }));
        else if (off.length) out.push(finding({ ...base, rule: 'autoupdate-off', severity: 'P3', plugins: off.map(p => p.name), key: 'off', title: `${off.length} plugin(s) have auto-updates switched off`, detail: 'Security fixes then wait for someone to click.', evidence: off.map(p => p.name), fix: 'Enable auto-updates for plugins that rarely break, and keep a person watching the others.', commands: off.slice(0, 5).map(p => `wp plugin auto-updates enable ${p.name}`), done: 'Auto-updates are on, or a person updates on a schedule.' }));
    }

    // ---- wordpress.org ----
    const label = 'Plugin and WordPress status on wordpress.org (abandoned, closed, outdated)';
    const latest = await ctx.outside.coreLatest();
    if (latest.skipped) { ctx.record('lifecycle-wporg', label, 'skipped', latest.reason); return out; }
    if (latest.ok && latest.json && ctx.wpVersion) {
        const offer = (latest.json.offers || [])[0];
        if (offer && offer.version && compare(ctx.wpVersion.version, offer.version) < 0) {
            out.push(finding({ ...base, rule: 'core-outdated', severity: 'P1', plugins: [], key: offer.version, title: `WordPress ${ctx.wpVersion.version} is behind the latest release ${offer.version}`, detail: 'Security fixes ship in minor releases; running an older one leaves known holes open.', fix: 'Back up, update on staging, then update live.', commands: ['wp core update', 'wp core update-db'], done: `WordPress is ${offer.version} or newer.` }));
        }
    }
    const unlisted = [];
    const items = [...ctx.plugins.filter(p => p.kind === 'plugin').map(p => ({ c: p, type: 'plugins' })), ...ctx.themes.map(t => ({ c: t, type: 'themes' }))];
    for (const { c, type } of items) {
        const r = await ctx.outside.pluginInfo(c.slug, type);
        if (r.skipped) break;
        const j = r.json || {};
        const what = type === 'themes' ? 'Theme' : 'Plugin';
        if (j.error === 'closed' || j.closed) {
            const sec = /security/i.test(`${j.reason || ''} ${j.description || ''}`);
            out.push(finding({ ...base, rule: 'plugin-closed', severity: sec ? 'P0' : 'P1', plugins: [c.ref], key: c.ref, title: `${what} "${c.name || c.slug}" was closed on wordpress.org${sec ? ' for a security issue' : ''}`, detail: `${j.description || 'It can no longer be downloaded or updated there.'}`, fix: 'Replace it with a maintained alternative and remove it.', commands: type === 'plugins' ? [`wp plugin delete ${c.slug}`] : [`wp theme delete ${c.slug}`], done: 'The closed item is removed.' }));
            continue;
        }
        if (!r.ok || !j.slug) { if (r.status === 404 || j.error) unlisted.push(c.ref); continue; }
        const yrs = yearsSince(j.last_updated);
        if (yrs !== null && yrs >= ctx.project.abandonedYears) out.push(finding({ ...base, rule: 'plugin-abandoned', severity: 'P2', plugins: [c.ref], key: c.ref, title: `${what} "${c.name || c.slug}" has not been updated for ${yrs.toFixed(1)} years`, detail: `Last update on wordpress.org: ${String(j.last_updated).slice(0, 10)}. Abandoned code collects unfixed vulnerabilities and breaks with new WordPress/PHP versions.`, fix: 'Look for a maintained alternative and plan the replacement.', done: 'The item is replaced, or the risk is accepted in decisions.txt.' }));
        if (j.version && c.version && c.versionTrusted !== false && compare(c.version, j.version) < 0) out.push(finding({ ...base, rule: 'plugin-outdated', severity: 'P2', plugins: [c.ref], key: c.ref, title: `${what} "${c.name || c.slug}" ${c.version} is behind the latest ${j.version}`, detail: 'Updates fix security problems as well as bugs.', fix: 'Update on staging first, then live.', commands: type === 'plugins' ? [`wp plugin update ${c.slug}`] : [`wp theme update ${c.slug}`], done: `${c.slug} is ${j.version} or newer.` }));
    }
    ctx.record('lifecycle-wporg', label, ctx.outside.stopped ? 'done' : 'done', ctx.outside.stopped || `${items.length - unlisted.length} found on wordpress.org, ${unlisted.length} not listed`);
    if (unlisted.length) out.push(finding({ ...base, rule: 'plugin-unlisted', severity: 'P3', plugins: [], key: 'unlisted', title: `${unlisted.length} installed item(s) are not in the wordpress.org directory`, detail: 'Premium, custom or removed. They need to be kept up to date through their vendor, and cannot be compared with official files.', evidence: unlisted, fix: 'Check each has a licence and an updater, and that the vendor is still active.', done: 'Each one has a known source and update path.' }));
    return out;
}

module.exports = { run };
