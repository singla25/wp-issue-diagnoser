#!/usr/bin/env node
// Self-test of issue/live-conflicts.js (known conflicts matched against a LIST OF PLUGIN NAMES) and the reader sentences (lib/plain-names.js liveConflictLines).
// Offline, pure, made-up plugin lists. Fail closed: only three entry ids of data/known-conflicts.json may match, with a detector that reads nothing but plugin names.
const fs = require('fs');
const path = require('path');
const lc = require('../issue/live-conflicts');
const sig = require('../issue/live-signals');
const kb = require('../issue/kb');
const plain = require('../lib/plain-names');

let failures = 0;
const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`); if (!c) failures++; };
const group = t => console.log(`\n== ${t}`);
const J = JSON.stringify;
const DATA = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'known-conflicts.json'), 'utf8')).entries;
const E = id => DATA.find(e => e.id === id);
const OPTS = { prefix: 'the page loads files of', partial: 'The page shows only plugins that load files on this page, so other plugins may exist that were not seen.' };
const lines = (names, o) => plain.liveConflictLines(lc.match(names, o), OPTS);
const src = e => e.sources.map(x => `"${x.title}" (${new URL(x.url).hostname.replace(/^www\./, '')}), checked ${x.last_checked}`).join(' and ');
// the printed line, built from the entry's own data (the test compares the real output with it, word by word)
const want = (e, names) => `Possible, not confirmed: the page loads files of ${names}. ${e.causes} ${e.beyond_sources ? `${e.beyond_sources} ` : ''}Source: ${src(e)}. This does not show that it causes the problem you reported. ${OPTS.partial}`;

group('the whitelist: three entries, name-only detectors');
ok(J(lc.ALLOWED) === J(['cache-plugin-with-elementor', 'multiple-full-page-cache-plugins', 'wp-rocket-with-incompatible-plugin']) && lc.ALLOWED.every(id => E(id) && lc.NAME_ONLY_DETECTORS.includes(E(id).detector)), 'ALLOWED names exactly the 3 entries, all in the data and all with a name-only detector');
const allNames = [...new Set(DATA.flatMap(e => { const p = e.params || {}; return [...(p.a || []), ...(p.b || []), ...(p.slugs || []), ...(p.cache_slugs || []), 'woocommerce']; }))];
ok(lc.match(allNames).conflicts.every(c => lc.ALLOWED.includes(c.id)) && lc.match(['woocommerce', 'wp-rocket']).conflicts.length === 0 && lc.match(['woocommerce', 'litespeed-cache', 'w3-total-cache']).conflicts.every(c => c.id !== 'page-cache-with-woocommerce'), 'every plugin name that any entry mentions, together: only whitelisted ids match; WooCommerce with a cache plugin does NOT match page-cache-with-woocommerce');
const extra = { id: 'brand-new-entry', title: 't', detector: 'pair-installed', params: { a: ['aa-sample'], b: ['bb-sample'] }, causes: 'x', change: 'y', sources: [{ url: 'https://example.test/x', title: 'x', last_checked: '2026-01-01' }], verified: true };
ok(lc.match(['aa-sample', 'bb-sample'], { entries: [...DATA, extra] }).conflicts.length === 0, 'FAIL CLOSED: a new entry added to the data file later (not in ALLOWED) does not match from a page');
const wrongDet = { ...E('cache-plugin-with-elementor'), detector: 'observation', params: { type: 'x' } };
ok(lc.match(['elementor', 'litespeed-cache'], { entries: [wrongDet] }).conflicts.length === 0, 'an allowed id whose detector is not a name-only detector is ignored');
ok(lc.match(['elementor', 'litespeed-cache'], { entries: [] }).conflicts.length === 0 && lc.match(['elementor', 'litespeed-cache'], { allowed: [] }).conflicts.length === 0, 'no entries, or an empty whitelist: nothing matches');

group('the three entries: the exact printed line, word for word from the entry');
const m1 = lines(['wp-rocket', 'autoptimize']), m2 = lines(['elementor', 'litespeed-cache']), m3 = lines(['w3-total-cache', 'wp-fastest-cache']);
ok(m1.length === 1 && m1[0] === want(E('wp-rocket-with-incompatible-plugin'), 'wp-rocket and autoptimize'), 'entry 1 (WP Rocket with another optimisation plugin): the line is the entry text, its "beyond the source" text and its source');
ok(m2.length === 1 && m2[0] === want(E('cache-plugin-with-elementor'), 'elementor and litespeed-cache'), 'entry 2 (Elementor with a caching plugin): the line is the entry text and its source');
ok(m3.length === 1 && m3[0] === want(E('multiple-full-page-cache-plugins'), 'w3-total-cache and wp-fastest-cache'), 'entry 3 (two full-page cache plugins): the line is the entry text and its source');
ok(m1[0].includes("That the two plugins 'break' each other is not stated") && !m2[0].includes('break') , 'the entry 1 line keeps the entry\'s own "not stated" text, the others have none');
ok([...m1, ...m2, ...m3].every(l => !/\binstalled\b|\bactive\b|\bconfirmed cause\b|both are/i.test(l) && /^Possible, not confirmed: the page loads files of /.test(l) && l.endsWith('other plugins may exist that were not seen.')), 'no line says "installed" or "active"; each starts with "Possible, not confirmed" and ends with the partial-list note');
ok(plain.liveConflictLines(lc.match(['wp-rocket', 'autoptimize']), { prefix: 'a pasted list names', partial: 'Other plugins may exist.' })[0].startsWith('Possible, not confirmed: a pasted list names wp-rocket and autoptimize.'), 'the prefix is passed in (a pasted list can use the matcher too), it is not fixed in the matcher');

group('what does NOT match');
ok(lines(['elementor']).length === 0 && lines(['litespeed-cache']).length === 0 && lines(['wp-rocket']).length === 0 && lines(['w3-total-cache']).length === 0, 'only one of the two: no line');
ok(lines(['elementor', 'woo-sample', 'yoast-sample']).length === 0 && lines([]).length === 0 && lines(null).length === 0 && lines('elementor').length === 0, 'unrelated plugins, an empty list, null, a text: no line');
ok(lines([null, 5, {}, '..', 'a b', 'www.x', 'elementor.com', 'x'.repeat(80)]).length === 0 && lc.match(Array.from({ length: 500 }, (_, i) => `n${i}-sample`)).conflicts.length === 0, 'bad names and a list of 500 names: no line, no error');
ok(lc.match(['elementor', 'litespeed-cache']).conflicts[0].names.join() === 'elementor,litespeed-cache' && J(lc.match(['elementor', 'litespeed-cache'])).indexOf('version') === -1, 'the match uses names only: no version anywhere in the result');

group('names beyond the five shown, many partners, several matches, no double print');
const pages = [{ url: 'http://127.0.0.1:8080/', loaded: true, assets: [...Array.from({ length: 7 }, (_, i) => `a${i}-sample`), 'elementor', 'litespeed-cache'].map(n => ({ url: `http://127.0.0.1:8080/wp-content/plugins/${n}/x.js?ver=1.${n.length}`, status: 200 })) }];
const col = sig.collect(pages);
ok(col.plugins.length === 5 && col.plugins_more === 4 && col.plugin_names.length === 9 && !col.plugins.some(p => p.slug === 'elementor') && lc.match(col.plugin_names).conflicts[0].id === 'cache-plugin-with-elementor', 'the pair is the 8th and 9th plugin: not in the 5 shown, but found, because the match gets the full name list');
ok(sig.collect([{ url: 'http://127.0.0.1:8080/', loaded: true, assets: Array.from({ length: 300 }, (_, i) => ({ url: `http://127.0.0.1:8080/wp-content/plugins/p${String(i).padStart(3, '0')}-sample/x.js`, status: 200 })) }]).plugin_names.length === 100, 'the full name list is bounded: at most 100 valid names');
const many = lc.match(['wp-rocket', 'autoptimize', 'breeze', 'fast-velocity-minify', 'litespeed-cache', 'perfmatters', 'w3-total-cache']).conflicts.find(c => c.id === 'wp-rocket-with-incompatible-plugin');
ok(many && many.names.length === 4 && many.names[0] === 'wp-rocket' && many.partners_more === 3, 'a main plugin with many partners: the main plugin, up to 3 partners, then "and N more"');
ok(/files of wp-rocket, autoptimize, breeze, fast-velocity-minify and 3 more\./.test(plain.liveConflictLines({ conflicts: [many], more: 0 }, OPTS)[0]), 'and the sentence says "and 3 more"');
const synth = (id, a, b) => ({ ...E('cache-plugin-with-elementor'), id, params: { a: [a], b: [b] } });
const five = [synth('c1', 'p1', 'q1'), synth('c2', 'p2', 'q2'), synth('c3', 'p3', 'q3'), synth('c4', 'p4', 'q4'), synth('c5', 'p5', 'q5')];
const cap = lc.match(['p1', 'q1', 'p2', 'q2', 'p3', 'q3', 'p4', 'q4', 'p5', 'q5'], { entries: five, allowed: five.map(e => e.id) });
const capLines = plain.liveConflictLines(cap, OPTS);
ok(cap.conflicts.length === 3 && cap.more === 2 && J(cap.conflicts.map(c => c.id)) === J(['c1', 'c2', 'c3']) && capLines.length === 4 && capLines[3] === 'And 2 more possible conflicts.', 'five matches: three lines in entry id order, then "And 2 more possible conflicts."');
const dup = lc.match(['litespeed-cache', 'wp-rocket']);
ok(dup.conflicts.length === 1 && dup.more === 0, 'two entries match the SAME pair (litespeed-cache and wp-rocket): it prints once');
const dup2 = lc.match(['p1', 'q1'], { entries: [synth('c1', 'p1', 'q1'), synth('c2', 'p1', 'q1')], allowed: ['c1', 'c2'] });
ok(dup2.conflicts.length === 1 && dup2.conflicts[0].id === 'c1', 'the same pair from two entries: the first in id order is kept');

group('text from the data is cleaned, not reworded');
const dirty = { ...E('cache-plugin-with-elementor'), causes: 'A\u001b[31m cause\u0000  with   spaces.', beyond_sources: 'Beyond​ text.' };
const dl = plain.liveConflictLines(lc.match(['elementor', 'litespeed-cache'], { entries: [dirty] }), OPTS)[0];
ok(!/[\u0000-\u001f\u007f​]/.test(dl) && dl.includes('A [31m cause with spaces.') && dl.includes('Beyond text.'), 'control and format characters are removed and spaces collapsed; the words stay');

console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll live-conflicts checks passed');
process.exit(failures ? 1 : 0);
