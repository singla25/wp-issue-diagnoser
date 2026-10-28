// Last line of defence before anything is written to a report: mask things that look like credentials.
const PATTERNS = [
    [/\b(bearer)\s+[A-Za-z0-9._~+\/=-]{12,}/gi, '$1 [REDACTED]'],
    [/\b((?:api[_-]?key|secret|passw(?:or)?d|token|auth[_-]?key|private[_-]?key|session(?:id)?|cookie)\b["']?\s*[:=]\s*["']?)[^\s"',;]{6,}/gi, '$1[REDACTED]'],
    [/\b(define\s*\(\s*['"](?:DB_PASSWORD|AUTH_KEY|SECURE_AUTH_KEY|LOGGED_IN_KEY|NONCE_KEY|AUTH_SALT|SECURE_AUTH_SALT|LOGGED_IN_SALT|NONCE_SALT)['"]\s*,\s*)(['"]).*?\2/g, '$1$2[REDACTED]$2'],
    [/\b(AKIA[0-9A-Z]{16}|sk_(?:live|test)_[0-9A-Za-z]{16,}|ghp_[0-9A-Za-z]{30,}|xox[baprs]-[0-9A-Za-z-]{10,})\b/g, '[REDACTED]']
];
const text = s => PATTERNS.reduce((acc, [re, to]) => acc.replace(re, to), String(s));
function deep(v) {
    if (typeof v === 'string') return text(v);
    if (Array.isArray(v)) return v.map(deep);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, deep(x)]));
    return v;
}
module.exports = { text, deep };
