// One snapshot per run, so a later run can say what is new, what got fixed and what a plugin update brought.

const fs = require('fs');
const path = require('path');
const { dirOf } = require('./project');

const dir = name => path.join(dirOf(name), 'history');
const stamp = d => d.toISOString().replace(/[-:]/g, '').replace(/\..*/, '').replace('T', '-');

function save(name, snapshot) {
    fs.mkdirSync(dir(name), { recursive: true });
    const file = path.join(dir(name), `${stamp(new Date(snapshot.at))}-${snapshot.type}.json`);
    fs.writeFileSync(file, JSON.stringify(snapshot, null, 2));
    return file;
}

function all(name) {
    if (!fs.existsSync(dir(name))) return [];
    return fs.readdirSync(dir(name)).filter(f => f.endsWith('.json')).sort().map(f => JSON.parse(fs.readFileSync(path.join(dir(name), f), 'utf8')));
}

// type: 'scan' | 'retest' | undefined (any)
const last = (name, type) => all(name).filter(s => !type || s.type === type).pop() || null;

function snapshotOf(result, type) {
    return {
        at: result.at, type, mode: result.mode,
        components: result.components.map(c => ({ ref: c.ref, kind: c.kind, version: c.version, active: c.active })),
        findings: result.findings.map(f => ({ id: f.id, severity: f.severity, title: f.title, rule: f.rule, plugins: f.plugins }))
    };
}

// What changed between the previous snapshot and the current findings.
function diff(prev, current, components) {
    if (!prev) return { baseline: null, isNew: new Set(), fixed: [], open: new Set(), updates: [], cause: new Map() };
    const prevIds = new Set(prev.findings.map(f => f.id));
    const curIds = new Set(current.map(f => f.id));
    const prevVer = new Map(prev.components.map(c => [c.ref, c]));
    const updates = [];
    for (const c of components) {
        const p = prevVer.get(c.ref);
        if (!p) updates.push({ ref: c.ref, from: null, to: c.version });
        else if (p.version !== c.version) updates.push({ ref: c.ref, from: p.version, to: c.version });
    }
    const cause = new Map();
    const isNew = new Set();
    for (const f of current) {
        if (prevIds.has(f.id)) continue;
        isNew.add(f.id);
        const hit = updates.find(u => f.plugins.includes(u.ref));
        if (hit) cause.set(f.id, hit.from ? `appeared after ${hit.ref} was updated ${hit.from} → ${hit.to}` : `appeared after ${hit.ref} was installed`);
    }
    return {
        baseline: prev.at, isNew, cause, updates,
        fixed: prev.findings.filter(f => !curIds.has(f.id)),
        open: new Set(current.filter(f => prevIds.has(f.id)).map(f => f.id))
    };
}

module.exports = { save, all, last, snapshotOf, diff };
