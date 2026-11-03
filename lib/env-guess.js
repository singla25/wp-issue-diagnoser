// A first guess at what kind of site an address is, so the wizard can ask ONE plain yes/no question instead of a list.
// Local: localhost, private addresses, .local / .test (site-intake hostIsLocal). Staging: a host name with a staging-like word. Everything else: live.
// With no address nothing is visited, so the kind is 'local' (it only labels the report). Pure; no network.
//   envGuess({ url, root }) -> { kind: 'local' | 'staging' | 'live', reason }

const intake = require('./site-intake');
const STAGING = /(^|[.-])(staging|stage|stg|dev|test|qa|preview|demo|uat)([.-]|$)/i;

function envGuess({ url } = {}) {
    let host = '';
    try { host = new URL(url).hostname.toLowerCase(); } catch { /* no address */ }
    if (!host) return { kind: 'local', reason: 'no address was given, so the site is not visited' };
    if (intake.hostIsLocal(host)) return { kind: 'local', reason: `${host} is an address on this computer or your own network` };
    if (STAGING.test(host)) return { kind: 'staging', reason: `${host} has a test-site word in its name` };
    return { kind: 'live', reason: `${host} is a public address` };
}

module.exports = { envGuess, STAGING };
