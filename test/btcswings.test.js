import { test } from 'node:test';
import assert from 'node:assert/strict';
import { btcSwings, tokenSwings, corrBeta } from '../src/core/btcswings.js';

const DAY = 86_400_000;
const bars = (closes) => ({ t: closes.map((_, i) => i * DAY), h: closes.map((c) => c * 1.01), l: closes.map((c) => c * 0.99), c: closes });

test('btcSwings + tokenSwings: up / down swings, ret, max, open swing', () => {
  // 100 -> 140 (up) -> 100 (down) -> 130 (up, in progress)
  const path = [100, 110, 120, 130, 140, 130, 120, 110, 100, 110, 120, 130];
  const btc = bars(path);
  const s = btcSwings(btc, 0, 0.15, 0);
  assert.deepEqual(s.map((x) => x.kind), ['up', 'down', 'up']);
  assert.equal(s[2].open, true);
  assert.ok(s[0].ret > 0.3 && s[1].ret < -0.2);
  const tok = bars(path.map((c) => 100 + (c - 100) * 2)); // beta 2
  const ts = tokenSwings(tok, s);
  assert.ok(ts[0].ret > s[0].ret);
  assert.ok(ts[0].max >= ts[0].ret);
  const cb = corrBeta(bars([...path, ...path, ...path]), bars([...path, ...path, ...path]), 0);
  assert.ok(Math.abs(cb.corr - 1) < 1e-9 && Math.abs(cb.beta - 1) < 1e-9);
});

test('waveScores: fidelity and amplification vs BTC', async () => {
  const { waveScores } = await import('../src/core/btcswings.js');
  const waves = [{ kind: 'up' }, { kind: 'down' }, { kind: 'up' }, { kind: 'down' }];
  const btc = [{ ret: 0.2 }, { ret: -0.2 }, { ret: 0.4 }, { ret: -0.2 }];
  const tok = [{ ret: 0.4 }, { ret: -0.2 }, { ret: 0.8 }, { ret: 0.1 }];
  const s = waveScores(waves, tok, btc);
  assert.equal(s.fidelity, 3); assert.equal(s.waves, 4);
  assert.ok(Math.abs(s.upAmp - 2) < 1e-9);
  assert.ok(Math.abs(s.downAmp - 0.25) < 1e-9); // (1 + -0.5) / 2
  assert.ok(Math.abs(s.asym - 8) < 1e-9);
});
