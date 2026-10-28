// Agent 2: code and security tester. Read-only: inspects the local WordPress copy, never writes to it.
// Inspection covers everything (core and third-party code explain behaviour); fix eligibility is decided later and
// only for allowlisted custom code. Findings in protected code are grouped (one per rule and component) so they do not drown the real ones.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { scan } = require('../guard');
const projectLib = require('../lib/project');
const ownership = require('../lib/ownership');
const schema = require('../lib/schema');
const wpSecurity = require('../lib/wp-security');
const { evidencePaths } = require('../lib/fixfile');

const MAX_LINT = 3000, MAX_BYTES = 1.5 * 1024 * 1024;
const TOOLS = [
    { id: 'phpcs', bin: 'phpcs', why: 'WordPress Coding Standards: style and some security sniffs', offline: true, needs: 'composer global require wp-coding-standards/wpcs (not installed here)' },
    { id: 'phpstan', bin: 'phpstan', why: 'static type/flow analysis with the WordPress stubs', offline: true, needs: 'composer require --dev phpstan/phpstan szepeviktor/phpstan-wordpress, plus a phpstan.neon' },
    { id: 'semgrep', bin: 'semgrep', why: 'security rules for PHP', offline: false, needs: 'pip install semgrep; rules must be local files (--config auto downloads rules)' },
    { id: 'composer-audit', bin: 'composer', why: 'known vulnerabilities in composer.lock', offline: false, needs: 'composer; queries packagist advisories (network)' },
    { id: 'npm-audit', bin: 'npm', why: 'known vulnerabilities in package-lock.json', offline: false, needs: 'npm; queries the npm registry (network)' }
];

const has = bin => { const r = spawnSync(bin, ['--version'], { encoding: 'utf8', timeout: 15000 }); return !r.error && r.status === 0; };

function walkFiles(dir, rootAbs, out, policy) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
        if (out.length >= 20000) return;
        const full = path.join(dir, e.name);
        if (e.isSymbolicLink()) continue;
        if (e.isDirectory()) { if (!['node_modules', '.git', 'vendor'].includes(e.name)) walkFiles(full, rootAbs, out, policy); }
        else if (/\.(php|phtml|inc)$/i.test(e.name)) out.push(full);
    }
}

function customFiles(policy) {
    const files = [];
    for (const rel of policy.customPaths) {
        const abs = path.join(policy.root, rel);
        if (!fs.existsSync(abs)) continue;
        if (fs.statSync(abs).isFile()) { if (/\.(php|phtml|inc)$/i.test(abs)) files.push(abs); } else walkFiles(abs, policy.root, files, policy);
    }
    return files.filter(f => ownership.classify(policy, path.relative(policy.root, f)).owner === 'custom');
}

const rel = (policy, f) => path.relative(policy.root, f).split(path.sep).join('/');
const lineFrom = e => { const m = /:(\d+)(?:\s|$)/.exec(String(e)); return m ? Number(m[1]) : null; };

// legacy Plugin Guard finding -> v1 finding(s)
function convert(f, policy, runId) {
    const paths = evidencePaths(f);
    const primary = paths[0] || null;
    const own = primary ? ownership.classify(policy, primary) : null;
    const component = (primary && ownership.componentOf(primary)) || (f.plugins && f.plugins[0]) || null;
    const line = primary ? lineFrom((f.evidence || []).find(e => String(e).startsWith(primary))) : null;
    const type = f.category === 'conflict' ? 'conflict' : ['exposure', 'integrity', 'server', 'database', 'live'].includes(f.category) ? 'security' : f.severity === 'P3' && f.rule === 'hook-order-note' ? 'info' : 'defect';
    return schema.makeFinding({
        id: schema.stableId('PGC', f.rule, f.id), run_id: runId, title: f.title, description: f.detail, severity: schema.severityFromLegacy(f), status: 'UNVERIFIED',
        category: f.category || 'general', finding_type: type, source_agent: 'code-security', confidence: f.confidence || 'possible', component, file_path: primary, line_start: line, line_end: line,
        impact: f.why || null, evidence: (f.evidence || []).map(String).slice(0, 12), recommended_fix: f.fix || null, rule: f.rule,
        validation_steps: f.done ? [f.done] : [], ownership: own, original: { legacy_id: f.id, severity: f.severity, owner: f.owner, paths, plugins: f.plugins || [] }
    });
}

// Findings in code that is not ours: one finding per (rule, component), so 134 "no ABSPATH" hits in a third-party plugin read as one fact.
function groupProtected(list) {
    const groups = new Map();
    const keep = [];
    for (const f of list) {
        const prot = f.ownership && f.ownership.owner !== 'custom' && f.file_path;
        if (!prot) { keep.push(f); continue; }
        const key = `${f.rule}|${f.component}|${f.ownership.owner}`;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(f);
    }
    for (const items of groups.values()) {
        if (items.length === 1) { keep.push(items[0]); continue; }
        const first = items[0];
        const sev = schema.SEVERITIES[Math.min(...items.map(i => schema.SEVERITIES.indexOf(i.severity)))];
        keep.push({ ...first, id: schema.stableId('PGC', first.rule, first.component, 'group'), title: `${first.component}: ${items.length} locations — ${first.title.replace(/^[^ ]*\s/, '').slice(0, 110)}`,
            severity: sev, evidence: items.map(i => `${i.file_path}${i.line_start ? ':' + i.line_start : ''}`).slice(0, 30), file_path: first.file_path, line_start: first.line_start, line_end: first.line_end,
            description: `${first.description} (${items.length} similar locations in ${first.component}, grouped; first 30 listed.)`, original: { ...first.original, grouped: items.length } });
    }
    return keep;
}

function phpLint(files, policy, checks, runId) {
    const out = [];
    if (!has('php')) { checks.push({ id: 'php-lint', label: 'PHP syntax check (php -l) on custom code', status: 'NOT_RUN', reason: 'php is not installed' }); return out; }
    let n = 0, failed = 0;
    for (const f of files.slice(0, MAX_LINT)) {
        n++;
        const r = spawnSync('php', ['-l', f], { encoding: 'utf8', timeout: 20000 });
        if (r.status === 0) continue;
        failed++;
        const msg = (r.stdout + r.stderr).split('\n').find(l => /error/i.test(l)) || 'syntax error';
        const lm = /on line (\d+)/.exec(msg);
        const relp = rel(policy, f);
        out.push(schema.makeFinding({
            id: schema.stableId('PGC', 'php-syntax-error', relp), run_id: runId, title: `PHP syntax error in ${relp}`, description: msg.replace(f, relp).trim(), severity: 'HIGH', status: 'UNVERIFIED', category: 'php',
            finding_type: 'defect', source_agent: 'code-security', confidence: 'certain', component: ownership.componentOf(relp), file_path: relp, line_start: lm ? Number(lm[1]) : null, line_end: lm ? Number(lm[1]) : null,
            impact: 'PHP cannot parse this file: loading it is a fatal error (white screen) wherever it is included.', evidence: [`php -l ${relp}: ${msg.replace(f, relp).trim()}`], recommended_fix: 'Fix the syntax error reported by php -l.',
            validation_steps: [`php -l ${relp} exits 0`], rule: 'php-syntax-error', ownership: ownership.classify(policy, relp)
        }));
    }
    checks.push({ id: 'php-lint', label: 'PHP syntax check (php -l) on custom code', status: failed ? 'FAILED' : 'PASSED', reason: `${n} file(s) checked, ${failed} with errors${files.length > MAX_LINT ? ` (first ${MAX_LINT} only)` : ''}` });
    return out;
}

function customSecurity(files, policy, checks, runId) {
    const out = [];
    let scanned = 0;
    for (const f of files) {
        let st; try { st = fs.statSync(f); } catch { continue; }
        if (st.size > MAX_BYTES) continue;
        const relp = rel(policy, f);
        scanned++;
        for (const h of wpSecurity.scanCustom(fs.readFileSync(f, 'utf8'), relp)) {
            out.push(schema.makeFinding({
                id: schema.stableId('PGC', h.rule, relp, h.line), run_id: runId, title: h.title, description: h.detail, severity: h.weak || h.rule === 'sql-unprepared-variable' ? 'LOW' : 'MEDIUM', // no proof of attacker control, so never above MEDIUM
                status: 'UNVERIFIED', category: 'custom-code', finding_type: 'security', source_agent: 'code-security', confidence: 'possible', component: ownership.componentOf(relp), file_path: relp, line_start: h.line, line_end: h.line,
                evidence: [`${relp}:${h.line}`], recommended_fix: { 'xss-request-output': 'Escape on output with the function that matches the context (esc_html, esc_attr, esc_url) or cast numbers with absint().', 'sql-unprepared-variable': 'Build the query with $wpdb->prepare() and placeholders (%s, %d).', 'hardcoded-secret': 'Move the value out of the source (wp-config.php constant or environment), rotate it, and remove it from history.', 'open-redirect': 'Use wp_safe_redirect() and validate the target against an allow-list.', 'nonce-without-capability': 'Add current_user_can( <required capability> ) before changing data.' }[h.rule],
                rule: h.rule, ownership: ownership.classify(policy, relp), validation_steps: ['Re-run the scan: this rule no longer matches the line.']
            }));
        }
    }
    checks.push({ id: 'wp-security', label: 'WordPress security patterns in custom code (XSS, SQL, secrets, redirects, nonce vs capability)', status: 'PASSED', reason: `${scanned} custom file(s) scanned; pattern matching only, hits are "needs review", never proof of exploitability` });
    return out;
}

function toolStatus(policy, checks) {
    const tools = [];
    for (const t of TOOLS) {
        const installed = has(t.bin);
        tools.push({ id: t.id, installed, offline: t.offline, why: t.why, needs: t.needs });
        checks.push({ id: `tool-${t.id}`, label: `${t.id} (${t.why})`, status: 'NOT_RUN', reason: installed ? `installed but not run by this tool yet (needs project-specific configuration: ${t.needs})` : `not installed. ${t.needs}` });
    }
    return tools;
}

function projectTests(config, policy, checks) {
    const roots = [policy.root, ...policy.customPaths.map(p => path.join(policy.root, p))];
    const found = roots.map(r => ({ r, xml: ['phpunit.xml', 'phpunit.xml.dist'].find(x => fs.existsSync(path.join(r, x))), bin: path.join(r, 'vendor', 'bin', 'phpunit') })).find(x => x.xml && fs.existsSync(x.bin));
    if (!found) { checks.push({ id: 'project-tests', label: 'Existing PHPUnit tests', status: 'NOT_RUN', reason: 'no phpunit.xml with vendor/bin/phpunit found in the project or custom paths' }); return; }
    if (!config.runProjectTests) { checks.push({ id: 'project-tests', label: 'Existing PHPUnit tests', status: 'SKIPPED', reason: `found in ${rel(policy, found.r) || '.'}; running them executes project code, so it needs --run-project-tests` }); return; }
    const r = spawnSync(found.bin, ['-c', path.join(found.r, found.xml)], { cwd: found.r, encoding: 'utf8', timeout: 10 * 60000 });
    checks.push({ id: 'project-tests', label: 'Existing PHPUnit tests', status: r.error ? 'FAILED' : r.status === 0 ? 'PASSED' : 'FAILED', reason: r.error ? r.error.message : `exit ${r.status}: ${(r.stdout || r.stderr || '').trim().split('\n').slice(-2).join(' | ').slice(0, 300)}` });
}

async function run({ runId, config, now = new Date() }) {
    const checks = [];
    const { policy, errors } = ownership.loadPolicy(config.root, config);
    if (errors.length) throw Object.assign(new Error(errors.join('\n')), { exitCode: 2 });
    const wp = ownership.resolveInside(policy.root, 'wp-config.php');
    const runtime = { wpConfig: fs.existsSync(path.join(policy.root, 'wp-config.php')), wpCli: false, wordpressInstalled: false, reachableUrl: config.url || null };

    const project = projectLib.normalise({ url: null, path: policy.root, customPaths: policy.customPaths, protectedPaths: policy.protectedPaths }, 'adhoc');
    const result = await scan('adhoc', { project, now, save: false });
    runtime.wpCli = !result.notes.some(n => /WP-CLI is not installed/.test(n));
    runtime.wordpressInstalled = result.checks.some(c => /^db-/.test(c.id) && c.status === 'done');
    for (const c of result.checks) checks.push({ id: `scan-${c.id}`, label: c.label, status: c.status === 'done' ? 'PASSED' : 'SKIPPED', reason: c.reason || '' });

    const legacy = result.findings.map(f => convert(f, policy, runId));
    let findings = groupProtected(legacy);
    const files = customFiles(policy);
    if (!policy.customPaths.length) checks.push({ id: 'custom-code', label: 'Custom-code checks (php -l, WordPress security patterns)', status: 'SKIPPED', reason: 'no customPaths allowlist configured: nothing is treated as project-owned code. Add the folders you wrote to customPaths.' });
    else {
        findings.push(...phpLint(files, policy, checks, runId));
        findings.push(...customSecurity(files, policy, checks, runId));
    }
    const tools = toolStatus(policy, checks);
    projectTests(config, policy, checks);
    checks.push({ id: 'runtime', label: 'Running WordPress site', status: runtime.wordpressInstalled ? 'PASSED' : 'NOT_RUN', reason: runtime.wordpressInstalled ? 'WP-CLI reads an installed database (this does NOT prove a web server is serving it)' : 'No database/WP-CLI answer: this is a source checkout, not a running site. Runtime checks were not possible.' });

    const seen = new Set();
    findings = findings.filter(f => !seen.has(f.id) && seen.add(f.id));
    return {
        agent: 'code-security', run_id: runId, finished_at: new Date().toISOString(), root: policy.root, url: config.url, policy: { customPaths: policy.customPaths, protectedPaths: policy.protectedPaths },
        runtime, tools, checks, findings, inventory: { wordpress: result.wpVersion, php: result.phpVersion, components: result.components.map(c => ({ ref: c.ref, kind: c.kind, version: c.version, active: c.active })), customFiles: files.length },
        notes: result.notes, config_file: config.file || null
    };
}

module.exports = { run, customFiles, TOOLS };
