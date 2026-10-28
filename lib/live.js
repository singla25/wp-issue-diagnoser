// Read-only probe of a live site that YOU own or are authorised to test. GET/HEAD only, one request at a time,
// paced, and it stops at the first 429 or WAF challenge (it never tries to get around protection).
// Response bodies are inspected for a signature and discarded: nothing sensitive is stored.

const tls = require('tls');
const { finding } = require('./finding');
const { compare } = require('./version');

const UA = 'plugin-guard/1.0 (read-only security check; contact the site owner)';
const CHALLENGE = /cf-chl|Just a moment|captcha|Attention Required|Access denied|Request blocked|Sucuri Website Firewall/i;

class Probe {
    constructor(base, { delayMs = 400, timeoutMs = 10000, fetchImpl = fetch } = {}) {
        this.base = new URL(base);
        if (!/^https?:$/.test(this.base.protocol)) throw new Error('Only http(s) URLs are supported');
        this.delayMs = delayMs;
        this.timeoutMs = timeoutMs;
        this.fetch = fetchImpl;
        this.stopped = null;
        this.requests = 0;
        this.last = 0;
    }

    async get(target, { redirect = 'follow', maxBytes = 4096, method = 'GET' } = {}) {
        if (this.stopped) return null;
        const wait = this.last + this.delayMs - Date.now();
        if (wait > 0) await new Promise(r => setTimeout(r, wait));
        this.last = Date.now();
        this.requests++;
        let res;
        try {
            res = await this.fetch(new URL(target, this.base), { method, redirect, headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(this.timeoutMs) });
        } catch (e) {
            return { status: 0, error: String((e.cause && e.cause.code) || e.message), body: '', headers: new Headers() };
        }
        let body = '';
        if (method === 'GET' && res.body) {
            const reader = res.body.getReader();
            const chunks = [];
            let n = 0;
            while (n < maxBytes) {
                const { done, value } = await reader.read();
                if (done) break;
                chunks.push(value);
                n += value.length;
            }
            reader.cancel().catch(() => {});
            body = Buffer.concat(chunks.map(c => Buffer.from(c))).toString('utf8', 0, maxBytes);
        }
        if (res.status === 429 || ((res.status === 403 || res.status === 503) && CHALLENGE.test(body))) {
            this.stopped = `site protection answered ${res.status} at ${new URL(target, this.base).pathname}`;
        }
        return { status: res.status, body, headers: res.headers };
    }
}

// path, signature that proves the content (not just a 200 soft-404), severity, patch id
const SENSITIVE = [
    { path: '/wp-content/debug.log', sig: /PHP (Notice|Warning|Fatal|Deprecated)|\[\d{2}-\w{3}-\d{4}/, sev: 'P0', title: 'wp-content/debug.log is publicly readable', htaccess: 'debug-log' },
    { path: '/.env', sig: /^[A-Z_][A-Z0-9_]*\s*=/m, sev: 'P0', title: '.env file is publicly readable', htaccess: 'dotfiles' },
    { path: '/.git/HEAD', sig: /^ref:\s*refs\//, sev: 'P0', title: '.git directory is publicly readable (source code and secrets)', htaccess: 'dotfiles' },
    { path: '/wp-config.php.bak', sig: /DB_PASSWORD|DB_NAME/, sev: 'P0', title: 'wp-config.php backup is publicly readable', htaccess: 'config-backup' },
    { path: '/wp-config.php~', sig: /DB_PASSWORD|DB_NAME/, sev: 'P0', title: 'wp-config.php editor backup is publicly readable', htaccess: 'config-backup' },
    { path: '/wp-config.old', sig: /DB_PASSWORD|DB_NAME/, sev: 'P0', title: 'wp-config.old is publicly readable', htaccess: 'config-backup' },
    { path: '/backup.sql', sig: /CREATE TABLE|INSERT INTO|DROP TABLE/i, sev: 'P0', title: 'A database dump (backup.sql) is publicly downloadable', htaccess: 'backups' },
    { path: '/database.sql', sig: /CREATE TABLE|INSERT INTO|DROP TABLE/i, sev: 'P0', title: 'A database dump (database.sql) is publicly downloadable', htaccess: 'backups' },
    { path: '/backup.zip', sig: /^PK/, sev: 'P0', title: 'A site backup (backup.zip) is publicly downloadable', htaccess: 'backups' },
    { path: '/phpinfo.php', sig: /phpinfo\(\)|<title>phpinfo|PHP Version/i, sev: 'P1', title: 'phpinfo.php is publicly reachable (server details)', htaccess: 'debug-files' },
    { path: '/wp-content/uploads/', sig: /Index of \/|<title>Index of/i, sev: 'P1', title: 'uploads directory listing is enabled', htaccess: 'dirlist' },
    { path: '/wp-content/plugins/', sig: /Index of \/|<title>Index of/i, sev: 'P1', title: 'plugins directory listing is enabled (lists every installed plugin)', htaccess: 'dirlist' },
    { path: '/wp-content/updraft/', sig: /Index of \/|<title>Index of/i, sev: 'P0', title: 'UpdraftPlus backup folder is listable', htaccess: 'backups' }
];

// REST namespace prefix -> plugin slug
const NAMESPACES = { wc: 'woocommerce', 'wc-admin': 'woocommerce', 'wc-analytics': 'woocommerce', yoast: 'wordpress-seo', elementor: 'elementor', 'contact-form-7': 'contact-form-7', jetpack: 'jetpack', rankmath: 'seo-by-rank-math', wordfence: 'wordfence', acf: 'advanced-custom-fields', wpforms: 'wpforms-lite', litespeed: 'litespeed-cache', redirection: 'redirection', akismet: 'akismet', 'wp-super-cache': 'wp-super-cache', gravityforms: 'gravityforms', 'wp-rocket': 'wp-rocket', 'updraftplus': 'updraftplus', tribe: 'the-events-calendar', sucuri: 'sucuri-scanner', mailpoet: 'mailpoet' };
const GENERATORS = [
    [/^Elementor\s+([\d.]+)/i, 'elementor'], [/^WooCommerce\s+([\d.]+)/i, 'woocommerce'], [/^Site Kit by Google\s+([\d.]+)/i, 'google-site-kit'],
    [/^WPML ver:([\d.]+)/i, 'sitepress-multilingual-cms'], [/^Powered by Slider Revolution\s+([\d.]+)/i, 'revslider'], [/^Powered by WPBakery/i, 'js_composer']
];
const SEC_HEADERS = [
    ['strict-transport-security', 'Strict-Transport-Security (HSTS)', true], ['x-content-type-options', 'X-Content-Type-Options', false],
    ['referrer-policy', 'Referrer-Policy', false], ['content-security-policy', 'Content-Security-Policy', false], ['permissions-policy', 'Permissions-Policy', false]
];

function tlsProbe(host, port, timeout = 8000) {
    return new Promise(resolve => {
        const s = tls.connect({ host, port, servername: host, rejectUnauthorized: false, timeout }, () => {
            const c = s.getPeerCertificate();
            resolve({ validTo: c && c.valid_to, authorized: s.authorized, authError: s.authorizationError });
            s.end();
        });
        s.on('error', e => resolve({ error: e.message }));
        s.on('timeout', () => { s.destroy(); resolve({ error: 'timeout' }); });
    });
}

const isLocalHost = h => /^(localhost|127\.|\[::1\]|.*\.(test|local|localhost)$)/i.test(h);

async function run(url, { delayMs, fetchImpl, certProbe = tlsProbe, record = () => {} } = {}) {
    const probe = new Probe(url, { delayMs, fetchImpl });
    const out = [];
    const detected = new Map(); // slug -> { version, source }
    const setDetected = (slug, version, source) => {
        const d = detected.get(slug);
        if (!d) detected.set(slug, { version: version || null, source });
        else if (version && (!d.version || /asset URL|REST/.test(d.source))) detected.set(slug, { version, source });
    };
    const base = { category: 'exposure', confidence: 'certain', owner: 'hosting' };

    const home = await probe.get('/', { maxBytes: 400000 });
    if (!home || home.status === 0) throw Object.assign(new Error(`Cannot reach ${url} (${home && home.error})`), { code: 'UNREACHABLE' });
    const blocked = probe.stopped || (home.status === 403 ? 'the home page answered 403 Forbidden to the scanner' : home.status === 401 ? 'the home page asks for a password' : null);
    if (blocked) return { findings: [], detected: [], detectedThemes: [], requests: probe.requests, stopped: probe.stopped, blocked, notWordPress: false };

    const html = home.body;
    const headers = home.headers;
    for (const m of html.matchAll(/\/wp-content\/plugins\/([\w.-]+)\//g)) setDetected(m[1], null, 'front-end asset URL');
    for (const m of html.matchAll(/\/wp-content\/plugins\/([\w.-]+)\/[^"'\s?]*\?ver=(\d[\w.-]*)/g)) setDetected(m[1], m[2], 'front-end asset URL (?ver= may be a cache-buster)');
    const themeCount = new Map();
    for (const m of html.matchAll(/\/wp-content\/themes\/([\w.-]+)\//g)) themeCount.set(m[1], (themeCount.get(m[1]) || 0) + 1);
    const detectedThemes = [...themeCount].sort((a, b) => b[1] - a[1]).map(x => x[0]);
    for (const m of html.matchAll(/<meta[^>]+name=["']generator["'][^>]+content=["']([^"']+)["']/gi)) {
        for (const [re, slug] of GENERATORS) { const g = re.exec(m[1]); if (g) setDetected(slug, g[1], 'generator tag'); }
    }
    const yoast = /optimized with the Yoast SEO(?: Premium)? plugin v([\d.]+)/i.exec(html);
    if (yoast) setDetected('wordpress-seo', yoast[1], 'page comment');

    const gen = /<meta name="generator" content="WordPress ([\d.]+)/i.exec(html);
    const wpHints = /wp-content|wp-includes|wp-json/i.test(html);
    if (gen) out.push(finding({ ...base, rule: 'live-generator', severity: 'P3', plugins: [], key: 'generator', title: `WordPress version ${gen[1]} is advertised in the page source`, detail: 'Helps attackers pick exploits for exactly your version.', fix: 'Remove the generator tag: `remove_action( \'wp_head\', \'wp_generator\' ); add_filter( \'the_generator\', \'__return_empty_string\' );`', patch: { type: 'harden', id: 'generator' }, owner: 'code', done: 'The page source no longer shows the WordPress version.' }));

    // REST root: namespaces reveal plugins that leave no trace in the HTML
    const rest = await probe.get('/wp-json/', { maxBytes: 300000 });
    let restOk = false;
    if (rest && rest.status === 200) {
        try {
            const j = JSON.parse(rest.body);
            if (Array.isArray(j.namespaces)) {
                restOk = true;
                for (const ns of j.namespaces) { const slug = NAMESPACES[String(ns).split('/')[0]]; if (slug) setDetected(slug, null, 'REST namespace'); }
            }
        } catch { /* truncated or not JSON */ }
    }
    const notWordPress = !wpHints && !restOk && !detected.size && !gen;

    // headers
    const missing = SEC_HEADERS.filter(([h, , https]) => (https ? /^https:/i.test(probe.base.protocol) : true) && !headers.get(h));
    if (!headers.get('x-frame-options') && !/frame-ancestors/i.test(headers.get('content-security-policy') || '')) missing.push(['x-frame-options', 'X-Frame-Options (clickjacking protection)', false]);
    if (missing.length) out.push(finding({ ...base, rule: 'live-security-headers', severity: missing.some(m => m[2]) ? 'P2' : 'P3', plugins: [], key: 'headers',
        title: `${missing.length} security header(s) missing on the home page`, detail: 'Headers tell browsers to refuse insecure behaviour (downgrade to HTTP, framing the site, guessing file types).', evidence: missing.map(m => m[1]),
        fix: 'Add the headers in the web server (patches in the fix file) or with a headers plugin. Start with HSTS only after HTTPS works everywhere.', patch: { type: 'htaccess', id: 'headers' }, done: 'A header check shows all listed headers present.' }));
    const disclose = [headers.get('server'), headers.get('x-powered-by')].filter(v => v && /\d+\.\d+/.test(v));
    if (disclose.length) out.push(finding({ ...base, rule: 'live-version-disclosure', severity: 'P3', plugins: [], key: 'server-version', title: 'The server announces software versions', detail: 'Response headers show exact versions, which narrows down known exploits.', evidence: disclose, fix: 'Hide them: Apache `ServerTokens Prod`, nginx `server_tokens off;`, PHP `expose_php = Off`.', patch: { type: 'htaccess', id: 'server-tokens' }, done: 'The Server and X-Powered-By headers carry no version numbers.' }));
    const poweredPhp = /PHP\/([\d.]+)/i.exec(headers.get('x-powered-by') || '');

    // HTTPS and certificate
    const host = probe.base.hostname;
    if (probe.base.protocol === 'http:' && !isLocalHost(host)) {
        out.push(finding({ ...base, rule: 'live-no-https', severity: 'P1', plugins: [], key: 'http', title: 'The site is served over plain HTTP', detail: 'Logins, cookies and form data cross the internet readable by anyone on the path.', fix: 'Install a certificate (Let\'s Encrypt), redirect HTTP to HTTPS, set the site address to https://.', done: 'The https:// address works and http:// redirects to it.' }));
    } else if (probe.base.protocol === 'https:') {
        const r = await probe.get(`http://${probe.base.host}/`, { redirect: 'manual', maxBytes: 256 });
        if (r && r.status === 200) out.push(finding({ ...base, rule: 'live-http-not-redirected', severity: 'P1', plugins: [], key: 'http-redirect', title: 'http:// is served instead of redirecting to https://', detail: 'Visitors who type or follow an http link stay unencrypted.', fix: 'Add a permanent (301) redirect from HTTP to HTTPS.', patch: { type: 'htaccess', id: 'https-redirect' }, done: 'http:// answers with a 301 to https://.' }));
        const c = await certProbe(host, Number(probe.base.port) || 443);
        if (c && c.validTo) {
            const days = Math.floor((new Date(c.validTo) - Date.now()) / 86400000);
            if (days < 0) out.push(finding({ ...base, rule: 'live-cert-expired', severity: 'P0', plugins: [], key: 'cert', title: `The TLS certificate expired ${-days} day(s) ago`, detail: 'Browsers show a full-page warning.', fix: 'Renew the certificate and turn on automatic renewal.', done: 'The certificate is valid for more than 30 days.' }));
            else if (days < 30) out.push(finding({ ...base, rule: 'live-cert-expiring', severity: days < 14 ? 'P1' : 'P2', plugins: [], key: 'cert', title: `The TLS certificate expires in ${days} day(s)`, detail: 'An expired certificate takes the site offline for most visitors.', fix: 'Renew it now and check that automatic renewal works.', done: 'The certificate is valid for more than 30 days.' }));
            if (c.authorized === false && days >= 0) out.push(finding({ ...base, rule: 'live-cert-untrusted', severity: 'P1', plugins: [], key: 'cert-trust', title: `The TLS certificate is not trusted (${c.authError || 'unknown reason'})`, detail: 'Self-signed, wrong host name or missing intermediate certificate.', fix: 'Install a certificate from a public authority that matches the site name.', done: 'Browsers accept the certificate without a warning.' }));
        }
    }

    // plugin readme files: one aggregated finding
    const readable = [];
    for (const slug of [...detected.keys()].slice(0, 40)) {
        const r = await probe.get(`/wp-content/plugins/${slug}/readme.txt`, { maxBytes: 2048 });
        if (!r) break;
        if (r.status === 200 && /===\s*.+\s*===|Stable tag:/i.test(r.body)) {
            readable.push(slug);
            const tag = /Stable tag:\s*([\w.-]+)/i.exec(r.body);
            const d = detected.get(slug);
            if (!d.version && tag) { d.version = tag[1]; d.source = 'readme.txt Stable tag (may differ from installed version)'; }
        }
    }
    if (readable.length) out.push(finding({ ...base, rule: 'live-readme', severity: 'P3', plugins: [], key: 'readme', title: `${readable.length} plugin readme file(s) are publicly readable`, detail: 'They state the plugin and version, which lets attackers look up matching exploits.', evidence: readable, fix: 'Block readme/license/changelog files in the web server.', patch: { type: 'htaccess', id: 'readme' }, done: 'Requesting a plugin readme.txt returns 403/404.' }));

    for (const s of SENSITIVE) {
        const r = await probe.get(s.path);
        if (!r) break;
        if (r.status === 200 && s.sig.test(r.body)) out.push(finding({ ...base, rule: 'live-sensitive-file', severity: s.sev, plugins: [], key: s.path, title: s.title, detail: `GET ${s.path} returned content matching its signature (content not stored).`, fix: 'Block it in the web server, delete the file, and rotate any secret it held.', patch: { type: 'htaccess', id: s.htaccess }, done: `GET ${s.path} returns 403 or 404.` }));
    }

    const inst = await probe.get('/wp-admin/install.php', { maxBytes: 20000 });
    if (inst && inst.status === 200 && /name=["']weblog_title["']/i.test(inst.body)) out.push(finding({ ...base, rule: 'live-not-installed', severity: 'P0', plugins: [], key: 'install', title: 'WordPress is not installed: anyone can run the installer', detail: 'The first visitor sets the admin account and takes over the site.', fix: 'Finish the installation yourself immediately, or take the site offline.', owner: 'admin', done: '/wp-admin/install.php says WordPress is already installed.' }));

    const users = await probe.get('/wp-json/wp/v2/users?per_page=1', { maxBytes: 2048 });
    if (users && users.status === 200 && /^\s*\[\s*\{/.test(users.body)) out.push(finding({ ...base, rule: 'live-user-enum-rest', severity: 'P1', plugins: [], key: 'rest-users', title: 'User list is exposed at /wp-json/wp/v2/users', detail: 'Usernames make brute-force and credential-stuffing far easier.', fix: 'Require login for the users endpoint (code in the fix file).', patch: { type: 'harden', id: 'users-rest' }, owner: 'code', done: '/wp-json/wp/v2/users returns 401 for visitors.' }));
    const author = await probe.get('/?author=1', { redirect: 'manual', maxBytes: 256 });
    if (author && [301, 302].includes(author.status) && /\/author\/[^/]+/.test(author.headers.get('location') || '')) out.push(finding({ ...base, rule: 'live-user-enum-author', severity: 'P1', plugins: [], key: 'author', title: 'Usernames leak through /?author=N redirects', detail: 'Requesting /?author=1 redirects to /author/<username>/.', fix: 'Block author enumeration (code in the fix file).', patch: { type: 'harden', id: 'author-enum' }, owner: 'code', done: '/?author=1 no longer redirects to an author page.' }));
    const sm = await probe.get('/wp-sitemap-users-1.xml', { maxBytes: 4096 });
    if (sm && sm.status === 200 && /<loc>[^<]*\/author\//i.test(sm.body)) out.push(finding({ ...base, rule: 'live-user-enum-sitemap', severity: 'P2', plugins: [], key: 'sitemap-users', title: 'Usernames are listed in wp-sitemap-users-1.xml', detail: 'The built-in sitemap lists author pages.', fix: 'Remove the users provider from the sitemap: `add_filter( \'wp_sitemaps_add_provider\', fn( $p, $name ) => \'users\' === $name ? false : $p, 10, 2 );`', patch: { type: 'harden', id: 'sitemap-users' }, owner: 'code', done: 'wp-sitemap-users-1.xml returns 404.' }));
    const xmlrpc = await probe.get('/xmlrpc.php', { maxBytes: 512 });
    if (xmlrpc && /XML-RPC server accepts POST requests only/i.test(xmlrpc.body)) {
        const needed = detected.has('jetpack');
        out.push(finding({ ...base, rule: 'live-xmlrpc', severity: needed ? 'P3' : 'P1', plugins: [], key: 'xmlrpc', title: 'xmlrpc.php is enabled', detail: needed ? 'Jetpack is active and uses XML-RPC: restrict rather than disable.' : 'XML-RPC allows credential brute-force (system.multicall) and pingback abuse.', fix: needed ? 'Restrict XML-RPC at the web server to Jetpack\'s IP ranges.' : 'Disable it (code in the fix file).', patch: needed ? null : { type: 'harden', id: 'xmlrpc' }, owner: 'code', done: 'xmlrpc.php returns 403/404 or the XML-RPC filter is off.' }));
    }
    const rm = await probe.get('/readme.html', { maxBytes: 4096 });
    if (rm && rm.status === 200 && /WordPress/i.test(rm.body) && /Version\s+[\d.]+/i.test(rm.body)) out.push(finding({ ...base, rule: 'live-core-readme', severity: 'P3', plugins: [], key: 'readme.html', title: '/readme.html reveals the WordPress version', detail: 'The default readme states the exact version.', fix: 'Delete readme.html or block it.', patch: { type: 'htaccess', id: 'core-readme' }, done: '/readme.html returns 404/403.' }));

    record('live', 'Live site checks', 'done', `${probe.requests} requests`);

    return { findings: out, detected: [...detected].map(([slug, d]) => ({ slug, ...d })), detectedThemes, requests: probe.requests, stopped: probe.stopped, blocked: null, notWordPress, phpFromHeader: poweredPhp ? poweredPhp[1] : null };
}

// What the live site loads vs what the local copy contains.
function compareWithLocal(detected, localPlugins) {
    const out = [];
    const base = { category: 'conflict', confidence: 'certain', owner: 'admin' };
    for (const d of detected) {
        const local = localPlugins.find(p => p.slug === d.slug);
        if (!local) out.push(finding({ ...base, category: 'exposure', rule: 'live-unknown-plugin', severity: 'P2', plugins: [d.slug], key: d.slug, title: `Live site loads plugin "${d.slug}" that is not in the local copy`, detail: 'The local copy differs from what is live. Findings for this plugin cannot be checked statically.', fix: 'Refresh the local copy from production before relying on a full scan.', done: 'The local copy contains the plugin.' }));
        else if (!local.active) out.push(finding({ ...base, rule: 'live-inactive-loaded', severity: 'P2', plugins: [d.slug], key: d.slug, title: `"${d.slug}" is inactive in the local copy but its files load on the live site`, detail: 'The local copy and production disagree about which plugins are active.', fix: 'Refresh the local copy (files and database) from production.', done: 'Local and live agree.' }));
        else if (d.version && local.version && /generator|comment|Stable/.test(d.source) && compare(d.version, local.version) !== 0) out.push(finding({ ...base, rule: 'live-version-differs', severity: 'P2', plugins: [d.slug], key: d.slug, title: `"${d.slug}" is ${d.version} on the live site but ${local.version} in the local copy`, detail: `Version read from the ${d.source}. The local scan may describe a different code base than production.`, fix: 'Refresh the local copy from production.', done: 'Local and live versions match.' }));
    }
    return out;
}

module.exports = { run, compareWithLocal, Probe, SENSITIVE, tlsProbe };
