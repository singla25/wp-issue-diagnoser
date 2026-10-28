// `issue cleanup`: remove leftover sandboxes and old issue folders, safely.
//   - It only ever looks at the DIRECT children of the issues folder and the sandboxes folder whose names are issue ids (iss-YYYYMMDD-HHMMSS-xxxxxx).
//   - Anything else is listed as skipped and never touched: other files, other folders, index.html, symbolic links, names that do not match.
//   - A path is re-checked immediately before it is deleted (a folder swapped for a symbolic link after the list was made is refused).
//   - Nothing is deleted without a "yes": an interactive confirmation or --yes. With no terminal and no --yes it only lists.
//   - A sandbox whose owner process is still running is kept. Docker resources are removed by label only (see sandbox.js), never by guessing.
const fs = require('fs');
const path = require('path');
const store = require('../lib/issue-store');
const sandbox = require('./sandbox');
const readdir = require('../lib/sorted-dir');

const ID = store.ISSUE_RE;
const DAY = 86400000;

class CleanupRefusal extends Error { constructor(m) { super(m); this.name = 'CleanupRefusal'; } }

// the folder itself must be a real directory that is not the filesystem root, the home folder, or a symbolic link
function checkRoot(root, what) {
    let st; try { st = fs.lstatSync(root); } catch { return null; }
    if (st.isSymbolicLink()) throw new CleanupRefusal(`the ${what} folder ${root} is a symbolic link: refusing to clean it`);
    if (!st.isDirectory()) throw new CleanupRefusal(`the ${what} folder ${root} is not a directory`);
    const real = fs.realpathSync(root);
    if (real === path.parse(real).root || real === require('os').homedir() || real.split(path.sep).filter(Boolean).length < 2) throw new CleanupRefusal(`the ${what} folder resolves to ${real}, which is too broad to clean`);
    return real;
}
// a direct child that is a plain directory with an issue-id name
function safeChild(realRoot, name) {
    if (!ID.test(name)) return { ok: false, reason: 'the name is not an issue id' };
    const p = path.join(realRoot, name);
    let st; try { st = fs.lstatSync(p); } catch { return { ok: false, reason: 'it no longer exists' }; }
    if (st.isSymbolicLink()) return { ok: false, reason: 'it is a symbolic link' };
    if (!st.isDirectory()) return { ok: false, reason: 'it is not a directory' };
    let real; try { real = fs.realpathSync(p); } catch { return { ok: false, reason: 'it cannot be resolved' }; }
    if (path.dirname(real) !== realRoot) return { ok: false, reason: 'it resolves outside its parent folder' };
    return { ok: true, path: real, st };
}
const sizeOf = dir => { let n = 0; (function w(d) { let es; try { es = readdir(d, { withFileTypes: true }); } catch { return; } for (const e of es) { const f = path.join(d, e.name); try { if (e.isDirectory() && !e.isSymbolicLink()) w(f); else n += fs.lstatSync(f).size; } catch { /* vanished */ } } })(dir); return n; };
const alive = pid => { if (!Number.isInteger(pid) || pid <= 0) return false; try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };

// -> { issues: [...], sandboxes: [...], skipped: [...] }
function plan({ olderThanDays = 30, issues = true, sandboxes = true, only = null, now = Date.now(), sandboxOptions = {} } = {}) {
    only = only || null;
    if (only !== null && !ID.test(only)) throw new CleanupRefusal(`"${only}" is not an issue id`);
    const out = { issues: [], sandboxes: [], skipped: [], olderThanDays };
    const sbRoot = sandbox.sandboxesRoot(), isRoot = store.issuesRoot();
    const liveSandbox = new Set();
    if (sandboxes) {
        const real = checkRoot(sbRoot, 'sandboxes');
        if (real) for (const name of readdir(real)) {
            if (!/^iss-/.test(name)) { out.skipped.push({ path: path.join(sbRoot, name), reason: 'not a sandbox folder (name does not start with iss-)' }); continue; }
            const c = safeChild(real, name);
            if (!c.ok) { out.skipped.push({ path: path.join(sbRoot, name), reason: c.reason }); continue; }
            if (only && name !== only) continue;
            let state = null; try { state = JSON.parse(fs.readFileSync(path.join(c.path, 'state.json'), 'utf8')); } catch { /* none */ }
            if (state && alive(state.pid) && state.pid !== process.pid) { liveSandbox.add(name); out.skipped.push({ path: c.path, reason: `its owner process ${state.pid} is still running` }); continue; }
            out.sandboxes.push({ id: name, path: c.path, project: state && state.project || null, bytes: sizeOf(c.path), reason: state ? 'left behind: its owner process is gone' : 'a sandbox folder without a state file' });
        }
    }
    if (issues) {
        const real = checkRoot(isRoot, 'issues');
        if (real) for (const name of readdir(real)) {
            if (!ID.test(name)) { if (name !== 'index.html') out.skipped.push({ path: path.join(isRoot, name), reason: 'not an issue folder' }); continue; }
            const c = safeChild(real, name);
            if (!c.ok) { out.skipped.push({ path: path.join(isRoot, name), reason: c.reason }); continue; }
            if (only && name !== only) continue;
            let created = null; try { created = Date.parse(JSON.parse(fs.readFileSync(path.join(c.path, 'issue.json'), 'utf8')).created_at); } catch { /* no usable date */ }
            const stamp = Number.isFinite(created) ? created : c.st.mtimeMs, age = Math.floor((now - stamp) / DAY);
            if (!only && age < olderThanDays) continue;
            if (liveSandbox.has(name)) { out.skipped.push({ path: c.path, reason: 'its sandbox is still running' }); continue; }
            out.issues.push({ id: name, path: c.path, age_days: age, bytes: sizeOf(c.path), reason: only ? 'named on the command line' : `older than ${olderThanDays} days` });
        }
    }
    return out;
}

// -> { removed: [...], failed: [{path, reason}] }. `confirm()` must return true; it is asked once, with the list.
async function apply(p, { confirm, sandboxOptions = {} } = {}) {
    const total = p.issues.length + p.sandboxes.length;
    const res = { removed: [], failed: [], asked: false, confirmed: false };
    if (!total) return res;
    if (typeof confirm !== 'function') return res;
    res.asked = true; res.confirmed = !!(await confirm(p));
    if (!res.confirmed) return res;
    const sbReal = checkRoot(sandbox.sandboxesRoot(), 'sandboxes'), isReal = checkRoot(store.issuesRoot(), 'issues');
    for (const s of p.sandboxes) {
        const c = sbReal && safeChild(sbReal, s.id);       // checked again, right before the deletion
        if (!c || !c.ok || c.path !== s.path) { res.failed.push({ path: s.path, reason: `refused: ${c && c.reason || 'the sandboxes folder is gone'}` }); continue; }
        try { const r = sandbox.destroy(s.id, sandboxOptions); if (fs.existsSync(c.path)) res.failed.push({ path: c.path, reason: 'could not be removed completely (files owned by the container user?)' }); else res.removed.push({ path: c.path, kind: 'sandbox', leftovers: r.leftovers }); }
        catch (e) { res.failed.push({ path: c.path, reason: String(e.message).split('\n')[0] }); }
    }
    for (const i of p.issues) {
        const c = isReal && safeChild(isReal, i.id);
        if (!c || !c.ok || c.path !== i.path) { res.failed.push({ path: i.path, reason: `refused: ${c && c.reason || 'the issues folder is gone'}` }); continue; }
        try { fs.rmSync(c.path, { recursive: true, force: true }); res.removed.push({ path: c.path, kind: 'issue' }); } catch (e) { res.failed.push({ path: c.path, reason: String(e.message).split('\n')[0] }); }
    }
    try { require('./index-page').write(); } catch { /* convenience only */ }
    return res;
}

module.exports = { plan, apply, safeChild, checkRoot, CleanupRefusal };
