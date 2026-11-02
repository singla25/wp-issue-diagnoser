// How to undo, per finding and per fix option. Built ONLY from fields the result already has (option type, file, plugin slug, setting label / stored key);
// nothing is invented. Plugin Guard applies nothing, so the first line always says that nothing was changed by it. Pure and deterministic.

const SLUG = /^[a-z0-9][a-z0-9._-]{0,80}$/i;
const clip = (s, n = 160) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, n);
const INTRO = 'Plugin Guard itself changed nothing on your website.';

function undoOption(o) {
    switch (o.type) {
        case 'patch': return o.file ? `If you applied this change: restore ${clip(o.file)} from your backup or from version control (for example "git checkout -- ${clip(o.file)}").` : null;
        case 'shim': return o.file ? `If you added this file: delete ${clip(o.file)} and reload the site.` : null;
        case 'plugin': return o.plugin && SLUG.test(o.plugin) ? `If you deactivated it: re-activate ${clip(o.plugin)} under Plugins in the WordPress admin (or run "wp plugin activate ${o.plugin}").` : null;
        case 'settings': {
            const s = o.setting;
            return s && s.label ? `Change the setting back to the value it had before: ${clip(s.label)}${s.admin_path ? ` (${clip(s.admin_path)})` : ''}${s.stored_key ? `, stored as ${clip(s.stored_key)}` : ''}.` : null;
        }
        default: return null;
    }
}

// plan: { hypothesis, options:[...] } from issue/resolve.js, or null
function rollbackFor(plan) {
    const options = ((plan && plan.options) || []).map(o => ({ title: clip(o.title, 120), type: o.type, undo: undoOption(o) || 'Nothing was applied by Plugin Guard for this option, so there is nothing to undo.' }));
    return { intro: INTRO, options };
}

module.exports = { rollbackFor, undoOption, INTRO };
