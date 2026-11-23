import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rankCategories } from '../src/core/categories.js';

test('rankCategories: medians per category, sorted by forecast', () => {
  const waves = [{ kind: 'up' }, { kind: 'down' }];
  const btc = [{ ret: 0.2 }, { ret: -0.2 }];
  const tk = (symbol, up, upAmp) => ({ symbol, moves: [{ ret: up }, { ret: -0.1 }], upAmp, downAmp: 0.5, fidelity: 2 });
  const tokens = [tk('A1', 0.6, 3), tk('A2', 0.4, 2), tk('A3', 0.5, 2.5), tk('B1', 0.1, 0.5), tk('B2', 0.2, 1), tk('B3', 0.3, 1.5), tk('C1', 1, 5)];
  const cat = { A1: 'IA', A2: 'IA', A3: 'IA', B1: 'Meme', B2: 'Meme', B3: 'Meme', C1: 'Gaming' };
  const r = rankCategories(tokens, waves, btc, (s) => cat[s], (t) => t.upAmp > 2, 0.3);
  assert.deepEqual(r.map((c) => c.cat), ['IA', 'Meme']); // Gaming has < 3 tokens
  assert.equal(r[0].upAmp, 2.5);
  assert.ok(Math.abs(r[0].forecast - 0.75) < 1e-9);
  assert.equal(r[0].reliable, 2);
  assert.equal(r[0].beatAll, 3);
  assert.equal(r[0].tokens[0].symbol, 'A1');
});
