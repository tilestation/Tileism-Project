/**
 * Tile Visualizer — public page at /visualizer.
 *
 * Hybrid render flow:
 *   1. Customer picks a sample room from the gallery.
 *   2. Customer searches & picks a tile from the live catalog.
 *   3. We auto-trigger a "fast" render on the backend (~1s, no fal cost).
 *   4. Result page shows before/after slider + "✨ Make it photoreal"
 *      button. Photoreal upgrade is free for the 1st render per session;
 *      after that it gates on cart £500+ for unlimited.
 *   5. "Add this look to cart" calculates m² + adhesive + grout and
 *      inserts the line items into the existing cart.
 *
 * No image upload in V1 — only curated sample rooms. V2 adds upload.
 */
import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import axios from 'axios';
import { toast } from 'sonner';
import { Sparkles, Image as ImageIcon, Loader2, ShoppingCart, ChevronRight, Search, Check, ArrowLeft, Upload, Info, Share2 } from 'lucide-react';
import { Button } from '../../components/ui/button';
import { Card } from '../../components/ui/card';
import { Input } from '../../components/ui/input';
import { ShopHeader, ShopFooter } from './TileStationHome';
import { safeArr } from '../../utils/safeStr';

const API = process.env.REACT_APP_BACKEND_URL;

// Inline before/after slider — small enough not to warrant a dependency.
const BeforeAfter = ({ before, after }) => {
  const [pos, setPos] = useState(50);
  return (
    <div
      className="relative w-full max-w-3xl mx-auto rounded-xl overflow-hidden border border-slate-200 select-none"
      data-testid="visualizer-before-after"
    >
      <img src={before} alt="Before" className="block w-full h-auto" />
      <div
        className="absolute inset-0 overflow-hidden"
        style={{ width: `${pos}%` }}
      >
        <img
          src={after}
          alt="After"
          className="block w-full h-auto"
          style={{ width: `${(100 / pos) * 100}%`, maxWidth: 'none' }}
        />
      </div>
      <div
        className="absolute top-0 bottom-0 w-0.5 bg-white shadow-md"
        style={{ left: `${pos}%` }}
      >
        <div className="absolute top-1/2 -translate-y-1/2 -translate-x-1/2 w-9 h-9 rounded-full bg-white shadow-lg flex items-center justify-center text-sm font-bold text-slate-700">
          ⇆
        </div>
      </div>
      <input
        type="range"
        min={0}
        max={100}
        value={pos}
        onChange={(e) => setPos(Number(e.target.value))}
        className="absolute inset-0 w-full h-full opacity-0 cursor-ew-resize"
        data-testid="visualizer-slider"
      />
      <div className="absolute top-2 left-2 px-2 py-0.5 rounded bg-black/60 text-white text-xs font-semibold tracking-wide uppercase">Before</div>
      <div className="absolute top-2 right-2 px-2 py-0.5 rounded bg-emerald-600 text-white text-xs font-semibold tracking-wide uppercase">After</div>
    </div>
  );
};


const RoomCard = ({ room, selected, onSelect }) => (
  <button
    type="button"
    onClick={() => onSelect(room)}
    className={`group relative rounded-xl overflow-hidden border-2 transition-all ${
      selected ? 'border-yellow-400 ring-2 ring-yellow-200' : 'border-transparent hover:border-slate-300'
    }`}
    data-testid={`visualizer-room-${room.id}`}
  >
    <img
      src={room.image_url}
      alt={room.label}
      className="w-full h-40 object-cover transition group-hover:scale-105"
      loading="lazy"
    />
    <div className="absolute inset-x-0 bottom-0 p-2 bg-gradient-to-t from-black/80 to-transparent">
      <div className="text-white text-sm font-semibold">{room.label}</div>
      <div className="text-white/70 text-[10px] uppercase tracking-wider">
        {room.room_type} · {room.surface_kind}
      </div>
    </div>
    {selected && (
      <div className="absolute top-2 right-2 w-6 h-6 rounded-full bg-yellow-400 text-slate-900 flex items-center justify-center">
        <Check className="w-4 h-4" />
      </div>
    )}
  </button>
);


const TilePicker = ({ value, onChange }) => {
  const [q, setQ] = useState('');
  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let cancel = false;
    const handle = setTimeout(async () => {
      if (q.trim().length < 2) {
        // Default: show 8 most popular tiles
        try {
          const r = await axios.get(`${API}/api/tiles/products?limit=8`);
          if (!cancel) setResults((r.data?.products || r.data || []).slice(0, 8));
        } catch (_e) { /* ignore */ }
        return;
      }
      setLoading(true);
      try {
        const r = await axios.get(`${API}/api/tiles/products?search=${encodeURIComponent(q)}&limit=12`);
        if (!cancel) setResults(r.data?.products || r.data || []);
      } catch (_e) {
        if (!cancel) setResults([]);
      } finally {
        if (!cancel) setLoading(false);
      }
    }, 300);
    return () => { cancel = true; clearTimeout(handle); };
  }, [q]);

  return (
    <div data-testid="visualizer-tile-picker">
      <div className="relative mb-3">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
        <Input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search tiles by name, colour, size…"
          className="pl-9"
          data-testid="visualizer-tile-search"
        />
      </div>
      {loading && (
        <div className="text-xs text-slate-500 flex items-center gap-1">
          <Loader2 className="w-3 h-3 animate-spin" /> Loading…
        </div>
      )}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2 max-h-72 overflow-y-auto pr-1">
        {results.map((t) => {
          // Normalise the gallery — same shape (string OR {url}) the
          // visualizer's _resolve_tile copes with.
          const allImages = (Array.isArray(t.images) ? t.images : [])
            .map((i) => (typeof i === 'string' ? i : (i && i.url) || ''))
            .filter(Boolean);
          const img = allImages[0] || t.image || '';
          const id = t.id || t._id;
          if (!img) return null;
          const selected = value?.id === id;
          return (
            <button
              key={id}
              type="button"
              onClick={() => onChange({
                id,
                name: t.display_name || t.our_name || t.name,
                image: img,
                images: allImages,  // full gallery for thumbnail strip
                price_per_m2: t.price_per_m2 || t.our_price || t.price || 25,
              })}
              className={`relative rounded-lg overflow-hidden border-2 transition ${
                selected ? 'border-yellow-400' : 'border-transparent hover:border-slate-300'
              }`}
              data-testid={`visualizer-tile-${id}`}
            >
              <img src={img} alt={t.display_name || t.name} className="w-full h-24 object-cover" loading="lazy" />
              <div className="p-1.5 text-[10px] text-slate-700 bg-white truncate">
                {(t.display_name || t.our_name || t.name || '').replace(/^\d+x\d+\s*/, '')}
              </div>
              {selected && (
                <div className="absolute top-1 right-1 w-5 h-5 rounded-full bg-yellow-400 text-slate-900 flex items-center justify-center">
                  <Check className="w-3 h-3" />
                </div>
              )}
              {allImages.length > 1 && (
                <div className="absolute bottom-7 right-1 px-1.5 py-0.5 rounded bg-black/60 text-white text-[9px] font-bold tracking-wide" title={`${allImages.length} images available`}>
                  +{allImages.length - 1}
                </div>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
};


// Inline waitlist form on the Coming Soon screen. Captures the email
// into `visualizer_waitlist` so we have a primed audience to email the
// day the feature flag flips.
const WaitlistForm = () => {
  const [email, setEmail] = useState('');
  const [status, setStatus] = useState('idle'); // idle | sending | done | error
  const [msg, setMsg] = useState('');

  const submit = async (e) => {
    e.preventDefault();
    if (!email.trim() || !email.includes('@')) {
      setStatus('error'); setMsg('Please enter a valid email');
      return;
    }
    setStatus('sending');
    try {
      const r = await axios.post(`${API}/api/visualizer/waitlist`, {
        email: email.trim(),
        source: 'coming_soon_page',
        referrer: document.referrer || '',
      });
      setStatus('done');
      setMsg(r.data?.message || "You're on the list — we'll email you the day it goes live.");
    } catch (err) {
      setStatus('error');
      setMsg(err?.response?.data?.detail || 'Could not save your email — please try again.');
    }
  };

  if (status === 'done') {
    return (
      <div className="max-w-md mx-auto rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-emerald-800 text-sm font-semibold flex items-center gap-2 justify-center" data-testid="visualizer-waitlist-success">
        <Check className="w-4 h-4" /> {msg}
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="max-w-md mx-auto" data-testid="visualizer-waitlist-form">
      <div className="flex flex-col sm:flex-row gap-2">
        <Input
          type="email"
          value={email}
          onChange={(e) => { setEmail(e.target.value); if (status === 'error') setStatus('idle'); }}
          placeholder="you@example.com"
          className="flex-1"
          disabled={status === 'sending'}
          data-testid="visualizer-waitlist-email"
        />
        <Button
          type="submit"
          disabled={status === 'sending'}
          className="bg-slate-900 hover:bg-slate-800 text-yellow-300 font-bold whitespace-nowrap"
          data-testid="visualizer-waitlist-submit"
        >
          {status === 'sending' ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Notify me when it\u2019s live'}
        </Button>
      </div>
      {status === 'error' && (
        <div className="mt-2 text-xs text-red-600" data-testid="visualizer-waitlist-error">{msg}</div>
      )}
      <div className="mt-2 text-[11px] text-slate-400">
        We'll only use this to tell you when the visualizer is ready. No marketing spam.
      </div>
    </form>
  );
};


// "Upload your own room" tile that sits in the room gallery.
const UploadRoomCard = ({ onUploaded }) => {
  const [busy, setBusy] = useState(false);
  const [surfaceKind, setSurfaceKind] = useState('floor');
  const inputRef = React.useRef(null);

  const onFileChosen = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > 12 * 1024 * 1024) {
      toast.error('Photo too large — please pick one under 12 MB');
      return;
    }
    setBusy(true);
    try {
      const fd = new FormData();
      fd.append('file', file);
      fd.append('surface_kind', surfaceKind);
      const tok = localStorage.getItem('token') || localStorage.getItem('access_token') || '';
      const r = await axios.post(`${API}/api/visualizer/upload-room`, fd, {
        headers: {
          'Content-Type': 'multipart/form-data',
          ...(tok ? { Authorization: `Bearer ${tok}` } : {}),
        },
        timeout: 45000,
      });
      onUploaded?.({
        id: r.data.upload_session_id,
        label: 'Your room',
        image_url: r.data.image_url,
        surface_kind: surfaceKind,
        surface_polygon: r.data.surface_polygon,
        is_user_upload: true,
        auto_detected: r.data.auto_detected,
      });
      toast.success(r.data.auto_detected ? 'Room detected ✓' : 'Room uploaded — using a default surface (we couldn\'t auto-detect)');
    } catch (err) {
      toast.error(err?.response?.data?.detail || 'Upload failed — try a different photo');
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = '';
    }
  };

  return (
    <div
      className="relative rounded-xl overflow-hidden border-2 border-dashed border-yellow-300 bg-yellow-50 p-3 flex flex-col items-center justify-center text-center min-h-[160px] cursor-pointer hover:border-yellow-500 hover:bg-yellow-100 transition"
      onClick={() => !busy && inputRef.current?.click()}
      data-testid="visualizer-upload-card"
    >
      <input ref={inputRef} type="file" accept="image/jpeg,image/png,image/webp" onChange={onFileChosen} className="hidden" data-testid="visualizer-upload-input" />
      {busy ? (
        <>
          <Loader2 className="w-6 h-6 text-yellow-600 animate-spin mb-1" />
          <div className="text-xs font-semibold text-slate-700">Detecting surface…</div>
          <div className="text-[10px] text-slate-500">~5 seconds</div>
        </>
      ) : (
        <>
          <Upload className="w-6 h-6 text-yellow-600 mb-1" />
          <div className="text-xs font-bold text-slate-900">Upload your own room</div>
          <div className="text-[10px] text-slate-500 mt-1">JPG / PNG / WebP · max 12 MB</div>
          <div className="mt-2 flex gap-1 text-[10px]">
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); setSurfaceKind('floor'); }}
              className={`px-2 py-0.5 rounded font-semibold ${surfaceKind === 'floor' ? 'bg-slate-900 text-yellow-300' : 'bg-white text-slate-600 border border-slate-300'}`}
            >Floor</button>
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); setSurfaceKind('wall'); }}
              className={`px-2 py-0.5 rounded font-semibold ${surfaceKind === 'wall' ? 'bg-slate-900 text-yellow-300' : 'bg-white text-slate-600 border border-slate-300'}`}
            >Wall</button>
          </div>
        </>
      )}
    </div>
  );
};


const TileVisualizerPage = () => {
  const navigate = useNavigate();
  const [rooms, setRooms] = useState([]);
  const [room, setRoom] = useState(null);
  const [tile, setTile] = useState(null);
  const [imageIdx, setImageIdx] = useState(0);  // which gallery image of the tile is the texture
  const [session, setSession] = useState(null);
  const [renders, setRenders] = useState({ fast: null, photoreal: null });
  const [busy, setBusy] = useState({ fast: false, photoreal: false });
  const [quote, setQuote] = useState(null);
  // Feature flag — defaults to "checking" until backend responds, then
  // either "enabled" (real visualizer) or "soon" (Coming Soon placeholder).
  const [flag, setFlag] = useState({ status: 'checking', adminPreview: false });

  // Probe the feature flag first. If the visualizer isn't publicly
  // enabled AND we're not an admin opening the page with the explicit
  // ?preview=1 query param, render the Coming Soon screen and skip
  // every other API call. The query-param gate is deliberate — May 3
  // 2026 the user found the visualizer was reachable to anyone with an
  // admin cookie, including from the customer-facing nav. Now admins
  // must explicitly visit /visualizer?preview=1 (linked from
  // /admin/visualizer) to preview, so the live URL always behaves as
  // Coming Soon for everyone else.
  useEffect(() => {
    const tok = localStorage.getItem('token') || localStorage.getItem('access_token') || '';
    let previewQuery = false;
    try {
      previewQuery = new URLSearchParams(window.location.search).get('preview') === '1';
    } catch (_e) { /* noop */ }
    axios.get(`${API}/api/visualizer/feature-flag`, {
      headers: (tok && previewQuery) ? { Authorization: `Bearer ${tok}` } : {},
    }).then((r) => {
      // public flag wins. admin_preview is only honoured when explicitly opted-in via ?preview=1.
      if (r.data?.public) {
        setFlag({ status: 'enabled', adminPreview: false });
      } else if (previewQuery && r.data?.admin_preview) {
        setFlag({ status: 'enabled', adminPreview: true });
      } else {
        setFlag({ status: 'soon', adminPreview: false });
      }
    }).catch(() => setFlag({ status: 'soon', adminPreview: false }));
  }, []);

  // Load sample rooms on mount (only once flag is enabled)
  useEffect(() => {
    if (flag.status !== 'enabled') return;
    const tok = localStorage.getItem('token') || localStorage.getItem('access_token') || '';
    axios.get(`${API}/api/visualizer/sample-rooms`, {
      headers: tok ? { Authorization: `Bearer ${tok}` } : {},
    }).then((r) => {
      const list = r.data?.rooms || [];
      setRooms(list);
      if (list.length && !room) setRoom(list[0]);
    }).catch(() => toast.error('Failed to load sample rooms'));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flag.status]);

  // Optional ?tile=<id> deep-link — used by share/viral links so a
  // visitor lands on the visualizer with the same tile pre-selected.
  useEffect(() => {
    if (flag.status !== 'enabled' || tile) return;
    try {
      const params = new URLSearchParams(window.location.search);
      const tileId = params.get('tile');
      if (!tileId) return;
      axios.get(`${API}/api/tiles/products?limit=1&search=${encodeURIComponent(tileId)}`)
        .then((r) => {
          const list = r.data?.products || r.data || [];
          // Prefer exact id match, otherwise first hit
          const match = list.find((t) => (t.id || t._id) === tileId) || list[0];
          if (!match) return;
          const img = (Array.isArray(match.images) && match.images[0])
            ? (typeof match.images[0] === 'string' ? match.images[0] : match.images[0].url)
            : (match.image || '');
          if (!img) return;
          setTile({
            id: match.id || match._id,
            name: match.display_name || match.our_name || match.name,
            image: img,
            price_per_m2: match.price_per_m2 || match.our_price || match.price || 25,
          });
        })
        .catch(() => {});
    } catch (_e) { /* noop */ }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flag.status]);

  // Reset image index whenever the tile changes — different products
  // have different gallery sizes so an old idx may be out of range.
  useEffect(() => {
    setImageIdx(0);
  }, [tile?.id]);

  // When room + tile both selected → start session + auto-fire fast render
  useEffect(() => {
    if (!room || !tile) return;
    let cancelled = false;
    const tok = localStorage.getItem('token') || localStorage.getItem('access_token') || '';
    const authHdr = tok ? { Authorization: `Bearer ${tok}` } : {};
    (async () => {
      setBusy({ fast: true, photoreal: false });
      setRenders({ fast: null, photoreal: null });
      try {
        const isUpload = !!room.is_user_upload;
        const r = await axios.post(`${API}/api/visualizer/sessions`, {
          sample_room_id: isUpload ? null : room.id,
          upload_session_id: isUpload ? room.id : null,
          tile_id: tile.id,
          image_index: imageIdx,
          surface_kind: room.surface_kind,
        }, { headers: authHdr });
        if (cancelled) return;
        setSession(r.data);
        const rr = await axios.post(`${API}/api/visualizer/sessions/${r.data.session_id}/render`, { style: 'fast' }, { headers: authHdr });
        if (cancelled) return;
        setRenders((p) => ({ ...p, fast: rr.data.result_url }));
      } catch (e) {
        toast.error(e?.response?.data?.detail?.message || e?.response?.data?.detail || 'Render failed');
      } finally {
        if (!cancelled) setBusy({ fast: false, photoreal: false });
      }
    })();
    return () => { cancelled = true; };
  }, [room?.id, tile?.id, imageIdx]);

  // After fast render lands → load quote in background
  useEffect(() => {
    if (!session?.session_id || !renders.fast) return;
    axios.post(`${API}/api/visualizer/sessions/${session.session_id}/quote`, {})
      .then((r) => setQuote(r.data))
      .catch(() => {});
  }, [session?.session_id, renders.fast]);

  const triggerPhotoreal = async () => {
    if (!session?.session_id) return;
    setBusy((p) => ({ ...p, photoreal: true }));
    try {
      const r = await axios.post(`${API}/api/visualizer/sessions/${session.session_id}/render`, { style: 'photoreal' });
      setRenders((p) => ({ ...p, photoreal: r.data.result_url }));
      toast.success('Photoreal render ready ✨');
    } catch (e) {
      const status = e?.response?.status;
      const detail = e?.response?.data?.detail;
      if (status === 402) {
        toast.warning(detail?.message || 'Free photoreal render used — add £500+ to basket for more.');
      } else {
        toast.error(detail?.message || detail || 'Photoreal render failed');
      }
    } finally {
      setBusy((p) => ({ ...p, photoreal: false }));
    }
  };

  const [sharing, setSharing] = useState(false);
  const handleShare = async () => {
    if (!session?.session_id || sharing) return;
    setSharing(true);
    try {
      const r = await axios.post(`${API}/api/visualizer/sessions/${session.session_id}/share`, {});
      const url = `${window.location.origin}${r.data.share_url}`;
      // Try the native share sheet first (mobile), fall back to copy-to-clipboard
      const shareData = {
        title: `${tile.name} on ${room.label} — Tile Station Visualizer`,
        text: `Check out how ${tile.name} looks in this room — rendered by Tile Station's AI visualizer.`,
        url,
      };
      if (navigator.share && navigator.canShare?.(shareData)) {
        try {
          await navigator.share(shareData);
          return;
        } catch (_e) { /* user cancelled — fall through to copy */ }
      }
      try {
        await navigator.clipboard.writeText(url);
        toast.success('Share link copied — paste it anywhere');
      } catch (_e) {
        // Last-resort fallback for very old browsers — show the URL in an alert
        window.prompt('Copy this link:', url);
      }
    } catch (e) {
      toast.error(e?.response?.data?.detail || 'Could not create share link');
    } finally {
      setSharing(false);
    }
  };

  const addToCart = () => {
    if (!quote || !tile) return;
    // Push tile into the existing localStorage cart used by the storefront.
    // The cart context picks it up on next /cart visit.
    try {
      const cartRaw = localStorage.getItem('shop_cart');
      const cart = cartRaw ? JSON.parse(cartRaw) : { items: [] };
      cart.items = cart.items || [];
      cart.items.push({
        id: tile.id,
        name: tile.name,
        image: tile.image,
        price_per_m2: quote.tile_price_per_m2,
        m2: quote.tile_m2_with_wastage,
        line_total: quote.tile_subtotal,
        added_at: new Date().toISOString(),
        from_visualizer: true,
        room_label: quote.room_name,
      });
      localStorage.setItem('shop_cart', JSON.stringify(cart));
      toast.success(`${quote.tile_m2_with_wastage}m² of ${tile.name} added to basket`);
      setTimeout(() => navigate('/cart'), 800);
    } catch (e) {
      toast.error('Could not update basket');
    }
  };

  const after = renders.photoreal || renders.fast;

  // ── Feature-flag gate ─────────────────────────────────────────────
  if (flag.status === 'checking') {
    return (
      <div className="min-h-screen bg-slate-50 flex flex-col">
        <ShopHeader />
        <main className="flex-1 flex items-center justify-center">
          <Loader2 className="w-8 h-8 animate-spin text-yellow-500" />
        </main>
        <ShopFooter />
      </div>
    );
  }
  if (flag.status === 'soon') {
    return (
      <div className="min-h-screen bg-slate-50 flex flex-col">
        <ShopHeader />
        <main className="flex-1 max-w-3xl mx-auto px-4 sm:px-6 py-20 w-full text-center">
          <div className="inline-flex items-center justify-center w-20 h-20 rounded-full bg-gradient-to-br from-amber-400 to-yellow-500 mb-6">
            <Sparkles className="w-10 h-10 text-slate-900" />
          </div>
          <h1 className="text-4xl sm:text-5xl font-bold text-slate-900 tracking-tight mb-3">
            Tile Visualizer — coming soon
          </h1>
          <p className="text-slate-600 max-w-xl mx-auto text-base mb-2">
            See any tile in a real room — instantly. Pick a room, pick a tile, and we'll render it photoreal in seconds.
          </p>
          <p className="text-slate-500 text-sm mb-8">
            We're polishing the renders before letting it loose. Drop your email below and we'll be in touch the day it's live.
          </p>

          <WaitlistForm />

          <Button
            onClick={() => navigate('/tiles')}
            variant="outline"
            className="mt-6 border-slate-300 text-slate-700 hover:bg-slate-100"
            data-testid="visualizer-coming-soon-cta"
          >
            Browse our tiles in the meantime
          </Button>
        </main>
        <ShopFooter />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-50 flex flex-col">
      <ShopHeader />

      {flag.adminPreview && (
        <div className="bg-amber-100 border-b border-amber-300 text-amber-900 text-xs text-center py-1.5 font-semibold" data-testid="visualizer-admin-preview-banner">
          Admin preview · Visualizer is hidden from customers — flip the toggle in /admin/visualizer to go live.
        </div>
      )}

      <main className="flex-1 max-w-7xl mx-auto px-4 sm:px-6 py-8 w-full">
        {/* Header */}
        <div className="mb-6">
          <button onClick={() => navigate(-1)} className="text-xs text-slate-500 hover:text-slate-800 flex items-center gap-1 mb-2">
            <ArrowLeft className="w-3 h-3" /> Back
          </button>
          <h1 className="text-3xl sm:text-4xl font-bold text-slate-900 tracking-tight">
            Tile Visualizer
          </h1>
          <p className="text-slate-600 mt-1 max-w-2xl">
            See any tile in a real room — instantly. Pick a room, pick a tile, and we'll render it for you.
            Want it to look photoreal? One free per session.
          </p>
        </div>

        <div className="grid lg:grid-cols-12 gap-6">
          {/* LEFT — Room + tile pickers */}
          <div className="lg:col-span-5 space-y-4">
            <Card className="p-4">
              <div className="flex items-center justify-between mb-3">
                <h2 className="font-bold text-slate-900 text-base flex items-center gap-2">
                  <ImageIcon className="w-4 h-4 text-yellow-500" /> 1. Choose a room
                </h2>
                <span className="text-[10px] text-slate-400 uppercase tracking-wide">
                  Or upload your own
                </span>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <UploadRoomCard onUploaded={(uploadedRoom) => setRoom(uploadedRoom)} />
                {rooms.map((r) => (
                  <RoomCard key={r.id} room={r} selected={room?.id === r.id} onSelect={setRoom} />
                ))}
              </div>
              {rooms.length === 0 && (
                <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900" data-testid="visualizer-rooms-empty">
                  <div className="font-semibold mb-0.5">Sample rooms loading…</div>
                  <div>Or upload your own room photo above to get started right away.</div>
                </div>
              )}
            </Card>

            <Card className="p-4">
              <h2 className="font-bold text-slate-900 text-base mb-3">
                2. Pick a tile
              </h2>
              <TilePicker value={tile} onChange={setTile} />

              {tile && Array.isArray(tile.images) && tile.images.length > 1 && (
                <div className="mt-4 pt-3 border-t border-slate-200" data-testid="visualizer-tile-image-strip">
                  <div className="flex items-center justify-between mb-2">
                    <div className="text-xs font-bold uppercase tracking-wider text-slate-600">
                      Texture image · {safeArr(tile.images).length} available
                    </div>
                    <div className="text-[10px] text-slate-500">
                      Image {imageIdx + 1} of {safeArr(tile.images).length}
                    </div>
                  </div>
                  <div className="grid grid-cols-5 sm:grid-cols-6 gap-1.5">
                    {safeArr(tile.images).map((u, i) => (
                      <button
                        key={`${u}-${i}`}
                        type="button"
                        onClick={() => setImageIdx(i)}
                        className={`relative rounded overflow-hidden border-2 transition ${
                          imageIdx === i ? 'border-yellow-400 ring-2 ring-yellow-200' : 'border-transparent hover:border-slate-300'
                        }`}
                        data-testid={`visualizer-tile-image-${i}`}
                        title={`Use image ${i + 1} as the tile texture`}
                      >
                        <img src={u} alt={`${tile.name} ${i + 1}`} className="w-full h-12 object-cover" loading="lazy" />
                        {imageIdx === i && (
                          <div className="absolute top-0.5 right-0.5 w-3.5 h-3.5 rounded-full bg-yellow-400 text-slate-900 flex items-center justify-center">
                            <Check className="w-2 h-2" />
                          </div>
                        )}
                      </button>
                    ))}
                  </div>
                  <div className="mt-2 text-[11px] text-slate-500">
                    Different angles or colourways of the same tile? Tap a thumbnail to re-render with that image as the texture.
                  </div>
                </div>
              )}
            </Card>
          </div>

          {/* RIGHT — Render */}
          <div className="lg:col-span-7 space-y-4">
            <Card className="p-4 min-h-[400px] flex flex-col justify-center" data-testid="visualizer-result-card">
              {!room || !tile ? (
                <div className="text-center text-slate-500 py-16">
                  <ImageIcon className="w-12 h-12 mx-auto mb-3 text-slate-300" />
                  <div className="font-semibold">Pick a room and a tile to begin</div>
                  <div className="text-sm mt-1">Your render will appear here.</div>
                </div>
              ) : busy.fast && !renders.fast ? (
                <div className="text-center text-slate-500 py-16">
                  <Loader2 className="w-12 h-12 mx-auto mb-3 animate-spin text-yellow-500" />
                  <div className="font-semibold">Rendering your room…</div>
                  <div className="text-sm mt-1">~2 seconds</div>
                </div>
              ) : after ? (
                <>
                  <BeforeAfter before={room.image_url} after={after} />

                  {/* AI render disclaimer — keeps customer expectations honest. */}
                  <div className="mt-3 p-3 rounded-lg bg-amber-50 border border-amber-200 text-amber-900 text-xs flex items-start gap-2" data-testid="visualizer-ai-disclaimer">
                    <Info className="w-4 h-4 flex-shrink-0 mt-0.5" />
                    <div>
                      <span className="font-semibold">This is an AI render</span> — actual tile colour, grout, and finish may differ slightly from what you see.{' '}
                      <button onClick={() => navigate('/shop/tile-samples')} className="underline font-semibold hover:text-amber-700">
                        Order a free sample
                      </button>{' '}
                      to confirm before you buy.
                    </div>
                  </div>

                  <div className="mt-4 flex items-center justify-between gap-3 flex-wrap">
                    <div className="text-xs text-slate-600">
                      Showing <span className="font-bold">{tile.name}</span> on <span className="font-bold">{room.label}</span>
                      {renders.photoreal && (
                        <span className="ml-2 inline-flex items-center gap-1 text-emerald-700 font-semibold">
                          <Sparkles className="w-3 h-3" /> Photoreal
                        </span>
                      )}
                    </div>
                    {!renders.photoreal && (
                      <Button
                        size="sm"
                        onClick={triggerPhotoreal}
                        disabled={busy.photoreal}
                        className="bg-gradient-to-r from-amber-400 to-yellow-500 hover:from-amber-500 hover:to-yellow-600 text-slate-900 font-bold"
                        data-testid="visualizer-photoreal-btn"
                      >
                        {busy.photoreal ? (
                          <><Loader2 className="w-4 h-4 animate-spin mr-1" /> ~15s</>
                        ) : (
                          <><Sparkles className="w-4 h-4 mr-1" /> Make it photoreal</>
                        )}
                      </Button>
                    )}
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={handleShare}
                      disabled={sharing}
                      className="border-slate-300 text-slate-700 hover:bg-slate-100 font-semibold"
                      data-testid="visualizer-share-btn"
                    >
                      {sharing ? <Loader2 className="w-4 h-4 animate-spin mr-1" /> : <Share2 className="w-4 h-4 mr-1" />}
                      Share
                    </Button>
                  </div>
                </>
              ) : null}
            </Card>

            {/* Quote / Add-to-cart */}
            {quote && (
              <Card className="p-4" data-testid="visualizer-quote-card">
                <div className="flex items-start justify-between gap-3 flex-wrap">
                  <div>
                    <div className="text-xs uppercase tracking-wider text-slate-500 font-semibold">
                      Estimate for this look
                    </div>
                    <div className="mt-1 text-2xl font-bold text-slate-900">
                      £{quote.total_estimate.toFixed(2)}
                    </div>
                    <div className="text-xs text-slate-600 mt-1 leading-snug">
                      {quote.tile_m2_with_wastage}m² of tile (incl. {quote.wastage_percent}% wastage) · {quote.adhesive_bags}× adhesive · {quote.grout_bags}× grout
                    </div>
                  </div>
                  <Button
                    onClick={addToCart}
                    className="bg-slate-900 hover:bg-slate-800 text-yellow-300 font-bold"
                    data-testid="visualizer-add-to-cart-btn"
                  >
                    <ShoppingCart className="w-4 h-4 mr-2" />
                    Add to basket
                    <ChevronRight className="w-4 h-4 ml-1" />
                  </Button>
                </div>
              </Card>
            )}
          </div>
        </div>
      </main>

      <ShopFooter />
    </div>
  );
};

export default TileVisualizerPage;
