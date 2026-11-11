// Everything the wizard needs to turn "a folder on this computer" into a safe copy to analyse. The original is only READ; every write goes into the issue folder.
//   resolveSite(p)       a WordPress root, or its wp-content folder, with plugins/ and themes/ -> { root, wpContent } or { error } in plain words
//   copyForIssue(...)    the parts of the site that matter (issue/sandbox-copy.js rules: no symlinks, no .git / .env / backups / logs, a size cap), a redacted wp-config.php
//                        (lib/wp-config-redact.js), the two core files that give WordPress's version and script list, and the reporter's log (redacted, tail only)
//   hostIsLocal(host)    localhost, a private address, or a .local / .test / .localhost name: is "local" a believable answer for this address?
//   chooseOutputRoot()   where reports go: --out, PLUGIN_GUARD_ISSUES, the package's own issues/ folder, or ./plugin-guard-reports when that is not writable
// Deterministic; no network.

const fs = require('fs');
const path = require('path');
const siteCopy = require('../issue/sandbox-copy');
const redactMod = require('./redact');
const wpRedact = require('./wp-config-redact');

const isDir = p => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };
const isFile = p => { try { return fs.statSync(p).isFile(); } catch { return false; } };
const hasParts = d => isDir(path.join(d, 'plugins')) && isDir(path.join(d, 'themes'));

function resolveSite(p) {
    if (!p) return { error: 'No folder was given.' };
    let abs; try { abs = fs.realpathSync(p); } catch { return { error: `${p} does not exist.` }; }
    if (!isDir(abs)) return { error: `${p} is not a folder.` };
    if (hasParts(path.join(abs, 'wp-content'))) return { root: abs, wpContent: path.join(abs, 'wp-content'), given: 'root' };
    if (path.basename(abs) === 'wp-content' && hasParts(abs)) return { root: path.dirname(abs), wpContent: abs, given: 'wp-content' };
    if (isDir(path.join(abs, 'wp-content'))) return { error: `${p} has a wp-content folder, but it has no "plugins" and "themes" folders inside. Is it the right site?` };
    return { error: `${p} is not a WordPress folder: I expected a folder that contains "wp-content" (with "plugins" and "themes" inside), or the wp-content folder itself.` };
}

function hostIsLocal(host) {
    const h = String(host || '').toLowerCase().replace(/^\[|\]$/g, '');
    if (!h) return false;
    if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.test') || h.endsWith('.localdomain') || h === '::1') return true;
    if (!h.includes('.') && !h.includes(':')) return true;                                  // a single name such as "wordpress" (a container, a hosts entry)
    const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(h);
    if (m) { const [a, b] = [Number(m[1]), Number(m[2])]; return a === 127 || a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31) || (a === 169 && b === 254); }
    if (h.includes(':')) return /^(fc|fd|fe80)/.test(h);
    return false;
}

// the reporter's log: the last 2 MB, redacted line by line, never modified at the source. When that tail holds no fatal error and the problem looks like a crash,
// issue/logs.js deepScan reads more of the original (up to 64 MB) and the fatal-like lines it finds are kept at the END of the copy, inside the 2 MB the analysis reads.
function readLogRedacted(file, { maxBytes = 2 * 1024 * 1024, crash = false, cap = 64 * 1024 * 1024 } = {}) {
    const logsLib = require('../issue/logs');
    const st = fs.statSync(file);
    if (!st.isFile()) throw Object.assign(new Error(`${file} is not a file.`), { exitCode: 2 });
    const read = len => {
        const fd = fs.openSync(file, 'r');
        try {
            const buf = Buffer.alloc(len); fs.readSync(fd, buf, 0, len, st.size - len);
            let text = buf.toString('utf8'); if (st.size > len) text = text.slice(text.indexOf('\n') + 1);
            return text.split(/\r?\n/).map(l => redactMod.text(l).slice(0, 1200)).join('\n');
        } finally { fs.closeSync(fd); }
    };
    let deep = null, extra = '';
    if (crash && st.size > maxBytes) {
        const tail = read(maxBytes);
        if (!logsLib.hasFatal(tail)) { deep = logsLib.deepScan(file, { tailBytes: maxBytes, cap }); if (deep && deep.found) extra = deep.text; }
    }
    const room = Math.max(256 * 1024, maxBytes - Buffer.byteLength(extra, 'utf8') - 1024);
    const text = read(Math.min(st.size, room));
    return { text: extra ? `${text}\n${extra}` : text, bytes: st.size, truncated: st.size > room, deep: deep ? { passes: deep.passes.map(p => ({ direction: p.direction, bytes: p.bytes })), read_bytes: deep.read_bytes, total_bytes: deep.total_bytes, found: deep.found, entries: deep.entries, text: logsLib.describeDeep(deep) } : null };
}

// -> { files, bytes, steps:[...for the report], wp_config: 'read' | 'not-found', log: 'copied' | 'none' }. Throws an Error with .exitCode and .cap when the copy is refused.
// logFiles: [{ src, dest }] (dest relative to the copy; the first one is normally wp-content/debug.log); logFile is the single-file form of the same.
// setTimes: injectable for tests (default fs.lutimesSync). times_preserved: false (with times_failed) when any original file time could not be kept.
function copyForIssue({ site, issueDir, destSite, logFile = null, logFiles = null, limits = {}, crash = false, setTimes = fs.lutimesSync }) {
    const steps = [];
    let res, timesFailed = 0;
    try { res = siteCopy.copySite(site.root, destSite, { sandboxDir: issueDir, ...limits, setTimes }); }
    catch (e) { if (/cap|files, above/.test(e.message)) { const c = new Error(e.message); c.exitCode = 2; c.cap = true; throw c; } throw e; }
    steps.push({ id: 'intake-copy', label: 'Copy of the site (the original is only read)', status: 'PASSED', reason: `${res.files} files copied from plugins, themes, must-use plugins and languages; symbolic links, backups, keys, .env files and logs were skipped (${res.skipped_total} item(s))` });
    // core files that give the WordPress version and its list of scripts (read-only)
    for (const rel of ['wp-includes/version.php', 'wp-includes/script-loader.php']) {
        const src = path.join(site.root, rel);
        const st = (() => { try { return fs.lstatSync(src); } catch { return null; } })();
        // the original file time is kept (lutimes on the file just written in the copy; a link is never followed)
        if (st && st.isFile()) { const to = path.join(destSite, rel); fs.mkdirSync(path.dirname(to), { recursive: true }); fs.copyFileSync(src, to); try { setTimes(to, st.atime, st.mtime); if (!(Math.abs(fs.lstatSync(to).mtimeMs - st.mtimeMs) < 2000)) timesFailed++; } catch { timesFailed++; } }
    }
    // wp-config.php: read from the original, only the safe settings are written into the copy
    let cfgState = 'not-found';
    const cfgSrc = [path.join(site.root, 'wp-config.php')].find(f => isFile(f) && !fs.lstatSync(f).isSymbolicLink());
    if (cfgSrc) {
        const r = wpRedact.redact(fs.readFileSync(cfgSrc, 'utf8'));
        fs.writeFileSync(path.join(destSite, 'wp-config.php'), r.text, { mode: 0o600 });
        cfgState = 'read';
        steps.push({ id: 'intake-wp-config', label: 'wp-config.php', status: 'PASSED', reason: `read from your site (read-only); only ${r.kept.length} non-secret setting(s) were kept; database details, keys and salts were removed` });
    } else steps.push({ id: 'intake-wp-config', label: 'wp-config.php', status: 'NOT_RUN', reason: 'wp-config was not read (no wp-config.php next to wp-content), so settings such as the site address are not checked' });
    // the log
    let logState = 'none';
    const logList = logFiles && logFiles.length ? logFiles : logFile ? [{ src: logFile, dest: 'wp-content/debug.log' }] : [];
    let unreadable = null;   // the first log that exists but could not be read: { name, code }
    if (logList.length) {
        const notes = []; let first = null;
        for (const { src, dest } of logList) {
            const target = path.resolve(destSite, dest);
            if (!target.startsWith(path.resolve(destSite) + path.sep)) throw Object.assign(new Error(`${dest} would be outside the copy.`), { exitCode: 2 });   // never outside the copy
            let l;
            try { l = readLogRedacted(src, { crash: crash && !first }); } catch (e) { if (!unreadable) unreadable = { name: path.basename(src), code: e.code || 'read error' }; continue; }
            fs.mkdirSync(path.dirname(target), { recursive: true });
            fs.writeFileSync(target, l.text + '\n', { mode: 0o600 });
            const one = `${l.truncated ? 'the last 2 MB of ' : ''}${Math.max(1, Math.round(l.bytes / 1024))} KB`;
            if (!first) first = { one, l }; else notes.push(`${dest} (${one})`);
        }
        if (first) {
            logState = 'copied';
            steps.push({ id: 'intake-log', label: 'Your log file', status: 'PASSED', log_read: { original_bytes: first.l.bytes, truncated: !!first.l.truncated, parts: ((first.l.deep && first.l.deep.passes) || []).map(p => ({ direction: p.direction, bytes: p.bytes })) }, reason: `copied and redacted (${first.one}); your file was not changed${first.l.deep ? `; ${first.l.deep.text}` : ''}${notes.length ? `; also copied: ${notes.join(', ')}` : ''}` });
        }
    }
    // a log that exists but could not be read (for example a file given with --log that this user may not read): said as it is, separately from "no log found"
    if (logState !== 'copied' && unreadable) { logState = 'unreadable'; steps.push({ id: 'intake-log', label: 'Your log file', status: 'NOT_RUN', log_state: 'unreadable', reason: `The log file ${unreadable.name} could not be read (${unreadable.code}), so no error message from it was used. This does not mean nothing went wrong.` }); }
    else if (logState !== 'copied') steps.push({ id: 'intake-log', label: 'Your log file', status: 'NOT_RUN', log_state: 'none', reason: 'No error log was found on this site, so no error message from a log was read. This does not mean nothing went wrong.' });
    timesFailed += res.times_failed || 0;
    return { ...(timesFailed ? { times_preserved: false, times_failed: timesFailed } : {}), files: res.files, bytes: res.bytes, steps, wp_config: cfgState, log: logState, skipped_by_reason: res.skipped_by_reason, php_skipped: res.php_skipped, php_skipped_examples: res.php_skipped_examples };
}

// Where reports and the copy go. Never inside the site folder. -> { dir, why }
function chooseOutputRoot({ out = null, env = process.env, cwd = process.cwd(), defaultRoot, siteRoot = null } = {}) {
    const writable = d => { try { fs.mkdirSync(d, { recursive: true, mode: 0o700 }); fs.accessSync(d, fs.constants.W_OK); return true; } catch { return false; } };
    let dir, why;
    if (out) { dir = path.resolve(cwd, out); why = '--out'; }
    else if (env.PLUGIN_GUARD_ISSUES) { dir = path.resolve(env.PLUGIN_GUARD_ISSUES); why = 'PLUGIN_GUARD_ISSUES'; }
    else if (writable(defaultRoot)) { dir = defaultRoot; why = 'default'; }
    else { dir = path.resolve(cwd, 'plugin-guard-reports'); why = 'the default folder is not writable, so ./plugin-guard-reports in the current folder is used'; }
    if (siteRoot) {
        const a = path.resolve(dir), b = fs.realpathSync(siteRoot), inside = (p, c) => c === p || c.startsWith(p + path.sep);
        let aReal = a; const rest = [];
        for (let c = a; ; c = path.dirname(c)) { try { aReal = path.join(fs.realpathSync(c), ...rest); break; } catch { rest.unshift(path.basename(c)); if (path.dirname(c) === c) break; } }
        if (inside(b, aReal)) { const e = new Error(`The reports folder (${a}) is inside your site folder (${b}). Files there could be downloaded by visitors. Choose a folder elsewhere with --out.`); e.exitCode = 2; throw e; }
    }
    if (!writable(dir)) { const e = new Error(`The reports folder ${dir} cannot be written. Choose another with --out <folder>.`); e.exitCode = 2; throw e; }
    return { dir, why };
}

module.exports = { resolveSite, hostIsLocal, readLogRedacted, copyForIssue, chooseOutputRoot, hasParts };
