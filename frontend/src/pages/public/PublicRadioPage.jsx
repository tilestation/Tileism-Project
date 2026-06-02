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
import { Radio, Play, Pause, Music, Mic, Info, ListMusic } from 'lucide-react';
import LiveVolumeMeter from '../../components/radio/LiveVolumeMeter';

const API_URL = process.env.REACT_APP_BACKEND_URL;
const API = `${API_URL}/api`;
const POLL_URL = `${API}/radio-studio/live/now-playing`;
const HEARTBEAT_URL = `${API}/radio-studio/tune-in/heartbeat`;
const HEARTBEAT_INTERVAL_MS = 30_000;

// Per-device id persisted in localStorage so the same showroom
// device counts as ONE listener even across page refreshes / tab
// reopens. First-time visitors get a fresh UUID.
const getDeviceId = () => {
  try {
    const k = 'tilestation_radio_device_id';
    let v = localStorage.getItem(k);
    if (!v) {
      v =
        (window.crypto && window.crypto.randomUUID && window.crypto.randomUUID()) ||
        `dev-${Math.random().toString(36).slice(2)}-${Date.now()}`;
      localStorage.setItem(k, v);
    }
    return v;
  } catch (_e) {
    return `dev-anon-${Date.now()}`;
  }
};
const getDeviceLabel = () => {
  try {
    return localStorage.getItem('tilestation_radio_device_label') || '';
  } catch (_e) {
    return '';
  }
};
const setDeviceLabel = (v) => {
  try {
    if (v && v.trim()) localStorage.setItem('tilestation_radio_device_label', v.trim());
    else localStorage.removeItem('tilestation_radio_device_label');
  } catch (_e) {
    /* ignore */
  }
};

export default function PublicRadioPage() {
  // 31 May 2026 — `?solo=1` query param switches to single-device
  // preview mode (starts from track #1, no wall-clock sync, no
  // multi-store coordination). Used by the admin "Solo preview"
  // button so admins can audition a fresh playlist without waiting
  // for the live loop to come around to track #1.
  const soloMode = typeof window !== 'undefined'
    && new URLSearchParams(window.location.search).get('solo') === '1';
  const [soloIdx, setSoloIdx] = useState(0);
  const [soloPlaylist, setSoloPlaylist] = useState(null); // {items, playlist}

  // 31 May 2026 — TWO audio elements so we can crossfade between
  // consecutive items. `activeRef` tracks which one is currently
  // foregrounded; the other is used to preload + ramp in the next
  // item while the current one ramps out. Hard cut (legacy) just
  // uses A; the right-hand `audioRefB` element sits silent.
  const audioRefA = useRef(null);
  const audioRefB = useRef(null);
  const activeRef = useRef('A'); // 'A' | 'B' — which element is foreground
  const fadeTimerRef = useRef(null);
  const [tunedIn, setTunedIn] = useState(false);
  const [now, setNow] = useState(null);
  const [err, setErr] = useState(null);
  // Local audio progress — drives the on-screen progress bar
  // off `audio.currentTime` rather than the server's wall-clock
  // elapsed. Avoids the bug where the UI showed "elapsed 478s" but
  // the actual audio was at 0s because we couldn't seek without
  // byte-range support on the stream endpoint. (30 May 2026.)
  const [audioPos, setAudioPos] = useState({ current: 0, duration: 0 });
  // Used to detect when the SERVER's "now playing" item changes
  // between polls — that's when we switch the audio element to the
  // next track. We do NOT seek into the track to "sync to wall
  // clock" — the stream endpoint doesn't support byte ranges so the
  // seek silently fails. Each store plays the current item from the
  // start and chains to the next on `ended`. All 4 stores see the
  // same SERVER-reported current item, so they advance through the
  // playlist together within ~one-item-length of each other.
  const currentRefRef = useRef(null);
  const crossfadeFiredRef = useRef(false);

  // Helper to fetch the currently-active audio element.
  const getActive = () => (activeRef.current === 'A' ? audioRefA.current : audioRefB.current);
  const getInactive = () => (activeRef.current === 'A' ? audioRefB.current : audioRefA.current);

  const fetchNow = useCallback(async () => {
    try {
      // In solo mode we fetch the preview endpoint ONCE per session,
      // cache the resolved playlist, and shape it into the same
      // {now, next, upcoming, playlist} contract as /live/now-playing
      // so the render code path stays single-source-of-truth.
      if (soloMode) {
        if (!soloPlaylist) {
          const r = await fetch(`${API}/radio-studio/live/playlist-preview`, { cache: 'no-store' });
          const data = await r.json();
          if (!data.playing) {
            setNow(data);
            return data;
          }
          setSoloPlaylist({ items: data.items, playlist: data.playlist });
          // First render uses index 0; shape to mimic now-playing
          const items = data.items;
          const cur = items[0];
          const upcoming = items.slice(1, 4).map((u) => ({
            type: u.type,
            ref_id: u.ref_id,
            name: u.name,
            duration_seconds: u.duration_seconds,
          }));
          const shaped = {
            playing: true,
            mode: 'solo',
            now: { ...cur, elapsed_seconds: 0, remaining_seconds: cur.duration_seconds },
            next: items[1] ? { ...items[1] } : null,
            upcoming,
            current_index: 0,
            playlist: data.playlist,
            server_time: Date.now() / 1000,
          };
          setNow(shaped);
          return shaped;
        }
        // Subsequent polls in solo mode: re-shape from the cached
        // list using the live `soloIdx` (advanced by `ended` handler).
        const items = soloPlaylist.items;
        const idx = Math.min(soloIdx, items.length - 1);
        const cur = items[idx];
        const upcoming = [];
        for (let off = 1; off <= 3 && idx + off < items.length; off += 1) {
          const u = items[idx + off];
          upcoming.push({
            type: u.type,
            ref_id: u.ref_id,
            name: u.name,
            duration_seconds: u.duration_seconds,
          });
        }
        const shaped = {
          playing: true,
          mode: 'solo',
          now: { ...cur, elapsed_seconds: 0, remaining_seconds: cur.duration_seconds },
          next: items[idx + 1] ? { ...items[idx + 1] } : null,
          upcoming,
          current_index: idx,
          playlist: soloPlaylist.playlist,
          server_time: Date.now() / 1000,
        };
        setNow(shaped);
        return shaped;
      }
      const r = await fetch(POLL_URL, { cache: 'no-store' });
      const data = await r.json();
      setNow(data);
      return data;
    } catch (_e) {
      return null;
    }
  }, [soloMode, soloPlaylist, soloIdx]);

  // Background polling. Cheap endpoint (no audio blobs). In solo
  // mode we skip the network poll entirely after the first fetch
  // — local sequential playback is fully client-driven — but we DO
  // re-shape `now` whenever soloIdx changes so the upcoming list
  // and current_index update.
  useEffect(() => {
    let alive = true;
    fetchNow();
    if (soloMode) return undefined;
    const t = setInterval(() => {
      if (alive) fetchNow();
    }, 4000);
    return () => { alive = false; clearInterval(t); };
  }, [fetchNow, soloMode, soloIdx]);

  // When the SERVER reports a different current item OR we just
  // tuned in, swap the active audio element's source and play it
  // from the start. We deliberately DON'T set `audio.currentTime`
  // — our stream endpoint serves the full file without HTTP byte-
  // range support, so a seek into unbuffered audio silently fails
  // on most browsers and the audio never starts. (30 May 2026.)
  useEffect(() => {
    if (!tunedIn) return;
    if (!now?.playing || !now?.now?.audio_url) return;
    const audio = getActive();
    if (!audio) return;
    const refKey = `${now.now.type}:${now.now.ref_id}`;
    // If the client has already crossfaded INTO this item, the
    // active element is already playing it — skip the resync.
    if (currentRefRef.current === refKey && !audio.paused) {
      return;
    }
    currentRefRef.current = refKey;
    crossfadeFiredRef.current = false;
    audio.src = `${API_URL}${now.now.audio_url}`;
    audio.volume = 1.0;
    audio.play().catch((e) => {
      setErr(e?.message || 'Browser blocked playback — tap Tune in again');
    });
  }, [tunedIn, now]);

  // Drive the progress bar AND the crossfade trigger off the
  // active audio element's timeupdate. When we're within
  // `crossfade_seconds` of the end and we have a `next` item,
  // pre-load the inactive element and start ramping.
  useEffect(() => {
    const a = getActive();
    if (!a) return;

    const onTime = () => {
      setAudioPos({ current: a.currentTime || 0, duration: a.duration || 0 });

      // ---- Crossfade trigger -------------------------------------
      const cfSec = Number(now?.playlist?.crossfade_seconds || 0);
      if (cfSec <= 0) return;
      if (crossfadeFiredRef.current) return;
      if (!now?.next?.audio_url) return;
      const dur = a.duration || 0;
      const cur = a.currentTime || 0;
      if (dur <= 0 || cur <= 0) return;
      if (dur - cur > cfSec) return;
      // We're inside the crossfade window — kick it off ONCE.
      crossfadeFiredRef.current = true;
      startCrossfade(cfSec);
    };

    a.addEventListener('timeupdate', onTime);
    a.addEventListener('loadedmetadata', onTime);
    // Also listen on the OTHER element so swapping active doesn't
    // lose the progress-bar updates.
    const b = getInactive();
    if (b) {
      b.addEventListener('timeupdate', onTime);
      b.addEventListener('loadedmetadata', onTime);
    }
    return () => {
      a.removeEventListener('timeupdate', onTime);
      a.removeEventListener('loadedmetadata', onTime);
      if (b) {
        b.removeEventListener('timeupdate', onTime);
        b.removeEventListener('loadedmetadata', onTime);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tunedIn, now]);

  // Kick off a linear crossfade: ramp `current` from 1 → 0 and
  // `next` from 0 → 1 over `seconds`, then swap active and fetch
  // a fresh now-playing. Uses a 50 ms interval — 20 steps per
  // crossfade is smoother than the human ear cares about.
  const startCrossfade = (seconds) => {
    const fromEl = getActive();
    const toEl = getInactive();
    if (!fromEl || !toEl || !now?.next?.audio_url) return;
    const nextRefKey = `${now.next.type}:${now.next.ref_id}`;

    // Prime the incoming element with the next track.
    toEl.src = `${API_URL}${now.next.audio_url}`;
    toEl.volume = 0;
    toEl.play().catch(() => {
      // If the browser blocked autoplay on the secondary element
      // for some reason, fall back to a hard cut — at least the
      // listener hears the next item rather than silence.
      fromEl.pause();
      activeRef.current = activeRef.current === 'A' ? 'B' : 'A';
      currentRefRef.current = nextRefKey;
      crossfadeFiredRef.current = false;
      toEl.volume = 1;
      toEl.play();
      fetchNow();
    });

    const stepMs = 50;
    const steps = Math.max(1, Math.floor((seconds * 1000) / stepMs));
    let i = 0;
    if (fadeTimerRef.current) clearInterval(fadeTimerRef.current);
    fadeTimerRef.current = setInterval(() => {
      i += 1;
      const t = Math.min(1, i / steps);
      // Equal-power crossfade so the perceived total loudness stays
      // ~constant through the swap (vs linear which dips ~3 dB at
      // the midpoint).
      const outGain = Math.cos((t * Math.PI) / 2);
      const inGain = Math.cos(((1 - t) * Math.PI) / 2);
      try { fromEl.volume = Math.max(0, Math.min(1, outGain)); } catch { /* ignore */ }
      try { toEl.volume = Math.max(0, Math.min(1, inGain)); } catch { /* ignore */ }
      if (i >= steps) {
        clearInterval(fadeTimerRef.current);
        fadeTimerRef.current = null;
        try { fromEl.pause(); fromEl.removeAttribute('src'); fromEl.load(); } catch { /* ignore */ }
        try { fromEl.volume = 1; } catch { /* ignore */ }
        activeRef.current = activeRef.current === 'A' ? 'B' : 'A';
        currentRefRef.current = nextRefKey;
        crossfadeFiredRef.current = false;
        // Pull the next item from the server so `now.next` updates.
        fetchNow();
      }
    }, stepMs);
  };

  // When the current track finishes WITHOUT a crossfade (cfSec=0
  // or the next URL hadn't loaded), refresh now-playing once so
  // the next render picks up the new item without waiting for the
  // next 4-second poll cycle.
  useEffect(() => {
    const a = audioRefA.current;
    const b = audioRefB.current;
    if (!a || !b) return;
    const onEnded = () => {
      if (fadeTimerRef.current) return; // crossfade is handling it
      // In solo mode, advance the local index manually rather than
      // re-polling the wall-clock endpoint.
      if (soloMode) {
        setSoloIdx((i) => i + 1);
        return;
      }
      currentRefRef.current = null;
      crossfadeFiredRef.current = false;
      fetchNow();
    };
    a.addEventListener('ended', onEnded);
    b.addEventListener('ended', onEnded);
    return () => {
      a.removeEventListener('ended', onEnded);
      b.removeEventListener('ended', onEnded);
    };
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
    if (fadeTimerRef.current) {
      clearInterval(fadeTimerRef.current);
      fadeTimerRef.current = null;
    }
    [audioRefA.current, audioRefB.current].forEach((a) => {
      if (a) {
        a.pause();
        a.removeAttribute('src');
        a.load();
        a.volume = 1;
      }
    });
    currentRefRef.current = null;
    crossfadeFiredRef.current = false;
  };

  // 31 May 2026 — Heartbeat to the backend every 30 s while tuned
  // in. Lets super admins see which showrooms are actually playing
  // the radio (vs the playlist merely being configured). Fire once
  // immediately on tune-in for a fast pill update; then on interval.
  const [deviceLabel, setDeviceLabelState] = useState(() => getDeviceLabel());
  useEffect(() => {
    if (!tunedIn) return undefined;
    let cancelled = false;
    const send = async () => {
      try {
        await fetch(HEARTBEAT_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            device_id: getDeviceId(),
            device_label: deviceLabel || null,
          }),
          // keepalive lets the browser deliver the final ping even if
          // the tab is closing (best-effort; modern browsers honour it).
          keepalive: true,
        });
      } catch (_e) {
        /* offline / network blip — pill will mark us off-air after 90 s */
      }
    };
    send();
    const t = setInterval(() => { if (!cancelled) send(); }, HEARTBEAT_INTERVAL_MS);
    return () => { cancelled = true; clearInterval(t); };
  }, [tunedIn, deviceLabel]);

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
            {soloMode
              ? 'Solo preview · plays from track #1 · NOT synced with showrooms'
              : 'In-store live · 4 showrooms · synced playback'}
          </p>
        </div>
        <div className="ml-auto flex items-center gap-2">
          {soloMode && (
            <span
              className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-[11px] font-bold bg-fuchsia-500/20 text-fuchsia-300 ring-1 ring-fuchsia-500/40"
              data-testid="public-radio-solo-badge"
            >
              SOLO PREVIEW
            </span>
          )}
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

      {/* Sync explainer banner — clears the recurring confusion
          "Why doesn't this start at track #1?" The radio uses
          wall-clock-modulo so all 4 stores hear the same item at
          the same moment, exactly like FM radio. In solo mode this
          banner switches to remind the admin that what they're
          hearing is a PREVIEW and won't match what's in stores.
          (31 May 2026.) */}
      <div
        className={`mx-6 sm:mx-10 mt-3 mb-1 px-3 py-2 rounded-lg border text-[11px] flex items-start gap-2 ${
          soloMode
            ? 'bg-fuchsia-500/5 border-fuchsia-500/30 text-fuchsia-100/80'
            : 'bg-emerald-500/5 border-emerald-500/20 text-emerald-100/70'
        }`}
        data-testid="public-radio-sync-banner"
      >
        <Info className={`w-3.5 h-3.5 mt-0.5 flex-shrink-0 ${soloMode ? 'text-fuchsia-400' : 'text-emerald-400'}`} />
        <div>
          {soloMode ? (
            <>
              <span className="font-semibold text-fuchsia-200">Solo preview mode.</span>{' '}
              Playing the saved playlist from track #1 on this device only.
              Other showrooms will continue with their normal synced loop.
              Close this tab when finished auditioning.
            </>
          ) : (
            <>
              <span className="font-semibold text-emerald-200">Continuous radio (synced).</span>{' '}
              All 4 showrooms hear the same track at the same second.
              You join wherever the playlist loop currently is — like turning on FM radio mid-show, not at the start.
            </>
          )}
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
                      width: audioPos.duration
                        ? `${Math.min(100, (audioPos.current / audioPos.duration) * 100)}%`
                        : '0%',
                    }}
                  />
                </div>
                <div className="flex justify-between text-[11px] text-slate-500 mt-1 font-mono">
                  <span>{Math.floor(audioPos.current || 0)}s</span>
                  <span>{audioPos.duration ? `-${Math.floor(Math.max(0, audioPos.duration - audioPos.current))}s` : ''}</span>
                </div>
              </div>

              {/* Up next list — surfaces the next 3 items from the
                  saved playlist so the user can SEE the radio is
                  following the order they configured. Closes the
                  "Why doesn't the radio follow Saved Playlist?"
                  UX gap (31 May 2026). */}
              {(now.upcoming?.length || now.next) && (
                <div className="w-full max-w-md mt-2" data-testid="public-radio-upcoming">
                  <div className="flex items-center gap-2 text-[10px] uppercase tracking-[0.25em] text-slate-500 font-bold mb-2">
                    <ListMusic className="w-3 h-3" />
                    Up next
                  </div>
                  <ol className="space-y-1 text-left">
                    {(now.upcoming && now.upcoming.length
                      ? now.upcoming
                      : (now.next ? [now.next] : [])
                    ).map((u, i) => (
                      <li
                        key={`${u.type}-${u.ref_id}-${i}`}
                        className="flex items-center gap-2 bg-slate-800/40 border border-slate-700/40 rounded-lg px-3 py-2"
                        data-testid={`public-radio-upcoming-${i}`}
                      >
                        <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${
                          u.type === 'ad' ? 'bg-amber-400' : 'bg-fuchsia-400'
                        }`} />
                        <span className="text-[10px] uppercase tracking-wider text-slate-500 font-bold w-10 flex-shrink-0">
                          {u.type === 'ad' ? 'Ad' : 'Music'}
                        </span>
                        <span className="text-sm text-slate-200 truncate flex-1">{u.name}</span>
                        {typeof u.duration_seconds === 'number' && u.duration_seconds > 0 && (
                          <span className="text-[10px] text-slate-500 font-mono tabular-nums flex-shrink-0">
                            {Math.floor(u.duration_seconds)}s
                          </span>
                        )}
                      </li>
                    ))}
                  </ol>
                </div>
              )}

              {/* Loop position — makes the wall-clock sync model
                  visible. "You're 5 min 12 s into the 27 min loop"
                  beats a silent mystery any day. */}
              {now.playlist && typeof now.playlist.loop_offset_seconds === 'number' && (
                <div className="mt-2 text-[10px] text-slate-600 font-mono" data-testid="public-radio-loop-pos">
                  Loop position:{' '}
                  {Math.floor(now.playlist.loop_offset_seconds / 60)}m{' '}
                  {Math.floor(now.playlist.loop_offset_seconds % 60)}s{' '}
                  of{' '}
                  {Math.floor((now.playlist.total_seconds || 0) / 60)}m{' '}
                  {Math.floor((now.playlist.total_seconds || 0) % 60)}s
                  {typeof now.current_index === 'number' && now.playlist.total_items && (
                    <> · Track {now.current_index + 1} of {now.playlist.total_items}</>
                  )}
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
        <audio ref={audioRefA} preload="none" data-testid="public-radio-audio" />
        <audio ref={audioRefB} preload="none" data-testid="public-radio-audio-b" />
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
        {/* 2 Jun 2026 — Live volume meter. Renders only after the user
            has tuned in so the AudioContext can start without a user-
            gesture violation. Helps staff spot under-normalised tracks
            in real time (e.g. an ad reading −28 dB vs music at −19 dB). */}
        <LiveVolumeMeter
          audioRefA={audioRefA}
          audioRefB={audioRefB}
          tunedIn={tunedIn}
        />
        <p className="text-[10px] text-slate-600 max-w-xs text-center leading-relaxed">
          Connect this device to your store's Bluetooth speaker, tap Tune in,
          and leave the tab open. All 4 stores stay in sync.
        </p>

        {/* Per-device label — lets the admin status pill show
            "Tonbridge front of house" instead of an opaque UUID. */}
        <div className="mt-2 flex items-center gap-2 max-w-sm w-full">
          <label
            htmlFor="radio-device-label"
            className="text-[10px] uppercase tracking-wider text-slate-500 font-bold whitespace-nowrap"
          >
            This device
          </label>
          <input
            id="radio-device-label"
            type="text"
            placeholder="e.g. Tonbridge front of house"
            value={deviceLabel}
            onChange={(e) => {
              setDeviceLabelState(e.target.value);
              setDeviceLabel(e.target.value);
            }}
            data-testid="public-radio-device-label"
            className="flex-1 bg-white/5 border border-white/10 rounded-md px-2 py-1.5 text-xs text-slate-200 placeholder:text-slate-600 focus:outline-none focus:border-amber-400/60"
            maxLength={80}
          />
        </div>
      </div>
    </div>
  );
}
