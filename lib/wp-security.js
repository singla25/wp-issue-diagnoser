// WordPress-specific source checks for CUSTOM code only (Agent 2 calls this with allowlisted files).
// Pattern matching, not a taint analysis: every hit is "possible" until a person or Agent 3 shows it is reachable.
// Secrets are never copied into a finding: only the key name and the length of the value.

const { parseArgs, clean, phpSegments } = require('./php');

const SAFE_OUT = /\b(esc_html|esc_attr|esc_url|esc_js|esc_textarea|wp_kses\w*|absint|intval|floatval|sanitize_\w+|htmlspecialchars|htmlentities|json_encode|wp_json_encode|number_format|\(int\)|\(float\)|count|isset|empty)\b/;
const STATE_CHANGE = /\b(update_option|delete_option|add_option|wp_insert_post|wp_update_post|wp_delete_post|update_user_meta|delete_user_meta|wp_insert_user|wp_update_user|wp_delete_user|update_post_meta|delete_post_meta|wp_set_password)\s*\(|\$wpdb->(insert|update|delete|replace|query)\s*\(/;

const lineOf = (text, idx) => text.slice(0, idx).split('\n').length;

function scanCustom(raw, rel) {
    const code = phpSegments(raw);
    const text = clean(code, false);
    const out = [];
    const add = (rule, idx, title, detail, extra = {}) => out.push({ rule, line: lineOf(text, idx), title, detail, ...extra });
    let m;

    // 1. request value echoed without escaping
    const echoRe = /\b(echo|print)\b([^;]{0,300});/g;
    while ((m = echoRe.exec(text))) {
        if (/\$_(GET|POST|REQUEST|COOKIE)\b/.test(m[2]) && !SAFE_OUT.test(m[2])) add('xss-request-output', m.index, `${rel}: request value is echoed without escaping`, 'A $_GET/$_POST/$_REQUEST/$_COOKIE value reaches echo/print in the same statement with no esc_*/absint/sanitize call. Reflected XSS if the line is reachable.');
    }
    // 2. $wpdb query built from variables without prepare()
    const sqlRe = /\$wpdb->(query|get_results|get_var|get_row|get_col)\s*\(/g;
    while ((m = sqlRe.exec(text))) {
        const first = parseArgs(text, m.index + m[0].length - 1).args[0] || '';
        if (/prepare\s*\(/.test(first)) continue;
        // table names held in variables/properties ({$this->table}, $wpdb->prefix, $threads_table) are not user input
        const stripped = first.replace(/\{?\$(?:wpdb|this)->\w*(?:table|prefix|posts|postmeta|users|usermeta|options|terms|comments)\w*\}?/gi, '').replace(/\{?\$wpdb->\w+\}?/g, '').replace(/\{?\$\w*table\w*\}?/gi, '');
        if (/\$\w+/.test(stripped) && /\b(select|insert|update|delete|replace)\b/i.test(first + ' ')) add('sql-unprepared-variable', m.index, `${rel}: SQL built from variables without $wpdb->prepare()`, 'The query text contains PHP variables and is not passed through $wpdb->prepare(). SQL injection if any variable is attacker-controlled.');
        else if (!/\b(select|insert|update|delete|replace|show|create|alter|drop)\b/i.test(first) && /\$\w+/.test(stripped)) add('sql-unprepared-variable', m.index, `${rel}: query passed as a variable to $wpdb`, 'The SQL comes from a variable that cannot be inspected here; check it is built with $wpdb->prepare().', { weak: true });
    }
    // 3. hard-coded secret (value never copied)
    const secRe = /['"]?([A-Za-z_]*(?:api[_-]?key|secret|passw(?:or)?d|token|auth[_-]?key|private[_-]?key)[A-Za-z_]*)['"]?\s*(?:=>|=)\s*(['"])([A-Za-z0-9_\-\/+=.]{20,})\2/gi;
    while ((m = secRe.exec(text))) {
        if (/your|example|changeme|placeholder|xxxx|\*{4}|^[a-z_]+$/i.test(m[3]) || /^(wp_|get_|esc_)/.test(m[3])) continue;
        add('hardcoded-secret', m.index, `${rel}: value assigned to "${m[1]}" looks like a hard-coded secret`, `A ${m[3].length}-character literal is assigned to a secret-like name. The value is not shown here. Move it to wp-config.php / an environment variable and rotate it if the code was ever shared.`, { redacted: true });
    }
    // 4. redirect target from the request
    const redirRe = /\bwp_redirect\s*\(([^;]{0,200});/g;
    while ((m = redirRe.exec(text))) if (/\$_(GET|POST|REQUEST)\b/.test(m[1])) add('open-redirect', m.index, `${rel}: redirect target comes from the request`, 'wp_redirect() is given a request value. Use wp_safe_redirect() or an allow-list of hosts, otherwise phishing links can bounce off this site.');
    // 5. a nonce is not authorization
    const ajax = /add_action\s*\(\s*['"]wp_ajax_(?!nopriv_)(\w+)['"]/.exec(text);
    if (ajax && /check_ajax_referer|wp_verify_nonce|check_admin_referer/.test(text) && STATE_CHANGE.test(text) && !/current_user_can\s*\(|user_can\s*\(/.test(text)) {
        add('nonce-without-capability', ajax.index, `${rel}: AJAX handler "${ajax[1]}" checks a nonce but never a capability, and changes data`, 'Any logged-in user (e.g. a subscriber) can obtain a valid nonce. A nonce proves intent, not permission: add current_user_can() with the capability the action needs.');
    }
    return out;
}

module.exports = { scanCustom };
