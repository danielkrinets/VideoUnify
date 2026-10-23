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

  const api = { sortByNumber, numberOf };
  if (typeof module !== 'undefined') module.exports = api;
  else root.Logic = api;
})(this);
