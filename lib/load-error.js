// The probe's own page load can fail before any page answers (a certificate error, a refused connection, a timeout, a loop). The raw error text is saved in
// work/probe.json (it holds the site address). The REPORT gets one fixed plain phrase for the error, never the raw text, never the address.
// classify(text) -> { id, phrase } or null. null = not recognised: the caller keeps its old generic wording ("no page result could be used").
// "date error" only: the tool does not know why the date is wrong, so it never says "expired".
const TABLE = [   // the first match wins; the order goes from the most specific code to the general ones
    ['cert-date', /ERR_CERT_DATE_INVALID/i, 'certificate date error'],
    ['host-name', /ERR_CERT_COMMON_NAME_INVALID|ERR_NAME_NOT_RESOLVED|ENOTFOUND|EAI_AGAIN/i, 'wrong host name'],
    ['cert-other', /ERR_CERT_[A-Z_]+|ERR_BAD_SSL_CLIENT_AUTH_CERT/i, 'other certificate error'],
    ['ssl', /ERR_SSL_[A-Z_]+|SSL_ERROR_[A-Z_]+/i, 'secure connection (SSL) error'],
    ['refused', /ERR_CONNECTION_REFUSED|ECONNREFUSED/i, 'connection refused'],
    ['timeout', /ERR_TIMED_OUT|ERR_CONNECTION_TIMED_OUT|ETIMEDOUT|Timeout \d+\s*ms exceeded/i, 'timeout'],
    ['redirects', /ERR_TOO_MANY_REDIRECTS/i, 'too many redirects'],
    ['reset', /ERR_CONNECTION_(?:RESET|CLOSED|ABORTED)|ERR_EMPTY_RESPONSE|ECONNRESET|socket hang up/i, 'connection reset']
];
// the sentence that must follow a load-error reason: one load, one computer, one time (never "visitors have the same problem")
const ONE_LOAD = 'This was one load, from one computer, at one time. It does not show what other visitors see.';
const REASON_HEAD = 'the tool\'s own page load failed: ';
function classify(text) {
    // only the error code part is read: the saved text ends with " at <address>", and an address may hold anything (a path with ETIMEDOUT in it)
    const s = String(text == null ? '' : text).replace(/\s+at\s+\S*$/i, '');
    for (const [id, re, phrase] of TABLE) if (re.test(s)) return { id, phrase };
    return null;
}
// the first page (in the order of the probe) whose saved error is recognised
function classifyPages(pages) {
    for (const p of Array.isArray(pages) ? pages : []) { const c = p && typeof p.error === 'string' ? classify(p.error) : null; if (c) return c; }
    return null;
}
module.exports = { classify, classifyPages, ONE_LOAD, REASON_HEAD, TABLE };
