// Agent 3: independent validation. It trusts neither agent: it re-reads the cited files, re-runs cheap local checks (php -l, file modes),
// re-computes ownership itself, de-duplicates, correlates browser symptoms with source findings, and only then assigns the final status.
// It never contacts the website (no extra requests) and never modifies the application.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const schema = require('../lib/schema');
const runs = require('../lib/runs');
const ownership = require('../lib/ownership');

const KEYWORD = {
    'code-eval': /\beval\s*\(/, 'code-sql-user-input': /\$wpdb->/, 'code-upload-no-type-check': /move_uploaded_file/, 'code-include-user-input': /\b(include|require)(_once)?\b/,
    'code-unserialize-user-input': /unserialize\s*\(/, 'code-exec-user-input': /\b(exec|system|passthru|popen|proc_open|shell_exec|eval|assert)\s*\(/, 'rest-no-permission': /register_rest_route/,
    'ajax-nopriv-unprotected': /wp_ajax_nopriv_|admin_post_nopriv_/, 'hook-priority': /add_(action|filter)/, 'hook-removed': /remove_(action|filter)/, 'xss-request-output': /\$_(GET|POST|REQUEST|COOKIE)/,
    'sql-unprepared-variable': /\$wpdb->/, 'hardcoded-secret': /(api[_-]?key|secret|passw|token|auth[_-]?key|private[_-]?key)/i, 'open-redirect': /wp_redirect/, 'nonce-without-capability': /wp_ajax_/,
    'redeclare-function': /\bfunction\s/, 'redeclare-class': /\b(class|interface|trait)\s/, 'dep-implied': /./, 'shared-constant': /define\s*\(/, 'shared-shortcode': /add_shortcode/, 'shared-ajax-action': /wp_ajax_|admin_post_/
};
const ACTIVE_STATUS = ['CONFIRMED', 'REPRODUCIBLE', 'PROBABLE_NEEDS_REVIEW'];
const note = (f, text) => { f.validation_notes.push(text); };

function readLines(abs) { try { const st = fs.statSync(abs); if (st.size > 3 * 1024 * 1024) return null; return fs.readFileSync(abs, 'utf8').split('\n'); } catch { return null; } }

// -> sets f.status (+ note). Only local, read-only checks.
function verifyCode(f, root, policy) {
    const rule = f.rule || '';
    const fact = verifyFact(f, root);
    if (fact) { f.status = fact.status; note(f, fact.note); if (fact.status === 'CONFIRMED') f.reproduction_steps = fact.steps; return; }
    if (!f.file_path) { f.status = 'UNVERIFIED'; note(f, 'No file path: nothing to re-check locally.'); return; }
    const r = ownership.resolveInside(root, f.file_path);
    if (!r.ok) { f.status = 'UNVERIFIED'; note(f, `Cited path rejected: ${r.reason}.`); f.file_path = null; return; }
    if (!fs.existsSync(r.abs)) { f.status = 'UNVERIFIED'; note(f, 'Cited file does not exist in the project root.'); return; }
    if (rule === 'php-syntax-error') {
        const l = spawnSync('php', ['-l', r.abs], { encoding: 'utf8', timeout: 20000 });
        if (l.status !== 0 && !l.error) { f.status = 'REPRODUCIBLE'; f.reproduction_steps = [`php -l ${r.rel}`, 'Observe the parse error and a non-zero exit code.']; note(f, 'Agent 3 re-ran php -l and got the same error.'); }
        else { f.status = 'UNVERIFIED'; note(f, 'php -l no longer reports an error (fixed since the scan, or php unavailable).'); }
        return;
    }
    const lines = readLines(r.abs);
    if (!lines) { f.status = 'UNVERIFIED'; note(f, 'File could not be read (too large or unreadable).'); return; }
    if (rule === 'code-no-abspath') {
        if (lines.some(l => /\b(ABSPATH|WPINC|WP_UNINSTALL_PLUGIN)\b/.test(l) && /defined|exit|die/.test(l))) { f.status = 'REJECTED_FALSE_POSITIVE'; note(f, 'The file does contain an ABSPATH/WPINC guard.'); }
        else { f.status = 'PROBABLE_NEEDS_REVIEW'; note(f, 'No ABSPATH guard found in the file. Whether it is dangerous depends on what it does when requested directly.'); }
        return;
    }
    const kw = KEYWORD[rule];
    if (!kw) { f.status = f.status === 'UNVERIFIED' ? 'UNVERIFIED' : f.status; note(f, `No independent verifier for rule "${rule}": the original agent's claim is unchecked.`); return; }
    const hits = lines.map((l, i) => (kw.test(l) ? i + 1 : 0)).filter(Boolean);
    if (!hits.length) { f.status = 'REJECTED_FALSE_POSITIVE'; note(f, `The cited file contains no text matching the rule (${kw}).`); return; }
    const near = f.line_start ? hits.some(h => Math.abs(h - f.line_start) <= 6) : true;
    f.status = 'PROBABLE_NEEDS_REVIEW';
    note(f, near ? 'Pattern re-found at the cited location. This is a source pattern: reachability and exploitability are not established.' : 'Pattern exists in the file but not at the cited line (the file changed since the scan, or the scanner reported a nearby line).');
}

function verifyFact(f, root) {
    const rule = f.rule || '';
    const stat = p => { const r = ownership.resolveInside(root, p); if (!r.ok) return null; try { return { abs: r.abs, st: fs.statSync(r.abs) }; } catch { return null; } };
    if (rule === 'perm-world-writable') {
        const paths = (f.original && f.original.paths || []).length ? f.original.paths : f.evidence.map(e => String(e).replace(/\s*\(\d+\)\s*$/, ''));
        const bad = paths.map(p => ({ p, s: stat(p) })).filter(x => x.s && (x.s.st.mode & 0o002));
        if (bad.length) return { status: 'CONFIRMED', note: `Agent 3 re-checked the modes: ${bad.length} of ${paths.length} listed path(s) are still world-writable.`, steps: [`ls -ld ${bad.slice(0, 3).map(b => b.p).join(' ')}`, 'Observe the "w" in the last permission triplet.'] };
        return { status: 'UNVERIFIED', note: 'Listed paths are no longer world-writable (fixed since the scan?).' };
    }
    if (rule === 'perm-config-readable') {
        const s = stat('wp-config.php');
        return s && (s.st.mode & 0o004) ? { status: 'CONFIRMED', note: 'wp-config.php is still world-readable.', steps: ['ls -l wp-config.php'] } : { status: 'UNVERIFIED', note: 'wp-config.php is not world-readable now.' };
    }
    if (/^stray-/.test(rule) && rule !== 'stray-core-readme') {
        const paths = (f.original && f.original.paths || []).length ? f.original.paths : f.evidence;
        const there = paths.filter(p => stat(p));
        return there.length ? { status: 'CONFIRMED', note: 'The file or folder exists in the web folder.', steps: [`ls -ld ${there.slice(0, 3).join(' ')}`] } : { status: 'UNVERIFIED', note: 'The cited path no longer exists.' };
    }
    if (rule === 'stray-core-readme') { const p = (f.evidence || [])[0]; return p && stat(p) ? { status: 'CONFIRMED', note: 'The file exists.', steps: [`ls ${p}`] } : null; }
    if (rule === 'default-db-prefix') {
        const s = stat('wp-config.php');
        if (!s) return null;
        return /\$table_prefix\s*=\s*['"]wp_['"]/.test(fs.readFileSync(s.abs, 'utf8')) ? { status: 'CONFIRMED', note: 'wp-config.php sets $table_prefix to "wp_".', steps: ['grep table_prefix wp-config.php'] } : { status: 'UNVERIFIED', note: 'Prefix is not wp_ now.' };
    }
    return null;
}

function verifyFrontend(f, runDir) {
    if (['BLOCKED', 'NEEDS_AUTHORIZATION'].includes(f.status)) { note(f, 'A testing restriction, not a site defect. Nothing was bypassed.'); return; }
    const shots = f.evidence.filter(e => /^evidence\//.test(e));
    const present = shots.filter(e => fs.existsSync(path.join(runDir, e)));
    const missing = shots.length - present.length;
    if (missing) note(f, `${missing} referenced screenshot file(s) are missing from the run folder.`);
    const measured = f.original && f.original.status === 'Fail';
    if (!f.url) { f.status = 'UNVERIFIED'; note(f, 'No page URL recorded.'); return; }
    if (measured && (present.length || f.evidence.length)) {
        f.status = present.length ? 'CONFIRMED' : 'PROBABLE_NEEDS_REVIEW';
        note(f, present.length ? `The frontend agent measured this on the rendered page and ${present.length} screenshot(s) are stored in the run. Agent 3 did not reload the site (no extra requests).` : 'Measured by the frontend agent but no screenshot is stored, so it is not independently inspectable.');
    } else if (f.evidence.length) { f.status = 'PROBABLE_NEEDS_REVIEW'; note(f, 'Reported with page evidence but not a hard failure; needs a human look.'); }
    else { f.status = 'UNVERIFIED'; note(f, 'No usable evidence attached.'); }
}

function dedupe(findings) {
    const seen = new Map();
    const out = [];
    for (const f of findings) {
        const key = f.source_agent === 'code-security' ? `${f.rule}|${f.file_path}|${f.line_start}` : `${f.rule || f.title}|${f.url}`;
        const first = seen.get(key);
        if (first) { first.related_finding_ids.push(f.id); note(first, `Duplicate merged: ${f.id}`); continue; }
        seen.set(key, f);
        out.push(f);
    }
    return out;
}

const COMPONENT_IN_URL = /\/wp-content\/(plugins|themes|mu-plugins)\/([^/\s"'?#]+)/g;
function correlate(findings) {
    const bySource = new Map();
    for (const f of findings.filter(x => x.source_agent === 'code-security' && x.component)) { if (!bySource.has(f.component)) bySource.set(f.component, []); bySource.get(f.component).push(f); }
    for (const b of findings.filter(x => x.source_agent === 'user-frontend' && !['BLOCKED', 'NEEDS_AUTHORIZATION'].includes(x.status))) {
        const text = [b.title, b.description, ...b.evidence, JSON.stringify(b.original || {})].join(' ');
        const comps = new Set([...text.matchAll(COMPONENT_IN_URL)].map(m => `${m[1] === 'plugins' ? 'plugin' : m[1] === 'themes' ? 'theme' : 'mu'}:${m[2]}`));
        for (const c of comps) {
            const src = (bySource.get(c) || []).filter(s => ACTIVE_STATUS.includes(s.status) || s.status === 'UNVERIFIED');
            if (!b.component) b.component = c;
            if (!src.length) { note(b, `The failing resource belongs to ${c}; no source finding exists for that component.`); continue; }
            for (const s of src.slice(0, 5)) {
                if (!b.related_finding_ids.includes(s.id)) b.related_finding_ids.push(s.id);
                if (!s.related_finding_ids.includes(b.id)) s.related_finding_ids.push(b.id);
            }
            b.root_cause = b.root_cause || `Possible cause in ${c}: ${src.slice(0, 3).map(s => s.id).join(', ')} (same component as the failing resource). This is a correlation by component, not proof.`;
            note(b, `Browser symptom linked to source findings in ${c}: ${src.slice(0, 3).map(s => s.id).join(', ')}.`);
            for (const s of src.slice(0, 5)) note(s, `Browser finding ${b.id} involves the same component; check whether it is the symptom of this issue.`);
        }
    }
}

function decide(f, root, policy) {
    // ownership is recomputed here, from the allowlist alone
    f.ownership = f.file_path && policy ? ownership.classify(policy, f.file_path) : null;
    f.allowed_fix_paths = [];
    f.fix_eligible = false;
    if (f.source_agent !== 'code-security') { f.blocked_reason = f.blocked_reason || (['BLOCKED', 'NEEDS_AUTHORIZATION'].includes(f.status) ? f.blocked_reason : 'Frontend finding: fix the source finding it is linked to, or locate the template named in the evidence (no source file was analysed).'); return; }
    if (!ACTIVE_STATUS.includes(f.status)) { f.blocked_reason = f.blocked_reason || `Status ${f.status}: not actionable`; return; }
    if (!f.recommended_fix) { f.blocked_reason = 'No concrete fix was proposed'; return; }
    if (f.original && ['hosting', 'admin'].includes(f.original.owner)) { f.blocked_reason = `Not a source-code change (owner: ${f.original.owner}): decide it outside the code tasks.`; return; }
    if (!f.file_path) { f.blocked_reason = 'Not a source-code change (server, hosting or WordPress admin action): decide it outside the code tasks.'; return; }
    if (!f.ownership || f.ownership.owner !== 'custom') {
        f.blocked_reason = !f.ownership ? 'Ownership could not be determined (no project root).' : f.ownership.owner === 'unknown' ? `Needs an allowlist decision: ${f.ownership.reason}` : `Protected code, not a fix target: ${f.ownership.reason}`;
        return;
    }
    f.fix_eligible = true;
    f.allowed_fix_paths = [f.ownership.rel];
    f.blocked_reason = null;
}

async function run({ runId, now = new Date(), allowStale = false }) {
    const dir = runs.dirOf(runId);
    const manifest = runs.read(runId, 'run.json');
    const a1 = runs.read(runId, 'agent1.json');
    const a2 = runs.read(runId, 'agent2.json');
    const stages = [];
    const checks = [];
    const inputProblems = [];
    const stale = runs.compatibility(manifest, { now, maxAgeHours: 24 });
    let use1 = a1, use2 = a2;
    if (stale.length && !allowStale) {
        for (const p of stale) { inputProblems.push(p); checks.push({ id: 'freshness', label: 'Stage results still valid for this combination', status: 'FAILED', reason: p }); }
        if (stale.some(s => /^agent1/.test(s))) use1 = null;
        if (stale.some(s => /^agent2/.test(s))) use2 = null;
        if (stale.some(s => /^Agent 1 tested/.test(s))) use2 = null; // different sites: do not mix
    }
    stages.push({ id: 'agent1', name: 'Agent 1: user / frontend tests', state: use1 ? (use1.tests_ran ? 'completed' : 'not-run') : a1 ? 'stale' : 'missing' });
    stages.push({ id: 'agent2', name: 'Agent 2: code / security analysis', state: use2 ? 'completed' : a2 ? 'stale' : 'missing' });
    for (const a of [use1, use2]) if (a) checks.push(...a.checks.map(c => ({ ...c, agent: a.agent })));
    if (!use1) checks.push({ id: 'agent1-missing', agent: 'user-frontend', label: 'Frontend / user tests', status: 'NOT_RUN', reason: a1 ? 'result is stale or for a different site' : 'Agent 1 has not run for this run' });
    if (!use2) checks.push({ id: 'agent2-missing', agent: 'code-security', label: 'Source-code and security analysis', status: 'NOT_RUN', reason: a2 ? 'result is stale or for a different site' : 'Agent 2 has not run: no local WordPress source was analysed' });

    let raw = [...(use1 ? use1.findings : []), ...(use2 ? use2.findings : [])];
    const valid = [];
    for (const f of raw) {
        const probs = schema.validate(f);
        if (probs.length) inputProblems.push(`Rejected malformed finding ${f && f.id}: ${probs.join('; ')}`); else valid.push(f);
    }
    const root = use2 ? use2.root : null;
    let policy = null;
    if (root) { try { policy = ownership.loadPolicy(root, use2.policy).policy; } catch (e) { inputProblems.push(`Ownership policy could not be loaded: ${e.message}`); } }

    for (const f of valid) {
        f.original = { ...(f.original || {}), agent_status: f.status, agent_severity: f.severity };
        if (f.source_agent === 'code-security') { if (root && policy) verifyCode(f, root, policy); else { f.status = 'UNVERIFIED'; note(f, 'Project root unavailable.'); } }
        else if (f.source_agent === 'user-frontend') verifyFrontend(f, dir);
    }
    let findings = dedupe(valid);
    correlate(findings);
    for (const f of findings) {
        f.run_id = runId;
        if (f.severity === 'CRITICAL' && !['CONFIRMED', 'REPRODUCIBLE'].includes(f.status)) { f.severity = 'HIGH'; note(f, 'Severity capped at HIGH: CRITICAL needs a confirmed or reproduced finding.'); }
        if (f.status === 'REJECTED_FALSE_POSITIVE') f.severity = 'INFO';
        decide(f, root, policy);
    }
    const order = s => schema.SEVERITIES.indexOf(s);
    findings.sort((a, b) => order(a.severity) - order(b.severity) || a.id.localeCompare(b.id));
    const partial = stages.some(s => s.state !== 'completed');
    return {
        schema_version: schema.SCHEMA_VERSION, run_id: runId, generated_at: now.toISOString(), complete: !partial,
        target: { url: manifest.target.url || null, root: root },
        stages, checks, input_problems: inputProblems, findings, summary: schema.summarize(findings, checks),
        policy: policy ? { customPaths: policy.customPaths, protectedPaths: policy.protectedPaths } : null,
        runtime: use2 ? use2.runtime : null, inventory: use2 ? use2.inventory : null, tools: use2 ? use2.tools : [],
        limits: ['Agent 3 re-checks local files and runs php -l; it does not reload the website, so browser findings are not re-reproduced.', 'Source findings are pattern matches. PROBABLE_NEEDS_REVIEW means present in the code, not exploitable.']
    };
}

module.exports = { run, verifyCode, decide, dedupe, correlate, ACTIVE_STATUS };
