// Who owns a path? The only gate between "we looked at this file" and "a fix task may change this file".
//
//   custom     inside an allowlisted root, not in a protected path   -> fix tasks allowed
//   protected  core, vendor, node_modules, explicit protectedPaths   -> never a task target
//   unknown    anything else (e.g. a plugin nobody declared as ours)  -> needs an explicit allowlist entry first
//   rejected   not a usable path (traversal, NUL byte, outside the root, symlink escape)
//
// Ownership is never guessed from a plugin name. With no allowlist, nothing is "custom".
// Inspection is allowed everywhere; this module only decides about MODIFICATION.

const fs = require('fs');
const path = require('path');

// Cannot be allowlisted as a whole: too broad to mean "ours".
const TOO_BROAD = ['', '.', 'wp-content', 'wp-content/plugins', 'wp-content/themes', 'wp-content/mu-plugins', 'wp-content/uploads', 'wp-admin', 'wp-includes'];
// Always protected, even inside an allowlisted root.
const GENERATED = /(^|\/)(vendor|vendor_prefixed|node_modules|bower_components)(\/|$)|\.min\.(js|css)$/i;
const CORE = /^(wp-admin|wp-includes)(\/|$)|^wp-[\w-]+\.php$|^(index|xmlrpc)\.php$/i;

const toPosix = p => p.split(path.sep).join('/');
const clean = rel => toPosix(String(rel)).replace(/^\.\//, '').replace(/\/+$/, '');

function realRoot(root) {
    if (!root) throw new Error('No project root given');
    let r;
    try { r = fs.realpathSync(root); } catch { throw new Error(`Project root "${root}" does not exist`); }
    if (!fs.statSync(r).isDirectory()) throw new Error(`Project root "${root}" is not a folder`);
    return r;
}

const inside = (parent, child) => child === parent || child.startsWith(parent + path.sep);

// Resolve a user/config/finding path to a path relative to the root, or explain why it is unusable.
// Symlinks are followed: a link that leaves the root makes the path unusable.
function resolveInside(root, input) {
    if (typeof input !== 'string' || !input.trim()) return { ok: false, reason: 'empty path' };
    if (input.includes('\0')) return { ok: false, reason: 'path contains a NUL byte' };
    const rr = realRoot(root);
    const abs = path.isAbsolute(input) ? path.normalize(input) : path.resolve(rr, input);
    if (!inside(rr, abs)) return { ok: false, reason: 'path is outside the project root' };
    // follow links at the nearest existing ancestor: a link that leaves the root makes the path unusable
    let probe = abs;
    while (!fs.existsSync(probe) && probe !== path.dirname(probe)) probe = path.dirname(probe);
    const real = safeReal(probe);
    if (!real || !inside(rr, real)) return { ok: false, reason: 'path (or a symlink in it) leaves the project root' };
    return { ok: true, rel: clean(path.relative(rr, abs)), abs, symlink: passesSymlink(rr, probe) };
}
// true when any existing part of the path below the root is a symbolic link
function passesSymlink(rr, target) {
    let cur = target;
    while (cur !== rr && inside(rr, cur)) {
        try { if (fs.lstatSync(cur).isSymbolicLink()) return true; } catch { /* part does not exist */ }
        cur = path.dirname(cur);
    }
    return false;
}
function safeReal(p) { try { return fs.realpathSync(p); } catch { return null; } }

// Validate a policy ({ customPaths, protectedPaths }) against the root. Returns { policy, errors, warnings }.
function loadPolicy(root, raw = {}) {
    const errors = [], warnings = [];
    const take = (list, label, { broadIsError }) => {
        const out = [];
        for (const item of Array.isArray(list) ? list : []) {
            const r = resolveInside(root, item);
            if (!r.ok) { errors.push(`${label} "${item}": ${r.reason}`); continue; }
            if (r.symlink) { errors.push(`${label} "${item}": is or passes through a symlink; list the real folder instead`); continue; }
            if (broadIsError && TOO_BROAD.includes(r.rel)) { errors.push(`${label} "${item}": too broad to mean "our code". Name the specific plugin or theme folder, e.g. wp-content/plugins/<your-plugin>`); continue; }
            if (broadIsError && (CORE.test(r.rel) || GENERATED.test(r.rel))) { errors.push(`${label} "${item}": WordPress core or generated/vendor code cannot be declared as custom code`); continue; }
            if (broadIsError && !fs.existsSync(r.abs)) warnings.push(`${label} "${item}" does not exist`);
            out.push(r.rel);
        }
        return [...new Set(out)];
    };
    if (raw.customPaths !== undefined && !Array.isArray(raw.customPaths)) errors.push('customPaths must be a list');
    if (raw.protectedPaths !== undefined && !Array.isArray(raw.protectedPaths)) errors.push('protectedPaths must be a list');
    const customPaths = take(raw.customPaths, 'customPaths', { broadIsError: true });
    const protectedPaths = take(raw.protectedPaths, 'protectedPaths', { broadIsError: false });
    return { policy: { root: realRoot(root), customPaths, protectedPaths }, errors, warnings };
}

// -> { owner: 'custom'|'protected'|'unknown'|'rejected', reason, rel, matchedRoot }
function classify(policy, input) {
    const r = resolveInside(policy.root, input);
    if (!r.ok) return { owner: 'rejected', reason: r.reason, rel: null };
    const rel = r.rel;
    const under = base => rel === base || rel.startsWith(base + '/');
    const explicit = policy.protectedPaths.find(under);
    if (explicit) return { owner: 'protected', reason: `listed in protectedPaths (${explicit})`, rel };
    if (CORE.test(rel)) return { owner: 'protected', reason: 'WordPress core', rel };
    if (GENERATED.test(rel)) return { owner: 'protected', reason: 'vendor / installed dependency / generated file', rel };
    const root = policy.customPaths.find(under);
    if (root) {
        if (r.symlink) return { owner: 'rejected', reason: 'symlink inside the allowlisted folder', rel };
        return { owner: 'custom', reason: `inside allowlisted ${root}`, rel, matchedRoot: root };
    }
    if (!policy.customPaths.length) return { owner: 'unknown', reason: 'no customPaths allowlist is configured, so no code is treated as ours', rel };
    return { owner: 'unknown', reason: 'not inside any customPaths entry: ownership is not assumed (a plugin name or location does not prove it is custom). Add it to customPaths to allow fix tasks.', rel };
}

// The component (plugin / theme / mu-plugin slug) a root-relative path belongs to, e.g. "plugin:my-plugin".
function componentOf(rel) {
    const m = /^wp-content\/(plugins|themes|mu-plugins)\/([^/]+)/.exec(clean(rel || ''));
    if (!m) return /^wp-(admin|includes)\//.test(rel || '') ? 'wordpress-core' : null;
    return `${m[1] === 'plugins' ? 'plugin' : m[1] === 'themes' ? 'theme' : 'mu'}:${m[2].replace(/\.php$/, '')}`;
}

module.exports = { loadPolicy, classify, resolveInside, componentOf, realRoot, TOO_BROAD };
