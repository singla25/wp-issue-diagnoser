// plugin-guard's OWN Playwright: resolved from plugin-guard's node_modules (package.json pins @playwright/test), never from another module.
// Used by: the PDF reports (lib/report-pdf.js), the page probe (probe/), the doctor, and the browser tests.
//   load()   -> the @playwright/test module, or throws PlaywrightMissing with the exact command that fixes it
//   status() -> { ok, version, chromium, executable, reason } without throwing (for the doctor)
// The browser itself (Chromium) is installed once with:  npm run setup:guard   (it runs `playwright install chromium`)
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const FIX = 'Run once from the repository root: npm run setup:guard';

class PlaywrightMissing extends Error { constructor(msg) { super(msg); this.name = 'PlaywrightMissing'; this.exitCode = 3; } }

function resolvePath() { try { return require.resolve('@playwright/test', { paths: [ROOT] }); } catch { return null; } }

function load() {
    const p = resolvePath();
    if (!p) throw new PlaywrightMissing(`Playwright is not installed for plugin-guard. ${FIX}`);
    return require(p);
}

function status() {
    const p = resolvePath();
    if (!p) return { ok: false, version: null, chromium: false, executable: null, reason: `@playwright/test is not installed in src/plugin-guard. ${FIX}` };
    let version = null; try { version = JSON.parse(fs.readFileSync(path.join(path.dirname(p), 'package.json'), 'utf8')).version; } catch { /* unreadable */ }
    let exe = null, chromium = false;
    try { exe = require(p).chromium.executablePath(); chromium = !!exe && fs.existsSync(exe); } catch { /* no browser registry */ }
    return { ok: chromium, version, chromium, executable: exe, reason: chromium ? null : `Playwright ${version || ''} is installed, but its Chromium browser is not. ${FIX}` };
}

module.exports = { load, status, resolvePath, PlaywrightMissing, FIX };
