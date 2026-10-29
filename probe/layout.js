// DOM-only layout checks, one in-page function each, in a fixed order. They only READ the page (geometry and computed style).
// Each returns a list of findings { title, category, severity, status, actual, near, selector, where, screenshot } in the shape the clues expect.
// Ported from the checks a person sees on a phone: sideways scrolling, text touching the screen edge, controls off-screen, overlapping text,
// words broken mid-word. NOT ported (they need much more code and are not used by the oracle): squeezed columns, group/spacing consistency, stretched images.
const SHARED = `
  const vw = document.documentElement.clientWidth;
  const docWidth = Math.max(document.documentElement.scrollWidth, document.body ? document.body.scrollWidth : 0);
  const loc = el => (window.__pgLocate ? window.__pgLocate(el) : { selector: el.tagName });
  const visible = el => { const b = el.getBoundingClientRect(), s = getComputedStyle(el); return b.width > 0 && b.height > 0 && s.visibility !== 'hidden' && s.display !== 'none' && Number(s.opacity) > 0.05; };
  const clippedOrFixed = el => {
    for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) { const s = getComputedStyle(p); if (s.position === 'fixed' || s.position === 'sticky') return true; if (/(hidden|clip|auto|scroll)/.test(s.overflowX) && p.getBoundingClientRect().right <= vw + 1) return true; }
    const s = getComputedStyle(el); return s.position === 'fixed' || s.position === 'sticky';
  };
  const all = [...document.querySelectorAll('body *')];
  const textEls = () => all.filter(el => /^(H[1-6]|P|LI|A|BUTTON|SPAN|LABEL)$/.test(el.tagName) && el.children.length <= 2 && (el.innerText || '').trim().length > 2 && visible(el) && !clippedOrFixed(el)).slice(0, 400);
`;
const CHECKS = {
    overflow: `(() => { ${SHARED}
      if (!(docWidth > vw + 1)) return null;
      const offenders = [];
      for (const el of all) { if (!visible(el)) continue; const b = el.getBoundingClientRect(); if (b.right > vw + 1 && !clippedOrFixed(el) && !offenders.some(o => o.el.contains(el))) offenders.push({ el, right: Math.round(b.right) }); if (offenders.length >= 6) break; }
      return { vw, docWidth, offenders: offenders.map(o => ({ loc: loc(o.el), right: o.right })) }; })()`,
    'text-edge': `(() => { ${SHARED}
      const rect = el => { const rg = document.createRange(); rg.selectNodeContents(el); return rg.getBoundingClientRect(); };
      const hits = textEls().filter(el => { const b = rect(el); return b.width > 0 && ((b.left < 2 && b.left > -1) || (b.right > vw - 2 && b.right <= vw + 1)); }).filter(el => el.tagName !== 'A' || !el.closest('nav')).slice(0, 4).map(el => ({ loc: loc(el), text: el.innerText.trim().slice(0, 40) }));
      return hits.length ? { hits } : null; })()`,
    unreachable: `(() => { ${SHARED}
      const hits = all.filter(el => el.matches('a[href], button, input, select, textarea') && visible(el)).filter(el => { const b = el.getBoundingClientRect(); return (b.left < -1 || b.right > vw + 1) && !clippedOrFixed(el); }).slice(0, 5).map(el => ({ loc: loc(el), text: (el.innerText || el.value || '').trim().slice(0, 40) }));
      return hits.length ? { hits } : null; })()`,
    overlap: `(() => { ${SHARED}
      const boxes = textEls().map(el => ({ el, b: el.getBoundingClientRect() })), hits = [];
      for (let i = 0; i < boxes.length && hits.length < 5; i++) for (let j = i + 1; j < boxes.length; j++) {
        const A = boxes[i], B = boxes[j]; if (A.el.contains(B.el) || B.el.contains(A.el)) continue;
        const w = Math.min(A.b.right, B.b.right) - Math.max(A.b.left, B.b.left), h = Math.min(A.b.bottom, B.b.bottom) - Math.max(A.b.top, B.b.top);
        if (w <= 2 || h <= 2) continue; const smaller = Math.min(A.b.width * A.b.height, B.b.width * B.b.height); if ((w * h) / smaller < 0.3) continue;
        hits.push({ a: loc(A.el), aText: A.el.innerText.trim().slice(0, 40), bText: B.el.innerText.trim().slice(0, 40) }); break;
      }
      return hits.length ? { hits } : null; })()`,
    'broken-words': `(() => { ${SHARED}
      const hits = [];
      for (const el of all.filter(e => /^(H[1-6]|BUTTON|A|LABEL|LI|P)$/.test(e.tagName) && visible(e) && !clippedOrFixed(e)).slice(0, 300)) {
        const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
        for (let node = walker.nextNode(); node && hits.length < 5; node = walker.nextNode()) {
          if (node.parentElement.closest('script, style')) continue;
          for (const m of node.textContent.matchAll(/[A-Za-z\\u00C0-\\u024F]{4,}/g)) { const rg = document.createRange(); rg.setStart(node, m.index); rg.setEnd(node, m.index + m[0].length); const tops = new Set([...rg.getClientRects()].filter(r => r.width > 1).map(r => Math.round(r.top))); if (tops.size > 1 && !hits.some(b => b.el === el)) hits.push({ el, word: m[0], text: el.innerText.trim().slice(0, 60) }); }
        }
        if (hits.length >= 5) break;
      }
      return hits.length ? { hits: hits.map(h => ({ loc: loc(h.el), word: h.word, text: h.text })) } : null; })()`
};
const ORDER = ['overflow', 'text-edge', 'overlap', 'broken-words', 'unreachable'];
const NARROW_ONLY = new Set(['text-edge', 'broken-words']);
const where = l => (l ? `${l.builder ? l.builder + ' ' : ''}${l.element || l.selector || ''}`.trim() : null);

// -> findings of one check at this viewport (may be empty)
async function runCheck(page, name, { viewportWidth }) {
    if (NARROW_ONLY.has(name) && viewportWidth >= 1024) return [];
    const r = await page.evaluate(CHECKS[name]);
    if (!r) return [];
    const mk = (title, severity, status, actual, l) => ({ title, category: 'responsive', severity, status, actual: String(actual).slice(0, 240), near: null, selector: (l && l.selector) || null, where: where(l), screenshot: null });
    if (name === 'overflow') return [mk('Horizontal overflow (page scrolls sideways)', r.docWidth - r.vw > 40 ? 'P2' : 'P3', 'Fail', `Page is ${r.docWidth}px wide; widest element(s): ${r.offenders.map(o => `${o.loc.element || o.loc.selector} (right edge ${o.right}px)`).join(', ')}`, r.offenders[0] && r.offenders[0].loc)];
    if (name === 'text-edge') return [mk('Text touches the screen edge (no side padding)', 'P3', 'Needs Review', r.hits.map(e => `"${e.text}"`).join(', '), r.hits[0].loc)];
    if (name === 'unreachable') return [mk('Link or button positioned outside the screen', 'P3', 'Needs Review', r.hits.map(u => `"${u.text}" ${u.loc.element || u.loc.selector}`).join(', '), r.hits[0].loc)];
    if (name === 'overlap') return [mk('Overlapping content', 'P2', 'Needs Review', r.hits.map(o => `"${o.aText}" over "${o.bText}"`).join('; '), r.hits[0].a)];
    if (name === 'broken-words') return [mk('Word breaks in the middle (no hyphen)', 'P3', 'Needs Review', r.hits.map(b => `"${b.word}" in "${b.text}"`).join('; '), r.hits[0].loc)];
    return [];
}
module.exports = { ORDER, runCheck, CHECKS };
