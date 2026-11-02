#!/usr/bin/env node
// Plugin Guard: read-only WordPress plugin / theme / site security checks.
//
//   guard.js init <project> --url https://site/ [--path <local WordPress folder>] [--schedule none|daily|weekly|monthly]
//                           [--allow-wordpress-org] [--allow-vuln-db] [--force]
//   guard.js set <project> [--url ...] [--path ...] [--php-version 8.1.27] [--db-exported 2026-10-20]
//                          [--allow-wordpress-org | --deny-wordpress-org] [--allow-vuln-db | --deny-vuln-db]
//   guard.js scan <project> [--url ...] [--path ...] [--no-pdf] [--fail-on P0|P1|P2|P3] [--wp-bin <wp>]
//   guard.js decisions <project>      re-read decisions.txt and show where each finding stands
//   guard.js bulk <project> --rule <rule>[,<rule>] --as ignore|accept|fix [--reason "why"] [--overwrite]
//                                     decide every finding of a rule at once (only "pending" ones unless --overwrite)
//   guard.js bulk <project>           list the rules in the last scan with their counts
//   guard.js fixfile <project>        build FIXES-FOR-CLAUDE.md from the findings marked "fix"
//   guard.js retest <project>         scan again and show each earlier problem as Fixed / Still open
//   guard.js schedule <project> <none|daily|weekly|monthly>
//   guard.js due                      projects whose approved schedule says a scan is due
//   guard.js run-due                  scan every due project
//   guard.js list
//
// Three-agent QA workflow (reports in reports/runs/<run-id>/; see src/plugin-guard/README.md):
//   guard.js scan --root .                      local-first: Agent 2 on this WordPress root, then Agent 3 (Agent 1 = browser tests: src/combined)
//   (qa-url and auto drive the Frontend QA agent and now live in src/combined: node src/combined/scripts/combined.js qa-url|auto ...)
//   guard.js qa-code --root <wp-root> [--config file] [--run <id>]
//   guard.js qa-validate [--run <id>|latest] [--fail-on CRITICAL|HIGH|MEDIUM|LOW] [--allow-stale]
//   guard.js issue new|investigate|show|list|retest|open [id]   investigate ONE reported problem (issue mode; needs: npm run setup:guard)
//   guard.js doctor [--root .]   guard.js config --root .   guard.js show [--run <id>]
//   qa exit codes: 0 done · 1 findings at/above --fail-on · 2 bad usage/config · 3 blocked (authorization, site protection, nothing could run)
//
// Exit codes: 0 ok · 1 findings at/above --fail-on · 2 bad usage or settings · 3 the site could not be read
// (blocked, unreachable, not WordPress) and a local copy is needed.

const fs = require('fs');
const path = require('path');
const projectLib = require('../lib/project');
const history = require('../lib/history');
const decisions = require('../lib/decisions');
const fixfile = require('../lib/fixfile');
const reportPdf = require('../lib/report-pdf');
const { scan, isOpen } = require('../guard');
const workflow = require('../lib/workflow');
const cfgLib = require('../lib/config');

const FLAGS = {
    url: 'v', path: 'v', schedule: 'v', 'fail-on': 'v', 'wp-bin': 'v', delay: 'v', rule: 'v', as: 'v', reason: 'v', overwrite: 'b',
    root: 'v', config: 'v', env: 'v', mode: 'v', run: 'v', 'timeout-min': 'v', authorized: 'b', 'allow-stale': 'b', 'run-project-tests': 'b',
    title: 'v', description: 'v', pages: 'v', symptom: 'v', oracle: 'v', images: 'v', since: 'v', php: 'v', 'changed-before': 'v', login: 'b', 'no-prompt': 'b', investigate: 'b', 'no-probe': 'b', 'no-layout': 'b', 'probe-pages': 'v', viewports: 'v',
    sandbox: 'b', 'db-dump': 'v', 'export-db': 'b', 'keep-real-data': 'b', 'neutralise-payments': 'b', 'with-uploads': 'b', 'max-size-mb': 'v', 'keep-sandbox': 'b', 'max-loads': 'v', 'max-minutes': 'v', 'no-bisect': 'b', hypothesis: 'v', 'no-sandbox': 'b', 'max-issues': 'v', 'sandbox-max-issues': 'v', 'older-than-days': 'v', yes: 'b', 'no-issues': 'b', 'no-sandboxes': 'b',
    force: 'b', 'no-pdf': 'b', 'allow-wordpress-org': 'b', 'allow-vuln-db': 'b', 'deny-wordpress-org': 'b', 'deny-vuln-db': 'b', 'php-version': 'v', 'db-exported': 'v'
};

function parse(argv) {
    const o = { _: [] };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (!a.startsWith('--')) { o._.push(a); continue; }
        const m = /^--([\w-]+)(?:=(.*))?$/.exec(a);
        if (!m || !FLAGS[m[1]]) throw new Error(`Unknown option "${a}"`);
        if (FLAGS[m[1]] === 'b') { o[m[1]] = true; continue; }
        const v = m[2] !== undefined ? m[2] : argv[++i];
        if (v === undefined) throw new Error(`--${m[1]} needs a value`);
        o[m[1]] = v;
    }
    return o;
}

const SEV = { P0: 'Critical', P1: 'High', P2: 'Medium', P3: 'Low' };
const outDirOf = name => projectLib.reportsDir(name);

function writeFindings(result, dir) {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'findings.json'), JSON.stringify(result, null, 2));
}

function summary(result, dir, built, retest) {
    const open = result.findings.filter(isOpen);
    const c = s => open.filter(f => f.severity === s).length;
    console.log(`\nPlugin Guard ${retest ? 'retest' : 'scan'} of "${result.name}" (${result.mode}): ${open.length} open finding(s)  Critical ${c('P0')} · High ${c('P1')} · Medium ${c('P2')} · Low ${c('P3')}`);
    const notRun = result.checks.filter(x => x.status !== 'done');
    if (notRun.length) console.log(`${notRun.length} check(s) did not run:\n${notRun.map(x => `  - ${x.label}: ${x.reason}`).join('\n')}`);
    for (const n of result.notes) console.log(`Note: ${n}`);
    if (result.diff && result.diff.baseline) {
        const still = result.findings.filter(f => f.status === 'open').length;
        console.log(retest
            ? `Retest vs scan of ${result.diff.baseline.slice(0, 16).replace('T', ' ')}: ${result.diff.fixed.length} fixed · ${still} still open · ${result.diff.newCount} new`
            : `Since ${result.diff.baseline.slice(0, 16).replace('T', ' ')}: ${result.diff.newCount} new · ${result.diff.fixed.length} fixed`);
    }
    console.log(`Report:    ${built.pdf || built.html}${built.pdf ? '' : '  (HTML only)'}`);
    if (built.pdfError) console.log(`PDF not built: ${built.pdfError}`);
    if (!retest) {
        const pending = result.findings.filter(f => f.decision === 'pending').length;
        console.log(`Decisions: ${decisions.file(result.name)}  (${pending} undecided)`);
        console.log('Next:      set "decision:" to fix / ignore / accept for each finding, then run:');
        console.log(`           node scripts/guard.js fixfile ${result.name}`);
    }
    for (const p of result.decisionProblems || []) console.log(`decisions.txt: ${p}`);
}

async function runScan(name, o, type) {
    const result = await scan(name, { url: o.url, path: o.path && cfgLib.userPath(o.path), wpBin: o['wp-bin'], type, delayMs: o.delay === undefined ? undefined : Number(o.delay) });
    const dir = outDirOf(name);
    writeFindings(result, dir);
    const built = await reportPdf.build(result, dir, { retest: type === 'retest', pdf: !o['no-pdf'] });
    summary(result, dir, built, type === 'retest');
    return result;
}

async function main() {
    const o = parse(process.argv.slice(2));
    const [cmd, name, arg] = o._;
    if (!cmd) { console.error(fs.readFileSync(__filename, 'utf8').split('\n').slice(1, 35).map(l => l.replace(/^\/\/ ?/, '')).join('\n')); return 2; }

    if (cmd === 'init') {
        const p = projectLib.create(name, { url: o.url, path: o.path && cfgLib.userPath(o.path), schedule: o.schedule, allowWordpressOrg: o['allow-wordpress-org'], allowVulnDb: o['allow-vuln-db'] }, { force: o.force });
        console.log(`Project "${name}" created: ${projectLib.fileOf(name)}\n  address: ${p.url || '—'}\n  local copy: ${p.path || '— (URL-only scans see only what a visitor sees)'}\n  schedule: ${p.schedule}\n  outside lookups: wordpress.org ${p.outsideLookups.wordpressOrg ? 'allowed' : 'NOT allowed'}, vulnerability database ${p.outsideLookups.vulnerabilityDb ? 'allowed' : 'NOT allowed'}`);
        console.log(`Next: node scripts/guard.js scan ${name}`);
        return 0;
    }
    const loadAll = () => projectLib.list().flatMap(n => { try { return [projectLib.load(n)]; } catch (e) { console.error(`${n}: skipped, settings are invalid (${(e.message.split('\n')[1] || e.message).trim()})`); return []; } });
    if (cmd === 'list') { for (const p of loadAll()) console.log(`${p.name}\t${p.schedule}\t${p.url || p.path}`); return 0; }
    if (cmd === 'due' || cmd === 'run-due') {
        const due = loadAll().filter(p => projectLib.isDue(p, (history.last(p.name, 'scan') || {}).at));
        if (!due.length) { console.log('No project is due. (Only projects with an approved schedule are ever due.)'); return 0; }
        let code = 0;
        for (const p of due) {
            console.log(`${p.name}: ${p.schedule} scan is due`);
            if (cmd === 'run-due') { try { await runScan(p.name, {}, 'scan'); } catch (e) { console.error(`  ${p.name} failed: ${e.message}`); code = Math.max(code, e.exitCode || 2); } }
        }
        return code;
    }
    if (cmd === 'issue') return require('../lib/issue-cli').run(o);
    if (cmd === 'auto' || cmd === 'qa-url') {
        console.error(`"${cmd}" drives the Frontend QA agent, so it lives in src/combined now:\n  node src/combined/scripts/combined.js ${process.argv.slice(2).join(' ')}${cmd === 'auto' ? '\n  (or: npm run guard:auto -- ...)' : ''}`);
        return 2;
    }
    const QA = { 'qa-code': workflow.qaCode, 'qa-validate': workflow.qaValidate, doctor: workflow.doctor, config: workflow.showConfig, show: workflow.showRun };
    if (QA[cmd]) return QA[cmd](o);
    if (cmd === 'scan' && !name && (o.root || o.config)) return workflow.scanLocal(o);
    if (!name) throw new Error(`"${cmd}" needs a project name`);

    if (cmd === 'set') {
        const p = projectLib.load(name);
        if (o.url) p.url = o.url;
        if (o.path) p.path = cfgLib.userPath(o.path);
        if (o['php-version']) p.phpVersion = o['php-version'];
        if (o['db-exported']) p.dbExportedAt = o['db-exported'];
        if (o['allow-wordpress-org']) p.outsideLookups.wordpressOrg = true;
        if (o['deny-wordpress-org']) p.outsideLookups.wordpressOrg = false;
        if (o['allow-vuln-db']) p.outsideLookups.vulnerabilityDb = true;
        if (o['deny-vuln-db']) p.outsideLookups.vulnerabilityDb = false;
        const errors = projectLib.validate(p);
        if (errors.length) throw new Error(errors.join('; '));
        projectLib.save(p);
        console.log(`Project "${name}" updated. address: ${p.url || '—'} · local copy: ${p.path || '—'} · wordpress.org lookups ${p.outsideLookups.wordpressOrg ? 'allowed' : 'NOT allowed'} · vulnerability database ${p.outsideLookups.vulnerabilityDb ? 'allowed' : 'NOT allowed'}`);
        return 0;
    }
    if (cmd === 'schedule') {
        const p = projectLib.setSchedule(name, arg);
        console.log(`Project "${name}" schedule set to ${p.schedule}${p.schedule === 'none' ? ' (it will never be flagged as due)' : ' (run "guard.js due" to see when it is due; nothing runs by itself)'}.`);
        return 0;
    }
    if (cmd === 'scan' || cmd === 'retest') {
        const result = await runScan(name, o, cmd);
        const limit = ['P0', 'P1', 'P2', 'P3'].indexOf(o['fail-on'] || '');
        return limit >= 0 && result.findings.some(f => isOpen(f) && ['P0', 'P1', 'P2', 'P3'].indexOf(f.severity) <= limit) ? 1 : 0;
    }
    if (cmd === 'bulk') {
        const file = path.join(outDirOf(name), 'findings.json');
        if (!fs.existsSync(file)) throw new Error(`No scan found for "${name}". Run: node scripts/guard.js scan ${name}`);
        const result = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (!o.rule) {
            decisions.apply(name, result.findings);
            const rows = new Map();
            for (const f of result.findings) { const r = rows.get(f.rule) || { n: 0, pending: 0, sev: f.severity }; r.n++; if (f.decision === 'pending') r.pending++; rows.set(f.rule, r); }
            console.log('rule'.padEnd(34) + 'severity  total  pending');
            for (const [rule, r] of [...rows].sort((a, b) => b[1].n - a[1].n)) console.log(`${rule.padEnd(34)}${r.sev.padEnd(10)}${String(r.n).padEnd(7)}${r.pending}`);
            console.log(`\nDecide a whole rule:  node scripts/guard.js bulk ${name} --rule <rule> --as ignore --reason "why"`);
            return 0;
        }
        const { changed, kept } = decisions.bulk(name, result.findings, { rules: o.rule.split(',').map(x => x.trim()).filter(Boolean), as: o.as, reason: o.reason, overwrite: o.overwrite });
        console.log(`${changed} finding(s) set to "${o.as}"${kept ? `; ${kept} already decided were left alone (use --overwrite to change them)` : ''}.\nRun "guard.js decisions ${name}" to see the totals.`);
        return 0;
    }
    if (cmd === 'decisions' || cmd === 'fixfile') {
        const file = path.join(outDirOf(name), 'findings.json');
        if (!fs.existsSync(file)) throw new Error(`No scan found for "${name}". Run: node scripts/guard.js scan ${name}`);
        const result = JSON.parse(fs.readFileSync(file, 'utf8'));
        const problems = decisions.apply(name, result.findings);
        const by = d => result.findings.filter(f => f.decision === d).length;
        console.log(`decisions.txt: ${decisions.file(name)}\n  fix ${by('fix')} · ignore ${by('ignore')} · accept ${by('accept')} · pending ${by('pending')}`);
        if (problems.length) { console.error(`\nFix these in decisions.txt first:\n  - ${problems.join('\n  - ')}`); return 2; }
        if (cmd === 'decisions') return 0;
        const md = fixfile.build(result);
        const target = path.join(outDirOf(name), 'FIXES-FOR-CLAUDE.md');
        fs.writeFileSync(target, md);
        fs.writeFileSync(file, JSON.stringify(result, null, 2));
        console.log(`\nFix file for Claude: ${target} (${by('fix')} item(s))\nGive it to a Claude agent working on the local copy. Afterwards run: node scripts/guard.js retest ${name}`);
        const pend = by('pending');
        if (pend) console.log(`Note: ${pend} finding(s) are still "pending" and are not in the file.`);
        return 0;
    }
    throw new Error(`Unknown command "${cmd}"`);
}

module.exports = { parse, FLAGS };   // src/combined reuses the same option parser

if (require.main === module) main().then(code => process.exit(code || 0)).catch(e => {
    console.error(`\nPlugin Guard: ${e.message}`);
    process.exit(e.exitCode || 2);
});
