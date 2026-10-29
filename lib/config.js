// Settings for the three-agent workflow. Sources, later wins: <root>/plugin-guard.config.json (or --config), then CLI flags.
// Credentials are NEVER read from files or flags: only from the environment (PG_TEST_USER / PG_TEST_PASSWORD),
// and they are never printed or written to a report.

const fs = require('fs');
const path = require('path');
const ownership = require('./ownership');

const ENVIRONMENTS = ['local', 'staging', 'live'];
const CONFIG_NAME = 'plugin-guard.config.json';
const KNOWN = ['url', 'environment', 'customPaths', 'protectedPaths', 'timeoutMinutes', 'maxAgeHours', 'runProjectTests', 'expectedPages'];

// npm --prefix runs scripts from src/plugin-guard; INIT_CWD is where the user typed the command.
const userCwd = () => process.env.INIT_CWD || process.cwd();
const userPath = p => (p ? path.resolve(userCwd(), p) : p);

function loadFile(file) {
    let raw;
    try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { throw new ConfigError([`${file} is not valid JSON (${e.message})`]); }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new ConfigError([`${file} must contain a JSON object`]);
    return raw;
}

class ConfigError extends Error { constructor(errors) { super(errors.join('\n')); this.errors = errors; this.exitCode = 2; } }

// o: parsed CLI options. extraKnown: further setting names a caller (src/combined) reads from the file itself, so they are not reported as unknown.
// -> { config, errors, warnings, file, raw }   (raw: the parsed settings file, or {})
function resolve(o = {}, { extraKnown = [] } = {}) {
    const errors = [], warnings = [];
    const root = o.root ? userPath(o.root) : null;
    const file = o.config ? userPath(o.config) : root && fs.existsSync(path.join(root, CONFIG_NAME)) ? path.join(root, CONFIG_NAME) : null;
    let raw = {};
    if (o.config && !fs.existsSync(file)) errors.push(`config file ${file} does not exist`);
    else if (file) { try { raw = loadFile(file); } catch (e) { errors.push(...e.errors); } }
    for (const k of Object.keys(raw)) if (!KNOWN.includes(k) && !extraKnown.includes(k)) warnings.push(`unknown setting "${k}" in ${path.basename(file)} (ignored)`);
    for (const k of Object.keys(raw)) if (/pass(word)?|secret|token|credential|api[-_]?key/i.test(k)) errors.push(`"${k}": credentials must not be stored in the config file; use the PG_TEST_USER / PG_TEST_PASSWORD environment variables`);

    const config = {
        root, file,
        url: o.url || raw.url || null,
        environment: o.env || raw.environment || null,
        authorizedLive: !!o.authorized,
        customPaths: raw.customPaths || [], protectedPaths: raw.protectedPaths || [],
        timeoutMinutes: Number(o['timeout-min'] || raw.timeoutMinutes || 20),
        maxAgeHours: Number(raw.maxAgeHours || 24),
        runProjectTests: !!o['run-project-tests'] || raw.runProjectTests === true,
        credentialsPresent: !!(process.env.PG_TEST_USER && process.env.PG_TEST_PASSWORD)
    };
    for (const c of o.custom || []) config.customPaths = [...config.customPaths, c];

    if (config.url) {
        try { const u = new URL(config.url); if (!/^https?:$/.test(u.protocol)) throw new Error('x'); config.url = u.href; } catch { errors.push(`url "${config.url}" is not a valid http(s) address`); }
    }
    if (config.environment && !ENVIRONMENTS.includes(config.environment)) errors.push(`environment must be one of ${ENVIRONMENTS.join(', ')}`);
    if (!(config.timeoutMinutes > 0 && config.timeoutMinutes <= 240)) errors.push('timeoutMinutes must be between 1 and 240');
    // Environment safety: a URL on a public host is "live" unless the owner says staging/local. Never guess it is safe.
    if (config.url && !config.environment) {
        const h = new URL(config.url).hostname;
        config.environment = /^(localhost|127\.|\[::1\]|.*\.(local|test|localhost|invalid))$/.test(h) ? 'local' : null;
    }
    if (config.root) {
        if (!fs.existsSync(config.root)) errors.push(`root ${config.root} does not exist`);
        else if (!fs.existsSync(path.join(config.root, 'wp-content'))) errors.push(`root ${config.root} has no wp-content folder: it must be the WordPress root (the folder with wp-config.php and wp-content)`);
        else {
            const p = ownership.loadPolicy(config.root, config);
            errors.push(...p.errors); warnings.push(...p.warnings);
            config.policy = p.policy;
            config.customPaths = p.policy.customPaths; config.protectedPaths = p.policy.protectedPaths;
        }
    }
    return { config, errors, warnings, file, raw };
}

// The URL stage may only start when the owner stated what kind of site it is.
function urlAuthorization(config) {
    if (!config.url) return { ok: false, code: 'NO_URL', message: 'No target URL. Pass --url https://your-site/' };
    if (!config.environment) return { ok: false, code: 'NEEDS_AUTHORIZATION', message: `Say what kind of site ${config.url} is: --env staging | local | live. The tool will not guess that a public site may be tested.` };
    if (config.environment === 'live' && !config.authorizedLive) return { ok: false, code: 'NEEDS_AUTHORIZATION', message: `${config.url} is marked live. Testing a live site needs the owner's permission: re-run with --authorized once you have it (prefer a staging copy).` };
    return { ok: true };
}

module.exports = { resolve, urlAuthorization, ConfigError, userPath, userCwd, CONFIG_NAME, ENVIRONMENTS };
