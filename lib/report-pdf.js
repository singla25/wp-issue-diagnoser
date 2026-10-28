// The PDF report (and an HTML copy), in the same style as the frontend module's QA-REPORT.pdf.
// All site-derived text is HTML-escaped. Rendering is offline (every network request from the page is aborted).

const fs = require('fs');
const path = require('path');

const SEV = { P0: 'Critical', P1: 'High', P2: 'Medium', P3: 'Low' };
const OWNER = { code: 'Code change', admin: 'WordPress admin / decision', hosting: 'Hosting / server' };
const SHORT = { code: 'Code', admin: 'Admin', hosting: 'Hosting' };
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const nl = v => esc(v).replace(/\r?\n/g, '<br>');
const fmt = iso => { try { return new Date(iso).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' }) + ' UTC'; } catch { return iso || ''; } };
const open = f => f.decision !== 'ignore' && f.decision !== 'accept';

function verdict(result, openFindings) {
    const notRun = result.checks.filter(c => c.status !== 'done').length;
    const has = s => openFindings.some(f => f.severity === s);
    if (has('P0')) return { text: 'Not safe: critical problems found', cls: 'bad' };
    if (has('P1')) return { text: 'Needs fixes: serious problems found', cls: 'bad' };
    const incomplete = result.mode === 'url' ? ' (URL-only scan: code, files and database were not checked)' : notRun ? ` (${notRun} check(s) could not run)` : '';
    if (has('P2')) return { text: `Fixable weaknesses found${incomplete}`, cls: 'warn' };
    if (result.mode === 'url' || notRun) return { text: `No serious problems found in what could be checked${incomplete}`, cls: 'warn' };
    return { text: 'No serious problems found', cls: 'good' };
}

function html(result, { retest = false } = {}) {
    const all = result.findings;
    const openF = all.filter(open);
    const closed = all.filter(f => !open(f));
    const v = verdict(result, openF);
    const count = s => openF.filter(f => f.severity === s).length;
    const kicker = retest ? 'Plugin Guard retest' : 'Plugin & site security report';
    const P = [];
    const siteName = result.target.url ? result.target.url.replace(/^https?:\/\//, '').replace(/\/$/, '') : result.name;

    P.push(`<section class="cover">
      <div class="kicker">${esc(kicker)}</div><h1>${esc(siteName)}</h1>
      <div class="meta">Project ${esc(result.name)} · ${esc(fmt(result.at))} · mode: ${esc(result.mode)}${result.wpVersion ? ` · WordPress ${esc(result.wpVersion.version)}` : ''}${result.phpVersion ? ` · PHP ${esc(result.phpVersion.version)}` : ''}</div>
      <div class="verdict ${v.cls}">${esc(v.text)}</div>
      <div class="tiles">${['P0', 'P1', 'P2', 'P3'].map(s => `<div class="tile t-${SEV[s]}"><b>${count(s)}</b><span>${SEV[s]}</span></div>`).join('')}
        <div class="tile"><b>${all.filter(f => f.decision === 'fix').length}</b><span>Marked fix</span></div>
        <div class="tile"><b>${all.filter(f => f.decision === 'pending').length}</b><span>Undecided</span></div>
        <div class="tile"><b>${closed.length}</b><span>Accepted / ignored</span></div></div>`);
    if (result.diff && result.diff.baseline) {
        P.push(`<p class="small"><b>Since ${esc(fmt(result.diff.baseline))}:</b> ${result.diff.newCount} new · ${result.diff.fixed.length} fixed · ${result.diff.updates.length} component(s) changed version or were added.</p>`);
    }
    if (retest) {
        const d = result.diff;
        P.push(`<h2 class="sect">Retest result</h2>`);
        if (!d || !d.baseline) P.push('<p class="small">There is no earlier full scan to compare with. Run a normal scan first.</p>');
        else {
            P.push(`<table class="list"><tr><th>Result</th><th>Count</th></tr><tr><td class="zero">Fixed</td><td>${d.fixed.length}</td></tr><tr><td class="n">Still open</td><td>${all.filter(f => f.status === 'open').length}</td></tr><tr><td>New since the scan</td><td>${all.filter(f => f.status === 'new').length}</td></tr></table>`);
            if (d.fixed.length) P.push(`<h2>Fixed</h2><table class="list"><tr><th>ID</th><th>Severity</th><th>Problem</th></tr>${d.fixed.map(f => `<tr><td>PG-${esc(f.id)}</td><td class="t-${SEV[f.severity]}">${SEV[f.severity]}</td><td>${esc(f.title)}</td></tr>`).join('')}</table>`);
        }
    }
    P.push(`<h2>What was checked</h2><table class="list"><tr><th>Check</th><th>Status</th><th>Detail</th></tr>${result.checks.map(c => `<tr><td style="white-space:normal">${esc(c.label)}</td><td class="nw ${c.status === 'done' ? 'zero' : 'n'}">${c.status === 'done' ? 'Done' : 'Not run'}</td><td>${esc(c.reason)}</td></tr>`).join('')}</table>`);
    if (!retest || openF.length) {
        P.push(`<h2>Problems</h2><table class="list"><tr><th>ID</th><th>Severity</th><th>Problem</th><th>Who fixes</th><th>Status</th><th>Decision</th></tr>
        ${openF.map(f => `<tr><td>PG-${esc(f.id)}</td><td class="nw t-${SEV[f.severity]}">${SEV[f.severity]}</td><td>${esc(f.title)}</td><td class="nw">${esc(SHORT[f.owner])}</td><td class="nw">${esc(f.status === 'open' ? 'still open' : f.status)}</td><td class="nw">${esc(f.decision)}</td></tr>`).join('') || '<tr><td colspan="6">No open problems.</td></tr>'}</table>
        </section>`);
    } else P.push('</section>');

    for (const f of openF) {
        P.push(`<article class="issue c-${SEV[f.severity]}">
          <div class="ihead"><span class="pill">PG-${esc(f.id)}</span><span class="pill t-${SEV[f.severity]}">${SEV[f.severity]}</span><span class="pill">${esc(f.category)}</span><span class="pill">${esc(OWNER[f.owner])}</span><span class="pill">${esc(f.confidence)}</span>${f.status === 'new' ? '<span class="pill">new</span>' : ''}</div>
          <h2>${esc(f.title)}</h2>
          <table class="fields">
            ${f.plugins.length ? `<tr><th>Component</th><td>${esc(f.plugins.join(', '))}</td></tr>` : ''}
            <tr><th>What is wrong</th><td>${nl(f.detail)}</td></tr>
            ${f.cause ? `<tr><th>Cause</th><td>${esc(f.cause)}</td></tr>` : ''}
            <tr><th>Recommended fix</th><td>${nl(f.fix)}</td></tr>
            ${f.commands.length ? `<tr><th>Commands</th><td><span class="muted">staging first</span><br>${f.commands.slice(0, 6).map(c => `<code>${esc(c)}</code>`).join('<br>')}</td></tr>` : ''}
            ${f.done ? `<tr><th>Done when</th><td>${nl(f.done)}</td></tr>` : ''}
          </table>
          ${f.evidence.length ? `<div class="where"><b>Exact location${f.evidence.length > 1 ? 's' : ''}</b><ol>${f.evidence.slice(0, 6).map(e => `<li><code>${esc(e)}</code></li>`).join('')}</ol>${f.evidence.length > 6 ? `<div class="muted">+${f.evidence.length - 6} more in the fix file</div>` : ''}</div>` : ''}
        </article>`);
    }

    if (closed.length) {
        P.push(`<section class="break-avoid"><h2>Accepted and ignored</h2><p class="small">Decided by the admin in decisions.txt. They are not counted above.</p><table class="list"><tr><th>ID</th><th>Severity</th><th>Problem</th><th>Decision</th><th>Reason</th><th>Date</th></tr>${closed.map(f => `<tr><td>PG-${esc(f.id)}</td><td>${SEV[f.severity]}</td><td>${esc(f.title)}</td><td>${esc(f.decision)}</td><td>${esc(f.decisionReason)}</td><td>${esc(f.decidedOn)}</td></tr>`).join('')}</table></section>`);
    }
    if (!retest) {
        P.push(`<section class="break-avoid"><h2>Installed components</h2><table class="list"><tr><th>Component</th><th>Type</th><th>Version</th><th>Active</th><th>Job</th></tr>${result.components.map(c => `<tr><td>${esc(c.name && c.name !== c.slug ? `${c.name} (${c.ref})` : c.ref)}</td><td>${esc(c.kind)}</td><td>${esc(c.version || '—')}</td><td>${c.active ? 'yes' : 'no'}</td><td>${esc(c.category || '')}</td></tr>`).join('') || '<tr><td colspan="5">None read.</td></tr>'}</table></section>`);
        const edges = result.graph.edges.filter(e => e.kind !== 'optional');
        if (edges.length) P.push(`<section class="break-avoid"><h2>Dependencies between components</h2><table class="list"><tr><th>Component</th><th>Relation</th><th>Other component</th></tr>${edges.map(e => `<tr><td>${esc(e.from)}</td><td>${esc(e.kind === 'declared' ? 'requires' : e.kind === 'implied' ? 'uses code of' : `removes ${e.via || 'a hook'} of`)}</td><td>${esc(e.to)}</td></tr>`).join('')}</table></section>`);
    }

    const o = result.outside;
    P.push(`<section class="break-avoid"><h2>Limits and what left this computer</h2>
      <p class="small">Outside lookups: ${o.total ? `${o.total} request(s) (${Object.entries(o.byHost).map(([h, n]) => `${esc(h)} ×${n}`).join(', ')}), only plugin/theme names and versions or the WordPress version` : 'none'}.${o.stopped ? ` ${esc(o.stopped)}.` : ''} WP-CLI: ${result.wpCliCommands.length} read-only command(s) run on the local copy.${result.live ? ` Live site: ${result.live.requests} GET request(s).` : ''}</p>
      ${result.copyModified ? `<p class="small">Local copy: newest plugin/theme file changed ${esc(result.copyModified)}${result.dbExportedAt ? `; database export dated ${esc(result.dbExportedAt)}` : '; database export date not recorded (set dbExportedAt in project.json)'}. The database checks describe that copy, not the live database.</p>` : ''}
      ${result.notes.map(n => `<p class="small">${esc(n)}</p>`).join('')}
      <p class="small">Code checks are pattern matching, not a proof of an exploit. <b>certain</b> comes from headers, official checksums or live answers; <b>likely</b> and <b>possible</b> need a human look. Read-only: nothing on the site was changed, no form was submitted, no login was attempted.</p></section>`);

    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc(kicker)}</title><style>
      @page { size: A4; margin: 15mm 14mm 17mm; }
      * { box-sizing: border-box; } body { font: 10pt/1.45 "Segoe UI", Roboto, Arial, sans-serif; color: #1d2330; margin: 0; }
      h1 { font-size: 22pt; margin: 4px 0; } h2 { font-size: 12pt; margin: 3px 0 5px; }
      .kicker { text-transform: uppercase; letter-spacing: .08em; color: #5d6676; font-size: 8.5pt; } .meta, .muted { color: #5d6676; } .small { font-size: 8.5pt; color: #5d6676; }
      .verdict { margin: 12px 0; padding: 10px 14px; border-radius: 8px; font-size: 13pt; font-weight: 700; }
      .verdict.good { background: #e6f4ea; color: #1e6b3a; } .verdict.warn { background: #fdf3dc; color: #8a5a00; } .verdict.bad { background: #fde8e8; color: #a12020; }
      .tiles { display: flex; gap: 8px; margin: 8px 0 12px; flex-wrap: wrap; } .tile { border: 1px solid #d5d9e0; border-radius: 8px; padding: 6px 12px; min-width: 70px; } .tile b { display: block; font-size: 16pt; } .tile span { font-size: 8pt; color: #5d6676; }
      .t-Critical, .t-Critical b { color: #a12020; font-weight: 700; } .t-High, .t-High b { color: #c2410c; font-weight: 700; } .t-Medium, .t-Medium b { color: #8a5a00; font-weight: 700; } .t-Low, .t-Low b { color: #1d4f91; font-weight: 700; }
      table.list { border-collapse: collapse; width: 100%; font-size: 8.5pt; margin: 6px 0 10px; } .list th, .list td { border-bottom: 1px solid #e2e5ea; padding: 3px 6px; text-align: left; vertical-align: top; overflow-wrap: break-word; word-break: normal; } .list .nw { white-space: nowrap; } .list th { background: #f1f3f6; } .list td:first-child { white-space: nowrap; } .list td:first-child[style] { white-space: normal; }
      .list td.zero { color: #1e6b3a; font-weight: 700; } .list td.n { color: #a12020; font-weight: 700; } tr { break-inside: avoid; }
      .issue { border: 1px solid #d5d9e0; border-left: 5px solid #1d4f91; border-radius: 6px; padding: 6px 10px; margin: 0 0 8px; break-inside: avoid; }
      .issue.c-Critical { border-left-color: #a12020; } .issue.c-High { border-left-color: #c2410c; } .issue.c-Medium { border-left-color: #b7791f; }
      .pill { display: inline-block; font-size: 7.5pt; font-weight: 700; padding: 1px 7px; border-radius: 99px; background: #eef1f5; margin-right: 4px; color: #1d2330; }
      table.fields { border-collapse: collapse; width: 100%; font-size: 8.5pt; line-height: 1.35; } .fields th { width: 30mm; text-align: left; color: #5d6676; font-weight: 600; padding: 2px 6px 2px 0; vertical-align: top; } .fields td { padding: 2px 0; overflow-wrap: anywhere; }
      .where { font-size: 8pt; line-height: 1.3; margin-top: 4px; overflow-wrap: anywhere; } .where ol { margin: 3px 0 0 16px; padding: 0; } code { font-size: 7.5pt; background: #f1f3f6; padding: 0 3px; border-radius: 3px; }
      .cover { margin-bottom: 8px; } h2.sect { margin-top: 14px; break-after: avoid; } .break-avoid { break-inside: avoid; margin-top: 12px; }
    </style></head><body>${P.join('\n')}</body></html>`;
}

function loadPlaywright() {
    try { return require(require.resolve('@playwright/test', { paths: [path.join(__dirname, '..', '..', 'frontend')] })); }
    catch { throw new Error('The PDF needs Playwright, which is not installed. Run once: npm run setup:frontend'); }
}

async function renderPdf(doc, target, footer) {
    const { chromium } = loadPlaywright();
    const browser = await chromium.launch();
    try {
        const context = await browser.newContext();
        await context.route(/^(https?|wss?):/, route => route.abort());
        const page = await context.newPage();
        await page.setContent(doc, { waitUntil: 'load' });
        await page.pdf({
            path: target, format: 'A4', printBackground: true, displayHeaderFooter: true, headerTemplate: '<div></div>',
            footerTemplate: `<div style="font-size:7px;color:#5d6676;width:100%;padding:0 14mm;display:flex;justify-content:space-between"><span>${esc(footer)}</span><span><span class="pageNumber"></span> / <span class="totalPages"></span></span></div>`,
            margin: { top: '15mm', bottom: '17mm', left: '14mm', right: '14mm' }
        });
    } finally { await browser.close(); }
}

async function build(result, outDir, { retest = false, pdf = true } = {}) {
    fs.mkdirSync(outDir, { recursive: true });
    const stem = retest ? 'RETEST-REPORT' : 'PLUGIN-GUARD-REPORT';
    const doc = html(result, { retest });
    const htmlFile = path.join(outDir, `${stem}.html`);
    fs.writeFileSync(htmlFile, doc);
    const out = { html: htmlFile, pdf: null, pdfError: null };
    if (pdf) {
        try { out.pdf = path.join(outDir, `${stem}.pdf`); await renderPdf(doc, out.pdf, `${retest ? 'Plugin Guard retest' : 'Plugin Guard report'} · ${result.name}`); }
        catch (e) { out.pdf = null; out.pdfError = e.message; }
    }
    return out;
}

module.exports = { build, html, esc, verdict };
