// How many page loads the probe PLANNED, read from probe.json: ONE place, used by the check rows (issue/checkpoints.js), the oracle recomputation (issue/validate.js)
// and the stored oracle answer (issue/probe.js). Pure; no file, no request.
//
// probe.json `planned` is an object { pages, viewports, loads, notes } (issue/probe.js writes it before the loads; `loads` is the FULL plan: pages x screen sizes).
// Older data and some tests hold a plain number. The probe does not load a page again at another screen size after a 5xx: such a load is recorded as a page with `skipped`
// (probe/worker.js), and it is not counted as planned any more.

// the planned page loads as a whole number above 0 (a plain number or an object with `loads`); anything else (missing, 0, fractional, a string) is null: "not usable"
const plannedLoads = v => { const n = typeof v === 'number' ? v : v && typeof v === 'object' ? v.loads : null; return Number.isInteger(n) && n > 0 ? n : null; };

// the number the oracle works with: a plain number as it is; an object: the full plan minus the loads that were skipped on purpose; not usable: the number of page records.
// A partial probe (a stop by protection, a crash) keeps its full plan, so the oracle can say "partial" and never "no" for a probe that did not finish.
function observedPlanned(probe) {
    const pages = probe && Array.isArray(probe.pages) ? probe.pages : [];
    const n = plannedLoads(probe && probe.planned);
    if (n === null) return pages.length;
    if (typeof probe.planned === 'number') return n;
    return Math.max(0, n - pages.filter(p => p && p.skipped).length);
}

module.exports = { plannedLoads, observedPlanned };
