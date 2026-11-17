import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sma, ema, rsi, macd, bollinger, atr, pivots } from '../lib/indicators.js';

const close = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} ≈ ${b}`);

test('sma basic values and null head', () => {
  const r = sma([1, 2, 3, 4, 5], 3);
  assert.deepEqual(r.slice(0, 2), [null, null]);
  close(r[2], 2);
  close(r[4], 4);
});

test('sma with period longer than data is all null', () => {
  assert.deepEqual(sma([1, 2], 5), [null, null]);
});

test('ema seeds with sma and handles leading nulls', () => {
  const r = ema([null, null, 1, 2, 3, 4], 2);
  assert.equal(r[2], null);
  close(r[3], 1.5);
  close(r[4], 3 * (2 / 3) + 1.5 * (1 / 3));
  assert.deepEqual(ema([1], 3), [null]);
});

test('rsi: only gains -> 100, only losses -> 0, flat -> 50', () => {
  const up = Array.from({ length: 30 }, (_, i) => 100 + i);
  const down = Array.from({ length: 30 }, (_, i) => 100 - i);
  const flat = Array.from({ length: 30 }, () => 100);
  assert.equal(rsi(up)[29], 100);
  assert.equal(rsi(down)[29], 0);
  assert.equal(rsi(flat)[29], 50);
  assert.equal(rsi(up)[13], null);
});

test('rsi stays within 0..100 on noisy data', () => {
  let p = 100;
  const data = Array.from({ length: 300 }, (_, i) => (p += Math.sin(i * 1.7) * 3));
  for (const v of rsi(data)) if (v != null) assert.ok(v >= 0 && v <= 100);
});

test('macd histogram = line - signal', () => {
  const data = Array.from({ length: 80 }, (_, i) => 100 + i + Math.sin(i) * 5);
  const m = macd(data);
  const i = 79;
  close(m.hist[i], m.line[i] - m.signal[i]);
  assert.equal(m.signal[20], null);
});

test('bollinger bands are symmetric around the mid line', () => {
  const data = Array.from({ length: 40 }, (_, i) => 50 + (i % 5));
  const b = bollinger(data);
  close(b.upper[39] - b.mid[39], b.mid[39] - b.lower[39]);
  assert.ok(b.upper[39] > b.lower[39]);
});

test('atr is positive and uses true range with gaps', () => {
  const c = Array.from({ length: 20 }, (_, i) => ({ open: 10, high: 11, low: 9, close: 10 + (i === 10 ? 5 : 0) }));
  const a = atr(c, 14);
  assert.equal(a[12], null);
  assert.ok(a[19] > 2);
});

test('pivots find obvious swing high and low', () => {
  const highs = [5, 6, 7, 10, 7, 6, 5, 4, 3, 4, 5, 6, 7];
  const c = highs.map((h) => ({ high: h, low: h - 0.5 }));
  const p = pivots(c, 3);
  assert.deepEqual(p.highs, [10]);
  assert.deepEqual(p.lows, [2.5]);
  // Bars too close to the end can't be confirmed.
  assert.deepEqual(pivots(c.slice(0, 5), 3), { highs: [], lows: [] });
});
