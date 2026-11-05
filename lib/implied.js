// Code signature -> the plugin it only works with.
//
// A use counts as a HARD dependency unless THAT USE is guarded. The test is per use, not per file: a file with one guarded and one unguarded `Jetpack::` call is still hard.
// A use is guarded when, for the same plugin (`names`), one of these holds:
//   - the statement itself tests it first            class_exists( 'Jetpack' ) && Jetpack::is_active()
//   - an enclosing block is opened by such a test    if ( class_exists( 'Jetpack' ) ) { Jetpack::... }
//   - an earlier statement in an enclosing block leaves when the test fails     if ( ! class_exists( 'Jetpack' ) ) { return; }  ...  Jetpack::...
// Guard calls: class_exists, function_exists, interface_exists, trait_exists, defined, is_plugin_active, is_plugin_active_for_network, did_action.
// The entries marked `soft` are themselves a guard (the test for the plugin): they make a SOFT dependency, as before.
const IMPLIED = [
    { re: /\b(class_exists|function_exists|defined)\s*\(\s*['"](WooCommerce|WC_Product|woocommerce_)/, slug: 'woocommerce', soft: true },
    { re: /\bWC\(\)|\bwc_get_(product|order|cart)\b|\bWC_(Order|Product|Cart|Payment_Gateway)\b/, slug: 'woocommerce', names: /woocommerce|\bWC\b|\bWC_|\bwc_/i },
    { re: /\\?Elementor\\(Plugin|Widget_Base|Controls_Manager)/, slug: 'elementor', names: /elementor/i },
    { re: /\b(get_field|update_field|have_rows|the_sub_field|acf_add_local_field_group)\s*\(/, slug: 'advanced-custom-fields', names: /\bacf\b|advanced-custom-fields|get_field|update_field|have_rows|the_sub_field|acf_add_local_field_group/i },
    { re: /\bWPCF7_|\bwpcf7_/, slug: 'contact-form-7', names: /wpcf7|contact-form-7/i },
    { re: /\bGFAPI\b|\bGFForms\b/, slug: 'gravityforms', names: /GFAPI|GFForms|gravityforms|gravity_form/i },
    { re: /\bJetpack::|\bJetpack_Options\b/, slug: 'jetpack', names: /jetpack/i },
    { re: /\bYoast\\WP\\|\bWPSEO_/, slug: 'wordpress-seo', names: /yoast|wpseo|wordpress-seo/i },
    { re: /\bRankMath\\/, slug: 'seo-by-rank-math', names: /rankmath|rank-math|rank_math/i }
];

const GUARD_CALL = /\b(?:class_exists|function_exists|interface_exists|trait_exists|defined|is_plugin_active|is_plugin_active_for_network|did_action)\s*\(([^()]*)\)/g;
const LEAVES = /^\s*(?:\{\s*)?(?:return\b|exit\b|die\b|continue\b|break\b|throw\b|wp_die\b)/;

// the code with comments blanked out (same length, so positions stay), so a commented-out guard guards nothing
function blankComments(raw) {
    return raw.replace(/\/\*[\s\S]*?\*\/|(^|[^:'"])\/\/[^\n]*/g, (m, a) => (a || '') + ' '.repeat(m.length - (a || '').length));
}
const testsPlugin = (text, names) => { GUARD_CALL.lastIndex = 0; let m; while ((m = GUARD_CALL.exec(text))) if (names.test(m[1])) return true; return false; };

// is the use at `pos` guarded for this plugin?
function guardedAt(code, pos, names) {
    // 1. the same statement, before the use
    let st = pos; while (st > 0 && !';{}'.includes(code[st - 1])) st--;
    if (testsPlugin(code.slice(st, pos), names)) return true;
    // 2. the enclosing blocks, innermost first: the test that opens each; an early leave counts only in the use's own function body (or the file top level) at the block's own level
    let depth = 0, inFunction = false;
    for (let i = pos - 1; i >= 0; i--) {
        const ch = code[i];
        if (ch === '}') depth++;
        else if (ch === '{') {
            if (depth > 0) { depth--; continue; }
            let h = i; while (h > 0 && !';{}'.includes(code[h - 1])) h--;
            const header = code.slice(h, i);
            if (testsPlugin(header, names)) return true;
            if (!inFunction && earlyLeave(code.slice(i + 1, pos), names)) return true;
            if (/\bfunction\b|\bfn\b/.test(header)) inFunction = true;   // outside this function body nothing that leaves early applies
        }
    }
    return !inFunction && earlyLeave(code.slice(0, pos), names);   // the file level, for a use that is itself at the top level
}
// `if ( !guard(plugin) [|| !guard(other)] ) <leave>` as a statement at the top level of `body` (not inside a closed block or another function).
// Any other term in the condition (!is_admin(), a plain call) means the leave happens for other reasons too: NOT a guard.
function earlyLeave(body, names) {
    const re = /\bif\s*\(/g; let m;
    while ((m = re.exec(body))) {
        let d = 0; for (let k = 0; k < m.index; k++) { if (body[k] === '{') d++; else if (body[k] === '}') d--; }
        if (d !== 0) continue;
        let p = 1, j = re.lastIndex; while (j < body.length && p > 0) { if (body[j] === '(') p++; else if (body[j] === ')') p--; j++; }
        const cond = body.slice(re.lastIndex, j - 1);
        const terms = cond.split('||').map(t => t.trim());
        const neg = /^!\s*(?:class_exists|function_exists|interface_exists|trait_exists|defined|is_plugin_active|is_plugin_active_for_network|did_action)\s*\(([^()]*)\)$/;
        const parsed = terms.map(t => neg.exec(t));
        if (parsed.some(x => !x) || !parsed.some(x => names.test(x[1]))) continue;
        if (LEAVES.test(body.slice(j, j + 40))) return true;
    }
    return false;
}

function impliedDeps(raw) {
    const by = new Map();
    let code = null;
    for (const i of IMPLIED) {
        if (!i.re.test(raw)) continue;
        let soft = !!i.soft;
        if (!soft && i.names) {
            // soft only when EVERY use of the signature is guarded
            if (code === null) code = blankComments(raw);
            const g = new RegExp(i.re.source, 'g'); let m, uses = 0, guarded = 0;
            // the name inside a guard call (class_exists( 'WPCF7_ContactForm' )) is the test itself, not a use
            const scan = code.replace(new RegExp(GUARD_CALL.source, 'g'), x => ' '.repeat(x.length));
            while ((m = g.exec(scan))) { uses++; if (guardedAt(code, m.index, i.names)) guarded++; if (m[0] === '') g.lastIndex++; }
            // no use left (the signature was only a guard's argument, or sat in a comment): nothing relies on the plugin
            soft = guarded === uses;
        }
        by.set(i.slug, { slug: i.slug, soft: (by.has(i.slug) ? by.get(i.slug).soft : true) && soft });
    }
    return [...by.values()];
}

module.exports = { IMPLIED, impliedDeps };
