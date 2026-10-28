// Finding shape shared by all checks.
//   P0 breaks the site or is directly exploitable   P1 high   P2 medium   P3 informational

const crypto = require('crypto');

const SEVERITIES = ['P0', 'P1', 'P2', 'P3'];

// owner: who does the fix. code = edit files (Claude can do it), admin = a setting in WordPress admin / a decision,
// hosting = server, PHP version, file permissions, web-server rules.
function finding({ rule, severity, category, title, detail, plugins = [], key = '', evidence = [], fix = '', commands = [], patch = null, confidence = 'likely', owner = 'code', why = '', done = '' }) {
    if (!SEVERITIES.includes(severity)) throw new Error(`bad severity ${severity}`);
    const id = crypto.createHash('sha1').update([rule, key || title, plugins.join(',')].join('|')).digest('hex').slice(0, 10);
    return { id, rule, severity, category, title, detail, plugins, evidence, fix, commands, patch, confidence, owner, why, done };
}

module.exports = { finding, SEVERITIES };
