import { useEffect, useRef, useState } from 'react';
import { stepSignals } from '../core/signals.js';

const KEY_HISTORY = 'nebula_bench_v2_signals';
const KEY_SOUND = 'nebula_bench_v2_sound';

function load(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw == null ? fallback : JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function save(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage unavailable */ }
}

export function playAlert() {
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    const t = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(587.33, t);
    osc.frequency.exponentialRampToValueAtTime(1174.66, t + 0.24);
    gain.gain.setValueAtTime(0.01, t);
    gain.gain.linearRampToValueAtTime(0.2, t + 0.04);
    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.55);
    osc.connect(gain).connect(ctx.destination);
    osc.start(t);
    osc.stop(t + 0.6);
    osc.onended = () => ctx.close();
  } catch { /* audio blocked */ }
}

/**
 * Runs the launchpad alert state machine each time the data `version` changes.
 * Only runs once the full scan is complete (`enabled`).
 */
export function useSignals({ curves, levels, ranks, version, enabled }) {
  const stateRef = useRef({ baseline: null, history: load(KEY_HISTORY, []) });
  const [history, setHistory] = useState(stateRef.current.history);
  const [toast, setToast] = useState(null);
  const [sound, setSound] = useState(() => load(KEY_SOUND, true));
  const toastTimer = useRef(null);

  useEffect(() => {
    if (!enabled || !levels || !curves) return;
    const { state, fresh } = stepSignals(stateRef.current, curves, levels, ranks, Date.now());
    const changed = state.history !== stateRef.current.history;
    stateRef.current = state;
    if (changed) {
      setHistory(state.history);
      save(KEY_HISTORY, state.history);
    }
    if (fresh.length) {
      setToast(fresh[0]);
      if (sound) playAlert();
      clearTimeout(toastTimer.current);
      toastTimer.current = setTimeout(() => setToast(null), 7000);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version, enabled]);

  const toggleSound = () => setSound((s) => { save(KEY_SOUND, !s); return !s; });
  const clear = () => {
    stateRef.current = { ...stateRef.current, history: [] };
    setHistory([]);
    save(KEY_HISTORY, []);
  };

  return { history, toast, dismissToast: () => setToast(null), sound, toggleSound, clear };
}
