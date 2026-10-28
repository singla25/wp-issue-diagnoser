// Deterministic search for the smallest set of components whose joint presence causes the symptom (delta debugging, ddmin), run against the
// sandbox only. There is no randomness and no clock-dependent choice: the plugin order is fixed by the caller, every set is closed under
// "requires" before it is tested (a plugin is never active without the plugins it needs), and every set is tested at most once (cache by
// the hash of the set). Hard caps on page loads and wall time stop a runaway search and are reported, never hidden.
//
// test({ plugins, theme, mu }) -> 'fail' (the symptom is present) | 'pass' (absent) | 'unresolved' (a DIFFERENT failure, e.g. a fatal error
// while looking for a JavaScript error: the set says nothing about the symptom). theme: null = the site's theme, '__default__' = a default
// theme. mu: null = every must-use plugin, or a list.
//
// Phases:  baseline (everything on must fail) -> nothing-on (is it plugins at all?) -> one-at-a-time removal (which plugins are NECESSARY)
//          -> verify the necessary set / ddmin -> more independent causes -> theme -> must-use plugins.

const crypto = require('crypto');
const fs = require('fs');

class CapReached extends Error { constructor(kind) { super(kind); this.kind = kind; } }
const DEFAULT_CAPS = { maxLoads: 40, maxMs: 15 * 60 * 1000, maxCauses: 3 };

async function run({ plugins, requires = {}, mu = [], test, caps = {}, logFile = null, clock = () => Date.now(), top = [], label = {} }) {
    const C = { ...DEFAULT_CAPS, ...caps };
    const order = new Map(plugins.map((p, i) => [p, i]));
    const byOrder = a => [...new Set(a)].sort((x, y) => order.get(x) - order.get(y));
    const start = clock();
    const log = [], seen = new Map(), executed = [], tests = [];
    let loads = 0, cacheHits = 0, unresolved = 0, n = 0;
    const L = s => log.push(s);

    // --- dependency helpers (requires: slug -> slugs it needs, installed ones only) ---
    const need = p => requires[p] || [];
    const closure = set => { const out = new Set(set), todo = [...set]; while (todo.length) { const p = todo.pop(); for (const d of need(p)) if (order.has(d) && !out.has(d)) { out.add(d); todo.push(d); } } return byOrder([...out]); };
    const dependents = p => { const out = new Set([p]); let grew = true; while (grew) { grew = false; for (const q of plugins) if (!out.has(q) && need(q).some(d => out.has(d))) { out.add(q); grew = true; } } return out; };
    const without = (set, drop) => { const gone = new Set(); for (const p of drop) for (const d of dependents(p)) gone.add(d); return byOrder(set.filter(p => !gone.has(p))); };

    // --- the cached, capped test ---
    const hashOf = s => crypto.createHash('sha256').update(JSON.stringify([s.plugins, s.theme, s.mu])).digest('hex').slice(0, 12);
    async function T(set, why) {
        const s = { plugins: closure(set.plugins), theme: set.theme === undefined ? null : set.theme, mu: set.mu === undefined ? null : set.mu };
        const h = hashOf(s), tag = `plugins=[${s.plugins.join(',')}] theme=${s.theme === null ? 'site' : s.theme} mu=${s.mu === null ? 'all' : `[${s.mu.join(',')}]`}`;
        if (seen.has(h)) { cacheHits++; L(`    ${h} ${tag} -> ${seen.get(h).result} (cached, test #${seen.get(h).n})${why ? `  ${why}` : ''}`); return seen.get(h).result; }
        if (loads >= C.maxLoads) throw new CapReached('loads');
        if (clock() - start >= C.maxMs) throw new CapReached('time');
        loads++; n++;
        const result = await test(s);
        if (!['fail', 'pass', 'unresolved'].includes(result)) throw new Error(`the test returned "${result}", expected fail | pass | unresolved`);
        if (result === 'unresolved') unresolved++;
        seen.set(h, { result, n }); executed.push(h); tests.push({ n, hash: h, plugins: s.plugins, theme: s.theme, mu: s.mu, result, why: why || null });
        L(`#${String(n).padStart(2, '0')} ${h} ${tag} -> ${result}${why ? `  ${why}` : ''}`);
        return result;
    }

    // --- ddmin over a list of items that must stay together with their requirements ---
    async function ddmin(items, mk, isFail) {
        let c = items.slice(), g = 2;
        while (c.length >= 2) {
            const size = Math.ceil(c.length / g), parts = [];
            for (let i = 0; i < c.length; i += size) parts.push(c.slice(i, i + size));
            let reduced = false;
            for (const part of parts) { if ((await T(mk(part), `ddmin subset of ${c.length}`)) === 'fail') { c = closureIfPlugins(part); g = 2; reduced = true; break; } }
            if (!reduced) for (const part of parts) {
                const comp = c.filter(x => !part.includes(x));
                if (!comp.length) continue;
                if ((await T(mk(comp), `ddmin complement of ${c.length}`)) === 'fail') { c = closureIfPlugins(comp); g = Math.max(g - 1, 2); reduced = true; break; }
            }
            if (!reduced) { if (g >= c.length) break; g = Math.min(c.length, g * 2); }
        }
        return c;
    }
    const closureIfPlugins = a => (a.every(x => order.has(x)) ? closure(a) : a);

    const out = { status: null, symptom_without_plugins: null, causes: [], theme: null, mu: null, loads: 0, cache_hits: 0, unresolved: 0, capped: null, minimal: true, necessary: [], log, executed, tests, caps: C, label };
    const finish = status => {
        out.status = status; out.loads = loads; out.cache_hits = cacheHits; out.unresolved = unresolved; out.executed = executed;
        L(`== result: ${status}; ${loads} page loads, ${cacheHits} answered from the cache, ${unresolved} unresolved${out.capped ? `; STOPPED by the ${out.capped} cap` : ''}`);
        for (const c of out.causes) L(`   cause: [${c.plugins.join(', ')}]${Object.keys(c.required_by).length ? ` (${Object.entries(c.required_by).map(([p, by]) => `${p} is required by ${by.join(', ')}`).join('; ')})` : ''}${c.minimal ? '' : ' (not proven minimal)'}`);
        if (out.theme) L(`   theme: ${out.theme.involved === null ? 'not tested' : out.theme.involved ? 'INVOLVED (the symptom goes away with a default theme)' : 'not involved'}`);
        if (out.mu) L(`   must-use plugins: ${out.mu.culprits ? `[${out.mu.culprits.join(', ')}]` : out.mu.note}`);
        if (logFile) fs.writeFileSync(logFile, log.join('\n') + '\n', { mode: 0o600 });
        return out;
    };
    L(`== bisect: ${plugins.length} active plugin(s) in fixed order [${plugins.join(', ')}]; ${mu.length} must-use plugin(s); caps ${C.maxLoads} loads, ${Math.round(C.maxMs / 1000)} s`);
    for (const p of plugins) if (need(p).length) L(`   ${p} requires [${need(p).join(', ')}]`);

    try {
        L('== baseline: everything on');
        if ((await T({ plugins, theme: null, mu: null }, 'everything on')) !== 'fail') return finish('not-reproduced-at-start');
        L('== nothing on: is it the plugins at all?');
        const bare = await T({ plugins: [], theme: null, mu: null }, 'no plugin active');
        let causePlugins = [];
        out.symptom_without_plugins = bare === 'fail';   // said in plain words in every report: it is NOT a plugin conflict
        if (bare === 'fail') L('   the symptom is there with NO plugin active: not plugin-related');
        else {
            L('== one at a time: which plugins are necessary (the symptom goes away without them)');
            const necessary = [];
            for (const p of plugins) { const r = await T({ plugins: without(plugins, [p]), theme: null, mu: null }, `without ${p}${dependents(p).size > 1 ? ` and its dependents` : ''}`); if (r === 'pass') necessary.push(p); }
            out.necessary = necessary;
            const mkP = set => ({ plugins: set, theme: null, mu: null });
            const find = async from => {
                let cand = null;
                if (necessary.length && from === plugins) {
                    L(`== the necessary plugins [${necessary.join(', ')}] on their own`);
                    const nc = closure(necessary);
                    if ((await T(mkP(nc), 'necessary set + requirements')) === 'fail') {
                        // verify 1-minimality: removing any one of them must make the symptom go away
                        let smaller = null;
                        for (const p of nc) { const sub = without(nc, [p]); if (sub.length && (await T(mkP(sub), `verify: without ${p}`)) === 'fail') { smaller = sub; break; } }
                        cand = smaller ? await ddmin(smaller, mkP, 'fail') : nc;
                    }
                }
                if (!cand && top.length >= 2 && necessary.length === 0) {
                    L('== no single removal helps: pairs among the strongest candidates');
                    const t = byOrder(top.filter(x => order.has(x))).slice(0, 6);
                    for (let i = 0; i < t.length && !cand; i++) for (let j = i + 1; j < t.length && !cand; j++) if ((await T(mkP([t[i], t[j]]), `pair ${t[i]} + ${t[j]}`)) === 'fail') cand = closure([t[i], t[j]]);
                    if (cand) cand = await ddmin(cand, mkP, 'fail');
                }
                if (!cand) { L(`== ddmin over ${from.length} plugin(s)`); cand = await ddmin(from, mkP, 'fail'); }
                return cand;
            };
            let pool = plugins;
            for (let k = 0; k < C.maxCauses; k++) {
                const c = await find(pool);
                // members that are in the set because another member REQUIRES them (they cannot be turned off without turning that member off too)
                const requiredBy = {}; for (const p of c) { const by = c.filter(q => q !== p && need(q).includes(p)); if (by.length) requiredBy[p] = by; }
                out.causes.push({ plugins: c, required_by: requiredBy, minimal: true });
                if (k === C.maxCauses - 1) break;
                const rest = without(pool, c);
                if (!rest.length) break;
                L(`== is there another, independent cause? everything except [${c.join(', ')}]`);
                const r = await T({ plugins: rest, theme: null, mu: null }, 'remainder');
                if (r !== 'fail') break;
                pool = rest;
            }
            causePlugins = out.causes[0] ? out.causes[0].plugins : [];
        }
        // ---- theme ----
        L('== theme: does the symptom survive a default theme?');
        const withDefault = await T({ plugins: causePlugins, theme: '__default__', mu: null }, `cause set with a default theme`);
        out.theme = { involved: withDefault === 'pass' ? true : withDefault === 'fail' ? false : null, tested: '__default__', result: withDefault };
        // ---- must-use plugins, only when neither plugins nor the theme explain it ----
        if (!causePlugins.length && out.theme.involved === false) {
            if (!mu.length) out.mu = { culprits: null, note: 'there are no must-use plugins; the cause is in core, the database or the server' };
            else {
                L(`== must-use plugins: ddmin over ${mu.length}`);
                const keep = await ddmin(mu, set => ({ plugins: [], theme: '__default__', mu: set }), 'fail');
                const none = await T({ plugins: [], theme: '__default__', mu: [] }, 'no must-use plugin');
                out.mu = none === 'fail' ? { culprits: null, note: 'the symptom remains with no plugin, no must-use plugin and a default theme: core, the database, or the server' } : { culprits: keep };
            }
        }
        return finish(out.causes.length ? 'cause-found' : out.theme.involved ? 'theme-is-the-cause' : out.mu && out.mu.culprits ? 'mu-plugin-is-the-cause' : 'not-explained');
    } catch (e) {
        if (!(e instanceof CapReached)) throw e;
        out.capped = e.kind; out.minimal = false;
        if (!out.causes.length) L('   (no cause established before the cap was reached)');
        return finish(out.causes.length ? 'cause-found-not-proven-minimal' : 'capped-without-result');
    }
}

module.exports = { run, DEFAULT_CAPS, CapReached };
