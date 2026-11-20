#!/usr/bin/env node
// Self-test of issue/live-signals.js and the reader sentences (lib/plain-names.js liveSignalsLines): plugin, theme and WordPress names and versions that are read from what the
// live probe ALREADY loaded (script and style addresses, the generator tag, a short fixed list of page comments). Offline, pure, made-up sample pages only. No request is made here.
// The fixed comment list is pinned by one sample text per entry: the samples are the texts those plugins print, written down from the plugins' documented output, NOT checked against a live site.
const redact = require('../lib/redact');
const sig = require('../issue/live-signals');
const plain = require('../lib/plain-names');

let failures = 0;
const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`); if (!c) failures++; };
const group = t => console.log(`\n== ${t}`);
const J = JSON.stringify;

const H = 'http://127.0.0.1:8080';
const page = (assets = [], extra = {}) => ({ url: `${H}/`, viewport: { name: 'laptop', width: 1280, height: 800 }, loaded: true, status: 200, assets: assets.map(u => (typeof u === 'string' ? { url: u, status: 200, type: 'script' } : u)), ...extra });

group('the fixed comment list: one sample per entry');
const SAMPLES = [
    ['wordpress-seo', ' This site is optimized with the Yoast SEO plugin v22.0 - https://yoast.com/wordpress/plugins/seo/ ', '22.0'],
    ['wordpress-seo-premium', ' This site is optimized with the Yoast SEO Premium plugin v22.0 (Yoast SEO v22.0) - https://yoast.com/wordpress/plugins/seo/ ', '22.0'],
    ['all-in-one-seo-pack', ' All in One SEO 4.5.5 - aioseo.com ', '4.5.5'],
    ['wp-rocket', " This website is like a Rocket, isn't it? Performance optimized by WP Rocket. Learn more: https://wp-rocket.me ", null],
    ['w3-total-cache', ' Performance optimized by W3 Total Cache. Learn more: https://www.boldgrid.com/w3-total-cache/ ', null],
    ['litespeed-cache', ' Page optimized by LiteSpeed Cache @2023-11-01 12:00:00 ', null]
];
ok(sig.COMMENTS.length === SAMPLES.length && sig.COMMENTS.length <= 8, `the list is short (${sig.COMMENTS.length} entries) and every entry has a sample`);
for (const [slug, text, ver] of SAMPLES) {
    const r = sig.fromPage({ generators: [], comments: [text] });
    ok(r.comments.length === 1 && r.comments[0].slug === slug && r.comments[0].version === ver, `${slug}: the sample comment gives the name${ver ? ` and the version ${ver}` : ' and no version'}`);
}
ok(sig.fromPage({ generators: [], comments: [' just a note for the next developer ', ' <!-- nested --> ', ' Yoast SEO is great ', ' All in One SEO without the address '] }).comments.length === 0, 'comments that look a little alike but are not on the list give nothing');
ok(!J(sig.fromPage({ generators: [], comments: [SAMPLES[0][1] + ' SECRETSAMPLE0001 '] })).includes('SECRETSAMPLE'), 'the text of a comment is thrown away: only the name and the version are kept');
const tooLong = sig.fromPage({ generators: [], comments: [' This site is optimized with the Yoast SEO plugin v' + '1'.repeat(40) + ' - x '] });
ok(tooLong.comments.length === 0 || tooLong.comments[0].version === null, 'a version longer than 20 characters from a comment is dropped');
ok(sig.fromPage({ generators: [], comments: Array.from({ length: 400 }, (_, i) => (i === 399 ? SAMPLES[3][1] : ' filler ')) }).comments.length === 0, 'at most 100 comments are scanned (a hit after the 100th is not read)');

group('the generator tag');
ok(sig.fromPage({ generators: ['WordPress 6.4.2'], comments: [] }).wordpress === '6.4.2', 'WordPress 6.4.2 -> 6.4.2');
ok(sig.fromPage({ generators: ['Elementor 3.18.2', 'WordPress 6.5-beta1'], comments: [] }).wordpress === '6.5-beta1', 'the WordPress tag is picked among several generator tags');
for (const bad of ['WordPress 6.4.2<script>alert(1)</script>', 'WordPress ', 'Joomla 4.0', 'WordPress ' + '9'.repeat(30), 'WordPress 6.4.2; drop table', 'wordpress.org 6.4']) ok(sig.fromPage({ generators: [bad], comments: [] }).wordpress === null, `a generator text that is not a plain WordPress version is dropped: ${bad.slice(0, 40)}`);
ok(sig.fromPage(null).wordpress === null && sig.fromPage('x').comments.length === 0 && sig.fromPage({}).comments.length === 0, 'odd input gives an empty result');

group('script and style addresses (rec.assets)');
const A = u => sig.assetPart(u);
ok(J(A(`${H}/wp-content/plugins/woo-sample/assets/a.css?ver=8.3.1`)) === J({ kind: 'plugin', slug: 'woo-sample', version: '8.3.1' }), 'a plugin file: the folder name and the ver value');
ok(J(A(`${H}/wp-content/themes/twentytwentyfour/style.css?ver=1.2`)) === J({ kind: 'theme', slug: 'twentytwentyfour', version: '1.2' }), 'a theme file: the folder name and the ver value');
ok(A(`${H}/wp-content/plugins/no-ver/x.js`).version === null, 'no ver value: version not shown');
ok(A(`${H}/wp-content/plugins/long-ver/x.js?ver=${'1'.repeat(25)}`).version === null && A(`${H}/wp-content/plugins/long-ver/x.js?ver=${'1'.repeat(25)}`).slug === 'long-ver', 'a version of 25 characters is dropped, the name stays');
for (const v of ['1.0;rm', '1.0<b>', '1 0', '%3Cscript%3E', 'a'.repeat(21)]) ok(A(`${H}/wp-content/plugins/x/y.js?ver=${v}`).version === null, `a ver value with other characters or too long is dropped: ${v.slice(0, 20)}`);
ok(A(`${H}/wp-content/plugins/20%20x/y.js?ver=1`) === null && A(`${H}/wp-content/plugins/../y.js?ver=1`) === null && A(`${H}/wp-content/plugins/bad slug/y.js`) === null, 'a slug with a space, "%" or only dots is dropped');
ok(A(`${H}/wp-content/uploads/2024/x.js?ver=1`) === null && A('not an address') === null && A(null) === null && A(undefined) === null, 'other folders, text that is no address, null: nothing');
ok(A(`${H}/wp-content/plugins/www.evil.example/y.js`) === null && A(`${H}/wp-content/plugins/evil.com/y.js`) === null && A(`${H}/wp-content/plugins/my.plugin2/y.js`) !== null, 'a folder name that looks like a web address (www.x, ends in .com) is dropped; a dot inside a name is fine')
const keep = J(A(`${H}/wp-content/plugins/q/x.js?ver=2.0&nonce=SAMPLENONCE123&token=SAMPLETOKEN456&p=1`));
ok(!/SAMPLE|nonce|token|127\.0\.0\.1|8080|http/.test(keep), `only the kind, the name and ver are kept: no host, no other query value (${keep})`);

group('collect: the whole probe.json page list');
const REAL = [page([
    `${H}/wp-content/themes/twentytwentyfour/style.css?ver=1.2`, `${H}/wp-content/plugins/woo-sample/assets/a.css?ver=8.3.1&nonce=abcdef123456`,
    `${H}/wp-content/plugins/elementor-sample/b.js?ver=3.18.2`, `${H}/wp-content/plugins/long-sample/c.js?ver=${'1'.repeat(25)}`, `${H}/wp-content/plugins/bad%20slug/d.js?ver=1.0`,
    `${H}/wp-content/plugins/nover-sample/e.js`, { url: `${H}/wp-content/plugins/missing-sample/f.js?ver=5`, status: 404, type: 'script' },
    { url: 'https://other-site.example/wp-content/plugins/foreign-sample/g.js?ver=2', status: 200, type: 'script' }, { url: `${H}/wp-content/plugins/www.evil.example/h.js?ver=1`, status: 200, type: 'script' }, { url: `${H}/wp-content/plugins/evil.com/h.js?ver=1`, status: 200, type: 'script' }
], { context: { plugins: ['woo-sample', 'ctx-only-sample', 'bad slug', '..'], themes: ['ctx-theme-sample'], builders: [] }, signals: { wordpress: '6.4.2', comments: [{ slug: 'wordpress-seo', version: '22.0' }, { slug: 'wp-rocket', version: null }] } }),
page([`${H}/wp-content/plugins/woo-sample/assets/a.css?ver=8.4.0`], { viewport: { name: 'mobile', width: 390, height: 844 } }),
{ url: `${H}/skipped`, loaded: false, status: 0, skipped: 'x', assets: [{ url: `${H}/wp-content/plugins/ghost-sample/x.js?ver=9`, status: 200 }] }];
const C = sig.collect(REAL);
const names = C.plugins.map(p => p.slug);
ok(J(names) === J(['elementor-sample', 'long-sample', 'nover-sample', 'woo-sample']), `the plugins whose files were loaded, in name order (${names.join(', ')}); not the 404 file, the bad or address-like names, a file from another site, the page that did not load, or a name only the page context stored`);
ok(J(C.plugins.find(p => p.slug === 'woo-sample').versions.map(v => v.v)) === J(['8.3.1', '8.4.0']), 'two screen sizes with two versions: both are kept');
ok(C.plugins.find(p => p.slug === 'long-sample').versions.length === 0 && !J(C).includes('ctx-only-sample') && !J(C).includes('ctx-theme-sample'), 'a plugin with no usable version has no version; a name that only the page context stored (any status, any host) is not used');
ok(J(C.named_in_comments.map(p => p.slug)) === J(['wordpress-seo', 'wp-rocket']) && C.named_in_comments[0].versions[0].v === '22.0' && C.named_in_comments[0].versions[0].src === 'comment', 'plugins only named in a page comment are kept apart, with the version from the comment');
ok(C.wordpress === '6.4.2' && C.themes.length === 1 && C.themes[0].slug === 'twentytwentyfour' && C.themes[0].versions[0].v === '1.2', 'the WordPress version from the generator tag, and the theme with its version');
ok(!J(C).includes('ghost-sample') && !J(C).includes('foreign-sample') && !J(C).includes('evil') && !J(C).includes('bad') && !/nonce|abcdef123456|http|127\.0\.0\.1/.test(J(C)), 'no full address, no host, no query value other than ver, no bad name anywhere in the result');
ok(J(redact.deep(C)) === J(C), 'the result passes redact.deep unchanged (nothing in it looks like a secret)');
const both = sig.collect([page([`${H}/wp-content/plugins/x-sample/a.js?ver=1.0`], { signals: { wordpress: null, comments: [{ slug: 'x-sample', version: '2.0' }] } })]).plugins[0];
ok(both.slug === 'x-sample' && both.versions.length === 2 && both.versions[0].src === 'asset' && both.versions[1].src === 'comment', 'a plugin seen in a file address and in a comment is one entry with both versions, the file address first');

group('limits');
const many = sig.collect([page(Array.from({ length: 8 }, (_, i) => `${H}/wp-content/plugins/p${i}-sample/a.js?ver=1.${i}`))]);
ok(many.plugins.length === 5 && many.plugins_more === 3, 'at most 5 plugins are listed, the rest is counted (and 3 more)');
const vmany = sig.collect([page(Array.from({ length: 5 }, (_, i) => `${H}/wp-content/plugins/v-sample/a.js?ver=1.${i}`))]).plugins[0];
ok(vmany.versions.length === 3 && vmany.versions_more === 2, 'at most 3 versions of one plugin are listed, the rest is counted (and 2 more)');
const big = sig.collect([page(Array.from({ length: 900 }, (_, i) => `${H}/wp-content/plugins/z${String(i).padStart(3, '0')}-sample/a.js?ver=1`))]);
ok(big.scanned_assets === 500 && big.truncated === true && big.plugins.length === 5 && big.plugins_more === 495, 'at most 500 assets are scanned and the result says it was cut (the 495 more are the 500 scanned minus the 5 shown)');
ok(J(sig.collect(null)) === J(sig.collect([])) && sig.collect([null, 7, 'x', {}, { loaded: true }, { loaded: true, assets: 'x', context: 'y', signals: 'z' }]).plugins.length === 0, 'odd input (null, numbers, text, pages without fields) gives an empty result and never throws');

group('the reader sentences (exact)');
const L = o => plain.liveSignalsLines({ wordpress: null, plugins: [], plugins_more: 0, named_in_comments: [], named_in_comments_more: 0, themes: [], themes_more: 0, ...o });
const ent = (slug, vs = [], more = 0) => ({ slug, versions: vs.map(v => ({ v, src: 'asset' })), versions_more: more });
ok(J(L({})) === '[]' && J(plain.liveSignalsLines(null)) === '[]' && J(plain.liveSignalsLines({})) === '[]', 'nothing found: NO line');
ok(J(L({ plugins: [ent('woo-sample', ['8.3.1'])] })) === J(['The page loads files of: woo-sample (version 8.3.1 in the file address, which can be a cache number). Plugins that load nothing on this page are not shown.']), 'one plugin with a version: the exact sentence');
ok(J(L({ plugins: [ent('nover-sample')] })) === J(['The page loads files of: nover-sample (version not shown). Plugins that load nothing on this page are not shown.']), 'one plugin without a version: "version not shown"');
ok(J(L({ plugins: [ent('a-sample', ['1.2']), ent('b-sample', ['3.0']), ent('c-sample')] })) === J(['The page loads files of: a-sample 1.2, b-sample 3.0 and c-sample (a number after a name is a version from a file address or a page comment, and can be a cache number). Plugins that load nothing on this page are not shown.']), 'several plugins: "<plugin one> <v1>, <plugin two> <v2> and <plugin three>"');
ok(J(L({ plugins: [ent('a-sample', ['1.2']), ent('b-sample', ['3.0'])], plugins_more: 4 })) === J(['The page loads files of: a-sample 1.2, b-sample 3.0 and 4 more (a number after a name is a version from a file address or a page comment, and can be a cache number). Plugins that load nothing on this page are not shown.']), 'more plugins than shown: "... and N more"');
ok(J(L({ plugins: [ent('a-sample', ['1.0', '1.1', '1.2'], 2)] })) === J(['The page loads files of: a-sample (version 1.0/1.1/1.2 and 2 more in the file address, which can be a cache number). Plugins that load nothing on this page are not shown.']), 'several versions of one plugin: at most 3, then "and N more"');
ok(J(L({ wordpress: '6.4.2' })) === J(['The page says it runs WordPress 6.4.2 (from the generator tag, which can be hidden or changed).']), 'WordPress: the exact sentence');
ok(J(L({ themes: [ent('twentytwentyfour', ['1.2'])] })) === J(['The page loads files of the theme: twentytwentyfour (version 1.2 in the file address, which can be a cache number).']), 'a theme: the sentence');
ok(J(L({ named_in_comments: [{ slug: 'wordpress-seo', versions: [{ v: '22.0', src: 'comment' }], versions_more: 0 }, ent('wp-rocket')] })) === J(['A comment on the page names: wordpress-seo 22.0 and wp-rocket. A comment is not proof that the plugin is active.']), 'plugins only named in a comment: they are not said to load files, and a comment is not proof');
const all = L({ wordpress: '6.4.2', plugins: [ent('a-sample', ['1'])], themes: [ent('t-sample')] });
ok(all.length === 3 && !all.some(l => /confirmed|cause|broken|active plugin|installed/i.test(l)), 'the lines never say confirmed, cause, broken, installed or active');

console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll live-signals checks passed');
process.exit(failures ? 1 : 0);
