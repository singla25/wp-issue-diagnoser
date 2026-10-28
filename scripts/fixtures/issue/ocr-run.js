// Runs the real OCR wrapper on the fixture screenshot and prints JSON. Used by the network-blocked test.
const path = require('path');
require('../../../issue/ocr').recognize([path.join(__dirname, 'fatal-error.png')]).then(r => { console.log(JSON.stringify({ text: r[0].text })); process.exit(0); }, e => { console.error(e.message); process.exit(1); });
