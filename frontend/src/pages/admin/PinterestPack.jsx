/**
 * Admin · Pinterest Pack
 * ──────────────────────
 * Generates everything an operator needs to manually post a Pinterest pin
 * in under a minute: image URL, keyword-rich caption, suggested board,
 * hashtag list, destination URL.
 *
 * No Pinterest API needed — works without their approval. Rich Pin meta
 * tags on the destination URL ensure Pinterest's crawler auto-attaches
 * price + availability + brand to the resulting pin.
 */
import React, { useCallback, useEffect, useState } from 'react';
import axios from 'axios';
import { toast } from 'sonner';
import { Card } from '../../components/ui/card';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { Textarea } from '../../components/ui/textarea';
import {
  Search, Copy, ExternalLink, Image as ImageIcon, Hash, Layout,
  PoundSterling, ArrowLeft, Sparkles, CheckCircle2,
} from 'lucide-react';

const API = process.env.REACT_APP_BACKEND_URL;
const tokenHdr = () => {
  const t = localStorage.getItem('token') || localStorage.getItem('access_token') || '';
  return t ? { Authorization: `Bearer ${t}` } : {};
};

const copyToClipboard = async (text, label = 'Copied') => {
  try {
    await navigator.clipboard.writeText(text);
    toast.success(`${label} copied to clipboard`);
  } catch {
    toast.error('Copy failed — your browser blocked clipboard access');
  }
};

export default function PinterestPack() {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState([]);
  const [searching, setSearching] = useState(false);
  const [selected, setSelected] = useState(null);
  const [customBlurb, setCustomBlurb] = useState('');
  const [pack, setPack] = useState(null);
  const [generating, setGenerating] = useState(false);

  const search = useCallback(async (q) => {
    setSearching(true);
    try {
      const r = await axios.get(`${API}/api/admin/marketing/pinterest-pack/search`,
        { headers: tokenHdr(), params: { q, limit: 18 } });
      setResults(r.data.results || []);
    } catch (e) {
      toast.error(`Search failed: ${e?.response?.data?.detail || e.message}`);
    } finally { setSearching(false); }
  }, []);

  // Debounce search as the user types
  useEffect(() => {
    const id = setTimeout(() => search(query), 300);
    return () => clearTimeout(id);
  }, [query, search]);

  const generate = async (product) => {
    setSelected(product);
    setGenerating(true);
    setPack(null);
    try {
      const r = await axios.post(`${API}/api/admin/marketing/pinterest-pack`, {
        product_id: product.id, sku: product.sku, slug: product.slug,
        custom_blurb: customBlurb || '',
      }, { headers: tokenHdr() });
      setPack(r.data);
    } catch (e) {
      toast.error(`Pack failed: ${e?.response?.data?.detail || e.message}`);
    } finally { setGenerating(false); }
  };

  const regenerate = () => {
    if (selected) generate(selected);
  };

  return (
    <div className="max-w-7xl mx-auto p-6 space-y-6" data-testid="pinterest-pack-page">
      <div className="flex items-start justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <span className="w-7 h-7 rounded-full bg-[#E60023] text-white flex items-center justify-center text-sm font-bold">P</span>
            Pinterest Pack
          </h1>
          <p className="text-sm text-gray-500 mt-1">
            Manual posting that takes 30 seconds. Pick a product, copy the pack, paste into Pinterest.
            No API approval needed.
          </p>
        </div>
        <a href="/admin/marketing-studio" className="text-sm text-amber-600 hover:underline inline-flex items-center gap-1">
          <ArrowLeft className="w-4 h-4" /> Back to Marketing Studio
        </a>
      </div>

      {/* SEARCH + RESULTS */}
      <Card className="p-5">
        <div className="flex gap-3 items-center mb-3">
          <div className="flex-1 relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400 pointer-events-none" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search by name, SKU, colour, series, category…"
              className="pl-9"
              data-testid="pack-search-input"
            />
          </div>
          <div className="text-xs text-gray-500">{searching ? 'Searching…' : `${results.length} results`}</div>
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2" data-testid="pack-results-grid">
          {results.map((p) => (
            <button
              key={p.id || p.sku}
              onClick={() => generate(p)}
              className={`text-left rounded-lg overflow-hidden border-2 transition ${
                (selected && (selected.id === p.id || selected.sku === p.sku))
                  ? 'border-[#E60023] ring-2 ring-red-200'
                  : 'border-gray-200 hover:border-gray-300'
              }`}
              data-testid={`pack-result-${p.sku || p.id}`}
            >
              <div className="aspect-square bg-gray-100">
                {p.image && <img src={p.image} alt="" className="w-full h-full object-cover" />}
              </div>
              <div className="p-1.5 bg-white">
                <div className="text-[11px] font-medium truncate">{p.name}</div>
                <div className="text-[10px] text-gray-500">
                  {p.price != null ? `£${Number(p.price).toFixed(2)}` : ''}
                </div>
              </div>
            </button>
          ))}
        </div>
      </Card>

      {/* CUSTOM BLURB */}
      <Card className="p-5">
        <label className="text-xs font-bold text-gray-500 uppercase tracking-wide flex items-center gap-2 mb-2">
          <Sparkles className="w-4 h-4 text-amber-500" /> Optional weekly hook (gets stitched into the caption)
        </label>
        <Textarea
          value={customBlurb}
          onChange={(e) => setCustomBlurb(e.target.value)}
          rows={2}
          maxLength={240}
          placeholder="e.g. Perfect for north-facing bathrooms — soft warm tones make small spaces feel bigger."
          data-testid="custom-blurb-textarea"
        />
        <div className="text-xs text-gray-400 mt-1 text-right">
          {customBlurb.length}/240 · {selected ? <button onClick={regenerate} className="text-amber-600 hover:underline">Regenerate pack →</button> : 'pick a product first'}
        </div>
      </Card>

      {/* PACK OUTPUT */}
      {generating && (
        <Card className="p-12 text-center text-gray-500">Generating pack…</Card>
      )}
      {pack && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6" data-testid="pack-output">
          {/* LEFT: image preview + suggested board */}
          <Card className="p-5">
            <h2 className="text-lg font-semibold flex items-center gap-2 mb-3">
              <ImageIcon className="w-5 h-5 text-emerald-500" /> Pin image
            </h2>
            <div className="rounded-lg overflow-hidden border border-gray-200 bg-stone-100 mb-3">
              <img src={pack.pin_image_url} alt={pack.product?.name || ''} className="w-full h-auto" />
            </div>
            <div className="flex gap-2">
              <Button variant="outline" size="sm" onClick={() => copyToClipboard(pack.pin_image_url, 'Image URL')} className="flex-1" data-testid="copy-image-url-btn">
                <Copy className="w-3 h-3 mr-1" /> Copy image URL
              </Button>
              <a href={pack.pin_image_url} target="_blank" rel="noopener noreferrer"
                 className="px-3 py-1.5 text-sm border border-gray-300 rounded-md hover:bg-gray-50 inline-flex items-center gap-1">
                <ExternalLink className="w-3 h-3" /> Open
              </a>
            </div>

            <div className="mt-5 p-3 bg-amber-50 border border-amber-200 rounded-lg">
              <div className="text-xs font-bold text-amber-900 uppercase tracking-wide flex items-center gap-1.5 mb-1">
                <Layout className="w-3 h-3" /> Suggested board
              </div>
              <div className="text-base font-semibold text-stone-900">{pack.suggested_board}</div>
              <div className="text-xs text-amber-700 mt-1">Pinterest ranks pins higher when board name matches caption keywords.</div>
            </div>
          </Card>

          {/* RIGHT: caption + hashtags + destination URL */}
          <div className="space-y-5">
            <Card className="p-5">
              <h2 className="text-base font-semibold flex items-center gap-2 mb-2">
                <Sparkles className="w-4 h-4 text-amber-500" /> Caption (with hashtags)
              </h2>
              <Textarea
                value={pack.full_caption_with_tags || ''}
                onChange={() => { /* read-only */ }}
                rows={8}
                className="text-sm"
                readOnly
                data-testid="pack-caption-textarea"
              />
              <Button onClick={() => copyToClipboard(pack.full_caption_with_tags || '', 'Caption')} className="mt-2 w-full bg-[#E60023] hover:bg-[#AD081B] text-white" data-testid="copy-caption-btn">
                <Copy className="w-4 h-4 mr-2" /> Copy full caption
              </Button>
            </Card>

            <Card className="p-5">
              <h2 className="text-base font-semibold flex items-center gap-2 mb-2">
                <ExternalLink className="w-4 h-4 text-blue-500" /> Destination URL
              </h2>
              <code className="block p-3 bg-stone-100 rounded text-xs text-stone-700 break-all" data-testid="pack-destination-url">
                {pack.destination_url}
              </code>
              <Button variant="outline" onClick={() => copyToClipboard(pack.destination_url, 'Destination URL')} className="mt-2 w-full" data-testid="copy-dest-btn">
                <Copy className="w-4 h-4 mr-2" /> Copy URL
              </Button>
            </Card>

            <Card className="p-5">
              <h2 className="text-base font-semibold flex items-center gap-2 mb-2">
                <Hash className="w-4 h-4 text-purple-500" /> Hashtags
              </h2>
              <div className="flex flex-wrap gap-1.5">
                {(pack.hashtags || []).map((h) => (
                  <span key={h} className="px-2 py-1 bg-purple-100 text-purple-700 rounded-full text-xs font-medium">{h}</span>
                ))}
              </div>
            </Card>

            <Card className="p-5 bg-emerald-50 border-emerald-200">
              <h2 className="text-sm font-semibold flex items-center gap-2 mb-2 text-emerald-900">
                <CheckCircle2 className="w-4 h-4" /> How to post
              </h2>
              <ol className="text-xs text-emerald-800 space-y-1 list-decimal pl-4">
                {(pack.instructions || []).map((step, i) => (
                  <li key={i}>{step.replace(/^\d+\.\s*/, '')}</li>
                ))}
              </ol>
            </Card>
          </div>
        </div>
      )}
    </div>
  );
}
