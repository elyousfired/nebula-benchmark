import { colorOf, fmtPct, fmtPts, fmtPrice, fmtTime, fmtUsd } from '../lib/format.js';

export function Header({ scan, onRescan }) {
  const { status, progress, tokens, lastTickerAt, tickerStale, staleTokens, failed, btc, route, error, scanning } = scan;
  let pill = { cls: 'live', text: `LIVE · ${tokens.length} TOKENS BYBIT` };
  if (status === 'scanning' || scanning) pill = { cls: 'scan', text: `SCAN ${progress.done}/${progress.total || '…'}` };
  if (tickerStale) pill = { cls: 'stale', text: 'STALE · prix non mis à jour' };
  if (status === 'error') pill = { cls: 'err', text: 'ERREUR · Bybit injoignable' };

  return (
    <header className="header">
      <div className="brand">
        <span className="logo">◆</span>
        <div>
          <div className="title">NEBULA · TOP 50 BENCHMARK</div>
          <div className="subtitle">Prix vs Score · Bybit Spot USDT</div>
        </div>
      </div>
      <div className="header-right">
        <span className={`pill ${pill.cls}`}>● {pill.text}</span>
        {lastTickerAt > 0 && <span className="meta">MAJ {fmtTime(lastTickerAt)}</span>}
        {route === 'proxy' && <span className="meta warn" title="api.bybit.com injoignable depuis ce navigateur">via proxy</span>}
        {(failed > 0 || staleTokens > 0) && (
          <span className="meta warn" title="Tokens dont les bougies n'ont pas pu être chargées / sont en retard">
            {failed > 0 ? `${failed} échecs` : ''}{failed > 0 && staleTokens > 0 ? ' · ' : ''}{staleTokens > 0 ? `${staleTokens} en retard` : ''}
          </span>
        )}
        {btc && (
          <span className={`btc ${btc.change24h >= 0 ? 'pos' : 'neg'}`}>
            ₿ ${fmtPrice(btc.price)} <b>{fmtPct(btc.change24h)}</b>
            <small>{btc.change24h >= 0 ? 'SOULAGEMENT' : 'PRESSION'}</small>
          </span>
        )}
        <button className="btn primary" onClick={onRescan} disabled={scanning || status === 'scanning'}>⟳ Rescanner</button>
      </div>
      {error && <div className="error-line">⚠ {error}</div>}
      {(status === 'scanning' || scanning) && progress.total > 0 && (
        <div className="progress"><div style={{ width: `${(progress.done / progress.total) * 100}%` }} /></div>
      )}
    </header>
  );
}

function Seg({ value, options, onChange }) {
  return (
    <div className="seg">
      {options.map((o) => (
        <button key={o.value} className={value === o.value ? 'on' : ''} onClick={() => onChange(o.value)}>{o.label}</button>
      ))}
    </div>
  );
}

function Toggle({ on, onChange, children }) {
  return <button className={`toggle ${on ? 'on' : ''}`} onClick={() => onChange(!on)}>{children} {on ? '(ON)' : '(OFF)'}</button>;
}

export function Controls({ opts, set }) {
  return (
    <div className="controls">
      <Seg value={opts.universe} onChange={(v) => set({ universe: v })} options={[
        { value: 'score', label: '👑 TOP SCORE' },
        { value: 'peak', label: '🔥 TOP PICS (ATH 30D)' },
      ]} />
      <Seg value={opts.horizon} onChange={(v) => set({ horizon: v })} options={[
        { value: 'month', label: '30D MOIS' },
        { value: 'week', label: '7D SEMAINE' },
        { value: 'day', label: '24H JOUR' },
      ]} />
      <Seg value={opts.topN} onChange={(v) => set({ topN: v })} options={[5, 10, 20, 50].map((n) => ({ value: n, label: `TOP ${n}` }))} />
      <Toggle on={opts.showBench} onChange={(v) => set({ showBench: v })}>📈 BENCHMARK</Toggle>
      <Toggle on={opts.showLevels} onChange={(v) => set({ showLevels: v })}>🎯 NIVEAUX 24H</Toggle>
      <Toggle on={opts.showProfile} onChange={(v) => set({ showProfile: v })}>📊 PROFIL VOLUME</Toggle>
    </div>
  );
}

export function SentimentBar({ s, horizonLabel }) {
  const label = s.dominance === 'BULL' ? 'DOMINANCE HAUSSIÈRE' : s.dominance === 'BEAR' ? 'DOMINANCE BAISSIÈRE' : 'NEUTRE';
  return (
    <div className="card sentiment">
      <span className="card-title">🧭 SENTIMENT (liste affichée · {horizonLabel})</span>
      <span className={`pill ${s.dominance === 'BULL' ? 'live' : s.dominance === 'BEAR' ? 'err' : 'scan'}`}>● {label}</span>
      <span className="pos">{s.up} en hausse ({s.upPct}%)</span>
      <div className="bar">
        <div className="bar-up" style={{ width: `${s.upPct}%` }} />
        <div className="bar-flat" style={{ width: `${100 - s.upPct - s.downPct}%` }} />
        <div className="bar-down" style={{ width: `${s.downPct}%` }} />
      </div>
      <span className="neg">{s.down} en baisse ({s.downPct}%)</span>
      <span className="muted small">sur les 2 dernières bougies</span>
    </div>
  );
}

export function VolumeProfilePanel({ vp, horizonLabel }) {
  if (!vp.buckets.length) return <div className="card"><div className="card-title">📊 PROFIL DE VOLUME</div><div className="muted">Pas encore de données.</div></div>;
  const rows = [...vp.buckets].reverse();
  const max = Math.max(...rows.map((b) => b.volume));
  return (
    <div className="card">
      <div className="card-head">
        <div>
          <div className="card-title">📊 PROFIL DE VOLUME COLLECTIF · {horizonLabel}</div>
          <div className="muted small">Turnover USDT par niveau de points (tous les tokens scannés) · {fmtUsd(vp.total)}</div>
        </div>
        <div className="vp-legend">
          <span className="chip gold">POC {fmtPts(vp.poc, 0)}</span>
          <span className="chip">VA {fmtPts(vp.val, 0)} → {fmtPts(vp.vah, 0)}</span>
        </div>
      </div>
      <div className="vp">
        {rows.map((b) => {
          const inVA = b.lvl >= vp.val && b.lvl < vp.vah;
          return (
            <div key={b.lvl} className={`vp-row ${b.lvl === vp.poc ? 'poc' : ''} ${inVA ? 'va' : ''}`} title={`${fmtPts(b.lvl, 0)} à ${fmtPts(b.lvl + vp.bucket, 0)} · ${fmtUsd(b.volume)} · ${b.tokens} tokens`}>
              <span className="vp-lvl">{b.lvl > 0 ? '+' : ''}{b.lvl}</span>
              <div className="vp-bar" style={{ width: `${(b.volume / max) * 100}%` }}>
                <div className="vp-up" style={{ width: `${(b.up / b.volume) * 100}%` }} />
              </div>
              <span className="vp-vol">{fmtUsd(b.volume)}</span>
            </div>
          );
        })}
      </div>
      <div className="muted small">Vert = bougies haussières · Rouge = bougies baissières (pas le flux acheteur/vendeur réel).</div>
    </div>
  );
}

export function QuantPanel({ levels, sniper, bt }) {
  if (!levels) return null;
  const pct = (x) => (x == null ? '—' : `${(x * 100).toFixed(0)}%`);
  return (
    <div className="card">
      <div className="card-title">🎯 STRATÉGIE LAUNCHPAD · 24H</div>
      <div className="kv-grid">
        <div><span>Launchpad (entrée)</span><b className="cyan">{fmtPts(sniper.entry)}</b></div>
        <div><span>Stop</span><b className="neg">{fmtPts(sniper.sl)}</b></div>
        <div><span>Objectif / mur de rejet</span><b className="pos">{fmtPts(sniper.tp)}</b></div>
        <div><span>R:R</span><b>{bt.riskReward ? `1 : ${bt.riskReward.toFixed(1)}` : '—'}</b></div>
        <div><span>Tokens en pump (≥10 pts)</span><b>{levels.pumping.length}</b></div>
        <div><span>Au-dessus du mur</span><b>{levels.pierced.length}</b></div>
      </div>
      <div className="card-sub">Replay sur les courbes 24H (premier touché TP / SL)</div>
      <div className="kv-grid">
        <div><span>Gagnants</span><b className="pos">{bt.wins}</b></div>
        <div><span>Perdants</span><b className="neg">{bt.losses}</b></div>
        <div><span>En cours</span><b>{bt.open}</b></div>
        <div><span>Win rate</span><b>{pct(bt.winRate)}</b></div>
        <div><span>Espérance / trade</span><b className={bt.expectancy >= 0 ? 'pos' : 'neg'}>{bt.expectancy == null ? '—' : fmtPts(bt.expectancy, 2)}</b></div>
      </div>
      {bt.trades.length > 0 && (
        <div className="mini-list">
          {bt.trades.slice(0, 8).map((t) => (
            <div key={t.symbol} className="mini-row">
              <span style={{ color: colorOf(t.symbol) }}>{t.symbol.replace('USDT', '')}</span>
              <span className={`tag ${t.status}`}>{t.status === 'WIN' ? 'TP' : t.status === 'LOSS' ? 'SL' : 'EN COURS'}</span>
              <b className={t.pnl >= 0 ? 'pos' : 'neg'}>{fmtPts(t.pnl, 2)}</b>
            </div>
          ))}
        </div>
      )}
      <div className="muted small">Calculé sur les tokens affichés, sur les dernières 24H uniquement — pas un backtest historique.</div>
    </div>
  );
}

export function SignalsPanel({ signals }) {
  const { history, sound, toggleSound, clear } = signals;
  const closed = history.filter((s) => s.status !== 'ACTIVE');
  const wins = closed.filter((s) => s.status === 'WIN').length;
  return (
    <div className="card">
      <div className="card-head">
        <div className="card-title">🔔 ALERTES LAUNCHPAD (live)</div>
        <div className="row-gap">
          <button className="btn" onClick={toggleSound}>{sound ? '🔊 Son' : '🔇 Muet'}</button>
          {history.length > 0 && <button className="btn" onClick={clear}>Effacer</button>}
        </div>
      </div>
      <div className="muted small">
        Déclenchée quand un token du Top 50 (score 30D) passe la ligne launchpad 24H entre deux mises à jour.
        {closed.length > 0 && ` · Résultat: ${wins}/${closed.length} au TP.`}
      </div>
      {history.length === 0 ? <div className="muted">Aucune alerte pour l'instant.</div> : (
        <div className="mini-list">
          {history.slice(0, 12).map((s) => (
            <div key={s.id} className="mini-row">
              <span style={{ color: colorOf(s.symbol) }}>{s.symbol.replace('USDT', '')}</span>
              <span className="muted small">{fmtTime(s.at)}</span>
              <span className={`tag ${s.status === 'STOPPED' ? 'LOSS' : s.status === 'ACTIVE' ? 'OPEN' : 'WIN'}`}>{s.status}</span>
              <b className={s.pnl >= 0 ? 'pos' : 'neg'}>{fmtPts(s.pnl, 2)}</b>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function Toast({ signal, onClose }) {
  if (!signal) return null;
  return (
    <div className="toast" onClick={onClose}>
      <b>🚀 {signal.symbol.replace('USDT', '')}</b> passe le launchpad {fmtPts(signal.entry)} · actuel {fmtPts(signal.current)}
      <div className="small">SL {fmtPts(signal.sl)} · TP {fmtPts(signal.tp)}</div>
    </div>
  );
}
