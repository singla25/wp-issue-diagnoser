// Finds the site's own log files, INSIDE the site folder only. No question is asked and system logs are never looked at.
// Preference: a literal WP_DEBUG_LOG path from wp-config.php (when it is inside the site), wp-content/debug.log, error_log, wp-content/error_log.
// Every candidate must be a regular file, not a symlink, and its real path must stay inside the site. Only stat is used; no content is read here.
//   findLogs(siteRoot, wpConfigText) -> [{ path, rel, bytes, mtime }]

const fs = require('fs');
const path = require('path');

const LITERAL = /define\s*\(\s*['"]WP_DEBUG_LOG['"]\s*,\s*(['"])([^'"\r\n]+)\1\s*\)/;

function findLogs(siteRoot, wpConfigText = '') {
    let real; try { real = fs.realpathSync(siteRoot); } catch { return []; }
    const inside = p => p.startsWith(real + path.sep);
    const cands = [];
    const m = LITERAL.exec(String(wpConfigText || '').replace(/^\s*(\/\/|#).*$/gm, ''));   // lines commented out with // or # do not count
    if (m && path.isAbsolute(m[2])) cands.push(path.resolve(m[2]));
    cands.push(path.join(real, 'wp-content', 'debug.log'), path.join(real, 'error_log'), path.join(real, 'wp-content', 'error_log'));
    const out = [], seen = new Set();
    for (const c of cands) {
        try {
            const l = fs.lstatSync(c);
            if (l.isSymbolicLink() || !l.isFile()) continue;
            const rp = fs.realpathSync(c);
            if (!inside(rp) || seen.has(rp)) continue;
            seen.add(rp);
            out.push({ path: rp, rel: path.relative(real, rp).split(path.sep).join('/'), bytes: l.size, mtime: l.mtime.toISOString() });
        } catch { /* not there */ }
    }
    return out;
}

module.exports = { findLogs };
