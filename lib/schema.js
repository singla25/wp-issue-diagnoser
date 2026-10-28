// Shared finding schema (v1) for all three agents and every report format.
// Agents emit findings with status UNVERIFIED / PROBABLE_NEEDS_REVIEW / BLOCKED / NEEDS_AUTHORIZATION; only Agent 3 decides
// CONFIRMED / REPRODUCIBLE / REJECTED_FALSE_POSITIVE / FIXED_VERIFIED. Every report is generated from the SAME final array.

const crypto = require('crypto');

const SCHEMA_VERSION = '1.0';
const SEVERITIES = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFO'];
const STATUSES = ['CONFIRMED', 'REPRODUCIBLE', 'PROBABLE_NEEDS_REVIEW', 'UNVERIFIED', 'BLOCKED', 'NEEDS_AUTHORIZATION', 'REJECTED_FALSE_POSITIVE', 'FIXED_VERIFIED'];
const AGENTS = ['user-frontend', 'code-security', 'validation'];
const TYPES = ['defect', 'security', 'conflict', 'access-restriction', 'info'];
const CONFIDENCE = ['certain', 'likely', 'possible'];

const FIELDS = ['schema_version', 'id', 'run_id', 'title', 'description', 'severity', 'status', 'category', 'finding_type', 'source_agent', 'confidence', 'component', 'file_path',
    'line_start', 'line_end', 'url', 'expected_behavior', 'actual_behavior', 'impact', 'root_cause', 'evidence', 'reproduction_steps', 'validation_steps',
    'related_finding_ids', 'recommended_fix', 'allowed_fix_paths', 'blocked_reason', 'created_at',
    // validation outcome (set by Agent 3)
    'validation_notes', 'ownership', 'fix_eligible', 'original', 'rule'];

const stableId = (prefix, ...parts) => `${prefix}-${crypto.createHash('sha1').update(parts.map(p => String(p ?? '')).join('|')).digest('hex').slice(0, 10)}`;

function makeFinding(o) {
    const f = {
        schema_version: SCHEMA_VERSION, id: null, run_id: null, title: '', description: '', severity: 'INFO', status: 'UNVERIFIED', category: 'general', finding_type: 'defect',
        source_agent: null, confidence: 'possible', component: null, file_path: null, line_start: null, line_end: null, url: null, expected_behavior: null, actual_behavior: null,
        impact: null, root_cause: null, evidence: [], reproduction_steps: [], validation_steps: [], related_finding_ids: [], recommended_fix: null, allowed_fix_paths: [],
        blocked_reason: null, created_at: new Date().toISOString(), validation_notes: [], ownership: null, fix_eligible: false, original: null, rule: null, ...o
    };
    return f;
}

// -> list of problems (empty when valid). Never throws: Agent 3 rejects bad input instead of crashing.
function validate(f) {
    const p = [];
    if (!f || typeof f !== 'object') return ['not an object'];
    if (f.schema_version !== SCHEMA_VERSION) p.push(`schema_version must be ${SCHEMA_VERSION}`);
    if (!f.id || typeof f.id !== 'string') p.push('id missing');
    if (!f.title || typeof f.title !== 'string') p.push('title missing');
    if (!SEVERITIES.includes(f.severity)) p.push(`severity "${f.severity}" is not one of ${SEVERITIES.join('/')}`);
    if (!STATUSES.includes(f.status)) p.push(`status "${f.status}" is not valid`);
    if (!AGENTS.includes(f.source_agent)) p.push(`source_agent "${f.source_agent}" is not valid`);
    if (!TYPES.includes(f.finding_type)) p.push(`finding_type "${f.finding_type}" is not valid`);
    if (!CONFIDENCE.includes(f.confidence)) p.push(`confidence "${f.confidence}" is not valid`);
    for (const k of ['evidence', 'reproduction_steps', 'validation_steps', 'related_finding_ids', 'allowed_fix_paths']) if (!Array.isArray(f[k])) p.push(`${k} must be a list`);
    for (const k of ['line_start', 'line_end']) if (f[k] !== null && !Number.isInteger(f[k])) p.push(`${k} must be a whole number or null`);
    return p;
}

// Legacy Plugin Guard severity (P0..P3) -> v1. A pattern match is never CRITICAL by itself: impact has to be demonstrated.
function severityFromLegacy(f) {
    if (f.rule === 'hook-order-note') return 'INFO';
    const certain = f.confidence === 'certain';
    if (f.severity === 'P0') return certain ? 'CRITICAL' : 'HIGH';
    if (f.severity === 'P1') return certain ? 'HIGH' : 'MEDIUM';
    if (f.severity === 'P2') return 'MEDIUM';
    return 'LOW';
}

// One source of truth for every count shown in Markdown and HTML.
function summarize(findings, checks = []) {
    const n = pred => findings.filter(pred).length;
    const by = (key, values) => Object.fromEntries(values.map(v => [v, n(f => f[key] === v)]));
    const actionable = f => f.fix_eligible === true;
    const security = f => ['security', 'conflict'].includes(f.finding_type) && !['REJECTED_FALSE_POSITIVE', 'FIXED_VERIFIED'].includes(f.status);
    return {
        total: findings.length,
        by_severity: by('severity', SEVERITIES),
        by_status: by('status', STATUSES),
        confirmed_or_reproducible: n(f => f.status === 'CONFIRMED' || f.status === 'REPRODUCIBLE'),
        needs_review: n(f => f.status === 'PROBABLE_NEEDS_REVIEW' || f.status === 'UNVERIFIED'),
        blocked_or_authorization: n(f => f.status === 'BLOCKED' || f.status === 'NEEDS_AUTHORIZATION'),
        rejected_false_positives: n(f => f.status === 'REJECTED_FALSE_POSITIVE'),
        fixed_verified: n(f => f.status === 'FIXED_VERIFIED'),
        actionable: n(actionable),
        unresolved_security: n(security),
        checks: Object.fromEntries(['PASSED', 'FAILED', 'BLOCKED', 'SKIPPED', 'NOT_RUN', 'NEEDS_AUTHORIZATION'].map(s => [s, checks.filter(c => c.status === s).length]))
    };
}

module.exports = { SCHEMA_VERSION, SEVERITIES, STATUSES, AGENTS, TYPES, CONFIDENCE, FIELDS, stableId, makeFinding, validate, severityFromLegacy, summarize };
