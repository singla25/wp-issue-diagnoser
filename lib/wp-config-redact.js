// A redacted copy of wp-config.php for the analysis. The original is only READ. Everything that could be a secret is dropped: database name, user, password and host, keys
// and salts, API keys, anything that is not a plain literal. Only a short allow-list of settings is kept (the ones the server-settings check and the report look at),
// each as a simple define( 'NAME', literal ); line, plus $table_prefix. Pure and deterministic.

const KEEP = new Set(['WP_HOME', 'WP_SITEURL', 'WP_DEBUG', 'WP_DEBUG_LOG', 'WP_DEBUG_DISPLAY', 'SCRIPT_DEBUG', 'FORCE_SSL_ADMIN', 'FORCE_SSL_LOGIN', 'DISABLE_WP_CRON', 'WP_MEMORY_LIMIT',
    'WP_MAX_MEMORY_LIMIT', 'WP_AUTO_UPDATE_CORE', 'AUTOMATIC_UPDATER_DISABLED', 'DISALLOW_FILE_EDIT', 'DISALLOW_FILE_MODS', 'WP_CACHE', 'MULTISITE', 'SUBDOMAIN_INSTALL', 'WP_ALLOW_REPAIR',
    'EMPTY_TRASH_DAYS', 'CONCATENATE_SCRIPTS', 'COMPRESS_CSS', 'COMPRESS_SCRIPTS', 'WP_POST_REVISIONS', 'WP_CONTENT_DIR_NAME']);
const LITERAL = /^(?:'([^'\\\r\n]*)'|"([^"\\$\r\n]*)"|-?\d{1,12}|true|false|TRUE|FALSE|null|NULL)$/;

// -> { text, kept: [names], dropped: number }
function redact(source) {
    const kept = [], lines = ['<?php', '// Redacted copy made by Plugin Guard: database details, keys, salts and every setting that is not on a short safe list were removed.'];
    let dropped = 0;
    const text = String(source == null ? '' : source).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*(\/\/|#).*$/gm, '');
    for (const m of text.matchAll(/define\s*\(\s*(['"])([A-Z0-9_]+)\1\s*,\s*([^;]*?)\s*\)\s*;/g)) {
        const name = m[2], raw = m[3].trim();
        if (!KEEP.has(name) || !LITERAL.test(raw)) { dropped++; continue; }
        let value = raw;
        // an address with a user name and password in it (http://user:pass@host) keeps only the host
        if (/^['"]/.test(raw)) value = raw.replace(/(https?:\/\/)[^\/@'"\s]*@/i, '$1');
        lines.push(`define( '${name}', ${value} );`); kept.push(name);
    }
    const pre = /\$table_prefix\s*=\s*(['"])([A-Za-z0-9_]{0,40})\1\s*;/.exec(text);
    if (pre) { lines.push(`$table_prefix = '${pre[2]}';`); kept.push('table_prefix'); }
    return { text: lines.join('\n') + '\n', kept, dropped: dropped + (/define\s*\(/.test(text) ? 0 : 0) };
}

module.exports = { redact, KEEP };
