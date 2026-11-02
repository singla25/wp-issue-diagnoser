// issue.html and the Issues index: single offline files (inline CSS + JS + ONE embedded JSON object). No network, no fetch, no CDN, no fonts,
// no innerHTML. The data is findings.json (plus the developer's screenshots as data: URIs); this file only presents it.
// The client code lives in issue-html-client.js / issue-index-client.js so it can be checked and tested as ordinary files.

const fs = require('fs');
const path = require('path');

const embed = data => JSON.stringify(data).replace(/[<>&\u2028\u2029]/g, c => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
const read = f => fs.readFileSync(path.join(__dirname, f), 'utf8');
const CSP = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:">`;
const MAX_IMAGE_BYTES = 300 * 1024, MAX_IMAGES = 6;

// -> [{ name, uri | null, note }]: small PNG/JPEG/WEBP screenshots are embedded so the page works alone; larger ones are named, not embedded
function embedImages(issueDir, images) {
    const out = [], MIME = { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp' };
    for (const im of (images || []).slice(0, MAX_IMAGES)) {
        const f = path.join(issueDir, 'images', im.name);
        try {
            const st = fs.lstatSync(f);
            if (!st.isFile() || st.isSymbolicLink()) { out.push({ name: im.name, uri: null, note: 'not a plain file' }); continue; }
            if (st.size > MAX_IMAGE_BYTES) { out.push({ name: im.name, uri: null, note: `${Math.round(st.size / 1024)} KB is above the ${MAX_IMAGE_BYTES / 1024} KB embedding limit; the file is in the issue's images folder` }); continue; }
            if (!MIME[im.kind]) { out.push({ name: im.name, uri: null, note: 'unsupported image type' }); continue; }
            out.push({ name: im.name, uri: `data:${MIME[im.kind]};base64,${fs.readFileSync(f).toString('base64')}`, note: null });
        } catch { out.push({ name: im.name, uri: null, note: 'the file could not be read' }); }
    }
    for (const im of (images || []).slice(MAX_IMAGES)) out.push({ name: im.name, uri: null, note: `only the first ${MAX_IMAGES} screenshots are embedded` });
    return out;
}

function build(findings, images = []) {
    return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
${CSP}
<title>Issue report</title><style>${read('issue-html.css')}</style></head>
<body><main>
<h1 id="title"></h1>
<p class="meta" id="meta"></p>
<nav class="toc" id="toc" aria-label="Sections"></nav>
<div id="content"></div>
</main>
<script type="application/json" id="pg-data">${embed({ findings, images })}</script>
<script>${findings && findings.gate ? require('./issue-html-gate').apply(read('issue-html-client.js')) : read('issue-html-client.js')}</script>
</body></html>
`;
}

function buildIndex(issues) {
    return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
${CSP}
<title>Issues</title><style>${read('issue-html.css')}</style></head>
<body><main>
<h1>Issues</h1>
<p class="meta">Every issue Plugin Guard has investigated for this project. Open one for its verdict, evidence, fixes and retest history. Nothing on this page is sent anywhere.</p>
<form role="search" aria-label="Search issues" onsubmit="return false"><label for="q">Search</label><input id="q" type="search" placeholder="title, id, symptom, verdict…" autocomplete="off"></form>
<p id="count" role="status" aria-live="polite"></p>
<div class="scroll"><table><thead><tr><th scope="col">Issue</th><th scope="col">Symptom / environment</th><th scope="col">Verdict</th><th scope="col">Top hypothesis</th><th scope="col">Retests</th><th scope="col">Created</th></tr></thead><tbody id="rows"></tbody></table></div>
</main>
<script type="application/json" id="pg-data">${embed({ issues })}</script>
<script>${read('issue-index-client.js')}</script>
</body></html>
`;
}

module.exports = { build, buildIndex, embedImages, embed };
