#!/usr/bin/env node
// Self-test of the cache clue, Case A (step 4p-1a): when the live page showed an ERROR (a status 400 to 599, or a 200 page with the WordPress critical-error text, found by the report's own detector issue/oracle.js flagsOf) and the answer shows signs that a cache served it, the report says so as
// "possible, not confirmed". Covered here:
//   - probe/recorder.js cacheSigns: only served-from-cache signs (Age above 0; hit or stale in X-Cache, CF-Cache-Status, X-LiteSpeed-Cache (EXPIRED gives nothing: the origin answered again); two request numbers in
//     X-Varnish) and only a fixed vocabulary; a MISS, BYPASS or DYNAMIC value gives nothing; a hostile value (a host name, markup, a huge text) never comes out;
//   - issue/cache-clues.js caseA: an error page with a sign; not a fine page, not an error page without a sign, not a miss or bypass sign (also when a record holds one);
//   - lib/plain-names.js cacheClueLines: the exact sentence, "possible, not confirmed", "one load, from one computer, at one time", never "no cache";
//   - a real no-files run against a fixture server on 127.0.0.1: the line is in the report files and the terminal, no raw header value and no canary host is stored in
//     probe.json, probe/result.json or any report file; a MISS or BYPASS answer gives no line and no cache_signs field; a fine page with a HIT gives no line.
// Never touches a real site; the fixture server is on 127.0.0.1 only.
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pg-cache-')));
process.env.PLUGIN_GUARD_ISSUES = path.join(tmp, 'issues');
const ENVX = { PG_PROBE_NAV_DELAY_MS: '0', PG_PROBE_REQUEST_DELAY_MS: '0', PG_PROBE_5XX_RETRY_DELAY_MS: '0', PG_PROBE_COOLDOWN_FILE: path.join(tmp, 'cool.json') };
Object.assign(process.env, ENVX);
let failures = 0;
const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`); if (!c) failures++; };
const group = t => console.log(`\n== ${t}`);
const CMD = path.join(__dirname, 'plugin-guard.js');
const CANARY = 'canary-cdn-host.example';
const PAGE = '<!doctype html><html><head><title>Fixture</title></head><body><h1>Fixture</h1><p>Some text so the page does not look blank to the probe.</p></body></html>';

let R = null; try { R = require('../probe/recorder'); } catch { /* old code */ }
let C = null; try { C = require('../issue/cache-clues'); } catch { /* old code: every check FAILS, the file does not crash */ }
const plainNames = require('../lib/plain-names');
const sign = h => (R && typeof R.cacheSigns === 'function' ? R.cacheSigns(h) : null);
const J = x => JSON.stringify(x);
const SENT = signs => `The page showed an error, and the answer shows signs of a cache (${signs}). Possible, not confirmed: a cache kept this error and still shows it. This was one load, from one computer, at one time.`;

const run = args => new Promise(resolve => { const c = spawn(process.execPath, [CMD, ...args], { cwd: tmp, env: { ...process.env } }); let so = '', se = ''; c.stdout.on('data', d => { so += d; }); c.stderr.on('data', d => { se += d; }); c.on('close', code => resolve({ status: code, out: so + se })); });
const dirs = () => { try { return fs.readdirSync(path.join(tmp, 'issues')).filter(n => /^iss-/.test(n)); } catch { return []; } };
const walk = (d, out = []) => { for (const n of fs.readdirSync(d)) { const p = path.join(d, n), st = fs.lstatSync(p); if (st.isDirectory()) walk(p, out); else out.push(p); } return out; };
async function scenario(status, headers, body = PAGE) {
    const sv = http.createServer((q, res) => { res.writeHead(status, { 'Content-Type': 'text/html', ...headers }); res.end(body); });
    await new Promise(r => sv.listen(0, '127.0.0.1', r));
    const before = new Set(dirs());
    const r = await run(['--description', 'The page shows an error', '--no-files', '--yes', '--url', `http://127.0.0.1:${sv.address().port}/`, '--env', 'local']);
    sv.close();
    const id = dirs().find(n => !before.has(n)), dir = path.join(tmp, 'issues', id || 'none');
    const files = fs.existsSync(dir) ? walk(dir) : [];
    const text = files.map(f => { try { return fs.readFileSync(f, 'utf8'); } catch { return ''; } }).join('\n');
    const rd = rel => { try { return fs.readFileSync(path.join(dir, rel), 'utf8'); } catch { return ''; } };
    const f = rd('result/findings.json') ? JSON.parse(rd('result/findings.json')) : null;
    const probe = rd('work/probe.json') ? JSON.parse(rd('work/probe.json')) : null;
    return { r, f, probe, text, md: rd('result/ISSUE-REPORT.md'), html: rd('result/issue.html') };
}

(async () => {
    group('cacheSigns: only served-from-cache signs, only a fixed vocabulary');
    ok(J(sign({ age: '120', 'X-Cache': 'HIT from cloudfront', 'CF-Cache-Status': 'HIT', 'X-LiteSpeed-Cache': 'hit', 'x-varnish': '123 456' })) === J({ age_over_zero: true, x_cache: 'hit', cf_cache_status: 'hit', litespeed: 'hit', varnish: 'hit' }), 'every served-from-cache sign is found (header names in any case)');
    ok(J(sign({ 'CF-Cache-Status': 'STALE', 'X-Cache': 'TCP_MISS, TCP_STALE' })) === J({ x_cache: 'stale', cf_cache_status: 'stale' }) || J(sign({ 'CF-Cache-Status': 'STALE', 'X-Cache': 'TCP_MISS, TCP_STALE' })) === J({ cf_cache_status: 'stale', x_cache: 'stale' }), 'stale counts (a MISS next to it is ignored)');
    ok(J(sign({ 'CF-Cache-Status': 'EXPIRED' })) === '{}' && J(sign({ 'X-Cache': 'TCP_EXPIRED' })) === '{}' && J(sign({ 'x-litespeed-cache': 'expired' })) === '{}' && J(sign({ 'CF-Cache-Status': 'EXPIRED', 'X-Cache': 'EXPIRED, MISS', age: '0' })) === '{}' && J(sign({ 'CF-Cache-Status': 'EXPIRED', 'X-Cache': 'TCP_HIT' })) === J({ x_cache: 'hit' }), 'EXPIRED gives nothing in any header (the stored copy was out of date and the origin answered again); a real hit next to it still counts');
    ok(J(sign({ age: '0', 'x-cache': 'MISS', 'cf-cache-status': 'MISS', 'x-litespeed-cache': 'miss', 'x-varnish': '123' })) === '{}', 'MISS, Age 0 and ONE Varnish number give nothing');
    ok(J(sign({ 'cf-cache-status': 'BYPASS', 'x-cache': 'BYPASS', 'x-litespeed-cache': 'DYNAMIC' })) === '{}' && J(sign({ 'cf-cache-status': 'DYNAMIC' })) === '{}' && J(sign({ 'cf-cache-status': 'REVALIDATED' })) === '{}' && J(sign({ 'cf-cache-status': 'UPDATING' })) === '{}', 'BYPASS and DYNAMIC (and REVALIDATED, UPDATING, which are not in the list) give nothing');
    ok(J(sign({ 'x-cache': 'Hit from cloudfront' })) === J({ x_cache: 'hit' }) && J(sign({ 'x-cache': 'TCP_MEM_HIT' })) === J({ x_cache: 'hit' }) && J(sign({ 'x-cache': 'HITCH' })) === '{}' && J(sign({ 'x-cache': 'whitelist' })) === '{}', 'the word hit is a word: "Hit from ...", "TCP_MEM_HIT" count; "HITCH" and "whitelist" do not');
    ok(J(sign({ 'x-cache': 'HIT-FOR-PASS' })) === '{}' && J(sign({ 'x-cache': 'hit_for_miss' })) === '{}' && J(sign({ 'x-cache': 'NOT_HIT' })) === '{}' && J(sign({ 'x-litespeed-cache': 'uncacheable-hit' })) === '{}' && J(sign({ 'x-cache': 'HIT-FOR-PASS, HIT' })) === J({ x_cache: 'hit' }), 'hit-for-pass, hit-for-miss, not hit and uncacheable hit are not hits (the answer came from the server); a real hit next to them still counts');
    ok(J(sign({ 'x-varnish': '12\n34' })) === '{}' && J(sign({ 'x-varnish': '12, 34' })) === '{}' && J(sign({ 'x-varnish': '123 456' })) === J({ varnish: 'hit' }) && J(sign({ 'x-varnish': ' 123   456 ' })) === J({ varnish: 'hit' }), 'X-Varnish: two request numbers separated by spaces are a hit; two headers joined by a newline or a comma (one number each) are not');
    ok(J(sign({ age: 'abc' })) === '{}' && J(sign({ age: '-5' })) === '{}' && J(sign({ age: '12.5' })) === '{}', 'a broken Age gives nothing');
    const hostile = sign({ 'x-cache': `HIT from ${CANARY} <script>alert(1)</script> ${'A'.repeat(5000)}`, 'cf-cache-status': `HIT ${CANARY}`, age: `5 ${CANARY}`, 'x-varnish': `123 ${CANARY}`, 'x-litespeed-cache': `hit\u0000${CANARY}` });
    ok(hostile && J(hostile) === J({ x_cache: 'hit', litespeed: 'hit' }) && !/canary|script|AAAA/.test(J(hostile)), 'a hostile value (a host name, markup, a huge text) never comes out: only the fixed words');
    const ofResp = r => (R && typeof R.cacheSignsOf === 'function' ? R.cacheSignsOf(r) : null);
    ok(J(ofResp({ headers: () => ({ age: '5', 'cf-cache-status': 'HIT' }) })) === J({ age_over_zero: true, cf_cache_status: 'hit' }) && J(ofResp(null)) === '{}' && J(ofResp({})) === '{}' && J(ofResp({ headers: () => { throw new Error('x'); } })) === '{}', 'cacheSignsOf(response): reads the headers of the navigation response the probe already has; a missing response, no headers() or an error gives {}');
    const wsrc = fs.readFileSync(path.join(__dirname, '..', 'probe', 'worker.js'), 'utf8');
    ok(/cacheSignsOf\(nav\.response\)/.test(wsrc) && wsrc.split('\n').filter(l => /headers\(\)/.test(l)).length === 1, 'worker.js asks cacheSignsOf for the signs and still reads headers() in exactly one place (the selftest-6b rule is kept as it is)');
    ok(J(sign(null)) === '{}' && J(sign(undefined)) === '{}' && J(sign('x')) === '{}' && J(sign({ age: ['5'] })) === J({ age_over_zero: true }), 'null, undefined, a string and an array value do not crash');

    group('caseA: an error page with a sign, and nothing else');
    const P = (status, signs, extra = {}) => ({ loaded: true, status, cache_signs: signs, ...extra });
    const A = pages => (C && typeof C.caseA === 'function' ? C.caseA(pages) : 'N/A');
    ok(J(A([P(500, { age_over_zero: true, cf_cache_status: 'hit' })])) === J({ signs: ['the Age header is above 0', 'CF-Cache-Status says hit'], pages: 1 }), 'a 500 page with signs: the fixed words, in a fixed order');
    ok(((A([P(404, { litespeed: 'hit' })]) || {}).signs || [])[0] === 'X-LiteSpeed-Cache says hit' && ((A([P(200, { x_cache: 'stale' }, { text_flags: { critical: true } })]) || {}).signs || [])[0] === 'X-Cache says stale', 'a 404 page, and a 200 page whose stored text flags say critical, count as error pages');
    const CRIT = 'There has been a critical error on this website.';
    ok(((A([P(200, { cf_cache_status: 'hit' }, { text: CRIT })]) || {}).signs || [])[0] === 'CF-Cache-Status says hit' && A([P(200, { age_over_zero: true }, { text: 'PHP Fatal error: x\nFatal error: Uncaught Error in /a.php' })]) !== null, 'a 200 page whose text carries the critical-error text (the report\'s own detector, from the text or from the stored flags) with a sign: the line');
    ok(A([P(200, { cf_cache_status: 'hit' }, { text: 'A normal page about error handling and critical thinking.' })]) === null && A([P(200, { cf_cache_status: 'hit' }, { text_flags: { blank: false, critical: false } })]) === null && A([P(200, { cf_cache_status: 'hit' }, { text: '' })]) === null, 'a 200 page WITHOUT the critical-error text (also a blank one) with a sign: no line');
    ok(A([P(200, { age_over_zero: true, cf_cache_status: 'hit' })]) === null && A([P(301, { age_over_zero: true })]) === null, 'a fine page (200, 301) with signs gives nothing');
    ok(A([P(500, undefined)]) === null && A([P(500, {})]) === null && A([]) === null && A(null) === null && A([null, {}])  === null, 'an error page with no sign, no pages, null: nothing, no crash');
    ok(A([P(500, { x_cache: 'miss', cf_cache_status: 'bypass', litespeed: 'dynamic', age_over_zero: false, varnish: 'miss' })]) === null && A([P(500, { x_cache: 'expired', cf_cache_status: 'expired', litespeed: 'expired' })]) === null, 'even when a stored record holds MISS, BYPASS, DYNAMIC, EXPIRED, false or "miss", the line is not made (served-from-cache only)');
    ok(A([{ loaded: false, status: 500, cache_signs: { age_over_zero: true } }]) === null, 'a page that did not load gives nothing');
    ok(J(A([P(200, { age_over_zero: true }), P(500, { cf_cache_status: 'hit' }), P(503, { cf_cache_status: 'hit', litespeed: 'hit' })]).signs) === J(['CF-Cache-Status says hit', 'X-LiteSpeed-Cache says hit']) && A([P(500, { x_cache: 'hit' }), P(503, { x_cache: 'hit' })]).pages === 2, 'several pages: the signs of the ERROR pages only, each once');
    ok(J(A([P(500, { age_over_zero: true, junk: 'HIT canary-cdn-host.example', x_cache: 'hit from canary-cdn-host.example' })]).signs) === J(['the Age header is above 0']), 'an unknown field and a free-text value in a stored record are ignored');

    group('the sentence');
    const L = plainNames.cacheClueLines ? plainNames.cacheClueLines({ signs: ['the Age header is above 0', 'CF-Cache-Status says hit'] }) : null;
    ok(Array.isArray(L) && L.length === 1 && L[0] === SENT('the Age header is above 0 and CF-Cache-Status says hit'), 'the exact sentence for two signs');
    ok(plainNames.cacheClueLines && plainNames.cacheClueLines({ signs: ['X-Cache says hit'] })[0] === SENT('X-Cache says hit') && plainNames.cacheClueLines({ signs: ['a', 'b', 'c'] })[0] === SENT('a, b and c'), 'one sign, and three signs ("a, b and c")');
    ok(plainNames.cacheClueLines && plainNames.cacheClueLines(null).length === 0 && plainNames.cacheClueLines({ signs: [] }).length === 0 && !/no cache|not cached|no sign/i.test(L ? L[0] : 'no cache'), 'nothing for null or no sign, and the sentence never says "no cache"');

    group('a real no-files run (fixture server on 127.0.0.1)');
    const hit = await scenario(500, { Age: '120', 'X-Cache': `HIT from ${CANARY}`, 'CF-Cache-Status': 'HIT', 'X-Varnish': `111 222 ${CANARY}` });
    const LINE = SENT('the Age header is above 0, X-Cache says hit and CF-Cache-Status says hit');
    ok(hit.r.status === 0 && hit.md.includes(LINE) && hit.html.includes(LINE) && hit.r.out.includes(LINE) && !!hit.f && hit.f.cache_clues && hit.f.cache_clues.case === 'A' && hit.f.cache_clues.lines[0] === LINE, `a 500 answer with cache headers: the line is in ISSUE-REPORT.md, issue.html, the terminal and findings.json (exit ${hit.r.status})`);
    ok(!!hit.probe && hit.probe.pages.some(p => p.cache_signs && J(p.cache_signs) === J({ age_over_zero: true, x_cache: 'hit', cf_cache_status: 'hit' })), 'probe.json holds the fixed signs on the page record');
    ok(!/canary-cdn-host|HIT from|X-Varnish|111 222/.test(hit.text) && hit.text.length > 1000, 'no raw header value and no canary host in ANY file of the issue folder (probe.json, probe/result.json, the report files)');
    const miss = await scenario(500, { Age: '0', 'X-Cache': `MISS from ${CANARY}`, 'CF-Cache-Status': 'MISS', 'X-Varnish': '333' });
    ok(miss.r.status === 0 && !/signs of a cache/.test(miss.text + miss.r.out) && !!miss.probe && miss.probe.pages.every(p => !('cache_signs' in p)) && !miss.f.cache_clues, 'a MISS answer: no line, and no cache_signs field');
    const byp = await scenario(500, { 'CF-Cache-Status': 'BYPASS', 'X-LiteSpeed-Cache': 'DYNAMIC' });
    ok(byp.r.status === 0 && !/signs of a cache/.test(byp.text + byp.r.out) && byp.probe.pages.every(p => !('cache_signs' in p)), 'a BYPASS and DYNAMIC answer: no line, and no cache_signs field');
    const critPage = await scenario(200, { Age: '60', 'CF-Cache-Status': 'HIT' }, '<!doctype html><html><head><title>WordPress</title></head><body><p>There has been a critical error on this website.</p></body></html>');
    ok(critPage.r.status === 0 && critPage.md.includes(SENT('the Age header is above 0 and CF-Cache-Status says hit')) && !!critPage.f.cache_clues, 'a 200 page with the critical-error text and a HIT: the line (report and findings.json)');
    const fine = await scenario(200, { Age: '300', 'CF-Cache-Status': 'HIT' });
    ok(fine.r.status === 0 && !/signs of a cache/.test(fine.text + fine.r.out) && !fine.f.cache_clues && fine.probe.pages.some(p => p.cache_signs), 'a fine page (200, no error text) with a HIT: no line (the sign is stored, the line is for a page that showed an error only)');
    const plain = await scenario(404, {});
    ok(plain.r.status === 0 && !/signs of a cache/.test(plain.text + plain.r.out) && !/no cache|not cached/i.test(plain.md), 'an error page with no cache header: no line, and the report never says "no cache"');
    const exp = await scenario(500, { 'CF-Cache-Status': 'EXPIRED', 'X-LiteSpeed-Cache': 'expired' });
    ok(exp.r.status === 0 && !/signs of a cache/.test(exp.text + exp.r.out) && exp.probe.pages.every(p => !('cache_signs' in p)) && !exp.f.cache_clues, 'an EXPIRED answer (500): no line and no cache_signs field');
    const lsc = await scenario(404, { 'X-LiteSpeed-Cache': 'hit' });
    ok(lsc.r.status === 0 && lsc.md.includes(SENT('X-LiteSpeed-Cache says hit')), 'a 404 with X-LiteSpeed-Cache: hit: the line names that header');

    fs.rmSync(tmp, { recursive: true, force: true });
    console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll cache-clue checks passed');
    process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ } process.exit(1); });
