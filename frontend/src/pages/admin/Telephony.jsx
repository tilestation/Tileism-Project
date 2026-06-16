/**
 * Telephony Admin (Feb 2026) — `/admin/telephony`.
 *
 * 4 tabs:
 *   Setup    — wizard with the exact Twilio Console clicks + .env keys
 *   Settings — welcome message + ads + recording toggle + hours
 *   Calls    — log table + recording playback
 *   Stats    — today/week/month + 7-day chart
 */
import React, { useEffect, useState, useCallback, useMemo } from 'react';
import axios from 'axios';
import { toast } from 'sonner';
import {
  Phone, PhoneIncoming, PhoneOutgoing, PhoneMissed, PhoneOff, Mic, MicOff,
  Settings, Sparkles, Save, RefreshCw, ExternalLink, AlertTriangle,
  CheckCircle2, Clock, Headphones, Upload, Volume2, Loader2, Copy,
} from 'lucide-react';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { Textarea } from '../../components/ui/textarea';
import { Label } from '../../components/ui/label';
import { Switch } from '../../components/ui/switch';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../../components/ui/tabs';
import ClickToCallButton from '../../components/ClickToCallButton';

const API = process.env.REACT_APP_BACKEND_URL;
const authHeader = () => {
  const t = localStorage.getItem('token');
  return t ? { Authorization: `Bearer ${t}` } : {};
};

export default function TelephonyAdmin() {
  return (
    <div className="p-4 sm:p-6 max-w-7xl mx-auto" data-testid="telephony-page">
      <div className="flex items-center gap-3 mb-4">
        <div className="w-10 h-10 rounded-lg bg-emerald-100 flex items-center justify-center">
          <Phone className="w-5 h-5 text-emerald-700" />
        </div>
        <div>
          <h1 className="text-xl font-bold">Telephony</h1>
          <p className="text-xs text-muted-foreground">
            Twilio Voice call centre — welcome message, hold ads, recording,
            click-to-call &amp; call log.
          </p>
        </div>
      </div>

      <Tabs defaultValue="settings" data-testid="telephony-tabs">
        <TabsList>
          <TabsTrigger value="settings" data-testid="tab-settings">Settings</TabsTrigger>
          <TabsTrigger value="showrooms" data-testid="tab-showrooms">Per-Showroom</TabsTrigger>
          <TabsTrigger value="calls" data-testid="tab-calls">Call Log</TabsTrigger>
          <TabsTrigger value="stats" data-testid="tab-stats">Stats</TabsTrigger>
          <TabsTrigger value="setup" data-testid="tab-setup">Setup</TabsTrigger>
        </TabsList>
        <TabsContent value="settings"><SettingsTab /></TabsContent>
        <TabsContent value="showrooms"><ShowroomRoutesTab /></TabsContent>
        <TabsContent value="calls"><CallsTab /></TabsContent>
        <TabsContent value="stats"><StatsTab /></TabsContent>
        <TabsContent value="setup"><SetupTab /></TabsContent>
      </Tabs>
    </div>
  );
}


/* ─── Tab 1: Settings ─────────────────────────────────────────────── */
function SettingsTab() {
  const [form, setForm] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [regenerating, setRegenerating] = useState(false);

  const fetchSettings = useCallback(async () => {
    setLoading(true);
    try {
      const r = await axios.get(`${API}/api/admin/voice/settings`, { headers: authHeader() });
      setForm(r.data);
    } catch (e) {
      toast.error(`Load failed: ${e?.response?.data?.detail || e.message}`);
    } finally { setLoading(false); }
  }, []);
  useEffect(() => { fetchSettings(); }, [fetchSettings]);

  const save = async () => {
    if (!form) return;
    setSaving(true);
    try {
      const r = await axios.put(`${API}/api/admin/voice/settings`, form, { headers: authHeader() });
      setForm(r.data);
      toast.success('Telephony settings saved');
    } catch (e) {
      toast.error(e?.response?.data?.detail || e.message);
    } finally { setSaving(false); }
  };

  const regenerateWelcome = async () => {
    setRegenerating(true);
    try {
      const r = await axios.post(`${API}/api/admin/voice/settings/regenerate-welcome`, {},
        { headers: authHeader() });
      toast.success('Welcome audio regenerated', {
        description: `${r.data.char_count} chars → ${Math.round(r.data.bytes / 1024)} KB`,
      });
      await fetchSettings();
    } catch (e) {
      toast.error(e?.response?.data?.detail || e.message);
    } finally { setRegenerating(false); }
  };

  const uploadManualAd = async (file) => {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async () => {
      const b64 = String(reader.result).split(',')[1];
      try {
        const r = await axios.post(`${API}/api/admin/voice/settings/upload-ad`,
          { file_base64: b64 },
          { headers: authHeader() });
        setForm((f) => ({ ...f, manual_ad_urls: [...(f.manual_ad_urls || []), r.data.audio_url] }));
        toast.success('Ad uploaded — remember to save');
      } catch (e) {
        toast.error(e?.response?.data?.detail || e.message);
      }
    };
    reader.readAsDataURL(file);
  };

  if (loading || !form) {
    return <div className="p-8 text-center text-xs text-muted-foreground">Loading…</div>;
  }

  return (
    <div className="space-y-5 mt-4" data-testid="settings-tab">
      {/* Master switch */}
      <Card>
        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm font-bold">Call centre {form.enabled ? 'ON' : 'OFF'}</p>
            <p className="text-xs text-muted-foreground">When off, callers hear a "phone system unavailable" message and the call ends.</p>
          </div>
          <Switch checked={!!form.enabled}
            onCheckedChange={(v) => setForm({ ...form, enabled: v })}
            data-testid="set-enabled" />
        </div>
      </Card>

      {/* Mobile divert */}
      <Card title="Mobile divert">
        <Label>Owner mobile (E.164 — e.g. +447379562631)</Label>
        <Input value={form.divert_mobile_number || ''}
          onChange={(e) => setForm({ ...form, divert_mobile_number: e.target.value })}
          placeholder="+447XXX XXXXXX" data-testid="set-mobile" />
        <Hint>Ring timeout: {form.ring_timeout_seconds}s. After this, the call counts as missed and you get a Telegram alert.</Hint>
      </Card>

      {/* Twilio landline */}
      <Card title="Twilio UK landline (Caller ID)">
        <Label>Twilio number (E.164)</Label>
        <Input value={form.twilio_phone_number || ''}
          onChange={(e) => setForm({ ...form, twilio_phone_number: e.target.value })}
          placeholder="+44 1474 XXXXXX" data-testid="set-twilio-number" />
        <Hint>Buy your number in Twilio Console → Phone Numbers → Buy a number. See the <strong>Setup</strong> tab for step-by-step.</Hint>
      </Card>

      {/* Welcome */}
      <Card title="Welcome message">
        <Textarea rows={4} value={form.welcome_message_text || ''}
          onChange={(e) => setForm({ ...form, welcome_message_text: e.target.value })}
          placeholder="Welcome to Tile Station…" data-testid="set-welcome-text" />
        <div className="flex items-center justify-between gap-2 mt-2">
          <div className="text-xs text-muted-foreground">
            {form.welcome_audio_url ? (
              <>
                <CheckCircle2 className="w-3 h-3 inline text-emerald-600 mr-1" />
                Custom audio active —
                <a href={form.welcome_audio_url} target="_blank" rel="noreferrer"
                   className="text-indigo-700 underline ml-1">preview MP3</a>
                {form.welcome_audio_generated_at &&
                 <span className="ml-2">· generated {form.welcome_audio_generated_at.slice(0, 10)}</span>}
              </>
            ) : (
              <>No custom audio — Twilio will use the built-in &quot;alice&quot; voice on each call.</>
            )}
          </div>
          <Button onClick={regenerateWelcome} disabled={regenerating}
            variant="outline" data-testid="regen-welcome">
            {regenerating ? <Loader2 className="w-4 h-4 mr-1.5 animate-spin" /> : <Sparkles className="w-4 h-4 mr-1.5" />}
            {regenerating ? 'Synthesising…' : 'Generate audio (ElevenLabs)'}
          </Button>
        </div>
      </Card>

      {/* Hold ads */}
      <Card title="Hold ads (played while ringing your mobile)">
        <div className="flex gap-2 text-xs">
          {['radio_studio', 'manual', 'none'].map((src) => (
            <button key={src} type="button"
              onClick={() => setForm({ ...form, ads_source: src })}
              className={`px-3 py-1.5 rounded border text-xs font-bold ${form.ads_source === src ? 'bg-indigo-600 text-white border-indigo-600' : 'bg-card hover:bg-muted'}`}
              data-testid={`set-ads-${src}`}>
              {src === 'radio_studio' ? 'Latest Radio Studio ads' : src === 'manual' ? 'Manual uploads' : 'None'}
            </button>
          ))}
        </div>
        <div className="mt-2 flex items-center gap-3">
          <Label className="text-xs">Max ads per call</Label>
          <Input type="number" min={0} max={5}
            value={form.max_hold_ads ?? 2}
            onChange={(e) => setForm({ ...form, max_hold_ads: Number(e.target.value) || 0 })}
            className="w-20" data-testid="set-max-ads" />
        </div>
        {form.ads_source === 'manual' && (
          <div className="mt-3 space-y-2">
            {(form.manual_ad_urls || []).map((url, i) => (
              <div key={url} className="flex items-center gap-2 text-xs font-mono bg-muted/40 px-2 py-1 rounded">
                <span className="flex-1 truncate">{url}</span>
                <button type="button"
                  onClick={() => setForm({ ...form, manual_ad_urls: form.manual_ad_urls.filter((_, j) => j !== i) })}
                  className="text-rose-700 hover:underline">Remove</button>
              </div>
            ))}
            <label className="inline-flex items-center gap-2 px-3 py-1.5 rounded border border-dashed cursor-pointer hover:bg-muted text-xs"
              data-testid="upload-ad-label">
              <Upload className="w-3.5 h-3.5" /> Upload MP3 (≤5MB)
              <input type="file" accept="audio/mpeg,audio/mp3" className="hidden"
                onChange={(e) => uploadManualAd(e.target.files?.[0])} />
            </label>
          </div>
        )}
      </Card>

      {/* Recording */}
      <Card title="Call recording">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm">Record both legs of every call</p>
            <p className="text-xs text-muted-foreground">UK GDPR: keep the &quot;this call may be recorded&quot; phrase in your welcome message. Recordings stay in Twilio (Basic-Auth proxied through us so the browser doesn't see Twilio credentials).</p>
          </div>
          <Switch checked={!!form.recording_enabled}
            onCheckedChange={(v) => setForm({ ...form, recording_enabled: v })}
            data-testid="set-record" />
        </div>
      </Card>

      {/* Alerts */}
      <Card title="Telegram alerts">
        <Row>
          <span className="text-sm">Missed-call alerts</span>
          <Switch checked={!!form.missed_call_telegram_alerts}
            onCheckedChange={(v) => setForm({ ...form, missed_call_telegram_alerts: v })}
            data-testid="set-missed-tg" />
        </Row>
        <Row>
          <span className="text-sm">Every inbound call alert <span className="text-muted-foreground">(noisy — off by default)</span></span>
          <Switch checked={!!form.inbound_call_telegram_alerts}
            onCheckedChange={(v) => setForm({ ...form, inbound_call_telegram_alerts: v })}
            data-testid="set-inbound-tg" />
        </Row>
      </Card>

      {/* Business hours */}
      <Card title="Business hours">
        <Row>
          <span className="text-sm">Out-of-hours auto-message</span>
          <Switch checked={!!form.business_hours_enabled}
            onCheckedChange={(v) => setForm({ ...form, business_hours_enabled: v })}
            data-testid="set-hours-enabled" />
        </Row>
        {form.business_hours_enabled && (
          <>
            <div className="grid grid-cols-2 gap-2 mt-2">
              <div>
                <Label className="text-xs">Open</Label>
                <Input type="time" value={form.business_hours_open || '09:00'}
                  onChange={(e) => setForm({ ...form, business_hours_open: e.target.value })}
                  data-testid="set-hours-open" />
              </div>
              <div>
                <Label className="text-xs">Close</Label>
                <Input type="time" value={form.business_hours_close || '17:30'}
                  onChange={(e) => setForm({ ...form, business_hours_close: e.target.value })}
                  data-testid="set-hours-close" />
              </div>
            </div>
            <Label className="text-xs mt-2 block">Days open (0=Mon … 6=Sun)</Label>
            <div className="flex gap-1 mt-1">
              {['M', 'T', 'W', 'T', 'F', 'S', 'S'].map((day, idx) => {
                const isOpen = (form.business_hours_days || []).includes(idx);
                return (
                  <button key={idx} type="button"
                    onClick={() => {
                      const days = new Set(form.business_hours_days || []);
                      if (isOpen) days.delete(idx); else days.add(idx);
                      setForm({ ...form, business_hours_days: Array.from(days).sort() });
                    }}
                    className={`w-9 h-9 rounded font-bold text-xs ${isOpen ? 'bg-emerald-600 text-white' : 'bg-muted hover:bg-muted-foreground/10'}`}>
                    {day}
                  </button>
                );
              })}
            </div>
            <Label className="text-xs mt-3 block">Closed message</Label>
            <Textarea rows={3} value={form.closed_message_text || ''}
              onChange={(e) => setForm({ ...form, closed_message_text: e.target.value })}
              data-testid="set-closed-msg" />
          </>
        )}
      </Card>

      <div className="sticky bottom-0 bg-background border-t -mx-4 sm:-mx-6 px-4 sm:px-6 py-3 flex justify-end">
        <Button onClick={save} disabled={saving}
          className="bg-indigo-600 hover:bg-indigo-700 text-white" data-testid="save-settings">
          <Save className="w-4 h-4 mr-1.5" />
          {saving ? 'Saving…' : 'Save settings'}
        </Button>
      </div>
    </div>
  );
}


/* ─── Tab 2: Call Log ──────────────────────────────────────────────── */
function CallsTab() {
  const [filter, setFilter] = useState('all');
  const [missedOnly, setMissedOnly] = useState(false);
  const [calls, setCalls] = useState([]);
  const [loading, setLoading] = useState(true);
  const [active, setActive] = useState(null);

  const fetchCalls = useCallback(async () => {
    setLoading(true);
    try {
      const q = new URLSearchParams();
      if (filter !== 'all') q.set('direction', filter);
      if (missedOnly) q.set('missed_only', 'true');
      const r = await axios.get(`${API}/api/admin/voice/calls?${q.toString()}`,
        { headers: authHeader() });
      setCalls(r.data || []);
    } catch (e) {
      toast.error(e?.response?.data?.detail || e.message);
    } finally { setLoading(false); }
  }, [filter, missedOnly]);
  useEffect(() => { fetchCalls(); }, [fetchCalls]);

  return (
    <div className="space-y-3 mt-4" data-testid="calls-tab">
      <div className="flex flex-wrap items-center gap-2">
        {['all', 'inbound', 'outbound'].map((f) => (
          <button key={f} type="button" onClick={() => setFilter(f)}
            className={`px-3 py-1 rounded border text-xs font-bold capitalize ${filter === f ? 'bg-indigo-600 text-white border-indigo-600' : 'bg-card hover:bg-muted'}`}
            data-testid={`filter-${f}`}>{f}</button>
        ))}
        <label className="ml-2 inline-flex items-center gap-1.5 text-xs cursor-pointer">
          <input type="checkbox" checked={missedOnly} onChange={(e) => setMissedOnly(e.target.checked)} />
          Missed only
        </label>
        <Button variant="outline" size="sm" onClick={fetchCalls} className="ml-auto" data-testid="refresh-calls">
          <RefreshCw className="w-3.5 h-3.5 mr-1" /> Refresh
        </Button>
      </div>

      {loading ? (
        <div className="p-10 text-center text-xs text-muted-foreground">Loading…</div>
      ) : calls.length === 0 ? (
        <div className="p-10 text-center text-xs text-muted-foreground border rounded">
          No calls yet. Once your Twilio number is wired up and someone rings, calls will appear here.
        </div>
      ) : (
        <div className="border rounded-md overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="bg-muted/40">
              <tr>
                <th className="px-3 py-2 text-left">When</th>
                <th className="px-3 py-2 text-left">Dir</th>
                <th className="px-3 py-2 text-left">From</th>
                <th className="px-3 py-2 text-left">To</th>
                <th className="px-3 py-2 text-left">Status</th>
                <th className="px-3 py-2 text-left">Duration</th>
                <th className="px-3 py-2 text-left">Rec</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {calls.map((c) => (
                <tr key={c.id || c.call_sid}
                  onClick={() => setActive(c)}
                  className="hover:bg-muted/30 cursor-pointer"
                  data-testid={`call-row-${c.call_sid || c.id}`}>
                  <td className="px-3 py-2 whitespace-nowrap">{(c.started_at || '').replace('T', ' ').slice(0, 19)}</td>
                  <td className="px-3 py-2">
                    {c.direction === 'inbound'
                      ? <PhoneIncoming className="w-3.5 h-3.5 text-emerald-700" />
                      : <PhoneOutgoing className="w-3.5 h-3.5 text-indigo-700" />}
                  </td>
                  <td className="px-3 py-2 font-mono">{c.from_number || '—'}</td>
                  <td className="px-3 py-2 font-mono">{c.to_number || '—'}</td>
                  <td className="px-3 py-2">
                    {c.missed
                      ? <span className="px-2 py-0.5 rounded text-[10px] font-bold bg-rose-100 text-rose-900">MISSED</span>
                      : c.dial_status === 'completed'
                        ? <span className="px-2 py-0.5 rounded text-[10px] font-bold bg-emerald-100 text-emerald-900">ANSWERED</span>
                        : <span className="px-2 py-0.5 rounded text-[10px] font-bold bg-muted">{c.dial_status || c.status || '—'}</span>}
                  </td>
                  <td className="px-3 py-2">{c.duration_seconds || 0}s</td>
                  <td className="px-3 py-2">
                    {c.recording_url
                      ? <Headphones className="w-3.5 h-3.5 text-indigo-700" />
                      : <span className="text-muted-foreground">—</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {active && <CallDrawer call={active} onClose={() => setActive(null)} />}
    </div>
  );
}

function CallDrawer({ call, onClose }) {
  const recordingUrl = call.recording_url
    ? `${API}/api/admin/voice/recording/${call.id || call.call_sid}`
    : null;
  const audioToken = localStorage.getItem('token');
  return (
    <div className="fixed inset-0 bg-black/40 z-50 flex items-end sm:items-center justify-center p-2"
      onClick={onClose} data-testid="call-drawer">
      <div className="bg-background rounded-lg max-w-lg w-full p-5 shadow-xl"
        onClick={(e) => e.stopPropagation()}>
        <div className="flex items-start justify-between">
          <div>
            <p className="text-xs uppercase tracking-wider text-muted-foreground">{call.direction}</p>
            <h3 className="text-lg font-bold font-mono">{call.from_number} → {call.to_number}</h3>
            <p className="text-xs text-muted-foreground">{(call.started_at || '').replace('T', ' ').slice(0, 19)}</p>
          </div>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground">✕</button>
        </div>
        <div className="grid grid-cols-3 gap-2 mt-3 text-xs">
          <Stat label="Status" value={call.dial_status || call.status || '—'} />
          <Stat label="Duration" value={`${call.duration_seconds || 0}s`} />
          <Stat label="Missed" value={call.missed ? 'YES' : 'no'}
            cls={call.missed ? 'bg-rose-50' : ''} />
        </div>
        {recordingUrl ? (
          <div className="mt-4">
            <Label className="text-xs flex items-center gap-1"><Headphones className="w-3 h-3" /> Recording</Label>
            {/* Use a fetch+blob approach to inject the auth header */}
            <RecordingPlayer src={recordingUrl} token={audioToken} />
          </div>
        ) : (
          <div className="mt-4 text-xs text-muted-foreground italic">
            {call.recording_url === undefined ? 'Recording not requested for this call.' : 'Recording still processing — refresh in a minute.'}
          </div>
        )}
        <div className="mt-4 flex gap-2">
          {(call.direction === 'inbound' || call.direction === 'outbound') && (
            <ClickToCallButton
              number={call.direction === 'inbound' ? call.from_number : call.to_number}
              label="Call back"
              data-testid="drawer-callback"
            />
          )}
        </div>
      </div>
    </div>
  );
}

function RecordingPlayer({ src, token }) {
  const [blobUrl, setBlobUrl] = useState(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await axios.get(src, { headers: token ? { Authorization: `Bearer ${token}` } : {}, responseType: 'blob' });
        if (cancelled) return;
        setBlobUrl(URL.createObjectURL(r.data));
      } catch (e) {
        if (!cancelled) toast.error(`Recording failed: ${e?.response?.data?.detail || e.message}`);
      } finally { setLoading(false); }
    })();
    return () => { cancelled = true; if (blobUrl) URL.revokeObjectURL(blobUrl); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [src, token]);
  if (loading) return <div className="text-xs text-muted-foreground">Loading recording…</div>;
  if (!blobUrl) return null;
  return <audio controls src={blobUrl} className="w-full mt-1" data-testid="recording-player" />;
}


/* ─── Tab 3: Stats ────────────────────────────────────────────────── */
function StatsTab() {
  const [stats, setStats] = useState(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await axios.get(`${API}/api/admin/voice/stats`, { headers: authHeader() });
      setStats(r.data);
    } catch (e) {
      toast.error(e?.response?.data?.detail || e.message);
    } finally { setLoading(false); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const maxCount = useMemo(
    () => Math.max(1, ...(stats?.daily || []).map((d) => d.count)),
    [stats],
  );

  if (loading || !stats) return <div className="p-8 text-center text-xs text-muted-foreground">Loading…</div>;

  return (
    <div className="space-y-4 mt-4" data-testid="stats-tab">
      <div className="grid grid-cols-3 gap-3">
        {['today', 'week', 'month'].map((k) => {
          const s = stats[k] || {};
          return (
            <div key={k} className="rounded-lg border bg-card p-4">
              <div className="text-[10px] uppercase tracking-wider font-bold text-muted-foreground">{k}</div>
              <div className="text-3xl font-bold">{s.count || 0}</div>
              <div className="text-xs text-muted-foreground mt-1">
                {s.missed || 0} missed · {Math.round((s.total_duration || 0) / 60)} min total
              </div>
            </div>
          );
        })}
      </div>
      <div className="rounded-lg border bg-card p-4" data-testid="daily-chart">
        <p className="text-xs font-bold mb-2">Last 7 days</p>
        <div className="space-y-1">
          {(stats.daily || []).map((d) => (
            <div key={d.day} className="flex items-center gap-2 text-xs">
              <span className="w-20 font-mono">{d.day}</span>
              <div className="flex-1 bg-muted/40 h-5 rounded relative overflow-hidden">
                <div className="bg-emerald-500 h-full" style={{ width: `${(d.count / maxCount) * 100}%` }} />
                {d.missed > 0 && (
                  <div className="absolute right-1 top-0 h-full flex items-center text-[10px] text-rose-700 font-bold">
                    {d.missed} missed
                  </div>
                )}
              </div>
              <span className="w-8 text-right">{d.count}</span>
            </div>
          ))}
          {(stats.daily || []).length === 0 && (
            <div className="text-xs text-muted-foreground">No calls in the last 7 days.</div>
          )}
        </div>
      </div>
    </div>
  );
}


/* ─── Tab 4: Setup wizard ─────────────────────────────────────────── */
function SetupTab() {
  const copyLine = (txt) => {
    navigator.clipboard?.writeText(txt);
    toast.success('Copied');
  };
  const incoming = `${(typeof window !== 'undefined' ? window.location.origin : '').replace('://www.', '://www.')}/api/voice/incoming`;
  const outbound = `${(typeof window !== 'undefined' ? window.location.origin : '')}/api/voice/outbound`;
  return (
    <div className="space-y-4 mt-4 text-sm" data-testid="setup-tab">
      <Step n={1} title="Buy a UK landline number on Twilio">
        Open <Link href="https://console.twilio.com/us1/develop/phone-numbers/manage/search">
          Twilio Console → Phone Numbers → Buy a number
        </Link>. Filter <strong>Country = United Kingdom</strong>, <strong>Local</strong>, area code{' '}
        of your choice (e.g. <code>1474</code> for Gravesend, <code>020</code> for London,{' '}
        <code>0330</code> for non-geographic).
        <Hint>UK numbers need a Regulatory Bundle — upload your company details + proof of UK address. Approval is usually 1–3 working days.</Hint>
      </Step>

      <Step n={2} title="Set the inbound webhook on your new number">
        In the number's <strong>Voice Configuration</strong> section:
        <Block>
          <Row>
            <span><strong>A call comes in</strong></span>
            <span className="text-xs text-muted-foreground">Webhook · HTTP POST</span>
          </Row>
          <Row>
            <code className="text-xs">{incoming}</code>
            <Button variant="ghost" size="sm" onClick={() => copyLine(incoming)}>
              <Copy className="w-3 h-3" />
            </Button>
          </Row>
        </Block>
      </Step>

      <Step n={3} title="Paste your new number into Settings → Twilio UK landline">
        Then save. Test by calling the number — you'll hear the welcome message and your mobile will ring.
      </Step>

      <Step n={4} title="(Optional) Set up Click-to-call from the browser">
        This part needs 3 extra credentials. From Twilio Console:
        <Block>
          <Bullet><strong>API Key + Secret:</strong> <Link href="https://console.twilio.com/us1/account/keys-credentials/api-keys">Account → API Keys → Create</Link>. Type "Standard". Copy the Key SID + Secret.</Bullet>
          <Bullet><strong>TwiML App:</strong> <Link href="https://console.twilio.com/us1/develop/voice/manage/twiml-apps">Voice → TwiML Apps → Create</Link>. Set the <em>Voice Request URL</em> to:</Bullet>
          <Row>
            <code className="text-xs">{outbound}</code>
            <Button variant="ghost" size="sm" onClick={() => copyLine(outbound)}>
              <Copy className="w-3 h-3" />
            </Button>
          </Row>
          <Bullet>Method = HTTP POST. Copy the resulting App SID.</Bullet>
        </Block>
        Add these to <code>backend/.env</code>:
        <pre className="text-[11px] bg-muted/40 p-2 rounded">{`TWILIO_API_KEY=SK...
TWILIO_API_SECRET=...
TWILIO_TWIML_APP_SID=AP...`}</pre>
      </Step>

      <Step n={5} title="(Optional) Outbound calls from YOUR mobile as the landline">
        Install <strong>Zoiper</strong> (free) or <strong>Bria</strong> on your phone. In Twilio Console:
        <Bullet>Voice → SIP → Create a SIP Domain (e.g. <code>tilestation.sip.twilio.com</code>)</Bullet>
        <Bullet>Credential Lists → Create one with username/password for you</Bullet>
        <Bullet>In Zoiper, add account: domain = your SIP domain, login + password as above.</Bullet>
        Outbound calls from the app will be billed to Twilio and show the landline as Caller ID.
      </Step>

      <Step n={6} title="Lock down the webhook signature">
        Once everything works end-to-end, flip <code>VOICE_REQUIRE_SIGNATURE=1</code> in{' '}
        <code>backend/.env</code> and redeploy. Twilio's signed requests will be the only ones accepted.
      </Step>
    </div>
  );
}


/* ─── Tiny presentational helpers ─────────────────────────────────── */
function Card({ title, children }) {
  return (
    <div className="rounded-lg border bg-card p-4 space-y-2">
      {title && <p className="text-sm font-bold">{title}</p>}
      {children}
    </div>
  );
}
function Row({ children }) { return <div className="flex items-center justify-between gap-3">{children}</div>; }
function Hint({ children }) { return <p className="text-[11px] text-muted-foreground mt-1">{children}</p>; }
function Stat({ label, value, cls = '' }) {
  return (
    <div className={`rounded border p-2 ${cls}`}>
      <div className="text-[9px] uppercase font-bold text-muted-foreground tracking-wider">{label}</div>
      <div className="text-sm font-bold">{value}</div>
    </div>
  );
}
function Step({ n, title, children }) {
  return (
    <div className="rounded-lg border bg-card p-4">
      <div className="flex items-center gap-2 mb-2">
        <div className="w-7 h-7 rounded-full bg-indigo-600 text-white flex items-center justify-center font-bold text-sm">{n}</div>
        <h3 className="font-bold text-sm">{title}</h3>
      </div>
      <div className="text-xs leading-relaxed pl-9">{children}</div>
    </div>
  );
}
function Block({ children }) { return <div className="bg-muted/40 rounded p-2 my-1 space-y-1">{children}</div>; }
function Bullet({ children }) { return <div className="text-xs">• {children}</div>; }
function Link({ href, children }) {
  return (
    <a href={href} target="_blank" rel="noreferrer"
       className="text-indigo-700 underline inline-flex items-center gap-0.5 hover:text-indigo-900">
      {children} <ExternalLink className="w-3 h-3" />
    </a>
  );
}


/* ─── Tab: Per-Showroom routes ────────────────────────────────────── */
function ShowroomRoutesTab() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await axios.get(`${API}/api/admin/voice/showroom-routes`, { headers: authHeader() });
      setData(r.data);
    } catch (e) { toast.error(e?.response?.data?.detail || e.message); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { load(); }, [load]);

  if (loading || !data) return <div className="p-8 text-center text-xs text-muted-foreground">Loading…</div>;

  const routesByName = Object.fromEntries((data.routes || []).map((r) => [r.showroom_name, r]));
  const showrooms = data.showrooms || [];

  return (
    <div className="space-y-4 mt-4" data-testid="showrooms-tab">
      <div className="rounded-lg border bg-indigo-50/50 border-indigo-200 p-4 text-xs leading-relaxed">
        <p className="font-bold text-sm mb-1">Per-showroom call routing</p>
        <p>
          Each showroom can have its own Twilio number, divert mobile and welcome message —
          welcome text supports <code className="bg-card px-1 rounded">{'{showroom_name}'}</code>
          {' and '}<code className="bg-card px-1 rounded">{'{showroom_hours_today}'}</code> placeholders.
          Opening hours auto-pull from the showroom record. You then set up <strong>BT/Sky/Virgin
          call divert</strong> from each landline → its Twilio number.
        </p>
      </div>

      <div className="space-y-3">
        {showrooms.map((sr) => {
          const route = routesByName[sr.name];
          return (
            <ShowroomRow key={sr.name} showroom={sr} route={route} onEdit={() => setEditing(sr)} />
          );
        })}
        {showrooms.length === 0 && (
          <div className="text-xs text-muted-foreground border rounded p-4 text-center">
            No showrooms defined. Add them under <code>Settings → Showrooms</code> first.
          </div>
        )}
      </div>

      {editing && (
        <ShowroomRouteEditor
          showroom={editing}
          route={routesByName[editing.name]}
          onClose={() => { setEditing(null); load(); }}
        />
      )}
    </div>
  );
}

function ShowroomRow({ showroom, route, onEdit }) {
  const wired = !!route?.twilio_number;
  const enabled = route?.enabled !== false;
  return (
    <div className={`rounded-lg border p-3 ${wired ? 'bg-card' : 'bg-muted/30'}`}
      data-testid={`showroom-row-${showroom.name}`}>
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h3 className="font-bold text-sm">{showroom.name}</h3>
            {wired && enabled && (
              <span className="px-2 py-0.5 text-[10px] font-bold uppercase rounded bg-emerald-100 text-emerald-900 border border-emerald-300">Wired</span>
            )}
            {wired && !enabled && (
              <span className="px-2 py-0.5 text-[10px] font-bold uppercase rounded bg-amber-100 text-amber-900 border border-amber-300">Disabled</span>
            )}
            {!wired && (
              <span className="px-2 py-0.5 text-[10px] font-bold uppercase rounded bg-rose-100 text-rose-900 border border-rose-300">Not wired</span>
            )}
          </div>
          <p className="text-xs text-muted-foreground mt-0.5">
            Existing landline: <span className="font-mono">{showroom.phone || '— not on file —'}</span>
          </p>
          {wired ? (
            <div className="mt-2 grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-1 text-xs">
              <div>
                <span className="text-muted-foreground">Twilio →</span>{' '}
                <span className="font-mono">{route.twilio_number}</span>
              </div>
              <div>
                <span className="text-muted-foreground">Rings →</span>{' '}
                <span className="font-mono">{route.divert_mobile || '—'}</span>
              </div>
              {route.welcome_message_text && (
                <div className="sm:col-span-2 truncate">
                  <span className="text-muted-foreground">Welcome →</span>{' '}
                  <em className="text-foreground">"{route.welcome_message_text}"</em>
                </div>
              )}
              {route.welcome_audio_url && (
                <div className="sm:col-span-2">
                  <audio controls src={route.welcome_audio_url} className="w-full h-8 mt-1"
                    data-testid={`welcome-audio-${showroom.name}`} />
                </div>
              )}
            </div>
          ) : (
            <p className="text-xs text-muted-foreground italic mt-1">
              No Twilio routing yet. Buy a Twilio number for this location + click Configure.
            </p>
          )}
        </div>
        <Button onClick={onEdit} variant={wired ? 'outline' : 'default'} size="sm"
          className={!wired ? 'bg-indigo-600 hover:bg-indigo-700 text-white' : ''}
          data-testid={`configure-${showroom.name}`}>
          {wired ? 'Edit' : 'Configure'}
        </Button>
      </div>
    </div>
  );
}

function ShowroomRouteEditor({ showroom, route, onClose }) {
  const [form, setForm] = useState({
    showroom_name: showroom.name,
    twilio_number: route?.twilio_number || '',
    divert_mobile: route?.divert_mobile || '',
    welcome_message_text: route?.welcome_message_text
      || `Welcome to Tile Station, ${showroom.name} showroom. This call may be recorded for quality and training. Please hold while we connect you to our team.`,
    use_showroom_hours: route?.use_showroom_hours !== false,
    recording_enabled: route?.recording_enabled,
    enabled: route?.enabled !== false,
    welcome_audio_url: route?.welcome_audio_url || null,
    welcome_audio_generated_at: route?.welcome_audio_generated_at || null,
  });
  const [saving, setSaving] = useState(false);
  const [regenerating, setRegenerating] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const save = async () => {
    setSaving(true);
    try {
      await axios.put(`${API}/api/admin/voice/showroom-routes/${encodeURIComponent(showroom.name)}`,
        form, { headers: authHeader() });
      toast.success(`${showroom.name} route saved`);
      onClose();
    } catch (e) { toast.error(e?.response?.data?.detail || e.message); }
    finally { setSaving(false); }
  };
  const regen = async () => {
    setRegenerating(true);
    try {
      const r = await axios.post(
        `${API}/api/admin/voice/showroom-routes/${encodeURIComponent(showroom.name)}/regenerate-welcome`,
        {}, { headers: authHeader() });
      setForm((f) => ({ ...f, welcome_audio_url: r.data.audio_url,
                              welcome_audio_generated_at: new Date().toISOString() }));
      toast.success('Welcome audio regenerated', { description: r.data.rendered_text?.slice(0, 80) });
    } catch (e) { toast.error(e?.response?.data?.detail || e.message); }
    finally { setRegenerating(false); }
  };
  const del = async () => {
    if (!window.confirm(`Remove the Twilio route for ${showroom.name}? Callers ringing the Twilio number will fall back to the global default greeting.`)) return;
    setDeleting(true);
    try {
      await axios.delete(`${API}/api/admin/voice/showroom-routes/${encodeURIComponent(showroom.name)}`,
        { headers: authHeader() });
      toast.success('Route removed');
      onClose();
    } catch (e) { toast.error(e?.response?.data?.detail || e.message); }
    finally { setDeleting(false); }
  };

  return (
    <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-2"
      onClick={onClose} data-testid="showroom-editor">
      <div className="bg-background rounded-lg max-w-2xl w-full max-h-[90vh] overflow-y-auto p-5 shadow-xl"
        onClick={(e) => e.stopPropagation()}>
        <div className="flex items-start justify-between mb-3">
          <div>
            <h3 className="text-lg font-bold">{showroom.name} telephony</h3>
            <p className="text-xs text-muted-foreground">
              Existing landline: <span className="font-mono">{showroom.phone || '—'}</span>
              {showroom.postcode && <> · {showroom.postcode}</>}
            </p>
          </div>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground">✕</button>
        </div>

        <div className="space-y-3">
          <div>
            <Label className="text-xs">Twilio number (the one callers are diverted to)</Label>
            <Input value={form.twilio_number}
              onChange={(e) => setForm({ ...form, twilio_number: e.target.value })}
              placeholder="+44 1474 …" data-testid="sr-twilio" />
            <p className="text-[10px] text-muted-foreground mt-1">
              Buy this in Twilio Console → set its Voice webhook to <code>/api/voice/incoming</code>.
            </p>
          </div>
          <div>
            <Label className="text-xs">Divert mobile (showroom manager)</Label>
            <Input value={form.divert_mobile}
              onChange={(e) => setForm({ ...form, divert_mobile: e.target.value })}
              placeholder="+447…" data-testid="sr-mobile" />
          </div>
          <div>
            <Label className="text-xs">Welcome message</Label>
            <Textarea rows={4} value={form.welcome_message_text}
              onChange={(e) => setForm({ ...form, welcome_message_text: e.target.value })}
              data-testid="sr-welcome" />
            <p className="text-[10px] text-muted-foreground mt-1">
              Placeholders: <code>{'{showroom_name}'}</code>, <code>{'{showroom_hours_today}'}</code>
            </p>
          </div>
          <div className="flex items-center justify-between">
            <div className="text-xs">
              {form.welcome_audio_url ? (
                <>
                  <CheckCircle2 className="w-3 h-3 inline text-emerald-600 mr-1" />
                  Custom audio ready
                  <a href={form.welcome_audio_url} target="_blank" rel="noreferrer" className="text-indigo-700 underline ml-1">preview</a>
                  {form.welcome_audio_generated_at && <span className="ml-2 text-muted-foreground">· {form.welcome_audio_generated_at.slice(0, 10)}</span>}
                </>
              ) : 'No audio yet — will use Twilio "alice" voice on each call.'}
            </div>
            <Button onClick={regen} disabled={regenerating || saving}
              variant="outline" size="sm" data-testid="sr-regen">
              {regenerating ? <Loader2 className="w-3 h-3 mr-1 animate-spin" /> : <Sparkles className="w-3 h-3 mr-1" />}
              {regenerating ? 'Synthesising…' : 'Generate audio'}
            </Button>
          </div>
          <Row>
            <div>
              <p className="text-sm">Use this showroom's opening hours</p>
              <p className="text-[10px] text-muted-foreground">Auto-pulled from the Showrooms record. Out-of-hours plays the closed message + hangs up.</p>
            </div>
            <Switch checked={form.use_showroom_hours}
              onCheckedChange={(v) => setForm({ ...form, use_showroom_hours: v })}
              data-testid="sr-hours" />
          </Row>
          {showroom.opening_hours && Object.keys(showroom.opening_hours).length > 0 && (
            <div className="text-[11px] bg-muted/40 rounded p-2 font-mono">
              {Object.entries(showroom.opening_hours).map(([day, h]) => (
                <div key={day}><strong className="capitalize">{day}:</strong> {h}</div>
              ))}
            </div>
          )}
          <Row>
            <div>
              <p className="text-sm">Recording</p>
              <p className="text-[10px] text-muted-foreground">Leave blank to inherit the global setting</p>
            </div>
            <select value={form.recording_enabled === null || form.recording_enabled === undefined ? '' : String(form.recording_enabled)}
              onChange={(e) => setForm({ ...form, recording_enabled: e.target.value === '' ? null : e.target.value === 'true' })}
              className="h-8 px-2 rounded border bg-background text-xs"
              data-testid="sr-record">
              <option value="">(inherit)</option>
              <option value="true">On</option>
              <option value="false">Off</option>
            </select>
          </Row>
          <Row>
            <div>
              <p className="text-sm">Route enabled</p>
              <p className="text-[10px] text-muted-foreground">Off = the Twilio number won't be matched (falls back to global default).</p>
            </div>
            <Switch checked={form.enabled}
              onCheckedChange={(v) => setForm({ ...form, enabled: v })}
              data-testid="sr-enabled" />
          </Row>
        </div>

        <div className="mt-5 flex justify-between gap-2">
          {route && (
            <Button onClick={del} disabled={deleting} variant="outline"
              className="text-rose-700 border-rose-300 hover:bg-rose-50" data-testid="sr-delete">
              {deleting ? <Loader2 className="w-3 h-3 animate-spin" /> : null}
              Remove route
            </Button>
          )}
          <div className="ml-auto flex gap-2">
            <Button variant="outline" onClick={onClose}>Cancel</Button>
            <Button onClick={save} disabled={saving} className="bg-indigo-600 hover:bg-indigo-700 text-white"
              data-testid="sr-save">
              <Save className="w-3 h-3 mr-1.5" />
              {saving ? 'Saving…' : 'Save'}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
