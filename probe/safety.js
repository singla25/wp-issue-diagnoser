// The probe's request safety layer (replaces the frontend's request governor for the page probe). One in-process object per probe run:
//   - CONCURRENCY 1: every request goes through governed(), which runs one at a time;
//   - PACING: a pause before each navigation / API request (0.75-1.25 x the base delay, doubled after every protection sign, up to 8x);
//   - DETECTION: Cloudflare / WAF challenge pages, 429, 403, 5xx, connection resets, classified from the status, headers and (for 403/429/503) the page text;
//   - STOP: the FIRST 429 or challenge ends the probe (no retry, no backoff); 403, 5xx and connection errors stop it at their own thresholds;
//     a 5xx page is retried exactly once, a second broken page stops the probe as "server instability";
//   - COOLDOWN: a stop caused by site protection is written to the cooldown file (per origin); while it is active the next run sends NOT ONE request;
//   - DENY-LIST: a target sub-resource already seen as 404/410/429 is never requested again in this run;
//   - it never works around a protection mechanism, and it only ever sends GET/HEAD.
// Its state is written to <stateDir>/governor.json after every change so that a run can be audited afterwards (the file name is kept for tools that read it).
const fs = require('fs');
const path = require('path');

class ProtectionStop extends Error { constructor(reason) { super(`Testing limited by site protection/rate limiting: ${reason}`); this.name = 'ProtectionStop'; this.reason = reason; } }
class SiteUnreachable extends Error { constructor(url, detail) { super(`Site unreachable (${String(detail).split('\n')[0].slice(0, 120)}) for ${url}: this is not site protection; check the URL / that the server is up. No cooldown recorded.`); this.name = 'SiteUnreachable'; } }
class TestStopped extends Error { constructor(reason) { super(`Test stopped for server safety: ${reason}`); this.name = 'TestStopped'; this.reason = reason; } }

const UNREACHABLE = /ECONNREFUSED|ERR_CONNECTION_REFUSED|ERR_NAME_NOT_RESOLVED|ENOTFOUND|EAI_AGAIN|ERR_ADDRESS_UNREACHABLE|ERR_NAME_RESOLUTION_FAILED/i;
const CONNECTION_ERROR = /ECONNRESET|ECONNREFUSED|ERR_CONNECTION_(RESET|CLOSED|REFUSED|ABORTED)|ERR_EMPTY_RESPONSE|socket hang up|ERR_TIMED_OUT|ETIMEDOUT|ERR_SSL_PROTOCOL_ERROR|ERR_HTTP2_PROTOCOL_ERROR/i;
const CHALLENGE_TEXT = /just a moment\.\.\.|attention required|verify you are human|access denied|checking your browser|captcha|request blocked|you have been blocked|sucuri website firewall|wordfence/i;
const sleep = ms => new Promise(r => setTimeout(r, ms));

// -> 'ok' | 'challenge' | 'rate-limited' | 'forbidden' | 'server-error'. A passive Cloudflare script on a normal page is NOT a challenge.
function classify({ status, headers = {}, title = '', bodySnippet = '' }) {
    const h = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
    if (h['cf-mitigated'] === 'challenge') return 'challenge';
    if ([403, 429, 503].includes(status) && CHALLENGE_TEXT.test(`${title} ${bodySnippet}`)) return 'challenge';
    if (status === 429) return 'rate-limited';
    if (status === 403) return 'forbidden';
    if (status >= 500) return 'server-error';
    return 'ok';
}
function retryAfterMs(headers = {}) {
    const raw = headers['retry-after'] || headers['Retry-After'];
    if (!raw) return null;
    const s = Number(raw); if (!Number.isNaN(s)) return s * 1000;
    const d = Date.parse(raw); return Number.isNaN(d) ? null : Math.max(0, d - Date.now());
}

class Safety {
    constructor(cfg, { origin, stateDir = null } = {}) {
        this.cfg = cfg; this.origin = origin; this.stateDir = stateDir;
        this.state = { startedAt: new Date().toISOString(), lastRequestAt: 0, requestsMade: 0, browserResponses: 0, targetResponses: 0, status429: 0, status403: 0, status5xx: 0, connectionErrors: 0, okResponses: 0, consecutive429: 0, slowFactor: 1, backoffEvents: [], protectionEvents: [], testsStopped: [], deniedUrls: [], challenges: 0, stopped: false, stopReason: null };
        this._chain = Promise.resolve();
        this.persist();
    }
    persist() { if (!this.stateDir) return; try { fs.mkdirSync(this.stateDir, { recursive: true }); fs.writeFileSync(path.join(this.stateDir, 'governor.json'), JSON.stringify(this.state, null, 2)); } catch { /* best effort */ } }
    isStopped() { return this.state.stopped; }
    stopReason() { return this.state.stopReason; }
    snapshot() { return this.state; }
    deniedUrls() { return this.state.deniedUrls; }
    isTargetHost(url) { try { return new URL(url).origin === this.origin; } catch { return false; } }

    // ---- cooldown (per origin), kept in the probe's own file ----
    readCooldown() {
        try {
            const all = JSON.parse(fs.readFileSync(this.cfg.cooldownFile, 'utf8'));
            const last = all.at ? all : all[this.origin];
            if (!last) return null;
            const until = new Date(last.at).getTime() + this.cfg.protectionCooldownMinutes * 60000;
            return Date.now() < until ? { at: last.at, reason: last.reason, until: new Date(until).toISOString() } : null;
        } catch { return null; }
    }
    writeCooldown() {
        if (!this.state.stopped || /^Cooling down/.test(this.state.stopReason || '')) return;
        let cd = {}; try { cd = JSON.parse(fs.readFileSync(this.cfg.cooldownFile, 'utf8')); } catch { /* none yet */ }
        if (cd.at) cd = {};
        cd[this.origin] = { at: new Date().toISOString(), reason: this.state.stopReason };
        fs.mkdirSync(path.dirname(this.cfg.cooldownFile), { recursive: true });
        fs.writeFileSync(this.cfg.cooldownFile, JSON.stringify(cd, null, 2));
    }

    tripBreaker(reason, evidence = {}) {
        if (!this.state.stopped) { this.state.stopped = true; this.state.stopReason = reason; }
        this.state.protectionEvents.push({ at: new Date().toISOString(), reason, ...evidence });
        this.persist();
    }

    recordOutcome(outcome, { url, status, source = 'probe', detail } = {}) {
        const s = this.state;
        if (outcome === 'rate-limited') { s.status429++; s.consecutive429++; s.slowFactor = Math.min(s.slowFactor * 2, 8); }
        else if (outcome === 'forbidden') { s.status403++; s.slowFactor = Math.min(s.slowFactor * 2, 8); }
        else if (outcome === 'challenge') { s.challenges++; s.slowFactor = Math.min(s.slowFactor * 2, 8); }
        else if (outcome === 'server-error') s.status5xx++;
        else if (outcome === 'connection-error') s.connectionErrors++;
        else if (outcome === 'ok') { s.consecutive429 = 0; s.okResponses++; }
        const ev = { url, status, source, ...(detail ? { detail: String(detail).slice(0, 120) } : {}) }, c = this.cfg;
        // a challenge on a PAGE stops at once; on one sub-resource it counts like a 429 (and that URL is never asked for again)
        if (outcome === 'challenge' && source !== 'browser-subresource') this.tripBreaker('Cloudflare/WAF challenge, CAPTCHA or block page', ev);
        else if (outcome === 'challenge' && s.challenges + s.status429 >= c.stopAfter429) this.tripBreaker(`Repeated challenges on page assets (${s.challenges})`, ev);
        else if (s.status429 >= c.stopAfter429) this.tripBreaker(`Repeated rate limiting (${s.status429} x HTTP 429)`, ev);
        else if (s.status403 >= c.stopAfter403) this.tripBreaker(`Increasing 403 Forbidden responses (${s.status403})`, ev);
        else if (s.status5xx >= c.stopAfter5xx) this.tripBreaker(`Server instability (${s.status5xx} x 5xx)`, ev);
        else if (s.connectionErrors >= c.stopAfterConnectionErrors) this.tripBreaker(`Connection resets/timeouts (${s.connectionErrors})`, ev);
        else this.persist();
        return outcome;
    }

    // every response the BROWSER received from the target (sub-resources and documents alike): not agent-initiated, but 429/403/5xx still count
    observeBrowserResponse(url, status, headers, resourceType = 'other') {
        const target = this.isTargetHost(url), s = this.state;
        s.browserResponses++;
        if (target) s.targetResponses++;
        if (target && resourceType !== 'document' && [404, 410, 429].includes(status) && !s.deniedUrls.includes(url) && s.deniedUrls.length < 500) s.deniedUrls.push(url);
        if (!target || resourceType === 'document') { this.persist(); return; }   // documents are judged by navigate(), which sees the page text too
        const outcome = classify({ status, headers });
        if (outcome !== 'ok') this.recordOutcome(outcome, { url, status, source: 'browser-subresource' }); else this.persist();
    }

    // ---- pacing + one request at a time ----
    async pace(kind) {
        if (this.state.stopped) throw new ProtectionStop(this.state.stopReason);
        const unit = kind === 'navigation' ? this.cfg.navigationDelayMs : this.cfg.requestDelayMs;
        const base = Math.min(unit * this.state.slowFactor, this.cfg.maxDelayMs);
        const delay = base * (0.75 + Math.random() * 0.5);
        const start = Math.max(Date.now(), (this.state.lastRequestAt || 0) + delay);
        this.state.lastRequestAt = start; this.state.requestsMade++; this.persist();
        const wait = start - Date.now();
        if (wait > 0) await sleep(wait);
        if (this.state.stopped) throw new ProtectionStop(this.state.stopReason);
    }
    governed(fn, kind = 'request') {
        const run = this._chain.then(async () => { await this.pace(kind); return fn(); });
        this._chain = run.catch(() => {});   // the next request waits for this one, whether it worked or not
        return run;
    }
    async backoff(url, headers) {
        const step = Math.max(0, this.state.consecutive429 - 1);
        let wait = this.cfg.backoffScheduleMs[Math.min(step, this.cfg.backoffScheduleMs.length - 1)];
        const ra = retryAfterMs(headers);
        if (ra !== null) { if (ra > this.cfg.maxRetryAfterMs) { this.tripBreaker(`Server asked us to wait ${Math.round(ra / 1000)}s (Retry-After)`, { url }); throw new ProtectionStop(this.state.stopReason); } wait = Math.max(wait, ra); }
        this.state.backoffEvents.push({ at: new Date().toISOString(), url, waitMs: wait, consecutive429: this.state.consecutive429 }); this.persist();
        await sleep(wait);
    }

    // Navigates a page. -> { response, status, outcome, retried, firstStatus, title }
    async navigate(page, url, { waitUntil = 'domcontentloaded', settleMs = 1200 } = {}) {
        const attempt = () => this.governed(async () => {
            try {
                const response = await page.goto(url, { waitUntil, timeout: this.cfg.navigationTimeoutMs });
                if (settleMs) await page.waitForTimeout(settleMs);
                const status = response ? response.status() : 0, headers = response ? response.headers() : {};
                const title = await page.title().catch(() => '');
                let bodySnippet = ''; if ([403, 429, 503].includes(status)) bodySnippet = (await page.locator('body').innerText().catch(() => '')).slice(0, 2000);
                return { response, status, headers, outcome: classify({ status, headers, title, bodySnippet }), title };
            } catch (error) {
                if (UNREACHABLE.test(error.message) && !this.state.okResponses) throw new SiteUnreachable(url, error.message);
                if (CONNECTION_ERROR.test(error.message)) { this.recordOutcome('connection-error', { url, status: 0 }); return { response: null, status: 0, headers: {}, outcome: 'connection-error', error: error.message }; }
                throw error;
            }
        }, 'navigation');
        const note = r => this.recordOutcome(r.outcome, { url, status: r.status, detail: r.outcome === 'ok' ? undefined : r.title });
        let result = await attempt(); note(result);
        const firstStatus = result.status;
        if (result.outcome === 'challenge') throw new ProtectionStop(this.state.stopReason);
        if (result.outcome === 'rate-limited') {            // with the first-429 rule the breaker is already tripped here; kept for a raised threshold
            if (this.state.stopped) throw new ProtectionStop(this.state.stopReason);
            await this.backoff(url, result.headers); result = await attempt(); note(result);
            if (result.outcome === 'challenge' || this.state.stopped) throw new ProtectionStop(this.state.stopReason);
            if (result.outcome === 'rate-limited') throw new TestStopped(`HTTP 429 persisted after backoff on ${url}`);
            return { ...result, retried: true, firstStatus };
        }
        if (result.outcome === 'server-error' || result.outcome === 'connection-error') {   // retried exactly once, after a pause
            if (this.state.stopped) throw new ProtectionStop(this.state.stopReason);
            await sleep(this.cfg.serverErrorRetryDelayMs); result = await attempt(); note(result);
            if (result.outcome === 'challenge' || this.state.stopped) throw new ProtectionStop(this.state.stopReason);
            return { ...result, retried: true, firstStatus };
        }
        return { ...result, retried: false, firstStatus };
    }

    // One paced GET/HEAD through an APIRequestContext (the "is the original public" check). Never follows more than 3 redirects.
    async request(api, url, { method = 'GET', maxRedirects = 3 } = {}) {
        if (!['GET', 'HEAD'].includes(method)) throw new Error(`Read-only probe: refusing ${method} request`);
        const attempt = () => this.governed(async () => {
            try {
                const res = await api.fetch(url, { method, maxRedirects, timeout: 20000, failOnStatusCode: false });
                const status = res.status(), headers = res.headers();
                const text = [403, 429, 503].includes(status) ? (await res.text().catch(() => '')).slice(0, 4000) : '';
                const title = (text.match(/<title[^>]*>([^<]*)<\/title>/i) || [])[1] || '';
                const outcome = classify({ status, headers, title: title.trim(), bodySnippet: text.slice(0, 2000) });
                await res.dispose();
                return { status, headers, finalUrl: res.url(), outcome, title: title.trim() };
            } catch (error) {
                if (UNREACHABLE.test(error.message) && !this.state.okResponses) throw new SiteUnreachable(url, error.message);
                if (CONNECTION_ERROR.test(error.message)) { this.recordOutcome('connection-error', { url, status: 0 }); return { status: 0, headers: {}, outcome: 'connection-error', error: error.message }; }
                return { status: 0, headers: {}, outcome: 'request-error', error: error.message };
            }
        });
        let result = await attempt(); this.recordOutcome(result.outcome, { url, status: result.status });
        const firstStatus = result.status;
        if (result.outcome === 'challenge') throw new ProtectionStop(this.state.stopReason);
        if (result.outcome === 'rate-limited') { if (this.state.stopped) throw new ProtectionStop(this.state.stopReason); await this.backoff(url, result.headers); result = await attempt(); this.recordOutcome(result.outcome, { url, status: result.status }); if (result.outcome === 'challenge' || this.state.stopped) throw new ProtectionStop(this.state.stopReason); if (result.outcome === 'rate-limited') throw new TestStopped(`HTTP 429 persisted after backoff on ${url}`); return { ...result, retried: true, firstStatus }; }
        if (result.outcome === 'server-error') { if (this.state.stopped) throw new ProtectionStop(this.state.stopReason); await sleep(this.cfg.serverErrorRetryDelayMs); result = await attempt(); this.recordOutcome(result.outcome, { url, status: result.status }); if (result.outcome === 'challenge' || this.state.stopped) throw new ProtectionStop(this.state.stopReason); return { ...result, retried: true, firstStatus }; }
        return { ...result, retried: false, firstStatus };
    }
}

module.exports = { Safety, classify, retryAfterMs, ProtectionStop, SiteUnreachable, TestStopped, UNREACHABLE, CONNECTION_ERROR };
