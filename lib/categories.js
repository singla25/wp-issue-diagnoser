// What a plugin DOES, guessed from its slug/name. Two active plugins of the same exclusive category usually
// fight over the same files, hooks or login flow. Extend via "categories" in the project's project.json.

const CATEGORIES = [
    { id: 'firewall', security: true, label: 'web application firewall', re: /wordfence|ninjafirewall|all-in-one-wp-security|sucuri|solid-security|ithemes-security|bulletproof|shield-security|wp-cerber|malcare|jetpack-protect|firewall/i },
    { id: '2fa', security: true, label: 'two-factor authentication', re: /two-factor|wp-2fa|2fa|google-authenticator|miniorange.*(2|two)|duo-wordpress|authy/i },
    { id: 'login-limit', security: true, label: 'login attempt limiting', re: /limit-login|loginizer|login-lockdown|wps-limit-login|login-security-solution|cerber/i },
    { id: 'captcha', security: true, label: 'CAPTCHA / bot protection', re: /recaptcha|captcha|turnstile|hcaptcha/i },
    { id: 'security-headers', security: true, label: 'security headers', re: /http-headers|security-headers|headers-security/i },
    { id: 'login-url', security: true, label: 'login URL hiding', re: /wps-hide-login|rename-wp-login|change-wp-admin-login|hide-my-wp/i },
    { id: 'caching', security: false, label: 'page caching', re: /w3-total-cache|wp-super-cache|wp-rocket|litespeed-cache|wp-fastest-cache|cache-enabler|hummingbird|sg-cachepress/i },
    { id: 'seo', security: false, label: 'SEO', re: /wordpress-seo|seo-by-rank-math|all-in-one-seo|autodescription|seopress/i },
    { id: 'backup', security: false, label: 'backup', re: /updraftplus|backwpup|duplicator|backupbuddy|all-in-one-wp-migration|wpvivid/i },
    { id: 'smtp', security: false, label: 'SMTP / mail delivery', re: /wp-mail-smtp|post-smtp|easy-wp-smtp|fluent-smtp|mailgun|sendgrid/i },
    { id: 'redirect', security: false, label: 'redirect management', re: /redirection|safe-redirect|simple-301/i },
    { id: 'image-optimizer', security: false, label: 'image optimization', re: /smush|imagify|shortpixel|ewww|optimole|wp-optimize/i }
];

function categoryOf(plugin, extra = {}) {
    const hay = `${plugin.slug} ${plugin.name || ''}`;
    const list = [...(extra.categories || []).map(c => ({ ...c, re: new RegExp(c.pattern, 'i') })), ...CATEGORIES];
    return list.find(c => c.re.test(hay)) || null;
}

module.exports = { CATEGORIES, categoryOf };
