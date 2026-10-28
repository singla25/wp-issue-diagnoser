// WP-CLI wrapper that can only READ. Every call must match the allow-list below, never goes through a shell,
// and always passes --skip-plugins --skip-themes so a (possibly infected) plugin's code is not executed
// just because we looked at the site. The site's database password is never read or printed.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const OPTION_NAMES = new Set(['siteurl', 'home', 'users_can_register', 'default_role', 'admin_email', 'template', 'stylesheet', 'WPLANG', 'blog_public']);
const FORBIDDEN_SQL = /;|\binto\s+(out|dump)file\b|\bload_file\b|\bsleep\s*\(|\bbenchmark\s*\(|--|\/\*/i;

const ALLOWED = [
    a => a[0] === 'core' && a[1] === 'version',
    a => a[0] === 'core' && a[1] === 'is-installed',
    a => a[0] === 'plugin' && a[1] === 'list',
    a => a[0] === 'theme' && a[1] === 'list',
    a => a[0] === 'user' && a[1] === 'list',
    a => a[0] === 'cron' && a[1] === 'event' && a[2] === 'list',
    a => a[0] === 'super-admin' && a[1] === 'list',
    a => a[0] === 'site' && a[1] === 'list',
    a => a[0] === 'db' && a[1] === 'prefix',
    a => a[0] === 'option' && a[1] === 'get' && OPTION_NAMES.has(a[2]),
    a => a[0] === 'db' && a[1] === 'query' && /^\s*select\s/i.test(a[2] || '') && !FORBIDDEN_SQL.test(a[2])
];

class WpCli {
    constructor({ bin = 'wp', path, timeoutMs = 60000, runner = spawnSync } = {}) {
        this.bin = bin;
        this.path = path;
        this.timeoutMs = timeoutMs;
        this.runner = runner;
        this.commands = []; // audit trail
    }

    // The ONE write this wrapper can cause: `wp db export <file>`, a read of the database, and only to the fixed dump path of a sandbox folder
    // (<sandboxes>/iss-…/db/dump.sql, owner-only). No other path, no extra flags (no --tables, no --result-file, no stdout).
    static exportAllowed(args, sandboxesRoot) {
        if (args.length !== 3 || args[0] !== 'db' || args[1] !== 'export') return false;
        const file = args[2];
        if (typeof file !== 'string' || !path.isAbsolute(file) || file.includes('\0') || /(^|[\/\\])\.\.([\/\\]|$)/.test(file)) return false;
        const root = path.resolve(sandboxesRoot);
        if (path.dirname(path.dirname(file)) === root || path.relative(root, file).split(path.sep).length !== 3) return false;
        if (!/^iss-\d{8}-\d{6}-[0-9a-f]{6}$/.test(path.relative(root, file).split(path.sep)[0]) || path.relative(root, file).split(path.sep).slice(1).join('/') !== 'db/dump.sql') return false;
        try { const d = fs.lstatSync(path.dirname(file)); if (!d.isDirectory() || d.isSymbolicLink()) return false; } catch { return false; }
        try { const f = fs.lstatSync(file); if (!f.isFile() || f.isSymbolicLink()) return false; } catch { /* does not exist yet: fine */ }
        return true;
    }
    exportDatabase(file, sandboxesRoot) {
        if (!WpCli.exportAllowed(['db', 'export', file], sandboxesRoot)) throw new Error(`WP-CLI command not allowed (the database export is only allowed to <sandboxes>/iss-…/db/dump.sql): wp db export ${String(file).slice(0, 80)}`);
        fs.writeFileSync(file, '', { mode: 0o600 }); fs.chmodSync(file, 0o600);   // owner-only before a single byte of real data is written
        this.exportOk = file;
        try { return this.run(['db', 'export', file]); } finally { this.exportOk = null; try { fs.chmodSync(file, 0o600); } catch { /* not created */ } }
    }
    run(args) {
        if (!(this.exportOk && args.length === 3 && args[2] === this.exportOk && args[0] === 'db' && args[1] === 'export') && !ALLOWED.some(rule => rule(args))) throw new Error(`WP-CLI command not allowed (read-only list): wp ${args.join(' ')}`);
        const full = [...args, `--path=${this.path}`, '--skip-plugins', '--skip-themes', '--no-color'];
        if (typeof process.getuid === 'function' && process.getuid() === 0) full.push('--allow-root');
        this.commands.push(`wp ${args.join(' ')}`.slice(0, 160));
        const r = this.runner(this.bin, full, { encoding: 'utf8', timeout: this.timeoutMs, maxBuffer: 20 * 1024 * 1024 });
        if (r.error) return { ok: false, error: r.error.code === 'ENOENT' ? 'WP-CLI (wp) is not installed on this computer' : r.error.message };
        if (r.status !== 0) return { ok: false, error: (r.stderr || r.stdout || `exit ${r.status}`).trim().split('\n')[0].slice(0, 200), dbDown: /database connection|Error establishing|Access denied|Unknown database/i.test(r.stderr || '') };
        return { ok: true, stdout: r.stdout };
    }

    json(args) {
        const r = this.run([...args, '--format=json']);
        if (!r.ok) return r;
        try { return { ok: true, data: JSON.parse(r.stdout || 'null') }; } catch { return { ok: false, error: `WP-CLI returned something that is not JSON for: wp ${args.join(' ')}` }; }
    }

    // SELECT only; returns rows as arrays of tab-separated columns.
    query(sql) {
        const r = this.run(['db', 'query', sql, '--skip-column-names']);
        return r.ok ? { ok: true, rows: r.stdout.split('\n').filter(Boolean).map(l => l.split('\t')) } : r;
    }

    option(name) {
        const r = this.run(['option', 'get', name]);
        return r.ok ? { ok: true, value: r.stdout.trim() } : r;
    }
}

module.exports = { WpCli, ALLOWED };
