// What the browser saw on one page, recorded passively: responses, failed requests, console errors, uncaught page errors, requests that are not GET.
// Plus the two network guards the probe installs: the READ-ONLY guard (every state-changing request made by the page is aborted and counted) and the
// DENY-LIST (target sub-resources already seen as 404/410/429 are blocked for the rest of the run). Both are Chromium-level and send nothing themselves.

// failures that say nothing about the site: our own aborts, cache misses, the deny-list
const BENIGN_FAILURE = /net::ERR_ABORTED|NS_BINDING_ABORTED|ERR_BLOCKED_BY_CLIENT|ERR_CACHE_MISS|^inspector$|blockedbyclient/i;

class NetworkRecorder {
    constructor(page, safety) {
        this.page = page; this.safety = safety;
        this.reset();
        this.onResponse = response => {
            const request = response.request(), url = response.url(), status = response.status(), headers = response.headers();
            const entry = {
                url, status, type: request.resourceType(), method: request.method(), frame: request.frame() === this.page.mainFrame() ? 'main' : 'sub',
                // answered by site protection (rate limit / challenge), not by the real file
                mitigated: status === 429 || Boolean(headers['cf-mitigated']) || ([403, 503].includes(status) && /cloudflare/i.test(headers.server || '') && /text\/html/i.test(headers['content-type'] || '') && !/\.html?$/.test(safePath(url)) && request.resourceType() !== 'document')
            };
            this.responses.push(entry);
            if (safety) safety.observeBrowserResponse(url, status, headers, entry.type);
        };
        this.onFailed = request => {
            const errorText = (request.failure() && request.failure().errorText) || 'failed';
            this.failed.push({ url: request.url(), type: request.resourceType(), errorText, benign: BENIGN_FAILURE.test(errorText) });
            if (safety && /ERR_CONNECTION_RESET|ERR_CONNECTION_CLOSED|ERR_EMPTY_RESPONSE/.test(errorText) && safety.isTargetHost(request.url())) safety.recordOutcome('connection-error', { url: request.url(), status: 0, source: 'browser' });
        };
        this.onConsole = msg => {
            const loc = msg.location() || {}, entry = { text: msg.text().slice(0, 500), url: loc.url || '', line: loc.lineNumber };
            if (msg.type() === 'error') this.consoleErrors.push(entry);
        };
        this.onPageError = error => { this.pageErrors.push({ text: String(error.message || error).slice(0, 500), stack: String(error.stack || '').split('\n').slice(0, 4).join('\n') }); };
        page.on('response', this.onResponse); page.on('requestfailed', this.onFailed); page.on('console', this.onConsole); page.on('pageerror', this.onPageError);
    }
    reset() { this.responses = []; this.failed = []; this.consoleErrors = []; this.pageErrors = []; }
    errorResponses() { return this.responses.filter(r => r.status >= 400 && !r.mitigated); }
    // the generic "Failed to load resource" is reported through the network records instead
    meaningfulConsoleErrors() { return this.consoleErrors.filter(e => !/^Failed to load resource/i.test(e.text)); }
    detach() { this.page.off('response', this.onResponse); this.page.off('requestfailed', this.onFailed); this.page.off('console', this.onConsole); this.page.off('pageerror', this.onPageError); }
}
function safePath(u) { try { return new URL(u).pathname; } catch { return ''; } }

// Aborts every request that is not GET/HEAD/OPTIONS, except Cloudflare's own passive bot-detection beacon that every ordinary visitor sends.
async function installReadOnlyGuard(context, origin, blockedLog = []) {
    await context.route('**/*', route => {
        const request = route.request(), method = request.method(), url = request.url();
        if (['GET', 'HEAD', 'OPTIONS'].includes(method)) return route.continue();
        if (url.startsWith(`${origin}/cdn-cgi/`)) return route.continue();
        blockedLog.push({ method, url: url.split('?')[0], at: new Date().toISOString() });
        return route.abort('blockedbyclient');
    });
    return blockedLog;
}
// Sandbox mode: the page may be written to and clicked, but NOTHING outside the sandbox's own origin may be reached.
async function installSandboxGuard(context, origin, blockedLog = []) {
    await context.route('**/*', route => {
        const r = route.request(), u = r.url();
        let same = false; try { same = new URL(u).origin === origin; } catch { /* not a URL */ }
        if (same || u.startsWith('data:') || u.startsWith('blob:')) return route.continue();
        blockedLog.push({ method: r.method(), url: u.split('?')[0], at: new Date().toISOString() });
        return route.abort('blockedbyclient');
    });
    return blockedLog;
}
// Blocks known-missing sub-resources WITHOUT disabling the HTTP cache (unlike page.route). Chromium only; a no-op elsewhere.
async function applyDenyList(page, safety) {
    const urls = safety.deniedUrls();
    try {
        if (!page.__pgCdp) { page.__pgCdp = await page.context().newCDPSession(page); await page.__pgCdp.send('Network.enable'); }
        await page.__pgCdp.send('Network.setBlockedURLs', { urls });
    } catch { /* not Chromium */ }
    return urls.length;
}
module.exports = { NetworkRecorder, installReadOnlyGuard, installSandboxGuard, applyDenyList, BENIGN_FAILURE };
