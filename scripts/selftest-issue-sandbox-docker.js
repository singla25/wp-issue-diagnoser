#!/usr/bin/env node
// Self-test of issue mode, step 7, part 3: the sandbox against a REAL Docker daemon. It SKIPS (exit 0, clearly labelled) when Docker is not
// usable or the three pinned images are not present locally (`npm run guard:setup-sandbox`). Plugin Guard never pulls anything on its own.
// What it proves that the fake-docker suite cannot: `docker inspect` of the running containers shows every safeguard, the published port is on
// 127.0.0.1, the containers can really not reach the internet, and teardown leaves nothing behind (also after SIGINT).

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const crypto = require('crypto');
const sandbox = require('../issue/sandbox');
function hashTree(dir) { const h = crypto.createHash('sha256'); (function walk(d) { for (const n of fs.readdirSync(d).sort()) { const f = path.join(d, n), st = fs.lstatSync(f); h.update(`${path.relative(dir, f)}|${st.isSymbolicLink() ? 'l' : st.isDirectory() ? 'd' : 'f'}|${st.mode}|`); if (st.isDirectory()) walk(f); else if (st.isFile()) h.update(fs.readFileSync(f)); } })(dir); return h.digest('hex'); }

const pf = sandbox.preflight({});
if (!pf.ok) { console.log(`SKIPPED (not run): the real-Docker sandbox tests need a usable daemon and the pinned images.\n  reason: ${pf.reason}\n  These tests are written but were NOT executed in this environment, so nothing here is claimed as verified.`); process.exit(0); }

let failures = 0;
const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`); if (!c) failures++; };
const dk = args => spawnSync('docker', args, { encoding: 'utf8' });
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-dk-'));
const SITE = path.join(tmp, 'site');
fs.mkdirSync(path.join(SITE, 'wp-content', 'plugins', 'probe-plugin'), { recursive: true });
fs.mkdirSync(path.join(SITE, 'wp-content', 'themes'), { recursive: true });
fs.writeFileSync(path.join(SITE, 'wp-content', 'plugins', 'probe-plugin', 'probe-plugin.php'), "<?php\n/* Plugin Name: Probe Plugin */\n");
const SB = path.join(tmp, 'sandboxes');
const SITE_HASH = hashTree(SITE);
let seq = 0;
const newId = () => `iss-20261028-2000${String(seq++).padStart(2, '0')}-abcde${seq}`;
const labelled = () => { const l = sandbox.labelled({ dockerBin: 'docker', runner: spawnSync, env: process.env }); return l.containers.length + l.volumes.length + l.networks.length; };

(async () => {
    const before = labelled();
    const id = newId();
    const h = sandbox.create(id, { root: SITE, sandboxesRoot: SB });
    try {
        const ids = dk(['ps', '-q', '--filter', `label=pg.project=${h.project}`]).stdout.split('\n').filter(Boolean);
        ok(ids.length === 3, `three containers run for project ${h.project}`);
        for (const cid of ids) {
            const j = JSON.parse(dk(['inspect', cid]).stdout)[0], hc = j.HostConfig, name = j.Name;
            ok(hc.Privileged === false, `${name}: not privileged`);
            ok((hc.CapDrop || []).includes('ALL'), `${name}: cap_drop ALL`);
            ok(JSON.stringify(hc.SecurityOpt) === '["no-new-privileges:true"]', `${name}: no-new-privileges and nothing else`);
            ok(hc.NetworkMode !== 'host' && hc.PidMode !== 'host' && hc.IpcMode !== 'host', `${name}: no host network / pid / ipc`);
            ok(!(j.Mounts || []).some(m => /docker\.sock/.test(m.Source || '')), `${name}: no docker.sock mount`);
            ok(hc.Memory > 0 && hc.NanoCpus > 0 && hc.PidsLimit > 0, `${name}: memory ${hc.Memory} / cpus ${hc.NanoCpus} / pids ${hc.PidsLimit} limits are set`);
            ok(Object.values(hc.PortBindings || {}).flat().every(b => b.HostIp === '127.0.0.1'), `${name}: every published port is bound to 127.0.0.1`);
            ok(/@sha256:[0-9a-f]{64}$/.test(j.Config.Image) || /^sha256:/.test(j.Image), `${name}: started from a digest-pinned image (${j.Config.Image})`);
            ok(j.Config.Labels['pg.sandbox'] === '1' && j.Config.Labels['pg.owner'] === 'plugin-guard', `${name}: carries the Plugin Guard labels`);
        }
        const net = JSON.parse(dk(['network', 'inspect', `${h.project}_back`]).stdout)[0];
        ok(net.Internal === true, 'the database/WP-CLI network is internal (no route out)');
        const out = spawnSync('docker', ['compose', '-p', h.project, '-f', h.composeFile, 'exec', '-T', 'cli', 'php', '-r', "echo @file_get_contents('http://1.1.1.1/', false, stream_context_create(['http'=>['timeout'=>4]])) === false ? 'BLOCKED' : 'REACHED';"], { encoding: 'utf8' });
        ok(/BLOCKED/.test(out.stdout), 'the WP-CLI container cannot reach the internet');
        const web = spawnSync('docker', ['compose', '-p', h.project, '-f', h.composeFile, 'exec', '-T', 'wordpress', 'php', '-r', "echo @file_get_contents('http://example.com/', false, stream_context_create(['http'=>['timeout'=>4]])) === false ? 'BLOCKED' : 'REACHED';"], { encoding: 'utf8' });
        ok(/BLOCKED/.test(web.stdout), 'the web container cannot reach a HOST NAME (DNS points nowhere); a raw IP connection is the documented limit and is deliberately not exercised here');
        const mu = h.wp.run(['plugin', 'list', '--field=name']);
        ok(mu.ok && /probe-plugin/.test(mu.stdout), 'WP-CLI works inside the sandbox and sees the copied plugin');
        ok(fs.statSync(h.dir).mode % 512 === 0o700 % 512 && (fs.statSync(h.composeFile).mode & 0o777) === 0o600, 'sandbox folder 0700 and compose.json 0600 on the real filesystem');
    } finally { h.destroy(); }
    ok(labelled() === before, 'after destroy() no labelled container, volume or network is left');

    // SIGINT in a child process
    const id2 = newId(), ready = path.join(tmp, 'ready');
    const code = `const sb=require(${JSON.stringify(path.join(__dirname, '..', 'issue', 'sandbox'))});const h=sb.create(${JSON.stringify(id2)},{root:${JSON.stringify(SITE)},sandboxesRoot:${JSON.stringify(SB)}});require('fs').writeFileSync(${JSON.stringify(ready)},'1');setInterval(()=>{},1000);`;
    const c = spawn(process.execPath, ['-e', code], { stdio: 'inherit' });
    const done = new Promise(r => c.on('exit', r));
    for (let i = 0; i < 600 && !fs.existsSync(ready); i++) await new Promise(r => setTimeout(r, 500));
    const running = labelled();
    c.kill('SIGINT'); await done;
    ok(running > before && labelled() === before && !fs.existsSync(path.join(SB, id2)), `SIGINT: ${running - before} resources while running, none afterwards, folder removed`);
    ok(hashTree(SITE) === SITE_HASH, 'the original site tree is byte-for-byte unchanged after the real containers ran and were destroyed');
    fs.rmSync(tmp, { recursive: true, force: true });
    console.log(failures ? `\n${failures} FAILED` : '\nAll checks passed');
    process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); try { sandbox.sweep({}); } catch { /* ignore */ } process.exit(1); });
