/**
 * Public live-radio tune-in page — for in-store tablets / phones
 * tethered to Bluetooth speakers (26 May 2026, Phase 2).
 *
 * No auth, no chrome, big NOW PLAYING display, autoplay on tap.
 *
 * URL: /radio — paste this on any store tablet wall display,
 * tap "Tune in", connect tablet over Bluetooth to a speaker, done.
 * All 4 stores hear the SAME song/ad at the SAME moment thanks to
 * the wall-clock-modulated sync in the backend live generator.
 */
import React, { useEffect, useRef, useState } from 'react';
import { Radio, Play, Pause, Loader2, Volume2, Music, Mic } from 'lucide-react';

const API_URL = process.env.REACT_APP_BACKEND_URL;
const API = `${API_URL}/api`;
const STREAM_URL = `${API}/radio-studio/live`;
const POLL_URL = `${API}/radio-studio/live/now-playing`;

export default function PublicRadioPage() {
  const audioRef = useRef(null);
  const [playing, setPlaying] = useState(false);
  const [now, setNow] = useState(null);
  const [err, setErr] = useState(null);

  // Poll now-playing every 4 seconds. The endpoint is cheap (no
  // audio blobs) so even with 4 store screens this is sub-second
  // total load on the backend.
  useEffect(() => {
    let alive = true;
    const fetchNow = async () => {
      try {
        const r = await fetch(POLL_URL, { cache: 'no-store' });
        const data = await r.json();
        if (alive) setNow(data);
      } catch (_e) {
        // Network blips happen — keep the last known state visible.
      }
    };
    fetchNow();
    const t = setInterval(fetchNow, 4000);
    return () => { alive = false; clearInterval(t); };
  }, []);

  const tuneIn = () => {
    if (!audioRef.current) return;
    setErr(null);
    audioRef.current.src = STREAM_URL;
    const p = audioRef.current.play();
    if (p?.catch) {
      p.then(() => setPlaying(true)).catch((e) => {
        setErr(e?.message || 'Browser blocked autoplay — tap Tune In again');
        setPlaying(false);
      });
    } else {
      setPlaying(true);
    }
  };

  const tuneOut = () => {
    if (!audioRef.current) return;
    audioRef.current.pause();
    audioRef.current.removeAttribute('src');
    audioRef.current.load();
    setPlaying(false);
  };

  const cur = now?.now;
  const isAd = cur?.type === 'ad';

  return (
    <div
      className="min-h-screen w-full bg-gradient-to-br from-slate-950 via-slate-900 to-fuchsia-950/40 text-white flex flex-col"
      data-testid="public-radio-page"
    >
      <div className="px-6 sm:px-10 py-6 flex items-center gap-3 border-b border-white/5">
        <div className="w-11 h-11 rounded-xl bg-gradient-to-br from-amber-400 to-orange-500 flex items-center justify-center shadow-lg shadow-amber-500/30">
          <Radio className="w-6 h-6 text-slate-900" />
        </div>
        <div>
          <h1 className="text-xl sm:text-2xl font-extrabold tracking-tight">
            Tile Station Radio
          </h1>
          <p className="text-xs sm:text-sm text-slate-400">
            In-store live · 4 showrooms · synced playback
          </p>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <span className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-[11px] font-bold ${
            playing
              ? 'bg-emerald-500/20 text-emerald-300 ring-1 ring-emerald-500/40'
              : 'bg-slate-700/60 text-slate-300'
          }`}>
            <span className={`w-1.5 h-1.5 rounded-full ${playing ? 'bg-emerald-400 animate-pulse' : 'bg-slate-500'}`} />
            {playing ? 'ON AIR' : 'TAP TO TUNE IN'}
          </span>
        </div>
      </div>

      <div className="flex-1 flex flex-col items-center justify-center px-6 py-10 text-center">
        {now && !now.playing && (
          <div className="max-w-md">
            <div className="w-24 h-24 mx-auto mb-6 rounded-3xl bg-slate-800/60 flex items-center justify-center">
              <Radio className="w-10 h-10 text-slate-500" />
            </div>
            <h2 className="text-2xl font-bold mb-2">No playlist scheduled</h2>
            <p className="text-sm text-slate-400">{now.reason}</p>
          </div>
        )}

        {now && now.playing && cur && (
          <div className="w-full max-w-2xl">
            <div className="text-[11px] uppercase tracking-[0.3em] text-slate-500 mb-4">
              Now Playing
            </div>
            <div className="flex flex-col items-center gap-5">
              <div className={`w-32 h-32 sm:w-44 sm:h-44 rounded-3xl flex items-center justify-center shadow-2xl ${
                isAd
                  ? 'bg-gradient-to-br from-amber-400 via-orange-500 to-rose-500'
                  : 'bg-gradient-to-br from-fuchsia-500 via-purple-500 to-indigo-500'
              }`}>
                {isAd
                  ? <Mic className="w-14 h-14 sm:w-20 sm:h-20 text-slate-900/90" />
                  : <Music className="w-14 h-14 sm:w-20 sm:h-20 text-white" />
                }
              </div>
              <div>
                <div className="text-3xl sm:text-5xl font-extrabold tracking-tight" data-testid="public-radio-now-name">
                  {cur.name}
                </div>
                <div className="mt-2 text-sm sm:text-base text-slate-400">
                  {isAd ? `Voiced by ${cur.voice_name || 'AI narrator'}` : 'Music track'}
                  {cur.bed_music_name ? ` · over ${cur.bed_music_name}` : ''}
                </div>
              </div>

              {/* Progress bar — driven entirely by the polled
                  elapsed/remaining values so it stays in sync with
                  any other speaker without local clock drift. */}
              <div className="w-full max-w-md">
                <div className="h-1.5 bg-slate-800 rounded-full overflow-hidden">
                  <div
                    className="h-full bg-gradient-to-r from-amber-400 to-fuchsia-500 transition-all duration-500"
                    style={{
                      width: cur.duration_seconds
                        ? `${Math.min(100, (cur.elapsed_seconds / cur.duration_seconds) * 100)}%`
                        : '0%',
                    }}
                  />
                </div>
                <div className="flex justify-between text-[11px] text-slate-500 mt-1 font-mono">
                  <span>{Math.floor(cur.elapsed_seconds || 0)}s</span>
                  <span>-{Math.floor(cur.remaining_seconds || 0)}s</span>
                </div>
              </div>

              {now.next && (
                <div className="text-xs text-slate-500 mt-2">
                  Up next: <span className="text-slate-300 font-medium">{now.next.name}</span>
                </div>
              )}
            </div>
          </div>
        )}

        {err && (
          <p className="mt-6 text-xs text-amber-400 max-w-md">
            {err}
          </p>
        )}
      </div>

      {/* Tune-in button — fixed bottom so it's always tappable on
          the in-store tablet, never hidden by scroll. */}
      <div className="px-6 pb-8 flex flex-col items-center gap-3">
        <audio ref={audioRef} preload="none" data-testid="public-radio-audio" />
        {!playing ? (
          <button
            type="button"
            onClick={tuneIn}
            data-testid="public-radio-tune-in"
            className="px-8 py-4 bg-gradient-to-r from-amber-400 to-orange-500 text-slate-900 rounded-full font-extrabold text-lg shadow-2xl shadow-amber-500/20 hover:scale-105 active:scale-95 transition-transform flex items-center gap-3"
          >
            <Play className="w-6 h-6 fill-current" />
            Tune in
          </button>
        ) : (
          <button
            type="button"
            onClick={tuneOut}
            data-testid="public-radio-tune-out"
            className="px-6 py-3 bg-white/5 hover:bg-white/10 border border-white/10 rounded-full font-bold flex items-center gap-2 text-sm"
          >
            <Pause className="w-4 h-4" />
            Stop
          </button>
        )}
        <p className="text-[10px] text-slate-600 max-w-xs text-center leading-relaxed">
          Connect this device to your store's Bluetooth speaker, tap Tune in,
          and leave the tab open. All 4 stores stay in sync.
        </p>
      </div>
    </div>
  );
}
