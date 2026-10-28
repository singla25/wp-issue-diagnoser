// The reporter's words -> features. Lower-case, tokenise, remove stop words, stem (a small suffix stripper, no library),
// then find the taxonomy phrases (also stemmed) in the token list. Pure functions: same text, same result.

const fs = require('fs');
const path = require('path');

const TAXONOMY_FILE = path.join(__dirname, '..', 'data', 'feature-taxonomy.json');
const STOP = new Set(('a about after again all also am an and any are as at be because been before being but by can could did do does doing done down during each few for from further had has have having he her here hers him his how i if in into is it its just me more most my no nor not now of off on once only or other our out over own same she should so some such than that the their them then there these they this those through to too under until up us very was we were what when where which while who whom why will with would you your yours since update updated updating').split(/\s+/));

// not a linguistic stemmer: it only has to give "sliders"/"slider", "checking out"/"check out" the same stem, deterministically
function stem(w) {
    let s = w;
    if (s.length > 4 && s.endsWith('ies')) s = s.slice(0, -3) + 'y';
    else if (s.length > 4 && s.endsWith('sses')) s = s.slice(0, -2);
    else if (s.length > 3 && s.endsWith('s') && !/(ss|us|is)$/.test(s)) s = s.slice(0, -1);
    for (const suf of ['ing', 'ed', 'ly']) if (s.length > suf.length + 3 && s.endsWith(suf)) { s = s.slice(0, -suf.length); break; }
    return s;
}
const words = text => String(text).toLowerCase().normalize('NFKD').replace(/[^a-z0-9\s'-]+/g, ' ').split(/\s+/).map(w => w.replace(/^[-']+|[-']+$/g, '')).filter(Boolean);
const tokenise = text => words(text).filter(w => !STOP.has(w)).map(stem);

function loadTaxonomy(file = TAXONOMY_FILE) {
    const t = JSON.parse(fs.readFileSync(file, 'utf8'));
    return t.entries.map(e => ({ ...e, stemmed: e.phrases.map(p => ({ phrase: p, tokens: words(p).map(stem) })) }));
}

const contains = (hay, needle) => { // needle appears as a contiguous run of tokens in hay
    if (!needle.length) return false;
    outer: for (let i = 0; i + needle.length <= hay.length; i++) { for (let j = 0; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer; return true; }
    return false;
};

// -> { tokens, features: [{id, label, matched, signals, verified}], terms: [tokens that matched no feature], dates: [], mentions: [] }
function analyse(text, taxonomy = loadTaxonomy()) {
    const all = words(text).map(stem);          // stop words kept: "check out" must still match as two tokens
    const tokens = tokenise(text);
    const features = [];
    const used = new Set();
    for (const e of taxonomy) {
        const hit = e.stemmed.find(p => contains(all, p.tokens));
        if (hit) { features.push({ id: e.id, label: e.label, matched: hit.phrase, signals: e.signals, verified: !!e.verified }); hit.tokens.forEach(t => used.add(t)); }
    }
    features.sort((a, b) => a.id.localeCompare(b.id));
    return {
        tokens, features,
        terms: [...new Set(tokens.filter(t => !used.has(t) && t.length > 2 && !/^\d/.test(t)))].sort(),
        dates: [...new Set(String(text).match(/\b20\d{2}-\d{2}-\d{2}\b/g) || [])].sort(),
        slugs: [...new Set((String(text).match(/\b[a-z0-9]+(?:-[a-z0-9]+){1,4}\b/g) || []).filter(s => /plugin|woo|elementor|form|cache|seo|slider|rocket|pro$/.test(s)))].sort()
    };
}

module.exports = { analyse, tokenise, stem, words, loadTaxonomy, STOP };
