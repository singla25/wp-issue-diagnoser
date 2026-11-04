// The "What is wrong" box for a log fatal that names a file (issue/fatal-recheck.js). Pure: it only words facts that were already re-checked; it decides nothing.
//   tier "likely"     the fatal is in the log, repeats, and its file and line were re-read, but nothing established it (it is NOT "confirmed")
//   tier "confirmed"  validate.js confirmed it (rule A or B)
// It says what was found and what was checked, never "your site is broken because of X". Every text it prints is data from the site, shown as plain text.

const { LIKELY_PHRASE } = require('../lib/plain-names');
const LIKELY_OLD = LIKELY_PHRASE.replace(' log (', ' log, old entry (');
const DAY = 24 * 3600 * 1000, FRESH_DAYS = 7;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const dateOf = iso => { const d = new Date(iso); return Number.isNaN(d.getTime()) ? null : `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`; };
const KIND_WORD = { theme: 'theme', plugin: 'plugin', mu: 'must-use plugin' };
const cap = s => s.charAt(0).toUpperCase() + s.slice(1);

// fr: hypothesis.fatal_recheck. ctx: { components: [{ref,kind,slug,name,version}], issue, probePages: [{url,status}], advisories: [...gate advisories], ran: {probe,sandbox}, fileComponent: ref }
function build(fr, ctx, tier) {
    const comps = ctx.components || [];
    const byRef = ref => comps.find(c => c.ref === ref || c.slug === ref) || null;
    const fileComp = byRef(ctx.fileComponent || '');
    const compName = c => (c && (c.name || c.slug)) || null;
    const kind = KIND_WORD[fr.file_kind] || 'file';
    const ref = new Date(ctx.issue.probe_ran_at || ctx.issue.created_at || 0).getTime();
    const last = fr.last_seen ? new Date(fr.last_seen).getTime() : NaN;
    const age = Number.isFinite(last) && Number.isFinite(ref) && Math.abs(ref - last) > FRESH_DAYS * DAY ? 'old' : 'recent';
    const L = [];
    const isFn = fr.kind === 'function';
    L.push(`Error in your log: PHP Fatal error: ${isFn ? `Call to undefined function ${fr.class}()` : `Class "${fr.class}" not found`}.`);
    L.push(`Where: the ${kind} file ${fr.file}, line ${fr.line}${fileComp ? ` (${kind} ${compName(fileComp)}${fileComp.version ? ` ${fileComp.version}` : ''})` : ''}.`);
    const seen = dateOf(fr.last_seen);
    L.push(`What was checked: found in your log, repeated ${fr.count} times, file and line re-read (line ${fr.line} names ${isFn ? String(fr.class).split(/::|\\/).pop() : String(fr.class).replace(/^.*\\/, '')}).`);
    L.push(age === 'old' ? `Old log entry: last seen in your log on ${seen || 'an unknown date'}, more than ${FRESH_DAYS} days before this report.` : `Last seen in your log on ${seen || 'an unknown date'}.`);
    // the class: only a known provider whose files were searched can be said not to contain it
    if (!isFn) {
        const p = fr.provider || {};
        const searched = fr.scan && fr.scan.complete;
        const defined = searched && fr.scan.defined && fr.scan.defined.length;
        if (p.known && p.installed && searched && !defined) L.push(`The class: ${p.name}${p.version ? ` ${p.version}` : ''} does not contain it (every PHP file of the copy was read).${p.active === false ? ` ${p.name} is installed but switched off.` : ''}${p.version ? ` This usually means the ${kind} was written for an older version of ${p.name}.` : ''}`);
        else if (p.known && p.installed === false) L.push(`The class: it comes from ${p.name}, which is not installed.`);
        else if (defined) L.push(`The class: it is defined in ${[...new Set(fr.scan.defined.map(x => String(x.component || x.file).replace(/^plugin:/, '')))].slice(0, 2).join(', ')}.${p.known && p.installed ? (p.active === false ? ` ${p.name} is installed but switched off.` : p.active === true ? ` ${p.name} is installed and active.` : ` Whether ${p.name} is switched on is not known.`) : ''}`);
        else if (p.known && p.installed) L.push(`The class: this class normally comes from ${p.name}${p.version ? ` ${p.version}` : ''}; whether it contains the class was not checked.`);
        else if (p.source === 'guess') L.push(`The class: this class normally comes from ${p.name || p.slug} (a guess from its name, not checked).`);
        else L.push("The class: its owner could not be identified.");
        if (fr.blocked && /could not check all code/.test(fr.blocked)) L.push(`Could not check all code: ${fr.blocked.replace(/^could not check all code: ?/, '')}.`);
    }
    // versions: the theme or plugin of the file, the provider and WooCommerce (when installed)
    const vs = [];
    const add = (label, c) => { if (c && c.version && !vs.some(v => v.startsWith(label))) vs.push(`${label} ${c.version}`); };
    if (fileComp) add(`${kind} ${compName(fileComp)}`, fileComp);
    const prov = fr.provider && fr.provider.slug ? byRef(fr.provider.slug) : null;
    if (prov && prov !== fileComp) add(compName(prov), prov);
    const woo = byRef('woocommerce');
    if (woo && woo !== prov && woo !== fileComp) add(compName(woo) || 'WooCommerce', woo);
    if (vs.length) L.push(`Versions: ${vs.join(' · ')}.`);
    // a second thing worth checking, when the analysis flagged it
    const tpl = (ctx.advisories || []).find(a => a.type === 'template-override-outdated');
    // the count is the code check's (all outdated copies found); the Advisories keep at most five of them as possible causes, so both numbers are said when they differ
    const tplShown = tpl ? tpl.merged || 1 : 0, tplAll = Math.max(ctx.templateTotal || 0, tplShown);
    if (tpl) L.push(`A second thing to check: ${tplAll > tplShown ? `outdated template overrides (${tplAll} templates in all, ${tplShown} of them are` : `an outdated template override${tpl.merged > 1 ? ` (${tpl.merged} templates)` : ''} is`} listed under Advisories${tplAll > tplShown ? ')' : ''}${tpl.components && tpl.components.length ? ` (${tpl.components.map(c => (byRef(c) ? compName(byRef(c)) : c)).join(' + ')})` : ''}.`);
    // live check
    const five = (ctx.probePages || []).find(p => p && p.status >= 500 && p.status < 600);
    L.push(five ? `Live check: a live page answered HTTP ${five.status}${five.url ? ` (${five.url})` : ''}.` : ctx.ran && ctx.ran.probe ? 'Live check: the live pages that were loaded did not answer with an error.' : 'Live check: none was run, so nothing here was seen failing on your website.');
    // what to try
    const who = fileComp ? `${kind} ${compName(fileComp)}` : `the ${kind}`;
    const prName = fr.provider && fr.provider.name;
    L.push(isFn ? `What to try: update ${who}; make sure the plugin that provides ${fr.class}() is installed and active; test with a default theme.`
        : `What to try: update ${who}${prName ? `; use a version of ${prName} that has this class` : '; make sure the plugin that provides this class is installed and active'}; test with a default theme to see whether the error goes away.`);
    return { title: 'What is wrong', tier, heading: tier === 'likely' ? (age === 'old' ? LIKELY_OLD : LIKELY_PHRASE) : 'Cause found in your log', age, lines: L };
}

module.exports = { build, FRESH_DAYS };
