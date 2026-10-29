// WordPress knowledge the probe needs, derived from the public page only:
//   INIT_SCRIPT   injected before the site's scripts: window.__pgLocate(el) (CSS path, region, page builder element, nearest heading) and the
//                 largest-contentful-paint observer (window.__pgPerf.lcp), for the lcp-over oracle;
//   pageContext() post id, post type, template, builders, theme and plugins seen in the page's assets;
//   assetSource() which plugin / theme / builder / core a file URL belongs to (this is how a failing asset is attributed to a component).
const INIT_SCRIPT = `(() => {
  if (window.__pgLocate) return;
  function cssPath(el) {
    if (!el || el.nodeType !== 1) return '';
    if (el.id) return '#' + CSS.escape(el.id);
    const parts = [];
    for (let n = el; n && n.nodeType === 1 && parts.length < 4; n = n.parentElement) {
      if (n.id) { parts.unshift('#' + CSS.escape(n.id)); break; }
      let p = n.tagName.toLowerCase();
      const cls = [...n.classList].filter(c => !/^(swiper-slide-|is-|active|hover|focus)/.test(c)).slice(0, 2);
      if (cls.length) p += '.' + cls.map(c => CSS.escape(c)).join('.');
      parts.unshift(p);
    }
    return parts.join(' > ');
  }
  function nearestHeading(el) {
    for (let n = el; n && n !== document.body; n = n.parentElement) {
      const h = n.matches && n.matches('h1,h2,h3,h4') ? n : n.querySelector && n.querySelector('h1,h2,h3,h4');
      if (h && h.innerText && h.innerText.trim()) return h.innerText.trim().replace(/\\s+/g, ' ').slice(0, 60);
    }
    return null;
  }
  window.__pgLocate = function (el) {
    if (!el || el.nodeType !== 1) return null;
    const out = { selector: cssPath(el), tag: el.tagName.toLowerCase(), region: null, builder: null, element: null, elementType: null, ownerId: null, heading: nearestHeading(el) };
    const region = el.closest('header, footer, nav, aside, main'); out.region = region ? region.tagName.toLowerCase() : null;
    for (let n = el; n && n !== document.body; n = n.parentElement) { const m = n.id && n.id.match(/^_?([a-z_]+?)-(\\d+)-(\\d+)$/); if (m) { out.builder = 'Oxygen'; out.element = '#' + n.id; out.elementType = m[1]; out.ownerId = Number(m[3]); break; } }
    const eDoc = el.closest('[data-elementor-id]');
    if (!out.builder && eDoc) { const w = el.closest('.elementor-element[data-id]'); out.builder = 'Elementor'; out.ownerId = Number(eDoc.getAttribute('data-elementor-id')); if (w) { out.element = '.elementor-element-' + w.getAttribute('data-id'); out.elementType = w.getAttribute('data-widget_type') || w.getAttribute('data-element_type'); } }
    if (!out.builder && el.closest('[class*="fusion-"]')) { out.builder = 'Avada'; const e2 = el.closest('[class*="fusion-"][class*="-element"], [class*="fusion-imageframe"], [class*="fusion-button"], [class*="fusion-text"], [class*="fusion-title"]'); out.element = e2 ? cssPath(e2) : null; }
    if (!out.builder && el.closest('[class*="et_pb_"]')) { out.builder = 'Divi'; const mod = el.closest('.et_pb_module'); out.element = mod ? (mod.id ? '#' + mod.id : cssPath(mod)) : null; }
    if (!out.builder && el.closest('.vc_row, .wpb_row')) { out.builder = 'WPBakery'; const it = el.closest('.wpb_content_element, .vc_btn3-container, .wpb_single_image'); out.element = it ? (it.id ? '#' + it.id : cssPath(it)) : null; }
    const fl = el.closest('.fl-builder-content[data-post-id]');
    if (!out.builder && fl) { const mod = el.closest('.fl-module'); out.builder = 'Beaver Builder'; out.ownerId = Number(fl.getAttribute('data-post-id')) || null; out.element = mod && mod.getAttribute('data-node') ? '.fl-node-' + mod.getAttribute('data-node') : null; }
    if (!out.builder && el.closest('[id^="brxe-"], #brx-header, #brx-content, #brx-footer')) { const it = el.closest('[id^="brxe-"]'); out.builder = 'Bricks'; out.element = it ? '#' + it.id : null; }
    if (!out.builder) { const b = el.closest('[class*="wp-block-"]'); if (b) { out.builder = 'Block editor'; out.elementType = [...b.classList].find(c => c.startsWith('wp-block-')); out.element = cssPath(b); } }
    return out;
  };
  const perf = window.__pgPerf = { lcp: null };
  try { new PerformanceObserver(list => { for (const e of list.getEntries()) perf.lcp = e.startTime; }).observe({ type: 'largest-contentful-paint', buffered: true }); } catch (e) {}
})();`;

async function pageContext(page) {
    return page.evaluate(() => {
        const cls = document.body ? [...document.body.classList] : [];
        const find = re => { for (const c of cls) { const m = c.match(re); if (m) return m[1]; } return null; };
        const postId = find(/^(?:page-id|postid)-(\d+)$/);
        const postType = cls.includes('home') ? 'front page' : cls.includes('page') ? 'page' : find(/^single-([\w-]+)$/) ? find(/^single-([\w-]+)$/) : cls.includes('category') ? 'category archive' : cls.includes('archive') ? 'archive' : cls.includes('search') ? 'search' : cls.includes('error404') ? '404' : null;
        const template = find(/^page-template-([\w-]+)$/);
        const urls = [...document.querySelectorAll('link[href], script[src], img[src]')].map(e => e.href || e.src || '');
        const plugins = [...new Set(urls.map(u => (u.match(/\/wp-content\/plugins\/([\w-]+)\//) || [])[1]).filter(Boolean))];
        const themes = [...new Set([...cls.map(c => (c.match(/^wp-(?:child-)?theme-([\w-]+)$/) || [])[1]), ...urls.map(u => (u.match(/\/wp-content\/themes\/([\w-]+)\//) || [])[1])].filter(Boolean))];
        const builders = [];
        if (cls.includes('oxygen-body') || document.querySelector('.ct-section, [id^="div_block-"]')) builders.push('Oxygen');
        if (document.querySelector('[data-elementor-id]')) builders.push('Elementor');
        if (document.querySelector('.fusion-builder-row, .fusion-fullwidth') || cls.some(c => c.startsWith('fusion-'))) builders.push('Avada');
        if (document.querySelector('.et_pb_section, .et-l')) builders.push('Divi');
        if (document.querySelector('.vc_row, .wpb_row')) builders.push('WPBakery');
        if (document.querySelector('.fl-builder-content')) builders.push('Beaver Builder');
        if (document.querySelector('[id^="brxe-"], #brx-content')) builders.push('Bricks');
        if (document.querySelector('[class*="wp-block-"]')) builders.push('Block editor');
        return { postId: postId ? Number(postId) : null, postType, template, plugins, themes, builders };
    });
}

function assetSource(url) {
    try {
        const p = new URL(url).pathname; let m;
        if ((m = p.match(/\/wp-content\/plugins\/([\w-]+)\//))) return { type: 'plugin', name: m[1], hint: `Plugin "${m[1]}" enqueues this file` };
        if ((m = p.match(/\/wp-content\/themes\/([\w-]+)\//))) return { type: 'theme', name: m[1], hint: `Theme "${m[1]}" enqueues this file` };
        if (/\/wp-content\/uploads\/oxygen\/css\//.test(p)) return { type: 'builder', name: 'Oxygen', hint: 'Oxygen-generated CSS: Oxygen > Settings > CSS Cache > Regenerate' };
        if (/\/wp-content\/uploads\/elementor\/css\//.test(p)) return { type: 'builder', name: 'Elementor', hint: 'Elementor-generated CSS: Elementor > Tools > Regenerate CSS & Data' };
        if (/\/wp-content\/uploads\/fusion-styles\//.test(p)) return { type: 'builder', name: 'Avada', hint: 'Avada-generated CSS: Avada > Options > Performance > Reset Avada Caches' };
        if (/\/wp-content\/uploads\//.test(p)) return { type: 'media', name: 'Media Library', hint: 'File in the Media Library (uploads)' };
        if (/\/wp-includes\//.test(p)) return { type: 'core', name: 'WordPress core', hint: 'WordPress core asset' };
        return { type: 'other', name: new URL(url).host, hint: null };
    } catch { return { type: 'other', name: null, hint: null }; }
}
module.exports = { INIT_SCRIPT, pageContext, assetSource };
