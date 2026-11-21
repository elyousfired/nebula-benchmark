import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectCrossings, openPosition, updatePosition, realizedPnlPct, summarize, DEFAULT_CONFIG } from '../bot/engine.js';

const cfg = DEFAULT_CONFIG;
const lv = { entry: 8, tp: 14 };

// Token at +8 pts on 24H at price 108 => 24H base = 100, wall (+14 pts) = 114 => +5.56% from entry 108.
const open = (over = {}) => openPosition({ symbol: 'ABCUSDT', ask: 108, last: 108, curvePts: 8, levels: lv, now: 0, ...over }).position;

test('detectCrossings: only fresh upward crosses, no chasing, nothing on first tick', () => {
  assert.deepEqual(detectCrossings(null, { A: 9 }, 8, 2), []);
  assert.deepEqual(detectCrossings({ A: 7, B: 9, C: 5, D: 7 }, { A: 8.5, B: 10, C: 7, D: 11 }, 8, 2), ['A']);
});

test('openPosition freezes levels into prices', () => {
  const p = open();
  assert.equal(p.entry, 108);
  assert.ok(Math.abs(p.tp1 - 114) < 1e-6);
  assert.ok(Math.abs(p.final - 118.8) < 1e-6);
  assert.ok(Math.abs(p.stop - 105.84) < 1e-6);
});

test('openPosition skips when the wall is too close, and drops the partial when wall >= +10%', () => {
  assert.ok(openPosition({ symbol: 'A', ask: 113.5, last: 113.5, curvePts: 13.5, levels: lv, now: 0 }).skip);
  const far = openPosition({ symbol: 'A', ask: 108, last: 108, curvePts: 8, levels: { entry: 8, tp: 25 }, now: 0 }).position;
  assert.equal(far.tp1, null);
});

test('stop -2% before TP1 => full loss of ~2% + fees', () => {
  const { position, events } = updatePosition(open(), { bid: 105, now: 1 });
  assert.deepEqual(events, ['STOP']);
  assert.equal(position.status, 'CLOSED');
  // filled at the bid (gap): (105/108 - 1) = -2.78% - 0.2% fees
  assert.ok(Math.abs(position.pnlPct - (-2.778 - 0.2)) < 0.01);
});

test('TP1 half at the wall, stop to breakeven, runner stopped at breakeven', () => {
  let { position, events } = updatePosition(open(), { bid: 114.2, now: 1 });
  assert.deepEqual(events, ['TP1']);
  assert.equal(position.remaining, 0.5);
  assert.ok(position.stop > position.entry);
  ({ position, events } = updatePosition(position, { bid: 108.1, now: 2 }));
  assert.deepEqual(events, ['BREAKEVEN']);
  assert.equal(position.status, 'CLOSED');
  // half at +5.556% - 0.2, half at +0.2% (BE incl. fees) - 0.2  => ≈ +2.68%
  assert.ok(position.pnlPct > 2.5 && position.pnlPct < 2.8, String(position.pnlPct));
});

test('TP1 then +10% final', () => {
  let { position } = updatePosition(open(), { bid: 114.5, now: 1 });
  ({ position } = updatePosition(position, { bid: 119, now: 2 }));
  assert.equal(position.status, 'CLOSED');
  assert.deepEqual(position.fills.map((f) => f.reason), ['TP1', 'FINAL']);
  const expected = 0.5 * (5.5556 - 0.2) + 0.5 * (10 - 0.2);
  assert.ok(Math.abs(position.pnlPct - expected) < 0.01);
});

test('one big jump through wall and final in the same tick closes both', () => {
  const { position, events } = updatePosition(open(), { bid: 125, now: 1 });
  assert.deepEqual(events, ['TP1', 'FINAL']);
  assert.equal(position.status, 'CLOSED');
});

test('summarize: win rate, total, drawdown', () => {
  const t = (pnlPct, closedAt) => ({ pnlPct, closedAt, fills: [{ reason: pnlPct > 0 ? 'TP1' : 'STOP' }] });
  const s = summarize([t(5, 1), t(-2.2, 2), t(-2.2, 3), t(7, 4)]);
  assert.equal(s.trades, 4);
  assert.equal(s.winRate, 0.5);
  assert.equal(s.totalPct, 7.6);
  assert.equal(s.maxDrawdownPct, -4.4);
  assert.equal(realizedPnlPct({ entry: 100, fills: [{ price: 110, share: 1 }] }, cfg), 9.8);
});
