// Issue mode needs a few open-source packages (see THIRD-PARTY.md). The classic scan and the three-agent workflow do not,
// so this check runs only when an issue command needs them, and fails with one clear instruction.

const REQUIRED = ['php-parser', 'postcss', 'acorn', 'acorn-walk', 'minisearch', 'tesseract.js', 'pixelmatch', 'pngjs', 'jpeg-js', 'semver'];

function missing(names = REQUIRED) {
    return names.filter(n => { try { require.resolve(n, { paths: [__dirname] }); return false; } catch { return true; } });
}

// Throws an error with exitCode 2 (bad setup) naming what to run.
function need(names = REQUIRED) {
    const m = missing(names);
    if (!m.length) return;
    const e = new Error(`Issue mode needs packages that are not installed: ${m.join(', ')}.\nRun once from the repository root:  npm run setup:guard\n(The classic scan and qa-* commands work without them.)`);
    e.exitCode = 2;
    throw e;
}

module.exports = { REQUIRED, missing, need };
