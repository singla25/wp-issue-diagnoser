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
const want = (e, names) => `Possible, not confirmed: the page loads files of ${names}. What the source says: ${e.causes} ${e.beyond_sources ? `${e.beyond_sources} ` : ''}Source: ${src(e)}. This does not show that it causes the problem you reported. ${OPTS.partial}`;

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
ok(m1[0].includes("That the plugins 'break' each other is not stated") && !m2[0].includes('break') , 'the entry 1 line keeps the entry\'s own "not stated" text, the others have none');
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
const synth = (id, a, b) => ({ ...E('cache-plugin-with-elementor'), id, params: { a: [a], b: [b] }, claims: Object.values((lc.CLAIM_NAME || {})) });   // made-up entries: the partner names are real, claim-backed names
const five = [synth('c1', 'p1', 'litespeed-cache'), synth('c2', 'p2', 'w3-total-cache'), synth('c3', 'p3', 'wp-fastest-cache'), synth('c4', 'p4', 'wp-super-cache'), synth('c5', 'p5', 'wp-optimize')];
const cap = lc.match(['p1', 'litespeed-cache', 'p2', 'w3-total-cache', 'p3', 'wp-fastest-cache', 'p4', 'wp-super-cache', 'p5', 'wp-optimize'], { entries: five, allowed: five.map(e => e.id) });
const capLines = plain.liveConflictLines(cap, OPTS);
ok(cap.conflicts.length === 3 && cap.more === 2 && J(cap.conflicts.map(c => c.id)) === J(['c1', 'c2', 'c3']) && capLines.length === 4 && capLines[3] === 'And 2 more possible conflicts.', 'five matches: three lines in entry id order, then "And 2 more possible conflicts."');
const dup = lc.match(['litespeed-cache', 'wp-rocket']);
ok(dup.conflicts.length === 1 && dup.more === 0, 'two entries match the SAME pair (litespeed-cache and wp-rocket): it prints once');
const dup2 = lc.match(['p1', 'litespeed-cache'], { entries: [synth('c1', 'p1', 'litespeed-cache'), synth('c2', 'p1', 'litespeed-cache')], allowed: ['c1', 'c2'] });
ok(dup2.conflicts.length === 1 && dup2.conflicts[0].id === 'c1', 'the same pair from two entries: the first in id order is kept');

group('text from the data is cleaned, not reworded');
const dirty = { ...E('cache-plugin-with-elementor'), causes: 'A\u001b[31m cause\u0000  with   spaces.', beyond_sources: 'Beyond​ text.' };
const dl = plain.liveConflictLines(lc.match(['elementor', 'litespeed-cache'], { entries: [dirty] }), OPTS)[0];
ok(!/[\u0000-\u001f\u007f​]/.test(dl) && dl.includes('A [31m cause with spaces.') && dl.includes('Beyond text.'), 'control and format characters are removed and spaces collapsed; the words stay');

group('S3c-fix 1: a name matches only if the entry\'s own claims back it');
const ids = r => r.conflicts.map(c => c.id).join();
const e2 = E('cache-plugin-with-elementor');
ok(J(e2.claims.filter(c => ['LiteSpeed Cache', 'WP Rocket', 'W3 Total Cache', 'WP Fastest Cache', 'Autoptimize'].includes(c))) === J(['LiteSpeed Cache', 'WP Rocket']), 'the data: the claims of the Elementor entry name LiteSpeed Cache and WP Rocket, and not W3 Total Cache, WP Fastest Cache or Autoptimize');
ok(ids(lc.match(['elementor', 'litespeed-cache'])) === 'cache-plugin-with-elementor' && ids(lc.match(['elementor', 'wp-rocket'])) === 'cache-plugin-with-elementor', 'elementor + litespeed-cache, and elementor + wp-rocket, match the Elementor entry');
for (const n of ['w3-total-cache', 'autoptimize', 'wp-fastest-cache']) ok(lc.match(['elementor', n]).conflicts.length === 0, `elementor + ${n} does NOT match (no claim behind that name)`);
ok(lc.match(['w3-total-cache', 'autoptimize', 'wp-fastest-cache', 'elementor']).conflicts.every(c => c.id !== 'cache-plugin-with-elementor'), 'elementor with only unbacked names: the Elementor entry never prints');
ok(Object.keys((lc.CLAIM_NAME || {})).every(k => /^[a-z0-9-]+$/.test(k)) && lc.match(['zzz-unknown-cache', 'elementor']).conflicts.length === 0, 'a name that is not in the claim map is never backed (fail closed)');

const brandX = { ...E('cache-plugin-with-elementor'), id: 'brand-x', params: { a: ['aa-sample'], b: ['brand-x-cache'] }, claims: ['Brand X Cache'] };
ok(lc.match(['aa-sample', 'brand-x-cache'], { entries: [brandX], allowed: ['brand-x'] }).conflicts.length === 0 && !('brand-x-cache' in (lc.CLAIM_NAME || {})), 'EXPLICIT table: a slug that is not in the table is never backed, even if an entry\'s claims text contains a matching display name');
const tbl = (lc.CLAIM_NAME || {}); ok(Object.entries(tbl).every(([k, v]) => typeof v === 'string' && v.length > 2) && J(Object.keys(tbl).sort()) === J(['autoptimize', 'breeze', 'fast-velocity-minify', 'litespeed-cache', 'perfmatters', 'w3-total-cache', 'wp-fastest-cache', 'wp-optimize', 'wp-rocket', 'wp-super-cache']), 'the table is an explicit slug -> display name list of 10 names (pinned)');
const BACK = {};
for (const id of lc.ALLOWED) { const e = E(id), list = e.params.b || e.params.slugs; BACK[id] = { backed: list.filter(x => tbl[x] && e.claims.includes(tbl[x])), not: list.filter(x => !(tbl[x] && e.claims.includes(tbl[x]))) }; }
ok(J(BACK['cache-plugin-with-elementor']) === J({ backed: ['litespeed-cache', 'wp-rocket'], not: ['w3-total-cache', 'autoptimize', 'wp-fastest-cache'] }) && J(BACK['multiple-full-page-cache-plugins']) === J({ backed: ['w3-total-cache', 'litespeed-cache', 'wp-fastest-cache'], not: ['wp-rocket'] }) && BACK['wp-rocket-with-incompatible-plugin'].not.length === 0 && BACK['wp-rocket-with-incompatible-plugin'].backed.length === 9, 'which names are backed by each entry\'s claims, pinned: Elementor entry 2 of 5, set entry 3 of 4, WP Rocket entry 9 of 9');

group('S3c-fix 2: pair entries first, a set entry only for names no printed entry covers');
const rl = lc.match(['wp-rocket', 'litespeed-cache']);
ok(ids(rl) === 'wp-rocket-with-incompatible-plugin' && rl.conflicts[0].sources[0].host === 'docs.wp-rocket.me', 'wp-rocket + litespeed-cache prints the WP Rocket page (entry 1), not the Elementor set entry');
const rlLine = plain.liveConflictLines(rl, OPTS)[0];
ok(rlLine.includes('docs.wp-rocket.me') && !rlLine.includes('elementor.com') && /Source: "Optimization plugins not compatible with WP Rocket"/.test(rlLine), 'and the printed line names that source');
const wf = lc.match(['w3-total-cache', 'wp-fastest-cache']);
ok(ids(wf) === 'multiple-full-page-cache-plugins' && plain.liveConflictLines(wf, OPTS)[0].includes('elementor.com'), 'w3-total-cache + wp-fastest-cache: no pair entry covers them, so the Elementor set entry prints');
ok(ids(lc.match(['wp-rocket', 'w3-total-cache', 'wp-fastest-cache'])) === 'wp-rocket-with-incompatible-plugin', 'a set entry whose names are all covered by a printed pair entry is skipped (printed once)');
ok(ids(lc.match(['elementor', 'litespeed-cache', 'wp-rocket', 'w3-total-cache', 'wp-fastest-cache'])).split(',').length <= 3 && new Set(lc.match(['elementor', 'litespeed-cache', 'wp-rocket', 'w3-total-cache', 'wp-fastest-cache']).conflicts.map(c => c.names.slice().sort().join())).size === lc.match(['elementor', 'litespeed-cache', 'wp-rocket', 'w3-total-cache', 'wp-fastest-cache']).conflicts.length, 'several matches: at most 3 lines, never the same set twice');

const hid = lc.match(['wp-rocket', 'autoptimize', 'breeze', 'w3-total-cache', 'wp-fastest-cache', 'litespeed-cache']);
ok(hid.conflicts.length === 2 && hid.conflicts[0].id === 'wp-rocket-with-incompatible-plugin' && hid.conflicts[0].partners_more === 2 && hid.conflicts[1].id === 'multiple-full-page-cache-plugins' && J(hid.conflicts[1].names) === J(['litespeed-cache', 'w3-total-cache', 'wp-fastest-cache']), 'names that are only counted in "and N more" do not cover a lower entry: the set entry still prints and names w3-total-cache and wp-fastest-cache');

group('S3c-fix 1b and 3: the lead-in, and the data text');
const sample = [...lines(['wp-rocket', 'autoptimize', 'breeze', 'litespeed-cache']), ...lines(['elementor', 'litespeed-cache']), ...lines(['w3-total-cache', 'wp-fastest-cache'])];
ok(sample.length === 3 && sample.every(l => l.split(' What the source says: ').length === 2 && /^Possible, not confirmed: the page loads files of [^.]+\. What the source says: /.test(l)), 'every line has the lead-in "What the source says:" once, right after the names');
ok(sample.every((l, i) => l.includes(`What the source says: ${[E('wp-rocket-with-incompatible-plugin'), e2, E('multiple-full-page-cache-plugins')][i].causes}`)), 'and the entry cause text after it is unchanged, word for word');
ok(sample[0].startsWith('Possible, not confirmed: the page loads files of wp-rocket, autoptimize, breeze and litespeed-cache. What the source says: WP Rocket\'s own documentation lists these plugins as not compatible with it:') && sample[0].includes("That the plugins 'break' each other is not stated;") && !/the two plugins/.test(sample[0]), 'entry 1 with 3 partners reads correctly: four names, and "the plugins" (not "the two plugins")');
ok(!/the two plugins/.test(E('wp-rocket-with-incompatible-plugin').beyond_sources) && DATA.filter(e => lc.ALLOWED.includes(e.id)).every(e => !/\bthe (two|both)\b/i.test(`${e.causes} ${e.beyond_sources || ''}`)), 'data: no printed text of the three entries says "the two" or "both"');

console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll live-conflicts checks passed');
process.exit(failures ? 1 : 0);
