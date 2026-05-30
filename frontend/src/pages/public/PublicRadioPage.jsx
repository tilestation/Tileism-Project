/**
 * Public live-radio tune-in page — for in-store tablets / phones
 * tethered to Bluetooth speakers (26 May 2026, Phase 2).
 *
 * Sync strategy (proxy-bulletproof):
 *   The backend's /live endless-stream endpoint works perfectly on
 *   Cloudflare + Railway. However some corporate ingress proxies
 *   (Kubernetes default nginx, some store WiFi firewalls) buffer
 *   audio/mpeg streaming responses. To survive ALL networks, this
 *   page does client-orchestrated playback instead:
 *
 *     1. Poll /api/radio-studio/live/now-playing every 4 s.
 *     2. Each speaker fetches a normal FINITE MP3 from the
 *        existing /stream/ad/{id} or /stream/music/{id} endpoint
 *        (already works through every proxy) and seeks to the
 *        wall-clock-derived elapsed_seconds offset.
 *     3. When the current item ends, the speaker re-polls
 *        now-playing to pick up the next item.
 *
 *   All 4 stores compute the same wall-clock offset → they hear
 *   the same content at the same moment, within ~1 s of network
 *   jitter. Same UX as the original /live streaming approach but
 *   works on every network in the world.
 *
 * URL: /radio — paste on any in-store tablet, tap "Tune in",
 * connect to Bluetooth speaker, leave the tab open.
 */
import React, { useEffect, useRef, useState, useCallback } from 'react';
import { Radio, Play, Pause, Music, Mic } from 'lucide-react';

const API_URL = process.env.REACT_APP_BACKEND_URL;
const API = `${API_URL}/api`;
const POLL_URL = `${API}/radio-studio/live/now-playing`;

export default function PublicRadioPage() {
  const audioRef = useRef(null);
  const [tunedIn, setTunedIn] = useState(false);
  const [now, setNow] = useState(null);
  const [err, setErr] = useState(null);
  // Used to detect when the SERVER's "now playing" item changes
  // between polls — that's when we cross-fade to the next track.
  const currentRefRef = useRef(null);

  const fetchNow = useCallback(async () => {
    try {
      const r = await fetch(POLL_URL, { cache: 'no-store' });
      const data = await r.json();
      setNow(data);
      return data;
    } catch (_e) {
      return null;
    }
  }, []);

  // Background polling. Cheap endpoint (no audio blobs).
  useEffect(() => {
    let alive = true;
    const t = setInterval(() => {
      if (alive) fetchNow();
    }, 4000);
    fetchNow();
    return () => { alive = false; clearInterval(t); };
  }, [fetchNow]);

  // When the SERVER changes the current item OR we just tuned in,
  // load the audio for that item and seek to the synced offset so
  // every speaker is at the same moment of the same track.
  useEffect(() => {
    if (!tunedIn) return;
    if (!now?.playing || !now?.now?.audio_url) return;
    const audio = audioRef.current;
    if (!audio) return;
    const refKey = `${now.now.type}:${now.now.ref_id}`;
    if (currentRefRef.current === refKey && !audio.paused) {
      // Same track still playing — let it run, don't re-seek (would
      // cause an audible jump every poll cycle).
      return;
    }
    currentRefRef.current = refKey;
    const fullUrl = `${API_URL}${now.now.audio_url}`;
    audio.src = fullUrl;
    const onLoaded = () => {
      // Seek to wall-clock offset for instant sync across speakers.
      try {
        audio.currentTime = Math.max(0, Math.min(
          (now.now.elapsed_seconds || 0),
          (now.now.duration_seconds || 999) - 0.2,
        ));
      } catch (_e) {
        // Some browsers refuse seek before metadata fully loaded —
        // ignore, next loadedmetadata fires it correctly.
      }
      audio.play().catch((e) => {
        setErr(e?.message || 'Browser blocked playback — tap Tune in again');
      });
      audio.removeEventListener('loadedmetadata', onLoaded);
    };
    audio.addEventListener('loadedmetadata', onLoaded);
  }, [tunedIn, now]);

  // When the current track finishes, refresh now-playing once so
  // the next render picks up the new item without waiting for the
  // next 4-second poll cycle.
  useEffect(() => {
    const a = audioRef.current;
    if (!a) return;
    const onEnded = () => {
      currentRefRef.current = null;
      fetchNow();
    };
    a.addEventListener('ended', onEnded);
    return () => a.removeEventListener('ended', onEnded);
  }, [fetchNow]);

  const tuneIn = async () => {
    setErr(null);
    setTunedIn(true);
    // Pre-warm: on user gesture, immediately fetch now-playing so
    // the audio element loads with audio.play() still permitted by
    // browser autoplay policy.
    await fetchNow();
  };

  const tuneOut = () => {
    setTunedIn(false);
    const a = audioRef.current;
    if (a) {
      a.pause();
      a.removeAttribute('src');
      a.load();
    }
    currentRefRef.current = null;
  };

  const cur = now?.now;
  const isAd = cur?.type === 'ad';
  const playing = tunedIn && !!cur;

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
              {tunedIn ? 'Now Playing' : 'Ready to play'}
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

      <div className="px-6 pb-8 flex flex-col items-center gap-3">
        <audio ref={audioRef} preload="none" data-testid="public-radio-audio" />
        {!tunedIn ? (
          <button
            type="button"
            onClick={tuneIn}
            data-testid="public-radio-tune-in"
            disabled={!now?.playing}
            className="px-8 py-4 bg-gradient-to-r from-amber-400 to-orange-500 disabled:from-slate-700 disabled:to-slate-700 disabled:text-slate-500 text-slate-900 rounded-full font-extrabold text-lg shadow-2xl shadow-amber-500/20 hover:scale-105 active:scale-95 disabled:hover:scale-100 transition-transform flex items-center gap-3"
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
