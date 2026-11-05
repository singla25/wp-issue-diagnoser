// Opens the finished report (issue.html) in the person's browser, or says why not. This is the ONLY file of the project that starts a program for
// that purpose (static test in scripts/selftest-part5.js). The opener is the OS default, started with an argument array, never through a shell.
// Only <issues root>/<id>/result/issue.html is ever opened: the real path must be inside the issues root and the file itself must not be a symlink.
// The spawn function is injectable so that tests never launch a browser.
const fs = require('fs');
const path = require('path');
const { spawn: realSpawn } = require('child_process');

const FALLBACK = url => `I could not open a browser here. Open this file in your browser: ${url}`;

// file URL from an absolute path: every path segment percent-encoded (space %20, # %23, ? %3F, % %25, non-ASCII as UTF-8)
function fileUrl(abs) {
    const p = String(abs).replace(/\\/g, '/');
    const drive = /^[A-Za-z]:\//.test(p);
    const segs = (drive ? p.slice(2) : p).split('/').map(s => encodeURIComponent(s).replace(/[!'()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase()));
    return 'file://' + (drive ? '/' + p.slice(0, 2) : '') + segs.join('/');
}

const inside = (child, parent) => { const r = path.relative(parent, child); return r === '' || (!!r && !r.startsWith('..') && !path.isAbsolute(r)); };

// -> { ok, real?, reason? }
function check(file, issuesRoot) {
    try {
        if (path.basename(file) !== 'issue.html') return { ok: false, reason: 'not the report page' };
        const st = fs.lstatSync(file);
        if (st.isSymbolicLink()) return { ok: false, reason: 'the report page is a link' };
        if (!st.isFile()) return { ok: false, reason: 'not a file' };
        const real = fs.realpathSync(file), root = fs.realpathSync(issuesRoot);
        if (path.basename(real) !== 'issue.html' || !inside(real, root)) return { ok: false, reason: 'outside the reports folder' };
        const rel = path.relative(root, real).split(path.sep);
        if (rel.length !== 3 || rel[1] !== 'result' || !require('./issue-store').ISSUE_RE.test(rel[0])) return { ok: false, reason: 'not the report page of an issue' };
        return { ok: true, real };
    } catch (e) { return { ok: false, reason: 'not readable' }; }
}

const hasDisplay = (env = process.env, platform = process.platform) => platform !== 'linux' || !!(env.DISPLAY || env.WAYLAND_DISPLAY);

function openerFor(platform, target) {
    if (platform === 'darwin') return { cmd: 'open', args: [target] };
    if (platform === 'win32') return { cmd: 'rundll32', args: ['url.dll,FileProtocolHandler', target] };
    return { cmd: 'xdg-open', args: [target] };
}

// -> { opened: boolean, url, reason? }. Never throws.
async function open(file, { issuesRoot, env = process.env, platform = process.platform, tty = true, spawn = realSpawn } = {}) {
    const c = check(file, issuesRoot);
    const url = fileUrl(c.ok ? c.real : path.resolve(file));
    if (!tty) return { opened: false, url, reason: 'no terminal' };
    if (!c.ok) return { opened: false, url, reason: c.reason };
    if (!hasDisplay(env, platform)) return { opened: false, url, reason: 'no display' };
    const { cmd, args } = openerFor(platform, c.real);
    try {
        const child = spawn(cmd, args, { shell: false, detached: true, stdio: 'ignore' });
        const started = await new Promise(resolve => {
            if (!child || typeof child.on !== 'function') return resolve(true);
            const t = setTimeout(() => resolve(true), 1500);
            child.on('error', () => { clearTimeout(t); resolve(false); });
            child.on('spawn', () => { clearTimeout(t); resolve(true); });
        });
        if (child && typeof child.unref === 'function') child.unref();
        return started ? { opened: true, url } : { opened: false, url, reason: 'the opener failed' };
    } catch (e) { return { opened: false, url, reason: 'the opener failed' }; }
}

module.exports = { open, check, fileUrl, hasDisplay, openerFor, FALLBACK };
