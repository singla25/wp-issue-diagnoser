// Per-project settings. One folder per project:
//   projects/<name>/project.json    settings the admin edits (schedule, outside-lookup permission, preferences)
//   projects/<name>/decisions.txt   the admin's fix / ignore / accept choices (see lib/decisions.js)
//   projects/<name>/history/*.json  one snapshot per run (see lib/history.js)
// Nothing runs on a schedule unless the admin sets one here.

const fs = require('fs');
const path = require('path');

const SCHEDULES = { none: 0, daily: 1, weekly: 7, monthly: 30 };
const NAME_RE = /^[a-z0-9][a-z0-9._-]{0,60}$/i;

const homeDir = () => process.env.PLUGIN_GUARD_HOME || path.join(__dirname, '..', 'projects');
const reportsRoot = () => process.env.PLUGIN_GUARD_REPORTS || path.join(__dirname, '..', '..', '..', 'reports', 'plugin-guard');
const dirOf = name => path.join(homeDir(), name);
const fileOf = name => path.join(dirOf(name), 'project.json');

const DEFAULTS = {
    url: null,                      // live site, e.g. https://example.com/
    path: null,                     // local copy of the site (WordPress root); enables the deep checks
    schedule: 'none',               // none | daily | weekly | monthly (approved by the admin, per project)
    scheduleSetAt: null,
    outsideLookups: { wordpressOrg: false, vulnerabilityDb: false }, // see lib/outside.js
    advisories: [],                 // local advisory JSON files (offline vulnerability data)
    precedence: [],                 // plugin order when hooks collide (first runs first)
    prefer: {},                     // { "firewall": "wordfence" }: which plugin to keep when two do the same job
    categories: [],                 // extra plugin categories: [{ id, label, pattern, security }]
    ignoreRules: [],                // rule names never reported for this project
    expectedAdminDomains: [],       // e-mail domains allowed for administrator accounts
    abandonedYears: 2,              // plugin not updated for this long = abandoned
    phpVersion: null,               // the SERVER's PHP version if different from this computer's
    active: null,                   // explicit active plugin slugs when WP-CLI is not available
    activeTheme: null,
    wpCliBin: null,
    customPaths: [],                // project-owned code (relative to the WordPress root). ONLY these may become fix tasks
    protectedPaths: []              // never a fix target, even inside customPaths
};

function validate(p) {
    const errors = [];
    if (p.url) { try { if (!/^https?:$/.test(new URL(p.url).protocol)) errors.push('url must start with http:// or https://'); } catch { errors.push(`url "${p.url}" is not a valid address`); } }
    if (p.path && !fs.existsSync(p.path)) errors.push(`path "${p.path}" does not exist`);
    if (!(p.schedule in SCHEDULES)) errors.push(`schedule must be one of: ${Object.keys(SCHEDULES).join(', ')}`);
    for (const k of ['wordpressOrg', 'vulnerabilityDb']) if (typeof p.outsideLookups[k] !== 'boolean') errors.push(`outsideLookups.${k} must be true or false`);
    for (const k of ['advisories', 'precedence', 'categories', 'ignoreRules', 'expectedAdminDomains', 'customPaths', 'protectedPaths']) if (!Array.isArray(p[k])) errors.push(`${k} must be a list`);
    if (typeof p.prefer !== 'object' || Array.isArray(p.prefer) || !p.prefer) errors.push('prefer must be an object like {"firewall":"wordfence"}');
    if (!(Number(p.abandonedYears) > 0)) errors.push('abandonedYears must be a positive number');
    return errors;
}

function normalise(raw, name) {
    return { ...DEFAULTS, ...raw, name, outsideLookups: { ...DEFAULTS.outsideLookups, ...(raw.outsideLookups || {}) } };
}

function load(name) {
    if (!NAME_RE.test(name || '')) throw new Error(`Project name "${name}" is not valid (letters, digits, . _ - only)`);
    if (!fs.existsSync(fileOf(name))) throw new Error(`Project "${name}" does not exist. Create it with: guard.js init ${name} --url https://your-site/`);
    let raw;
    try { raw = JSON.parse(fs.readFileSync(fileOf(name), 'utf8')); } catch (e) { throw new Error(`${fileOf(name)} is not valid JSON (${e.message})`); }
    const p = normalise(raw, name);
    const errors = validate(p);
    if (errors.length) throw new Error(`Project "${name}" has problems:\n  - ${errors.join('\n  - ')}\n  Fix them in ${fileOf(name)}`);
    return p;
}

function save(p) {
    const { name, ...rest } = p;
    fs.mkdirSync(dirOf(name), { recursive: true });
    fs.writeFileSync(fileOf(name), JSON.stringify(rest, null, 2) + '\n');
}

function create(name, opts, { force = false } = {}) {
    if (!NAME_RE.test(name || '')) throw new Error(`Project name "${name}" is not valid (letters, digits, . _ - only)`);
    if (fs.existsSync(fileOf(name)) && !force) throw new Error(`Project "${name}" already exists (use --force to overwrite its settings)`);
    if (!opts.url && !opts.path) throw new Error('A project needs at least --url <live site> or --path <local copy>');
    const p = normalise({ url: opts.url || null, path: opts.path ? path.resolve(opts.path) : null }, name);
    if (opts.schedule) { p.schedule = opts.schedule; p.scheduleSetAt = new Date().toISOString(); }
    if (opts.allowWordpressOrg) p.outsideLookups.wordpressOrg = true;
    if (opts.allowVulnDb) p.outsideLookups.vulnerabilityDb = true;
    const errors = validate(p);
    if (errors.length) throw new Error(errors.join('; '));
    save(p);
    return p;
}

function setSchedule(name, schedule, now = new Date()) {
    const p = load(name);
    if (!(schedule in SCHEDULES)) throw new Error(`schedule must be one of: ${Object.keys(SCHEDULES).join(', ')}`);
    p.schedule = schedule;
    p.scheduleSetAt = now.toISOString();
    save(p);
    return p;
}

function list() {
    if (!fs.existsSync(homeDir())) return [];
    return fs.readdirSync(homeDir(), { withFileTypes: true }).filter(e => e.isDirectory() && fs.existsSync(fileOf(e.name))).map(e => e.name).sort();
}

// A project is due when the admin approved a schedule and the last full scan is older than it.
function isDue(p, lastScanAt, now = new Date()) {
    const days = SCHEDULES[p.schedule];
    if (!days) return false;
    return !lastScanAt || now - new Date(lastScanAt) >= days * 86400000 - 3600000; // 1h grace so a cron at the same time of day still fires
}

module.exports = { normalise, DEFAULTS, load, save, create, setSchedule, list, isDue, validate, dirOf, fileOf, reportsRoot, reportsDir: name => path.join(reportsRoot(), name), SCHEDULES, NAME_RE };
