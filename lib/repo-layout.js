// Where the classic reports go, and whether this package sits inside its own repository.
//   inside the repository   (the folder two levels above the package holds THIS package as src/plugin-guard):
//                           <repo>/reports/plugin-guard and <repo>/reports/runs, exactly as before
//   on its own              (a copy of src/plugin-guard alone, an installed package): plugin-guard-reports/ NEXT TO THE PACKAGE CODE
//                           (git-ignored), never the current folder and never a folder above the package
// PLUGIN_GUARD_REPORTS / PLUGIN_GUARD_RUNS still win (lib/project.js, lib/runs.js). Nothing here writes anything.
const fs = require('fs');
const path = require('path');

const PKG = path.join(__dirname, '..');
const FALLBACK = 'plugin-guard-reports';
const real = p => { try { return fs.realpathSync(p); } catch { return null; } };

// -> the repository root, or null when the package is on its own
function repoRoot(pkg = PKG) {
    const root = path.join(pkg, '..', '..');
    const inside = real(path.join(root, 'src', 'plugin-guard'));
    return inside !== null && inside === real(pkg) ? root : null;
}
// -> the folder that holds plugin-guard/ and runs/
function reportsBase(pkg = PKG) {
    const root = repoRoot(pkg);
    return root ? path.join(root, 'reports') : path.join(pkg, FALLBACK);
}

module.exports = { PKG, FALLBACK, repoRoot, reportsBase };
