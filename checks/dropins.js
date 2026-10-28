// Drop-ins (wp-content/*.php that WordPress loads on EVERY request) and must-use plugins (loaded automatically,
// cannot be deactivated from wp-admin). Both are favourite hiding places for malware.

const { finding } = require('../lib/finding');
const { categoryOf } = require('../lib/categories');

// Text the real files carry in their header comment.
const KNOWN = {
    'object-cache.php': /redis|memcache|w3 total cache|w3tc|litespeed|object cache pro|wp rocket|apcu|sg-cachepress/i,
    'advanced-cache.php': /w3 total cache|w3tc|wp super cache|wp rocket|litespeed|wp fastest cache|cache enabler|hummingbird|sg-cachepress|batcache|nginx|breeze/i,
    'db.php': /query monitor|hyperdb|ludicrousdb|w3 total cache|w3tc|sqlite|debug bar/i,
    'sunrise.php': /domain mapping|mercator|multisite/i,
    'fatal-error-handler.php': /sentry|bugsnag|rollbar|newrelic|honeybadger/i,
    'install.php': /sqlite|wp-cli|test/i
};
const ALWAYS_RISKY = new Set(['db.php', 'advanced-cache.php', 'object-cache.php', 'fatal-error-handler.php', 'install.php']);

function run(ctx) {
    const out = [];
    for (const d of ctx.dropins) {
        const known = KNOWN[d.slug] && KNOWN[d.slug].test(d.head || '');
        const loc = `wp-content/${d.slug}`;
        if (ALWAYS_RISKY.has(d.slug) && !known) {
            out.push(finding({
                rule: 'dropin-unrecognised', severity: 'P1', category: 'exposure', plugins: [d.ref], key: d.slug, confidence: 'possible', owner: 'admin',
                title: `Unrecognised drop-in ${loc}`,
                detail: `${d.slug} is loaded by WordPress on every request, before plugins, and can see or change everything (database queries, cached pages, errors). Its header does not name a known cache, database or monitoring tool.`,
                evidence: [loc], fix: `Open ${loc}. If it belongs to a plugin you use, note which. If you cannot say why it exists, restore it from a clean backup or delete it.`,
                done: 'You can name the plugin that installed it, or the file is removed.'
            }));
        }
        const cacheSlug = d.slug === 'advanced-cache.php' ? 'caching' : d.slug === 'object-cache.php' ? 'caching' : null;
        if (cacheSlug && known && !ctx.active.some(p => p.kind === 'plugin' && /cache|rocket|redis|memcache|litespeed|w3-total|hummingbird|sg-cachepress|breeze/i.test(p.slug))) {
            out.push(finding({
                rule: 'dropin-orphan', severity: 'P2', category: 'conflict', plugins: [d.ref], key: d.slug, confidence: 'possible', owner: 'admin',
                title: `${loc} is left over: no matching cache plugin is active`,
                detail: 'A drop-in from a removed or deactivated plugin keeps running. It can serve stale pages, break logins or hide an injected script.',
                evidence: [loc], fix: 'Delete the file if the cache plugin is gone, or re-activate the plugin that owns it.', done: 'No orphan drop-in remains.'
            }));
        }
    }
    for (const m of ctx.mu) {
        if (m.noHeader && !m.loaderNeeded) {
            out.push(finding({
                rule: 'mu-no-header', severity: 'P3', category: 'exposure', plugins: [m.ref], key: m.slug, confidence: 'possible', owner: 'admin',
                title: `Must-use plugin ${m.loc(m.main)} has no plugin header`,
                detail: 'WordPress loads every PHP file in mu-plugins even without a header, and they do not appear in the normal plugin list. Legitimate ones are usually documented; unexplained ones deserve a look.',
                evidence: [m.loc(m.main)], fix: 'Open the file and confirm what it does and who added it.', done: 'You know why it is there.'
            }));
        }
    }
    return out;
}

module.exports = { run };
