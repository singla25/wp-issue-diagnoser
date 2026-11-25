// A preload for a CHILD process of a test (node --require <this file>): module lookup stops at the package root.
// Why: require.resolve looks in the node_modules folder of every parent folder. When the package sits inside another project that has the same packages (for example
// the snapshot of scripts/run-full.sh, which is under run-logs/ inside the repository), "the packages are not installed" can never be tested by hiding the package's own
// node_modules: the parent's copy is found. With this file only the node_modules folders INSIDE the package root are searched. The package root is two folders above
// this file (scripts/fixtures/ -> the root), so it is the snapshot's root in a snapshot. Used only by selftest-issue.js and only for its two child calls; nothing else loads it.
const Module = require('module');
const path = require('path');
const root = path.resolve(__dirname, '..', '..');
const original = Module._nodeModulePaths;
Module._nodeModulePaths = function (from) {
    return original.call(this, from).filter(p => p.startsWith(root + path.sep));
};
