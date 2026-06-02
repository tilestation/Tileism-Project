/**
 * Live Volume Meter — shows real-time loudness of whatever's playing on
 * /radio so showroom staff can spot mis-normalised tracks before customers
 * notice. Reads ALL active <audio> elements via Web Audio's AnalyserNode,
 * computes RMS dBFS, and renders a green/amber/red horizontal bar with a
 * numeric dB readout plus the −16 LUFS broadcast-target line.
 *
 * Built 2 Jun 2026.
 *
 *   • Multi-source: ties into BOTH crossfade audio refs (A + B) so the
 *     reading stays continuous across track transitions.
 *   • Lazy: only spins up AudioContext after the user actually tunes in
 *     (browsers require a user gesture before starting AudioContext).
 *   • Cheap: single requestAnimationFrame loop, smoothed with EMA, no
 *     React state updates faster than ~30Hz.
 *
 * dBFS vs LUFS: dBFS is INSTANTANEOUS sample-peak/RMS, LUFS is gated
 * loudness over time. They're not the same number — but for spotting a
 * track that's 8-10dB quieter than the rest, a simple RMS dBFS meter
 * is more than enough. Target line at −19 dBFS RMS roughly corresponds
 * to the −16 LUFS broadcast target for typical program content.
 */
import React, { useEffect, useRef, useState } from 'react';
import { Volume2 } from 'lucide-react';

const TARGET_DBFS = -19; // approx −16 LUFS for typical program material
const FLOOR_DBFS = -60;  // bottom of the meter

const LiveVolumeMeter = ({ audioRefA, audioRefB, tunedIn }) => {
  const ctxRef = useRef(null);
  const analyserRef = useRef(null);
  const sourceARef = useRef(null);
  const sourceBRef = useRef(null);
  const rafRef = useRef(null);
  const smoothedRef = useRef(FLOOR_DBFS);

  const [dbReading, setDbReading] = useState(FLOOR_DBFS);
  const [active, setActive] = useState(false);

  useEffect(() => {
    // Only spin up Web Audio once the user has tuned in (so the
    // AudioContext can start without a user-gesture violation).
    if (!tunedIn) return undefined;

    const a = audioRefA.current;
    const b = audioRefB.current;
    if (!a || !b) return undefined;

    // Re-use the AudioContext across re-renders. createMediaElementSource
    // can only be called ONCE per element so we keep refs around.
    let cancelled = false;
    const ensureCtx = async () => {
      try {
        if (!ctxRef.current) {
          const AC = window.AudioContext || window.webkitAudioContext;
          if (!AC) return; // Older browser — silently skip the meter.
          ctxRef.current = new AC();
        }
        const ctx = ctxRef.current;
        if (ctx.state === 'suspended') await ctx.resume();
        if (!analyserRef.current) {
          const an = ctx.createAnalyser();
          an.fftSize = 2048;
          an.smoothingTimeConstant = 0.3;
          analyserRef.current = an;
          // Tap to BOTH audio elements so we keep the reading
          // continuous through crossfades. Each audio plays via
          // ctx.destination already (default routing), so we also
          // connect the analyser back to destination → audio stays
          // audible AND we get samples.
          if (!sourceARef.current) {
            sourceARef.current = ctx.createMediaElementSource(a);
            sourceARef.current.connect(an);
            sourceARef.current.connect(ctx.destination);
          }
          if (!sourceBRef.current) {
            sourceBRef.current = ctx.createMediaElementSource(b);
            sourceBRef.current.connect(an);
            sourceBRef.current.connect(ctx.destination);
          }
        }
      } catch (_e) {
        // Some browsers (notably Safari sometimes) throw on
        // createMediaElementSource if the element wasn't user-gestured.
        // We swallow — the meter just won't show, audio still plays.
      }
    };
    ensureCtx();

    const buf = new Uint8Array(2048);
    const tick = () => {
      if (cancelled) return;
      const an = analyserRef.current;
      if (!an) {
        rafRef.current = requestAnimationFrame(tick);
        return;
      }
      an.getByteTimeDomainData(buf);
      // RMS over the time-domain samples. 128 is silence (mid-point).
      let sumSq = 0;
      for (let i = 0; i < buf.length; i++) {
        const v = (buf[i] - 128) / 128;
        sumSq += v * v;
      }
      const rms = Math.sqrt(sumSq / buf.length);
      const dbInst = rms > 0.00001 ? 20 * Math.log10(rms) : FLOOR_DBFS;
      // Exponential smoothing — fast attack, slower release so the
      // meter behaves like a peak meter on percussive transients but
      // doesn't flicker on noise.
      const prev = smoothedRef.current;
      const a2 = dbInst > prev ? 0.5 : 0.12; // attack faster than release
      const smoothed = prev + a2 * (dbInst - prev);
      smoothedRef.current = smoothed;
      // Throttle React state to ~30Hz (every other frame on 60Hz screens).
      if ((performance.now() | 0) % 2 === 0) {
        setDbReading(smoothed);
        setActive(smoothed > FLOOR_DBFS + 5);
      }
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);

    return () => {
      cancelled = true;
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, [tunedIn, audioRefA, audioRefB]);

  if (!tunedIn) return null;

  // Map dB → 0-100% bar fill.
  const clamped = Math.max(FLOOR_DBFS, Math.min(0, dbReading));
  const pct = ((clamped - FLOOR_DBFS) / (0 - FLOOR_DBFS)) * 100;
  const targetPct = ((TARGET_DBFS - FLOOR_DBFS) / (0 - FLOOR_DBFS)) * 100;

  // Colour bands: green up to target, amber for +6dB above target, red beyond.
  const dbAboveTarget = clamped - TARGET_DBFS;
  let zone = 'silent';
  if (clamped > TARGET_DBFS + 6) zone = 'hot';
  else if (clamped > TARGET_DBFS - 3) zone = 'on-target';
  else if (clamped > TARGET_DBFS - 10) zone = 'low';
  else if (active) zone = 'very-low';

  const zoneCopy = {
    'on-target': { text: 'On target', color: 'text-emerald-300' },
    hot: { text: 'Hot — risk of clipping', color: 'text-rose-300' },
    low: { text: 'A bit quiet', color: 'text-amber-300' },
    'very-low': { text: 'Quiet — re-normalise?', color: 'text-amber-400' },
    silent: { text: 'Silent', color: 'text-slate-500' },
  }[zone];

  return (
    <div
      className="w-full max-w-md bg-slate-900/60 border border-slate-700/50 rounded-lg px-3 py-2 backdrop-blur-sm"
      data-testid="public-radio-volume-meter"
    >
      <div className="flex items-center justify-between gap-2 mb-1.5">
        <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider font-semibold text-slate-400">
          <Volume2 className="w-3 h-3" />
          <span>Live volume</span>
        </div>
        <div className="flex items-baseline gap-2">
          <span
            className="font-mono text-sm font-bold tabular-nums text-slate-100"
            data-testid="public-radio-volume-db"
          >
            {clamped <= FLOOR_DBFS + 1 ? '−∞' : `${clamped.toFixed(1)} dB`}
          </span>
          <span className={`text-[10px] font-semibold ${zoneCopy.color}`}>
            {zoneCopy.text}
          </span>
        </div>
      </div>
      {/* Meter bar */}
      <div className="relative h-2.5 bg-slate-800/80 rounded-full overflow-hidden">
        {/* Coloured fill */}
        <div
          className={`absolute inset-y-0 left-0 transition-[width] duration-75 ${
            zone === 'hot'
              ? 'bg-gradient-to-r from-emerald-500 via-amber-400 to-rose-500'
              : zone === 'on-target'
                ? 'bg-gradient-to-r from-emerald-600 to-emerald-400'
                : zone === 'low' || zone === 'very-low'
                  ? 'bg-gradient-to-r from-slate-500 to-amber-500'
                  : 'bg-slate-600'
          }`}
          style={{ width: `${pct}%` }}
        />
        {/* Target line */}
        <div
          className="absolute inset-y-0 w-px bg-emerald-300/70"
          style={{ left: `${targetPct}%` }}
          title="Target: −16 LUFS broadcast standard"
        />
      </div>
      {/* Scale */}
      <div className="flex justify-between text-[8px] text-slate-500 mt-1 font-mono">
        <span>−60</span>
        <span>−40</span>
        <span className="text-emerald-400" title="Target: −16 LUFS / ≈ −19 dBFS RMS">−19</span>
        <span>0 dB</span>
      </div>
    </div>
  );
};

export default LiveVolumeMeter;
