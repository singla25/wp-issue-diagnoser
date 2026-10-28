// Static exposure checks on plugin / theme / mu-plugin code, plus leftovers (inactive plugins and themes).

const { finding } = require('../lib/finding');

const RISK_TEXT = {
    'eval': ['P1', 'uses eval()', 'eval() executes strings as PHP; anyone who can influence the string runs code on the server.'],
    'include-user-input': ['P0', 'includes a file chosen by request input', 'Local/remote file inclusion: an attacker picks which PHP file runs.'],
    'unserialize-user-input': ['P0', 'unserializes request input', 'PHP object injection: crafted input can trigger code in any class that is loaded.'],
    'exec-user-input': ['P0', 'passes request input to a shell/exec call', 'Command injection.'],
    'sql-user-input': ['P0', 'puts request input into an unprepared SQL query', 'SQL injection: use $wpdb->prepare().'],
    'upload-no-type-check': ['P1', 'moves uploaded files without checking their type', 'An attacker can upload a .php file and run it.']
};

const FALLBACK_THEME = /^twenty(twenty|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|nineteen|twentyone|twentytwo|twentythree|twentyfour|twentyfive|twentysix)?/i;

function run(ctx) {
    const out = [];
    for (const p of ctx.components) {
        const active = ctx.isActive(p.ref);
        const what = p.kind === 'theme' ? 'theme' : p.kind === 'mu' ? 'must-use plugin' : 'plugin';
        const note = active ? '' : ` The ${what} is inactive, but its files are still reachable by URL.`;
        const seen = new Map();
        const stable = (file, kind) => { const k = `${file}:${kind}`; const i = seen.get(k) || 0; seen.set(k, i + 1); return `${p.ref}/${k}#${i}`; };

        for (const s of p.scans) {
            for (const r of s.risks) {
                if (RISK_TEXT[r.kind]) {
                    const [severity, wh, why] = RISK_TEXT[r.kind];
                    out.push(finding({
                        rule: `code-${r.kind}`, severity, category: 'exposure', plugins: [p.ref], key: stable(s.file, r.kind),
                        title: `${p.loc(s.file, r.line)} ${wh}`, detail: why + note + ' This is a pattern match, not a proven exploit: confirm by reading the code.',
                        evidence: [p.loc(s.file, r.line)], fix: `Read the code at that line. If confirmed, rewrite it safely (validate/escape the input), or update ${p.ref} to a fixed version, or remove it.`,
                        why, done: 'The flagged line no longer passes request input to this call (or the plugin is updated/removed).'
                    }));
                } else if (r.kind === 'no-abspath-guard') {
                    out.push(finding({
                        rule: 'code-no-abspath', severity: r.userInput ? 'P1' : 'P3', category: 'exposure', plugins: [p.ref], key: `${p.ref}/${s.file}`,
                        title: `${p.loc(s.file)} runs outside WordPress when requested directly`,
                        detail: `No ABSPATH check, so ${p.loc(s.file)} can be called straight from the browser${r.userInput ? ' and it reads request input' : ''}.${note}`,
                        evidence: [p.loc(s.file)], fix: "Add `defined( 'ABSPATH' ) || exit;` as the first line after the opening PHP tag, or deny direct access to plugin PHP files in the web server.",
                        patch: { type: 'htaccess', id: 'plugin-direct-php' }, done: 'Requesting the file directly returns a blank page or 403.'
                    }));
                }
            }
            for (const a of s.ajax.filter(x => x.nopriv)) {
                if (!s.hasNonce && !s.hasCapCheck) {
                    out.push(finding({
                        rule: 'ajax-nopriv-unprotected', severity: 'P1', category: 'exposure', plugins: [p.ref], key: `${p.ref}:${a.action}`,
                        title: `${p.ref}: public AJAX action "${a.action}" has no nonce or capability check`,
                        detail: `Any visitor can call it without logging in, and ${s.file} contains no check_ajax_referer / wp_verify_nonce / current_user_can.${note}`,
                        evidence: [p.loc(s.file, a.line)], fix: 'Add check_ajax_referer() (nonce) to the handler, or remove the wp_ajax_nopriv_ registration if only logged-in users need it.',
                        done: 'The handler rejects requests without a valid nonce.'
                    }));
                }
            }
            for (const r of s.restRoutes.filter(x => x.noPermission)) {
                out.push(finding({
                    rule: 'rest-no-permission', severity: r.writes ? 'P1' : 'P3', category: 'exposure', plugins: [p.ref], key: `${p.ref}:${r.namespace}${r.route}`,
                    title: `${p.ref}: REST route ${r.namespace}${r.route} is public${r.writes ? ' and accepts writes' : ''}`,
                    detail: `permission_callback is missing or __return_true.${r.writes ? ' Anyone on the internet can send write requests.' : ' Fine for public data; check it returns nothing private.'}${note}`,
                    evidence: [p.loc(s.file, r.line)], fix: 'Return a capability check from permission_callback, for example `fn() => current_user_can( "edit_posts" )`.',
                    done: 'An unauthenticated request to the route returns 401/403.'
                }));
            }
        }

        if (p.kind === 'plugin' && !active) {
            const risky = out.some(f => f.plugins.includes(p.ref) && f.category === 'exposure');
            out.push(finding({
                rule: 'inactive-plugin', severity: risky ? 'P1' : 'P2', category: 'exposure', confidence: 'certain', plugins: [p.ref], key: p.ref, owner: 'admin',
                title: `${p.name || p.ref} is installed but inactive`,
                detail: 'Deactivated plugins keep their PHP files on the server and those files stay reachable by URL: a known-vulnerable inactive plugin is exploitable. This is the most common left-over attack path.',
                fix: 'Delete it if it is not used.', commands: [`wp plugin delete ${p.slug}`], done: 'The plugin folder no longer exists.'
            }));
        }
        if (p.kind === 'theme' && ctx.themesKnown && !active && !FALLBACK_THEME.test(p.slug)) {
            const risky = out.some(f => f.plugins.includes(p.ref) && f.category === 'exposure');
            out.push(finding({
                rule: 'inactive-theme', severity: risky ? 'P1' : 'P3', category: 'exposure', confidence: 'certain', plugins: [p.ref], key: p.ref, owner: 'admin',
                title: `Theme "${p.name || p.slug}" is installed but not used`,
                detail: 'Unused themes still have PHP files reachable by URL and need updates like any other code. Keep one default theme (Twenty Twenty-x) as a fallback and delete the rest.',
                fix: 'Delete the unused theme.', commands: [`wp theme delete ${p.slug}`], done: 'The theme folder no longer exists.'
            }));
        }
    }
    return out;
}

module.exports = { run };
