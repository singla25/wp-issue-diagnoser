// The commands Plugin Guard prints for the user to type, in the right form for where the package stands (lib/repo-layout.js):
//   inside the repository   the texts printed before this file existed, byte for byte (run from the repository root: npm run guard:*,
//                           npm run setup:guard, node src/plugin-guard/scripts/guard.js)
//   on its own              package-relative forms, run in the package folder: npm ci, npm run setup-ocr, npm run setup-sandbox,
//                           npm run setup-browser (no npx), node scripts/guard.js (each npm run name is a script of THIS package.json)
// PG_HINT_LAYOUT=repo forces the repository wording. It changes hint TEXT only (never a path, a folder or a decision) and is read here only;
// it exists for scripts/selftest-isolated-copy.js, whose copy re-runs suites that pin the repository wording. Not a user option.
// Nothing here writes, reads a site, or makes a request.
const layout = require('./repo-layout');

const REPO = {
    guard: 'node src/plugin-guard/scripts/guard.js',
    // issue-mode packages missing (lib/issue-deps.js)
    packagesLine: 'Run once from the repository root:  npm run setup:guard',
    // doctor, "Packages: <label>" (lib/workflow.js -> lib/doctor-checks.js)
    packagesLabel: 'issue mode (src/plugin-guard)',
    // lib/playwright.js: the module is missing / only the browser is missing; where it is missing
    playwrightMissing: 'Run once from the repository root: npm run setup:guard',
    chromiumMissing: 'Run once from the repository root: npm run setup:guard',
    playwrightWhere: 'in src/plugin-guard',
    // lib/report-pdf.js
    pdfFix: 'Run once: npm run setup:guard',
    // lib/ocr-data.js (the missing-file message)
    ocrLine: 'Run once from the repository root:  npm run guard:setup-ocr',
    // lib/runs.js
    noRun: 'No run found. Start one with: node src/plugin-guard/scripts/guard.js qa-url --url <site>',
    // lib/workflow.js: why Agent 1 did not run although a URL was given
    noBrowserStage: 'this Plugin Guard build has no browser-test stage; the combined tool (src/combined) provides one',
};
const ALONE = {
    guard: 'node scripts/guard.js',
    packagesLine: 'Run once in this folder: npm ci',
    packagesLabel: 'issue mode (this package)',
    playwrightMissing: 'Run once in this folder: npm ci, then: npm run setup-browser',
    chromiumMissing: 'Run once in this folder: npm run setup-browser',
    playwrightWhere: 'in this package',
    pdfFix: 'Run once in this folder: npm ci, then: npm run setup-browser',
    ocrLine: 'Run once in this folder: npm run setup-ocr',
    noRun: 'No run found. Start one with: node scripts/guard.js qa-code --root <wordpress-root>',
    noBrowserStage: 'this package has no browser-test stage',
};
// the npm scripts a hint may name: repository root script -> this package's own script
const SCRIPTS = { 'setup-ocr': 'setup-ocr', 'setup-sandbox': 'setup-sandbox', 'knowledge-review': 'knowledge-review', checkpoints: 'checkpoints' };
// the doctor's missing-packages advice per label (the repository label keeps its old command)
const PACKAGES_ADVICE = { [REPO.packagesLabel]: 'npm run setup:guard', [ALONE.packagesLabel]: ALONE.packagesLine };
// the guard.js usage text (its header comment) on its own: exact substrings replaced; inside the repository it is printed unchanged
const USAGE_ALONE = [
    ['(reports in reports/runs/<run-id>/; see src/plugin-guard/README.md)', '(reports in plugin-guard-reports/runs/<run-id>/; see README.md)'],
    ['(Agent 1 = browser tests: src/combined)', '(Agent 1 = browser tests: not part of this package)'],
    ['(qa-url and auto drive the Frontend QA agent and now live in src/combined: node src/combined/scripts/combined.js qa-url|auto ...)', '(qa-url and auto need the Frontend QA agent, which is not part of this package)'],
    ['(issue mode; needs: npm run setup:guard)', '(issue mode; needs: npm ci)'],
];

// true = the repository wording
function inRepo(pkg) {
    if (process.env.PG_HINT_LAYOUT === 'repo') return true;
    return layout.repoRoot(pkg) !== null;
}
// every fixed hint for one layout (the selftest compares both tables)
function forLayout(repo) {
    const t = repo ? REPO : ALONE;
    return {
        ...t,
        npmRun: name => { if (!SCRIPTS[name]) throw new Error(`hints: unknown script ${name}`); return repo ? `npm run guard:${name}` : `npm run ${SCRIPTS[name]}`; },
        scriptLabel: name => { if (!SCRIPTS[name]) throw new Error(`hints: unknown script ${name}`); return repo ? `guard:${name}` : SCRIPTS[name]; },
        frontendOnly: (cmd, args) => repo
            ? `"${cmd}" drives the Frontend QA agent, so it lives in src/combined now:\n  node src/combined/scripts/combined.js ${args.join(' ')}${cmd === 'auto' ? '\n  (or: npm run guard:auto -- ...)' : ''}`
            : `"${cmd}" needs the Frontend QA agent, which is not part of this package.`,
        usage: text => repo ? text : USAGE_ALONE.reduce((s, [a, b]) => s.split(a).join(b), text),
    };
}
const current = () => forLayout(inRepo());

module.exports = { inRepo, forLayout, current, REPO, ALONE, SCRIPTS, PACKAGES_ADVICE, USAGE_ALONE };
