// The Issues index: issues/index.html lists every issue with its verdict, so there is one place to look. A static file (no server): it lists
// what is in the issues folder (outside the web root, owner-only) and links to each issue's result/issue.html with a relative path.
const fs = require('fs');
const path = require('path');
const store = require('../lib/issue-store');
const html = require('../lib/issue-html');

function collect() {
    return store.list().map(i => {
        const dir = store.dirOf(i.id), fj = path.join(dir, 'result', 'findings.json');
        let f = null; try { f = JSON.parse(fs.readFileSync(fj, 'utf8')); } catch { /* not investigated yet */ }
        const top = f && f.hypotheses.filter(h => h.status !== 'REJECTED_FALSE_POSITIVE')[0];
        const last = f && f.retests[f.retests.length - 1];
        return { id: i.id, title: require('../lib/plain-names').shortTitle(i.title, i.description), symptom: i.symptom, environment: i.environment, created_at: i.created_at, verdict: f ? f.verdict.label : null, top_status: top ? top.status : null, retests: f ? f.retests.length : 0, last_retest: last ? last.verdict : null, has_report: !!(f && fs.existsSync(path.join(dir, 'result', 'issue.html'))) };
    }).sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : a.id < b.id ? -1 : 1));
}
function write() {
    const root = store.issuesRoot();
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    const file = path.join(root, 'index.html');
    fs.writeFileSync(file, html.buildIndex(collect()), { mode: 0o600 });
    return file;
}
module.exports = { write, collect };
