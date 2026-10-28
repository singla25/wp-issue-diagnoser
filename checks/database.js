// Users, options, scheduled jobs and injected content, read through WP-CLI (read-only, see lib/wpcli.js).
// WP-CLI looks at the DATABASE OF THE LOCAL COPY: the result is only as current as the export you imported.

const { finding } = require('../lib/finding');

const CORE_CRON = new Set(['delete_expired_transients', 'recovery_mode_clean_expired_keys', 'publish_future_post', 'do_pings', 'importer_scheduled_cleanup', 'upgrader_scheduled_cleanup', 'update_network_counts', 'action_scheduler_run_queue', 'rss_gc', 'wp_scheduled_delete']);
const INJECT_POST = "post_content REGEXP 'eval[(]|base64_decode[(]|document[.]write[(]unescape|fromCharCode|<iframe[^>]*(display:none|visibility:hidden|width=.0.|height=.0.)'";
const INJECT_OPT = "option_value REGEXP 'eval[(]|base64_decode[(]|gzinflate[(]|document[.]write[(]unescape' AND option_name NOT LIKE '%transient%'";

function run(ctx) {
    const out = [];
    const wp = ctx.wp;
    const REASON = ctx.wpReason || 'needs a local copy with a working database (WP-CLI)';
    if (!wp) { for (const [id, label] of [['db-users', 'Administrator accounts'], ['db-options', 'Registration and role settings'], ['db-cron', 'Scheduled jobs'], ['db-injected', 'Injected code in posts and options'], ['db-multisite', 'Multisite']]) ctx.record(id, label, 'skipped', REASON); return out; }

    const fail = (id, label, r) => ctx.record(id, label, 'skipped', r.dbDown ? 'WP-CLI could not reach the database of the local copy: import the database export into it' : r.error);
    const base = { category: 'database', confidence: 'certain', owner: 'admin' };

    // ---- users ----
    const users = wp.json(['user', 'list', '--role=administrator', '--fields=ID,user_login,user_email,user_registered']);
    if (!users.ok) fail('db-users', 'Administrator accounts', users);
    else {
        ctx.record('db-users', 'Administrator accounts', 'done');
        const admins = users.data || [];
        const since = ctx.lastScanAt ? new Date(ctx.lastScanAt) : new Date(ctx.now - 30 * 86400000);
        for (const a of admins) {
            const login = a.user_login;
            if (/^admin(istrator)?$/i.test(login)) out.push(finding({ ...base, rule: 'user-default-admin', severity: 'P1', plugins: [], key: login, title: `An administrator is called "${login}"`, detail: 'The most-guessed username in every brute-force list.', fix: `Create a new administrator with a different name, move the content over to it, then delete "${login}".`, done: 'No administrator uses a default name.' }));
            const reg = new Date(String(a.user_registered).replace(' ', 'T') + 'Z');
            if (!isNaN(reg) && reg > since) out.push(finding({ ...base, confidence: 'possible', rule: 'user-new-admin', severity: ctx.lastScanAt ? 'P0' : 'P2', plugins: [], key: `new-${a.ID}`,
                title: `Administrator "${login}" (ID ${a.ID}) was created ${ctx.lastScanAt ? 'since the last scan' : 'in the last 30 days'}`, detail: 'Attackers who get in create a new administrator to come back later. Check this is someone you know.', evidence: [`user ID ${a.ID}, registered ${a.user_registered}`], fix: 'Confirm with the team who this is. If nobody knows them, delete the account, change all passwords and scan for backdoors.', done: 'Every administrator is a known person.' }));
            const domains = ctx.project.expectedAdminDomains || [];
            const dom = String(a.user_email || '').split('@')[1] || '';
            if (domains.length && !domains.some(d => d.toLowerCase() === dom.toLowerCase())) out.push(finding({ ...base, rule: 'user-admin-domain', severity: 'P1', plugins: [], key: `dom-${a.ID}`, title: `Administrator "${login}" uses an e-mail outside your expected domains (${dom || 'none'})`, detail: `Expected: ${domains.join(', ')}.`, fix: 'Confirm the owner, or remove the administrator role.', done: 'All administrators use expected e-mail domains.' }));
        }
        if (admins.length > 3) out.push(finding({ ...base, rule: 'user-many-admins', severity: 'P2', plugins: [], key: 'count', title: `${admins.length} administrator accounts exist`, detail: 'Every administrator is a way in. Most people need Editor, not Administrator.', evidence: admins.map(a => `${a.user_login} (ID ${a.ID})`), fix: 'Downgrade people who do not need full control.', done: 'Three or fewer administrators remain.' }));
    }

    // ---- options ----
    const getOpt = n => { const r = wp.option(n); return r.ok ? r.value : null; };
    const reg = getOpt('users_can_register');
    if (reg === null) fail('db-options', 'Registration and role settings', { error: 'could not read options', dbDown: false });
    else {
        ctx.record('db-options', 'Registration and role settings', 'done');
        const role = getOpt('default_role');
        if (reg === '1') {
            const bad = role === 'administrator' ? 'P0' : ['editor', 'author', 'contributor'].includes(role) ? 'P1' : 'P3';
            out.push(finding({ ...base, rule: 'opt-open-registration', severity: bad, plugins: [], key: 'register', title: `Anyone can register, new users get the role "${role}"`, detail: bad === 'P0' ? 'Anyone on the internet can make themselves administrator.' : bad === 'P1' ? 'New visitors get content-editing rights.' : 'Open registration invites spam accounts and is a stepping stone for privilege-escalation bugs in plugins.', fix: bad === 'P3' ? 'Switch off "Anyone can register" in Settings → General unless the site needs it.' : 'Set "New User Default Role" to Subscriber (Settings → General) and switch off registration if not needed.', commands: ['wp option update users_can_register 0'], done: 'Registration is off, or the default role is Subscriber.' }));
        }
        const siteurl = getOpt('siteurl');
        if (siteurl && /^http:\/\//i.test(siteurl) && !/localhost|127\.0\.0\.1|\.test$|\.local$/i.test(siteurl)) out.push(finding({ ...base, rule: 'opt-http-siteurl', severity: 'P2', plugins: [], key: 'siteurl', title: 'The WordPress address in the database uses http://', detail: 'Logins and cookies would travel unencrypted.', fix: 'Install a certificate and set the WordPress and Site Address to https://.', done: 'siteurl and home use https.' }));
    }

    // ---- cron ----
    const cron = wp.json(['cron', 'event', 'list', '--fields=hook,recurrence']);
    if (!cron.ok) fail('db-cron', 'Scheduled jobs', cron);
    else {
        ctx.record('db-cron', 'Scheduled jobs', 'done');
        const seen = new Set();
        const unknown = [];
        for (const e of cron.data || []) {
            const h = e.hook;
            if (seen.has(h)) continue;
            seen.add(h);
            if (/^wp_/.test(h) || CORE_CRON.has(h) || ctx.allHooks.has(h) || [...ctx.prefixes].some(p => h.startsWith(p))) continue;
            unknown.push(h);
        }
        if (unknown.length) out.push(finding({ ...base, confidence: 'possible', rule: 'cron-unknown', severity: 'P2', plugins: [], key: 'unknown', title: `${unknown.length} scheduled job(s) have no code behind them in the installed plugins or themes`, detail: 'A scheduled job whose code is not in any installed plugin is either left over from a removed plugin, or its code lives somewhere unusual (database, mu-plugin, injected file). Malware uses cron to re-infect cleaned sites.', evidence: unknown.slice(0, 20), fix: 'For each hook, find out which plugin created it. Delete the job with wp cron event delete <hook> if it is orphaned.', commands: unknown.slice(0, 5).map(h => `wp cron event delete ${h}`), done: 'Every scheduled job belongs to an installed plugin or WordPress.' }));
    }

    // ---- injected content ----
    const px = wp.run(['db', 'prefix']);
    const prefix = px.ok ? px.stdout.trim() : null;
    if (!prefix || !/^[A-Za-z0-9_]+$/.test(prefix)) fail('db-injected', 'Injected code in posts and options', px.ok ? { error: 'unexpected table prefix' } : px);
    else {
        if (prefix === 'wp_') out.push(finding({ ...base, rule: 'default-db-prefix', severity: 'P3', plugins: [], key: 'prefix', title: 'The database table prefix is the default "wp_"', detail: 'Automated SQL-injection tools assume wp_. A custom prefix is a small extra hurdle, not a fix for injection.', fix: 'Optional: change the prefix with a migration plugin on staging.', done: 'Prefix changed, or the risk is accepted.' }));
        const posts = wp.query(`SELECT ID, post_type FROM ${prefix}posts WHERE post_status IN ('publish','draft','private','pending') AND ${INJECT_POST} LIMIT 50`);
        const opts = wp.query(`SELECT option_name FROM ${prefix}options WHERE ${INJECT_OPT} LIMIT 50`);
        if (!posts.ok) fail('db-injected', 'Injected code in posts and options', posts);
        else {
            ctx.record('db-injected', 'Injected code in posts and options', 'done');
            if (posts.rows.length) out.push(finding({ ...base, confidence: 'possible', rule: 'db-injected-posts', severity: 'P1', plugins: [], key: 'posts', title: `${posts.rows.length} post(s) contain code that looks injected (hidden iframe, eval, encoded script)`, detail: 'Spam and malware campaigns inject scripts and hidden iframes into post content. Some page builders also store code legitimately, so open each one.', evidence: posts.rows.map(r => `post ID ${r[0]} (${r[1]})`), fix: 'Open each post in wp-admin (post.php?post=<ID>&action=edit), compare with a backup, remove foreign code.', done: 'The listed posts contain only intended content.' }));
            if (opts.ok && opts.rows.length) out.push(finding({ ...base, confidence: 'possible', rule: 'db-injected-options', severity: 'P1', plugins: [], key: 'options', title: `${opts.rows.length} setting(s) in the options table contain eval/base64 code`, detail: 'Malware stores payloads in wp_options so they survive file clean-ups. Code-snippet plugins also do this legitimately.', evidence: opts.rows.map(r => `option "${r[0]}"`), fix: 'Check which plugin owns each option. Delete those nobody owns (wp option get <name> to read first).', done: 'Each flagged option is explained or deleted.' }));
        }
    }

    // ---- multisite ----
    // `core is-installed --network` also fails when the database cannot be read; that must not be recorded as "not a multisite"
    if (!users.ok) { ctx.record('db-multisite', 'Multisite', 'skipped', 'the database could not be read, so multisite could not be checked'); return out; }
    if (ctx.config.multisite || wp.run(['core', 'is-installed', '--network']).ok) {
        const sa = wp.json(['super-admin', 'list']);
        const sites = wp.json(['site', 'list', '--fields=blog_id,url']);
        if (!sa.ok && !sites.ok) fail('db-multisite', 'Multisite', sa);
        else {
            ctx.record('db-multisite', 'Multisite', 'done');
            const names = (sa.ok ? sa.data : []).map(x => (typeof x === 'string' ? x : x.user_login || x.login));
            out.push(finding({ ...base, rule: 'multisite-note', severity: 'P3', plugins: [], key: 'info', title: `This is a multisite network${sites.ok ? ` with ${sites.data.length} site(s)` : ''}`, detail: 'Network-activated plugins and super admins affect every site. One weak site can reach the whole network.', fix: 'Review the plugins that are network-activated and keep the list of super admins short.', done: 'Network-wide settings reviewed.' }));
            if (names.length > 2) out.push(finding({ ...base, rule: 'multisite-superadmins', severity: 'P2', plugins: [], key: 'sa', title: `${names.length} super admins exist`, detail: 'Super admins can change every site and install code.', evidence: names, fix: 'Reduce to the people who truly manage the network.', done: 'Two or fewer super admins.' }));
        }
    } else ctx.record('db-multisite', 'Multisite', 'done', 'not a multisite');
    return out;
}

module.exports = { run };
