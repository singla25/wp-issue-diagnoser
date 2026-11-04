#!/usr/bin/env node
// Generates data/checkpoints.json from the table in docs/COVERAGE.md (the one source). Offline, deterministic, sorted by row number.
//   node scripts/gen-checkpoints.js            write data/checkpoints.json
//   node scripts/gen-checkpoints.js --check    exit 1 if data/checkpoints.json is not what the table gives now (stale)
//   --source <file>  read another copy of the table (used by the test)   --out <file>  write/compare another file
// A checkpoint has `evaluator` (a key of issue/checkpoints.js EVALUATORS) or null; when null, `no_evaluator_reason` says why in plain words.
// The key table lives HERE, not in COVERAGE.md: the page stays a hand-written description, the mapping to checks is code.
const fs = require('fs');
const path = require('path');

const SOURCE = path.join(__dirname, '..', '..', '..', 'docs', 'COVERAGE.md');
const OUT = path.join(__dirname, '..', 'data', 'checkpoints.json');

// row number -> evaluator key. A row not listed here has no evaluator (see NO_EVALUATOR for the reason).
const KEYS = {
    1: 'duplicate-declaration', 2: 'duplicate-constant', 3: 'duplicate-shortcode', 4: 'duplicate-post-type', 5: 'duplicate-rest-route', 6: 'duplicate-ajax-action', 7: 'duplicate-script-handle',
    8: 'shared-option', 9: 'hook-same-priority', 10: 'hook-removal', 11: 'library-clash', 12: 'duplicate-purpose', 13: 'missing-dependency', 14: 'template-override',
    15: 'handle-removal', 18: 'theme-post-type', 19: 'page-builder', 20: 'redirect-on-hook', 21: 'rest-auth-hook', 22: 'content-hooks', 24: 'removed-functions', 25: 'php-version-code',
    26: 'version-headers', 27: 'syntax-error', 30: 'log-limits', 31: 'log-extensions', 33: 'home-siteurl', 35: 'dropins', 37: 'https', 38: 'white-screen', 39: 'http-5xx',
    40: 'critical-error-page', 41: 'redirect-loop', 43: 'admin-ajax', 44: 'js-errors', 45: 'failed-assets', 49: 'obfuscated-code', 50: 'php-in-uploads'
};
// row number -> why there is no evaluator (plain words, shown to the reader). Classic-only rows get the standard sentence.
const NO_EVALUATOR = {
    16: 'no check reads the theme templates for this yet',
    17: 'Plugin Guard only lists who provides a feature; no check decides that the theme repeats a plugin',
    23: 'the real load order of the plugins is not read yet',
    28: 'the site is tested on one PHP version only',
    29: 'nothing checks code that assumes a single site',
    32: 'the .htaccess file is not read yet',
    34: 'no check looks at the cron setting yet',
    42: 'needs a REST probe, which does not exist yet',
    46: 'no check for a failing login exists; the sandbox login is only a first step for other tests',
    47: 'no scripted checkout exists (writing to a shop is not allowed)',
    53: 'no check looks for redirects that depend on the visitor'
};
// breaks_site, per evaluator key: can what the check finds, ON ITS OWN, stop the site from loading?
//   'yes'      yes: a fatal error, a blank page or a server error follows from it by itself (a redeclared function, a syntax error, a removed PHP function, running out of memory, 5xx, a redirect loop)
//   'no'       no: it is a warning, a notice, a header mismatch or a duplicated setting; the site keeps loading
//   'depends'  it breaks only in some situations (which hook runs when, which file is loaded) and the report cannot say which; also every row without an evaluator
// Deterministic: a fixed table, no run data. The report uses it as a label only; it never changes a result.
const BREAKS_SITE = {
    'duplicate-declaration': 'yes', 'removed-functions': 'yes', 'php-version-code': 'yes', 'syntax-error': 'yes', 'log-limits': 'yes', 'log-extensions': 'yes',
    'white-screen': 'yes', 'http-5xx': 'yes', 'critical-error-page': 'yes', 'redirect-loop': 'yes', 'php-in-uploads': 'depends',
    'duplicate-constant': 'no', 'duplicate-shortcode': 'no', 'duplicate-post-type': 'no', 'shared-option': 'no', 'version-headers': 'no', 'template-override': 'no', 'duplicate-purpose': 'no',
    'home-siteurl': 'no', 'https': 'no', 'js-errors': 'no', 'failed-assets': 'no', 'obfuscated-code': 'no', 'dropins': 'no', 'theme-post-type': 'no'
};
const CLASSIC_ONLY = 'only the classic scan checks this';

// split a table row on pipes that are not inside backticks
function cells(line) {
    const out = []; let cur = '', tick = false;
    for (const ch of line) { if (ch === '`') tick = !tick; if (ch === '|' && !tick) { out.push(cur.trim()); cur = ''; } else cur += ch; }
    out.push(cur);
    return out.slice(1, -1).map(s => s.trim());
}
const plain = s => s.replace(/`/g, '').replace(/\*\*/g, '').replace(/\s+/g, ' ').trim();
function short(s, n = 200) {
    const t = plain(s);
    if (t.length <= n) return t;
    const cut = t.slice(0, n), sp = cut.lastIndexOf(' ');
    return cut.slice(0, sp > 120 ? sp : n).replace(/[\s,;:.(—-]+$/, '') + ' ...';
}
const REACHED = { 'Issue mode': 'Issue', 'Classic only': 'Classic', 'Both': 'Both', 'Neither': 'Neither' };

function build(source = SOURCE) {
    const lines = fs.readFileSync(source, 'utf8').split('\n');
    const start = lines.findIndex(l => /^\| # \| Item \| Status \|/.test(l));
    if (start < 0) throw new Error(`${source}: the coverage table was not found`);
    const cps = []; let section = null;
    for (let i = start + 2; i < lines.length && lines[i].startsWith('|'); i++) {
        const c = cells(lines[i]);
        if (c.length !== 6) throw new Error(`${source}: line ${i + 1} has ${c.length} cells, expected 6`);
        if (c[0] === '') { section = plain(c[1]); continue; }
        const n = Number(c[0]);
        if (!Number.isInteger(n) || String(n) !== c[0]) throw new Error(`${source}: line ${i + 1}: row number "${c[0]}"`);
        const coverage = c[2];
        if (!['DETECTED', 'PARTIAL', 'NOT DETECTED'].includes(coverage)) throw new Error(`${source}: row ${n}: status "${coverage}"`);
        const reached = REACHED[c[3]];
        if (!reached) throw new Error(`${source}: row ${n}: "Reached in" is "${c[3]}"`);
        const evaluator = coverage === 'NOT DETECTED' || reached === 'Classic' ? null : (KEYS[n] || null);
        const cp = { id: `cp-${String(n).padStart(2, '0')}`, title: plain(c[1]), section, coverage, reached_in: reached, where: short(c[4]), missing: plain(c[5]), evaluator, breaks_site: (evaluator && BREAKS_SITE[evaluator]) || 'depends' };
        if (!evaluator) cp.no_evaluator_reason = reached === 'Classic' ? CLASSIC_ONLY : NO_EVALUATOR[n] || '';
        cps.push(cp);
    }
    cps.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const count = k => cps.filter(x => x.coverage === k).length;
    return JSON.stringify({ schema: 1, source: 'docs/COVERAGE.md', counts: { total: cps.length, detected: count('DETECTED'), partial: count('PARTIAL'), not_detected: count('NOT DETECTED') }, checkpoints: cps }, null, 2) + '\n';
}

module.exports = { build, SOURCE, OUT, KEYS, BREAKS_SITE, NO_EVALUATOR, CLASSIC_ONLY };

if (require.main === module) {
    const argv = process.argv.slice(2), opt = n => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : null; };
    const source = opt('--source') || SOURCE, out = opt('--out') || OUT;
    let text;
    try { text = build(source); } catch (e) { console.error(e.message); process.exit(2); }
    if (argv.includes('--check')) {
        let have = null; try { have = fs.readFileSync(out, 'utf8'); } catch { /* missing */ }
        if (have !== text) { console.error(`${path.relative(process.cwd(), out)} is stale: run "npm run guard:checkpoints"`); process.exit(1); }
        console.log('data/checkpoints.json is in step with docs/COVERAGE.md');
    } else {
        fs.writeFileSync(out, text);
        const j = JSON.parse(text);
        console.log(`wrote ${path.relative(process.cwd(), out)}: ${j.counts.total} checkpoints (${j.counts.detected} detected, ${j.counts.partial} partial, ${j.counts.not_detected} not detected)`);
    }
}
