export const PALETTE = [
  '#38bdf8', '#00ff88', '#facc15', '#f43f5e', '#a855f7', '#fb923c', '#e879f9', '#22d3ee',
  '#a3e635', '#fdba74', '#ec4899', '#818cf8', '#34d399', '#f472b6', '#3b82f6', '#fde047',
  '#2dd4bf', '#c084fc', '#f87171', '#60a5fa',
];

export function colorOf(symbol) {
  let h = 0;
  for (let i = 0; i < symbol.length; i++) h = (h * 31 + symbol.charCodeAt(i)) >>> 0;
  return PALETTE[h % PALETTE.length];
}

export function fmtPct(x, d = 2) {
  if (x == null || !Number.isFinite(x)) return '—';
  return `${x > 0 ? '+' : ''}${x.toFixed(d)}%`;
}

export function fmtPts(x, d = 1) {
  if (x == null || !Number.isFinite(x)) return '—';
  return `${x > 0 ? '+' : ''}${x.toFixed(d)} pts`;
}

export function fmtUsd(x) {
  if (x == null || !Number.isFinite(x)) return '—';
  const a = Math.abs(x);
  if (a >= 1e9) return `$${(x / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `$${(x / 1e6).toFixed(2)}M`;
  if (a >= 1e3) return `$${(x / 1e3).toFixed(1)}K`;
  return `$${x.toFixed(0)}`;
}

export function fmtPrice(p) {
  if (p == null || !Number.isFinite(p)) return '—';
  if (p >= 1000) return p.toLocaleString('en-US', { maximumFractionDigits: 1 });
  if (p >= 1) return p.toFixed(4);
  if (p >= 0.01) return p.toFixed(5);
  // Plain decimals for tiny prices (no e-notation): 4 significant digits.
  return p.toFixed(Math.min(20, Math.ceil(-Math.log10(p)) + 3));
}

export function fmtTime(ts) {
  return new Date(ts).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

export function pctClass(x) {
  if (x == null || !Number.isFinite(x)) return 'muted';
  return x > 0 ? 'pos' : x < 0 ? 'neg' : 'muted';
}

export const PHASES = {
  CLIMAX: { label: '⚠️ CLIMAX', color: '#fb923c', desc: "Écart extrême à l'EMA 20 4H — risque de correction" },
  CORRECTION: { label: '🔻 CORRECTION', color: '#f87171', desc: 'Baisse active / repli en cours' },
  PULLBACK: { label: '💎 PULLBACK', color: '#38bdf8', desc: "Tendance haussière + retest de l'EMA 20 4H" },
  EXPANSION: { label: '🚀 EXPANSION', color: '#00ff88', desc: "Hausse active au-dessus de l'EMA 20 4H" },
  ACCUMULATION: { label: '📦 ACCUM.', color: '#facc15', desc: 'Base de consolidation / phase neutre' },
};
