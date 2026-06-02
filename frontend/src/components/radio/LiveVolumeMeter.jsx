/**
 * Live Volume Meter — shows real-time loudness of whatever's playing on
 * /radio so showroom staff can spot mis-normalised tracks before customers
 * notice. Reads via `audio.captureStream()` → MediaStreamSource → Analyser
 * (a "parallel observation" path that does NOT touch the audio element's
 * default output, so playback works exactly as before — the meter is purely
 * additive).
 *
 * Built 2 Jun 2026.
 * Rewritten 3 Jun 2026 — original used `createMediaElementSource` which
 *   reroutes the element's audio through the Web Audio graph. That made
 *   the audio silent for the user when the routing failed. `captureStream()`
 *   avoids touching the playback pipeline entirely.
 *
 *   • Multi-source: ties into BOTH crossfade audio refs (A + B) so the
 *     reading stays continuous across track transitions.
 *   • Lazy: only spins up AudioContext after the user has tuned in.
 *   • Cheap: single requestAnimationFrame loop, smoothed with EMA, no
 *     React state updates faster than ~30Hz.
 *   • Safe: graceful no-op when captureStream() is unsupported (e.g.
 *     some Safari versions). Hides the bar but never blocks playback.
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
  const streamSourcesRef = useRef([]); // MediaStreamAudioSourceNodes
  const rafRef = useRef(null);
  const smoothedRef = useRef(FLOOR_DBFS);

  const [dbReading, setDbReading] = useState(FLOOR_DBFS);
  const [active, setActive] = useState(false);
  const [supported, setSupported] = useState(true);

  useEffect(() => {
    // Only spin up Web Audio once the user has tuned in (so the
    // AudioContext can start without a user-gesture violation).
    if (!tunedIn) return undefined;

    const a = audioRefA?.current;
    const b = audioRefB?.current;
    if (!a || !b) return undefined;

    let cancelled = false;
    const attach = async () => {
      try {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) { setSupported(false); return; }
        // captureStream() is supported by all modern Chromium/Firefox.
        // Safari needs 13.1+. Fall back to hidden meter if unsupported.
        if (typeof a.captureStream !== 'function') { setSupported(false); return; }

        if (!ctxRef.current) ctxRef.current = new AC();
        const ctx = ctxRef.current;
        if (ctx.state === 'suspended') {
          try { await ctx.resume(); } catch (_e) { /* ignore */ }
        }

        if (!analyserRef.current) {
          const an = ctx.createAnalyser();
          an.fftSize = 2048;
          an.smoothingTimeConstant = 0.3;
          analyserRef.current = an;
        }

        // Tap BOTH audio elements via captureStream so the reading
        // stays continuous across the crossfade A→B handover. Each
        // stream source is created ONCE per audio element + cached.
        for (const el of [a, b]) {
          // Have we already attached to this element?
          if (streamSourcesRef.current.find(s => s._el === el)) continue;
          let stream;
          try {
            stream = el.captureStream ? el.captureStream() : el.mozCaptureStream?.();
          } catch (_e) {
            stream = null;
          }
          if (!stream) continue;
          // The stream is initially empty until the element starts
          // playing — that's fine, MediaStreamSource handles it.
          try {
            const node = ctx.createMediaStreamSource(stream);
            node.connect(analyserRef.current);
            node._el = el;
            streamSourcesRef.current.push(node);
          } catch (_e) {
            // Some browsers throw if the stream has no audio track
            // yet — retry on next play event.
            const onPlay = () => {
              try {
                const s2 = el.captureStream ? el.captureStream() : el.mozCaptureStream?.();
                if (!s2 || streamSourcesRef.current.find(s => s._el === el)) return;
                const node2 = ctx.createMediaStreamSource(s2);
                node2.connect(analyserRef.current);
                node2._el = el;
                streamSourcesRef.current.push(node2);
                el.removeEventListener('play', onPlay);
              } catch (_err) { /* keep trying */ }
            };
            el.addEventListener('play', onPlay);
          }
        }
      } catch (_e) {
        setSupported(false);
      }
    };
    attach();

    const buf = new Uint8Array(2048);
    const tick = () => {
      if (cancelled) return;
      const an = analyserRef.current;
      if (!an) {
        rafRef.current = requestAnimationFrame(tick);
        return;
      }
      an.getByteTimeDomainData(buf);
      let sumSq = 0;
      for (let i = 0; i < buf.length; i++) {
        const v = (buf[i] - 128) / 128;
        sumSq += v * v;
      }
      const rms = Math.sqrt(sumSq / buf.length);
      const dbInst = rms > 0.00001 ? 20 * Math.log10(rms) : FLOOR_DBFS;
      const prev = smoothedRef.current;
      const a2 = dbInst > prev ? 0.5 : 0.12;
      const smoothed = prev + a2 * (dbInst - prev);
      smoothedRef.current = smoothed;
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
  if (!supported) return null; // graceful — no meter, audio still plays

  const clamped = Math.max(FLOOR_DBFS, Math.min(0, dbReading));
  const pct = ((clamped - FLOOR_DBFS) / (0 - FLOOR_DBFS)) * 100;
  const targetPct = ((TARGET_DBFS - FLOOR_DBFS) / (0 - FLOOR_DBFS)) * 100;

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
      <div className="relative h-2.5 bg-slate-800/80 rounded-full overflow-hidden">
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
        <div
          className="absolute inset-y-0 w-px bg-emerald-300/70"
          style={{ left: `${targetPct}%` }}
          title="Target: −16 LUFS broadcast standard"
        />
      </div>
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
