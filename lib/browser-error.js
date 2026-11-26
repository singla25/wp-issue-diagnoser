// A browser error page that the reporter wrote down or showed in a screenshot ("NET::ERR_CERT_DATE_INVALID", "Your connection is not private") is a CLUE, never a cause.
// Each rule maps to ONE fixed label. The reader never sees the raw words, so OCR damage cannot reach the report and nothing typed by the reporter is repeated.
// The text is first made tolerant to OCR damage: lower case, runs of spaces, underscores, dots and dashes become ONE underscore, runs of colons become one colon, so
// "NET:ERR_CERT_DATE INVALID" (one colon, a space for an underscore) and "net::err cert date invalid" read the same as the clean form.
// Wording rule: always "possible, not confirmed" (see BROWSER_ERROR_NOTE). A date error is never called "expired": the tool only knows what the browser said.
// A hyphen is KEPT (an OCR dash can stand for an underscore inside a code, so the code rules accept [_-]); the plain phrases accept spaces only, so a plugin folder such
// like "fix-too-many-redirects" is not a match (a folder written with underscores still can match: a known limit). Every rule starts at a word boundary B0, so "concert expired" or "xerr_cert" never match.
const norm = text => String(text == null ? '' : text).toLowerCase().replace(/[\s_.]+/g, '_').replace(/:+/g, ':');
const B0 = '(?:^|[^a-z])';
const RULES = [   // [id, test on the normalised text, the fixed label]; the first matching rule per family wins; every id is reported at most once
    ['cert-date', new RegExp(`${B0}(?:err[_-]?cert[_-]?date|certificate_(?:has_)?expired|certificate_is_not_yet_valid)`), 'a certificate date error'],
    ['cert-other', new RegExp(`${B0}(?:err[_-]?cert[_-](?!date)[a-z_-]{3,}|err[_-]?bad[_-]?ssl[_-]?client[_-]?auth[_-]?cert)`), 'a certificate error'],
    ['not-private', new RegExp(`${B0}(?:your_connection_is(?:_not|n['\u2019]?t)_private|connection_is_not_private)`), 'the browser page "your connection is not private"'],
    ['redirects', new RegExp(`${B0}(?:err[_-]?too[_-]?many[_-]?redirects|redirected_you_too_many_times|too_many_redirects)`), 'a "too many redirects" error'],
    ['ssl', new RegExp(`${B0}(?:err[_-]?ssl[_-]?protocol[_-]?error|ssl_protocol_error|(?:this_site_)?can[^a-z_]?_?t_provide_a_secure_connection|cannot_provide_a_secure_connection)`), 'an SSL protocol error']
];
const BROWSER_ERROR_NOTE = 'Possible, not confirmed: this is a clue, not a cause.';
// -> [{ id, label }] in table order; nothing else leaves this function
function find(text) {
    const n = norm(text), out = [];
    for (const [id, re, label] of RULES) if (re.test(n)) out.push({ id, label });
    return out;
}
// the families of the table above that are about a certificate or a secure connection (the browser's certificate warning page included): a cache or an old answer is not the
// reason for these, so the cache clue, Case B (issue/cache-clues.js) leaves them out
const CERTIFICATE_OR_SSL = new Set(['cert-date', 'cert-other', 'not-private', 'ssl']);
module.exports = { find, norm, RULES, BROWSER_ERROR_NOTE, CERTIFICATE_OR_SSL };
