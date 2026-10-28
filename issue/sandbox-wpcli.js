// WP-CLI for the SANDBOX only. A separate class from lib/wpcli.js on purpose: that one can only read the original; this one can change
// things (deactivate a plugin, switch the theme), so it must be impossible for it to ever act on anything but a sandbox.
//
// On EVERY call it re-checks, with realpath (not once at construction):
//   - the sandbox folder is a real directory (no symbolic link anywhere in its path, no "..") inside the sandboxes root;
//   - it is not the original site, not inside it, and does not contain it;
//   - compose.json is a plain file inside it, and state.json inside it names the same project (identity);
// and then runs   docker compose -p <project> -f <that compose.json> exec -T cli wp <checked args> --path=/var/www/html
// with an ARGUMENT ARRAY and no shell, in an environment rebuilt from an allow-list (a DOCKER_HOST or DOCKER_CONTEXT that points at a
// remote daemon is refused; WP_CLI_*, COMPOSE_*, LD_*, NODE_OPTIONS and everything else are dropped).
// Commands come from a closed table: unknown commands and flags are refused (no eval, shell, db drop, plugin install, --ssh, --path, ...).

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

class SandboxRefusal extends Error { constructor(msg) { super(msg); this.name = 'SandboxRefusal'; this.exitCode = 3; } }
const refuse = m => { throw new SandboxRefusal(m); };

const SAFE_PATH = '/usr/local/bin:/usr/bin:/bin';
const KEEP_ENV = ['HOME', 'LANG', 'LC_ALL', 'TMPDIR', 'XDG_RUNTIME_DIR', 'USER', 'LOGNAME'];
const LOCAL_SOCKET = /^unix:\/\/(\/var)?\/run\/docker\.sock$/;
// Rootless Docker: the socket lives in the user's own runtime folder. Accepted only for THIS user's uid, and only if the path really is a
// socket owned by this user and not writable by anyone else (otherwise another account could be answering as "Docker").
const ROOTLESS_SOCKET = /^unix:\/\/(\/run\/user\/(\d{1,10})\/docker\.sock)$/;
function checkLocalSocket(host, { uid = process.getuid(), fsApi = fs } = {}) {
    if (LOCAL_SOCKET.test(host)) return { ok: true, kind: 'system' };
    const m = ROOTLESS_SOCKET.exec(host);
    if (!m) return { ok: false, reason: `"${host}" is not a local Docker socket (only unix:///var/run/docker.sock and this user's unix:///run/user/<uid>/docker.sock are accepted; tcp://, ssh:// and every other address are refused)` };
    if (Number(m[2]) !== uid) return { ok: false, reason: `the socket ${m[1]} belongs to uid ${m[2]}, not to this user (uid ${uid})` };
    let st; try { st = fsApi.lstatSync(m[1]); } catch { return { ok: false, reason: `the socket ${m[1]} does not exist: is rootless Docker running?` }; }
    if (!st.isSocket()) return { ok: false, reason: `${m[1]} is not a socket` };
    if (st.uid !== uid) return { ok: false, reason: `${m[1]} is owned by uid ${st.uid}, not by this user (uid ${uid})` };
    if (st.mode & 0o002) return { ok: false, reason: `${m[1]} is writable by everyone` };
    return { ok: true, kind: 'rootless' };
}

// The environment a docker child process gets. Refuses setups that would send commands to another machine.
function cleanEnv(env = process.env) {
    let host = null;
    if (env.DOCKER_HOST) { const c = checkLocalSocket(env.DOCKER_HOST); if (!c.ok) refuse(`DOCKER_HOST is set to "${env.DOCKER_HOST}": ${c.reason}. Unset it.`); host = env.DOCKER_HOST; }
    if (env.DOCKER_CONTEXT && env.DOCKER_CONTEXT !== 'default') refuse(`DOCKER_CONTEXT is "${env.DOCKER_CONTEXT}", not the local default context. Unset it.`);
    if (env.DOCKER_TLS_VERIFY || env.DOCKER_CERT_PATH) refuse('DOCKER_TLS_VERIFY / DOCKER_CERT_PATH are set, which means a remote daemon. Unset them.');
    const out = { PATH: SAFE_PATH };
    for (const k of KEEP_ENV) if (env[k]) out[k] = env[k];
    if (host) out.DOCKER_HOST = host;   // only a validated local socket is passed on
    return out;
}

// ---------------------------------------------------------------- the closed command table
const SLUG = /^[a-z0-9][a-z0-9._-]{0,80}(\/[a-z0-9._-]{1,80}\.php)?$/i;
const THEME = /^[a-z0-9][a-z0-9._-]{0,80}$/i;
const OPT_NAME = /^[A-Za-z0-9_.:-]{1,191}$/;
const TEXT = /^[^\0]{0,2000}$/;
const EXAMPLE_MAIL = /^[A-Za-z0-9._+-]+@(example\.(com|org|net)|[a-z0-9-]+\.(invalid|test|example))$/i;   // RFC 2606 / 6761 names: mail can never reach a real person
const SB_URL = /^http:\/\/127\.0\.0\.1(:\d{2,5})?\/?$/;
const OLD_URL = /^https?:\/\/[A-Za-z0-9.-]+(:\d{2,5})?(\/[A-Za-z0-9._~\/-]*)?$/;
const ENUM = (...v) => new RegExp(`^(${v.join('|')})$`);
const BOOL = true;
const LIST_FLAGS = { '--status': ENUM('active', 'inactive', 'must-use', 'all'), '--field': ENUM('name', 'status', 'version', 'ID', 'user_login'), '--fields': /^[A-Za-z_,]{1,100}$/, '--format': ENUM('json', 'csv', 'table', 'count', 'yaml') };
const RULES = [
    { cmd: 'core version' }, { cmd: 'core is-installed' },
    { cmd: 'core install', flags: { '--url': SB_URL, '--title': TEXT, '--admin_user': /^[A-Za-z0-9_]{3,30}$/, '--admin_password': /^[^\0]{8,100}$/, '--admin_email': EXAMPLE_MAIL, '--skip-email': BOOL } },
    { cmd: 'plugin list', flags: LIST_FLAGS }, { cmd: 'plugin activate', pos: [SLUG], many: true, flags: {} }, { cmd: 'plugin deactivate', pos: [SLUG], many: true, min: 0, flags: { '--all': BOOL } },
    { cmd: 'plugin is-active', pos: [SLUG] },
    { cmd: 'theme list', flags: LIST_FLAGS }, { cmd: 'theme activate', pos: [THEME] }, { cmd: 'theme is-active', pos: [THEME] },
    { cmd: 'option get', pos: [OPT_NAME] }, { cmd: 'option update', pos: [OPT_NAME, TEXT] },
    { cmd: 'user create', pos: [/^[A-Za-z0-9_]{3,30}$/, EXAMPLE_MAIL], flags: { '--role': ENUM('administrator', 'editor', 'author', 'subscriber', 'customer', 'shop_manager'), '--user_pass': /^[^\0]{8,100}$/ } },
    { cmd: 'user list', flags: LIST_FLAGS },
    { cmd: 'search-replace', pos: [OLD_URL, SB_URL], flags: { '--all-tables': BOOL, '--skip-columns': ENUM('guid'), '--dry-run': BOOL } },
    { cmd: 'cache flush' }, { cmd: 'rewrite flush' }, { cmd: 'transient delete', flags: { '--all': BOOL } },
    { cmd: 'db check' }, { cmd: 'db prefix' }, { cmd: 'db tables', flags: { '--format': ENUM('json', 'csv', 'list') } },
    { cmd: 'db import', pos: [/^-$/] }   // the dump is streamed on stdin; it is never mounted into a container
];
const GLOBAL_FLAGS = { '--skip-plugins': BOOL, '--skip-themes': BOOL, '--quiet': BOOL };
const DANGEROUS_FLAG = /^--(ssh|http|path|require|exec|config|user|debug|prompt|skip-column-names|color|no-color|allow-root|url)\b/;

// -> the validated argument list (unchanged); throws SandboxRefusal
function checkArgs(args) {
    if (!Array.isArray(args) || !args.length) refuse('WP-CLI arguments must be a non-empty array');
    for (const a of args) {
        if (typeof a !== 'string') refuse('every WP-CLI argument must be a string');
        if (a.includes('\0')) refuse('a WP-CLI argument contains a NUL byte');
        if (a.length > 4096) refuse('a WP-CLI argument is longer than 4096 characters');
        if (/(^|[\/\\])\.\.([\/\\]|$)/.test(a)) refuse(`a WP-CLI argument contains ".." (path traversal): ${a.slice(0, 60)}`);
    }
        // longest matching command (two words, or one for search-replace / etc.)
    const rule = RULES.filter(r => { const w = r.cmd.split(' '); return w.every((x, i) => args[i] === x); }).sort((a, b) => b.cmd.length - a.cmd.length)[0];
    if (!rule) refuse(`"wp ${args.slice(0, 2).join(' ')}" is not an allowed sandbox command (allowed: ${[...new Set(RULES.map(r => r.cmd))].join(', ')})`);
    const nWords = rule.cmd.split(' ').length;
    const flags = { ...GLOBAL_FLAGS, ...(rule.flags || {}) }, positional = [];
    for (const a of args.slice(nWords)) {
        if (a.startsWith('-') && a !== '-') {   // a lone "-" is the stdin marker of `db import -`, a positional argument
            if (DANGEROUS_FLAG.test(a) && !(rule.flags && Object.keys(rule.flags).some(k => a === k || a.startsWith(`${k}=`)))) refuse(`the flag ${a.split('=')[0]} is never allowed (it can run code, change the target or reach another machine)`);
            const [name, ...v] = a.split('='), val = v.join('=');
            const spec = flags[name];
            if (spec === undefined) refuse(`the flag ${name} is not allowed for "wp ${rule.cmd}"`);
            if (spec === BOOL) { if (v.length) refuse(`the flag ${name} takes no value`); }
            else if (!v.length || !spec.test(val)) refuse(`the value of ${name} is not acceptable`);
        } else positional.push(a);
    }
    const pos = rule.pos || [];
    const min = rule.min !== undefined ? rule.min : pos.length;
    if (positional.length < min || (!rule.many && positional.length > pos.length)) refuse(`"wp ${rule.cmd}" needs ${rule.many ? `at least ${min}` : pos.length} argument(s), got ${positional.length}`);
    positional.forEach((p, i) => { const re = pos[Math.min(i, pos.length - 1)]; if (!re || !re.test(p)) refuse(`argument ${i + 1} of "wp ${rule.cmd}" is not acceptable: ${p.slice(0, 60)}`); });
    return args;
}

class SandboxWpCli {
    // sandboxesRoot: the folder that holds every sandbox; sandboxDir: this sandbox; originals: real paths of sites that must never be touched
    constructor({ sandboxesRoot, sandboxDir, project, originals = [], dockerBin = 'docker', runner = spawnSync, env = process.env }) {
        this.sandboxesRoot = sandboxesRoot; this.sandboxDir = sandboxDir; this.project = project; this.originals = originals; this.runner = runner; this.env = env;
        this.dockerBin = path.isAbsolute(dockerBin) ? dockerBin : (this.resolveBin(dockerBin) || dockerBin);
        this.commands = []; // audit trail (arguments only; never values of passwords)
        this.guard(); // refuse at construction too
    }
    resolveBin(name) { for (const d of String(this.env.PATH || '').split(path.delimiter)) { const f = path.join(d, name); try { if (fs.statSync(f).isFile()) return f; } catch { /* next */ } } return null; }

    // realpath on EVERY call: a folder swapped for a symlink after construction is caught here
    guard() {
        let root, real;
        try { root = fs.realpathSync(this.sandboxesRoot); } catch { refuse(`the sandboxes folder ${this.sandboxesRoot} does not exist`); }
        const lexical = path.resolve(this.sandboxDir);
        if (/(^|[\/\\])\.\.([\/\\]|$)/.test(String(this.sandboxDir))) refuse('the sandbox path contains ".."');
        try { real = fs.realpathSync(this.sandboxDir); } catch { refuse(`the sandbox folder ${this.sandboxDir} does not exist`); }
        if (real !== lexical && real !== path.join(root, path.relative(path.resolve(this.sandboxesRoot), lexical))) refuse(`the sandbox path goes through a symbolic link (${lexical} is really ${real})`);
        if (!real.startsWith(root + path.sep) || path.dirname(real) !== root) refuse(`${real} is not a sandbox folder directly inside ${root}`);
        for (const o of this.originals) {
            let or; try { or = fs.realpathSync(o); } catch { continue; }
            if (real === or || real.startsWith(or + path.sep)) refuse(`${real} is the original site or inside it. The sandbox WP-CLI never acts on the original.`);
            if (or.startsWith(real + path.sep)) refuse(`the original site ${or} is inside the sandbox folder`);
            if (root === or || root.startsWith(or + path.sep)) refuse(`the sandboxes folder is inside the original site ${or}`);
        }
        const compose = path.join(real, 'compose.json');
        let st; try { st = fs.lstatSync(compose); } catch { refuse('compose.json is missing from the sandbox folder'); }
        if (!st.isFile() || st.isSymbolicLink()) refuse('compose.json is not a plain file (symbolic links are refused)');
        let state; try { state = JSON.parse(fs.readFileSync(path.join(real, 'state.json'), 'utf8')); } catch { refuse('state.json is missing or unreadable in the sandbox folder'); }
        if (state.project !== this.project) refuse(`state.json names project "${state.project}", not "${this.project}"`);
        if (!/^pgsb[0-9a-f]{8}$/.test(this.project)) refuse('the project name is not a Plugin Guard sandbox name');
        return { real, compose };
    }

    argv(wpArgs, compose) {
        return ['compose', '-p', this.project, '-f', compose, 'exec', '-T', 'cli', 'wp', ...wpArgs, '--path=/var/www/html'];
    }
    invoke(wpArgs, { input, timeoutMs = 120000, secret = false } = {}) {
        const { real, compose } = this.guard();
        const env = cleanEnv(this.env);
        const argv = this.argv(wpArgs, compose);
        this.commands.push(`wp ${secret ? wpArgs.slice(0, 2).join(' ') + ' …' : wpArgs.join(' ')}`.slice(0, 200));
        const r = this.runner(this.dockerBin, argv, { encoding: 'utf8', timeout: timeoutMs, env, shell: false, cwd: real, input, maxBuffer: 50 * 1024 * 1024 });
        if (r.error) return { ok: false, status: -1, stdout: '', stderr: r.error.code === 'ENOENT' ? 'docker is not installed' : String(r.error.message) };
        return { ok: r.status === 0, status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
    }
    // the public interface: the closed table
    // the SQL dump, streamed on stdin (a Buffer): the 0600 file on the host is never mounted or readable by a container user
    importDump(buffer, opts = {}) { if (!Buffer.isBuffer(buffer)) refuse('the dump must be a Buffer'); return this.run(['db', 'import', '-'], { ...opts, input: buffer, timeoutMs: opts.timeoutMs || 15 * 60 * 1000 }); }
    run(wpArgs, opts = {}) { checkArgs(wpArgs); return this.invoke(wpArgs, { ...opts, secret: wpArgs.some(a => /^--(admin_password|user_pass)=/.test(a)) }); }
    // SQL generated by Plugin Guard itself (anonymisation, payment check): sent on stdin, never built from reporter text
    sql(text, opts = {}) { if (typeof text !== 'string' || text.includes('\0')) refuse('SQL must be a string without NUL bytes'); return this.invoke(['db', 'query'], { ...opts, input: text, secret: true }); }
}

module.exports = { checkLocalSocket, SandboxWpCli, SandboxRefusal, checkArgs, cleanEnv, RULES };
