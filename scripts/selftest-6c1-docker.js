#!/usr/bin/env node
// Self-test of TEST-COPY-SPEC Part 6c-1 against a REAL Docker daemon: a sandbox built from the fixture database export
// (scripts/fixtures/issue/dump/wp-site.sql.txt) with the default (PHP 8.3) images. It SKIPS LOUDLY (exit 0, a SKIP line saying nothing was
// verified) when Docker is not usable or the pinned images are missing (`npm run guard:setup-sandbox`). Nothing is pulled.
// What it proves: from INSIDE the web container (as www-data) a raw TCP connection to a public IP, fsockopen and cURL to an IP, an SMTP connection
// to a public IP and PHP mail() all fail, and the container has no default route (/proc/net/route; the proxy, the control, has one), while the
// database and the proxy answer; a page loads through the proxy on 127.0.0.1:<port>, wp-login.php and the REST API answer 200, redirects use
// that address, siteurl and home are rewritten; the proxy is not a forward proxy (an absolute URI gets the sandbox's own WordPress, CONNECT
// gets 400), runs as uid 33 on a read-only file system; nothing labelled and no anonymous volume is left; a build WITHOUT a dump keeps the old
// topology. No request leaves this computer: every "fails" check is a connection attempt that has no route (it ends at once, errno 101).

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const sandbox = require('../issue/sandbox');
const proxy = require('../issue/sandbox-proxy');

const pf = sandbox.preflight({});
if (!pf.ok) { console.log(`SKIP  selftest-6c1-docker was NOT run: it needs a usable Docker daemon and the pinned sandbox images.\n  reason: ${pf.reason}\n  Nothing in this suite is claimed as verified in this environment.`); process.exit(0); }

let failures = 0;
const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`); if (!c) failures++; };
const group = t => console.log(`\n== ${t}`);
const dk = (args, o = {}) => spawnSync('docker', args, { encoding: 'utf8', timeout: 120000, ...o });
const labelled = () => { const l = sandbox.labelled({ dockerBin: 'docker', runner: spawnSync, env: process.env }); return l.containers.length + l.volumes.length + l.networks.length; };
const get = (url, o = {}) => new Promise(res => { const q = http.get(url, { timeout: 30000, ...o }, r => { let b = ''; r.setEncoding('utf8'); r.on('data', c => { b += c; }); r.on('end', () => res({ status: r.statusCode, body: b, location: r.headers.location })); }); q.on('timeout', () => q.destroy(new Error('timeout'))); q.on('error', e => res({ status: 0, body: '', error: e.message })); });
const idOf = (project, role) => dk(['ps', '-a', '-q', '--filter', `label=pg.project=${project}`, '--filter', `label=pg.role=${role}`]).stdout.trim().split('\n')[0];
const inspect = id => JSON.parse(dk(['inspect', id]).stdout)[0];

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-6c1-dk-'));
const SITE = path.join(tmp, 'site');
fs.mkdirSync(path.join(SITE, 'wp-content', 'plugins', 'probe-plugin'), { recursive: true });
fs.mkdirSync(path.join(SITE, 'wp-content', 'themes'), { recursive: true });
fs.writeFileSync(path.join(SITE, 'wp-content', 'plugins', 'probe-plugin', 'probe-plugin.php'), "<?php\n/* Plugin Name: Probe Plugin */\n");
const SB = path.join(tmp, 'sandboxes');
const DUMP = path.join(tmp, 'in', 'site.sql');
fs.mkdirSync(path.dirname(DUMP)); fs.copyFileSync(path.join(__dirname, 'fixtures', 'issue', 'dump', 'wp-site.sql.txt'), DUMP);
let seq = 0;
const newId = () => `iss-20261105-62${String(seq++).padStart(4, "0")}-${crypto.randomBytes(3).toString('hex')}`;

// run inside a container; every connection has a 3 s timeout; prints one JSON object
const EGRESS = String.raw`<?php
function tcp($h, $p) { $t = microtime(true); $s = @stream_socket_client("tcp://$h:$p", $en, $es, 3); $ms = (int) ((microtime(true) - $t) * 1000); if ($s) { fclose($s); return ['ok' => true, 'ms' => $ms]; } return ['ok' => false, 'errno' => $en, 'err' => $es, 'ms' => $ms]; }
$r = [];
$r['tcp_1.1.1.1:53'] = tcp('1.1.1.1', 53);
$t = microtime(true); $fp = @fsockopen('8.8.8.8', 53, $en, $es, 3); $r['fsockopen_8.8.8.8:53'] = $fp ? ['ok' => true] : ['ok' => false, 'errno' => $en, 'err' => $es]; if ($fp) fclose($fp);
if (function_exists('curl_init')) { $c = curl_init('http://1.1.1.1/'); curl_setopt_array($c, [CURLOPT_RETURNTRANSFER => true, CURLOPT_CONNECTTIMEOUT => 3, CURLOPT_TIMEOUT => 5, CURLOPT_NOBODY => true]); $x = curl_exec($c); $r['curl_http://1.1.1.1/'] = $x !== false ? ['ok' => true] : ['ok' => false, 'err' => curl_error($c)]; } else $r['curl_http://1.1.1.1/'] = ['ok' => false, 'err' => 'no curl extension'];
$r['smtp_8.8.8.8:25'] = tcp('8.8.8.8', 25);
$r['smtp_1.1.1.1:25'] = tcp('1.1.1.1', 25);
$h = gethostbyname('example.com'); $r['dns_example.com'] = ['ok' => $h !== 'example.com', 'answer' => $h];
$m = @mail('nobody@example.invalid', 'pg', 'pg'); $r['mail()'] = ['ok' => $m !== false, 'returned' => var_export($m, true)];
$r['db:3306'] = tcp('db', 3306);
$r['proxy:80'] = tcp('proxy', 80);
$route = @file_get_contents('/proc/net/route'); $r['default_route'] = ['ok' => (bool) preg_match('/^\S+\s+00000000\s/m', (string) $route)];
echo json_encode($r);
`;
// from inside the web container: is the proxy a forward proxy? (absolute URI to a public IP, CONNECT)
const RELAY = String.raw`<?php
$out = [];
foreach (['abs' => "GET http://1.1.1.1/ HTTP/1.1\r\nHost: 1.1.1.1\r\nConnection: close\r\n\r\n", 'connect' => "CONNECT 1.1.1.1:443 HTTP/1.1\r\nHost: 1.1.1.1:443\r\n\r\n"] as $k => $q) {
  $s = @stream_socket_client('tcp://proxy:80', $e, $es, 3); if (!$s) { $out[$k] = ['status' => 0, 'err' => $es]; continue; }
  fwrite($s, $q); stream_set_timeout($s, 20); $resp = (string) stream_get_contents($s, 20000); fclose($s);
  preg_match('/^HTTP\/\S+ (\d+)/', $resp, $m); preg_match('/^Location: (\S+)/mi', $resp, $l);
  $out[$k] = ['status' => (int) ($m[1] ?? 0), 'location' => $l[1] ?? null, 'cloudflare' => (bool) preg_match('/cloudflare/i', $resp)];
}
echo json_encode($out);
`;
const inContainer = (h, svc, php, user) => { const r = dk(['compose', '-p', h.project, '-f', h.composeFile, 'exec', '-T', ...(user ? ['-u', user] : []), svc, 'php'], { input: php, timeout: 180000 }); try { return JSON.parse(r.stdout); } catch { return { error: (r.stderr || r.stdout || '').slice(0, 300) }; } };

(async () => {
    const before = labelled();
    const anonBefore = new Set(dk(['volume', 'ls', '-q', '--filter', 'dangling=true']).stdout.split('\n').filter(Boolean));

    group('a sandbox built from the fixture export: the web container behind the front proxy');
    const h = sandbox.create(newId(), { root: SITE, sandboxesRoot: SB, dump: DUMP });
    try {
        const spec = JSON.parse(fs.readFileSync(h.composeFile, 'utf8'));
        ok(h.topology === 'proxied' && spec.services.proxy && spec.services.proxy.image === spec.services.wordpress.image, `topology "proxied"; the proxy uses the pinned wordpress image (${spec.services.proxy.image.slice(0, 30)}...)`);
        const web = inspect(idOf(h.project, 'wordpress')), px = inspect(idOf(h.project, 'proxy'));
        ok(Object.keys(web.NetworkSettings.Networks).join() === `${h.project}_back` && !Object.keys(web.HostConfig.PortBindings || {}).length, `web container: only on ${h.project}_back (internal), no published port`);
        ok(JSON.parse(dk(['network', 'inspect', `${h.project}_back`]).stdout)[0].Internal === true && JSON.parse(dk(['network', 'inspect', `${h.project}_front`]).stdout)[0].Internal === false && Object.keys(px.NetworkSettings.Networks).sort().join() === [`${h.project}_back`, `${h.project}_front`].sort().join(), 'the proxy is on back (internal) and front (route out); it is the only container on front');
        const pb = Object.values(px.HostConfig.PortBindings || {}).flat();
        ok(pb.length === 1 && pb[0].HostIp === '127.0.0.1' && px.HostConfig.Privileged === false && (px.HostConfig.CapAdd || []).length === 0 && JSON.stringify(px.HostConfig.CapDrop) === '["ALL"]' && px.HostConfig.ReadonlyRootfs === true && px.Config.User === '33:33' && JSON.stringify(px.HostConfig.SecurityOpt) === '["no-new-privileges:true"]', 'proxy (docker inspect): one port on 127.0.0.1, not privileged, CapDrop ALL, CapAdd none, read-only root file system, user 33:33, no-new-privileges');
        ok(JSON.stringify(px.HostConfig.Tmpfs) === JSON.stringify({ '/run/apache2': 'size=1m,mode=0700,uid=33,gid=33' }) && JSON.stringify(px.HostConfig.Dns) === '["192.0.2.1"]' && !(px.Config.Env || []).some(e => /^WORDPRESS_/.test(e)), 'proxy: tmpfs only /run/apache2, DNS 192.0.2.1, no WORDPRESS_* variables (no environment given)');
        const mounts = px.Mounts.map(m => `${m.Type}:${m.Type === 'volume' ? m.Name : m.Source}->${m.Destination}:${m.RW ? 'rw' : 'ro'}`).sort();
        ok(mounts.length === 2 && mounts.includes(`bind:${path.join(h.dir, 'proxy', 'proxy.conf')}->/etc/pg-proxy/proxy.conf:ro`) && mounts.includes(`volume:${h.project}_proxyhtml->/var/www/html:ro`), `proxy mounts: the config read-only and the labelled empty volume at /var/www/html (${mounts.join(', ')})`);
        const vol = JSON.parse(dk(['volume', 'inspect', `${h.project}_proxyhtml`]).stdout)[0];
        ok(vol.Labels['pg.sandbox'] === '1' && vol.Labels['pg.project'] === h.project, 'that volume carries the Plugin Guard labels (found by teardown and the sweep)');
        const startStep = h.steps.find(s => s.id === 'start');
        ok(startStep && startStep.reason.includes(h.url) && /^http:\/\/127\.0\.0\.1:\d+$/.test(h.url), `the proxy port stayed the same across the web container's stop and start (${h.url})`);

        group('from INSIDE the web container (as www-data): no route out; the database and the proxy answer');
        const e = inContainer(h, 'wordpress', EGRESS, '33');
        const failed = k => e[k] && e[k].ok === false;
        const unreachable = k => failed(k) && (e[k].errno === 101 || /unreachable/i.test(e[k].err || ''));
        ok(unreachable('tcp_1.1.1.1:53'), `raw TCP to 1.1.1.1:53 fails: ${JSON.stringify(e['tcp_1.1.1.1:53'] || e)}`);
        ok(unreachable('fsockopen_8.8.8.8:53'), `fsockopen to 8.8.8.8:53 fails: ${JSON.stringify(e['fsockopen_8.8.8.8:53'])}`);
        ok(failed('curl_http://1.1.1.1/'), `PHP cURL to http://1.1.1.1/ fails: ${JSON.stringify(e['curl_http://1.1.1.1/'])}`);
        ok(unreachable('smtp_8.8.8.8:25') && unreachable('smtp_1.1.1.1:25'), `SMTP (port 25) to a public IP fails: ${JSON.stringify(e['smtp_8.8.8.8:25'])}`);
        ok(failed('dns_example.com'), `a host-name lookup fails (example.com -> ${e['dns_example.com'] && e['dns_example.com'].answer})`);
        ok(e['mail()'] && e['mail()'].returned === 'false', `PHP mail() returns false (${e['mail()'] && e['mail()'].returned})`);
        ok(e['db:3306'] && e['db:3306'].ok === true && e['proxy:80'] && e['proxy:80'].ok === true, 'db:3306 and proxy:80 connect (the internal network works)');
        ok(e.default_route && e.default_route.ok === false, 'the web container has no default route (/proc/net/route)');
        const ctl = dk(['compose', '-p', h.project, '-f', h.composeFile, 'exec', '-T', 'proxy', 'cat', '/proc/net/route']);
        ok(/^\S+\s+00000000\s/m.test(ctl.stdout), 'control (offline): the proxy container, on the network with a route out, does have a default route; the web container does not');

        group('through the proxy, from this computer (127.0.0.1 only)');
        const page = await get(`${h.url}/?p=4`);
        ok(page.status === 200 && page.body.includes('PG-FIXTURE-MARKER-6A'), `a page loads through the proxy with the marker text of the imported post (HTTP ${page.status}${page.error ? ' ' + page.error : ''})`);
        const login = await get(`${h.url}/wp-login.php`), rest = await get(`${h.url}/?rest_route=/`);
        ok(login.status === 200 && /user_login|loginform/.test(login.body), `wp-login.php answers 200 (${login.status})`);
        let restJson = null; try { restJson = JSON.parse(rest.body); } catch { /* shown below */ }
        ok(rest.status === 200 && restJson && restJson.url === h.url && restJson.home === h.url, `the REST API answers 200 and reports url and home ${h.url} (${rest.status})`);
        const admin = await get(`${h.url}/wp-admin/`), p1 = await get(`${h.url}/?p=1`);
        ok(admin.status === 302 && String(admin.location).startsWith(`${h.url}/wp-login.php`), `a redirect uses the 127.0.0.1:<port> address (${admin.status} -> ${admin.location})`);
        ok(!p1.location || String(p1.location).startsWith(h.url), `and so does a canonical redirect (${p1.status} ${p1.location || ''})`);
        const opt = n => { const r = h.wp.run(['option', 'get', n]); return r.ok ? r.stdout.trim() : `(error: ${r.stderr.trim()})`; };
        ok(opt('siteurl') === h.url && opt('home') === h.url, `siteurl and home were rewritten to ${h.url}`);

        group('the proxy itself');
        const relay = inContainer(h, 'wordpress', RELAY, '33');
        const port = h.url.split(':').pop();
        // the answer names the sandbox's own published port, which only the sandbox's WordPress knows (its home URL): it was not passed on to 1.1.1.1
        ok(relay.abs && relay.abs.status >= 200 && relay.abs.status < 400 && !relay.abs.cloudflare && relay.abs.location && relay.abs.location.includes(`:${port}/`), `GET http://1.1.1.1/ sent to proxy:80 is answered by the sandbox's own WordPress (${relay.abs && relay.abs.status} ${relay.abs && relay.abs.location || ''}: the sandbox port), not passed on`);
        ok(relay.connect && relay.connect.status === 400, `CONNECT 1.1.1.1:443 to proxy:80 is refused with 400 (${relay.connect && relay.connect.status})`);
        const uids = dk(['compose', '-p', h.project, '-f', h.composeFile, 'exec', '-T', 'proxy', 'sh', '-c', 'for p in /proc/[0-9]*; do [ -r $p/status ] && awk \'/^Name:/{n=$2} /^Uid:/{print n, $2}\' $p/status; done']).stdout.split('\n').filter(l => /^apache2 /.test(l));
        ok(uids.length >= 2 && uids.every(l => l.endsWith(' 33')), `every apache2 process of the proxy runs as uid 33 (${uids.length} processes)`);
        const wr = dk(['compose', '-p', h.project, '-f', h.composeFile, 'exec', '-T', 'proxy', 'sh', '-c', 'touch /etc/pg-x 2>&1; touch /var/www/html/pg-x 2>&1; touch /etc/pg-proxy/proxy.conf 2>&1; true']);
        const lines = wr.stdout.split('\n');
        ok(lines.some(l => /\/etc\/pg-x'?: Read-only file system/.test(l)) && lines.some(l => /\/var\/www\/html\/pg-x'?: Read-only file system/.test(l)) && lines.some(l => /proxy\.conf'?: (Read-only file system|Permission denied)/.test(l)), `the proxy cannot write its root file system or the empty volume (read-only), nor its config (read-only mount, owned by another user): ${JSON.stringify((wr.stdout + wr.stderr).trim().slice(0, 300))}`);
        ok(fs.readFileSync(path.join(h.dir, 'proxy', 'proxy.conf'), 'utf8') === proxy.conf(), 'the config the proxy runs is the generated one');
        const logs = dk(['compose', '-p', h.project, '-f', h.composeFile, 'logs', '--no-log-prefix', 'proxy']).stdout;
        ok(/host=127\.0\.0\.1:\d+ "GET \/\?p=4 HTTP\/1\.1" 200/.test(logs), 'the proxy logs its requests to stdout (nothing is written to a file)');
    } finally { h.destroy(); }
    ok(labelled() === before && !fs.existsSync(h.dir), 'after destroy no labelled container (proxy included), volume or network is left, and the folder is gone');

    group('a build WITHOUT a database file keeps the old topology');
    const hn = sandbox.create(newId(), { root: SITE, sandboxesRoot: SB });
    try {
        const sn = JSON.parse(fs.readFileSync(hn.composeFile, 'utf8'));
        const web = inspect(idOf(hn.project, 'wordpress'));
        const pb = Object.values(web.HostConfig.PortBindings || {}).flat();
        ok(hn.topology === 'direct' && !sn.services.proxy && !idOf(hn.project, 'proxy') && pb.length === 1 && pb[0].HostIp === '127.0.0.1' && Object.keys(web.NetworkSettings.Networks).sort().join() === [`${hn.project}_back`, `${hn.project}_front`].sort().join(), 'no proxy; the web container is on back and front and publishes its own port on 127.0.0.1');
        const r = await get(`${hn.url}/`);
        ok(r.status === 200, `the fresh install answers on ${hn.url} (${r.status})`);
    } finally { hn.destroy(); }
    ok(labelled() === before, 'nothing labelled is left');
    const anonNew = dk(['volume', 'ls', '-q', '--filter', 'dangling=true']).stdout.split('\n').filter(v => v && !anonBefore.has(v));
    ok(anonNew.length === 0, `no anonymous (unlabelled) volume was created by these builds (${anonNew.length} new)`);
    fs.rmSync(tmp, { recursive: true, force: true });
    console.log(failures ? `\n${failures} FAILED` : '\nAll checks passed');
    process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); try { sandbox.sweep({}); } catch { /* ignore */ } process.exit(1); });
