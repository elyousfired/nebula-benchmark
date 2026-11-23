// Narrative categories vs BTC waves: which category followed BTC best, and the
// forecast for the next rally ("if it repeats like before").

const median = (a) => { const s = a.filter((x) => x != null && Number.isFinite(x)).sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : null; };

/**
 * tokens: /api/followers tokens (moves, upAmp, downAmp, fidelity, ...),
 * waves, btcMoves: /api/followers waves and btc, catOf(symbol) -> category label or null,
 * isReliable(token) -> bool, btcMove: simulated BTC rally (0.32 = +32%).
 * Returns categories sorted by forecast, each with its tokens sorted by forecast.
 */
export function rankCategories(tokens, waves, btcMoves, catOf, isReliable, btcMove) {
  const ups = waves.map((w, k) => (w.kind === 'up' && !w.open ? k : -1)).filter((k) => k >= 0);
  const groups = new Map();
  for (const t of tokens) {
    const cat = catOf(t.symbol) || 'Autres';
    if (!groups.has(cat)) groups.set(cat, []);
    const upRets = ups.map((k) => t.moves[k]?.ret).filter((x) => x != null);
    groups.get(cat).push({
      ...t, cat, reliable: isReliable(t),
      upAvg: upRets.length ? upRets.reduce((a, b) => a + b, 0) / upRets.length : null,
      beatAll: ups.every((k) => t.moves[k] && t.moves[k].ret > btcMoves[k].ret),
      forecast: t.upAmp != null ? t.upAmp * btcMove : null,
    });
  }
  return [...groups.entries()].map(([cat, list]) => {
    const upAmp = median(list.map((t) => t.upAmp));
    return {
      cat, n: list.length,
      reliable: list.filter((t) => t.reliable).length,
      beatAll: list.filter((t) => t.beatAll).length,
      upAvg: median(list.map((t) => t.upAvg)),
      waveMed: waves.map((w, k) => median(list.map((t) => t.moves[k]?.ret))),
      upAmp, downAmp: median(list.map((t) => t.downAmp)),
      forecast: upAmp != null ? upAmp * btcMove : null,
      tokens: list.sort((a, b) => (b.forecast ?? -99) - (a.forecast ?? -99)),
    };
  }).filter((c) => c.n >= 3).sort((a, b) => (b.forecast ?? -99) - (a.forecast ?? -99));
}
