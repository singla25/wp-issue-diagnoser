// A first guess at what kind of site an address is, so the wizard can ask ONE plain yes/no question instead of a list.
// Local: localhost, private addresses, .local / .test (site-intake hostIsLocal). Staging: a host name with a staging-like word. Everything else: live.
// envGuessResolved() also looks the name up (a DNS lookup only, NO request to the site) so that a name such as localhost82.local.com that points at
// 127.0.0.1 is local; any failure falls back to envGuess(). The resolver is injectable, so tests are offline.
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

// loopback or private: 127/8, 10/8, 172.16/12, 192.168/16, ::1, fc00::/7, fe80::/10 (an IPv4-mapped IPv6 address is read as the IPv4 one)
function isPrivateAddress(addr) {
    let a = String(addr || '').toLowerCase().replace(/^\[|\]$/g, '').replace(/%.*$/, '');
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(a);
    if (mapped) a = mapped[1];
    const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(a);
    if (m) { const [x, y] = [Number(m[1]), Number(m[2])]; return x === 127 || x === 10 || (x === 192 && y === 168) || (x === 172 && y >= 16 && y <= 31); }
    if (a.includes(':')) return a === '::1' || /^f[cd][0-9a-f]{2}:/.test(a) || /^fe[89ab][0-9a-f]:/.test(a);
    return false;
}

async function defaultResolve(host) {
    const r = await require('dns').promises.lookup(host, { all: true });
    return r.map(x => x.address);
}

// -> same shape as envGuess, plus { resolved: [addresses] } when a lookup answered. opts: { resolve: async host => [address], timeoutMs }
async function envGuessResolved({ url } = {}, { resolve = defaultResolve, timeoutMs = 1500 } = {}) {
    const base = envGuess({ url });
    let host = '';
    try { host = new URL(url).hostname.toLowerCase(); } catch { return base; }
    if (!host || base.kind === 'local') return base;
    let addrs = null, timer;
    try {
        addrs = await Promise.race([Promise.resolve().then(() => resolve(host)), new Promise((_, no) => { timer = setTimeout(() => no(new Error('timeout')), timeoutMs); })]);
    } catch { return base; } finally { clearTimeout(timer); }
    if (!Array.isArray(addrs) || !addrs.length) return base;
    if (addrs.every(isPrivateAddress)) return { kind: 'local', reason: `${host} points to ${addrs[0]}, an address on this computer or your own network`, resolved: addrs, resolved_local: true };
    return { ...base, resolved: addrs };
}

module.exports = { envGuess, envGuessResolved, isPrivateAddress, STAGING };
