#!/usr/bin/env node
// Corpus test of lib/redact.js: data in scripts/fixtures/redact-corpus.json (made-up values only; the markers are obviously fake).
//   secrets: every text carries unique marker values; after redact.text() NO marker may appear, and masking twice changes nothing.
//   benign:  every text must come back byte for byte unchanged.
// A failure names the entry, so the corpus is the test of every rule in lib/redact.js. Offline, deterministic.
const fs = require('fs');
const path = require('path');
const redact = require('../lib/redact');

let failures = 0;
const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`); if (!c) failures++; };
const group = t => console.log(`\n== ${t}`);
const corpus = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'redact-corpus.json'), 'utf8'));
const show = s => JSON.stringify(s).slice(0, 150);

group('the corpus itself');
const markers = corpus.secrets.flatMap(s => s.markers);
ok(corpus.secrets.length >= 100 && corpus.benign.length >= 100, `at least 100 secret forms and 100 benign texts (${corpus.secrets.length} and ${corpus.benign.length})`);
ok(new Set(markers).size === markers.length && corpus.secrets.every(s => s.markers.every(m => s.text.includes(m))), 'every marker is unique and appears in its own text');
const cats = [...new Set(corpus.secrets.map(s => s.category))];
ok(['url-param', 'url-encoded', 'nonce', 'header', 'cookie', 'json', 'php-dump', 'wp-config', 'recovery', 'jwt', 'url-creds', 'env', 'yaml', 'shell', 'log', 'misc'].every(c => cats.includes(c)), `all required kinds of secret form are present (${cats.join(', ')})`);

group('every secret form is masked: no marker survives');
for (const s of corpus.secrets) {
    const out = redact.text(s.text);
    const left = s.markers.filter(m => out.includes(m));
    ok(!left.length && out.includes('[REDACTED]') && redact.text(out) === out, `${s.id} ${s.category}: ${left.length ? `still visible ${left.join(', ')} in ${show(out)}` : 'masked, and masking again changes nothing'}`);
}

group('every benign text is unchanged');
corpus.benign.forEach((t, i) => { const out = redact.text(t); ok(out === t, `b${String(i + 1).padStart(3, '0')}: ${out === t ? show(t).slice(0, 70) : `changed ${show(t)} -> ${show(out)}`}`); });

group('structure and speed');
{
    const o = redact.deep({ secrets: corpus.secrets.map(s => s.text), benign: corpus.benign, n: 3 });
    ok(JSON.parse(JSON.stringify(o)).n === 3 && o.secrets.length === corpus.secrets.length && markers.every(m => !JSON.stringify(o).includes(m)), 'deep() keeps the structure and no marker survives');
    const all = corpus.secrets.map(s => s.text).concat(corpus.benign).join('\n');
    const big = all.repeat(Math.ceil(200000 / all.length));
    const t0 = Date.now(); redact.text(big);
    ok(big.length >= 200000 && Date.now() - t0 < 200, `speed: ${big.length} characters of corpus text took ${Date.now() - t0} ms (under 200 ms)`);
}

console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll corpus checks passed');
process.exit(failures ? 1 : 0);
