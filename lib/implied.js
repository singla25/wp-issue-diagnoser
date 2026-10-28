// Code signature -> the plugin it only works with.
const IMPLIED = [
    { re: /\b(class_exists|function_exists|defined)\s*\(\s*['"](WooCommerce|WC_Product|woocommerce_)/, slug: 'woocommerce', soft: true },
    { re: /\bWC\(\)|\bwc_get_(product|order|cart)\b|\bWC_(Order|Product|Cart|Payment_Gateway)\b/, slug: 'woocommerce' },
    { re: /\\?Elementor\\(Plugin|Widget_Base|Controls_Manager)/, slug: 'elementor' },
    { re: /\b(get_field|update_field|have_rows|the_sub_field|acf_add_local_field_group)\s*\(/, slug: 'advanced-custom-fields' },
    { re: /\bWPCF7_|\bwpcf7_/, slug: 'contact-form-7' },
    { re: /\bGFAPI\b|\bGFForms\b/, slug: 'gravityforms' },
    { re: /\bJetpack::|\bJetpack_Options\b/, slug: 'jetpack' },
    { re: /\bYoast\\WP\\|\bWPSEO_/, slug: 'wordpress-seo' },
    { re: /\bRankMath\\/, slug: 'seo-by-rank-math' }
];

function impliedDeps(raw) {
    const by = new Map();
    for (const i of IMPLIED) {
        if (!i.re.test(raw)) continue;
        by.set(i.slug, { slug: i.slug, soft: (by.has(i.slug) ? by.get(i.slug).soft : true) && !!i.soft });
    }
    return [...by.values()];
}

module.exports = { IMPLIED, impliedDeps };
