#!/usr/bin/env node
// Self-test of lib/report-mask.js (step 4a-1): the masking of the SHAREABLE report files. Pure functions, no browser, no network.
// Covered: the host of the issue's address is replaced by "[site address]" with or without scheme, "www.", sub-domains and port, and the PATH stays; email and IP
// addresses are replaced with the rules of lib/feedback.js (reused); loopback hosts and IPs are NOT masked; other domain-like text is NOT masked; deep() walks
// objects and arrays and leaves keys and numbers; a long text stays fast; the masked value never contains the host.
const path = require('path');
let failures = 0;
const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`); if (!c) failures++; };
const group = t => console.log(`\n== ${t}`);

let M = null; try { M = require('../lib/report-mask'); } catch { /* old code: every check FAILS, the file does not crash */ }
const text = (s, hosts) => (M && typeof M.text === 'function' ? M.text(s, { hosts }) : null);
const H = ['acme-shop.example'];
const SA = '[site address]', EM = '[email removed]', IP = '[IP address removed]';

group('hostsOf');
const hs = i => (M && typeof M.hostsOf === 'function' ? M.hostsOf(i) : null);
ok(JSON.stringify(hs({ url: 'https://www.Acme-Shop.example:8080/x', pages: ['/a', 'http://acme-shop.example/b', 'http://127.0.0.1:3/c'] })) === JSON.stringify(['acme-shop.example']), 'the host of the address and of absolute page addresses; "www." removed; lower case; once; loopback and page paths left out');
ok(JSON.stringify(hs({ url: 'http://localhost:8080/', pages: [] })) === '[]' && JSON.stringify(hs({ url: 'http://203.0.113.9/', pages: [] })) === '[]' && JSON.stringify(hs({ url: 'not a url', pages: null })) === '[]' && JSON.stringify(hs({})) === '[]' && JSON.stringify(hs(null)) === '[]', 'localhost, an IP host (the IP rule handles it), a broken address and an empty issue give no host');
ok(JSON.stringify(hs({ url: 'https://short.example/', pages: ['https://a-much-longer-name.example/'] })) === JSON.stringify(['a-much-longer-name.example', 'short.example']), 'longest host first');

group('the site host');
ok(text('Open https://www.acme-shop.example:8080/checkout/ now', H) === `Open ${SA}/checkout/ now`, 'scheme, www and port are masked, the path stays');
ok(text('acme-shop.example/cart and ACME-SHOP.EXAMPLE', H) === `${SA}/cart and ${SA}`, 'the bare host (any case) is masked, with the path kept');
ok(text('cdn.acme-shop.example and http://a.b.acme-shop.example/x.js', H) === `${SA} and ${SA}/x.js`, 'a sub-domain of the site is masked too');
ok(text('notacme-shop.example and acme-shop.example.evil.test', H) === `notacme-shop.example and ${SA}.evil.test`, 'a name that only ends the same way is not touched; the site name inside a longer name is masked (safe side)');
ok(text('The page (acme-shop.example), "acme-shop.example:443".', H) === `The page (${SA}), "${SA}".`, 'inside brackets and quotes');
ok(text('Plain words and example.org stay. Version 6.5.2.', H) === 'Plain words and example.org stay. Version 6.5.2.', 'other domain-like text and version numbers are NOT masked');
ok(text('no host given acme-shop.example', []) === 'no host given acme-shop.example', 'without a host list nothing is masked (the caller decides)');
ok(!text('x https://www.acme-shop.example:8080/a?b=1#c y', H).includes('acme-shop'), 'the masked text never holds the host');

group('email and IP (the rules of lib/feedback.js)');
ok(text('Contact owner-test@acme-shop.example please', H) === `Contact ${EM} please`, 'an email at the site host is an email: masked once, as an email');
ok(text('from 203.0.113.9 and 2001:db8::7', H) === `from ${IP} and ${IP}`, 'IPv4 and IPv6 addresses are masked');
ok(text('local 127.0.0.1, 127.1.2.3 and ::1 and http://localhost:8080/x', H) === 'local 127.0.0.1, 127.1.2.3 and ::1 and http://localhost:8080/x', 'loopback hosts and IPs are NOT masked');
ok(text('10.0.0.256 and 6.5.2 and 1.2.3', H) === '10.0.0.256 and 6.5.2 and 1.2.3', 'not an IP: a part above 255, a three-part version');
const fb = require('../lib/feedback');
ok(Array.isArray(fb.MASKS) && fb.MASKS.length === 3 && text('a@b.example', []) === EM && fb.mask('a@b.example').text === '[email removed]', 'the rules come from lib/feedback.js (exported), not a copy: the same words');

group('review round 1: encoded host, long address, mapped IPv6, names, versions, sub-domains');
ok(text('?redirect=https%3A%2F%2Facme-shop.example%2Fx and acme-shop%2Eexample', H) === `?redirect=https%3A%2F%2F${SA}%2Fx and ${SA}`, 'a host inside a percent-encoded address (%2F before it, %2E for dots) is masked');
ok(text('x_acme-shop.example y', H) === `x_${SA} y`, 'an underscore before the host is no part of a host name');
const long = text(`https://x.test/?q=${'a'.repeat(400)}&e=owner@mail.example and ${'b'.repeat(400)}`, H);
ok(long.includes(EM) && !long.includes('owner@') && long.includes('b'.repeat(400)), 'an email inside a word over 320 characters is still found; the rest of the word stays');
ok(text('map ::ffff:127.0.0.1 and ::ffff:203.0.113.9 end', H) === `map ::ffff:127.0.0.1 and ${IP} end`, 'an IPv4 address written as IPv6: loopback kept whole, a real one masked whole (no leftover ".0.113.9")');
ok(text('Call to undefined method Feed::add() and a::b and cafe:: and DB::table', H) === 'Call to undefined method Feed::add() and a::b and cafe:: and DB::table', 'class and method names made of hex letters are not IP addresses');
ok(text('fe80::a and 2001:db8::7', H) === `${IP} and ${IP}`, 'real IPv6 addresses (with a digit) are still masked');
ok(text('Plugin 1.2.3.4 and WordPress 6.4.3.1', H) === `Plugin ${IP} and WordPress ${IP}`, 'KNOWN LIMIT, documented: a bare four-part version in prose (no "version" word before it) looks like an IPv4 address and is masked (over-masking, safe side)');
ok(JSON.stringify(hs({ url: 'https://shop.acme-shop.example/', pages: [] })) === JSON.stringify(['shop.acme-shop.example', 'acme-shop.example']) && JSON.stringify(hs({ url: 'https://acme.co.uk/', pages: [] })) === JSON.stringify(['acme.co.uk']) && JSON.stringify(hs({ url: 'https://shop.acme.co.uk/', pages: [] })) === JSON.stringify(['shop.acme.co.uk', 'acme.co.uk']), 'a sub-domain address also masks its parent domain, but never a public suffix such as co.uk');
const cyc = {}; cyc.self = cyc; cyc.list = [cyc];
const cd = M && M.deep ? M.deep(cyc, { hosts: H }) : null;
ok(cd && cd.self === '[circular]' && cd.list[0] === '[circular]', 'deep: a cyclic object does not crash');
let deepObj = {}; let cur = deepObj; for (let i = 0; i < 5000; i++) { cur.n = {}; cur = cur.n; }
let deepOk = false; try { M.deep(deepObj, { hosts: H }); deepOk = true; } catch { deepOk = false; }
ok(deepOk, 'deep: an object 5000 levels deep does not crash');
const pj = M && M.deep ? M.deep(JSON.parse('{"__proto__":"a@b.example","k":"v"}'), { hosts: H }) : null;
ok(pj && Object.keys(pj).join() === '__proto__,k' && Object.getOwnPropertyDescriptor(pj, '__proto__').value === EM, 'deep: a "__proto__" key is kept as a plain key and its text is masked');

group('review round 2: window edge, NUL in the text, parent chain, platforms');
const edge = text(`${'a'.repeat(400)}@${'b'.repeat(250)}xxjohnsmith@mail.example`, []);
ok(edge.endsWith(EM) && !edge.includes('johnsmi') && !edge.includes('mail.example'), 'an email that crosses the edge of a search window is masked whole (windows are merged)');
ok(text('a\u00000\u0000b ::1 \u00001\u0000', []) === 'a0b ::1 1', 'a NUL character in the text cannot break the placeholders (it is dropped; nothing becomes "undefined")');
ok(JSON.stringify(hs({ url: 'https://a.b.c.example.com/', pages: [] })) === JSON.stringify(['a.b.c.example.com', 'b.c.example.com', 'c.example.com', 'example.com']), 'every parent down to two labels is masked');
ok(JSON.stringify(hs({ url: 'https://blog.wordpress.com/', pages: [] })) === JSON.stringify(['blog.wordpress.com']) && JSON.stringify(hs({ url: 'https://x.github.io/', pages: [] })) === JSON.stringify(['x.github.io']) && JSON.stringify(hs({ url: 'https://x.pantheonsite.io/', pages: [] })) === JSON.stringify(['x.pantheonsite.io']), 'a shared platform (wordpress.com, github.io ...) is never masked as a parent; the site\'s own host still is');
ok(text('see wordpress.com and github.io', hs({ url: 'https://blog.wordpress.com/', pages: [] })) === 'see wordpress.com and github.io', 'so ordinary advice that names the platform stays readable');
// KNOWN LIMITS (shared with lib/feedback.js, which owns the email and IP rules): "10.0.0.1::" and "a@b.example joined to a second address" are cut at the rule edge. Recorded here, not fixed.

group('review round 3: trailing dot, internationalised names');
ok(JSON.stringify(hs({ url: 'https://acme-shop.example./', pages: [] })) === JSON.stringify(['acme-shop.example']) && JSON.stringify(hs({ url: 'https://shop.acme.com./', pages: [] })) === JSON.stringify(['shop.acme.com', 'acme.com']), 'a host written with a trailing dot is the same host (no leak, no bare "example." parent)');
ok(text('for example. and acme-shop.example/x', hs({ url: 'https://acme-shop.example./', pages: [] })) === `for example. and ${SA}/x`, 'so ordinary prose is not masked and the host is');
const idn = hs({ url: 'https://xn--bcher-kva.example/', pages: [] });
ok(idn.includes('xn--bcher-kva.example') && idn.includes('b\u00fccher.example') && text('Seite b\u00fccher.example/shop und xn--bcher-kva.example', idn) === `Seite ${SA}/shop und ${SA}`, 'an international name is masked in both forms (letters and xn--)');
ok(JSON.stringify(hs({ url: 'https://localhost./', pages: [] })) === '[]' && JSON.stringify(hs({ url: 'https://intranet/', pages: [] })) === '[]', 'a one-label host is not masked (it would mask an ordinary word)');

group('the tool\'s own made-up addresses');
ok(text('one dummy administrator (login pgadmin, e-mail pgadmin@example.invalid) and user7@example.invalid', H) === 'one dummy administrator (login pgadmin, e-mail pgadmin@example.invalid) and user7@example.invalid', 'the dummy addresses of the test copy (@example.invalid) are kept: they are made up by the tool, and the report says them');
ok(text('real owner@mail.example.invalid.test and bob@example.invalid.com', H) === `real ${EM} and ${EM}`, 'only the exact domain example.invalid is kept; a look-alike is masked');

group('versions are not addresses');
ok(text('version 8.9.1.0 and Version: 2.1.0.5 and v1.2.3.4 and ver. 3.4.5.6 and release 7.8.9.1', H) === 'version 8.9.1.0 and Version: 2.1.0.5 and v1.2.3.4 and ver. 3.4.5.6 and release 7.8.9.1', 'a four-part number right after "version", "v", "ver." or "release" is a version, not an IP address');
const vd = M && M.deep ? M.deep({ components: [{ name: 'Shop', version: '8.9.1.0', plugin_version: '2.1.0.5', note: 'seen from 203.0.113.9' }], required_php_version: '7.4.1.2' }, { hosts: H }) : null;
ok(vd && vd.components[0].version === '8.9.1.0' && vd.components[0].plugin_version === '2.1.0.5' && vd.required_php_version === '7.4.1.2' && vd.components[0].note === `seen from ${IP}`, 'deep: the value of a key named like a version keeps its four-part number; other keys are still masked');
ok(text('server 203.0.113.9 and from 198.51.100.7', H) === `server ${IP} and from ${IP}`, 'a real IP address next to ordinary words is still masked');

group('OCR text (4a-3): the site name, even damaged, and website-like text; benign text stays');
const ocr = t => (M && typeof M.ocrText === 'function' ? M.ocrText(t, { hosts: H }) : null);
ok(ocr('Address bar: ACME - SHOP | Checkout') === `Address bar: ${SA} | Checkout` && ocr('visit acme.shop or Acme  Shop now') === `visit ${SA} or ${SA} now`, 'the site name is masked with its case, spaces, dots and hyphens damaged (ACME - SHOP, acme.shop, Acme  Shop)');
ok(ocr('acmeshop.com/cart and www.acme-shop.example and shopping.example.com') === `${SA}/cart and ${SA} and ${SA}`, 'website-like text is masked in OCR text, and leaves no ending behind ("acmeshop.com" -> one [site address])');
ok(ocr('bob@corp.example and 203.0.113.9') === `${EM} and ${IP}`, 'email and IP rules apply to OCR text too');
const BENIGN = ['Fatal error: Call to undefined function acme_helper() in /wp-content/plugins/shop-plugin/shop.php on line 12', 'WordPress admin staging demo test blog site theme plugin local localhost', 'jquery.min.js style.css debug.log functions.php readme.txt version 6.5.2', 'Your connection is not private NET::ERR_CERT_DATE_INVALID', 'Thank you for your order #1234 total 49.90 EUR', 'wordpress.org github.com php.net',
    'Error.In file', 'End.It was', 'Save.At least', 'Ok.Be careful', 'done.Us too', 'Settings.me', 'Name.Me', 'Menus.Info', 'Cart.Store', 'update.Online', 'Hello.co', 'Mar.de', 'see file.in now', 'text.no', 'a.it', 'error.log.no', 'Version 6.5.it', 'v1.2.co', 'jquery.ui.de', 'translations.de_DE', 'wp-content/languages/plugins/woo.de', 'class-wc-acmeshop.php'];   // the last lines: a sentence that lost its space after the full stop, a country code or a word ending, a version, a file name
ok(BENIGN.every(b => ocr(b) === b), 'benign OCR text is NOT masked: error lines, file names, versions, the stop-list words (wordpress, plugin, theme, local, localhost, admin, staging, demo, test, shop, blog, site) and well-known hosts');
ok(M && JSON.stringify(M.siteTokens(['shop.acme-shop.example', 'blog.example', 'tiny.example', 'pluginhub.co.uk'])) === JSON.stringify(['pluginhub', 'acmeshop']), 'site-name tokens: from the labels without the ending (and without co.uk); under 5 letters and the stop-list words are never used; longest first');
ok(M && M.siteTokens(['x.example']).length === 0 && M.siteTokens([]).length === 0 && M.siteTokens(null).length === 0, 'no token for a short name, an empty list or null');
const fo = M && M.maskOcrFields ? M.maskOcrFields({ reported: { images: [{ name: 'a.png', ocr_text: 'ACME SHOP bar' }] }, supports: [{ kind: 'ocr', text: 'OCR: acmeshop.com' }, { kind: 'log', text: 'acmeshop.com stays here' }] }, { hosts: H }) : null;
ok(fo && fo.reported.images[0].ocr_text === `${SA} bar` && fo.supports[0].text === `OCR: ${SA}` && fo.supports[1].text === 'acmeshop.com stays here', 'maskOcrFields: ocr_text fields and texts of kind "ocr" get the OCR rules; a text of another kind does not (the domain-like rule is only for OCR text)');
ok(ocr("go to https://acme-shop.de/cart now") === `go to https://${SA}/cart now` && ocr('www.acme.de and acme.de:8080 and acme.de/x') === `${SA} and ${SA}:8080 and ${SA}/x`, 'a country ending or a common word ending IS masked when "://" or "www." is before it, or "/" or ":port" after it');
ok(M && JSON.stringify(M.siteTokens(['acme.myshopify.com', 'mysite.wpengine.com', 'client-site.kinsta.cloud', 'x.github.io'])) === JSON.stringify(['clientsite', 'mysite']), 'a shared platform is never the site name (acme.myshopify.com has none under 5 letters; mysite.wpengine.com gives "mysite", not "wpengine")');
ok(M.ocrText('Powered by WP Engine and wpengine', { hosts: ['mysite.wpengine.com'] }) === 'Powered by WP Engine and wpengine' && M.ocrText('class-wc-orders.php and Orders page', { hosts: ['orders.example'] }) === 'class-wc-orders.php and [site address] page', 'the host company is not masked; a site name that is a common word keeps a file name ("class-wc-orders.php") and is masked as a word');
const IDN = hs({ url: 'https://acme-sh\u00f6p.de/', pages: [] });
ok(M && M.ocrText('Bar: https://acme-sh\u00f6p.de/ and Acme Sh\u00f6p and acme-sh\u00f6p.de', { hosts: IDN }) === `Bar: ${SA}/ and ${SA} and ${SA}`, 'a site name with a non-ASCII letter is masked whole (written with the letter, in a name, in an address): no half name is left');
ok(['window.app is undefined', 'config.local and array.test', 'x.dev'].every(b => ocr(b) === b), 'code words that are also endings (app, local, test, dev) are not addresses without a sign');
ok(M && M.ocrText('siteaddress.com and siteaddress', { hosts: ['siteaddress.com'] }) === `${SA} and ${SA}`, 'a site whose name is "siteaddress" does not turn the placeholder into "[[site address]]"');
ok(ocr('\u00fcnacme-shop.example and https://b\u00fccher-laden.de/x') === `${SA} and https://${SA}/x`, 'a non-ASCII letter glued to the front of a name or an address does not hide it (the whole word is masked), and a website with a non-ASCII name is recognised');
const start = Date.now(); ocr('a.'.repeat(2000) + 'b-'.repeat(2000) + 'acme shop'); ocr('x'.repeat(4000));
ok(Date.now() - start < 1500, `long OCR text stays fast (${Date.now() - start} ms)`);

group('4m verification round: aligned log lines and non-ASCII sub-domains');
ok(text('server:        10.1.2.3 and observer 10.1.2.4 and Server 10.1.2.5', H) === `server:        ${IP} and observer ${IP} and Server ${IP}`, 'a real IP address after a word that only ENDS in "ver" (server, observer), also after many spaces (aligned log lines), is masked');
ok(text('version 8.9.1.0 and Version:     2.1.0.5 and release 7.8.9.1', H) === 'version 8.9.1.0 and Version:     2.1.0.5 and release 7.8.9.1' && text('ver 1.2.3.4 at the start', H) === 'ver 1.2.3.4 at the start', 'a version number after the real word (also at the very start of the text) is still kept');
ok(text('m\u00fcnchen.acme-shop.example and \u00fcber.www.acme-shop.example/x', H) === `${SA} and ${SA}/x`, 'a sub-domain with a non-ASCII letter is masked whole (no fragment is left)');

ok(text('\u8bbf\u95eeacme-shop.example/x and \u00e9acme-shop.example and acme-shop.example\u7684', H) === `\u8bbf\u95ee${SA}/x and \u00e9${SA} and ${SA}\u7684`, 'a host glued to a non-ASCII letter (Chinese text, an accented letter) is still masked, before and after it');

group('deep, null and speed');
const d = M && M.deep ? M.deep({ url: 'https://acme-shop.example/p', n: 5, ok: true, nothing: null, list: ['a@b.example', { 'acme-shop.example': 'x acme-shop.example' }] }, { hosts: H }) : null;
ok(d && d.url === `${SA}/p` && d.n === 5 && d.ok === true && d.nothing === null && d.list[0] === EM && d.list[1]['acme-shop.example'] === `x ${SA}`, 'deep masks every string, leaves numbers, booleans, null and the KEYS');
ok(text(null, H) === '' && text(undefined, H) === '' && text('', H) === '', 'null and empty text give an empty string');
let t0 = Date.now(); text('a.'.repeat(60000) + '@', H); text('a.'.repeat(60000) + 'acme-shop.example', H); text('1.2.'.repeat(30000), H); text('a:'.repeat(60000), H);
ok(Date.now() - t0 < 2000, `long texts of dots, digits and colons stay fast (${Date.now() - t0} ms)`);
ok(M && M.SITE_ADDRESS === SA && M.isLoopbackHost('LOCALHOST') && M.isLoopbackHost('a.localhost') && M.isLoopbackHost('127.9.9.9') && !M.isLoopbackHost('127.0.0.1.evil.test') && !M.isLoopbackHost('acme-shop.example'), 'the loopback test: localhost and 127.x only');

console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll report-mask checks passed');
void path;
process.exit(failures ? 1 : 0);
