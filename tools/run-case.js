// usage: node tools/run-case.js <status|none> [--no-probe|--no-url|--env-missing]   (local fixture server on 127.0.0.1; prints the live rows and the report path)
const http = require('http'), fs = require('fs'), os = require('os'), path = require('path'), { spawn } = require('child_process');
const ROOT = process.env.PG_ROOT || path.join(__dirname, '..');   // the repository this file sits in (tools/..), so it works from any folder
const arg = process.argv[2] || '200', code = Number(arg) || 200, mode = process.argv[3] || '';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 's3a-'));
const body = code === 200 ? '<!doctype html><html><head><title>Fixture</title></head><body><h1>Fixture shop</h1><p>The page works and has enough text to look like a real page.</p></body></html>' : '<html><body>There has been a critical error on this website.</body></html>';
// 5xx-stop: a 200 page whose three scripts answer 503 (the probe stops for server instability); reset-stop: its scripts drop the connection (the probe stops for connection resets)
const PAGE = '<!doctype html><html><head><title>Fixture</title><script src="/a.js"></script><script src="/b.js"></script><script src="/c.js"></script></head><body><h1>Fixture shop</h1><p>The page works and has enough text to look like a real page.</p></body></html>';
// plugins: a realistic WordPress-like page: several plugins and a theme in script/style addresses, a bad slug, a very long version, a script tag inside a comment, the generator tag and two plugin comments
const PLUGINS_PAGE = `<!doctype html><html><head><title>Fixture</title>
<meta name="generator" content="WordPress 6.4.2" />
<!-- This site is optimized with the Yoast SEO plugin v22.0 - https://yoast.com/wordpress/plugins/seo/ -->
<link rel="stylesheet" href="/wp-content/themes/twentytwentyfour/style.css?ver=1.2" />
<link rel="stylesheet" href="/wp-content/plugins/woo-fixture/assets/a.css?ver=8.3.1&amp;nonce=abcdef123456" />
<script src="/wp-content/plugins/elementor-fixture/b.js?ver=3.18.2"></script>
<script src="/wp-content/plugins/long-fixture/c.js?ver=1234567890123456789012345"></script>
<script src="/wp-content/plugins/bad%20slug/d.js?ver=1.0"></script>
<script src="/wp-content/plugins/nover-fixture/e.js"></script>
<script src="/wp-content/plugins/elementor/f.js?ver=3.18.2"></script><script src="/wp-content/plugins/litespeed-cache/g.js?ver=6.0"></script>
</head><body><h1>Fixture shop</h1><p>The page works and has enough text to look like a real page.</p>
<!-- <script src="/wp-content/plugins/ghost-fixture/x.js?ver=9"></script> -->
<!-- This website is like a Rocket, isn't it? Performance optimized by WP Rocket. Learn more: https://wp-rocket.me -->
</body></html>`;
const sv = http.createServer((q, r) => {
  if (arg === 'plugins-asset404') {   // the plugins page (a matching pair) plus a script that is a 404
    if (q.url === '/') { r.writeHead(200, { 'Content-Type': 'text/html' }); return r.end(PLUGINS_PAGE.replace('</head>', '<script src="/missing.js"></script></head>')); }
    if (q.url === '/missing.js') { r.writeHead(404, { 'Content-Type': 'text/plain' }); return r.end('nope'); }
    r.writeHead(200, { 'Content-Type': /\.css/.test(q.url) ? 'text/css' : 'application/javascript' }); return r.end('/* ok */');
  }
  if (arg === 'hscroll') { if (q.url === '/') { r.writeHead(200, { 'Content-Type': 'text/html' }); return r.end('<!doctype html><html><head><title>Fixture</title></head><body><h1>Fixture shop</h1><p>The page works and has enough text to look like a real page.</p><div style="width:3000px;height:20px;background:#ccc">wide</div></body></html>'); } r.writeHead(404); return r.end('x'); }
  if (arg === 'asset404') {   // a 200 page whose script is a 404, and one that throws a console error (a page error)
    if (q.url === '/') { r.writeHead(200, { 'Content-Type': 'text/html' }); return r.end('<!doctype html><html><head><title>Fixture</title><script src="/missing.js"></script></head><body><h1>Fixture shop</h1><p>The page works and has enough text to look like a real page.</p></body></html>'); }
    r.writeHead(404, { 'Content-Type': 'text/plain' }); return r.end('nope');
  }
  if (arg === 'plugins500') { if (q.url === '/') { r.writeHead(500, { 'Content-Type': 'text/html' }); return r.end(PLUGINS_PAGE); } r.writeHead(200, { 'Content-Type': /\.css/.test(q.url) ? 'text/css' : 'application/javascript' }); return r.end('/* ok */'); }
  if (arg === 'plugins') {
    if (q.url === '/') { r.writeHead(200, { 'Content-Type': 'text/html' }); return r.end(PLUGINS_PAGE); }
    r.writeHead(200, { 'Content-Type': /\.css/.test(q.url) ? 'text/css' : 'application/javascript' }); return r.end(/\.css/.test(q.url) ? 'body{}' : '/* ok */');
  }
  if (arg === '5xx-stop' || arg === 'reset-stop') {
    if (q.url === '/') { r.writeHead(200, { 'Content-Type': 'text/html' }); return r.end(PAGE); }
    if (arg === 'reset-stop') return q.socket.destroy();
    r.writeHead(503, { 'Content-Type': 'text/plain' }); return r.end('unavailable');
  }
  r.writeHead(code, { 'Content-Type': 'text/html' }); r.end(body);
});
sv.listen(0, '127.0.0.1', () => {
  const url = `http://127.0.0.1:${sv.address().port}/`;
  if (arg === 'unreachable') { sv.close(); }   // the port is closed again: the probe cannot reach the site
  const args = [path.join(ROOT, 'scripts/plugin-guard.js'), '--description', 'White screen after an update', '--yes'];
  if (mode === '--root') { const site = path.join(tmp, 'site'); fs.mkdirSync(path.join(site, 'wp-content/plugins/demo'), { recursive: true }); fs.mkdirSync(path.join(site, 'wp-content/themes/t'), { recursive: true }); fs.writeFileSync(path.join(site, 'wp-content/plugins/demo/demo.php'), '<?php\n/* Plugin Name: Demo */\nadd_action("init", function(){});\n'); fs.writeFileSync(path.join(site, 'wp-config.php'), "<?php\n$table_prefix='wp_';\n"); args.push('--root', site, '--no-replica'); } else args.push('--no-files');
  if (mode !== '--no-url') args.push('--url', url);
  if (mode !== '--env-missing' && mode !== '--no-url') args.push('--env', 'local');
  if (mode === '--no-probe') args.push('--no-probe');
  if (mode === '--log') { const lf = path.join(tmp, 'debug.log'); fs.writeFileSync(lf, '[19-Nov-2026 10:00:01 UTC] PHP Fatal error:  Uncaught Error: Call to undefined function acme_missing() in /srv/example/wp-content/plugins/acme-slider/acme.php:12\n'); args.push('--log', lf); }
  if (process.env.SHOW) process.env.SHOWOUT = '1';
  const env = { ...process.env, PLUGIN_GUARD_ISSUES: path.join(tmp, 'issues'), PG_PROBE_NAV_DELAY_MS: '0', PG_PROBE_REQUEST_DELAY_MS: '0', PG_PROBE_COOLDOWN_FILE: path.join(tmp, 'cool.json') };
  const c = spawn(process.execPath, args, { cwd: tmp, env }); let out = '';
  c.stdout.on('data', d => out += d); c.stderr.on('data', d => out += d);
  c.on('close', st => { sv.close();
    if (!fs.existsSync(path.join(tmp,'issues'))) { console.log(out.slice(0,700)); return; }
    const d = fs.readdirSync(path.join(tmp, 'issues')).filter(n => /^iss-/.test(n))[0];
    const fj = d && path.join(tmp, 'issues', d, 'result', 'findings.json');
    if (process.env.SHOW) console.log(out.split('\n').slice(0, 60).join('\n'));
    console.log('exit', st, '\nreport folder:', d ? path.join(tmp, 'issues', d, 'result') : '(none)');
    if (fj && fs.existsSync(fj)) { const f = JSON.parse(fs.readFileSync(fj)); const pj=path.join(tmp,'issues',d,'work','probe.json'); if(fs.existsSync(pj)){const p=JSON.parse(fs.readFileSync(pj));console.log('probe: planned=',JSON.stringify(p.planned&&p.planned.loads),'loaded=',p.pages.filter(x=>x.loaded).length,'entries=',p.pages.length,'protection=',JSON.stringify(p.protection&&p.protection.kind||p.protection));}
    try{const ev=JSON.parse(fs.readFileSync(path.join(tmp,'issues',d,'work','evidence.json')));const st=(ev.steps||[]).find(x=>x.id==='live-probe');console.log('step:',JSON.stringify(st&&{status:st.status,reason:st.reason&&st.reason.slice(0,260)}));const pj2=JSON.parse(fs.readFileSync(path.join(tmp,'issues',d,'work','probe.json')));console.log('protection:',JSON.stringify(pj2.protection));console.log('skipped:',JSON.stringify(pj2.pages.filter(x=>x.skipped).map(x=>x.skipped)));}catch(e){console.log('nostep',e.message)}
    console.log('conflicts:', JSON.stringify((f.live_conflicts||{}).lines||null, null, 1));
    console.log('signals:', JSON.stringify(f.live_signals||null));
    console.log('verdict:', f.verdict.label, '|', f.confidence_text); console.log(JSON.stringify(f.live_checks || 'no live_checks field')); console.log(f.checkpoints.items.filter(i => /^cp-(38|39|40|41|43|44|45)$/.test(i.id)).map(i => `${i.id} ${i.result}: ${i.reason}`).join('\n')); }
    else console.log(out.slice(0, 600));
  });
});
