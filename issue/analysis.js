// Phases C and D for one issue: custom-code-first analysis, then the component index and "who provides this feature" table.
// Reads evidence.json (phase B), writes work/custom-code.json, work/components.json and work/feature-index.json. Read-only on the site.

const fs = require('fs');
const path = require('path');
const store = require('../lib/issue-store');
const cfgLib = require('../lib/config');
const ownership = require('../lib/ownership');
const custom = require('./custom');
const indexer = require('./index');
const collideMod = require('./collide');
const graphMod = require('./graph');
const kbMod = require('./kb');
const hyp = require('./hypotheses');

const write = (dir, rel, body) => { const f = path.join(dir, rel); fs.mkdirSync(path.dirname(f), { recursive: true, mode: 0o700 }); fs.writeFileSync(f, JSON.stringify(body, null, 2) + '\n', { mode: 0o600 }); };
// evidence names components as "plugin:x"; components.js refs plugins by bare slug
// hooks named by the taxonomy entries of the features the report mentions
function taxonomyHooks(evidence) {
    const tax = require('./describe').loadTaxonomy();
    return [...new Set((evidence.features || []).flatMap(f => ((tax.find(t => t.id === f.id) || {}).signals || {}).hooks || []))];
}
// the subset of those hooks whose taxonomy signal was verified against official documentation
function taxonomyHooksVerified(evidence) {
    const tax = require('./describe').loadTaxonomy();
    return new Set((evidence.features || []).flatMap(f => ((tax.find(t => t.id === f.id) || {}).verified_signals || {}).hooks || []));
}
const toRef = id => String(id).replace(/^plugin:/, '');

function run(id, { root, config = null } = {}) {
    const issue = store.load(id), dir = store.dirOf(id);
    const evFile = path.join(dir, 'work', 'evidence.json');
    const evidence = fs.existsSync(evFile) ? JSON.parse(fs.readFileSync(evFile, 'utf8')) : { clues: [], features: [], component_hints: [] };
    if (!root) return { steps: [{ id: 'custom-first', label: 'Custom code first', status: 'NOT_RUN', reason: 'no local WordPress root was given (--root)' }, { id: 'component-index', label: 'Component and feature index', status: 'NOT_RUN', reason: 'no local WordPress root was given (--root)' }] };

    const cfg = cfgLib.resolve({ root, config: config || undefined });
    if (cfg.errors.length) { const e = new Error(cfg.errors.join('\n')); e.exitCode = 2; throw e; }
    const policy = cfg.config.policy || ownership.loadPolicy(root, {}).policy;

    const focusNames = evidence.clues.filter(c => ['php-redeclare', 'php-undefined-function'].includes(c.type)).map(c => c.value);
    const hints = evidence.component_hints.slice(0, 8).map(h => toRef(h.component));
    const analysis = custom.analyse(root, { policy, hints, focus: { names: focusNames } });
    const text = [issue.title, issue.description, issue.since, issue.changed_before].filter(Boolean).join('\n');
    const index = indexer.build(root, analysis, evidence, { description: { title: issue.title, text } });

    // ---- phase E: collisions, graph, slice, knowledge base ----
    const collide = collideMod.run(root, analysis);
    const graph = graphMod.build(root, analysis, collide, { featureHooks: taxonomyHooks(evidence), featureHooksVerified: taxonomyHooksVerified(evidence), reproduced: evidence.reproduced || null });
    const seeds = [...new Set([...index.providers.flatMap(p => p.rows.map(r => r.component)), ...hints, ...evidence.clues.filter(c => c.source.kind === 'log' && c.type === 'component-path').map(c => toRef(c.value))])].filter(r => analysis.components.some(c => c.ref === r));
    const slice = graphMod.slice(graph, analysis, collide, { seeds, depth: 2 });
    const kbHits = kbMod.evaluate({ components: analysis.components, facts: analysis.facts, observations: analysis.observations, collisions: collide.collisions, symptom: issue.symptom, clueTypes: [...new Set(evidence.clues.map(c => c.type))] });
    const descFile = path.join(dir, 'work', 'description.json');
    const description = fs.existsSync(descFile) ? JSON.parse(fs.readFileSync(descFile, 'utf8')) : { dates: [] };

    // ---- phase F: hypotheses ----
    const hypotheses = hyp.build({ issue, evidence, analysis, index, collide, graph, kb: kbHits, description, steps: evidence.steps, featureHooks: taxonomyHooks(evidence), featureHooksVerified: taxonomyHooksVerified(evidence), reproduced: evidence.reproduced || null });

    write(dir, 'work/custom-code.json', { mode: analysis.mode, message: analysis.message, policy: analysis.policy, components: analysis.components, observations: analysis.observations, templates: analysis.templates, core_handles: analysis.core_handles, steps: analysis.steps,
        facts: Object.fromEntries(Object.entries(analysis.facts).filter(([ref]) => analysis.components.find(c => c.ref === ref).depth === 'syntax-tree')) });
    write(dir, 'work/components.json', { components: index.components });
    write(dir, 'work/feature-index.json', { scoring: index.scoring, query: index.query, text_matches: index.text_matches, providers: index.providers });
    write(dir, 'work/collisions.json', { assets: collide.assets, collisions: collide.collisions, effective_jquery: collide.effective_jquery, steps: collide.steps });
    write(dir, 'work/graph.json', { nodes: graph.nodes, edges: graph.edges, edges_total: graph.edges_total, truncated: graph.truncated, problems: graph.problems, relevant_hooks: graph.relevant_hooks, core_options_known: graph.core_options_known });
    write(dir, 'work/slice.json', slice);
    write(dir, 'work/kb-hits.json', { hits: kbHits, not_applicable: kbHits.not_applicable || [] });
    write(dir, 'work/hypotheses.json', hypotheses);
    const steps = [...analysis.steps, ...collide.steps,
        { id: 'component-index', label: 'Component and feature index', status: 'PASSED', reason: null, components: index.components.length, features: index.providers.length, text_matches: index.text_matches.length },
        { id: 'graph', label: 'Dependency and conflict graph', status: 'PASSED', reason: graph.truncated ? `only the first ${graph.edges.length} of ${graph.edges_total} relations are kept` : null, nodes: graph.nodes.length, edges: graph.edges_total, problems: graph.problems.length },
        { id: 'slice', label: 'Slice around the issue', status: seeds.length ? 'PASSED' : 'SKIPPED', reason: seeds.length ? null : 'no component could be tied to the report, so there is nothing to slice around', seeds: seeds.length, nodes: slice.nodes.length, also_found: slice.also_found.observations.length + slice.also_found.collisions.length },
        { id: 'knowledge-base', label: 'Known interaction patterns', status: 'PASSED', reason: null, hits: kbHits.length, not_applicable: (kbHits.not_applicable || []).length, unverified_entries: kbMod.load().filter(e => !e.verified).length },
        { id: 'hypotheses', label: 'Hypotheses', status: 'PASSED', reason: `${hypotheses.hypotheses.length} listed of ${hypotheses.considered} considered; none is confirmed by this step`, count: hypotheses.hypotheses.length }];
    const cur = store.load(id); cur.status = 'ANALYSED_STATIC'; store.save(cur);
    const top = [...new Set(hypotheses.hypotheses.flatMap(h => h.components))];
    analysis.top = top;
    return { steps, analysis, index, collide, graph, slice, kb: kbHits, hypotheses, evidence, issue, description, ctxForHypotheses: { issue, evidence, analysis, index, collide, graph, kb: kbHits, description, steps: evidence.steps, featureHooks: taxonomyHooks(evidence), featureHooksVerified: taxonomyHooksVerified(evidence), reproduced: evidence.reproduced || null } };
}

// After the sandbox phase: rebuild the hypotheses with the bisection result (the strongest support) and write them again.
function applyBisect(id, an, { bisect = null, sandboxReproduced = null } = {}) {
    const dir = store.dirOf(id);
    const h = hyp.build({ ...an.ctxForHypotheses, bisect, sandboxReproduced });
    write(dir, 'work/hypotheses.json', h);
    an.hypotheses = h;
    return h;
}
module.exports = { run, applyBisect, toRef };
