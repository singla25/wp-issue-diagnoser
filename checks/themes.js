// Theme-specific checks. Theme code also takes part in the conflict / exposure checks as a component.

const { finding } = require('../lib/finding');

function run(ctx) {
    const out = [];
    const bySlug = new Map(ctx.themes.map(t => [t.slug, t]));
    for (const t of ctx.themes.filter(x => ctx.isActive(x.ref))) {
        if (t.template && t.template !== t.slug && !bySlug.has(t.template)) {
            out.push(finding({
                rule: 'theme-parent-missing', severity: 'P1', category: 'dependency', confidence: 'certain', plugins: [t.ref], key: t.slug, owner: 'admin',
                title: `Child theme "${t.name || t.slug}" needs parent theme "${t.template}", which is not installed`,
                detail: 'WordPress falls back to a default theme or shows a broken site, and any protections added in the child theme stop working.',
                fix: `Install the parent theme "${t.template}" or switch to a theme that has no missing parent.`, commands: [`wp theme install ${t.template}`],
                done: `Theme ${t.template} is installed.`
            }));
        }
    }
    return out;
}

module.exports = { run };
