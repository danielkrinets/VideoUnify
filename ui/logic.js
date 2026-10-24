// Shared by tests (Node) and the UI (browser, as window.Logic).
(function (root) {
  const base = (p) => p.split(/[\\/]/).pop().replace(/\.[^.]+$/, '');

  // Last number in the name decides the order; files without a number go last.
  function numberOf(p) {
    const m = base(p).match(/(\d+)(?!.*\d)/);
    return m ? parseInt(m[1], 10) : null;
  }

  function sortByNumber(list, key = (x) => x) {
    return [...list].sort((a, b) => {
      const na = numberOf(key(a)), nb = numberOf(key(b));
      if (na !== null && nb !== null && na !== nb) return na - nb;
      if (na !== null && nb === null) return -1;
      if (na === null && nb !== null) return 1;
      return key(a).localeCompare(key(b), undefined, { numeric: true });
    });
  }

  // Oldest file first; files with no date (0) go last. Stable, so ties keep their order.
  function sortByDate(list, key = (x) => x) {
    const t = (x) => key(x) || Infinity;
    return [...list].sort((a, b) => (t(a) === t(b) ? 0 : t(a) < t(b) ? -1 : 1));
  }

  // Keeps the first item per key; the rest are copies. `seen` lets callers dedupe against an existing list.
  function dedupe(list, key, seen = new Set()) {
    const kept = [], copies = [];
    for (const x of list) {
      const k = key(x);
      if (seen.has(k)) copies.push(x); else { seen.add(k); kept.push(x); }
    }
    return { kept, copies };
  }

  const api = { sortByNumber, numberOf, sortByDate, dedupe };
  if (typeof module !== 'undefined') module.exports = api;
  else root.Logic = api;
})(this);
