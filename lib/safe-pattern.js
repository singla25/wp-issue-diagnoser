// Patterns the reporter types (oracles) are DATA that later run against page text and logs. A pattern can make a regex engine
// run for minutes (catastrophic backtracking), so the default is plain, case-insensitive text matching. A regular expression
// must be written explicitly as  re:<pattern>  and is refused when it is long or can backtrack badly.

const MAX_PATTERN = 200;
const MAX_INPUT = 20000; // text longer than this is cut before matching

// Not a regex parser: a conservative screen. It refuses what it cannot be sure about.
function regexProblem(src) {
    if (src.length > MAX_PATTERN) return `longer than ${MAX_PATTERN} characters`;
    if (/\\[1-9]|\\k</.test(src)) return 'back-references are not allowed';
    if (/\(\?<?[=!]/.test(src)) return 'look-ahead / look-behind is not allowed';
    // a group that contains a quantifier or an alternation, and is itself repeated: (a+)+  (a|b)*  (a*){2,}
    const groups = [...src.matchAll(/\(([^()]*)\)\s*([*+]|\{\d*,\d*\}|\{\d{2,}\})/g)];
    for (const g of groups) if (/[*+]|\{\d*,\d*\}|\|/.test(g[1].replace(/\\./g, ''))) return 'a repeated group that itself repeats or branches (nested repeat) can run forever';
    if (/(\.\*|\.\+)[^]*\1/.test(src.replace(/\\./g, ''))) return 'several ".*" / ".+" in one pattern can backtrack badly';
    try { new RegExp(src); } catch { return 'is not a valid regular expression'; }
    return null;
}

// spec: "text" (plain) or "re:pattern". -> { ok, kind, problem, test(str) }
function compile(spec) {
    const s = String(spec ?? '');
    if (!s) return { ok: false, problem: 'empty pattern' };
    if (s.length > MAX_PATTERN + 3) return { ok: false, problem: `longer than ${MAX_PATTERN} characters` };
    if (s.startsWith('re:')) {
        const src = s.slice(3), p = regexProblem(src);
        if (p) return { ok: false, kind: 'regex', problem: p };
        const re = new RegExp(src, 'i');
        return { ok: true, kind: 'regex', test: str => re.test(String(str).slice(0, MAX_INPUT)) };
    }
    if (s.length > MAX_PATTERN) return { ok: false, problem: `longer than ${MAX_PATTERN} characters` };
    const needle = s.toLowerCase();
    return { ok: true, kind: 'text', test: str => String(str).slice(0, MAX_INPUT).toLowerCase().includes(needle) };
}

module.exports = { compile, regexProblem, MAX_PATTERN, MAX_INPUT };
