// The ONLY place in the probe that types or clicks. Called by worker.js solely when the job is a SANDBOX job (a throwaway copy on 127.0.0.1);
// the read-only static test (selftest-issue-evidence.js) forbids these calls in every other probe file.
// Credentials come from the environment (PG_TEST_USER / PG_TEST_PASSWORD), never from files.

async function login({ page, context, governor, base, cut }) {
    try {
        await governor.navigate(page, new URL('wp-login.php', base).href, { waitUntil: 'load', settleMs: 300 });
        await page.fill('#user_login', process.env.PG_TEST_USER); await page.fill('#user_pass', process.env.PG_TEST_PASSWORD);
        await Promise.all([page.waitForNavigation({ waitUntil: 'load', timeout: 20000 }).catch(() => {}), page.click('#wp-submit')]);
        const cookies = await context.cookies();
        return { attempted: true, ok: cookies.some(c => /^wordpress_logged_in/.test(c.name)) };
    } catch (e) { return { attempted: true, ok: false, error: cut(e.message, 120) }; }
}

// Click `spec.from` and report whether `spec.to` changed. The selector is only ever passed to querySelector / page.click inside the sandbox.
async function click({ page, spec, cut }) {
    const snap = sel => page.evaluate(q => { try { const e = document.querySelector(q); if (!e) return { found: false }; const b = e.getBoundingClientRect(), st = getComputedStyle(e); return { found: true, visible: b.width > 0 && b.height > 0 && st.display !== 'none' && st.visibility !== 'hidden', text: (e.innerText || '').slice(0, 300), html: e.outerHTML.slice(0, 3000), cls: e.className && String(e.className) }; } catch { return { found: false }; } }, sel);
    const before = await snap(spec.to), from = await snap(spec.from);
    const rec = { from: spec.from, to: spec.to, clicked: false, changed: false };
    if (!from.found || !before.found) rec.error = !from.found ? 'the element to click was not found' : 'the element that should change was not found';
    else { try { await page.click(spec.from, { timeout: 5000 }); rec.clicked = true; await page.waitForTimeout(1500); const after = await snap(spec.to); rec.changed = JSON.stringify(before) !== JSON.stringify(after); } catch (e) { rec.error = cut(e.message, 120); } }
    return rec;
}
module.exports = { login, click };
