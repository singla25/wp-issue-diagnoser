// Settings of plugin-guard's own page probe. Environment variables only, all with safe defaults and clamped ranges (no file, no other module).
//   PG_PROBE_NAV_DELAY_MS        base pause between two page loads            default 2000   (0.75-1.25 x, doubled after each protection sign, up to 8x)
//   PG_PROBE_REQUEST_DELAY_MS    base pause between two API requests          default 1000
//   PG_PROBE_NAV_TIMEOUT_MS      one page load                                 default 45000
//   PG_PROBE_STOP_AFTER_403      403 answers before stopping                   default 3
//   PG_PROBE_STOP_AFTER_5XX      5xx answers (each attempt counts) before stopping  default 3: one broken page and its one retry are observed, a second broken page stops
//   PG_PROBE_STOP_AFTER_CONN     connection resets/timeouts before stopping    default 2
//   PG_PROBE_COOLDOWN_MINUTES    after site protection: no request at all for  default 30
//   PG_PROBE_COOLDOWN_FILE       where that is remembered                      default <plugin-guard>/state/probe-cooldown.json
//   PG_PROBE_UA_SUFFIX           added to the browser's User-Agent             default PluginGuard-Probe/1.0
// The first 429 or challenge always stops the probe (threshold 1, not configurable): it is a safety rule, not a setting.
const path = require('path');

const num = (name, def, { min = 0, max = Infinity } = {}) => { const raw = process.env[name]; if (raw === undefined || raw === '') return def; const n = Number(raw); return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : def; };

function resolve(overrides = {}) {
    return {
        navigationDelayMs: num('PG_PROBE_NAV_DELAY_MS', 2000, { min: 0, max: 30000 }),
        requestDelayMs: num('PG_PROBE_REQUEST_DELAY_MS', 1000, { min: 0, max: 15000 }),
        navigationTimeoutMs: num('PG_PROBE_NAV_TIMEOUT_MS', 45000, { min: 5000, max: 120000 }),
        stopAfter429: 1,
        stopAfter403: num('PG_PROBE_STOP_AFTER_403', 3, { min: 1, max: 5 }),
        stopAfter5xx: num('PG_PROBE_STOP_AFTER_5XX', 3, { min: 1, max: 6 }),
        stopAfterConnectionErrors: num('PG_PROBE_STOP_AFTER_CONN', 2, { min: 1, max: 5 }),
        protectionCooldownMinutes: num('PG_PROBE_COOLDOWN_MINUTES', 30, { min: 5, max: 1440 }),
        cooldownFile: process.env.PG_PROBE_COOLDOWN_FILE || path.join(__dirname, '..', 'state', 'probe-cooldown.json'),
        userAgentSuffix: process.env.PG_PROBE_UA_SUFFIX || 'PluginGuard-Probe/1.0',
        maxDelayMs: 30000,
        serverErrorRetryDelayMs: num('PG_PROBE_5XX_RETRY_DELAY_MS', 5000, { min: 0, max: 30000 }),
        backoffScheduleMs: [2000, 5000, 10000],
        maxRetryAfterMs: 60000,
        concurrency: 1,
        ...overrides
    };
}
module.exports = { resolve, num };
