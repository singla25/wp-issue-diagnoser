// Markdown reports. Everything is built from the same objects the JSON and HTML use; nothing is re-decided here.

const code = t => '`' + String(t ?? '').replace(/`/g, "'").replace(/\r?\n/g, ' ') + '`';
const one = t => String(t ?? '').replace(/\r?\n/g, ' ').trim();
const SEV_ICON = { CRITICAL: '🟥', HIGH: '🟧', MEDIUM: '🟨', LOW: '🟦', INFO: '⬜' };

function checksTable(checks) {
    if (!checks.length) return ['_No checks recorded._', ''];
    const L = ['| Status | Check | Detail |', '|---|---|---|'];
    for (const c of checks) L.push(`| **${c.status}** | ${one(c.label).replace(/\|/g, '\\|')} | ${one(c.reason).replace(/\|/g, '\\|').slice(0, 300)} |`);
    return [...L, ''];
}

function findingBlock(f) {
    const L = [`### ${SEV_ICON[f.severity] || ''} ${f.id}: ${one(f.title)}`, ''];
    L.push(`- **Severity:** ${f.severity} · **Status:** ${f.status} · **Confidence:** ${f.confidence} · **Type:** ${f.finding_type} · **Category:** ${f.category} · **Agent:** ${f.source_agent}`);
    if (f.component) L.push(`- **Component:** ${code(f.component)}`);
    if (f.file_path) L.push(`- **Location:** ${code(f.file_path + (f.line_start ? ':' + f.line_start : ''))}${f.ownership ? ` (${f.ownership.owner})` : ''}`);
    if (f.url) L.push(`- **Page:** ${code(f.url)}`);
    if (f.description) L.push(`- **What:** ${one(f.description)}`);
    if (f.expected_behavior) L.push(`- **Expected:** ${one(f.expected_behavior)}`);
    if (f.actual_behavior && f.actual_behavior !== f.description) L.push(`- **Actual:** ${one(f.actual_behavior)}`);
    if (f.impact) L.push(`- **Impact:** ${one(f.impact)}`);
    if (f.root_cause) L.push(`- **Root cause:** ${one(f.root_cause)}`);
    if (f.evidence.length) { L.push('- **Evidence:**'); for (const e of f.evidence.slice(0, 10)) L.push(`    - ${code(e)}`); if (f.evidence.length > 10) L.push(`    - …and ${f.evidence.length - 10} more (findings.json)`); }
    if (f.reproduction_steps.length) L.push(`- **Reproduce:** ${f.reproduction_steps.map(one).join(' → ')}`);
    if (f.recommended_fix) L.push(`- **Suggested fix:** ${one(f.recommended_fix)}`);
    if (f.validation_steps.length) L.push(`- **Verify with:** ${f.validation_steps.map(one).join('; ')}`);
    if (f.blocked_reason) L.push(`- **Not a fix task because:** ${one(f.blocked_reason)}`);
    if (f.related_finding_ids.length) L.push(`- **Related:** ${f.related_finding_ids.join(', ')}`);
    for (const n of f.validation_notes || []) L.push(`- _Validation:_ ${one(n)}`);
    return [...L, ''];
}

// 01 / 02: one agent's own output, before validation.
function agentReport(a, title, extra = []) {
    const L = [`# ${title}`, '', `Run \`${a.run_id}\` · finished ${a.finished_at}`, ''];
    L.push(...extra);
    L.push('## Checks', '', ...checksTable(a.checks));
    L.push(`## Findings reported by this agent (${a.findings.length})`, '', '_These are the agent\'s own claims. Their final status is decided by Agent 3 in `03-final-validation-report.md`._', '');
    for (const f of a.findings.slice(0, 200)) L.push(`- **${f.severity}** ${f.id} ${one(f.title)}${f.file_path ? ` (${code(f.file_path)})` : ''}${f.url ? ` (${code(f.url)})` : ''}`);
    if (a.findings.length > 200) L.push(`- …and ${a.findings.length - 200} more (see agent JSON)`);
    return L.join('\n') + '\n';
}

function userReport(a) {
    const extra = [`**Target:** ${code(a.url)} · **Environment:** ${a.environment || 'not stated'} · **Mode:** ${a.mode}`, ''];
    if (!a.tests_ran) extra.push('> ⚠ **No browser tests ran.** See the check list below for the reason. Nothing here says the website is healthy or broken.', '');
    if (a.summary) extra.push(`Pages tested: ${a.summary.pagesTested} · viewports: ${(a.summary.viewportsTested || []).join(', ')} · completion: ${one(a.summary.completion)}`, '');
    if (a.traces) extra.push(`Playwright traces kept (failed tests only): ${a.traces}`, '');
    extra.push('Evidence is stored in `evidence/frontend/` (screenshots and the frontend module\'s own report).', '');
    return agentReport(a, 'Agent 1: user and frontend test report', extra);
}

function codeReport(a) {
    const extra = [`**Root:** ${code(a.root)}`, '', `**Custom-code allowlist:** ${a.policy.customPaths.length ? a.policy.customPaths.map(code).join(', ') : '_none configured: no code is treated as project-owned, so no fix tasks can be generated_'}`, '',
        `**Runtime:** wp-config.php ${a.runtime.wpConfig ? 'present' : 'missing'} · WP-CLI ${a.runtime.wpCli ? 'available' : 'not available'} · WordPress database ${a.runtime.wordpressInstalled ? 'readable' : 'not readable (source checkout only)'}`, ''];
    if (a.inventory && a.inventory.wordpress) extra.push(`WordPress ${a.inventory.wordpress.version} · ${a.inventory.components.length} components · ${a.inventory.customFiles} custom PHP file(s) inspected`, '');
    extra.push('## Tools', '', '| Tool | Installed | Works offline | Purpose |', '|---|---|---|---|', ...a.tools.map(t => `| ${t.id} | ${t.installed ? 'yes' : 'no'} | ${t.offline ? 'yes' : 'no (network)'} | ${t.why} |`), '');
    for (const n of a.notes || []) extra.push(`> ${one(n)}`);
    return agentReport(a, 'Agent 2: code and security test report', extra);
}

function finalReport(d) {
    const s = d.summary;
    const L = [`# Final validation report`, '', `Run \`${d.run_id}\` · generated ${d.generated_at}`, ''];
    L.push(d.complete ? '**Scope:** complete (both stages ran).' : '> ⚠ **PARTIAL REPORT.** One or more stages did not run; what they would have checked is NOT covered:', '');
    for (const st of d.stages) L.push(`- ${st.name}: **${st.state}**`);
    L.push('', `**Target:** ${d.target.url ? code(d.target.url) : '_no URL_'} · **Source root:** ${d.target.root ? code(d.target.root) : '_none_'}`, '');
    L.push('## Summary', '', `Total findings: **${s.total}** — Critical ${s.by_severity.CRITICAL} · High ${s.by_severity.HIGH} · Medium ${s.by_severity.MEDIUM} · Low ${s.by_severity.LOW} · Info ${s.by_severity.INFO}`, '');
    L.push(`- Confirmed or reproducible: **${s.confirmed_or_reproducible}**`, `- Need review (probable / unverified): **${s.needs_review}**`, `- Blocked or need authorization (testing limits, not defects): **${s.blocked_or_authorization}**`, `- Rejected as false positives: **${s.rejected_false_positives}**`, `- Fixes verified: **${s.fixed_verified}**`, `- Actionable fix tasks (custom code only): **${s.actionable}**`, `- Unresolved security findings: **${s.unresolved_security}**`, '');
    if (d.input_problems.length) { L.push('## Input problems', ''); for (const p of d.input_problems) L.push(`- ${one(p)}`); L.push(''); }
    L.push('## Checks', '', ...checksTable(d.checks));
    const group = (title, pred) => { const list = d.findings.filter(pred); if (!list.length) return; L.push(`## ${title} (${list.length})`, ''); for (const f of list) L.push(...findingBlock(f)); };
    group('Confirmed and reproducible', f => ['CONFIRMED', 'REPRODUCIBLE'].includes(f.status));
    group('Probable: needs human review', f => f.status === 'PROBABLE_NEEDS_REVIEW');
    group('Unverified (not the same as harmless)', f => f.status === 'UNVERIFIED');
    group('Blocked or needs authorization', f => ['BLOCKED', 'NEEDS_AUTHORIZATION'].includes(f.status));
    group('Rejected as false positives', f => f.status === 'REJECTED_FALSE_POSITIVE');
    group('Fixed and verified', f => f.status === 'FIXED_VERIFIED');
    if (d.auto) {
        const A = d.auto;
        L.push('## guard:auto', '', `Mode: **${A.mode === 'sandbox' ? 'sandbox (one shared throwaway copy)' : 'static-only'}**${A.mode_reason ? ` — ${one(A.mode_reason)}` : ''}. Auto-issues: ${A.counts.issues} (${A.counts.reproduced} reproduced in the sandbox, ${A.counts.not_plugin} not a plugin conflict).`, '');
        if (A.plain) { L.push('### In plain words', '', `**${one(A.plain.headline)}**`, '', ...A.plain.lines.map(x => `- ${one(x)}`), ''); if (A.plain.next.length) L.push('**What to do next:**', '', ...A.plain.next.map((n, i) => `${i + 1}. ${one(n)}`), ''); }
        for (const i of A.issues) L.push(`- **${one(i.title)}** — ${one(i.verdict || 'not investigated')}${i.not_plugin_conflict ? ' — **NOT A PLUGIN CONFLICT**' : ''}${i.cause ? ` — cause: ${one(i.cause)}` : ''}`);
        if (A.did_not_run.length) { L.push('', '**What did not run:**', ...A.did_not_run.map(r => `- ${one(r.what)}: ${one(r.why)}`)); }
        L.push('');
    }
    L.push('## Limits of this report', '', ...d.limits.map(x => `- ${x}`), '');
    return L.join('\n');
}

module.exports = { userReport, codeReport, finalReport, findingBlock };
