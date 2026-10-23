const test = require('node:test');
const assert = require('node:assert');
const { sortByNumber } = require('../ui/logic');

test('sorts by last number in the name, numerically', () => {
  const out = sortByNumber(['/a/dsafdfds_10.mp4', '/a/videoldfd_2.mp4', '/a/x_1.mov']);
  assert.deepStrictEqual(out, ['/a/x_1.mov', '/a/videoldfd_2.mp4', '/a/dsafdfds_10.mp4']);
});

test('files without a number go last, alphabetically', () => {
  const out = sortByNumber(['/a/zeta.mp4', '/a/b_3.mp4', '/a/alpha.mp4']);
  assert.deepStrictEqual(out, ['/a/b_3.mp4', '/a/alpha.mp4', '/a/zeta.mp4']);
});
