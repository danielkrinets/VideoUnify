const test = require('node:test');
const assert = require('node:assert');
const { sortByNumber, sortByDate, dedupe } = require('../ui/logic');

test('sorts by last number in the name, numerically', () => {
  const out = sortByNumber(['/a/dsafdfds_10.mp4', '/a/videoldfd_2.mp4', '/a/x_1.mov']);
  assert.deepStrictEqual(out, ['/a/x_1.mov', '/a/videoldfd_2.mp4', '/a/dsafdfds_10.mp4']);
});

test('files without a number go last, alphabetically', () => {
  const out = sortByNumber(['/a/zeta.mp4', '/a/b_3.mp4', '/a/alpha.mp4']);
  assert.deepStrictEqual(out, ['/a/b_3.mp4', '/a/alpha.mp4', '/a/zeta.mp4']);
});

test('sortByDate: oldest first, no date last, stable', () => {
  const out = sortByDate([{ n: 'a', t: 0 }, { n: 'b', t: 5 }, { n: 'c', t: 2 }, { n: 'd', t: 5 }], (x) => x.t);
  assert.deepStrictEqual(out.map((x) => x.n), ['c', 'b', 'd', 'a']);
});

test('dedupe keeps first, honours existing keys', () => {
  const { kept, copies } = dedupe(['a', 'b', 'a', 'c'], (x) => x, new Set(['c']));
  assert.deepStrictEqual([kept, copies], [['a', 'b'], ['a', 'c']]);
});
