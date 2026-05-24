/**
 * Marketing Studio — /admin/marketing-studio
 *
 * Generate AI banners (Nano Banana or GPT Image 1), manage a gallery,
 * 1-click publish to homepage hero or to the site-wide promo banner.
 */
import React, { useEffect, useMemo, useState } from 'react';
import axios from 'axios';
import { toast } from 'sonner';
import { Card } from '../../components/ui/card';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { Textarea } from '../../components/ui/textarea';
import {
  Loader2, Sparkles, Wand2, Image as ImageIcon, Trash2, Send,
  Home, Megaphone, RefreshCw, PoundSterling, Layers, FileSearch,
  AlertTriangle, Check, ExternalLink, Zap, Maximize2, X, Download,
  Video,
} from 'lucide-react';
import { normaliseImageUrl } from '../../utils/safeStr';

const API = process.env.REACT_APP_BACKEND_URL;
const tokenHdr = () => {
  const t = localStorage.getItem('token') || localStorage.getItem('access_token') || '';
  return t ? { Authorization: `Bearer ${t}` } : {};
};

const PRESETS = [
  { key: 'hero',             label: 'Homepage hero (1920×640) — recommended', w: 1920, h: 640,  kind: 'hero' },
  { key: 'hero-tall',        label: 'Hero tall (1920×720) — Tile-Mountain style', w: 1920, h: 720,  kind: 'hero' },
  { key: 'hero-wide-short',  label: 'Hero short (1920×600) — above-the-fold safe', w: 1920, h: 600,  kind: 'hero' },
  // Portrait variant for the mobile <picture> swap. 1080×1440 = 3:4,
  // matching Tile Mountain's tall mobile hero (kitchen scene + bottom
  // gradient strip with text). The storefront uses an aspect-[3/4]
  // section on mobile when every slide carries a variant of this
  // shape — banner fills edge-to-edge with no letterbox.
  // (24 May 2026 — v5 mobile-banner upgrade.)
  { key: 'hero-mobile',      label: 'Hero mobile portrait (1080×1440) — for mobile <picture> swap', w: 1080, h: 1440, kind: 'hero' },
  { key: 'hero-square',      label: 'Hero square (1080×1080)',     w: 1080, h: 1080, kind: 'hero' },
  { key: 'ribbon',           label: 'Promo banner strip (1200×300)', w: 1200, h: 300,  kind: 'ribbon' },
  { key: 'social-square',    label: 'Social square (1080×1080)',   w: 1080, h: 1080, kind: 'social' },
  { key: 'social-portrait',  label: 'Social portrait (1080×1350)', w: 1080, h: 1350, kind: 'social' },
  { key: 'social-landscape', label: 'Social landscape (1200×628)', w: 1200, h: 628,  kind: 'social' },
  { key: 'lifestyle-product',label: 'Lifestyle product (1024×1024)', w: 1024, h: 1024, kind: 'lifestyle' },
];

const MODELS = [
  { id: 'nano-banana',   label: 'Nano Banana (Gemini · ~£0.04 · fast, great with text)' },
  { id: 'gpt-image-1',   label: 'GPT Image 1 (OpenAI · ~£0.10 · sharper composition)' },
];

const DEFAULT_PROMPT = `A premium UK tile-shop banner advertising "Bank Holiday Sale — Up to 30% off" with bold gold (#F7EA1C) headline text and a "Shop Now" call to action. Background: tasteful luxury bathroom interior with marble-effect porcelain tiles, natural sunlight, soft shadows. Tile Station brand mark. Magazine-quality interior photography. Sharp text, clear hierarchy.`;

// --- Asset card -----------------------------------------------------

const AssetCard = ({ asset, mobileVariantOptions, onPublish, onDelete, onUnpublish, onZoom, onRegenerate }) => {
  const [showPublish, setShowPublish] = useState(false);
  const [linkUrl, setLinkUrl] = useState('');
  const [ctaText, setCtaText] = useState('Shop Now');
  const [autoUnpublishAt, setAutoUnpublishAt] = useState('');  // datetime-local string, e.g. '2026-05-04T09:00'
  // Carousel rotation speed (seconds). Only matters when ≥2 hero
  // slides are active. Stored on the slide doc so the storefront's
  // HeroBannerCarousel picks it up. 5s = historical default.
  // (24 May 2026 — user-requested control.)
  const [rotationSeconds, setRotationSeconds] = useState(5);
  // Optional portrait-cropped mobile variant. References another
  // Marketing-Studio asset's image_url. Empty string = "no variant,
  // use the main image with letterbox on mobile".
  // (24 May 2026 — user-requested mobile variant support.)
  const [mobileVariantId, setMobileVariantId] = useState('');
  const [busy, setBusy] = useState(false);
  const [regenerating, setRegenerating] = useState(false);

  // "Fixed with safe-zone rules" banners carry the `regenerated_with`
  // field. Show a small green badge so admins can tell at a glance
  // which banners are the improved ones.
  const isRegenerated = !!asset.regenerated_with;

  const regenerate = async () => {
    if (!window.confirm(
      'Regenerate this banner with the new text-safe-zone rules?\n\n'
      + 'The old banner will be archived (you can still see it in "Include old versions"). '
      + (asset.published_to
          ? `Because it's currently live as ${asset.published_to.replace('_', ' ')}, the storefront will hot-swap to the new version automatically.`
          : 'The new one will appear next to the old in your gallery.')
      + '\n\n'
      + `Cost: ~$${Number(asset.cost_usd || 0).toFixed(2)} (same as the original).`,
    )) return;
    setRegenerating(true);
    try {
      await onRegenerate?.(asset);
    } finally {
      setRegenerating(false);
    }
  };

  const publish = async (placement) => {
    setBusy(true);
    try {
      // datetime-local input gives a string without timezone — interpret as
      // browser local time and send ISO with explicit offset so the backend
      // stores an unambiguous UTC instant.
      let isoEnd = null;
      if (autoUnpublishAt) {
        try {
          isoEnd = new Date(autoUnpublishAt).toISOString();
        } catch { /* invalid date — ignore, no schedule */ }
      }
      await onPublish(asset.id, placement, {
        link_url: linkUrl,
        cta_text: ctaText,
        auto_unpublish_at: isoEnd,
        rotation_seconds: rotationSeconds,
        mobile_image_url: (mobileVariantOptions || []).find((o) => o.id === mobileVariantId)?.image_url || '',
      });
      setShowPublish(false);
    } finally {
      setBusy(false);
    }
  };

  const fullUrl = asset.image_url?.startsWith('http') ? asset.image_url : `${API}${asset.image_url}`;
  return (
    <Card className="overflow-hidden flex flex-col" data-testid={`marketing-asset-${asset.id}`}>
      <div
        className="aspect-video bg-slate-100 overflow-hidden flex items-center justify-center relative cursor-zoom-in group"
        onClick={() => onZoom?.(asset)}
        data-testid={`marketing-asset-zoom-${asset.id}`}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onZoom?.(asset); } }}
        title="Click to view full size"
      >
        <img src={fullUrl} alt={asset.prompt?.slice(0, 80)} className="w-full h-full object-cover" loading="lazy" />
        {asset.variant_group_id && (
          <div className="absolute top-1.5 left-1.5 px-1.5 py-0.5 rounded bg-purple-600 text-white text-[10px] font-bold uppercase tracking-wide">
            Variant {(asset.variant_index ?? 0) + 1}
          </div>
        )}
        {isRegenerated && (
          <div
            className="absolute bottom-1.5 left-1.5 px-1.5 py-0.5 rounded bg-emerald-600 text-white text-[10px] font-bold uppercase tracking-wide flex items-center gap-1"
            data-testid={`marketing-asset-safe-zone-badge-${asset.id}`}
            title="This banner was regenerated with the text-safe-zone rules applied"
          >
            <Check className="w-2.5 h-2.5" /> Text-safe
          </div>
        )}
        <div className="absolute top-1.5 right-1.5 p-1.5 rounded-full bg-black/50 text-white opacity-0 group-hover:opacity-100 transition">
          <Maximize2 className="w-3.5 h-3.5" />
        </div>
      </div>
      <div className="p-3 flex-1 flex flex-col">
        <div className="flex items-start justify-between gap-2">
          <div className="flex-1">
            <div className="text-[10px] uppercase tracking-wide text-slate-500 font-bold">
              {asset.model} · {asset.width}×{asset.height} · ${asset.cost_usd}
            </div>
            <div className="text-xs text-slate-700 mt-1 line-clamp-3">{asset.prompt}</div>
          </div>
        </div>
        {asset.published_to && (
          <div className="mt-2 space-y-1">
            <div className="flex items-center justify-between gap-2 text-[10px] uppercase tracking-wide font-bold text-emerald-700">
              <span>Published → {asset.published_to.replace('_', ' ')}</span>
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); onUnpublish?.(asset.id, asset.published_to); }}
                disabled={busy}
                className="px-2 py-0.5 rounded bg-amber-100 text-amber-800 hover:bg-amber-200 normal-case font-bold border border-amber-300"
                data-testid={`marketing-asset-unpublish-${asset.id}`}
                title="Remove from the storefront without deleting the asset"
              >
                Unpublish
              </button>
            </div>
            {asset.auto_unpublish_at && (
              <div
                className="text-[10px] text-amber-800 bg-amber-50 border border-amber-200 rounded px-2 py-1 flex items-center gap-1"
                data-testid={`marketing-asset-auto-end-badge-${asset.id}`}
                title="A background job will auto-remove this banner from the storefront at this time"
              >
                <svg className="w-3 h-3 inline" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
                Auto-removes <strong>{new Date(asset.auto_unpublish_at).toLocaleString()}</strong>
              </div>
            )}
          </div>
        )}
        {showPublish ? (
          <div className="mt-3 space-y-2 border-t pt-3">
            <div>
              <Input value={linkUrl} onChange={(e) => setLinkUrl(e.target.value)} placeholder="Click-through URL (optional) — e.g. /shop/collection/roca" className="text-xs" data-testid={`marketing-asset-link-${asset.id}`} />
              {/* 24 May 2026 — collection-targeting helpers. Admins
                  often ask "how do I make the banner go to a specific
                  product range?". Quick-click chips paste the most
                  common targets so they don't have to remember route
                  syntax. Click any chip to populate the input above. */}
              <div className="flex flex-wrap gap-1 mt-1.5">
                <span className="text-[10px] text-slate-500 font-bold uppercase tracking-wider mr-1 self-center">Quick targets:</span>
                {[
                  { label: 'Sale', path: '/tiles?sale=true' },
                  { label: 'Bathroom', path: '/shop/bathroom' },
                  { label: 'Outdoor', path: '/tiles?group=outdoor' },
                  { label: 'Flooring', path: '/tiles?group=flooring' },
                  { label: 'All tiles', path: '/tiles' },
                  { label: 'Clearance', path: '/tiles?clearance=true' },
                ].map((c) => (
                  <button
                    key={c.label}
                    type="button"
                    onClick={() => setLinkUrl(c.path)}
                    className={`text-[10px] px-2 py-0.5 rounded-full border transition ${
                      linkUrl === c.path
                        ? 'bg-emerald-100 border-emerald-400 text-emerald-900 font-bold'
                        : 'bg-slate-100 hover:bg-slate-200 text-slate-700 border-slate-300'
                    }`}
                    data-testid={`marketing-asset-link-preset-${asset.id}-${c.label.toLowerCase().replace(/\s+/g, '-')}`}
                    title={`Send clicks to ${c.path}`}
                  >
                    {c.label}
                  </button>
                ))}
              </div>
              <p className="text-[10px] text-slate-400 mt-1 leading-snug">
                Tip: target a specific collection with <code className="bg-slate-100 px-1 rounded">/shop/collection/&lt;slug&gt;</code> or filter All Tiles with <code className="bg-slate-100 px-1 rounded">/tiles?brand=roca</code>.
              </p>
            </div>
            <Input value={ctaText} onChange={(e) => setCtaText(e.target.value)} placeholder="Hero CTA text (e.g. Shop Now)" className="text-xs" data-testid={`marketing-asset-cta-${asset.id}`} />
            <div>
              <label className="block text-[10px] uppercase tracking-wider text-slate-500 font-bold mb-1">
                Auto-unpublish at <span className="normal-case opacity-70">(optional — banner removes itself at this time)</span>
              </label>
              <Input
                type="datetime-local"
                value={autoUnpublishAt}
                onChange={(e) => setAutoUnpublishAt(e.target.value)}
                className="text-xs"
                data-testid={`marketing-asset-auto-end-${asset.id}`}
              />
              <div className="flex flex-wrap gap-1 mt-1.5">
                {[
                  { label: 'Tonight midnight', when: () => { const d = new Date(); d.setHours(23, 59, 0, 0); return d; } },
                  { label: 'Tomorrow 9am', when: () => { const d = new Date(); d.setDate(d.getDate() + 1); d.setHours(9, 0, 0, 0); return d; } },
                  { label: '+3 days', when: () => { const d = new Date(); d.setDate(d.getDate() + 3); return d; } },
                  { label: '+7 days', when: () => { const d = new Date(); d.setDate(d.getDate() + 7); return d; } },
                  { label: 'Clear', when: null },
                ].map((p) => (
                  <button
                    key={p.label}
                    type="button"
                    onClick={() => {
                      if (!p.when) { setAutoUnpublishAt(''); return; }
                      // datetime-local needs YYYY-MM-DDThh:mm in LOCAL time
                      const d = p.when();
                      const pad = (n) => String(n).padStart(2, '0');
                      setAutoUnpublishAt(`${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`);
                    }}
                    className="text-[10px] px-1.5 py-0.5 rounded-full bg-slate-100 hover:bg-slate-200 text-slate-700 border border-slate-300"
                    data-testid={`marketing-asset-auto-end-preset-${asset.id}-${p.label.toLowerCase().replace(/\s+/g, '-').replace(/\+/g, 'plus')}`}
                  >
                    {p.label}
                  </button>
                ))}
              </div>
            </div>
            <div>
              {/* 24 May 2026 — carousel rotation speed.
                  Only meaningful when ≥2 hero slides are active. We
                  still capture it for single-slide publishes so a future
                  variant inherits the admin's preference. */}
              <label className="block text-[10px] uppercase tracking-wider text-slate-500 font-bold mb-1">
                Carousel rotation speed <span className="normal-case opacity-70">— {rotationSeconds}s between slides</span>
              </label>
              <input
                type="range"
                min="2"
                max="30"
                step="1"
                value={rotationSeconds}
                onChange={(e) => setRotationSeconds(Number(e.target.value))}
                className="w-full accent-yellow-500"
                aria-label="Carousel rotation seconds"
                data-testid={`marketing-asset-rotation-${asset.id}`}
              />
              <div className="flex justify-between text-[10px] text-slate-400 mt-0.5">
                <span>Fast (2s)</span>
                <span>Default (5s)</span>
                <span>Slow (30s)</span>
              </div>
              <div className="flex flex-wrap gap-1 mt-1.5">
                {[3, 5, 7, 10, 15].map((s) => (
                  <button
                    key={s}
                    type="button"
                    onClick={() => setRotationSeconds(s)}
                    className={`text-[10px] px-2 py-0.5 rounded-full border transition ${
                      rotationSeconds === s
                        ? 'bg-yellow-400 border-yellow-500 text-slate-900 font-bold'
                        : 'bg-slate-100 hover:bg-slate-200 text-slate-700 border-slate-300'
                    }`}
                    data-testid={`marketing-asset-rotation-preset-${asset.id}-${s}s`}
                  >
                    {s}s
                  </button>
                ))}
              </div>
            </div>
            {/* 24 May 2026 (v5) — optional portrait-cropped mobile
                variant. Tile Mountain (tilemountain.co.uk) ships a
                separate portrait banner file per slide so phones get a
                full-bleed, tall hero matched to their viewport rather
                than a letterboxed landscape. When EVERY active slide
                has a variant the storefront auto-switches to a tall
                aspect-[3/4] mobile shell — variants fill it
                edge-to-edge with no letterbox bars. Generate variants
                with the "Hero mobile portrait (1080×1440)" preset for
                a perfect fit. */}
            <div>
              <label className="block text-[10px] uppercase tracking-wider text-slate-500 font-bold mb-1">
                Mobile variant <span className="normal-case opacity-70">(recommended — Tile-Mountain-style portrait banner for phones &lt;640px)</span>
              </label>
              <select
                value={mobileVariantId}
                onChange={(e) => setMobileVariantId(e.target.value)}
                className="w-full text-xs border border-slate-300 rounded px-2 py-1.5 bg-white"
                data-testid={`marketing-asset-mobile-variant-${asset.id}`}
              >
                <option value="">— None (use main banner with letterbox) —</option>
                {(mobileVariantOptions || [])
                  .filter((o) => o.id !== asset.id)
                  .map((o) => (
                    <option key={o.id} value={o.id}>
                      {o.label}
                    </option>
                  ))}
              </select>
              {mobileVariantId && (
                <div className="mt-1.5 flex items-center gap-2">
                  <img
                    src={(mobileVariantOptions || []).find((o) => o.id === mobileVariantId)?.preview_url}
                    alt="Mobile variant preview"
                    className="w-12 h-16 object-cover rounded border border-slate-300"
                    data-testid={`marketing-asset-mobile-variant-preview-${asset.id}`}
                  />
                  <span className="text-[10px] text-slate-500 leading-snug">
                    Phones will see this image instead of the landscape banner.
                  </span>
                </div>
              )}
            </div>
            <div className="grid grid-cols-2 gap-1.5">
              <Button size="sm" disabled={busy} onClick={() => publish('homepage_hero')} className="bg-yellow-400 hover:bg-yellow-500 text-slate-900 font-bold text-xs" data-testid={`marketing-asset-publish-hero-${asset.id}`}>
                <Home className="w-3 h-3 mr-1" /> Hero
              </Button>
              <Button size="sm" disabled={busy} onClick={() => publish('promo_banner')} className="bg-emerald-600 hover:bg-emerald-700 text-white font-bold text-xs" data-testid={`marketing-asset-publish-banner-${asset.id}`}>
                <Megaphone className="w-3 h-3 mr-1" /> Banner
              </Button>
            </div>
            <Button size="sm" variant="ghost" onClick={() => setShowPublish(false)} className="text-xs w-full">Cancel</Button>
          </div>
        ) : (
          <div className="mt-3 space-y-1.5">
            <div className="grid grid-cols-2 gap-1.5">
              <Button size="sm" variant="outline" onClick={() => setShowPublish(true)} className="text-xs" data-testid={`marketing-asset-publish-btn-${asset.id}`}>
                <Send className="w-3 h-3 mr-1" /> Publish
              </Button>
              <Button size="sm" variant="ghost" onClick={() => onDelete(asset.id)} className="text-xs text-red-600 hover:bg-red-50" data-testid={`marketing-asset-delete-${asset.id}`}>
                <Trash2 className="w-3 h-3 mr-1" /> Delete
              </Button>
            </div>
            {/* Regenerate-with-safe-zone — only for banners that
                weren't already regenerated. Triggers a server-side
                re-run with the new text-protection rules; archives
                the old one and hot-swaps the storefront placement
                if live. */}
            {!isRegenerated && asset.asset_kind === 'banner' && (
              <Button
                size="sm"
                variant="outline"
                onClick={regenerate}
                disabled={regenerating}
                className="text-xs w-full bg-indigo-50 border-indigo-300 text-indigo-800 hover:bg-indigo-100 font-semibold"
                data-testid={`marketing-asset-regenerate-${asset.id}`}
                title="Re-run this prompt with the new safe-zone rules. Fixes banners whose text got chopped in the top/bottom."
              >
                {regenerating ? <Loader2 className="w-3 h-3 mr-1 animate-spin" /> : <Wand2 className="w-3 h-3 mr-1" />}
                {regenerating ? 'Regenerating…' : 'Regenerate (protect text)'}
              </Button>
            )}
          </div>
        )}
      </div>
    </Card>
  );
};

// --- Asset lightbox -------------------------------------------------

const AssetLightbox = ({ asset, onClose }) => {
  // ESC closes the lightbox; arrow keys could be added later for prev/next.
  useEffect(() => {
    if (!asset) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    document.body.style.overflow = 'hidden';  // lock scroll while open
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = '';
    };
  }, [asset, onClose]);

  if (!asset) return null;
  const fullUrl = asset.image_url?.startsWith('http') ? asset.image_url : `${API}${asset.image_url}`;

  const downloadAsset = async () => {
    // Primary path: fetch the image as a blob and serve it from a
    // same-origin `blob:` URL. This works BOTH same-origin and
    // cross-origin (prod `tilestation.co.uk` → Railway backend) as long
    // as the backend returns CORS headers, which it does. The blob URL
    // is same-origin by definition, so `<a download>` always respects
    // the filename hint and always forces a real "Save As" regardless
    // of the original response's Content-Type.
    //
    // Fallback path: if the blob fetch fails (CORS misconfigured on
    // prod, offline, etc.), we fall back to a plain anchor navigation
    // to the `?download=1` URL. The backend sends
    // `Content-Disposition: attachment` which forces a download even
    // cross-origin — the only downside is the browser uses the
    // server-supplied filename instead of our pretty one.
    const sep = fullUrl.includes('?') ? '&' : '?';
    const dlUrl = `${fullUrl}${sep}download=1`;
    const filename = `tilestation-banner-${asset.id}.png`;

    let blobUrl = null;
    try {
      const r = await fetch(dlUrl, { cache: 'no-store' });
      if (!r.ok) {
        toast.error(`Image file missing from storage (HTTP ${r.status}). The asset metadata exists but the image itself is gone — try re-generating.`);
        return;
      }
      const blob = await r.blob();
      if (!blob || blob.size === 0) {
        toast.error('Image came back empty from the server.');
        return;
      }
      blobUrl = URL.createObjectURL(blob);
    } catch (_err) {
      // CORS or network error — fall through to plain navigation.
      // The server's Content-Disposition: attachment header will
      // still force the browser to save rather than render inline.
    }

    const a = document.createElement('a');
    a.href = blobUrl || dlUrl;
    a.download = filename;
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    a.remove();
    if (blobUrl) {
      // Give the browser a tick to start the download before we
      // revoke the object URL (otherwise Safari + older Chrome can
      // cancel the in-flight save).
      setTimeout(() => URL.revokeObjectURL(blobUrl), 2000);
    }
    toast.success('Download started');
  };

  return (
    <div
      className="fixed inset-0 z-[10000] bg-black/90 backdrop-blur-sm flex flex-col"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
      data-testid="marketing-asset-lightbox"
    >
      {/* Top bar */}
      <div className="flex items-center justify-between gap-3 px-4 py-3 text-white text-sm border-b border-white/10">
        <div className="min-w-0 flex-1">
          <div className="text-[10px] uppercase tracking-wider opacity-70 font-bold">
            {asset.model} · {asset.width}×{asset.height} · ${asset.cost_usd}
          </div>
          <div className="text-xs opacity-90 truncate" title={asset.prompt}>{asset.prompt}</div>
        </div>
        <Button
          size="sm"
          variant="outline"
          onClick={downloadAsset}
          className="bg-white/10 border-white/30 text-white hover:bg-white/20"
          data-testid="marketing-asset-lightbox-download"
        >
          <Download className="w-4 h-4 mr-1" /> Download
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={() => {
            // Send the prompt into Video Studio. Landscape banners → hd
            // preset (landscape 1280x720 on sora-2, cheapest). Tall
            // portrait banners → vertical 9:16 preset (sora-2-pro).
            const aspect = (asset.width || 1) / Math.max(1, (asset.height || 1));
            const preset = aspect < 0.8 ? 'vertical' : (aspect > 2 ? 'widescreen' : 'hd');
            // Rewrap the prompt with a motion intent — Sora needs a
            // camera/motion description, not just a still-image prompt.
            const videoPrompt = `Slow 4-second cinematic camera push-in. ${asset.prompt?.slice(0, 900) || ''} Magazine-quality colour grade, subtle depth-of-field, no overlay text — the still banner has text; the video is purely environmental B-roll.`;
            const q = new URLSearchParams({
              prompt: videoPrompt,
              preset,
              source_asset_id: asset.id,
            }).toString();
            window.location.href = `/admin/marketing-studio/videos?${q}`;
          }}
          className="bg-white/10 border-white/30 text-white hover:bg-white/20"
          data-testid="marketing-asset-lightbox-remix-video"
          title="Use this banner's prompt as the starting point for a Sora 2 video in Video Studio"
        >
          <Video className="w-4 h-4 mr-1" /> Remix to video
        </Button>
        <button
          type="button"
          onClick={onClose}
          className="p-2 rounded-full hover:bg-white/10 text-white"
          data-testid="marketing-asset-lightbox-close"
          aria-label="Close"
        >
          <X className="w-5 h-5" />
        </button>
      </div>

      {/* Image — contained, never bigger than viewport. Click in the
          padded letterbox area (around the image but not on it) closes
          the lightbox; click on the <img> itself does NOT close, so users
          can interact with the photo without dismissing it. */}
      <div
        className="flex-1 flex items-center justify-center p-4 overflow-auto"
        onClick={onClose}
        data-testid="marketing-asset-lightbox-backdrop"
      >
        <img
          src={fullUrl}
          alt={asset.prompt?.slice(0, 80)}
          onClick={(e) => e.stopPropagation()}
          className="max-w-full max-h-full object-contain shadow-2xl"
          style={{ minWidth: 0, minHeight: 0 }}
        />
      </div>

      <div className="text-center text-[10px] text-white/50 pb-3">
        ESC or click outside to close
      </div>
    </div>
  );
};

// --- Main page ------------------------------------------------------

const MarketingStudio = () => {
  const [prompt, setPrompt] = useState(DEFAULT_PROMPT);
  const [model, setModel] = useState('nano-banana');
  const [presetKey, setPresetKey] = useState('hero');
  const [busy, setBusy] = useState(false);
  const [numVariants, setNumVariants] = useState(1);

  const [assets, setAssets] = useState([]);
  const [stats, setStats] = useState(null);
  const [filter, setFilter] = useState('all');
  const [promoBanner, setPromoBanner] = useState(null);
  const [savingBanner, setSavingBanner] = useState(false);
  const [lightboxAsset, setLightboxAsset] = useState(null);  // asset currently shown in full-screen lightbox
  const [showSchedule, setShowSchedule] = useState(false);
  const [scheduleStart, setScheduleStart] = useState('');
  const [scheduleEnd, setScheduleEnd] = useState('');
  const [savingSchedule, setSavingSchedule] = useState(false);

  // Refine preview — runs cheap text LLM (~£0.0001) to predict what the
  // banner will look like and flag issues BEFORE the admin spends money
  // on an actual image render.
  const [refining, setRefining] = useState(false);
  const [preview, setPreview] = useState(null);  // {predicted, warnings, refined_prompt}

  // Lifestyle generator state
  const [showLifestyle, setShowLifestyle] = useState(false);
  const [lifestyleTileId, setLifestyleTileId] = useState('');
  const [lifestyleTileSearch, setLifestyleTileSearch] = useState('');
  const [lifestyleTileResults, setLifestyleTileResults] = useState([]);
  const [lifestyleTilePicked, setLifestyleTilePicked] = useState(null);
  const [lifestyleRoom, setLifestyleRoom] = useState('bathroom');
  const [lifestyleNotes, setLifestyleNotes] = useState('');
  const [lifestyleVariants, setLifestyleVariants] = useState(2);
  const [generatingLifestyle, setGeneratingLifestyle] = useState(false);

  const preset = useMemo(() => PRESETS.find((p) => p.key === presetKey) || PRESETS[0], [presetKey]);

  const fetchAll = async () => {
    try {
      const [a, s, b] = await Promise.all([
        axios.get(`${API}/api/admin/marketing-studio/assets?kind=${filter}`, { headers: tokenHdr() }),
        axios.get(`${API}/api/admin/marketing-studio/stats`, { headers: tokenHdr() }),
        axios.get(`${API}/api/admin/marketing-studio/promo-banner`, { headers: tokenHdr() }),
      ]);
      setAssets(a.data.assets || []);
      setStats(s.data);
      setPromoBanner(b.data);
      setScheduleStart(b.data?.scheduled_start ? String(b.data.scheduled_start).slice(0, 16) : '');
      setScheduleEnd(b.data?.scheduled_end ? String(b.data.scheduled_end).slice(0, 16) : '');
    } catch (e) {
      toast.error(e?.response?.data?.detail || 'Could not load Marketing Studio');
    }
  };

  useEffect(() => { fetchAll(); /* eslint-disable-next-line */ }, [filter]);

  const generate = async () => {
    if (prompt.trim().length < 10) {
      toast.error('Prompt is too short — describe the banner in detail');
      return;
    }
    setBusy(true);
    try {
      const r = await axios.post(`${API}/api/admin/marketing-studio/generate`, {
        prompt,
        model,
        width: preset.w,
        height: preset.h,
        preset: preset.key,
        asset_kind: preset.kind,
        num_variants: numVariants,
      }, { headers: tokenHdr(), timeout: 180000 });
      const newAssets = r.data.assets || (r.data.asset ? [r.data.asset] : []);
      const failed = r.data.failed || [];
      if (newAssets.length > 1) {
        toast.success(`${newAssets.length} variants ready — pick your favourite from the gallery`);
      } else {
        toast.success(`${model === 'nano-banana' ? 'Nano Banana' : 'GPT Image 1'} render complete`);
      }
      if (failed.length > 0) {
        toast.warning(`${failed.length} of ${numVariants} variants failed — only successful ones saved`);
      }
      setAssets((p) => [...newAssets, ...p]);
      setPreview(null);
      fetchAll();
    } catch (e) {
      toast.error(e?.response?.data?.detail || 'Generation failed — try again');
    } finally {
      setBusy(false);
    }
  };

  const refinePrompt = async () => {
    if (prompt.trim().length < 10) {
      toast.error('Add more detail to your prompt before refining');
      return;
    }
    setRefining(true);
    try {
      const r = await axios.post(`${API}/api/admin/marketing-studio/refine-prompt`, {
        prompt,
        model,
        width: preset.w,
        height: preset.h,
      }, { headers: tokenHdr(), timeout: 30000 });
      setPreview(r.data);
      toast.success('Preview ready — review before paying for the image');
    } catch (e) {
      toast.error(e?.response?.data?.detail || 'Refinement failed');
    } finally {
      setRefining(false);
    }
  };

  const acceptRefined = () => {
    if (preview?.refined_prompt) {
      setPrompt(preview.refined_prompt);
      toast.success('Refined prompt applied — click Generate when ready');
      setPreview(null);
    }
  };

  // --- Lifestyle generator helpers ---
  const searchLifestyleTiles = async () => {
    if (!lifestyleTileSearch.trim()) {
      setLifestyleTileResults([]);
      return;
    }
    try {
      const r = await axios.get(
        `${API}/api/tiles/search?q=${encodeURIComponent(lifestyleTileSearch.trim())}&limit=8`,
        { headers: tokenHdr() },
      );
      const list = r.data?.results || r.data || [];
      setLifestyleTileResults(Array.isArray(list) ? list : []);
    } catch (_e) {
      setLifestyleTileResults([]);
    }
  };

  const generateLifestyle = async () => {
    if (!lifestyleTilePicked?.id && !lifestyleTileId) {
      toast.error('Pick a tile first');
      return;
    }
    setGeneratingLifestyle(true);
    try {
      const r = await axios.post(`${API}/api/admin/marketing-studio/lifestyle`, {
        tile_id: lifestyleTilePicked?.id || lifestyleTileId,
        room_type: lifestyleRoom,
        style_notes: lifestyleNotes || null,
        width: 1024,
        height: 1024,
        num_variants: lifestyleVariants,
      }, { headers: tokenHdr(), timeout: 240000 });
      const newAssets = r.data.assets || [];
      toast.success(`Generated ${newAssets.length} lifestyle variant${newAssets.length === 1 ? '' : 's'}`);
      setAssets((p) => [...newAssets, ...p]);
      fetchAll();
    } catch (e) {
      toast.error(e?.response?.data?.detail || 'Lifestyle generation failed');
    } finally {
      setGeneratingLifestyle(false);
    }
  };

  const publish = async (assetId, placement, extra) => {
    try {
      await axios.post(`${API}/api/admin/marketing-studio/assets/${assetId}/publish`, {
        placement,
        link_url: extra?.link_url || '',
        cta_text: extra?.cta_text || '',
        auto_unpublish_at: extra?.auto_unpublish_at || null,
        rotation_seconds: extra?.rotation_seconds || null,
        mobile_image_url: extra?.mobile_image_url || null,
      }, { headers: tokenHdr() });
      const scheduleNote = extra?.auto_unpublish_at
        ? ` · auto-removes ${new Date(extra.auto_unpublish_at).toLocaleString()}`
        : '';
      toast.success(`Published to ${placement.replace('_', ' ')} ✓${scheduleNote}`);
      fetchAll();
    } catch (e) {
      toast.error(e?.response?.data?.detail || 'Publish failed');
    }
  };

  const removeAsset = async (assetId) => {
    const asset = assets.find((a) => a.id === assetId);
    const wasPublished = !!asset?.published_to;
    const confirmMsg = wasPublished
      ? `Delete this asset? It's currently published as ${asset.published_to.replace('_', ' ')} — deleting will REMOVE it from the storefront immediately. This cannot be undone.`
      : 'Delete this asset? This cannot be undone.';
    if (!window.confirm(confirmMsg)) return;
    try {
      const r = await axios.delete(`${API}/api/admin/marketing-studio/assets/${assetId}`, { headers: tokenHdr() });
      if (r.data?.unpublished_from) {
        toast.success(`Deleted — and removed from ${r.data.unpublished_from.replace('_', ' ')} on the storefront`);
        // Refresh promo banner state if it was the active banner
        if (r.data.unpublished_from === 'promo_banner') {
          setPromoBanner((p) => p ? { ...p, enabled: false } : p);
        }
      } else {
        toast.success('Deleted');
      }
      setAssets((p) => p.filter((a) => a.id !== assetId));
    } catch (e) {
      toast.error(e?.response?.data?.detail || 'Delete failed');
    }
  };

  const unpublishAsset = async (assetId, placement) => {
    const friendly = (placement || '').replace('_', ' ');
    if (!window.confirm(`Remove this asset from ${friendly} on the storefront? You can re-publish it again any time.`)) return;
    try {
      await axios.post(`${API}/api/admin/marketing-studio/assets/${assetId}/unpublish`, null, { headers: tokenHdr() });
      toast.success(`Removed from ${friendly} — storefront updates within 15 seconds`);
      setAssets((p) => p.map((a) => a.id === assetId ? { ...a, published_to: null } : a));
      if (placement === 'promo_banner') {
        setPromoBanner((b) => b ? { ...b, enabled: false } : b);
      }
    } catch (e) {
      toast.error(e?.response?.data?.detail || 'Unpublish failed');
    }
  };

  const regenerateAsset = async (asset) => {
    try {
      const r = await axios.post(
        `${API}/api/admin/marketing-studio/regenerate/${asset.id}`,
        {},
        { headers: tokenHdr() },
      );
      // Swap the card in-place: the old asset disappears (superseded)
      // and the new one takes its slot at the top of the list.
      setAssets((prev) => {
        const filtered = prev.filter((a) => a.id !== asset.id);
        return [r.data.new, ...filtered];
      });
      const friendly = r.data.swapped
        ? `Regenerated — storefront hot-swapped to the new ${r.data.placement?.replace('_', ' ')} automatically`
        : 'Regenerated — old banner archived, new one ready';
      toast.success(friendly);
    } catch (e) {
      toast.error(e?.response?.data?.detail || 'Regenerate failed');
    }
  };

  const togglePromoBanner = async () => {
    setSavingBanner(true);
    try {
      const r = await axios.put(`${API}/api/admin/marketing-studio/promo-banner`, {
        enabled: !promoBanner?.enabled,
      }, { headers: tokenHdr() });
      setPromoBanner(r.data);
      toast.success(r.data.enabled ? 'Promo banner ON — visible site-wide' : 'Promo banner OFF');
    } catch (e) {
      toast.error(e?.response?.data?.detail || 'Could not toggle banner');
    } finally {
      setSavingBanner(false);
    }
  };

  const saveSchedule = async (clear = false) => {
    setSavingSchedule(true);
    try {
      const payload = clear
        ? { schedule_enabled: false, scheduled_start: '', scheduled_end: '' }
        : {
            schedule_enabled: true,
            // Datetime-local inputs return e.g. 2026-05-23T19:00 — we tag with
            // user's local timezone offset so the server interprets correctly.
            scheduled_start: new Date(scheduleStart).toISOString(),
            scheduled_end: new Date(scheduleEnd).toISOString(),
          };
      if (!clear) {
        if (!scheduleStart || !scheduleEnd) {
          toast.error('Pick both a start and an end time');
          return;
        }
        if (new Date(scheduleStart) >= new Date(scheduleEnd)) {
          toast.error('End time must be after start time');
          return;
        }
      }
      const r = await axios.put(`${API}/api/admin/marketing-studio/promo-banner`, payload, { headers: tokenHdr() });
      setPromoBanner(r.data);
      if (clear) {
        setScheduleStart(''); setScheduleEnd('');
        toast.success('Schedule cleared — banner now follows the manual on/off toggle');
      } else {
        toast.success('Scheduled — banner will auto-flip on/off');
      }
    } catch (e) {
      toast.error(e?.response?.data?.detail || 'Could not save schedule');
    } finally {
      setSavingSchedule(false);
    }
  };

  return (
    <div className="p-6 max-w-7xl mx-auto" data-testid="marketing-studio-page">
      <div className="mb-6 flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-3xl font-bold text-slate-900 flex items-center gap-2">
            <Wand2 className="w-7 h-7 text-yellow-500" /> Marketing Studio
          </h1>
          <p className="text-sm text-slate-600 mt-1 max-w-2xl">
            Generate banners with AI, save them to your gallery, and publish to the homepage hero or as a site-wide promo banner with one click.
          </p>
        </div>
        <div className="flex gap-2 flex-wrap">
          <Button
            variant="outline"
            size="sm"
            onClick={() => window.open('/admin/marketing-studio/videos', '_self')}
            className="border-indigo-300 text-indigo-800 hover:bg-indigo-50 font-bold"
            data-testid="marketing-studio-video-studio-btn"
            title="Generate short social-media videos with Sora 2"
          >
            <Video className="w-4 h-4 mr-1" /> Video Studio
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={async () => {
              toast.message('Probing R2 storage — this takes ~10-30s…');
              try {
                const r = await axios.post(`${API}/api/admin/marketing-studio/verify-storage`,
                  null, { params: { dry_run: true }, headers: tokenHdr(), timeout: 120000 });
                const s = r.data?.summary || {};
                const missing = r.data?.missing_assets || [];
                const wouldMark = s.would_mark_count || 0;
                if (s.missing_count === 0) {
                  toast.success(`All ${s.probed_count} assets healthy — no missing files.`);
                  return;
                }
                const preview = missing.slice(0, 5).map((m) => `  • ${(m.prompt || '').slice(0, 60)}${m.skip_reason ? ` — PROTECTED: ${m.skip_reason}` : ''}`).join('\n');
                const body = [
                  `Probed ${s.probed_count} assets.`,
                  `${s.ok_count} healthy · ${s.missing_count} missing from R2 storage.`,
                  '',
                  `${wouldMark} would be auto-marked as orphan (safety rails passed).`,
                  `${s.missing_count - wouldMark} are missing but PROTECTED (published, recent, or linked to a hero slide).`,
                  '',
                  'First 5 missing assets:',
                  preview || '  (none)',
                  '',
                  wouldMark > 0
                    ? `Soft-delete the ${wouldMark} orphan${wouldMark !== 1 ? 's' : ''} now? (Recoverable — nothing is ever hard-deleted; audit log saved.)`
                    : 'Nothing to delete — everything missing is safety-protected.',
                ].join('\n');
                if (wouldMark === 0) { window.alert(body); return; }
                if (!window.confirm(body)) return;
                const r2 = await axios.post(`${API}/api/admin/marketing-studio/verify-storage`,
                  null, { params: { dry_run: false }, headers: tokenHdr(), timeout: 120000 });
                const marked = r2.data?.summary?.marked || 0;
                toast.success(`Soft-deleted ${marked} orphan asset${marked !== 1 ? 's' : ''}. Audit log saved — use the restore endpoint to undo.`);
                fetchAll();
              } catch (e) {
                toast.error(e?.response?.data?.detail || 'Storage probe failed');
              }
            }}
            className="border-purple-300 text-purple-800 hover:bg-purple-50"
            data-testid="marketing-studio-verify-storage-btn"
            title="Probe every asset's R2 blob — preview first, then soft-delete only assets missing for 48h+"
          >
            <FileSearch className="w-4 h-4 mr-1" /> Verify storage
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={async () => {
              const txt = window.prompt(
                'Delete every homepage carousel slide whose title, badge, or subtitle contains this text (case-insensitive). Use this to surgically remove a rogue slide you can see on the live site.\n\nExamples: BANK HOLIDAY · BIG SALE · SPRING\n\nMin 3 characters.',
                'BANK HOLIDAY',
              );
              if (!txt || txt.trim().length < 3) return;
              try {
                const r = await axios.post(
                  `${API}/api/admin/marketing-studio/delete-hero-slide-by-text`,
                  { match: txt.trim() }, { headers: tokenHdr() },
                );
                const n = r.data?.removed_count ?? 0;
                if (n === 0) {
                  toast.message(`No slides found matching "${txt}". The carousel may already be clean.`);
                } else {
                  toast.success(`Removed ${n} slide${n > 1 ? 's' : ''} matching "${txt}". Storefront updates within 1-2 seconds.`);
                }
              } catch (e) {
                toast.error(e?.response?.data?.detail || 'Delete failed');
              }
            }}
            className="border-red-300 text-red-800 hover:bg-red-50 font-bold"
            data-testid="marketing-studio-delete-slide-by-text-btn"
            title="Type some text from a rogue slide on the live site (e.g. BANK HOLIDAY) and it'll be removed from the carousel"
          >
            <AlertTriangle className="w-4 h-4 mr-1" /> Delete slide by text
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={async () => {
              if (!window.confirm('Scan the homepage carousel and remove any slide whose marketing-studio asset has been deleted or unpublished? Use this when a banner you deleted is still showing on the live homepage.')) return;
              try {
                const r = await axios.post(`${API}/api/admin/marketing-studio/cleanup-orphan-hero-slides`, null, { headers: tokenHdr() });
                const n = r.data?.removed_count ?? 0;
                if (n === 0) toast.message('No orphan slides found — the carousel is clean.');
                else toast.success(`Removed ${n} orphan slide${n > 1 ? 's' : ''} from the homepage carousel`);
              } catch (e) {
                toast.error(e?.response?.data?.detail || 'Cleanup failed');
              }
            }}
            className="border-amber-300 text-amber-800 hover:bg-amber-50"
            data-testid="marketing-studio-cleanup-orphans-btn"
            title="Removes hero carousel slides whose Marketing Studio asset was deleted or unpublished"
          >
            <AlertTriangle className="w-4 h-4 mr-1" /> Cleanup orphan slides
          </Button>
          <Button variant="outline" size="sm" onClick={fetchAll} data-testid="marketing-studio-refresh-btn">
            <RefreshCw className="w-4 h-4 mr-1" /> Refresh
          </Button>
        </div>
      </div>

      {/* Stats */}
      {stats && (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-6">
          <Card className="p-3">
            <div className="text-[10px] uppercase tracking-wide text-slate-500 font-bold flex items-center gap-1">
              <Layers className="w-3 h-3" /> Total assets
            </div>
            <div className="text-xl font-bold mt-0.5">{stats.total_assets}</div>
          </Card>
          <Card className="p-3" data-testid="marketing-mtd-spend-card">
            <div className="text-[10px] uppercase tracking-wide text-slate-500 font-bold flex items-center gap-1">
              <PoundSterling className="w-3 h-3" /> {stats.month_to_date?.month_label || 'This month'}
            </div>
            <div className="text-xl font-bold mt-0.5">${stats.month_to_date?.spend_usd ?? 0}</div>
            <div className="text-[10px] text-slate-500">
              ≈ £{stats.month_to_date?.spend_gbp_estimate ?? 0} · {stats.month_to_date?.render_count ?? 0} renders
            </div>
          </Card>
          <Card className="p-3 bg-gradient-to-br from-yellow-50 to-amber-50 border-amber-200" data-testid="marketing-balance-card">
            <div className="text-[10px] uppercase tracking-wide text-amber-800 font-bold flex items-center gap-1">
              <Zap className="w-3 h-3" /> Universal Key
            </div>
            <div className="text-[11px] text-slate-600 mt-1 leading-tight">
              Live balance not exposed via API.
            </div>
            <a
              href="https://app.emergent.sh/profile"
              target="_blank"
              rel="noreferrer"
              className="mt-1.5 inline-flex items-center gap-1 text-[11px] font-bold text-amber-900 hover:text-amber-700 underline underline-offset-2"
              data-testid="marketing-balance-link"
            >
              Check on profile <ExternalLink className="w-3 h-3" />
            </a>
          </Card>
          <Card className="p-3" data-testid="marketing-promo-card">
            <div className="text-[10px] uppercase tracking-wide text-slate-500 font-bold flex items-center gap-1">
              <Sparkles className="w-3 h-3" /> Promo banner
            </div>
            <div className="mt-1 flex items-center gap-2 mb-1">
              <span className={`text-xs font-bold px-2 py-0.5 rounded ${promoBanner?._now_visible ? 'bg-emerald-100 text-emerald-800' : 'bg-slate-100 text-slate-600'}`}>
                {promoBanner?._now_visible ? 'Visible' : 'Hidden'}
              </span>
              <Button size="sm" variant="outline" onClick={togglePromoBanner} disabled={savingBanner || !promoBanner?.image_url} className="text-xs" data-testid="marketing-promo-toggle-btn">
                {savingBanner ? <Loader2 className="w-3 h-3 animate-spin" /> : (promoBanner?.enabled ? 'Turn off' : 'Turn on')}
              </Button>
            </div>
            <button
              type="button"
              onClick={() => setShowSchedule((p) => !p)}
              className="text-[10px] font-bold text-amber-700 hover:text-amber-900 underline underline-offset-2"
              data-testid="marketing-promo-schedule-toggle"
            >
              {showSchedule ? 'Hide schedule' : 'Schedule a window…'}
            </button>
          </Card>
        </div>
      )}

      {/* Schedule editor — auto-flip the promo banner on/off in a window */}
      {showSchedule && (
        <Card className="p-5 mb-6 border-2 border-amber-300 bg-amber-50" data-testid="marketing-schedule-card">
          <h2 className="text-lg font-bold text-amber-900 mb-1 flex items-center gap-2">
            <Sparkles className="w-5 h-5" /> Schedule the promo banner
          </h2>
          <p className="text-xs text-slate-700 mb-3">
            Pick a start and end time and the banner will flip ON automatically at the start and OFF at the end. Perfect for weekend sales and bank holidays — set it Friday morning, sleep at night, banner does its thing.
          </p>
          <div className="grid sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-bold text-slate-700 mb-1">Start (your local time)</label>
              <Input
                type="datetime-local"
                value={scheduleStart}
                onChange={(e) => setScheduleStart(e.target.value)}
                data-testid="marketing-schedule-start"
              />
            </div>
            <div>
              <label className="block text-xs font-bold text-slate-700 mb-1">End (your local time)</label>
              <Input
                type="datetime-local"
                value={scheduleEnd}
                onChange={(e) => setScheduleEnd(e.target.value)}
                data-testid="marketing-schedule-end"
              />
            </div>
          </div>
          <div className="flex items-center gap-2 mt-3 flex-wrap">
            <Button onClick={() => saveSchedule(false)} disabled={savingSchedule} className="bg-emerald-600 hover:bg-emerald-700 text-white font-bold" data-testid="marketing-schedule-save-btn">
              {savingSchedule ? <Loader2 className="w-4 h-4 animate-spin mr-1" /> : null}
              Save schedule
            </Button>
            {(promoBanner?.schedule_enabled || promoBanner?.scheduled_start) && (
              <Button onClick={() => saveSchedule(true)} disabled={savingSchedule} variant="outline" className="border-slate-300" data-testid="marketing-schedule-clear-btn">
                Clear schedule
              </Button>
            )}
          </div>
          {promoBanner?.schedule_enabled && promoBanner?.scheduled_start && promoBanner?.scheduled_end && (
            <div className="mt-3 text-xs bg-white rounded p-2 border border-amber-200">
              <span className="font-bold text-amber-900">Active schedule:</span>{' '}
              {new Date(promoBanner.scheduled_start).toLocaleString()} → {new Date(promoBanner.scheduled_end).toLocaleString()}
              {promoBanner._now_visible && <span className="ml-2 text-emerald-700 font-bold">· LIVE NOW</span>}
            </div>
          )}
        </Card>
      )}

      {/* Generator */}
      <Card className="p-5 mb-6" data-testid="marketing-studio-generator">
        <h2 className="text-lg font-bold text-slate-900 mb-3 flex items-center gap-2">
          <Wand2 className="w-5 h-5 text-yellow-500" /> Generate a new banner
        </h2>
        <div className="grid lg:grid-cols-4 gap-3 mb-3">
          <div>
            <label className="block text-xs font-bold text-slate-700 mb-1">Model</label>
            <select value={model} onChange={(e) => setModel(e.target.value)} className="w-full border border-slate-300 rounded px-2 py-1.5 text-sm" data-testid="marketing-model-select">
              {MODELS.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
            </select>
          </div>
          <div>
            <label className="block text-xs font-bold text-slate-700 mb-1">Size preset</label>
            <select value={presetKey} onChange={(e) => setPresetKey(e.target.value)} className="w-full border border-slate-300 rounded px-2 py-1.5 text-sm" data-testid="marketing-preset-select">
              {PRESETS.map((p) => <option key={p.key} value={p.key}>{p.label}</option>)}
            </select>
          </div>
          <div>
            <label className="block text-xs font-bold text-slate-700 mb-1">How many?</label>
            <select value={numVariants} onChange={(e) => setNumVariants(Number(e.target.value))} className="w-full border border-slate-300 rounded px-2 py-1.5 text-sm" data-testid="marketing-variants-select">
              <option value={1}>1 render</option>
              <option value={2}>2 variants (compare)</option>
              <option value={4}>4 variants (best of)</option>
            </select>
          </div>
          <div className="flex items-end gap-2">
            <Button
              onClick={refinePrompt}
              disabled={refining || busy}
              variant="outline"
              className="border-slate-300 font-semibold"
              data-testid="marketing-refine-btn"
              title="Free preview — uses cheap text AI (~£0.0001) to predict the result"
            >
              {refining ? <><Loader2 className="w-4 h-4 animate-spin mr-1" /> Previewing…</> : <><FileSearch className="w-4 h-4 mr-1" /> Free preview</>}
            </Button>
            <Button onClick={generate} disabled={busy || refining} className="flex-1 bg-gradient-to-r from-amber-400 to-yellow-500 hover:from-amber-500 hover:to-yellow-600 text-slate-900 font-bold" data-testid="marketing-generate-btn">
              {busy ? <><Loader2 className="w-4 h-4 animate-spin mr-1" /> Generating… (~30s)</> : <><Sparkles className="w-4 h-4 mr-1" /> Generate (£{((model === 'nano-banana' ? 0.04 : 0.10) * numVariants).toFixed(2)})</>}
            </Button>
          </div>
        </div>
        <label className="block text-xs font-bold text-slate-700 mb-1">Prompt</label>
        <Textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          rows={5}
          className="text-sm"
          data-testid="marketing-prompt-input"
        />
        <div className="text-[11px] text-slate-500 mt-2">
          Tip: include the headline text in quotes ("Bank Holiday Sale — Up to 30% off"), the brand colour (#F7EA1C gold), and the room/style. Mention sharp text, magazine photography for best results.
          <span className="ml-1 text-slate-700 font-semibold">Click "Free preview" first to refine your prompt without spending money.</span>
        </div>
      </Card>

      {/* Free preview — text LLM prediction before paid render */}
      {preview && (
        <Card className="p-5 mb-6 border-2 border-amber-300 bg-amber-50" data-testid="marketing-preview-card">
          <div className="flex items-start justify-between gap-3 mb-3 flex-wrap">
            <h2 className="text-lg font-bold text-amber-900 flex items-center gap-2">
              <FileSearch className="w-5 h-5" /> Free preview — what your banner will likely show
            </h2>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setPreview(null)}
              className="text-slate-600 text-xs"
              data-testid="marketing-preview-dismiss"
            >Dismiss</Button>
          </div>
          <div className="bg-white rounded-lg p-3 border border-amber-200 mb-3">
            <div className="text-[10px] uppercase tracking-wider font-bold text-slate-500 mb-1">Predicted result</div>
            <div className="text-sm text-slate-800" data-testid="marketing-preview-predicted">{preview.predicted}</div>
          </div>
          {preview.warnings && preview.warnings.length > 0 && (
            <div className="bg-white rounded-lg p-3 border border-amber-200 mb-3" data-testid="marketing-preview-warnings">
              <div className="text-[10px] uppercase tracking-wider font-bold text-amber-700 mb-1 flex items-center gap-1">
                <AlertTriangle className="w-3 h-3" /> Warnings
              </div>
              <ul className="list-disc list-inside text-sm text-slate-800 space-y-0.5">
                {preview.warnings.map((w, i) => <li key={i}>{w}</li>)}
              </ul>
            </div>
          )}
          {preview.refined_prompt && preview.refined_prompt !== prompt && (
            <div className="bg-white rounded-lg p-3 border border-amber-200">
              <div className="text-[10px] uppercase tracking-wider font-bold text-emerald-700 mb-1">Refined prompt (suggested)</div>
              <div className="text-xs text-slate-800 italic mb-2" data-testid="marketing-preview-refined">"{preview.refined_prompt}"</div>
              <Button
                size="sm"
                onClick={acceptRefined}
                className="bg-emerald-600 hover:bg-emerald-700 text-white font-bold"
                data-testid="marketing-preview-accept-btn"
              >
                <Check className="w-4 h-4 mr-1" /> Use refined prompt
              </Button>
            </div>
          )}
          <div className="text-[11px] text-slate-600 mt-3">
            ✨ This preview cost roughly £0.0001 — refine the prompt as many times as you like before paying for the actual image.
          </div>
        </Card>
      )}

      {/* Lifestyle from a tile — multi-image reference */}
      <Card className="p-5 mb-6" data-testid="marketing-lifestyle-card">
        <div className="flex items-start justify-between gap-3 mb-1 flex-wrap">
          <h2 className="text-lg font-bold text-slate-900 flex items-center gap-2">
            <ImageIcon className="w-5 h-5 text-emerald-500" /> Lifestyle photo from a tile
          </h2>
          <Button size="sm" variant="outline" onClick={() => setShowLifestyle((p) => !p)} data-testid="marketing-lifestyle-toggle">
            {showLifestyle ? 'Hide' : 'Use a real catalogue tile →'}
          </Button>
        </div>
        <p className="text-xs text-slate-500 mb-3">
          Pick any tile from your catalogue and Nano Banana drops it into a luxury bathroom / kitchen / hallway / shower scene using the actual product photo as a reference. Perfect for product detail pages, lookbooks, and "shop the look" social posts.
        </p>
        {showLifestyle && (
          <div className="space-y-3">
            <div>
              <label className="block text-xs font-bold text-slate-700 mb-1">Search your tile catalogue</label>
              <div className="flex gap-2">
                <Input
                  value={lifestyleTileSearch}
                  onChange={(e) => setLifestyleTileSearch(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') searchLifestyleTiles(); }}
                  placeholder="Onyx, Carrara, Brushed Oak…"
                  className="text-sm"
                  data-testid="marketing-lifestyle-tile-search"
                />
                <Button size="sm" onClick={searchLifestyleTiles} variant="outline" className="border-slate-300" data-testid="marketing-lifestyle-tile-search-btn">
                  Search
                </Button>
              </div>
              {lifestyleTileResults.length > 0 && (
                <div className="mt-2 grid grid-cols-2 sm:grid-cols-4 gap-2 max-h-72 overflow-y-auto border border-slate-200 rounded-lg p-2">
                  {lifestyleTileResults.map((t, idx) => {
                    const tileKey = t.id || t._id || t.slug || `tile-${idx}`;
                    const img = (Array.isArray(t.images) && t.images[0])
                      ? (typeof t.images[0] === 'string' ? t.images[0] : t.images[0].url)
                      : (t.image || '');
                    const picked = lifestyleTilePicked?.id === (t.id || t._id);
                    return (
                      <button
                        key={tileKey}
                        type="button"
                        onClick={() => { setLifestyleTilePicked({ id: t.id || t._id, name: t.our_name || t.display_name || t.name, image: img }); setLifestyleTileResults([]); }}
                        className={`text-left border rounded-lg overflow-hidden hover:shadow-md transition ${picked ? 'border-emerald-500 ring-2 ring-emerald-300' : 'border-slate-200'}`}
                        data-testid={`marketing-lifestyle-tile-${tileKey}`}
                      >
                        {img && <img src={img} alt={t.name} className="w-full h-20 object-cover" />}
                        <div className="text-[11px] p-1.5 font-semibold text-slate-700 truncate">{t.our_name || t.display_name || t.name}</div>
                      </button>
                    );
                  })}
                </div>
              )}
              {lifestyleTilePicked && (
                <div className="mt-2 flex items-center gap-2 bg-emerald-50 border border-emerald-200 rounded-lg p-2 text-xs">
                  {lifestyleTilePicked.image && <img src={normaliseImageUrl(lifestyleTilePicked.image)} alt="" className="w-12 h-12 rounded object-cover" />}
                  <div className="flex-1">
                    <div className="font-bold text-emerald-900">Reference: {lifestyleTilePicked.name}</div>
                    <div className="text-emerald-700">This catalogue photo will be used as the source-of-truth for the tile pattern.</div>
                  </div>
                  <Button size="sm" variant="ghost" onClick={() => setLifestyleTilePicked(null)} className="text-xs">Change</Button>
                </div>
              )}
            </div>

            <div className="grid sm:grid-cols-3 gap-3">
              <div>
                <label className="block text-xs font-bold text-slate-700 mb-1">Room type</label>
                <select value={lifestyleRoom} onChange={(e) => setLifestyleRoom(e.target.value)} className="w-full border border-slate-300 rounded px-2 py-1.5 text-sm" data-testid="marketing-lifestyle-room-select">
                  <option value="bathroom">Bathroom</option>
                  <option value="kitchen">Kitchen</option>
                  <option value="hallway">Hallway</option>
                  <option value="lounge">Lounge</option>
                  <option value="shower">Walk-in shower</option>
                  <option value="bedroom">Bedroom</option>
                  <option value="open_plan">Open plan</option>
                </select>
              </div>
              <div>
                <label className="block text-xs font-bold text-slate-700 mb-1">How many?</label>
                <select value={lifestyleVariants} onChange={(e) => setLifestyleVariants(Number(e.target.value))} className="w-full border border-slate-300 rounded px-2 py-1.5 text-sm" data-testid="marketing-lifestyle-variants-select">
                  <option value={1}>1 photo (£0.04)</option>
                  <option value={2}>2 variants (£0.08)</option>
                  <option value={4}>4 variants (£0.16)</option>
                </select>
              </div>
              <div>
                <label className="block text-xs font-bold text-slate-700 mb-1">Style notes (optional)</label>
                <Input
                  value={lifestyleNotes}
                  onChange={(e) => setLifestyleNotes(e.target.value)}
                  placeholder="moody / scandinavian / bright"
                  className="text-sm"
                  data-testid="marketing-lifestyle-notes"
                />
              </div>
            </div>
            <Button onClick={generateLifestyle} disabled={generatingLifestyle || !lifestyleTilePicked} className="bg-emerald-600 hover:bg-emerald-700 text-white font-bold w-full" data-testid="marketing-lifestyle-generate-btn">
              {generatingLifestyle ? <><Loader2 className="w-4 h-4 animate-spin mr-1" /> Rendering… (~45s for {lifestyleVariants})</> : <><Sparkles className="w-4 h-4 mr-1" /> Generate lifestyle photo{lifestyleVariants === 1 ? '' : 's'} (£{(lifestyleVariants * 0.04).toFixed(2)})</>}
            </Button>
            <div className="text-[11px] text-slate-500">
              Tip: Nano Banana's interpretation of the tile pattern will be ~95% accurate but not pixel-perfect. For pixel-accurate "see your tile in your bathroom", use the customer-facing Tile Visualizer.
            </div>
          </div>
        )}
      </Card>

      {/* Filter + gallery */}
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-lg font-bold text-slate-900 flex items-center gap-2">
          <ImageIcon className="w-5 h-5 text-slate-500" /> Gallery
          <span className="text-xs font-normal text-slate-500">({assets.length})</span>
        </h2>
        <div className="flex gap-1 text-xs">
          {['all', 'hero', 'ribbon', 'lifestyle', 'social'].map((k) => (
            <button key={k} onClick={() => setFilter(k)} className={`px-2 py-1 rounded font-semibold ${filter === k ? 'bg-slate-900 text-yellow-300' : 'bg-slate-100 text-slate-600'}`} data-testid={`marketing-filter-${k}`}>{k}</button>
          ))}
        </div>
      </div>

      {assets.length === 0 ? (
        <Card className="p-10 text-center text-slate-500" data-testid="marketing-gallery-empty">
          <ImageIcon className="w-12 h-12 mx-auto mb-3 text-slate-300" />
          <div className="font-semibold">No assets yet</div>
          <div className="text-sm mt-1">Generate your first banner above to get started.</div>
        </Card>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4" data-testid="marketing-gallery">
          {assets.map((a) => (
            <AssetCard
              key={a.id}
              asset={a}
              mobileVariantOptions={assets
                .filter((x) => x.id !== a.id)
                .map((x) => {
                  const ratio = x.width && x.height ? (x.height / x.width) : 0;
                  const orientation = ratio >= 1 ? 'portrait' : 'landscape';
                  const url = x.image_url?.startsWith('http') ? x.image_url : `${API}${x.image_url}`;
                  return {
                    id: x.id,
                    image_url: x.image_url || '',
                    preview_url: url,
                    label: `${orientation} · ${x.width}×${x.height} · ${(x.prompt || '').slice(0, 40)}${(x.prompt || '').length > 40 ? '…' : ''}`,
                  };
                })}
              onPublish={publish}
              onDelete={removeAsset}
              onUnpublish={unpublishAsset}
              onZoom={setLightboxAsset}
              onRegenerate={regenerateAsset}
            />
          ))}
        </div>
      )}

      <AssetLightbox asset={lightboxAsset} onClose={() => setLightboxAsset(null)} />
    </div>
  );
};

export default MarketingStudio;
