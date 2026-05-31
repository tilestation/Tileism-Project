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
  Plus, Save, Upload, Sparkles, GripVertical, Volume2, Globe, PoundSterling,
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
      <div className="flex flex-wrap gap-1 mb-5 bg-slate-800/50 p-1 rounded-xl backdrop-blur border border-slate-700/50 w-fit">
        {[
          { key: 'ads', label: 'Ads', icon: Mic },
          { key: 'music', label: 'Music Library', icon: Music },
          { key: 'playlist', label: 'Playlist', icon: ListMusic },
          { key: 'usage', label: 'Usage & cost', icon: PoundSterling },
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
          music={music}
          onAdsChange={loadAds}
        />
      )}
      {tab === 'music' && <MusicTab music={music} ads={ads} onMusicChange={loadMusic} />}
      {tab === 'playlist' && (
        <PlaylistTab
          ads={ads}
          music={music}
          playlist={playlist}
          onPlaylistChange={loadPlaylist}
        />
      )}
      {tab === 'usage' && <UsageTab />}
    </div>
  );
}

/* ----------------------------------------------------------------
   Ads tab — script editor + voice picker + generate
---------------------------------------------------------------- */
function AdsTab({ voices, voicesLoading, onResyncVoices, ads, music, onAdsChange }) {
  const [editingAd, setEditingAd] = useState(null);  // null = compose new
  const [form, setForm] = useState({
    name: '',
    // 31 May 2026 — multi-kind segments. `kind` switches which
    // form fields are shown and which backend path generates audio.
    //   'ad'         → script + 1 voice (single ElevenLabs call)
    //   'qa'         → question + answer + 1 voice
    //   'trade_talk' → host + guest voices + N turns (concat)
    kind: 'ad',
    script: '',
    voice_id: '',
    voice_name: '',
    // Q&A
    question: '',
    narrate_question: true,
    // Trade Talk
    host_voice_id: '',
    host_voice_name: '',
    guest_voice_id: '',
    guest_voice_name: '',
    turns: [],
    stability: 0.5,
    similarity_boost: 0.75,
    style: 0,
    model_id: 'eleven_multilingual_v2',
    bed_music_id: '',
    bed_volume_pct: 18,
    pronunciation_hints: '',
  });
  const [saving, setSaving] = useState(false);
  const [generatingId, setGeneratingId] = useState(null);
  // 30 May 2026 — separate state from generatingId so the Test
  // Voice spinner can show while a different ad is mid-generate.
  const [testingId, setTestingId] = useState(null);
  // 31 May 2026 — "Seed starter content" button state.
  const [seeding, setSeeding] = useState(false);

  const handleSeedStarter = async () => {
    if (!window.confirm('Insert the starter library — 20 Q&A pairs + 10 Trade Talk topics — as drafts? Safe to re-run, won\'t overwrite anything you\'ve edited.')) return;
    setSeeding(true);
    try {
      const r = await axios.post(`${API}/admin/radio-studio/seed-starter-content`, {}, { headers: tokenHdr() });
      const { inserted_qa, inserted_trade_talk, skipped } = r.data;
      if (inserted_qa + inserted_trade_talk > 0) {
        toast.success(`Added ${inserted_qa} Q&As + ${inserted_trade_talk} Trade Talk drafts${skipped ? ` · ${skipped} already existed` : ''}`);
        onAdsChange();
      } else {
        toast.info(`All ${skipped} starter items already in your library`);
      }
    } catch (e) {
      toast.error(`Seed failed: ${e?.response?.data?.detail || e.message}`);
    } finally {
      setSeeding(false);
    }
  };
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
      kind: 'ad',
      script: '',
      voice_id: '',
      voice_name: '',
      question: '',
      narrate_question: true,
      host_voice_id: '',
      host_voice_name: '',
      guest_voice_id: '',
      guest_voice_name: '',
      turns: [],
      stability: 0.5,
      similarity_boost: 0.75,
      style: 0,
      model_id: 'eleven_multilingual_v2',
      bed_music_id: '',
      bed_volume_pct: 18,
      pronunciation_hints: '',
    });
  };

  const startEdit = (ad) => {
    setEditingAd(ad);
    setForm({
      name: ad.name,
      kind: ad.kind || 'ad',
      script: ad.script || '',
      voice_id: ad.voice_id || '',
      voice_name: ad.voice_name || '',
      question: ad.question || '',
      narrate_question: ad.narrate_question !== false,
      host_voice_id: ad.host_voice_id || '',
      host_voice_name: ad.host_voice_name || '',
      guest_voice_id: ad.guest_voice_id || '',
      guest_voice_name: ad.guest_voice_name || '',
      turns: Array.isArray(ad.turns) ? ad.turns.map((t) => ({ ...t })) : [],
      stability: ad.stability ?? 0.5,
      similarity_boost: ad.similarity_boost ?? 0.75,
      style: ad.style ?? 0,
      model_id: ad.model_id || 'eleven_multilingual_v2',
      bed_music_id: ad.bed_music_id || '',
      bed_volume_pct: ad.bed_volume_pct ?? 18,
      pronunciation_hints: ad.pronunciation_hints || '',
    });
  };

  const handleSave = async () => {
    // Validation differs by kind. 'ad' needs script+voice; 'qa' needs
    // question+answer+voice; 'trade_talk' needs ≥1 turn + both voices.
    if (!form.name.trim()) {
      toast.error('Name is required');
      return;
    }
    if (form.kind === 'ad') {
      if (!form.script.trim() || !form.voice_id) {
        toast.error('Script and voice are required for an ad');
        return;
      }
    } else if (form.kind === 'qa') {
      if (!form.question.trim()) {
        toast.error('Q&A needs a question');
        return;
      }
      if (!form.script.trim()) {
        toast.error('Q&A needs an answer');
        return;
      }
      if (!form.voice_id) {
        toast.error('Pick a voice for the narrator');
        return;
      }
    } else if (form.kind === 'trade_talk') {
      if (!form.turns || form.turns.length === 0) {
        toast.error('Add at least one dialogue turn');
        return;
      }
      if (!form.host_voice_id || !form.guest_voice_id) {
        toast.error('Pick host AND guest voices');
        return;
      }
      if (form.turns.some((t) => !t.text || !t.text.trim())) {
        toast.error('Every turn needs some text — remove empty turns first');
        return;
      }
    }
    setSaving(true);
    try {
      const selectedVoice = voices.find((v) => v.voice_id === form.voice_id);
      const selectedHost = voices.find((v) => v.voice_id === form.host_voice_id);
      const selectedGuest = voices.find((v) => v.voice_id === form.guest_voice_id);
      const body = {
        ...form,
        voice_name: selectedVoice?.name || form.voice_name,
        host_voice_name: selectedHost?.name || form.host_voice_name,
        guest_voice_name: selectedGuest?.name || form.guest_voice_name,
      };
      if (editingAd) {
        await axios.put(`${API}/admin/radio-studio/ads/${editingAd.id}`, body, { headers: tokenHdr() });
        toast.success('Segment updated');
      } else {
        await axios.post(`${API}/admin/radio-studio/ads`, body, { headers: tokenHdr() });
        toast.success('Segment saved');
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

  // 30 May 2026 — Test voice. Synthesises only the first ~180
  // normalised characters of the ad's script and plays them inline.
  // ~£0.0002 per preview (vs ~£0.005 for a full 30s ad). Lets the
  // admin sanity-check pronunciations (£, URLs) before committing.
  const handleTestVoice = async (adId) => {
    setTestingId(adId);
    try {
      // axios+blob — backend returns audio/mpeg bytes inline.
      const r = await axios.post(
        `${API}/admin/radio-studio/ads/${adId}/test-voice`,
        {},
        { headers: tokenHdr(), responseType: 'blob' },
      );
      const url = URL.createObjectURL(r.data);
      const audio = new Audio(url);
      // Revoke the blob URL once playback finishes (or fails) so
      // we don't leak object URLs across many previews.
      const cleanup = () => URL.revokeObjectURL(url);
      audio.addEventListener('ended', cleanup, { once: true });
      audio.addEventListener('error', cleanup, { once: true });
      await audio.play();
    } catch (e) {
      const detail = e?.response?.data?.detail;
      // axios responseType=blob keeps `data` as a Blob even on
      // error — try to parse the JSON error body if there is one.
      if (e?.response?.data && typeof e.response.data.text === 'function') {
        try {
          const text = await e.response.data.text();
          const parsed = JSON.parse(text);
          toast.error(`Test voice failed: ${parsed.detail || text}`);
          return;
        } catch (_e) { /* fall through */ }
      }
      toast.error(`Test voice failed: ${detail || e.message}`);
    } finally {
      setTestingId(null);
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

          {/* Kind switcher — 3 pill tabs at the top of the form
              determining which fields are shown below. (31 May 2026
              user request: Trade Talk + Q&A segments.) */}
          <div>
            <label className="block text-xs uppercase tracking-wider text-slate-400 font-bold mb-1">
              Segment type
            </label>
            <div className="flex gap-1 p-1 bg-slate-900/60 border border-slate-700 rounded-lg w-fit" data-testid="radio-kind-tabs">
              {[
                { key: 'ad', label: 'Ad', icon: Mic, hint: 'Single-voice promo or announcement' },
                { key: 'qa', label: 'Q&A', icon: Volume2, hint: 'Ask the Showroom — customer question, narrated answer' },
                { key: 'trade_talk', label: 'Trade Talk', icon: Radio, hint: 'Multi-turn dialogue between expert + builder' },
              ].map((opt) => {
                const Icon = opt.icon;
                const active = form.kind === opt.key;
                return (
                  <button
                    key={opt.key}
                    type="button"
                    onClick={() => setForm({ ...form, kind: opt.key })}
                    data-testid={`radio-kind-${opt.key}`}
                    title={opt.hint}
                    className={`px-3 py-1.5 rounded-md text-xs font-bold flex items-center gap-1.5 transition-all ${
                      active
                        ? 'bg-amber-500 text-slate-900 shadow'
                        : 'text-slate-300 hover:bg-slate-800/70'
                    }`}
                  >
                    <Icon className="w-3.5 h-3.5" />
                    {opt.label}
                  </button>
                );
              })}
            </div>
            <p className="text-[10px] text-slate-500 mt-1">
              {form.kind === 'ad' && 'Standard 15-45 second promo. One voice. One ElevenLabs call per generate.'}
              {form.kind === 'qa' && 'A customer-style question + your narrated answer. Costs ~£0.05 per generate.'}
              {form.kind === 'trade_talk' && 'Phone-in style dialogue. Each turn renders in its own voice — 8-15 turns typical. Costs ~£0.20-0.40 per episode.'}
            </p>
          </div>

          {/* 24 May 2026 — AI auto-generate panel. Collapsed by
              default so manual scripting (the existing UX) stays the
              primary path. Click to expand → fill keywords → click
              Generate. The LLM's text lands in the Script textarea
              below, ready to edit. Voice selection is independent —
              the admin still picks the voice + tuning separately.
              (31 May 2026 — only shows for 'ad' kind; Q&A and
              Trade Talk have their own generators below.) */}
          {form.kind === 'ad' && (
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
          )}

          {/* SCRIPT + VOICE — only for kind=ad. Q&A reuses these
              fields under different labels below; Trade Talk has
              its own turn editor. */}
          {form.kind === 'ad' && (
          <>
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
          </>
          )}

          {/* Q&A FORM — kind='qa'. The narrator reads the question
              first (with a comma pause), then the answer. Same voice
              picker as 'ad' below, but the "script" field is split
              into Question + Answer for clarity. (31 May 2026.) */}
          {form.kind === 'qa' && (
            <QaFields
              form={form}
              setForm={setForm}
              voices={voices}
              voicesLoading={voicesLoading}
              onResyncVoices={onResyncVoices}
              groupedVoices={groupedVoices}
            />
          )}

          {/* TRADE TALK FORM — kind='trade_talk'. Host + Guest voices
              + N editable turns + Generate-from-prompt button.
              (31 May 2026.) */}
          {form.kind === 'trade_talk' && (
            <TradeTalkFields
              form={form}
              setForm={setForm}
              voices={voices}
              voicesLoading={voicesLoading}
              onResyncVoices={onResyncVoices}
              groupedVoices={groupedVoices}
            />
          )}

          {/* Music bed — optional background track mixed under the
              voice with sidechain ducking. Defaults to none = clean
              narration (existing behaviour). (26 May 2026) */}
          <div className="bg-slate-900/40 rounded-lg px-3 py-3 border border-slate-700/40">
            <label className="block text-xs font-bold text-slate-300 mb-2 flex items-center gap-2">
              <Music className="w-3.5 h-3.5 text-fuchsia-400" />
              Background music bed
              <span className="text-[10px] font-normal text-slate-500">(optional — adds energy)</span>
            </label>
            <select
              data-testid="radio-ad-bed-select"
              value={form.bed_music_id}
              onChange={(e) => setForm({ ...form, bed_music_id: e.target.value })}
              className="w-full px-2 py-1.5 bg-slate-900 border border-slate-600 rounded text-xs"
            >
              <option value="">— No music bed (voice only) —</option>
              {(music || []).map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}{m.duration_seconds ? ` · ${Math.round(m.duration_seconds)}s` : ''}
                </option>
              ))}
            </select>
            {(music || []).length === 0 && (
              <p className="mt-1.5 text-[11px] text-slate-500">
                Upload a royalty-free track on the <span className="text-fuchsia-300 font-semibold">Music</span> tab first to use it as a bed.
              </p>
            )}
            {form.bed_music_id && (
              <div className="mt-3">
                <label className="block text-[11px] text-slate-400 mb-0.5">
                  Bed volume: <span className="text-fuchsia-300 font-mono">{form.bed_volume_pct}%</span>
                  <span className="ml-2 text-slate-500 text-[10px]">Voice always sits on top — bed ducks automatically while talking</span>
                </label>
                <input
                  data-testid="radio-ad-bed-volume"
                  type="range"
                  min="0"
                  max="50"
                  step="1"
                  value={form.bed_volume_pct}
                  onChange={(e) => setForm({ ...form, bed_volume_pct: parseInt(e.target.value, 10) })}
                  className="w-full accent-fuchsia-500"
                />
                <div className="flex justify-between text-[10px] text-slate-500 mt-0.5">
                  <span>Silent</span>
                  <span>18% (recommended)</span>
                  <span>50% (loud)</span>
                </div>
              </div>
            )}
          </div>

          {/* Pronunciation hints — per-ad word substitution applied
              before TTS. Useful for brand/product names ElevenLabs
              gets wrong. (30 May 2026 user request.) */}
          <details className="bg-slate-900/40 rounded-lg px-3 py-2">
            <summary className="text-xs font-bold text-slate-300 cursor-pointer flex items-center gap-2">
              <Mic className="w-3 h-3 text-amber-400" />
              Pronunciation hints
              <span className="text-[10px] font-normal text-slate-500">
                ({(form.pronunciation_hints || '').split('\n').filter((l) => l.trim() && !l.trim().startsWith('#') && /[:=→]|->|is pronounced/i.test(l)).length} active)
              </span>
            </summary>
            <div className="mt-2 space-y-2">
              <textarea
                value={form.pronunciation_hints}
                onChange={(e) => setForm({ ...form, pronunciation_hints: e.target.value })}
                placeholder={'porcelain: por-suh-lin\ncatalogue → cat-uh-log\nLa Dolce = lah-doll-chay\nCarrara is pronounced kar-RAR-uh'}
                rows={4}
                maxLength={4000}
                data-testid="radio-ad-pronunciation-hints"
                className="w-full px-2 py-1.5 bg-slate-900 border border-slate-600 rounded text-xs text-slate-100 placeholder-slate-600 focus:border-amber-500 focus:outline-none font-mono resize-y"
              />
              <p className="text-[10px] text-slate-500 leading-relaxed">
                One <span className="text-amber-300 font-bold">word : phonetic</span> pair per line. Supports
                <span className="font-mono mx-1">:</span>
                <span className="font-mono mx-1">=</span>
                <span className="font-mono mx-1">→</span>
                <span className="font-mono mx-1">-&gt;</span>
                or <span className="font-mono">is pronounced</span> as separators.
                Lines starting with <span className="font-mono">#</span> are notes (ignored).
                Click <span className="text-fuchsia-300 font-semibold">Test voice</span> on the saved ad to verify.
              </p>
            </div>
          </details>

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
          Segment library
          <span className="text-xs text-slate-400 font-normal">({ads.length})</span>
          <button
            type="button"
            onClick={handleSeedStarter}
            disabled={seeding}
            data-testid="radio-seed-starter"
            title="Insert 20 Q&A pairs + 10 Trade Talk topics as drafts. Safe to re-run — won't overwrite your edits."
            className="ml-auto px-2 py-1 bg-purple-600 hover:bg-purple-500 disabled:opacity-50 disabled:cursor-wait text-white text-[10px] font-bold rounded flex items-center gap-1"
          >
            {seeding ? <Loader2 className="w-3 h-3 animate-spin" /> : <Sparkles className="w-3 h-3" />}
            Seed starter content
          </button>
        </h2>
        {ads.length === 0 && (
          <p className="text-sm text-slate-400 py-8 text-center">
            No segments yet. Write one on the left, or click <span className="text-fuchsia-300 font-bold">Seed starter content</span> above for 30 ready-made Q&As and Trade Talk topics.
          </p>
        )}
        <div className="space-y-2 max-h-[600px] overflow-y-auto pr-1">
          {ads.map((ad) => (
            <div key={ad.id} className="bg-slate-900/60 border border-slate-700/50 rounded-lg p-3" data-testid={`radio-ad-card-${ad.id}`}>
              <div className="flex items-start justify-between gap-2 mb-1">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5 mb-0.5">
                    {/* Kind badge — at-a-glance type indicator. */}
                    {(() => {
                      const k = ad.kind || 'ad';
                      const meta = {
                        ad: { label: 'AD', cls: 'bg-emerald-500/20 text-emerald-300' },
                        qa: { label: 'Q&A', cls: 'bg-amber-500/20 text-amber-300' },
                        trade_talk: { label: 'TRADE TALK', cls: 'bg-fuchsia-500/20 text-fuchsia-300' },
                      }[k] || { label: k.toUpperCase(), cls: 'bg-slate-700 text-slate-300' };
                      return (
                        <span className={`px-1.5 py-0.5 rounded text-[9px] font-bold uppercase tracking-wider ${meta.cls}`}>
                          {meta.label}
                        </span>
                      );
                    })()}
                    <div className="font-semibold text-sm truncate">{ad.name}</div>
                  </div>
                  <div className="text-[11px] text-slate-400 truncate">
                    {ad.kind === 'trade_talk'
                      ? `${(ad.turns || []).length} turn${(ad.turns || []).length === 1 ? '' : 's'}`
                      : (ad.voice_name || ad.voice_id || '— no voice picked —')}
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
                    onClick={() => handleTestVoice(ad.id)}
                    disabled={testingId === ad.id || generatingId === ad.id}
                    data-testid={`radio-ad-test-voice-${ad.id}`}
                    className="p-1.5 text-fuchsia-400 hover:text-fuchsia-300 hover:bg-slate-800 rounded disabled:opacity-60 disabled:cursor-wait"
                    title="Test voice — play the first sentence to check pronunciations (£, URLs). ~£0.0002"
                  >
                    {testingId === ad.id
                      ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      : <Volume2 className="w-3.5 h-3.5" />}
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
   Music library tab — multi-file uploads with drag-and-drop
   (26 May 2026, user request: "allow me to upload multiple tracks
   at the same time" + "add a drag and drop feature")
---------------------------------------------------------------- */


/* ----------------------------------------------------------------
   Q&A form fields (kind='qa') — Ask the Showroom segment.
   31 May 2026. Two text inputs (Question + Answer), one voice
   picker, one "narrate question first" toggle, one "generate
   answer with Claude" button.
---------------------------------------------------------------- */
function QaFields({ form, setForm, voices, voicesLoading, onResyncVoices, groupedVoices }) {
  const [aiBusy, setAiBusy] = useState(false);

  const handleGenerate = async () => {
    if (!form.question.trim()) {
      toast.error('Type a question first — the LLM needs something to answer');
      return;
    }
    setAiBusy(true);
    try {
      const r = await axios.post(
        `${API}/admin/radio-studio/scripts/generate-qa`,
        { question: form.question.trim(), tone: 'expert' },
        { headers: tokenHdr() },
      );
      setForm({
        ...form,
        script: r.data.answer,
        name: form.name || r.data.suggested_name,
      });
      toast.success(`Answer written (~${r.data.approx_seconds}s)`);
    } catch (e) {
      toast.error(`Generation failed: ${e?.response?.data?.detail || e.message}`);
    } finally {
      setAiBusy(false);
    }
  };

  return (
    <div className="space-y-3">
      <div>
        <label className="block text-xs uppercase tracking-wider text-slate-400 font-bold mb-1">
          Customer question
        </label>
        <input
          type="text"
          value={form.question}
          onChange={(e) => setForm({ ...form, question: e.target.value })}
          placeholder="e.g. Can I tile straight onto plasterboard in a shower?"
          data-testid="radio-qa-question"
          maxLength={600}
          className="w-full px-3 py-2 bg-slate-900 border border-slate-600 rounded-lg text-sm text-slate-100 placeholder-slate-500 focus:border-amber-500 focus:outline-none"
        />
        <label className="inline-flex items-center gap-2 mt-2 text-[11px] text-slate-400 cursor-pointer">
          <input
            type="checkbox"
            checked={form.narrate_question}
            onChange={(e) => setForm({ ...form, narrate_question: e.target.checked })}
            data-testid="radio-qa-narrate-question"
            className="w-3.5 h-3.5 accent-amber-500"
          />
          Narrate the question out loud before the answer
        </label>
      </div>

      <button
        type="button"
        onClick={handleGenerate}
        disabled={aiBusy || !form.question.trim()}
        data-testid="radio-qa-generate"
        className="w-full py-2 bg-gradient-to-r from-fuchsia-500 to-purple-500 hover:from-fuchsia-400 hover:to-purple-400 text-white font-bold rounded-lg disabled:opacity-50 disabled:cursor-wait transition-all flex items-center justify-center gap-2 text-sm"
      >
        {aiBusy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Sparkles className="w-4 h-4" />}
        {aiBusy ? 'Writing the answer…' : 'Auto-generate answer with Claude'}
      </button>

      <div>
        <label className="block text-xs uppercase tracking-wider text-slate-400 font-bold mb-1">
          Answer
        </label>
        <textarea
          value={form.script}
          onChange={(e) => setForm({ ...form, script: e.target.value })}
          placeholder="Type the answer here, or click 'Auto-generate' above. Edit freely after."
          data-testid="radio-qa-answer"
          rows={8}
          maxLength={4000}
          className="w-full px-3 py-2 bg-slate-900 border border-slate-600 rounded-lg text-sm text-slate-100 placeholder-slate-500 focus:border-amber-500 focus:outline-none resize-y leading-relaxed"
        />
        <p className="text-[10px] text-slate-500 mt-0.5">
          {form.script.split(/\s+/).filter(Boolean).length} words · ~{Math.round(form.script.split(/\s+/).filter(Boolean).length / 2.3)}s read-aloud
        </p>
      </div>

      <VoicePickerInline
        form={form}
        setForm={setForm}
        voices={voices}
        voicesLoading={voicesLoading}
        onResyncVoices={onResyncVoices}
        groupedVoices={groupedVoices}
        fieldKey="voice_id"
        fieldNameKey="voice_name"
        label="Narrator voice"
      />
    </div>
  );
}


/* ----------------------------------------------------------------
   Trade Talk form fields (kind='trade_talk') — host/guest dialogue.
   31 May 2026.
     • Host + Guest voice pickers
     • Editable turn list (add / remove / reorder / edit text / swap speaker)
     • Generate dialogue with Claude from a topic prompt
---------------------------------------------------------------- */
function TradeTalkFields({ form, setForm, voices, voicesLoading, onResyncVoices, groupedVoices }) {
  const [aiTopic, setAiTopic] = useState('');
  const [aiBusy, setAiBusy] = useState(false);
  const [duration, setDuration] = useState(240);

  useEffect(() => {
    if (form.topic && !aiTopic) {
      setAiTopic(form.topic);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form.topic]);

  const handleGenerate = async () => {
    if (!aiTopic.trim()) {
      toast.error('Type a topic first');
      return;
    }
    setAiBusy(true);
    try {
      const r = await axios.post(
        `${API}/admin/radio-studio/scripts/generate-trade-talk`,
        {
          topic: aiTopic.trim(),
          target_duration_seconds: duration,
        },
        { headers: tokenHdr() },
      );
      setForm({
        ...form,
        turns: r.data.turns,
        name: form.name || r.data.suggested_name,
      });
      toast.success(`Dialogue written — ${r.data.turns.length} turns, ~${r.data.approx_seconds}s`);
    } catch (e) {
      toast.error(`Generation failed: ${e?.response?.data?.detail || e.message}`);
    } finally {
      setAiBusy(false);
    }
  };

  const updateTurn = (idx, patch) => {
    setForm({
      ...form,
      turns: form.turns.map((t, i) => (i === idx ? { ...t, ...patch } : t)),
    });
  };

  const removeTurn = (idx) => {
    setForm({ ...form, turns: form.turns.filter((_, i) => i !== idx) });
  };

  const addTurn = (speaker) => {
    const last = form.turns[form.turns.length - 1];
    const defaultSpeaker = last ? (last.speaker === 'host' ? 'guest' : 'host') : 'host';
    setForm({
      ...form,
      turns: [...form.turns, { speaker: speaker || defaultSpeaker, text: '' }],
    });
  };

  const moveTurn = (from, to) => {
    if (to < 0 || to >= form.turns.length) return;
    const next = [...form.turns];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    setForm({ ...form, turns: next });
  };

  const totalWords = form.turns.reduce(
    (sum, t) => sum + (t.text || '').split(/\s+/).filter(Boolean).length, 0,
  );

  return (
    <div className="space-y-3">
      {/* Claude generator for dialogue */}
      <div className="bg-gradient-to-br from-purple-900/40 to-fuchsia-900/30 border border-purple-500/30 rounded-lg p-3 space-y-2">
        <div className="flex items-center gap-2 text-xs font-bold text-fuchsia-300">
          <Sparkles className="w-4 h-4" />
          Generate dialogue from a topic
        </div>
        <input
          type="text"
          value={aiTopic}
          onChange={(e) => setAiTopic(e.target.value)}
          placeholder="e.g. Laying porcelain over electric underfloor heating in a 35 m² kitchen"
          data-testid="radio-talk-topic"
          maxLength={400}
          className="w-full px-3 py-2 bg-slate-900 border border-slate-600 rounded-lg text-sm text-slate-100 placeholder-slate-500 focus:border-fuchsia-500 focus:outline-none"
        />
        <div className="flex flex-wrap items-center gap-2">
          <label className="text-[11px] text-slate-400 flex items-center gap-1.5">
            Target length:
            <select
              value={duration}
              onChange={(e) => setDuration(parseInt(e.target.value, 10))}
              data-testid="radio-talk-duration"
              className="px-2 py-1 bg-slate-900 border border-slate-600 rounded text-xs"
            >
              <option value={120}>2 min · ~8 turns</option>
              <option value={180}>3 min · ~10 turns</option>
              <option value={240}>4 min · ~12 turns</option>
              <option value={360}>6 min · ~16 turns</option>
            </select>
          </label>
          <button
            type="button"
            onClick={handleGenerate}
            disabled={aiBusy || !aiTopic.trim()}
            data-testid="radio-talk-generate"
            className="ml-auto px-4 py-1.5 bg-fuchsia-500 hover:bg-fuchsia-400 disabled:opacity-50 disabled:cursor-wait text-white font-bold rounded-lg text-xs flex items-center gap-1.5"
          >
            {aiBusy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Sparkles className="w-3.5 h-3.5" />}
            {aiBusy ? 'Writing…' : 'Write dialogue'}
          </button>
        </div>
        <p className="text-[10px] text-fuchsia-300/60 leading-snug">
          ✓ Claude writes the whole conversation · ✓ Every turn editable below · ✓ Doesn&apos;t cost ElevenLabs credits until you click Generate Audio
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <VoicePickerInline
          form={form}
          setForm={setForm}
          voices={voices}
          voicesLoading={voicesLoading}
          onResyncVoices={onResyncVoices}
          groupedVoices={groupedVoices}
          fieldKey="host_voice_id"
          fieldNameKey="host_voice_name"
          label="Host voice (the expert)"
          colour="amber"
        />
        <VoicePickerInline
          form={form}
          setForm={setForm}
          voices={voices}
          voicesLoading={voicesLoading}
          onResyncVoices={onResyncVoices}
          groupedVoices={groupedVoices}
          fieldKey="guest_voice_id"
          fieldNameKey="guest_voice_name"
          label="Guest voice (the builder)"
          colour="fuchsia"
        />
      </div>

      <div>
        <label className="flex items-center justify-between text-xs uppercase tracking-wider text-slate-400 font-bold mb-2">
          <span>
            Dialogue · {form.turns.length} turn{form.turns.length === 1 ? '' : 's'}
            <span className="text-slate-600 normal-case text-[10px] font-normal ml-2">
              ({totalWords} words · ~{Math.round(totalWords / 2.1)}s)
            </span>
          </span>
          <button
            type="button"
            onClick={() => addTurn()}
            data-testid="radio-talk-add-turn"
            className="px-2 py-1 bg-slate-700 hover:bg-slate-600 text-slate-200 rounded text-[11px] font-bold flex items-center gap-1"
          >
            <Plus className="w-3 h-3" /> Add turn
          </button>
        </label>
        {form.turns.length === 0 ? (
          <div className="text-xs text-slate-500 bg-slate-900/40 border border-dashed border-slate-700 rounded-lg p-4 text-center">
            No turns yet. Click <span className="text-fuchsia-300 font-bold">Write dialogue</span> above to auto-generate, or <span className="text-amber-300 font-bold">Add turn</span> to write manually.
          </div>
        ) : (
          <div className="space-y-2" data-testid="radio-talk-turns">
            {form.turns.map((turn, idx) => (
              <div
                key={idx}
                data-testid={`radio-talk-turn-${idx}`}
                className={`bg-slate-900/40 border rounded-lg p-2.5 space-y-1.5 ${
                  turn.speaker === 'host' ? 'border-amber-500/30' : 'border-fuchsia-500/30'
                }`}
              >
                <div className="flex items-center gap-2 text-xs">
                  <button
                    type="button"
                    onClick={() => updateTurn(idx, { speaker: turn.speaker === 'host' ? 'guest' : 'host' })}
                    data-testid={`radio-talk-speaker-${idx}`}
                    className={`px-2 py-0.5 rounded-md font-bold uppercase tracking-wider text-[10px] cursor-pointer transition-colors ${
                      turn.speaker === 'host'
                        ? 'bg-amber-500/20 text-amber-300 hover:bg-amber-500/30'
                        : 'bg-fuchsia-500/20 text-fuchsia-300 hover:bg-fuchsia-500/30'
                    }`}
                    title="Click to swap host ↔ guest"
                  >
                    {turn.speaker}
                  </button>
                  <span className="text-[10px] text-slate-500">
                    {(turn.text || '').split(/\s+/).filter(Boolean).length} words
                  </span>
                  <div className="ml-auto flex items-center gap-1">
                    <button
                      type="button"
                      onClick={() => moveTurn(idx, idx - 1)}
                      disabled={idx === 0}
                      className="p-1 text-slate-500 hover:text-slate-200 disabled:opacity-30 rounded"
                      title="Move up"
                    >
                      ▲
                    </button>
                    <button
                      type="button"
                      onClick={() => moveTurn(idx, idx + 1)}
                      disabled={idx === form.turns.length - 1}
                      className="p-1 text-slate-500 hover:text-slate-200 disabled:opacity-30 rounded"
                      title="Move down"
                    >
                      ▼
                    </button>
                    <button
                      type="button"
                      onClick={() => removeTurn(idx)}
                      data-testid={`radio-talk-remove-${idx}`}
                      className="p-1 text-slate-500 hover:text-red-400 rounded"
                      title="Remove turn"
                    >
                      <Trash2 className="w-3 h-3" />
                    </button>
                  </div>
                </div>
                <textarea
                  value={turn.text}
                  onChange={(e) => updateTurn(idx, { text: e.target.value })}
                  rows={Math.max(2, Math.ceil((turn.text || '').length / 80))}
                  maxLength={2000}
                  placeholder={turn.speaker === 'host'
                    ? "What does the expert say here?"
                    : "What does the builder ask here?"}
                  data-testid={`radio-talk-text-${idx}`}
                  className="w-full px-2 py-1.5 bg-slate-950/60 border border-slate-700/50 rounded text-sm text-slate-100 placeholder-slate-600 focus:border-amber-500 focus:outline-none resize-y leading-snug"
                />
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}


/* ----------------------------------------------------------------
   Inline voice picker — reusable for Q&A narrator + Trade Talk
   host/guest. Same UX as the full voice picker in the 'ad' form
   but parameterised by which form field it writes to.
---------------------------------------------------------------- */
function VoicePickerInline({
  form, setForm, voices, voicesLoading, onResyncVoices,
  groupedVoices, fieldKey, fieldNameKey, label, colour = 'amber',
}) {
  const accent = colour === 'fuchsia' ? 'text-fuchsia-400' : 'text-amber-400';
  const focus = colour === 'fuchsia' ? 'focus:border-fuchsia-500' : 'focus:border-amber-500';
  return (
    <div>
      <label className="flex items-center justify-between text-xs uppercase tracking-wider text-slate-400 font-bold mb-1">
        <span>{label}</span>
        <button
          type="button"
          onClick={onResyncVoices}
          disabled={voicesLoading}
          className={`text-[11px] ${accent} hover:underline flex items-center gap-1`}
        >
          {voicesLoading ? <Loader2 className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3" />}
          Resync
        </button>
      </label>
      <select
        value={form[fieldKey] || ''}
        onChange={(e) => {
          const v = voices.find((x) => x.voice_id === e.target.value);
          setForm({ ...form, [fieldKey]: e.target.value, [fieldNameKey]: v?.name || '' });
        }}
        data-testid={`radio-${fieldKey.replace(/_/g, '-')}`}
        className={`w-full px-3 py-2 bg-slate-900 border border-slate-600 rounded-lg text-sm text-slate-100 ${focus} focus:outline-none`}
      >
        <option value="">— Pick a voice —</option>
        {groupedVoices.map(([groupName, groupVoices]) => (
          <optgroup key={groupName} label={groupName}>
            {groupVoices.map((v) => (
              <option key={v.voice_id} value={v.voice_id}>
                {v.name}{v.labels?.gender ? ` · ${v.labels.gender}` : ''}{v.labels?.accent ? ` · ${v.labels.accent}` : ''}
              </option>
            ))}
          </optgroup>
        ))}
      </select>
      {form[fieldKey] && (() => {
        const v = voices.find((x) => x.voice_id === form[fieldKey]);
        return v?.preview_url ? (
          <audio controls src={v.preview_url} className="w-full h-7 mt-1.5" />
        ) : null;
      })()}
    </div>
  );
}


function MusicTab({ music, ads, onMusicChange }) {
  // Each queue entry: { id, source: 'file'|'url', file?, url?, name, status, error }
  //   status: 'pending' | 'uploading' | 'done' | 'error'
  // ID is just an in-memory counter so we can React-key each row.
  const [queue, setQueue] = useState([]);
  const [uploading, setUploading] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  // 26 May 2026 — bulk-import-from-URL field. Textarea (one URL per
  // line) so admins can paste a single YouTube link OR a list of
  // 10 Bensound tracks in one go.
  const [urlInput, setUrlInput] = useState('');
  const fileInputRef = React.useRef(null);
  const queueIdRef = React.useRef(0);

  // 31 May 2026 — Test playback. Builds a 3-item Music→Ad→Music
  // sequence so the admin can audit volume parity from their office
  // speakers instead of walking into a showroom every tweak.
  // We trim each item to ~10 s by default so the whole test is <40 s.
  const [testSeq, setTestSeq] = useState(null);          // [{type,label,id}] | null
  const [testIdx, setTestIdx] = useState(0);             // which step is playing
  const [testTrim, setTestTrim] = useState(true);        // cap each step to 10 s
  const testAudioRef = React.useRef(null);
  const testTrimTimerRef = React.useRef(null);

  // Strip extension + common YouTube/SoundCloud hash prefixes +
  // trailing "(Official)"/"(Audio)" cruft so the name is shop-ready
  // straight out of the box.
  const deriveName = (filename) => {
    let n = filename.replace(/\.[^.]+$/, '');         // drop extension
    n = n.replace(/^[a-z0-9-_]{8,}-/i, '');           // drop hash prefixes
    n = n.replace(/\s*\([^)]*\)\s*$/, '').trim();     // drop "(Official)"
    return n;
  };

  // Smart guess for a "looks like a URL we'd give yt-dlp" string.
  // Doesn't validate completely — backend has the real check, this
  // is just so we can show a meaningful "Skipped N invalid lines"
  // toast when the admin pastes random text.
  const looksLikeUrl = (s) => {
    const t = (s || '').trim();
    return /^https?:\/\/[^\s]+$/i.test(t);
  };

  const ingestFiles = (filesLike) => {
    const arr = Array.from(filesLike || []);
    if (!arr.length) return;
    const audioOnly = arr.filter((f) => (f.type || '').startsWith('audio/') || /\.(mp3|wav|ogg|m4a|aac|flac)$/i.test(f.name));
    const rejected = arr.length - audioOnly.length;
    if (rejected > 0) {
      toast.error(`Skipped ${rejected} non-audio file${rejected === 1 ? '' : 's'}`);
    }
    // 15 MB backend cap (MAX_AUDIO_BYTES) — flag oversize files
    // BEFORE the user clicks Upload so they don't wait for a 413.
    const sized = audioOnly.map((file) => {
      const oversize = file.size > 15 * 1024 * 1024;
      return {
        id: ++queueIdRef.current,
        source: 'file',
        file,
        name: deriveName(file.name),
        status: oversize ? 'error' : 'pending',
        error: oversize ? `Too big (${Math.round(file.size / 1024 / 1024)} MB · 15 MB max)` : null,
      };
    });
    setQueue((q) => [...q, ...sized]);
  };

  const onDrop = (e) => {
    e.preventDefault();
    e.stopPropagation();
    setDragOver(false);
    ingestFiles(e.dataTransfer?.files);
  };

  const onDragOver = (e) => {
    e.preventDefault();
    if (!dragOver) setDragOver(true);
  };

  const onDragLeave = (e) => {
    e.preventDefault();
    setDragOver(false);
  };

  const onPickFiles = (e) => {
    ingestFiles(e.target.files);
    // Reset so picking the same file twice still fires onChange.
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  // Parse the textarea into URL queue rows. Skips blank lines and
  // anything that doesn't start with http(s):// (admin pasted a
  // title by mistake, etc).
  const handleAddUrls = () => {
    const lines = urlInput.split('\n').map((l) => l.trim()).filter(Boolean);
    if (!lines.length) {
      toast.error('Paste at least one URL');
      return;
    }
    const valid = lines.filter(looksLikeUrl);
    const invalid = lines.length - valid.length;
    if (invalid > 0) {
      toast.error(`Skipped ${invalid} invalid line${invalid === 1 ? '' : 's'} (must start with http:// or https://)`);
    }
    if (!valid.length) return;
    const newRows = valid.map((url) => ({
      id: ++queueIdRef.current,
      source: 'url',
      url,
      // Blank name — the backend extracts the title from the source
      // and uses that. The admin can override before clicking Upload.
      name: '',
      status: 'pending',
      error: null,
    }));
    setQueue((q) => [...q, ...newRows]);
    setUrlInput('');
    toast.success(`Added ${valid.length} URL${valid.length === 1 ? '' : 's'} to queue`);
  };

  const updateName = (id, name) => {
    setQueue((q) => q.map((it) => (it.id === id ? { ...it, name } : it)));
  };

  const removeFromQueue = (id) => {
    setQueue((q) => q.filter((it) => it.id !== id));
  };

  const clearDone = () => {
    setQueue((q) => q.filter((it) => it.status !== 'done'));
  };

  const handleUploadAll = async () => {
    const targets = queue.filter((q) => q.status === 'pending');
    if (!targets.length) {
      toast.error('Nothing to upload');
      return;
    }
    // File rows REQUIRE a name (we can't infer one from the file
    // beyond what we already did). URL rows can leave name blank —
    // backend extracts the title from yt-dlp metadata.
    const blanks = targets.filter((t) => t.source === 'file' && !t.name.trim());
    if (blanks.length) {
      toast.error(`${blanks.length} file${blanks.length === 1 ? '' : 's'} need a name`);
      return;
    }
    setUploading(true);
    let successCount = 0;
    let failCount = 0;
    // Sequential — keeps backend load predictable + lets the admin
    // watch each row flip status in real time.
    for (const t of targets) {
      setQueue((q) => q.map((it) => (it.id === t.id ? { ...it, status: 'uploading' } : it)));
      try {
        if (t.source === 'url') {
          await axios.post(
            `${API}/admin/radio-studio/music/import-url`,
            { url: t.url, name: t.name.trim() || null },
            { headers: tokenHdr() },
          );
        } else {
          const fd = new FormData();
          fd.append('name', t.name.trim());
          fd.append('file', t.file);
          // DO NOT set Content-Type — axios auto-builds it with the
          // multipart boundary. (24 May 2026 bug.)
          await axios.post(`${API}/admin/radio-studio/music/upload`, fd, { headers: tokenHdr() });
        }
        setQueue((q) => q.map((it) => (it.id === t.id ? { ...it, status: 'done' } : it)));
        successCount++;
      } catch (e) {
        const detail = e?.response?.data?.detail || e.message || 'Upload failed';
        setQueue((q) => q.map((it) => (it.id === t.id ? { ...it, status: 'error', error: detail } : it)));
        failCount++;
      }
    }
    if (successCount && !failCount) {
      toast.success(`Added ${successCount} track${successCount === 1 ? '' : 's'}`);
    } else if (successCount && failCount) {
      toast.warning(`Added ${successCount}, ${failCount} failed`);
    } else {
      toast.error(`${failCount} failed`);
    }
    onMusicChange();
    setUploading(false);
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

  const pendingCount = queue.filter((q) => q.status === 'pending').length;
  const doneCount = queue.filter((q) => q.status === 'done').length;

  // ---- Test playback (volume parity audit) ----------------------
  // Build a Music → Ad → Music sequence using whatever is in the
  // library + generated-ad pool. Pick distinct random items so the
  // admin hears a real-world snippet, not the same track twice.
  // Generated ads are filtered to those with audio_filename set
  // (i.e. ElevenLabs render completed).
  const playableAds = (ads || []).filter((a) => a.audio_filename);

  const startTestSequence = () => {
    if (music.length < 1 || playableAds.length < 1) {
      toast.error('Need at least 1 music track AND 1 generated ad in the library.');
      return;
    }
    const pickRandom = (arr, exclude = null) => {
      const pool = exclude ? arr.filter((x) => x.id !== exclude) : arr;
      return pool[Math.floor(Math.random() * pool.length)] || arr[0];
    };
    const m1 = pickRandom(music);
    const ad = pickRandom(playableAds);
    const m2 = pickRandom(music, m1.id);
    const seq = [
      { type: 'music', id: m1.id, label: m1.name },
      { type: 'ad', id: ad.id, label: ad.name },
      { type: 'music', id: m2.id, label: m2.name },
    ];
    setTestSeq(seq);
    setTestIdx(0);
  };

  const stopTestSequence = () => {
    if (testAudioRef.current) {
      testAudioRef.current.pause();
      testAudioRef.current.removeAttribute('src');
      testAudioRef.current.load();
    }
    if (testTrimTimerRef.current) {
      clearTimeout(testTrimTimerRef.current);
      testTrimTimerRef.current = null;
    }
    setTestSeq(null);
    setTestIdx(0);
  };

  // Effect: when testSeq + testIdx change, load and play the audio
  // for the current step. Set up `ended` handler to advance, and a
  // trim-timer to cap each item at 10 s if testTrim is on.
  React.useEffect(() => {
    if (!testSeq || testIdx >= testSeq.length) {
      // Sequence finished
      if (testSeq && testIdx >= testSeq.length) {
        toast.success('Test playback complete — did the volumes match?');
        setTestSeq(null);
        setTestIdx(0);
      }
      return;
    }
    const step = testSeq[testIdx];
    const audio = testAudioRef.current;
    if (!audio) return;
    const url =
      step.type === 'music'
        ? `${API}/radio-studio/stream/music/${step.id}`
        : `${API}/radio-studio/stream/ad/${step.id}`;
    audio.src = url;
    audio.volume = 1.0;
    audio
      .play()
      .catch((err) => {
        toast.error(`Playback blocked by browser: ${err.message}`);
        stopTestSequence();
      });
    const onEnded = () => setTestIdx((i) => i + 1);
    audio.addEventListener('ended', onEnded, { once: true });
    if (testTrim) {
      testTrimTimerRef.current = setTimeout(() => {
        audio.removeEventListener('ended', onEnded);
        setTestIdx((i) => i + 1);
      }, 10_000);
    }
    return () => {
      audio.removeEventListener('ended', onEnded);
      if (testTrimTimerRef.current) {
        clearTimeout(testTrimTimerRef.current);
        testTrimTimerRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [testSeq, testIdx, testTrim]);

  // Cleanup on unmount
  React.useEffect(() => {
    return () => {
      if (testTrimTimerRef.current) clearTimeout(testTrimTimerRef.current);
    };
  }, []);
  // ----------------------------------------------------------------

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
      <div className="bg-slate-800/60 backdrop-blur border border-slate-700/50 rounded-2xl p-4 sm:p-5 shadow-xl">
        <h2 className="text-lg font-bold mb-3 flex items-center gap-2">
          <Upload className="w-5 h-5 text-amber-400" />
          Upload music tracks
        </h2>
        <p className="text-xs text-slate-400 mb-3 leading-relaxed">
          Royalty-free MP3s only (e.g. YouTube Audio Library, Epidemic Sound free tier, Bensound). Max 15 MB per track.
          Drop multiple files at once — name each one and click Upload all.
        </p>

        {/* Drag-and-drop zone — also clickable to open file picker. */}
        <div
          onDragOver={onDragOver}
          onDragEnter={onDragOver}
          onDragLeave={onDragLeave}
          onDrop={onDrop}
          onClick={() => fileInputRef.current?.click()}
          data-testid="radio-music-dropzone"
          className={`relative cursor-pointer border-2 border-dashed rounded-xl px-4 py-8 text-center transition-all ${
            dragOver
              ? 'border-amber-400 bg-amber-500/10 scale-[1.01]'
              : 'border-slate-600 hover:border-amber-500/60 hover:bg-amber-500/5'
          }`}
        >
          <Upload className={`w-8 h-8 mx-auto mb-2 ${dragOver ? 'text-amber-300' : 'text-slate-400'}`} />
          <p className="text-sm font-bold text-slate-200">
            {dragOver ? 'Drop to add to upload queue' : 'Drop audio files here'}
          </p>
          <p className="text-[11px] text-slate-500 mt-0.5">
            or <span className="text-amber-400 underline underline-offset-2">click to pick from your computer</span> · MP3/WAV/M4A · multi-select supported
          </p>
          <input
            ref={fileInputRef}
            type="file"
            accept="audio/*"
            multiple
            onChange={onPickFiles}
            data-testid="radio-music-file"
            className="hidden"
          />
        </div>

        {/* Bulk-import from URL — paste one or more public URLs and
            the backend uses yt-dlp+ffmpeg to download + transcode
            them to 128 kbps MP3 in one shot. (26 May 2026 user
            request.) */}
        <div className="mt-4 bg-slate-900/40 rounded-xl border border-slate-700/40 p-3">
          <div className="flex items-center gap-2 mb-2">
            <Globe className="w-4 h-4 text-fuchsia-400" />
            <span className="text-xs font-bold text-slate-200">Or import from URL</span>
            <span className="text-[10px] text-slate-500">
              YouTube / Bensound / SoundCloud / direct .mp3 link
            </span>
          </div>
          <textarea
            value={urlInput}
            onChange={(e) => setUrlInput(e.target.value)}
            placeholder="https://www.youtube.com/watch?v=...&#10;https://www.bensound.com/.../track.mp3&#10;(one URL per line)"
            data-testid="radio-music-url-input"
            rows={2}
            className="w-full px-3 py-2 bg-slate-900 border border-slate-600 rounded-lg text-xs text-slate-100 placeholder-slate-500 focus:border-fuchsia-500 focus:outline-none resize-y font-mono"
          />
          <div className="flex items-center justify-between mt-2 gap-2">
            <p className="text-[10px] text-slate-500">
              Title is auto-extracted from the source. Backend transcodes to 128 kbps MP3 · 15 MB cap.
            </p>
            <button
              type="button"
              onClick={handleAddUrls}
              disabled={!urlInput.trim()}
              data-testid="radio-music-url-add"
              className="flex-shrink-0 px-3 py-1.5 bg-fuchsia-500 hover:bg-fuchsia-400 disabled:bg-slate-700 disabled:text-slate-500 text-white text-xs font-bold rounded-lg flex items-center gap-1.5 transition-all"
            >
              <Plus className="w-3.5 h-3.5" />
              Add to queue
            </button>
          </div>
        </div>

        {/* Upload queue — per-file row with editable name + status */}
        {queue.length > 0 && (
          <div className="mt-4 space-y-2" data-testid="radio-music-queue">
            <div className="flex items-center justify-between text-[11px] text-slate-400">
              <span>
                {queue.length} item{queue.length === 1 ? '' : 's'} queued
                {doneCount ? ` · ${doneCount} done` : ''}
              </span>
              {doneCount > 0 && (
                <button
                  type="button"
                  onClick={clearDone}
                  className="text-amber-400 hover:text-amber-300 underline"
                >
                  Clear done
                </button>
              )}
            </div>
            <div className="max-h-72 overflow-y-auto space-y-1.5 pr-1">
              {queue.map((it) => (
                <div
                  key={it.id}
                  data-testid={`radio-music-queue-row-${it.id}`}
                  className={`flex items-center gap-2 px-2.5 py-2 rounded-lg border ${
                    it.status === 'done'
                      ? 'bg-emerald-500/10 border-emerald-500/30'
                      : it.status === 'error'
                        ? 'bg-red-500/10 border-red-500/30'
                        : it.status === 'uploading'
                          ? 'bg-amber-500/10 border-amber-500/40'
                          : 'bg-slate-900/60 border-slate-700/50'
                  }`}
                >
                  <div className="flex-shrink-0 w-5 h-5 flex items-center justify-center">
                    {it.status === 'uploading' && <Loader2 className="w-4 h-4 animate-spin text-amber-400" />}
                    {it.status === 'done' && <span className="text-emerald-400 text-sm font-bold">✓</span>}
                    {it.status === 'error' && <span className="text-red-400 text-sm font-bold">!</span>}
                    {it.status === 'pending' && (
                      it.source === 'url'
                        ? <Globe className="w-4 h-4 text-fuchsia-400" />
                        : <Music className="w-4 h-4 text-slate-500" />
                    )}
                  </div>
                  <input
                    type="text"
                    value={it.name}
                    onChange={(e) => updateName(it.id, e.target.value)}
                    disabled={it.status === 'uploading' || it.status === 'done'}
                    placeholder={it.source === 'url' ? 'Name (auto from source title)' : 'Track name'}
                    className="flex-1 min-w-0 bg-transparent border-none text-sm text-slate-100 placeholder-slate-500 focus:outline-none disabled:text-slate-400"
                  />
                  <span className="text-[10px] text-slate-500 font-mono flex-shrink-0 truncate max-w-[140px]" title={it.source === 'url' ? it.url : undefined}>
                    {it.source === 'url'
                      ? (() => {
                          try {
                            return new URL(it.url).hostname.replace(/^www\./, '');
                          } catch { return 'url'; }
                        })()
                      : `${(it.file.size / 1024 / 1024).toFixed(1)} MB`}
                  </span>
                  {it.error && (
                    <span
                      className="text-[10px] text-red-300 truncate max-w-[160px]"
                      title={it.error}
                    >
                      {it.error}
                    </span>
                  )}
                  <button
                    type="button"
                    onClick={() => removeFromQueue(it.id)}
                    disabled={it.status === 'uploading'}
                    className="p-1 text-slate-500 hover:text-red-400 disabled:opacity-30 rounded"
                    title="Remove from queue"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}

        <button
          onClick={handleUploadAll}
          disabled={uploading || pendingCount === 0}
          data-testid="radio-music-upload"
          className="mt-4 w-full py-2.5 bg-amber-500 hover:bg-amber-400 text-slate-900 font-bold rounded-lg disabled:opacity-60 disabled:cursor-not-allowed flex items-center justify-center gap-2 transition-all"
          title={pendingCount === 0 ? 'Add files first' : `Upload ${pendingCount} track${pendingCount === 1 ? '' : 's'}`}
        >
          {uploading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Upload className="w-4 h-4" />}
          {uploading
            ? `Uploading… (${queue.filter((q) => q.status === 'done').length}/${queue.filter((q) => q.status !== 'pending').length})`
            : pendingCount === 0
              ? 'Add files to upload'
              : `Upload ${pendingCount} track${pendingCount === 1 ? '' : 's'}`}
        </button>

        <div className="mt-5 pt-4 border-t border-slate-700/50">
          <h3 className="text-xs uppercase tracking-wider text-slate-400 font-bold mb-2">Free music sources</h3>
          <ul className="text-xs text-slate-400 space-y-1 list-disc list-inside">
            <li><a href="https://studio.youtube.com/channel/UC/music" target="_blank" rel="noreferrer" className="text-amber-400 hover:underline">YouTube Audio Library</a> — free, commercial-OK</li>
            <li><a href="https://www.bensound.com/royalty-free-music" target="_blank" rel="noreferrer" className="text-amber-400 hover:underline">Bensound</a> — free with attribution</li>
            <li><a href="https://pixabay.com/music/" target="_blank" rel="noreferrer" className="text-amber-400 hover:underline">Pixabay Music</a> — free, no attribution required</li>
          </ul>
        </div>
      </div>

      {/* Test Playback — Music → Ad → Music sequence for volume-parity audit. */}
      <div className="bg-slate-800/60 backdrop-blur border border-slate-700/50 rounded-2xl p-4 sm:p-5 shadow-xl lg:col-span-2">
        <div className="flex items-start sm:items-center justify-between gap-3 flex-wrap">
          <div className="min-w-0">
            <h2 className="text-lg font-bold flex items-center gap-2">
              <Play className="w-5 h-5 text-emerald-400" />
              Volume-parity test
              <span className="text-[10px] uppercase tracking-wider text-emerald-300 bg-emerald-500/15 border border-emerald-500/30 px-1.5 py-0.5 rounded">
                Office speakers
              </span>
            </h2>
            <p className="text-xs text-slate-400 mt-1 leading-relaxed">
              Plays a random <span className="text-slate-200 font-semibold">Music → Ad → Music</span> sequence — exactly like in-store.
              Listen for whether the ad is at the same loudness as the music. Trim mode caps each step at 10 s so the test takes under 40 seconds.
            </p>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <label className="flex items-center gap-1.5 text-xs text-slate-300 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={testTrim}
                onChange={(e) => setTestTrim(e.target.checked)}
                disabled={!!testSeq}
                className="accent-emerald-500"
                data-testid="radio-test-trim-toggle"
              />
              Trim each step to 10 s
            </label>
            {!testSeq ? (
              <button
                type="button"
                onClick={startTestSequence}
                disabled={music.length < 1 || playableAds.length < 1}
                data-testid="radio-test-playback-start"
                className="text-xs px-4 py-2 rounded-md bg-emerald-500 text-white hover:bg-emerald-600 disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-1.5 font-semibold transition"
              >
                <Play className="w-3.5 h-3.5" />
                Play Music → Ad → Music
              </button>
            ) : (
              <button
                type="button"
                onClick={stopTestSequence}
                data-testid="radio-test-playback-stop"
                className="text-xs px-4 py-2 rounded-md bg-red-500/20 text-red-200 border border-red-500/40 hover:bg-red-500/30 flex items-center gap-1.5 font-semibold transition"
              >
                <Pause className="w-3.5 h-3.5" />
                Stop
              </button>
            )}
          </div>
        </div>

        {(music.length < 1 || playableAds.length < 1) && (
          <p className="text-[11px] text-amber-300 mt-3" data-testid="radio-test-playback-disabled-hint">
            {music.length < 1 && playableAds.length < 1
              ? 'Upload at least 1 music track AND generate at least 1 ad first.'
              : music.length < 1
              ? 'Upload at least 1 music track first.'
              : 'Generate at least 1 ad first (Ads tab → click Generate).'}
          </p>
        )}

        {testSeq && (
          <div className="mt-4 bg-slate-900/60 border border-slate-700/40 rounded-lg p-3" data-testid="radio-test-playback-active">
            <div className="flex items-center gap-2 text-[11px] uppercase tracking-wider text-slate-400 mb-2 font-bold">
              <span>Step {testIdx + 1} of {testSeq.length}</span>
              <span className="text-slate-600">·</span>
              <span>Now playing</span>
            </div>
            <div className="space-y-1.5">
              {testSeq.map((step, i) => (
                <div
                  key={`${step.type}-${step.id}-${i}`}
                  className={`flex items-center gap-2 text-sm rounded px-2 py-1.5 transition ${
                    i === testIdx
                      ? step.type === 'ad'
                        ? 'bg-fuchsia-500/15 text-fuchsia-100 border border-fuchsia-500/40 ring-1 ring-fuchsia-400/30'
                        : 'bg-amber-500/15 text-amber-100 border border-amber-500/40 ring-1 ring-amber-400/30'
                      : i < testIdx
                      ? 'text-slate-500 line-through'
                      : 'text-slate-400 border border-slate-700/30'
                  }`}
                  data-testid={`radio-test-step-${i}`}
                >
                  {i === testIdx && <Play className="w-3 h-3 flex-shrink-0 animate-pulse" />}
                  <span className="text-[10px] uppercase tracking-wider font-bold w-12 flex-shrink-0">
                    {step.type === 'ad' ? 'Ad' : 'Music'}
                  </span>
                  <span className="truncate flex-1">{step.label}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Hidden audio element — controlled by the sequence effect. */}
        <audio ref={testAudioRef} preload="auto" data-testid="radio-test-playback-audio" />
      </div>

      <div className="bg-slate-800/60 backdrop-blur border border-slate-700/50 rounded-2xl p-4 sm:p-5 shadow-xl">
        <div className="flex items-center justify-between gap-2 mb-3 flex-wrap">
          <h2 className="text-lg font-bold flex items-center gap-2">
            <Music className="w-5 h-5 text-amber-400" />
            Music library
            <span className="text-xs text-slate-400 font-normal">({music.length})</span>
          </h2>
          <button
            type="button"
            onClick={async () => {
              if (!window.confirm(
                'Re-process every un-normalised track + ad to the −16 LUFS loudness target?\n\n' +
                'This brings older content up to the same volume as new uploads/ads.\n' +
                'Each track takes 1-2 seconds. Safe to run multiple times.'
              )) return;
              const tId = toast.loading('Normalising library… this can take a minute');
              try {
                const r = await axios.post(
                  `${API}/admin/radio-studio/music/normalize-existing`,
                  {},
                  { headers: tokenHdr() }
                );
                const { music_normalised, ads_normalised, music_failed, ads_failed } = r.data;
                toast.success(
                  `Normalised ${music_normalised} track(s) + ${ads_normalised} ad(s)` +
                  (music_failed + ads_failed > 0
                    ? ` · ${music_failed + ads_failed} skipped (already done or unreadable)`
                    : ''),
                  { id: tId }
                );
                onMusicChange();
              } catch (e) {
                toast.error(
                  `Normalisation failed: ${e?.response?.data?.detail || e.message}`,
                  { id: tId }
                );
              }
            }}
            data-testid="radio-music-normalize-existing-btn"
            className="text-[11px] px-3 py-1.5 rounded-md bg-amber-500/15 border border-amber-500/40 text-amber-200 hover:bg-amber-500/25 transition flex items-center gap-1.5"
            title="Bring older tracks up to the same volume as new uploads"
          >
            <RefreshCw className="w-3 h-3" />
            Normalise volume across library
          </button>
        </div>
        {music.length === 0 && (
          <p className="text-sm text-slate-400 py-8 text-center">No tracks yet. Upload your first one on the left.</p>
        )}
        <div className="space-y-2 max-h-[600px] overflow-y-auto pr-1">
          {music.map((t) => (
            <div key={t.id} className="bg-slate-900/60 border border-slate-700/50 rounded-lg p-3" data-testid={`radio-music-card-${t.id}`}>
              <div className="flex items-start justify-between gap-2 mb-1">
                <div className="min-w-0 flex-1">
                  <div className="font-semibold text-sm truncate flex items-center gap-1.5">
                    {t.name}
                    {t.loudnorm_applied && (
                      <span
                        className="text-[9px] uppercase tracking-wider px-1.5 py-0.5 rounded bg-emerald-500/20 text-emerald-300 border border-emerald-500/30"
                        title={`Normalised to ${t.loudnorm_target_lufs || -16} LUFS`}
                        data-testid={`radio-music-normalised-badge-${t.id}`}
                      >
                        ✓ Normalised
                      </span>
                    )}
                  </div>
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
  // 30 May 2026 — repeat toggle. Default true (matches the
  // wall-clock-modulo loop that the backend has always done).
  const [repeat, setRepeat] = useState(playlist.repeat !== false);
  const [saving, setSaving] = useState(false);
  const [playingIdx, setPlayingIdx] = useState(null);
  const [audioEl, setAudioEl] = useState(null);

  useEffect(() => {
    setItems(playlist.items || []);
    setRepeat(playlist.repeat !== false);
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
        repeat,
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
    <div className="space-y-5">
      <LiveStreamPanel hasItems={items.length > 0} />
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
          <div className="flex flex-wrap items-center gap-2">
            {/* 30 May 2026 — Repeat toggle. When OFF, the stream
                plays through once and stops. When ON (the default),
                it loops forever using wall-clock-modulo. */}
            <label
              className="flex items-center gap-1.5 px-2.5 py-1.5 bg-slate-900/60 border border-slate-700/50 rounded-lg cursor-pointer hover:border-amber-500/60 transition-colors"
              title={repeat
                ? 'Playlist loops forever. Toggle off for a one-shot play-through.'
                : 'Plays through once then stops. Toggle on to loop.'}
            >
              <input
                type="checkbox"
                checked={repeat}
                onChange={(e) => setRepeat(e.target.checked)}
                data-testid="radio-playlist-repeat"
                className="w-3.5 h-3.5 accent-amber-500"
              />
              <RefreshCw className={`w-3.5 h-3.5 ${repeat ? 'text-amber-400' : 'text-slate-500'}`} />
              <span className={`text-xs font-bold ${repeat ? 'text-amber-300' : 'text-slate-400'}`}>
                Repeat
              </span>
            </label>
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
    </div>
  );
}

/* ----------------------------------------------------------------
   Live stream panel — Phase 2 (26 May 2026)

   The synced live-stream control surface inside the Playlist tab.
   Shows the public tune-in URL, a "Now playing" pill that polls
   /live/now-playing every 4s, an inline preview audio for the
   admin's own desk, and a button to open the public /radio screen
   in a new tab (for the in-store tablet wall display).
---------------------------------------------------------------- */
function LiveStreamPanel({ hasItems }) {
  const [now, setNow] = useState(null);
  const [streamOpen, setStreamOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const audioRef = React.useRef(null);
  const currentRefRef = React.useRef(null);

  const liveUrl = `${API}/radio-studio/live`;
  const publicScreenUrl = `${API_URL}/radio`;

  // Poll now-playing every 4s. Cheap endpoint, no audio blobs.
  const fetchNow = React.useCallback(async () => {
    try {
      const r = await axios.get(`${API}/radio-studio/live/now-playing`);
      setNow(r.data);
      return r.data;
    } catch (_e) {
      return null;
    }
  }, []);

  useEffect(() => {
    let alive = true;
    fetchNow();
    const t = setInterval(() => alive && fetchNow(), 4000);
    return () => { alive = false; clearInterval(t); };
  }, [fetchNow]);

  // Client-orchestrated preview playback. Each store plays the
  // current item FROM THE START (we deliberately don't seek into
  // the track — the stream endpoint doesn't support byte ranges so
  // a seek into unbuffered audio silently fails on most browsers).
  // Stores stay in sync because they all see the same SERVER-
  // reported current item and chain to the next on `ended`. (30 May
  // 2026 bugfix.)
  useEffect(() => {
    if (!streamOpen) return;
    if (!now?.playing || !now?.now?.audio_url) return;
    const audio = audioRef.current;
    if (!audio) return;
    const refKey = `${now.now.type}:${now.now.ref_id}`;
    if (currentRefRef.current === refKey && !audio.paused) return;
    currentRefRef.current = refKey;
    audio.src = `${API_URL}${now.now.audio_url}`;
    audio.play().catch((e) => toast.error(`Preview blocked: ${e?.message || 'tap again'}`));
  }, [streamOpen, now]);

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

  const togglePreview = async () => {
    if (streamOpen) {
      const a = audioRef.current;
      if (a) {
        a.pause();
        a.removeAttribute('src');
        a.load();
      }
      currentRefRef.current = null;
      setStreamOpen(false);
    } else {
      // Re-fetch on user gesture so the audio.play() below isn't
      // blocked by browser autoplay policies.
      await fetchNow();
      setStreamOpen(true);
    }
  };

  const copyUrl = () => {
    navigator.clipboard.writeText(liveUrl).then(() => {
      setCopied(true);
      toast.success('Stream URL copied');
      setTimeout(() => setCopied(false), 1800);
    });
  };

  const cur = now?.now;
  const isAd = cur?.type === 'ad';
  // Drive the admin's preview progress strip off audio.currentTime
  // so it matches what the admin is actually hearing in the
  // preview (rather than the server's wall-clock-derived elapsed).
  // Falls back to the server values when the admin hasn't pressed
  // Preview yet — gives them a still-useful "now playing" badge.
  const [previewPos, setPreviewPos] = useState({ current: 0, duration: 0 });
  useEffect(() => {
    const a = audioRef.current;
    if (!a) return;
    const onTime = () => setPreviewPos({
      current: a.currentTime || 0,
      duration: a.duration || 0,
    });
    a.addEventListener('timeupdate', onTime);
    a.addEventListener('loadedmetadata', onTime);
    return () => {
      a.removeEventListener('timeupdate', onTime);
      a.removeEventListener('loadedmetadata', onTime);
    };
  }, []);
  // Show local audio position while previewing, server elapsed
  // otherwise (so the strip stays useful even without preview).
  const showLocal = streamOpen && previewPos.duration > 0;
  const elapsedDisplay = showLocal ? previewPos.current : (cur?.elapsed_seconds || 0);
  const durationDisplay = showLocal ? previewPos.duration : (cur?.duration_seconds || 0);
  const remainingDisplay = Math.max(0, durationDisplay - elapsedDisplay);

  return (
    <div
      className="bg-gradient-to-br from-fuchsia-950/40 via-slate-900 to-slate-900 border border-fuchsia-700/30 rounded-2xl p-4 sm:p-5 shadow-xl"
      data-testid="radio-live-panel"
    >
      <div className="flex flex-wrap items-center justify-between gap-3 mb-3">
        <div className="flex items-center gap-2">
          <div className="w-9 h-9 rounded-lg bg-gradient-to-br from-fuchsia-500 to-purple-600 flex items-center justify-center shadow-lg shadow-fuchsia-500/30">
            <Radio className="w-5 h-5 text-white" />
          </div>
          <div>
            <h2 className="text-base font-bold flex items-center gap-2">
              Live Stream
              <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold ${
                now?.playing
                  ? 'bg-emerald-500/20 text-emerald-300 ring-1 ring-emerald-500/40'
                  : 'bg-slate-700/60 text-slate-300'
              }`}>
                <span className={`w-1.5 h-1.5 rounded-full ${now?.playing ? 'bg-emerald-400 animate-pulse' : 'bg-slate-500'}`} />
                {now?.playing ? 'ON AIR' : (hasItems ? 'STARTING…' : 'WAITING')}
              </span>
            </h2>
            <p className="text-[11px] text-slate-400">
              All 4 stores tune to one synced loop. ±1s sync window across speakers.
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={togglePreview}
            disabled={!hasItems}
            data-testid="radio-live-preview-toggle"
            className="px-3 py-1.5 bg-fuchsia-500 hover:bg-fuchsia-400 disabled:opacity-40 disabled:cursor-not-allowed text-white text-xs font-bold rounded-lg flex items-center gap-1.5 transition-all"
          >
            {streamOpen ? <Pause className="w-3.5 h-3.5" /> : <Play className="w-3.5 h-3.5" />}
            {streamOpen ? 'Stop preview' : 'Preview here'}
          </button>
          <a
            href={publicScreenUrl}
            target="_blank"
            rel="noreferrer"
            data-testid="radio-live-open-screen"
            className="px-3 py-1.5 bg-white/5 hover:bg-white/10 border border-white/10 text-white text-xs font-bold rounded-lg flex items-center gap-1.5 transition-all"
          >
            <Volume2 className="w-3.5 h-3.5" />
            Open in-store screen
          </a>
        </div>
      </div>

      {/* Now-playing strip */}
      <div className="bg-slate-950/40 rounded-lg p-3 flex flex-wrap items-center gap-3">
        {now?.playing && cur ? (
          <>
            <div className={`w-10 h-10 rounded-lg flex items-center justify-center flex-shrink-0 ${
              isAd
                ? 'bg-gradient-to-br from-amber-400 to-orange-500'
                : 'bg-gradient-to-br from-fuchsia-500 to-purple-600'
            }`}>
              {isAd ? <Mic className="w-5 h-5 text-slate-900" /> : <Music className="w-5 h-5 text-white" />}
            </div>
            <div className="min-w-0 flex-1">
              <div className="text-[10px] uppercase tracking-wider text-slate-500">
                {isAd ? 'Ad on air' : 'Music on air'}
              </div>
              <div className="text-sm font-bold truncate" data-testid="radio-live-now-name">{cur.name}</div>
              <div className="text-[11px] text-slate-400 truncate">
                {isAd && cur.voice_name ? `Voice · ${cur.voice_name}` : null}
                {cur.bed_music_name ? ` · bed ${cur.bed_music_name}` : null}
                {!isAd ? `${Math.round(cur.duration_seconds)}s` : null}
              </div>
            </div>
            <div className="flex-shrink-0 w-32">
              <div className="h-1 bg-slate-800 rounded-full overflow-hidden">
                <div
                  className="h-full bg-gradient-to-r from-amber-400 to-fuchsia-500 transition-all duration-500"
                  style={{
                    width: durationDisplay
                      ? `${Math.min(100, (elapsedDisplay / durationDisplay) * 100)}%`
                      : '0%',
                  }}
                />
              </div>
              <div className="flex justify-between text-[10px] text-slate-500 mt-0.5 font-mono">
                <span>{Math.floor(elapsedDisplay)}s</span>
                <span>-{Math.floor(remainingDisplay)}s</span>
              </div>
            </div>
            {now.next && (
              <div className="text-[11px] text-slate-500 flex-shrink-0 hidden sm:block">
                Up next:&nbsp;<span className="text-slate-300 font-medium">{now.next.name}</span>
              </div>
            )}
          </>
        ) : (
          <div className="text-xs text-slate-400 py-1">
            {now?.reason || 'Loading…'}
          </div>
        )}
      </div>

      {/* Shareable URL strip */}
      <div className="mt-3 flex flex-wrap items-center gap-2 text-[11px]">
        <span className="text-slate-500">Tune-in URL:</span>
        <code
          data-testid="radio-live-url"
          className="px-2 py-1 bg-slate-950/60 border border-slate-700 rounded font-mono text-fuchsia-300 truncate max-w-md"
        >
          {liveUrl}
        </code>
        <button
          type="button"
          onClick={copyUrl}
          data-testid="radio-live-copy-url"
          className="px-2 py-1 bg-white/5 hover:bg-white/10 border border-white/10 rounded font-bold"
        >
          {copied ? 'Copied ✓' : 'Copy'}
        </button>
        <span className="text-slate-500 hidden md:inline">
          · Use this URL in VLC or any continuous-stream audio app. Browsers use the in-store screen page above.
        </span>
      </div>

      <audio ref={audioRef} preload="none" data-testid="radio-live-preview-audio" />
    </div>
  );
}


/* ----------------------------------------------------------------
   Usage & cost tab — total ElevenLabs spend, broken down by
   today / 30 days / lifetime, plus per-ad leaderboard + recent
   activity. (30 May 2026 — user request: "I need a clear breakdown
   on Radio Studio dashboard of total I am spending".)
---------------------------------------------------------------- */
function UsageTab() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState(null);

  const fetchUsage = React.useCallback(async () => {
    try {
      const r = await axios.get(`${API}/admin/radio-studio/usage`, { headers: tokenHdr() });
      setData(r.data);
      setErr(null);
    } catch (e) {
      setErr(e?.response?.data?.detail || e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchUsage();
  }, [fetchUsage]);

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-slate-400 text-sm">
        <Loader2 className="w-4 h-4 animate-spin" /> Loading usage data…
      </div>
    );
  }
  if (err) {
    return (
      <div className="bg-red-500/10 border border-red-500/40 rounded-xl p-4 text-sm text-red-300">
        Failed to load usage: {err}
      </div>
    );
  }
  if (!data) return null;

  const rate = data.rate || {};
  const fmtGbp = (v) => `£${Number(v || 0).toFixed(4).replace(/0+$/, '0').replace(/\.0+$/, '.00')}`;
  const fmtChars = (v) => (v || 0).toLocaleString();

  return (
    <div className="space-y-5" data-testid="radio-usage-tab">
      {/* Headline rate strip */}
      <div className="bg-gradient-to-r from-amber-500/10 to-fuchsia-500/10 border border-amber-500/30 rounded-xl px-4 py-3 text-xs text-slate-300 flex flex-wrap items-center gap-x-4 gap-y-1">
        <span>
          Current rate:&nbsp;<strong className="text-amber-300 font-mono">
            £{rate.gbp_per_1k_chars} / 1,000 chars
          </strong>
        </span>
        <span className="text-slate-500">
          (${rate.usd_per_1k_chars} × {rate.gbp_per_usd} GBP/USD)
        </span>
        <span className="text-slate-500 ml-auto">
          Override with <code className="font-mono text-fuchsia-300">ELEVENLABS_USD_PER_1K_CHARS</code> env var
        </span>
      </div>

      {/* KPI cards — today / 30d / lifetime */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <KpiCard label="Today" stats={data.today} colour="emerald" />
        <KpiCard label="Last 30 days" stats={data.last_30_days} colour="amber" />
        <KpiCard label="Lifetime" stats={data.lifetime} colour="fuchsia" />
      </div>

      {/* Per-ad leaderboard */}
      <div className="bg-slate-800/60 backdrop-blur border border-slate-700/50 rounded-2xl p-4 sm:p-5 shadow-xl">
        <h2 className="text-base font-bold mb-3 flex items-center gap-2">
          <Mic className="w-4 h-4 text-amber-400" />
          Per-ad spend
          <span className="text-xs font-normal text-slate-500">
            (sorted by total £)
          </span>
        </h2>
        {data.by_ad.length === 0 ? (
          <p className="text-sm text-slate-400">
            No ads generated yet. Generate or test-voice any ad and the spend will show up here.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-[10px] uppercase tracking-wider text-slate-500 border-b border-slate-700/60">
                <tr>
                  <th className="text-left py-2 pr-2 font-semibold">Ad</th>
                  <th className="text-right py-2 px-2 font-semibold">Total spend</th>
                  <th className="text-right py-2 px-2 font-semibold hidden sm:table-cell">Generates</th>
                  <th className="text-right py-2 px-2 font-semibold hidden sm:table-cell">Tests</th>
                  <th className="text-right py-2 pl-2 font-semibold hidden md:table-cell">Chars</th>
                  <th className="text-right py-2 pl-2 font-semibold hidden lg:table-cell">Last generated</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-700/40">
                {data.by_ad.map((row) => (
                  <tr key={row.ad_id} className="hover:bg-slate-900/30">
                    <td className="py-2 pr-2 truncate max-w-xs">
                      <span className="font-medium text-slate-200">{row.ad_name}</span>
                    </td>
                    <td className="py-2 px-2 text-right font-mono text-amber-300 font-bold">
                      {fmtGbp(row.gbp)}
                    </td>
                    <td className="py-2 px-2 text-right text-slate-400 hidden sm:table-cell">
                      {row.generate_calls}
                    </td>
                    <td className="py-2 px-2 text-right text-slate-400 hidden sm:table-cell">
                      {row.test_calls}
                    </td>
                    <td className="py-2 pl-2 text-right text-slate-500 font-mono hidden md:table-cell">
                      {fmtChars(row.chars)}
                    </td>
                    <td className="py-2 pl-2 text-right text-slate-500 hidden lg:table-cell whitespace-nowrap">
                      {row.last_generated_at ? new Date(row.last_generated_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) : ''}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Recent activity (last 20) */}
      <div className="bg-slate-800/60 backdrop-blur border border-slate-700/50 rounded-2xl p-4 sm:p-5 shadow-xl">
        <h2 className="text-base font-bold mb-3 flex items-center gap-2">
          <RefreshCw className="w-4 h-4 text-amber-400" />
          Recent activity
          <span className="text-xs font-normal text-slate-500">
            (last 20 calls)
          </span>
          <button
            type="button"
            onClick={fetchUsage}
            className="ml-auto text-xs text-fuchsia-300 hover:text-fuchsia-200 underline"
          >
            Refresh
          </button>
        </h2>
        {data.recent.length === 0 ? (
          <p className="text-sm text-slate-400">No recent activity.</p>
        ) : (
          <div className="space-y-1 max-h-80 overflow-y-auto pr-1">
            {data.recent.map((r, i) => (
              <div
                key={i}
                className="flex items-center gap-2 px-2.5 py-1.5 rounded-md bg-slate-900/40 border border-slate-700/40 text-xs"
              >
                <span className={`flex-shrink-0 w-1.5 h-1.5 rounded-full ${
                  r.endpoint === 'generate' ? 'bg-emerald-400' : 'bg-fuchsia-400'
                }`} />
                <span className="text-slate-500 font-mono w-16 flex-shrink-0 hidden sm:block">
                  {new Date(r.created_at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}
                </span>
                <span className="flex-1 min-w-0 truncate">
                  <span className="text-slate-300 font-medium">{r.ad_name}</span>
                  <span className="text-slate-500 ml-2">
                    {r.endpoint === 'generate' ? 'full generate' : 'test voice'}
                    {r.voice_name ? ` · ${r.voice_name}` : ''}
                  </span>
                </span>
                <span className="text-slate-500 font-mono flex-shrink-0 hidden md:block">
                  {fmtChars(r.chars)} chars
                </span>
                <span className="text-amber-300 font-mono font-bold flex-shrink-0">
                  {fmtGbp(r.gbp)}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Footer note */}
      <p className="text-[11px] text-slate-500 italic leading-relaxed">
        {data.note}
      </p>
    </div>
  );
}

function KpiCard({ label, stats, colour }) {
  const palette = {
    emerald: 'from-emerald-500/15 to-slate-900 border-emerald-500/30 text-emerald-300',
    amber: 'from-amber-500/15 to-slate-900 border-amber-500/30 text-amber-300',
    fuchsia: 'from-fuchsia-500/15 to-slate-900 border-fuchsia-500/30 text-fuchsia-300',
  }[colour] || '';
  return (
    <div className={`bg-gradient-to-br ${palette} border rounded-2xl p-4 shadow-xl`}>
      <div className="text-[11px] uppercase tracking-wider text-slate-400 mb-1">
        {label}
      </div>
      <div className="text-4xl font-extrabold font-mono">
        £{Number(stats.gbp || 0).toFixed(2)}
      </div>
      <div className="mt-2 flex items-center justify-between text-[11px] text-slate-500">
        <span>{stats.calls || 0} call{stats.calls === 1 ? '' : 's'}</span>
        <span className="font-mono">{(stats.chars || 0).toLocaleString()} chars</span>
      </div>
    </div>
  );
}

