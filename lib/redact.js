// Last line of defence before anything is written to a report: mask things that look like credentials.
const PATTERNS = [
    [/\b(bearer)\s+[A-Za-z0-9._~+\/=-]{12,}/gi, '$1 [REDACTED]'],
    [/\b((?:api[_-]?key|secret|passw(?:or)?d|token|auth[_-]?key|private[_-]?key|session(?:id)?|cookie)\b["']?\s*[:=]\s*["']?)[^\s"',;]{6,}/gi, '$1[REDACTED]'],
    [/\b(define\s*\(\s*['"](?:DB_PASSWORD|AUTH_KEY|SECURE_AUTH_KEY|LOGGED_IN_KEY|NONCE_KEY|AUTH_SALT|SECURE_AUTH_SALT|LOGGED_IN_SALT|NONCE_SALT)['"]\s*,\s*)(['"]).*?\2/g, '$1$2[REDACTED]$2'],
    // WordPress recovery mode (the "technical issue" e-mail link): rm_token and rm_key, in a query, plain text, JSON or URL-encoded (%26 and %3D), any case
    [/((?<![A-Za-z])rm_(?:token|key)\b["']?\s*(?:[:=]|%3[dD])\s*["']?)(?:(?!%26)[^\s"'&;,)<>])+/gi, '$1[REDACTED]'],
    // WordPress nonces: the _wpnonce and _ajax_nonce parameters and the X-WP-Nonce header (query, text, JSON, URL-encoded)
    [/((?<![A-Za-z$])(?:_wpnonce|_ajax_nonce|x-wp-nonce)\b["']?\s*(?:[:=]|%3[dD])\s*["']?)[0-9a-f]{6,}(?![A-Za-z0-9_.(])/gi, '$1[REDACTED]'],
    // WordPress login cookies (wordpress_logged_in_<hash>, wordpress_sec_<hash>, wordpress_<hash>) in ANY position of a Cookie / Set-Cookie line
    [/((?<![A-Za-z0-9_])wordpress_(?:(?:logged_in|sec)_[0-9a-f]+|[0-9a-f]{20,})\s*(?:=|%3[dD])\s*)(?:(?!%3[bB])[^\s;,"'<>])+/gi, '$1[REDACTED]'],
    // the login form and profile passwords (pwd, user_pass, pass1, pass2) and the token and secret names the generic mask misses
    [/((?<![A-Za-z$])(?:pwd|user_pass|pass1|pass2)\b["']?\s*(?:=|%3[dD])\s*["']?)(?!%[sdu]\b|\?|\$)(?:(?!%26)[^\s"'&;,)<>])+/gi, '$1[REDACTED]'],
    [/((?<![A-Za-z$])(?:access|refresh|id|auth|csrf|api|client)_(?:token|secret)\b["']?\s*(?:[:=]|%3[dD])\s*["']?)(?!(?:null|undefined|true|false)\b)[A-Za-z0-9_~+\/=%-]{8,}(?![A-Za-z0-9_.(])/gi, '$1[REDACTED]'],
    // a key parameter in a URL query (the password-reset link has ?key=...&login=...): only right after ? or & (or their encoded forms)
    [/((?:\?|&|%3[fF]|%26)(?:key|access_key|secret_key)(?:=|%3[dD]))(?:(?!%26)[^\s"'&;,)<>])+/gi, '$1[REDACTED]'],
    // DB_PASSWORD written as plain text (the define() form is masked above)
    [/(\bDB_PASSWORD\b["']?\s*[:=]\s*["']?)[^\s"',;<>]{6,}/g, '$1[REDACTED]'],
    // Authorization headers with a scheme (Bearer is masked at the top); a header without a scheme is plain text
    [/(\bauthorization["']?\s*[:=]\s*["']?(?:basic|digest|negotiate|ntlm|token))\s+[A-Za-z0-9._~+\/=-]{6,}/gi, '$1 [REDACTED]'],
    // a password in a URL: scheme://user:password@host
    [/((?<![a-z0-9+.-])[a-z][a-z0-9+.-]{0,20}:\/\/[^\s:@\/?#"'<>]{1,200}:)[^\s@\/?#"'<>]{1,500}(@)/gi, '$1[REDACTED]$2'],
    // a JSON Web Token: three base64url parts; the first one starts with eyJ (the start of a JSON header in base64)
    [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, '[REDACTED]'],
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
