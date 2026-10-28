// fs.readdirSync with a fixed order (code-point order of the names). The operating system's directory order is not defined, and issue mode must
// give the same result for the same input, so every directory listing in issue mode and the component scan goes through this.
const fs = require('fs');
const nameOf = e => (typeof e === 'string' ? e : e.name);
const byName = (a, b) => { const x = nameOf(a), y = nameOf(b); return x < y ? -1 : x > y ? 1 : 0; };
module.exports = function readdir(dir, opts) { return fs.readdirSync(dir, opts).sort(byName); };
module.exports.byName = byName;
