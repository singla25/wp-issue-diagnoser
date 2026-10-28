// Lightweight PHP source scanner. It is NOT a PHP parser: it strips comments, balances call arguments
// and pulls out the facts the checks need (hooks, declarations, endpoints, risky calls). Every result is
// therefore a "likely", and the reports say so.

function phpSegments(src) {
    const out = [];
    const re = /<\?(?:php|=)?([\s\S]*?)(?:\?>|$)/g;
    let m;
    while ((m = re.exec(src))) {
        out.push(m[1]);
        if (m[0].length === 0) re.lastIndex++;
    }
    return out.join('\n');
}

// Remove comments; optionally blank string contents so braces/keywords inside strings are ignored.
function clean(code, blankStrings) {
    let out = '';
    let i = 0;
    const n = code.length;
    while (i < n) {
        const c = code[i];
        const d = code[i + 1];
        if (c === '/' && d === '*') {
            const e = code.indexOf('*/', i + 2);
            const end = e < 0 ? n : e + 2;
            out += code.slice(i, end).replace(/[^\n]/g, ' ');
            i = end;
            continue;
        }
        if ((c === '/' && d === '/') || (c === '#' && d !== '[')) {
            let e = code.indexOf('\n', i);
            if (e < 0) e = n;
            out += ' '.repeat(e - i);
            i = e;
            continue;
        }
        if (c === "'" || c === '"') {
            let j = i + 1;
            while (j < n && code[j] !== c) {
                if (code[j] === '\\') j++;
                j++;
            }
            j = Math.min(j + 1, n);
            const s = code.slice(i, j);
            out += blankStrings ? c + s.slice(1, -1).replace(/[^\n]/g, ' ') + (s.length > 1 ? c : '') : s;
            i = j;
            continue;
        }
        out += c;
        i++;
    }
    return out;
}

// Split the arguments of the call whose "(" is at `open`.
function parseArgs(code, open) {
    let depth = 0;
    let cur = '';
    const args = [];
    for (let i = open; i < code.length; i++) {
        const c = code[i];
        if (c === "'" || c === '"') {
            let j = i + 1;
            while (j < code.length && code[j] !== c) {
                if (code[j] === '\\') j++;
                j++;
            }
            cur += code.slice(i, j + 1);
            i = j;
            continue;
        }
        if (c === '(' || c === '[' || c === '{') {
            if (depth > 0) cur += c;
            depth++;
            continue;
        }
        if (c === ')' || c === ']' || c === '}') {
            depth--;
            if (depth === 0) {
                if (cur.trim() || args.length) args.push(cur.trim());
                return { args, end: i };
            }
            cur += c;
            continue;
        }
        if (c === ',' && depth === 1) {
            args.push(cur.trim());
            cur = '';
            continue;
        }
        cur += c;
    }
    return { args, end: code.length };
}

function literal(arg) {
    const m = /^(['"])([^'"$\\]*)\1$/.exec(arg || '');
    return m ? m[2] : null;
}

function priorityOf(arg) {
    if (arg === undefined) return 10;
    if (/^-?\d+$/.test(arg)) return Number(arg);
    if (/^PHP_INT_MAX$/.test(arg)) return Number.MAX_SAFE_INTEGER;
    if (/^PHP_INT_MIN$/.test(arg)) return -Number.MAX_SAFE_INTEGER;
    return null; // computed at runtime: unknown
}

// Last quoted word of a callback expression: 'fn', array($this,'method'), [Foo::class,'method'] -> fn / method
function callbackName(arg) {
    if (!arg) return null;
    const all = [...arg.matchAll(/['"]([\w\\:]+)['"]/g)].map(m => m[1]);
    if (all.length) return all[all.length - 1];
    const m = /([\w\\]+)::class|(\$this->\w+)|(\w+)\s*\(/.exec(arg);
    return m ? m[0] : arg.length < 60 ? arg : null;
}

// Who a callback expression refers to, so remove_action() is only matched with an add_action() of the SAME callable.
//   function  'my_fn'                        static  'Cls::m' / [Cls::class,'m'] / ['Cls','m']
//   own       [$this,'m'] / [self::class..] / self::m / static::m  (an object or class of the file itself)
//   dynamic   a variable, closure or call result: cannot be identified
function callbackIdentity(raw) {
    const a = String(raw || '').trim();
    let m;
    if ((m = /^(['"])\\?([\w\\]+)\1$/.exec(a))) return { kind: 'function', name: m[2].replace(/^\\/, '').toLowerCase() };
    if ((m = /^(['"])\\?([\w\\]+)::(\w+)\1$/.exec(a))) return /^(self|static|parent)$/i.test(m[2]) ? { kind: 'own' } : { kind: 'static', cls: m[2].split('\\').pop().toLowerCase(), method: m[3].toLowerCase() };
    if ((m = /^(?:array\s*\(|\[)\s*(\$this|(?:self|static|parent)(?:::class)?|\\?([\w\\]+)::class|(['"])\\?([\w\\]+)\3)\s*,\s*(['"])(\w+)\5\s*[)\]]$/i.exec(a))) {
        const cls = m[2] || m[4];
        if (!cls || /^(self|static|parent)$/i.test(cls)) return { kind: 'own' };
        return { kind: 'static', cls: cls.split('\\').pop().toLowerCase(), method: m[6].toLowerCase() };
    }
    return { kind: 'dynamic' };
}

// A file made only of declarations (classes, functions, namespace, use) does nothing when requested directly.
function runsCodeAtTopLevel(blank) {
    let depth = 0, skeleton = '';
    for (const c of blank) {
        if (c === '{') { if (depth++ === 0) skeleton += ';'; }
        else if (c === '}') depth = Math.max(0, depth - 1);
        else if (depth === 0) skeleton += c;
    }
    return skeleton.replace(/<\?php|\?>/g, ';').split(';').map(x => x.trim()).filter(Boolean).some(st =>
        !/^(namespace|use|declare|const)\b/.test(st) && !/^((abstract|final|readonly)\s+)*(class|interface|trait|enum|function)\b/.test(st));
}

function scanSource(raw, rel) {
    const code = phpSegments(raw);
    const text = clean(code, false);
    const blank = clean(code, true);
    const result = {
        file: rel,
        hooks: [], removals: [], shortcodes: [], ajax: [], restRoutes: [],
        functions: [], classes: [], constants: [], tables: [],
        risks: [], namespace: null, hasGuard: /\b(ABSPATH|WPINC|WP_UNINSTALL_PLUGIN)\b/.test(text),
        bundled: /(^|\/)(vendor|vendor_prefixed|packages|libs?|includes\/libs?|node_modules)\//i.test(rel)
    };
    const ns = /\bnamespace\s+([\w\\]+)\s*[;{]/.exec(blank);
    result.namespace = ns ? ns[1] : null;

    let m;
    const callRe = /\b(add_action|add_filter|remove_action|remove_filter|add_shortcode|register_rest_route)\s*\(/g;
    while ((m = callRe.exec(text))) {
        const { args } = parseArgs(text, m.index + m[0].length - 1);
        const line = text.slice(0, m.index).split('\n').length;
        const fn = m[1];
        if (fn === 'add_shortcode') {
            const tag = literal(args[0]);
            if (tag) result.shortcodes.push({ tag, line });
        } else if (fn === 'register_rest_route') {
            const spec = args.slice(2).join(',');
            result.restRoutes.push({
                namespace: literal(args[0]), route: literal(args[1]) || args[1], line,
                noPermission: !/permission_callback/.test(spec) || /permission_callback['"]?\s*=>\s*['"]?__return_true/.test(spec),
                writes: /\b(POST|PUT|PATCH|DELETE)\b|WP_REST_Server::(CREATABLE|EDITABLE|DELETABLE|ALLMETHODS)/.test(spec)
            });
        } else {
            const hook = literal(args[0]);
            if (!hook) continue;
            const entry = { hook, callback: callbackName(args[1]), callbackRaw: args[1], identity: callbackIdentity(args[1]), priority: priorityOf(args[2]), line };
            (fn.startsWith('add_') ? result.hooks : result.removals).push(entry);
            const a = /^wp_ajax_(nopriv_)?(\w+)$/.exec(hook);
            if (a && fn.startsWith('add_')) result.ajax.push({ action: a[2], nopriv: !!a[1], line });
            const p = /^admin_post_(nopriv_)?(\w+)$/.exec(hook);
            if (p && fn.startsWith('add_')) result.ajax.push({ action: `admin-post:${p[2]}`, nopriv: !!p[1], line });
        }
    }

    // declarations at file level only (methods and nested functions sit deeper)
    const depthAt = (() => {
        const marks = [];
        let d = 0;
        for (let i = 0; i < blank.length; i++) {
            if (blank[i] === '{') d++;
            else if (blank[i] === '}') d = Math.max(0, d - 1);
            marks[i] = d;
        }
        return i => marks[i] || 0;
    })();
    const qualify = name => (result.namespace ? `${result.namespace}\\${name}` : name);
    const fnRe = /\bfunction\s+&?(\w+)\s*\(/g;
    while ((m = fnRe.exec(blank))) {
        const guarded = new RegExp(`function_exists\\s*\\(\\s*['"]${m[1]}['"]`).test(text);
        const depth = depthAt(m.index);
        if (depth === 0 || (depth === 1 && guarded) || (result.namespace && depth === 1 && !/\bclass\b/.test(blank.slice(0, m.index)))) {
            result.functions.push({ name: qualify(m[1]), guarded, line: blank.slice(0, m.index).split('\n').length });
        }
    }
    const clRe = /\b(?:abstract\s+|final\s+)?(class|interface|trait)\s+(\w+)/g;
    while ((m = clRe.exec(blank))) {
        if (depthAt(m.index) > 1 || (blank.slice(Math.max(0, m.index - 8), m.index).includes('::'))) continue;
        const guarded = new RegExp(`(class|interface|trait)_exists\\s*\\(\\s*['"][\\\\\\w]*${m[2]}['"]`).test(text);
        result.classes.push({ name: qualify(m[2]), guarded, line: blank.slice(0, m.index).split('\n').length });
    }
    const defRe = /\bdefine\s*\(\s*['"](\w+)['"]/g;
    while ((m = defRe.exec(text))) {
        result.constants.push({ name: m[1], guarded: new RegExp(`defined\\s*\\(\\s*['"]${m[1]}['"]`).test(text) });
    }
    const tblRe = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?`?(?:\{\$wpdb->prefix\}|\$[\w>-]+\s*\.\s*['"]?)(\w+)/gi;
    while ((m = tblRe.exec(text))) result.tables.push(m[1]);

    // risky constructs ("likely", reported as such)
    const push = (kind, idx, extra) => result.risks.push({ kind, line: text.slice(0, idx).split('\n').length, ...extra });
    if (!result.bundled) {
        const evalRe = /\b(eval|assert)\s*\(([^;]{0,160})/g;
        while ((m = evalRe.exec(text))) {
            if (/^\s*(@\s*)?(base64_decode|gzinflate|gzuncompress|str_rot13)\s*\(/i.test(m[2])) continue; // obfuscated payloads are reported by the integrity check
            if (m[1] === 'eval' && !/\$_(GET|POST|REQUEST|COOKIE)\b/.test(m[2])) push('eval', m.index);
        }
    }
    // matched on the string-blanked copy, so words inside messages ("executed") and variables ($include_x) don't count
    const dangerRe = /(?<![\w$>:])(unserialize|eval|assert|system|exec|shell_exec|passthru|popen|proc_open|include|require|include_once|require_once)\b\s*(\(?)\s*([^;]{0,160})/g;
    while ((m = dangerRe.exec(blank))) {
        const isInclude = /^(include|require)/.test(m[1]);
        if (!isInclude && !m[2]) continue; // function calls need "("
        if (/\$_(GET|POST|REQUEST|COOKIE)\b/.test(m[3]) && !result.bundled) {
            push(isInclude ? 'include-user-input' : m[1] === 'unserialize' ? 'unserialize-user-input' : 'exec-user-input', m.index, { call: m[1] });
        }
    }
    const sqlRe = /\$wpdb->(query|get_results|get_var|get_row|get_col)\s*\(/g;
    while ((m = sqlRe.exec(text))) {
        const first = parseArgs(text, m.index + m[0].length - 1).args[0] || '';
        if (/\$_(GET|POST|REQUEST|COOKIE)\b/.test(first) && !/prepare\s*\(/.test(first)) push('sql-user-input', m.index);
    }
    if (/move_uploaded_file\s*\(/.test(text) && !/wp_check_filetype|wp_handle_upload|finfo|mime_content_type/.test(text)) {
        push('upload-no-type-check', text.search(/move_uploaded_file/));
    }
    if (!result.hasGuard && runsCodeAtTopLevel(blank) && /(\$_(GET|POST|REQUEST|FILES|COOKIE)\b|\b(include|require)(_once)?\b|\badd_(action|filter)\s*\()/.test(text)) {
        result.risks.push({ kind: 'no-abspath-guard', line: 1, userInput: /\$_(GET|POST|REQUEST|FILES|COOKIE)\b/.test(text) });
    }
    result.hasNonce = /check_ajax_referer|wp_verify_nonce|check_admin_referer/.test(text);
    result.hasCapCheck = /current_user_can\s*\(/.test(text);
    return result;
}

module.exports = { scanSource, parseArgs, clean, phpSegments, literal, callbackIdentity };
