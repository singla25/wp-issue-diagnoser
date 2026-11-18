// Last line of defence before anything is written to a report: mask things that look like credentials.
// BEST EFFORT AND PATTERN BASED: it masks the forms listed in docs/SAFETY.md section 6 and nothing else. It never proves that a text holds no secret.
//
// How a rule works: NAME, then a separator (=, :, =>, or URL-encoded %3D, also double-encoded), then a VALUE. The name and the separator stay,
// "[REDACTED]" takes the value. A VALUE is either a quoted string (up to the closing quote) or a RUN: the characters up to the first
// whitespace, quote, & (also %26, %2526 and &amp;), ; , < > or closing bracket. The whole run is masked, dots included, so no tail is left
// behind. Only the full stops that end a sentence and a trailing :line:column stay outside the mask.
const R = '[REDACTED]';
const AMP = '%(?:25)*26';                                   // an encoded & (also double encoded); a plain & and &amp; stop a run through the character class
const EQ = '(?:=>|[:=]|%(?:25)*3[dD])';                      // =>  :  =  %3D  %253D
const STOP = '\\s"\'`&;,<>)\\]}';                            // a run ends at any of these (the backtick keeps a closing Markdown backtick)

// builds a rule. names: regex source of the names; lb: what must not stand right before the name; stop: extra run terminators; accept(value, ctx) -> true to mask
function rule(names, { lb = '(?<![A-Za-z_$])', stop = AMP, sep = EQ, accept = () => true } = {}) {
    // value = a quoted string that closes on the same line, or a run (an opening quote that never closes is skipped and the run after it is masked)
    const re = new RegExp(`(${lb}(?:${names})\\b(?:\\\\?["'\`])?\\]?\\s*${sep}\\s*)(?:(\\\\?["'\`])((?:(?!\\2)(?:\\\\.|[^\\\\\\r\\n]))+)\\2|(?:\\\\?["'\`])?(?!=)((?:(?!${stop})[^${STOP}])+))`, 'gi');
    return [re, (m, pre, q, quoted, run, offset, whole) => {
        const raw = q ? quoted : run;
        if (raw.includes('[REDACTED') || /^\*+$/.test(raw)) return m;   // already masked, or a run of * (a placeholder): masking twice changes nothing
        // the whole run is masked, so no tail is left. Two things stay outside: ONE full stop that ends a sentence, and a :line:column that ends a stack-trace address
        let tail = '';
        if (!q) { const st = /:\d{1,7}:\d{1,7}$/.exec(raw); if (st && st.index >= 6) tail = st[0]; else if (raw.length > 1 && raw.endsWith('.')) tail = '.'; }
        // code context: the name sits behind a $ (a PHP variable) or the separator has spaces around it (x = y, x: y). Only there is a value that looks like code skipped; name=value and any quoted value are always masked
        const php = offset > 0 && (whole[offset - 1] === '$' || whole.slice(Math.max(0, offset - 2), offset) === '->' || /\[["']$/.test(whole.slice(Math.max(0, offset - 2), offset))),   // a PHP variable: $name, $obj->name, $arr["name"]
         spaced = /\s$/.test(pre);
        const usingPhrase = !q && offset >= 7 && whole.slice(offset - 7, offset) === '(using ' && /^password: (?:YES|NO)$/.test(m) && whole[offset + m.length] === ')';   // the exact text of the standard database error: "(using password: YES)" / "(using password: NO)"
        const ctx = { pre, quoted: !!q, usingPhrase, before: offset > 0 ? whole[offset - 1] : '', php, spaced, callAfter: !q && php && /^[A-Za-z_]+$/.test(raw) && /^\s*\(/.test(whole.substr(offset + m.length, 40)) };
        if (tail && !accept(raw.slice(0, -tail.length), ctx)) tail = '';   // the part before the tail does not qualify (too short ...): judge and mask the whole run
        if (!accept(tail ? raw.slice(0, -tail.length) : raw, ctx)) return m;
        return q ? `${pre}${q}${R}${q}` : m.slice(0, m.length - raw.length) + R + tail;
    }];
}
const CODE = /^(?:process|this|self|window|document|config|settings|options|env|req|request|args|params|state|props|getenv|get_option|os)(?:[.:>(\[]|$)/i;   // a reference to a value in code, not a value
const isCall = v => /^!*[A-Za-z_$\\][\w$\\.:>-]*\(/.test(v) || /^\((?:string|int|integer|bool|boolean|float|double|array|object)\)?$/i.test(v);                                    // wp_hash_password(x), getToken(, $this->get(
const WORDS = /^(?:null|undefined|true|false|none|empty)$/i;
const PLACEHOLDER = /^(?:%[sdu]\b|\?$)/;                                                  // SQL placeholders
const PHPVAR = /^(?:\$[A-Za-z_]\w*(?:->?|::|\[|\(|\.|$))/;   // $var, $this->x (the run stops at >), $_GET[; a hash like $P$B... or $2y$10$... is not a variable
const CONSTANT = /^(?:[A-Za-z_]\w*::)?[A-Z][A-Z_]{5,}$|^[A-Za-z_]\w*::[A-Za-z_]\w+$/;   // PASSWORD_DEFAULT, COOKIEHASH, self::SECRET_KEY: a constant, not a value
// a value that is really code: always for null/true words, SQL placeholders and a function call; a variable, a constant or a reference like process.env.X only in a code context (c.php or c.spaced), and never for a quoted value
const codeLike = (v, c = {}) => PLACEHOLDER.test(v) || (!c.quoted && (isCall(v) || ((c.php || c.spaced) && (WORDS.test(v) || CODE.test(v) || PHPVAR.test(v))) || (c.php && CONSTANT.test(v))));
// a nonce starts the run: hex (6 or more), or letters and digits with a digit (8 or more), then the run ends or goes on with a character that is not part of a name (wpApiSettings.nonce is a name)
const nonceLike = v => { const m = /^([A-Za-z0-9]+)(?:[^A-Za-z0-9_.(]|$)/.exec(v); return !!m && (/^[0-9a-f]{6,}$/i.test(m[1]) || /^(?=[A-Za-z0-9]*\d)[A-Za-z0-9]{8,}$/.test(m[1])); };

const PATTERNS = [
    [/\b(bearer)\s+[A-Za-z0-9._~+\/=-]{12,}/gi, '$1 [REDACTED]'],
    // WordPress login cookies (wordpress_logged_in_<hash>, wordpress_sec_<hash>, wordpress_<hash>) in ANY position of a Cookie / Set-Cookie line, quoted or not
    rule('wordpress_(?:(?:logged_in|sec)_[0-9a-f]+|[0-9a-f]{20,})', { lb: '(?<![A-Za-z0-9_])', sep: '(?:=|%(?:25)*3[dD])', stop: `${AMP}|%(?:25)*3[bB]` }),
    // session ids and cookies by name (6 characters or more: `session=1` and `cookie: yes` are normal text)
    rule('session(?:id)?|cookie', { lb: '(?<![A-Za-z_])', accept: (v, c) => v.length >= 6 && !c.callAfter && !codeLike(v, c) }),
    [/\b(define\s*\(\s*['"](?:DB_PASSWORD|AUTH_KEY|SECURE_AUTH_KEY|LOGGED_IN_KEY|NONCE_KEY|AUTH_SALT|SECURE_AUTH_SALT|LOGGED_IN_SALT|NONCE_SALT)['"]\s*,\s*)(['"]).*?\2/g, '$1$2[REDACTED]$2'],
    // WordPress recovery mode (the "technical issue" e-mail link): rm_token and rm_key, in a query, plain text, JSON or URL-encoded, any case
    rule('rm_(?:token|key)', { lb: '(?<![A-Za-z])' }),
    // WordPress nonces by every common name: _wpnonce, _ajax_nonce, X-WP-Nonce, security, nonce and any <name>_nonce / <name>-nonce; only a value that looks like a nonce (hex, or letters and digits with a digit)
    rule('_wpnonce\\w*|_ajax_nonce|x-wp-nonce|security|nonce|(?:[A-Za-z0-9]{1,20}[_-]){1,5}nonce', { lb: '(?<![A-Za-z$])', accept: nonceLike }),
    // every name that says "secret": password, passwd, passphrase, pass, pass1, pass2, pwd, secret, token, api key, auth key, private key, also with words before it or after it
    // (DB_PASSWORD, MYSQL_ROOT_PASSWORD, access_token, client_secret, SECRET_KEY_BASE, AWS_SECRET_ACCESS_KEY, user_pass). ANY non-empty value is masked, even a short one (`password=admin`),
    // except the placeholders [REDACTED] and a run of *, and code in a code context (see codeLike). "pwd: /path" is the shell command pwd.
    rule(`(?:pass(?:w(?:or)?d|phrase|[12])?|pwd|secret|token|api[_-]?key|auth[_-]?key|private[_-]?key)(?:_(?:access_key|key|base|value|phrase)){0,3}`, { lb: '(?:(?<![A-Za-z])|(?<=%3[fF]))',   // not after a letter: a word before the name (DB_, MYSQL_ROOT_, any length) is fine, `compass` and `bypass` are not
        accept: (v, c) => !c.usingPhrase && !c.callAfter && !codeLike(v, c) && !(!c.quoted && /^pass\s*:\s*$/i.test(c.pre) && !/[A-Za-z0-9_-]/.test(c.before)) && !(!c.quoted && /^(?:[A-Za-z0-9]+[_-])*pwd\b/i.test(c.pre.replace(/^[^A-Za-z]*/, '')) && /(?::|=>)\s*$/.test(c.pre) && /^[\/~.]/.test(v)) }),
    // the PHP server variable PHP_AUTH_PW (any value)
    rule('php_auth_pw', { lb: '(?<![A-Za-z$])', accept: (v, c) => !codeLike(v, c) }),
    // a key parameter in a URL query (the password-reset link has ?key=...&login=...): only right after ? or & (plain, encoded, double encoded or &amp;)
    [new RegExp(`((?:\\?|&|&amp;|%(?:25)*(?:3[fF]|26))(?:key|access_key|secret_key)(?:=|%(?:25)*3[dD]))(?:(?!${AMP})[^${STOP}])+`, 'gi'), (m, pre) => m.slice(pre.length).startsWith('[REDACTED') ? m : `${pre}${R}`],
    // Authorization headers with a scheme (Bearer is masked at the top), also the PHP dump and server-variable forms; a header without a scheme is plain text
    [/((?<![A-Za-z_])(?:http_)?authorization["']?\]?\s*(?:=>|[:=]|%(?:25)*3[dD])\s*["']?(?:basic|digest|negotiate|ntlm|token|bearer))\s+(?!\[REDACTED)[A-Za-z0-9._~+\/=-]{6,}/gi, '$1 [REDACTED]'],
    rule('(?:redirect_)?http_authorization', { lb: '(?<![A-Za-z$])', accept: (v, c) => !/^(?:basic|digest|negotiate|ntlm|token|bearer)$/i.test(v) && !codeLike(v, c) }),
    // a password in a URL: scheme://user:password@host
    [/((?<![a-z0-9+.-])[a-z][a-z0-9+.-]{0,20}:\/\/[^\s:@\/?#"'<>]{0,200}:)(?!\[REDACTED)[^\s@\/?#"'<>]{1,500}(@)/gi, '$1[REDACTED]$2'],
    // a JSON Web Token: three base64url parts (the first one starts with eyJ, the start of a JSON header in base64), a signature may carry = padding
    [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}(?:={1,2})?/g, '[REDACTED]'],
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
