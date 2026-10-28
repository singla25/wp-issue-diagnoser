// The ONLY place that talks to outside services, and only when the project allows it.
//   wordpressOrg      api.wordpress.org / downloads.wordpress.org   (plugin facts, official file checksums, latest versions)
//   vulnerabilityDb   wpscan.com                                    (known vulnerabilities; needs WPSCAN_API_TOKEN in the environment)
// What is sent: plugin/theme slugs and versions, the WordPress version. Never site content, URLs or user data.
// Every request is counted so the report can say exactly what left this computer. A 429 stops all further lookups.

const UA = 'plugin-guard/1.0 (read-only security check)';

class Outside {
    constructor(project, { fetchImpl = fetch, delayMs = 250, token = process.env.WPSCAN_API_TOKEN, max = 400 } = {}) {
        this.allow = project.outsideLookups || {};
        this.fetch = fetchImpl;
        this.delayMs = delayMs;
        this.token = token;
        this.max = max;
        this.requests = [];     // { host, purpose }
        this.stopped = null;
        this.last = 0;
    }

    allowed(kind) { return !!this.allow[kind]; }

    skipReason(kind) {
        if (!this.allowed(kind)) return kind === 'wordpressOrg'
            ? 'outside lookups to wordpress.org are not allowed for this project (outsideLookups.wordpressOrg)'
            : 'outside lookups to the vulnerability database are not allowed for this project (outsideLookups.vulnerabilityDb)';
        if (kind === 'vulnerabilityDb' && !this.token) return 'WPSCAN_API_TOKEN is not set in the environment';
        if (this.stopped) return this.stopped;
        if (this.requests.length >= this.max) return `lookup limit of ${this.max} requests reached`;
        return null;
    }

    async get(kind, url, purpose, headers = {}) {
        const why = this.skipReason(kind);
        if (why) return { skipped: true, reason: why };
        const wait = this.last + this.delayMs - Date.now();
        if (wait > 0) await new Promise(r => setTimeout(r, wait));
        this.last = Date.now();
        this.requests.push({ host: new URL(url).host, purpose });
        let res;
        try {
            res = await this.fetch(url, { headers: { 'User-Agent': UA, ...headers }, signal: AbortSignal.timeout(15000) });
        } catch (e) {
            return { ok: false, status: 0, error: String(e.cause && e.cause.code || e.message) };
        }
        if (res.status === 429) {
            this.stopped = `${new URL(url).host} answered 429 (rate limit): further lookups stopped`;
            return { ok: false, status: 429, error: this.stopped };
        }
        let json = null;
        try { json = await res.json(); } catch { /* not JSON */ }
        return { ok: res.ok, status: res.status, json };
    }

    // ---- wordpress.org ----
    pluginInfo(slug, type = 'plugins') {
        const kind = type === 'themes' ? 'theme' : 'plugin';
        const q = `request%5Bslug%5D=${encodeURIComponent(slug)}&request%5Bfields%5D%5Bsections%5D=0&request%5Bfields%5D%5Bdescription%5D=0&request%5Bfields%5D%5Breviews%5D=0&request%5Bfields%5D%5Bbanners%5D=0&request%5Bfields%5D%5Bicons%5D=0&request%5Bfields%5D%5Bratings%5D=0&request%5Bfields%5D%5Bcontributors%5D=0`;
        return this.get('wordpressOrg', `https://api.wordpress.org/${type}/info/1.2/?action=${kind}_information&${q}`, `${kind} facts (${slug})`);
    }
    pluginChecksums(slug, version) {
        return this.get('wordpressOrg', `https://downloads.wordpress.org/plugin-checksums/${encodeURIComponent(slug)}/${encodeURIComponent(version)}.json`, `official file list (${slug} ${version})`);
    }
    coreChecksums(version, locale = 'en_US') {
        return this.get('wordpressOrg', `https://api.wordpress.org/core/checksums/1.0/?version=${encodeURIComponent(version)}&locale=${encodeURIComponent(locale)}`, `official core file list (${version})`);
    }
    coreLatest() {
        return this.get('wordpressOrg', 'https://api.wordpress.org/core/version-check/1.7/', 'latest WordPress version');
    }

    // ---- vulnerability database ----
    async vulnerabilities(slug) {
        const r = await this.get('vulnerabilityDb', `https://wpscan.com/api/v3/plugins/${encodeURIComponent(slug)}`, `known vulnerabilities (${slug})`, { Authorization: `Token token=${this.token}` });
        if (r.skipped || r.status === 404) return { skipped: r.skipped, reason: r.reason, list: [] };
        if (!r.ok) return { error: r.error || `HTTP ${r.status}`, list: [] };
        const body = (r.json || {})[slug] || {};
        return {
            list: (body.vulnerabilities || []).map(v => ({
                id: `wpscan:${v.id}`, slug, title: v.title, fixedIn: v.fixed_in || null, affected: v.fixed_in ? `<${v.fixed_in}` : '*',
                severity: (v.cvss && v.cvss.severity) || 'high', url: `https://wpscan.com/vulnerability/${v.id}`
            }))
        };
    }

    summary() {
        const by = {};
        for (const r of this.requests) { by[r.host] = (by[r.host] || 0) + 1; }
        return { total: this.requests.length, byHost: by, stopped: this.stopped };
    }
}

module.exports = { Outside };
