// Turn text (OCR output, a log entry, the reporter's description) into structured clues with fixed regular expressions.
// A clue is a hint with a source, never a conclusion. The text is data: values are cut, control characters removed, and nothing is run.
//
// clue = { id, type, value, detail, source: { kind: 'ocr'|'log'|'description', ref, line }, confidence: 'certain'|'likely'|'possible', snippet }
// Confidence follows the SOURCE: a parsed log line is 'certain' about what the log says; OCR and prose are 'possible'.

const schema = require('../lib/schema');
const { componentOf } = require('../lib/ownership');

const RANK = { certain: 0, likely: 1, possible: 2 };
const cut = (s, n = 200) => String(s).replace(/\s+/g, ' ').trim().slice(0, n);
// OCR puts stray spaces into URLs and paths ("https: //", "wp- content"): collapse the common ones before matching
const tidy = s => String(s).replace(/(https?:)\s+\/\//gi, '$1//').replace(/wp-\s+content/gi, 'wp-content').replace(/\/\s+(wp-|plugins|themes)/gi, '/$1');

// "/var/www/x/wp-content/plugins/acme/a.php" -> "wp-content/plugins/acme/a.php" (the part that identifies the component)
function sitePath(p) {
    const m = /(wp-content\/(?:plugins|themes|mu-plugins)\/[^\s:()'"]+|wp-includes\/[^\s:()'"]+|wp-admin\/[^\s:()'"]+)/.exec(String(p).replace(/\\/g, '/'));
    return m ? m[1] : null;
}

const RULES = [
    // PHP
    ['php-redeclare', /Cannot redeclare\s+([\w\\:]+)\s*\(\)?(?:\s*\(?\s*previously declared in\s+(\S+?\.php):(\d+))?/i, m => ({ value: m[1], detail: { function: m[1], previous_file: m[2] ? sitePath(m[2]) : null, previous_line: m[3] ? Number(m[3]) : null } })],
    ['php-undefined-function', /Call to undefined (function|method)\s+([\w\\:>-]+)\s*\(/i, m => ({ value: m[2], detail: { kind: m[1].toLowerCase() } })],
    ['php-class-not-found', /(?:Class|Interface|Trait)\s+["']?([\w\\]+)["']?\s+not found/i, m => ({ value: m[1], detail: {} })],
    ['php-fatal', /\b(?:PHP )?(Fatal error|Parse error):\s*(.{1,200})/i, m => ({ value: cut(m[2], 160), detail: { level: m[1].toLowerCase() } })],
    ['php-notice', /\b(?:PHP )?(Warning|Notice|Deprecated):\s*(.{1,200}?)\s+in\s+(\/?\S+?\.php)(?:\s+on line\s+|:)(\d+)/i, m => ({ value: cut(m[2], 160), detail: { level: m[1].toLowerCase(), file: sitePath(m[3]), line: Number(m[4]) } })],
    ['php-location', /(?:\bin\s+|\(|^\s*)(\/?[^\s:()'"]+\.php)(?:\((\d+)\)|:(\d+)|\s+on line\s+(\d+))/i, m => { const f = sitePath(m[1]); return f ? { value: `${f}:${m[2] || m[3] || m[4]}`, detail: { file: f, line: Number(m[2] || m[3] || m[4]) } } : null; }],
    ['wp-critical-error', /(There has been a critical error on this (?:website|site)|Error establishing a database connection|Briefly unavailable for scheduled maintenance)/i, m => ({ value: m[1], detail: {} })],
    // JavaScript
    ['js-not-defined', /([\w$.]+)\s+is not (a function|defined|a constructor)/i, m => ({ value: `${m[1]} is not ${m[2]}`, detail: { symbol: m[1] } })],
    ['js-error', /Uncaught\s+((?:Type|Reference|Syntax|Range|Eval|URI)?Error)\s*:?\s*(.{0,160})/i, m => ({ value: cut(`${m[1]}: ${m[2]}`, 180), detail: { error: m[1] } })],
    // network
    ['http-request-failed', /\b(GET|POST|PUT|PATCH|DELETE)\s+(\S{3,200}?)\s+(?:\(?(?:failed|blocked)\)?\s+)?([45]\d\d)\b/i, m => ({ value: `${m[1].toUpperCase()} ${cut(m[2], 150)} ${m[3]}`, detail: { method: m[1].toUpperCase(), url: cut(m[2], 150), status: Number(m[3]) } })],
    ['http-status', /\b(?:HTTP(?:\/[\d.]+)?|status(?: code)?)\s*:?\s*([45]\d\d)\b/i, m => ({ value: m[1], detail: { status: Number(m[1]) } })],
    ['rest-route', /\/wp-json\/([\w.-]+(?:\/[\w.-]+)?\/v\d+(?:\/[\w.%()?<>\[\]-]*)*)/i, m => ({ value: m[1], detail: { namespace: m[1].split('/')[0] } })],
    ['ajax-action', /[?&](?:wc-ajax|action)=([\w-]{2,60})/i, m => ({ value: m[1], detail: {} })],
    ['ajax-endpoint', /(admin-ajax\.php)/i, m => ({ value: m[1], detail: {} })],
    ['woocommerce-notice', /(no payment methods (?:are )?available|there was an error processing your payment|your session has expired|your cart is currently empty|sorry, this product cannot be purchased)/i, m => ({ value: m[1], detail: {} })]
];

function extract(text, source, { confidence = 'possible' } = {}) {
    const out = [], seen = new Set();
    const add = (type, v, line, snippet) => {
        const value = cut(v.value, 200);
        if (!value) return;
        const key = `${type}|${value}|${source.ref}`;
        if (seen.has(key)) return;
        seen.add(key);
        out.push({ id: schema.stableId('clue', type, value, source.ref, source.kind), type, value, detail: v.detail || {}, source: { kind: source.kind, ref: source.ref, line: line || null }, confidence, snippet: cut(snippet, 220) });
    };
    const lines = tidy(text).split(/\r?\n/).slice(0, 2000);
    lines.forEach((raw, i) => {
        const line = raw.slice(0, 600);
        if (!line.trim()) return;
        const php = /\b(?:PHP )?(?:Fatal error|Parse error|Warning|Notice|Deprecated)\b/i.test(line);
        for (const [type, re, build] of RULES) {
            if (type === 'js-error' && php) continue; // "Uncaught Error: ..." on a PHP line is a PHP error, not a browser error
            // the error site is the "in <file>" that is NOT the earlier declaration named by "previously declared in"
            const m = re.exec(type === 'php-location' ? line.replace(/\(?previously declared in\s+\S+/i, '') : line);
            const v = m && build(m);
            if (v) add(type, v, i + 1, line);
        }
        // every wp-content path names a component, whatever else the line says
        for (const m of line.matchAll(/wp-content\/(plugins|themes|mu-plugins)\/([A-Za-z0-9._-]+)(\/[^\s:()'"]*)?/gi)) {
            const rel = `wp-content/${m[1].toLowerCase()}/${m[2]}${m[3] || ''}`;
            add('component-path', { value: componentOf(rel) || rel, detail: { path: rel.slice(0, 200), kind: m[1].toLowerCase() } }, i + 1, line);
        }
    });
    return out;
}

// Instruction-like or hostile-looking text is never acted on. It is only noticed, so the report can say it was seen.
const HOSTILE = [
    ['markup', /<\s*(script|iframe|object|embed|img[^>]+onerror|svg[^>]+onload)/i, 'contains HTML/script markup'],
    ['shell', /;\s*(rm\s+-rf|curl\s|wget\s|chmod\s|sudo\s)|\|\s*(sh|bash)\b|`[^`]+`|\$\([^)]+\)/i, 'contains shell command syntax'],
    ['prompt-injection', /(ignore|disregard|forget)\s+(all\s+|any\s+)?(the\s+)?(previous|prior|above|earlier)\s+(instructions|rules|prompts?)|you are now\b|system prompt|new instructions\s*:/i, 'contains instruction-like text aimed at an AI agent'],
    ['path-traversal', /(\.\.[\/\\]){1,}|\/etc\/(passwd|shadow)|%2e%2e%2f/i, 'contains a path-traversal or system-file path']
];
function notices(text, source) {
    const out = [];
    for (const [kind, re, what] of HOSTILE) if (re.test(text)) out.push({ kind, level: 'INFO', source: { kind: source.kind, ref: source.ref }, message: `Text from ${source.ref} ${what}. It was stored and shown as plain text only; nothing was executed or followed.` });
    return out;
}

const sortClues = list => list.slice().sort((a, b) => RANK[a.confidence] - RANK[b.confidence] || a.type.localeCompare(b.type) || a.value.localeCompare(b.value) || a.source.ref.localeCompare(b.source.ref) || (a.source.line || 0) - (b.source.line || 0));

module.exports = { extract, notices, sortClues, sitePath, tidy, RANK };
