// Minimal version comparison for WordPress plugin versions ("1.2.3", "2.0-beta1", "v3.1").

function parts(v) {
    return String(v || '0').trim().replace(/^v/i, '').split(/[.\-+_]/).map(p => (/^\d+$/.test(p) ? Number(p) : p));
}

function compare(a, b) {
    const pa = parts(a);
    const pb = parts(b);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
        const x = pa[i] === undefined ? 0 : pa[i];
        const y = pb[i] === undefined ? 0 : pb[i];
        if (x === y) continue;
        if (typeof x === 'number' && typeof y === 'number') return x < y ? -1 : 1;
        // a pre-release tag ("beta") sorts before the plain number
        if (typeof x === 'string' && typeof y === 'number') return -1;
        if (typeof x === 'number' && typeof y === 'string') return 1;
        return String(x) < String(y) ? -1 : 1;
    }
    return 0;
}

// Does `version` satisfy a range such as "<=1.4.2", ">=1.0 <1.5", "<2.1" or "*"?
function inRange(version, range) {
    if (!range || range === '*') return true;
    return String(range).split(/\s+/).filter(Boolean).every(term => {
        const m = term.match(/^(<=|>=|<|>|=)?(.+)$/);
        const op = m[1] || '=';
        const c = compare(version, m[2]);
        return op === '<' ? c < 0 : op === '<=' ? c <= 0 : op === '>' ? c > 0 : op === '>=' ? c >= 0 : c === 0;
    });
}

module.exports = { compare, inRange };
