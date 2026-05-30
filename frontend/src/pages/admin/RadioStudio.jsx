/**
 * Radio Studio admin page — in-store AI-narrated radio control panel.
 *
 * User-requested feature (24 May 2026): 4-store in-store radio with
 * ElevenLabs UK English voices + royalty-free music. Admins write ad
 * scripts here, pick a voice, generate the MP3, upload music, then
 * arrange ads + music into a playlist.
 *
 * Three tabs:
 *   • Ads — script editor + voice picker + generate/preview
 *   • Music — upload royalty-free tracks
 *   • Playlist — drag-drop sequence of ads + music
 *
 * The streaming/in-store-speaker piece (Phase 2) is intentionally
 * out of scope for this initial ship; admins preview clips via the
 * built-in <audio> element and play them through the Bluetooth
 * speaker by AirPlay/Bluetooth-to-phone-to-speaker manually until
 * the live stream goes online.
 */
import React, { useState, useEffect, useCallback } from 'react';
import axios from 'axios';
import { toast } from 'sonner';
import {
  Radio, Mic, Music, ListMusic, Play, Pause, Trash2, RefreshCw, Loader2,
  Plus, Save, Upload, Sparkles, GripVertical, Volume2,
} from 'lucide-react';

const API_URL = process.env.REACT_APP_BACKEND_URL;
const API = `${API_URL}/api`;

const tokenHdr = () => {
  // Match the rest of the admin app — token lives at localStorage['token'].
  // Belt-and-braces: also check 'access_token' (used by some older
  // admin pages) and 'admin_token' (used by a couple of legacy
  // wrappers like PalletPricingSettingsPage). Without this, every
  // Radio Studio API call sent no Authorization header → 403 "Not
  // authenticated". Bug surfaced 24 May 2026 on music upload AND
  // script generation.
  const t =
    localStorage.getItem('token') ||
    localStorage.getItem('access_token') ||
    localStorage.getItem('admin_token');
  return t ? { Authorization: `Bearer ${t}` } : {};
};

export default function RadioStudio() {
  const [tab, setTab] = useState('ads');
  const [voices, setVoices] = useState([]);
  const [voicesLoading, setVoicesLoading] = useState(false);
  const [ads, setAds] = useState([]);
  const [music, setMusic] = useState([]);
  const [playlist, setPlaylist] = useState({ items: [], name: 'Default Playlist' });

  const loadVoices = useCallback(async (resync = false) => {
    setVoicesLoading(true);
    try {
      const url = resync
        ? `${API}/admin/radio-studio/voices/sync`
        : `${API}/admin/radio-studio/voices`;
      const r = resync
        ? await axios.post(url, {}, { headers: tokenHdr() })
        : await axios.get(url, { headers: tokenHdr() });
      setVoices(r.data.voices || []);
    } catch (e) {
      toast.error(`Failed to load voices: ${e?.response?.data?.detail || e.message}`);
    } finally {
      setVoicesLoading(false);
    }
  }, []);

  const loadAds = useCallback(async () => {
    try {
      const r = await axios.get(`${API}/admin/radio-studio/ads`, { headers: tokenHdr() });
      setAds(r.data.ads || []);
    } catch (e) {
      toast.error(`Failed to load ads: ${e?.response?.data?.detail || e.message}`);
    }
  }, []);

  const loadMusic = useCallback(async () => {
    try {
      const r = await axios.get(`${API}/admin/radio-studio/music`, { headers: tokenHdr() });
      setMusic(r.data.tracks || []);
    } catch (e) {
      toast.error(`Failed to load music: ${e?.response?.data?.detail || e.message}`);
    }
  }, []);

  const loadPlaylist = useCallback(async () => {
    try {
      const r = await axios.get(`${API}/admin/radio-studio/playlist`, { headers: tokenHdr() });
      setPlaylist(r.data || { items: [], name: 'Default Playlist' });
    } catch (e) {
      toast.error(`Failed to load playlist: ${e?.response?.data?.detail || e.message}`);
    }
  }, []);

  useEffect(() => {
    loadVoices();
    loadAds();
    loadMusic();
    loadPlaylist();
  }, [loadVoices, loadAds, loadMusic, loadPlaylist]);

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-900 via-slate-800 to-slate-900 text-slate-100 p-4 sm:p-6">
      {/* Header */}
      <div className="mb-6 flex items-center gap-3">
        <div className="bg-amber-500 text-slate-900 p-2.5 rounded-xl shadow-lg">
          <Radio className="w-6 h-6" />
        </div>
        <div>
          <h1 className="text-2xl sm:text-3xl font-bold tracking-tight">Radio Studio</h1>
          <p className="text-xs text-slate-400">In-store AI-narrated radio · ElevenLabs UK voices · 4 stores</p>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 mb-5 bg-slate-800/50 p-1 rounded-xl backdrop-blur border border-slate-700/50 w-fit">
        {[
          { key: 'ads', label: 'Ads', icon: Mic },
          { key: 'music', label: 'Music Library', icon: Music },
          { key: 'playlist', label: 'Playlist', icon: ListMusic },
        ].map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            data-testid={`radio-tab-${t.key}`}
            className={`flex items-center gap-1.5 px-3 sm:px-4 py-2 text-sm font-semibold rounded-lg transition-all ${
              tab === t.key
                ? 'bg-amber-500 text-slate-900 shadow-lg'
                : 'text-slate-300 hover:bg-slate-700/50'
            }`}
          >
            <t.icon className="w-4 h-4" />
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'ads' && (
        <AdsTab
          voices={voices}
          voicesLoading={voicesLoading}
          onResyncVoices={() => loadVoices(true)}
          ads={ads}
          onAdsChange={loadAds}
        />
      )}
      {tab === 'music' && <MusicTab music={music} onMusicChange={loadMusic} />}
      {tab === 'playlist' && (
        <PlaylistTab
          ads={ads}
          music={music}
          playlist={playlist}
          onPlaylistChange={loadPlaylist}
        />
      )}
    </div>
  );
}

/* ----------------------------------------------------------------
   Ads tab — script editor + voice picker + generate
---------------------------------------------------------------- */
function AdsTab({ voices, voicesLoading, onResyncVoices, ads, onAdsChange }) {
  const [editingAd, setEditingAd] = useState(null);  // null = compose new
  const [form, setForm] = useState({
    name: '',
    script: '',
    voice_id: '',
    voice_name: '',
    stability: 0.5,
    similarity_boost: 0.75,
    style: 0,
    model_id: 'eleven_multilingual_v2',
  });
  const [saving, setSaving] = useState(false);
  const [generatingId, setGeneratingId] = useState(null);
  // 24 May 2026 — AI auto-generate state. Open the panel, fill the
  // keywords + tone, click "Generate" — the LLM-written script lands
  // straight into the Script textarea where the admin can tweak it.
  const [aiOpen, setAiOpen] = useState(false);
  const [aiBusy, setAiBusy] = useState(false);
  const [aiForm, setAiForm] = useState({
    keywords: '',
    duration_seconds: 20,
    tone: 'friendly',
    audience: 'both',
    call_to_action: '',
    avoid_words: '',
  });

  const resetForm = () => {
    setEditingAd(null);
    setForm({
      name: '',
      script: '',
      voice_id: '',
      voice_name: '',
      stability: 0.5,
      similarity_boost: 0.75,
      style: 0,
      model_id: 'eleven_multilingual_v2',
    });
  };

  const startEdit = (ad) => {
    setEditingAd(ad);
    setForm({
      name: ad.name,
      script: ad.script,
      voice_id: ad.voice_id,
      voice_name: ad.voice_name || '',
      stability: ad.stability ?? 0.5,
      similarity_boost: ad.similarity_boost ?? 0.75,
      style: ad.style ?? 0,
      model_id: ad.model_id || 'eleven_multilingual_v2',
    });
  };

  const handleSave = async () => {
    if (!form.name.trim() || !form.script.trim() || !form.voice_id) {
      toast.error('Name, script and voice are required');
      return;
    }
    setSaving(true);
    try {
      const selectedVoice = voices.find((v) => v.voice_id === form.voice_id);
      const body = { ...form, voice_name: selectedVoice?.name || form.voice_name };
      if (editingAd) {
        await axios.put(`${API}/admin/radio-studio/ads/${editingAd.id}`, body, { headers: tokenHdr() });
        toast.success('Ad updated');
      } else {
        await axios.post(`${API}/admin/radio-studio/ads`, body, { headers: tokenHdr() });
        toast.success('Ad saved');
      }
      resetForm();
      onAdsChange();
    } catch (e) {
      toast.error(`Save failed: ${e?.response?.data?.detail || e.message}`);
    } finally {
      setSaving(false);
    }
  };

  const handleGenerate = async (adId) => {
    setGeneratingId(adId);
    try {
      await axios.post(`${API}/admin/radio-studio/ads/${adId}/generate`, {}, { headers: tokenHdr() });
      toast.success('Audio generated');
      onAdsChange();
    } catch (e) {
      toast.error(`Generation failed: ${e?.response?.data?.detail || e.message}`);
    } finally {
      setGeneratingId(null);
    }
  };

  const handleDelete = async (adId) => {
    if (!window.confirm('Delete this ad? The audio file will be removed too.')) return;
    try {
      await axios.delete(`${API}/admin/radio-studio/ads/${adId}`, { headers: tokenHdr() });
      toast.success('Ad deleted');
      onAdsChange();
    } catch (e) {
      toast.error(`Delete failed: ${e?.response?.data?.detail || e.message}`);
    }
  };

  // 24 May 2026 — AI auto-generate. LLM writes the script from
  // keywords + tone; result populates the Script textarea so the
  // admin can edit before saving. The voice + voice settings remain
  // independent of the script source — auto-generated scripts can
  // use any voice the admin picks.
  const handleAiGenerate = async () => {
    if (!aiForm.keywords.trim()) {
      toast.error('Add a few keywords first (e.g. "La Dolce, 20% off, weekend")');
      return;
    }
    setAiBusy(true);
    try {
      const r = await axios.post(
        `${API}/admin/radio-studio/scripts/generate`,
        {
          keywords: aiForm.keywords.trim(),
          duration_seconds: aiForm.duration_seconds,
          tone: aiForm.tone,
          audience: aiForm.audience,
          call_to_action: aiForm.call_to_action.trim() || null,
          avoid_words: aiForm.avoid_words.trim() || null,
        },
        { headers: tokenHdr() }
      );
      // Drop the generated script into the form. Preserve the name
      // if the admin already typed one, otherwise seed from the
      // backend's suggested name.
      setForm((f) => ({
        ...f,
        script: r.data.script || '',
        name: f.name.trim() ? f.name : (r.data.suggested_name || ''),
      }));
      // If any banned phrases slipped through even after the retry,
      // surface them so the admin can hand-edit the script.
      const offenders = r.data.banned_phrases_used || [];
      if (offenders.length > 0) {
        toast.warning(
          `Script ready · ${r.data.approx_words} words · ~${r.data.approx_seconds}s — but ${offenders.length} banned phrase${offenders.length > 1 ? 's' : ''} (${offenders.join(', ')}) slipped through. Please review.`
        );
      } else {
        toast.success(
          `Script ready · ${r.data.approx_words} words · ~${r.data.approx_seconds}s`,
        );
      }
      setAiOpen(false);
    } catch (e) {
      toast.error(`Generation failed: ${e?.response?.data?.detail || e.message}`);
    } finally {
      setAiBusy(false);
    }
  };

  // Group voices by accent so the dropdown is easier to scan. UK
  // English first because that's the default request.
  const groupedVoices = (() => {
    const groups = {};
    voices.forEach((v) => {
      const key = (v.accent || 'other').toLowerCase().includes('british') ? 'UK English' : (v.accent || 'Other');
      if (!groups[key]) groups[key] = [];
      groups[key].push(v);
    });
    const order = ['UK English', 'American', 'Australian', 'Irish', 'Other'];
    return order.flatMap((k) => (groups[k] ? [[k, groups[k]]] : []));
  })();

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
      {/* Compose / Edit pane */}
      <div className="bg-slate-800/60 backdrop-blur border border-slate-700/50 rounded-2xl p-4 sm:p-5 shadow-xl">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-lg font-bold flex items-center gap-2">
            <Mic className="w-5 h-5 text-amber-400" />
            {editingAd ? `Edit: ${editingAd.name}` : 'Compose new ad'}
          </h2>
          {editingAd && (
            <button onClick={resetForm} className="text-xs text-slate-400 hover:text-slate-200">
              + New ad
            </button>
          )}
        </div>

        <div className="space-y-3">
          <div>
            <label className="block text-xs uppercase tracking-wider text-slate-400 font-bold mb-1">Ad name</label>
            <input
              type="text"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              placeholder="e.g. La Dolce weekend sale 20%"
              data-testid="radio-ad-name"
              className="w-full px-3 py-2 bg-slate-900 border border-slate-600 rounded-lg text-sm text-slate-100 placeholder-slate-500 focus:border-amber-500 focus:outline-none"
            />
          </div>

          {/* 24 May 2026 — AI auto-generate panel. Collapsed by
              default so manual scripting (the existing UX) stays the
              primary path. Click to expand → fill keywords → click
              Generate. The LLM's text lands in the Script textarea
              below, ready to edit. Voice selection is independent —
              the admin still picks the voice + tuning separately. */}
          <div className="bg-gradient-to-br from-purple-900/40 to-fuchsia-900/30 border border-purple-500/30 rounded-lg overflow-hidden">
            <button
              type="button"
              onClick={() => setAiOpen((v) => !v)}
              data-testid="radio-ad-ai-toggle"
              className="w-full flex items-center justify-between gap-2 px-3 py-2 text-left hover:bg-purple-500/10 transition-colors"
            >
              <span className="flex items-center gap-2">
                <Sparkles className="w-4 h-4 text-fuchsia-300" />
                <span className="text-sm font-semibold text-fuchsia-200">
                  Auto-generate script with AI
                </span>
                <span className="text-[10px] text-fuchsia-400/70 font-normal">— or write manually below</span>
              </span>
              <span className="text-xs text-fuchsia-300">{aiOpen ? '▲' : '▼'}</span>
            </button>
            {aiOpen && (
              <div className="px-3 pb-3 pt-1 space-y-2 border-t border-purple-500/20">
                <div>
                  <label className="block text-[10px] uppercase tracking-wider text-fuchsia-300/80 font-bold mb-0.5">
                    Keywords / themes
                  </label>
                  <input
                    type="text"
                    value={aiForm.keywords}
                    onChange={(e) => setAiForm({ ...aiForm, keywords: e.target.value })}
                    placeholder="La Dolce porcelain, 20% off, free samples, this weekend"
                    data-testid="radio-ad-ai-keywords"
                    className="w-full px-2.5 py-1.5 bg-slate-900 border border-purple-500/40 rounded text-sm text-slate-100 placeholder-slate-500 focus:border-fuchsia-400 focus:outline-none"
                  />
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <label className="block text-[10px] uppercase tracking-wider text-fuchsia-300/80 font-bold mb-0.5">
                      Tone
                    </label>
                    <select
                      value={aiForm.tone}
                      onChange={(e) => setAiForm({ ...aiForm, tone: e.target.value })}
                      data-testid="radio-ad-ai-tone"
                      className="w-full px-2 py-1.5 bg-slate-900 border border-purple-500/40 rounded text-xs text-slate-100 focus:border-fuchsia-400 focus:outline-none"
                    >
                      <option value="friendly">Friendly · conversational</option>
                      <option value="energetic">Energetic · sale-style</option>
                      <option value="calm">Calm · premium</option>
                      <option value="authoritative">Authoritative · trade</option>
                      <option value="premium">Premium · luxury</option>
                    </select>
                  </div>
                  <div>
                    <label className="block text-[10px] uppercase tracking-wider text-fuchsia-300/80 font-bold mb-0.5">
                      Length
                    </label>
                    <select
                      value={aiForm.duration_seconds}
                      onChange={(e) => setAiForm({ ...aiForm, duration_seconds: parseInt(e.target.value, 10) })}
                      data-testid="radio-ad-ai-length"
                      className="w-full px-2 py-1.5 bg-slate-900 border border-purple-500/40 rounded text-xs text-slate-100 focus:border-fuchsia-400 focus:outline-none"
                    >
                      <option value={10}>~10s (snappy)</option>
                      <option value={15}>~15s</option>
                      <option value={20}>~20s (standard)</option>
                      <option value={30}>~30s</option>
                      <option value={45}>~45s (detailed)</option>
                      <option value={60}>~60s (full story)</option>
                    </select>
                  </div>
                </div>
                <div>
                  <label className="block text-[10px] uppercase tracking-wider text-fuchsia-300/80 font-bold mb-0.5">
                    Audience
                  </label>
                  <div className="flex gap-1">
                    {[
                      { value: 'retail', label: 'Retail' },
                      { value: 'trade', label: 'Trade' },
                      { value: 'both', label: 'Both' },
                    ].map((opt) => (
                      <button
                        key={opt.value}
                        type="button"
                        onClick={() => setAiForm({ ...aiForm, audience: opt.value })}
                        data-testid={`radio-ad-ai-audience-${opt.value}`}
                        className={`flex-1 text-xs py-1.5 rounded font-semibold transition-colors ${
                          aiForm.audience === opt.value
                            ? 'bg-fuchsia-500 text-white'
                            : 'bg-slate-800 text-slate-300 hover:bg-slate-700'
                        }`}
                      >
                        {opt.label}
                      </button>
                    ))}
                  </div>
                </div>
                <div>
                  <label className="block text-[10px] uppercase tracking-wider text-fuchsia-300/80 font-bold mb-0.5">
                    Call to action <span className="normal-case opacity-70 font-normal">(optional)</span>
                  </label>
                  <input
                    type="text"
                    value={aiForm.call_to_action}
                    onChange={(e) => setAiForm({ ...aiForm, call_to_action: e.target.value })}
                    placeholder="e.g. visit our Manchester showroom · ask a team member · grab a free sample"
                    data-testid="radio-ad-ai-cta"
                    className="w-full px-2.5 py-1.5 bg-slate-900 border border-purple-500/40 rounded text-xs text-slate-100 placeholder-slate-500 focus:border-fuchsia-400 focus:outline-none"
                  />
                </div>
                <button
                  type="button"
                  onClick={handleAiGenerate}
                  disabled={aiBusy || !aiForm.keywords.trim()}
                  data-testid="radio-ad-ai-generate"
                  className="w-full py-2 bg-gradient-to-r from-fuchsia-500 to-purple-500 hover:from-fuchsia-400 hover:to-purple-400 text-white font-bold rounded-lg disabled:opacity-50 disabled:cursor-wait transition-all flex items-center justify-center gap-2 text-sm"
                >
                  {aiBusy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Sparkles className="w-4 h-4" />}
                  {aiBusy ? 'Writing your ad…' : 'Generate script'}
                </button>
                <p className="text-[10px] text-fuchsia-300/60 leading-snug">
                  ✓ Script lands in the box below — edit it freely · ✓ Pick voice + tuning separately · ✓ Doesn&apos;t cost ElevenLabs credits until you click Generate Audio
                </p>
              </div>
            )}
          </div>

          <div>
            <label className="block text-xs uppercase tracking-wider text-slate-400 font-bold mb-1">
              Script
              <span className="ml-2 text-slate-500 normal-case font-normal">
                {form.script.length} / 4000 chars · ~{Math.ceil(form.script.length / 14)}s narration
              </span>
            </label>
            <textarea
              value={form.script}
              onChange={(e) => setForm({ ...form, script: e.target.value })}
              placeholder="Welcome to Tile Station. This weekend only, La Dolce porcelain tiles are 20% off..."
              rows={6}
              maxLength={4000}
              data-testid="radio-ad-script"
              className="w-full px-3 py-2 bg-slate-900 border border-slate-600 rounded-lg text-sm text-slate-100 placeholder-slate-500 focus:border-amber-500 focus:outline-none resize-y"
            />
          </div>

          <div>
            <label className="block text-xs uppercase tracking-wider text-slate-400 font-bold mb-1 flex items-center justify-between">
              <span>Voice</span>
              <button
                onClick={onResyncVoices}
                disabled={voicesLoading}
                className="text-[10px] font-normal normal-case text-amber-400 hover:text-amber-300 flex items-center gap-1"
                data-testid="radio-resync-voices"
              >
                <RefreshCw className={`w-3 h-3 ${voicesLoading ? 'animate-spin' : ''}`} />
                Resync from ElevenLabs
              </button>
            </label>
            <select
              value={form.voice_id}
              onChange={(e) => setForm({ ...form, voice_id: e.target.value })}
              data-testid="radio-ad-voice"
              disabled={voices.length === 0}
              className="w-full px-3 py-2 bg-slate-900 border border-slate-600 rounded-lg text-sm text-slate-100 focus:border-amber-500 focus:outline-none disabled:opacity-60 disabled:cursor-not-allowed"
            >
              <option value="">
                {voicesLoading
                  ? '— loading voices from ElevenLabs… —'
                  : voices.length === 0
                    ? '— no voices yet · click "Resync from ElevenLabs" above —'
                    : '— pick a voice —'}
              </option>
              {groupedVoices.map(([groupName, groupVoices]) => (
                <optgroup key={groupName} label={groupName}>
                  {groupVoices.map((v) => (
                    <option key={v.voice_id} value={v.voice_id}>
                      {v.name}
                      {v.gender ? ` · ${v.gender}` : ''}
                      {v.age ? ` · ${v.age}` : ''}
                      {v.accent ? ` · ${v.accent}` : ''}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
            {voices.length === 0 && !voicesLoading && (
              <p className="text-[11px] text-amber-300/80 mt-1 leading-snug">
                If your ElevenLabs account has voices but none appear here, click
                <span className="font-bold"> Resync from ElevenLabs</span> above — your account&apos;s voices will populate the list.
              </p>
            )}
            {form.voice_id && (() => {
              const v = voices.find((x) => x.voice_id === form.voice_id);
              return v?.preview_url ? (
                <div className="mt-2">
                  <p className="text-[11px] text-slate-400 mb-1">Voice sample (ElevenLabs preview):</p>
                  <audio controls src={v.preview_url} className="w-full h-8" />
                </div>
              ) : null;
            })()}
          </div>

          {/* Voice tuning */}
          <details className="bg-slate-900/40 rounded-lg px-3 py-2">
            <summary className="text-xs font-bold text-slate-300 cursor-pointer">Advanced voice settings</summary>
            <div className="mt-3 space-y-2">
              {[
                { key: 'stability', label: 'Stability', hint: 'Lower = more expressive, Higher = more consistent' },
                { key: 'similarity_boost', label: 'Similarity', hint: 'How close to original voice character' },
                { key: 'style', label: 'Style exaggeration', hint: '0 for clean narration, higher for theatrical' },
              ].map((f) => (
                <div key={f.key}>
                  <label className="block text-[11px] text-slate-400 mb-0.5">
                    {f.label}: <span className="text-amber-300 font-mono">{form[f.key].toFixed(2)}</span>
                    <span className="ml-2 text-slate-500 text-[10px]">{f.hint}</span>
                  </label>
                  <input
                    type="range"
                    min="0"
                    max="1"
                    step="0.05"
                    value={form[f.key]}
                    onChange={(e) => setForm({ ...form, [f.key]: parseFloat(e.target.value) })}
                    className="w-full accent-amber-500"
                  />
                </div>
              ))}
              <div>
                <label className="block text-[11px] text-slate-400 mb-0.5">Model</label>
                <select
                  value={form.model_id}
                  onChange={(e) => setForm({ ...form, model_id: e.target.value })}
                  className="w-full px-2 py-1 bg-slate-900 border border-slate-600 rounded text-xs"
                >
                  <option value="eleven_multilingual_v2">Multilingual v2 — best quality (recommended)</option>
                  <option value="eleven_turbo_v2_5">Turbo v2.5 — fast & cheap</option>
                  <option value="eleven_monolingual_v1">Monolingual v1 — legacy</option>
                </select>
              </div>
            </div>
          </details>

          <button
            onClick={handleSave}
            disabled={saving}
            data-testid="radio-ad-save"
            className="w-full py-2.5 bg-amber-500 hover:bg-amber-400 text-slate-900 font-bold rounded-lg disabled:opacity-60 disabled:cursor-wait transition-all flex items-center justify-center gap-2"
          >
            {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
            {editingAd ? 'Update ad' : 'Save ad'}
          </button>
        </div>
      </div>

      {/* Library list */}
      <div className="bg-slate-800/60 backdrop-blur border border-slate-700/50 rounded-2xl p-4 sm:p-5 shadow-xl">
        <h2 className="text-lg font-bold mb-3 flex items-center gap-2">
          <ListMusic className="w-5 h-5 text-amber-400" />
          Ad library
          <span className="text-xs text-slate-400 font-normal">({ads.length})</span>
        </h2>
        {ads.length === 0 && (
          <p className="text-sm text-slate-400 py-8 text-center">No ads yet. Write your first script on the left.</p>
        )}
        <div className="space-y-2 max-h-[600px] overflow-y-auto pr-1">
          {ads.map((ad) => (
            <div key={ad.id} className="bg-slate-900/60 border border-slate-700/50 rounded-lg p-3" data-testid={`radio-ad-card-${ad.id}`}>
              <div className="flex items-start justify-between gap-2 mb-1">
                <div className="min-w-0 flex-1">
                  <div className="font-semibold text-sm truncate">{ad.name}</div>
                  <div className="text-[11px] text-slate-400 truncate">
                    {ad.voice_name || ad.voice_id}
                    {ad.duration_seconds ? ` · ${ad.duration_seconds}s` : ''}
                  </div>
                </div>
                <div className="flex items-center gap-1 flex-shrink-0">
                  <button
                    onClick={() => startEdit(ad)}
                    className="p-1.5 text-slate-400 hover:text-amber-300 hover:bg-slate-800 rounded"
                    title="Edit"
                  >
                    <Mic className="w-3.5 h-3.5" />
                  </button>
                  <button
                    onClick={() => handleGenerate(ad.id)}
                    disabled={generatingId === ad.id}
                    data-testid={`radio-ad-generate-${ad.id}`}
                    className="p-1.5 text-emerald-400 hover:text-emerald-300 hover:bg-slate-800 rounded disabled:opacity-60 disabled:cursor-wait"
                    title={ad.audio_filename ? 'Regenerate audio' : 'Generate audio'}
                  >
                    {generatingId === ad.id ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Sparkles className="w-3.5 h-3.5" />}
                  </button>
                  <button
                    onClick={() => handleDelete(ad.id)}
                    className="p-1.5 text-red-400 hover:text-red-300 hover:bg-slate-800 rounded"
                    title="Delete"
                    data-testid={`radio-ad-delete-${ad.id}`}
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
              <p className="text-xs text-slate-400 line-clamp-2">{ad.script}</p>
              {ad.audio_filename && (
                <audio
                  controls
                  // 24 May 2026 — cache-bust by `generated_at`. The
                  // backend OVERWRITES the same {id}.mp3 file when
                  // the admin regenerates with a new voice/script,
                  // but the browser caches the URL. Adding the
                  // timestamp as a query param forces a fresh fetch
                  // every time the ad is regenerated.
                  src={`${API}/radio-studio/stream/ad/${ad.id}${ad.generated_at ? `?v=${encodeURIComponent(ad.generated_at)}` : ''}`}
                  className="w-full h-8 mt-2"
                  data-testid={`radio-ad-preview-${ad.id}`}
                />
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/* ----------------------------------------------------------------
   Music library tab
---------------------------------------------------------------- */
function MusicTab({ music, onMusicChange }) {
  const [uploadName, setUploadName] = useState('');
  const [uploadFile, setUploadFile] = useState(null);
  const [uploading, setUploading] = useState(false);

  // 24 May 2026 — auto-derive the track name from the filename when
  // the admin picks a file. User reported the Upload button stayed
  // greyed out forever because they expected picking a file to be
  // enough — they didn't notice the empty Track Name input above.
  // Strips the extension and the most common YouTube/SoundCloud
  // download prefixes so the name is shop-ready.
  const handleFilePick = (file) => {
    setUploadFile(file);
    if (file && !uploadName.trim()) {
      let n = file.name.replace(/\.[^.]+$/, '');                 // drop extension
      n = n.replace(/^[a-z0-9-_]{8,}-/i, '');                    // drop hash prefixes
      n = n.replace(/\s*\([^)]*\)\s*$/, '').trim();              // drop trailing "(Official)" / "(Audio)"
      setUploadName(n);
    }
  };

  const handleUpload = async () => {
    if (!uploadFile || !uploadName.trim()) {
      toast.error('Pick a file and give it a name');
      return;
    }
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append('name', uploadName.trim());
      fd.append('file', uploadFile);
      // 24 May 2026 — DO NOT manually set Content-Type on FormData
      // uploads. Axios auto-generates it as
      //   "multipart/form-data; boundary=----WebKitFormBoundaryXxx"
      // The boundary is auto-derived from the FormData instance.
      // Setting Content-Type manually here OMITS the boundary, so
      // the backend's multipart parser couldn't find any fields →
      // silent 422 / "field required" → upload looked stuck.
      await axios.post(`${API}/admin/radio-studio/music/upload`, fd, {
        headers: tokenHdr(),
      });
      toast.success('Track uploaded');
      setUploadName('');
      setUploadFile(null);
      onMusicChange();
    } catch (e) {
      toast.error(`Upload failed: ${e?.response?.data?.detail || e.message}`);
    } finally {
      setUploading(false);
    }
  };

  const handleDelete = async (id) => {
    if (!window.confirm('Delete this track?')) return;
    try {
      await axios.delete(`${API}/admin/radio-studio/music/${id}`, { headers: tokenHdr() });
      toast.success('Track deleted');
      onMusicChange();
    } catch (e) {
      toast.error(`Delete failed: ${e?.response?.data?.detail || e.message}`);
    }
  };

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
      <div className="bg-slate-800/60 backdrop-blur border border-slate-700/50 rounded-2xl p-4 sm:p-5 shadow-xl">
        <h2 className="text-lg font-bold mb-3 flex items-center gap-2">
          <Upload className="w-5 h-5 text-amber-400" />
          Upload music track
        </h2>
        <p className="text-xs text-slate-400 mb-3 leading-relaxed">
          Royalty-free MP3s only (e.g. YouTube Audio Library, Epidemic Sound free tier, Bensound). Max 30 MB per track.
          Music plays between ads in the playlist.
        </p>
        <div className="space-y-3">
          <input
            type="text"
            value={uploadName}
            onChange={(e) => setUploadName(e.target.value)}
            placeholder="Track name (e.g. Upbeat morning loop)"
            data-testid="radio-music-name"
            className="w-full px-3 py-2 bg-slate-900 border border-slate-600 rounded-lg text-sm text-slate-100 placeholder-slate-500 focus:border-amber-500 focus:outline-none"
          />
          <input
            type="file"
            accept="audio/*"
            onChange={(e) => handleFilePick(e.target.files?.[0] || null)}
            data-testid="radio-music-file"
            className="w-full text-sm text-slate-300 file:mr-3 file:py-2 file:px-3 file:rounded-lg file:border-0 file:bg-amber-500 file:text-slate-900 file:font-bold hover:file:bg-amber-400 file:cursor-pointer"
          />
          <button
            onClick={handleUpload}
            disabled={uploading || !uploadFile || !uploadName.trim()}
            data-testid="radio-music-upload"
            className="w-full py-2.5 bg-amber-500 hover:bg-amber-400 text-slate-900 font-bold rounded-lg disabled:opacity-60 disabled:cursor-not-allowed flex items-center justify-center gap-2"
            title={
              !uploadFile ? 'Pick an MP3 file first' :
              !uploadName.trim() ? 'Enter a track name above' :
              'Upload track'
            }
          >
            {uploading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Upload className="w-4 h-4" />}
            {uploading
              ? 'Uploading...'
              : !uploadFile
                ? 'Pick a file above'
                : !uploadName.trim()
                  ? 'Enter a track name above'
                  : 'Upload track'}
          </button>
        </div>

        <div className="mt-5 pt-4 border-t border-slate-700/50">
          <h3 className="text-xs uppercase tracking-wider text-slate-400 font-bold mb-2">Free music sources</h3>
          <ul className="text-xs text-slate-400 space-y-1 list-disc list-inside">
            <li><a href="https://studio.youtube.com/channel/UC/music" target="_blank" rel="noreferrer" className="text-amber-400 hover:underline">YouTube Audio Library</a> — free, commercial-OK</li>
            <li><a href="https://www.bensound.com/royalty-free-music" target="_blank" rel="noreferrer" className="text-amber-400 hover:underline">Bensound</a> — free with attribution</li>
            <li><a href="https://pixabay.com/music/" target="_blank" rel="noreferrer" className="text-amber-400 hover:underline">Pixabay Music</a> — free, no attribution required</li>
          </ul>
        </div>
      </div>

      <div className="bg-slate-800/60 backdrop-blur border border-slate-700/50 rounded-2xl p-4 sm:p-5 shadow-xl">
        <h2 className="text-lg font-bold mb-3 flex items-center gap-2">
          <Music className="w-5 h-5 text-amber-400" />
          Music library
          <span className="text-xs text-slate-400 font-normal">({music.length})</span>
        </h2>
        {music.length === 0 && (
          <p className="text-sm text-slate-400 py-8 text-center">No tracks yet. Upload your first one on the left.</p>
        )}
        <div className="space-y-2 max-h-[600px] overflow-y-auto pr-1">
          {music.map((t) => (
            <div key={t.id} className="bg-slate-900/60 border border-slate-700/50 rounded-lg p-3" data-testid={`radio-music-card-${t.id}`}>
              <div className="flex items-start justify-between gap-2 mb-1">
                <div className="min-w-0 flex-1">
                  <div className="font-semibold text-sm truncate">{t.name}</div>
                  <div className="text-[11px] text-slate-400 truncate">
                    {t.duration_seconds ? `${t.duration_seconds}s` : '—'}
                    {' · '}
                    {Math.round((t.audio_bytes || 0) / 1024)} KB
                  </div>
                </div>
                <button
                  onClick={() => handleDelete(t.id)}
                  className="p-1.5 text-red-400 hover:text-red-300 hover:bg-slate-800 rounded flex-shrink-0"
                  title="Delete"
                  data-testid={`radio-music-delete-${t.id}`}
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
              <audio
                controls
                src={`${API}/radio-studio/stream/music/${t.id}`}
                className="w-full h-8 mt-2"
                data-testid={`radio-music-preview-${t.id}`}
              />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/* ----------------------------------------------------------------
   Playlist tab — drag-to-reorder sequence of ads + music
---------------------------------------------------------------- */
function PlaylistTab({ ads, music, playlist, onPlaylistChange }) {
  const [items, setItems] = useState(playlist.items || []);
  const [saving, setSaving] = useState(false);
  const [playingIdx, setPlayingIdx] = useState(null);
  const [audioEl, setAudioEl] = useState(null);

  useEffect(() => {
    setItems(playlist.items || []);
  }, [playlist]);

  const addItem = (type, refId) => {
    setItems([...items, { type, ref_id: refId }]);
  };

  const removeAt = (idx) => {
    setItems(items.filter((_, i) => i !== idx));
  };

  const moveItem = (from, to) => {
    if (to < 0 || to >= items.length) return;
    const next = [...items];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    setItems(next);
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      await axios.post(`${API}/admin/radio-studio/playlist`, {
        name: playlist.name || 'Default Playlist',
        items,
        is_active: true,
      }, { headers: tokenHdr() });
      toast.success('Playlist saved');
      onPlaylistChange();
    } catch (e) {
      toast.error(`Save failed: ${e?.response?.data?.detail || e.message}`);
    } finally {
      setSaving(false);
    }
  };

  // Resolve each playlist item to its full data for display.
  const resolved = items.map((it, idx) => {
    if (it.type === 'ad') {
      const ad = ads.find((a) => a.id === it.ref_id);
      // Cache-bust the ad audio URL by its generated_at so regenerated
      // ads always play the freshly-written MP3, not a stale browser-
      // cached version of the same {id}.mp3 file.
      const adStream = ad?.audio_filename
        ? `${API}/radio-studio/stream/ad/${ad.id}${ad.generated_at ? `?v=${encodeURIComponent(ad.generated_at)}` : ''}`
        : null;
      return { ...it, idx, label: ad?.name || 'Missing ad', sub: ad?.voice_name, duration: ad?.duration_seconds, streamUrl: adStream, missing: !ad };
    }
    const tr = music.find((m) => m.id === it.ref_id);
    return { ...it, idx, label: tr?.name || 'Missing track', sub: 'music', duration: tr?.duration_seconds, streamUrl: tr ? `${API}/radio-studio/stream/music/${tr.id}` : null, missing: !tr };
  });

  const totalSeconds = resolved.reduce((s, r) => s + (r.duration || 0), 0);

  // Sequential play-through (preview the whole playlist).
  const playFrom = (idx) => {
    if (audioEl) audioEl.pause();
    const r = resolved[idx];
    if (!r?.streamUrl) {
      toast.error(`Item ${idx + 1} has no audio yet`);
      return;
    }
    setPlayingIdx(idx);
    const a = new Audio(r.streamUrl);
    a.onended = () => {
      if (idx + 1 < resolved.length) {
        playFrom(idx + 1);
      } else {
        setPlayingIdx(null);
      }
    };
    a.onerror = () => {
      toast.error(`Failed to play ${r.label}`);
      setPlayingIdx(null);
    };
    // 24 May 2026 — `audio.play()` returns a Promise that can REJECT
    // (browser autoplay policies, blocked tab, file not ready). The
    // old code awaited it implicitly so failures were silent.
    const playPromise = a.play();
    if (playPromise?.catch) {
      playPromise.catch((err) => {
        toast.error(`Playback blocked: ${err?.message || 'browser refused'}`);
        setPlayingIdx(null);
      });
    }
    setAudioEl(a);
  };

  const stopPlay = () => {
    if (audioEl) audioEl.pause();
    setPlayingIdx(null);
  };

  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
      {/* Asset picker */}
      <div className="lg:col-span-1 space-y-4">
        <div className="bg-slate-800/60 backdrop-blur border border-slate-700/50 rounded-2xl p-4">
          <h3 className="text-sm font-bold mb-2 flex items-center gap-2">
            <Mic className="w-4 h-4 text-amber-400" /> Add ad
          </h3>
          {ads.length === 0 && <p className="text-xs text-slate-400">Create ads in the Ads tab first.</p>}
          <div className="space-y-1 max-h-72 overflow-y-auto pr-1">
            {ads.map((ad) => (
              <button
                key={ad.id}
                onClick={() => addItem('ad', ad.id)}
                disabled={!ad.audio_filename}
                title={ad.audio_filename ? 'Add to playlist' : 'Generate audio first'}
                className="w-full text-left text-xs bg-slate-900/60 hover:bg-amber-500/10 border border-slate-700/50 hover:border-amber-500/50 rounded px-2 py-1.5 flex items-center justify-between gap-2 disabled:opacity-40 disabled:cursor-not-allowed transition-all"
                data-testid={`radio-playlist-add-ad-${ad.id}`}
              >
                <span className="truncate">{ad.name}</span>
                <Plus className="w-3 h-3 flex-shrink-0 text-amber-400" />
              </button>
            ))}
          </div>
        </div>
        <div className="bg-slate-800/60 backdrop-blur border border-slate-700/50 rounded-2xl p-4">
          <h3 className="text-sm font-bold mb-2 flex items-center gap-2">
            <Music className="w-4 h-4 text-amber-400" /> Add music
          </h3>
          {music.length === 0 && <p className="text-xs text-slate-400">Upload tracks in the Music Library tab first.</p>}
          <div className="space-y-1 max-h-72 overflow-y-auto pr-1">
            {music.map((tr) => (
              <button
                key={tr.id}
                onClick={() => addItem('music', tr.id)}
                className="w-full text-left text-xs bg-slate-900/60 hover:bg-amber-500/10 border border-slate-700/50 hover:border-amber-500/50 rounded px-2 py-1.5 flex items-center justify-between gap-2 transition-all"
                data-testid={`radio-playlist-add-music-${tr.id}`}
              >
                <span className="truncate">{tr.name}</span>
                <Plus className="w-3 h-3 flex-shrink-0 text-amber-400" />
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Playlist builder */}
      <div className="lg:col-span-2 bg-slate-800/60 backdrop-blur border border-slate-700/50 rounded-2xl p-4 sm:p-5 shadow-xl">
        <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
          <h2 className="text-lg font-bold flex items-center gap-2">
            <ListMusic className="w-5 h-5 text-amber-400" />
            Playlist
            <span className="text-xs text-slate-400 font-normal">
              ({items.length} items · ~{Math.round(totalSeconds / 60)} min)
            </span>
          </h2>
          <div className="flex gap-2">
            {playingIdx === null ? (
              <button
                onClick={() => playFrom(0)}
                disabled={resolved.length === 0}
                data-testid="radio-playlist-play"
                className="flex items-center gap-1 px-3 py-1.5 text-xs font-bold bg-emerald-500 hover:bg-emerald-400 text-slate-900 rounded-lg disabled:opacity-40 disabled:cursor-not-allowed"
              >
                <Play className="w-3.5 h-3.5" /> Play preview
              </button>
            ) : (
              <button
                onClick={stopPlay}
                data-testid="radio-playlist-stop"
                className="flex items-center gap-1 px-3 py-1.5 text-xs font-bold bg-red-500 hover:bg-red-400 text-white rounded-lg"
              >
                <Pause className="w-3.5 h-3.5" /> Stop
              </button>
            )}
            <button
              onClick={handleSave}
              disabled={saving}
              data-testid="radio-playlist-save"
              className="flex items-center gap-1 px-3 py-1.5 text-xs font-bold bg-amber-500 hover:bg-amber-400 text-slate-900 rounded-lg disabled:opacity-60 disabled:cursor-wait"
            >
              {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
              Save playlist
            </button>
          </div>
        </div>
        {resolved.length === 0 && (
          <p className="text-sm text-slate-400 py-12 text-center">
            Empty playlist. Click an ad or track on the left to add it here.
          </p>
        )}
        <div className="space-y-1.5">
          {resolved.map((r) => (
            <div
              key={`${r.idx}-${r.type}-${r.ref_id}`}
              data-testid={`radio-playlist-item-${r.idx}`}
              className={`flex items-center gap-2 p-2 rounded-lg border ${
                playingIdx === r.idx
                  ? 'bg-emerald-500/10 border-emerald-500/50 ring-1 ring-emerald-500/30'
                  : r.missing
                    ? 'bg-red-500/10 border-red-500/30'
                    : 'bg-slate-900/40 border-slate-700/50'
              }`}
            >
              <GripVertical className="w-4 h-4 text-slate-500 flex-shrink-0" />
              <div className="flex flex-col gap-0.5 flex-shrink-0">
                <button
                  onClick={() => moveItem(r.idx, r.idx - 1)}
                  disabled={r.idx === 0}
                  className="text-[10px] text-slate-400 hover:text-amber-300 disabled:opacity-30"
                  title="Move up"
                >▲</button>
                <button
                  onClick={() => moveItem(r.idx, r.idx + 1)}
                  disabled={r.idx === resolved.length - 1}
                  className="text-[10px] text-slate-400 hover:text-amber-300 disabled:opacity-30"
                  title="Move down"
                >▼</button>
              </div>
              <span className={`text-[10px] font-bold uppercase px-1.5 py-0.5 rounded flex-shrink-0 ${
                r.type === 'ad' ? 'bg-amber-500/20 text-amber-300' : 'bg-blue-500/20 text-blue-300'
              }`}>
                {r.type}
              </span>
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium truncate">{r.label}</div>
                <div className="text-[11px] text-slate-400 truncate">
                  {r.sub}{r.duration ? ` · ${r.duration}s` : ''}{r.missing ? ' · MISSING' : ''}
                </div>
              </div>
              <button
                onClick={() => playFrom(r.idx)}
                disabled={!r.streamUrl}
                className="p-1 text-emerald-400 hover:bg-slate-800 rounded disabled:opacity-30"
                title="Play from here"
              >
                <Volume2 className="w-3.5 h-3.5" />
              </button>
              <button
                onClick={() => removeAt(r.idx)}
                className="p-1 text-red-400 hover:bg-slate-800 rounded"
                title="Remove"
                data-testid={`radio-playlist-remove-${r.idx}`}
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
