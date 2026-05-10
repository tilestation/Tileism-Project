/**
 * Admin · Email Hub
 * ─────────────────
 * Unified composer + audience builder + scheduler + analytics + suppression
 * manager. Sits on top of /api/admin/email-hub/*.
 *
 * Four tabs:
 *   1. Compose   — pick audience, write subject + body + CTA, send-test, send-now / schedule
 *   2. Campaigns — history with per-campaign analytics drilldown
 *   3. Templates — save / pick / delete reusable layouts
 *   4. Settings  — suppression list (unsubscribed / bounced / complained)
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import axios from 'axios';
import { toast } from 'sonner';
import { Card } from '../../components/ui/card';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { Textarea } from '../../components/ui/textarea';
import {
  Mail, Send, RefreshCw, Eye, Users, AlertCircle, CheckCircle2,
  PoundSterling, Clock, FileText, Save, Calendar, Plus, X, ExternalLink,
  TrendingUp, MousePointerClick, Ban, Trash2, Sparkles, ListChecks,
} from 'lucide-react';

const API = process.env.REACT_APP_BACKEND_URL;
const tokenHdr = () => {
  const t = localStorage.getItem('token') || localStorage.getItem('access_token') || '';
  return t ? { Authorization: `Bearer ${t}` } : {};
};
const fmtMoney = (n) => `£${(Number(n) || 0).toFixed(2)}`;
const fmtDateTime = (iso) => {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' });
  } catch { return iso; }
};

// Audience chip definitions — single source of truth shared with backend
const AUDIENCE_CHIPS = [
  { kind: 'all_customers',  label: 'All customers',          icon: Users },
  { kind: 'trade_only',     label: 'Trade only',             icon: Users },
  { kind: 'non_trade',      label: 'Non-trade only',         icon: Users },
  { kind: 'has_credit',     label: 'Has credit balance',     icon: PoundSterling },
  { kind: 'inactive_days',  label: 'Inactive 60+ days',      icon: Clock,  needs: 'days' },
  { kind: 'spend_gte',      label: 'Spend ≥ £X',             icon: PoundSterling, needs: 'spend' },
];

const STATUS_BADGE = {
  draft: 'bg-gray-200 text-gray-700',
  queued: 'bg-blue-100 text-blue-700',
  scheduled: 'bg-purple-100 text-purple-700',
  sending: 'bg-amber-100 text-amber-700',
  sent: 'bg-emerald-100 text-emerald-700',
  failed: 'bg-red-100 text-red-700',
  cancelled: 'bg-gray-300 text-gray-600',
};

export default function EmailHub() {
  const [tab, setTab] = useState('compose');

  return (
    <div className="max-w-7xl mx-auto p-6 space-y-6" data-testid="email-hub-page">
      <div className="flex items-start justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Mail className="w-6 h-6 text-amber-500" /> Email Hub
          </h1>
          <p className="text-sm text-gray-500 mt-1">
            Compose, schedule and track campaigns to any segment of customers or traders.
          </p>
        </div>
      </div>

      {/* Tab nav */}
      <div className="flex gap-2 border-b border-gray-200">
        {[
          { k: 'compose',   label: 'Compose',   icon: Sparkles },
          { k: 'campaigns', label: 'Campaigns', icon: TrendingUp },
          { k: 'templates', label: 'Templates', icon: FileText },
          { k: 'settings',  label: 'Suppressions', icon: Ban },
        ].map(({ k, label, icon: Icon }) => (
          <button
            key={k}
            onClick={() => setTab(k)}
            className={`flex items-center gap-2 px-4 py-2.5 text-sm font-medium border-b-2 transition ${
              tab === k
                ? 'border-amber-500 text-amber-700'
                : 'border-transparent text-gray-500 hover:text-gray-800 hover:border-gray-300'
            }`}
            data-testid={`tab-${k}`}
          >
            <Icon className="w-4 h-4" /> {label}
          </button>
        ))}
      </div>

      {tab === 'compose'   && <ComposeTab />}
      {tab === 'campaigns' && <CampaignsTab />}
      {tab === 'templates' && <TemplatesTab onUseTemplate={() => setTab('compose')} />}
      {tab === 'settings'  && <SuppressionsTab />}
    </div>
  );
}

// =============================================================================
// COMPOSE
// =============================================================================
function ComposeTab() {
  const [name, setName] = useState('');
  const [subject, setSubject] = useState('');
  const [bodyHtml, setBodyHtml] = useState('');
  const [heroImage, setHeroImage] = useState('');
  const [ctaText, setCtaText] = useState('');
  const [ctaUrl, setCtaUrl] = useState('');
  const [scheduledFor, setScheduledFor] = useState(''); // ISO local input
  const [testEmail, setTestEmail] = useState('');

  // Audience: segments[] + their numeric values + paste box
  const [activeKinds, setActiveKinds] = useState(new Set());
  const [inactiveDays, setInactiveDays] = useState(60);
  const [spendValue, setSpendValue] = useState(500);
  const [pastedEmails, setPastedEmails] = useState('');

  const [audiencePreview, setAudiencePreview] = useState({ count: 0, total_credit: 0, sample: [], suppressed_count: 0 });
  const [loadingPreview, setLoadingPreview] = useState(false);
  const [sending, setSending] = useState(false);
  const [sendingTest, setSendingTest] = useState(false);
  const [previewHtml, setPreviewHtml] = useState('');

  // Build the AudienceDef payload from current UI state
  const audiencePayload = useMemo(() => {
    const segments = [];
    activeKinds.forEach(kind => {
      const seg = { kind };
      if (kind === 'inactive_days') seg.inactive_days_value = Number(inactiveDays) || 60;
      if (kind === 'spend_gte') seg.spend_value = Number(spendValue) || 0;
      segments.push(seg);
    });
    if (pastedEmails.trim()) {
      const emails = pastedEmails.split(/[,\s]+/).map(e => e.trim()).filter(Boolean);
      if (emails.length) segments.push({ kind: 'custom_emails', custom_emails: emails });
    }
    return { segments };
  }, [activeKinds, inactiveDays, spendValue, pastedEmails]);

  const togglePresetKind = (kind) => {
    setActiveKinds(prev => {
      const next = new Set(prev);
      if (next.has(kind)) next.delete(kind);
      else next.add(kind);
      return next;
    });
  };

  const refreshAudience = useCallback(async () => {
    if (audiencePayload.segments.length === 0) {
      setAudiencePreview({ count: 0, total_credit: 0, sample: [], suppressed_count: 0 });
      return;
    }
    setLoadingPreview(true);
    try {
      const r = await axios.post(`${API}/api/admin/email-hub/audience/preview`, audiencePayload, { headers: tokenHdr() });
      setAudiencePreview(r.data);
    } catch (e) {
      toast.error(`Audience preview failed: ${e?.response?.data?.detail || e.message}`);
    } finally { setLoadingPreview(false); }
  }, [audiencePayload]);

  // Auto-refresh audience as the user changes filters (debounced)
  useEffect(() => {
    const id = setTimeout(refreshAudience, 350);
    return () => clearTimeout(id);
  }, [refreshAudience]);

  // Re-render the email preview whenever subject/body/cta change
  useEffect(() => {
    const html = renderLocalPreview({ subject, bodyHtml, heroImage, ctaText, ctaUrl });
    setPreviewHtml(html);
  }, [subject, bodyHtml, heroImage, ctaText, ctaUrl]);

  const sendTest = async () => {
    if (!testEmail.trim() || !subject.trim() || !bodyHtml.trim()) {
      toast.error('Fill subject + body + test recipient');
      return;
    }
    setSendingTest(true);
    try {
      await axios.post(`${API}/api/admin/email-hub/send-test`, {
        email: testEmail.trim(),
        subject, body_html: bodyHtml,
        hero_image_url: heroImage || null,
        cta_text: ctaText || null,
        cta_url: ctaUrl || null,
      }, { headers: tokenHdr() });
      toast.success(`Test sent to ${testEmail.trim()}`);
    } catch (e) {
      toast.error(`Test send failed: ${e?.response?.data?.detail || e.message}`);
    } finally { setSendingTest(false); }
  };

  const launch = async (asScheduled = false) => {
    if (!subject.trim() || !bodyHtml.trim() || audiencePreview.count === 0) {
      toast.error('Need a subject, body, and a non-empty audience');
      return;
    }
    if (asScheduled && !scheduledFor) {
      toast.error('Pick a date/time to schedule for');
      return;
    }
    if (!asScheduled && !window.confirm(`Send to ${audiencePreview.count} recipients now?`)) return;

    setSending(true);
    try {
      const body = {
        name: name.trim() || subject.trim().slice(0, 80),
        subject, body_html: bodyHtml,
        hero_image_url: heroImage || null,
        cta_text: ctaText || null, cta_url: ctaUrl || null,
        audience: audiencePayload,
        scheduled_for: asScheduled ? new Date(scheduledFor).toISOString() : null,
      };
      const r = await axios.post(`${API}/api/admin/email-hub/campaigns`, body, { headers: tokenHdr() });
      toast.success(asScheduled ? 'Scheduled ✓' : `Campaign queued — sending to ${r.data.audience_count}`);
      // Reset
      setSubject(''); setBodyHtml(''); setCtaText(''); setCtaUrl(''); setHeroImage('');
      setScheduledFor(''); setName('');
    } catch (e) {
      toast.error(`Launch failed: ${e?.response?.data?.detail || e.message}`);
    } finally { setSending(false); }
  };

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
      {/* LEFT — AUDIENCE + COMPOSER */}
      <div className="space-y-5">
        <Card className="p-5">
          <h2 className="text-lg font-semibold flex items-center gap-2 mb-3">
            <Users className="w-5 h-5 text-indigo-500" /> Audience
          </h2>
          <div className="flex flex-wrap gap-2 mb-3">
            {AUDIENCE_CHIPS.map(({ kind, label, icon: Icon }) => {
              const active = activeKinds.has(kind);
              return (
                <button
                  key={kind}
                  type="button"
                  onClick={() => togglePresetKind(kind)}
                  className={`px-3 py-1.5 rounded-full text-sm border transition flex items-center gap-1.5 ${
                    active
                      ? 'bg-amber-500 text-white border-amber-500'
                      : 'bg-white text-gray-700 border-gray-300 hover:border-amber-300'
                  }`}
                  data-testid={`audience-chip-${kind}`}
                >
                  <Icon className="w-3.5 h-3.5" /> {label}
                </button>
              );
            })}
          </div>

          {activeKinds.has('inactive_days') && (
            <div className="flex items-center gap-2 mb-3">
              <label className="text-sm text-gray-600">Inactive days ≥</label>
              <Input type="number" min={1} max={3650} value={inactiveDays}
                onChange={(e) => setInactiveDays(e.target.value)}
                className="w-32" data-testid="inactive-days-input" />
            </div>
          )}
          {activeKinds.has('spend_gte') && (
            <div className="flex items-center gap-2 mb-3">
              <label className="text-sm text-gray-600">Lifetime spend ≥ £</label>
              <Input type="number" min={0} value={spendValue}
                onChange={(e) => setSpendValue(e.target.value)}
                className="w-32" data-testid="spend-input" />
            </div>
          )}

          <div className="mt-3">
            <label className="text-xs font-bold text-gray-500 uppercase tracking-wide flex items-center gap-2">
              <ListChecks className="w-3.5 h-3.5 text-amber-500" /> Or paste specific emails
            </label>
            <Textarea
              value={pastedEmails}
              onChange={(e) => setPastedEmails(e.target.value)}
              rows={3}
              placeholder="one@example.com, two@example.com, …"
              className="mt-1 text-sm font-mono"
              data-testid="paste-emails-textarea"
            />
          </div>

          <div className="mt-4 p-3 bg-emerald-50 border border-emerald-200 rounded-lg">
            <div className="flex items-baseline justify-between">
              <span className="text-xs font-bold text-emerald-900 uppercase tracking-wide">Audience size</span>
              <span className="text-3xl font-bold text-emerald-700 tabular-nums" data-testid="audience-count">
                {loadingPreview ? '…' : audiencePreview.count}
              </span>
            </div>
            {audiencePreview.count > 0 && audiencePreview.total_credit > 0 && (
              <div className="text-xs text-emerald-700 mt-1">
                Holds {fmtMoney(audiencePreview.total_credit)} unredeemed credit
              </div>
            )}
            {audiencePreview.suppressed_count > 0 && (
              <div className="text-xs text-amber-700 mt-1">
                {audiencePreview.suppressed_count} unsubscribed (auto-skipped)
              </div>
            )}
          </div>
        </Card>

        <Card className="p-5">
          <h2 className="text-lg font-semibold flex items-center gap-2 mb-3">
            <Sparkles className="w-5 h-5 text-amber-500" /> Compose
          </h2>
          <div className="space-y-3">
            <div>
              <label className="text-xs font-bold text-gray-500 uppercase tracking-wide">Internal name (optional)</label>
              <Input value={name} onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Plus39 70% off — May 2026"
                data-testid="campaign-name-input" />
            </div>
            <div>
              <label className="text-xs font-bold text-gray-500 uppercase tracking-wide">Subject</label>
              <Input value={subject} onChange={(e) => setSubject(e.target.value)}
                placeholder="{{first_name}}, your trade credit can save you 70% this week"
                data-testid="subject-input" />
              <div className="text-xs text-gray-400 mt-1">
                Merge tags: <code>{'{{first_name}}'}</code>, <code>{'{{full_name}}'}</code>,
                <code>{'{{business_name}}'}</code>, <code>{'{{credit_balance}}'}</code>
              </div>
            </div>
            <div>
              <label className="text-xs font-bold text-gray-500 uppercase tracking-wide">Hero image URL (optional)</label>
              <Input value={heroImage} onChange={(e) => setHeroImage(e.target.value)}
                placeholder="https://…/banner.jpg"
                data-testid="hero-image-input" />
            </div>
            <div>
              <label className="text-xs font-bold text-gray-500 uppercase tracking-wide">Body</label>
              <Textarea value={bodyHtml} onChange={(e) => setBodyHtml(e.target.value)}
                rows={9}
                placeholder={'<p>Hi {{first_name}},</p>\n<p>This week we\\u2019ve got 70% off Plus39 \\u2014 perfect time to redeem your {{credit_balance}} of trade credit.</p>'}
                className="font-mono text-xs"
                data-testid="body-textarea" />
              <div className="text-xs text-gray-400 mt-1">
                Plain HTML accepted. Use <code>&lt;p&gt;</code>, <code>&lt;strong&gt;</code>, <code>&lt;a href&gt;</code>, <code>&lt;img&gt;</code>.
              </div>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="text-xs font-bold text-gray-500 uppercase tracking-wide">CTA button text</label>
                <Input value={ctaText} onChange={(e) => setCtaText(e.target.value)}
                  placeholder="Browse trade shop →" data-testid="cta-text-input" />
              </div>
              <div>
                <label className="text-xs font-bold text-gray-500 uppercase tracking-wide">CTA button URL</label>
                <Input value={ctaUrl} onChange={(e) => setCtaUrl(e.target.value)}
                  placeholder="https://tilestation.co.uk/tiles?sale=true"
                  data-testid="cta-url-input" />
              </div>
            </div>
          </div>
        </Card>

        <Card className="p-5">
          <h2 className="text-lg font-semibold flex items-center gap-2 mb-3">
            <Send className="w-5 h-5 text-amber-500" /> Send
          </h2>
          <div className="flex items-center gap-2">
            <Input type="email" value={testEmail} onChange={(e) => setTestEmail(e.target.value)}
              placeholder="Test recipient email"
              data-testid="test-email-input" />
            <Button variant="outline" onClick={sendTest} disabled={sendingTest} data-testid="send-test-btn">
              {sendingTest ? 'Sending…' : 'Send test'}
            </Button>
          </div>
          <hr className="my-4" />
          <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
            <Button
              className="bg-amber-500 hover:bg-amber-600 text-white w-full"
              onClick={() => launch(false)}
              disabled={sending || audiencePreview.count === 0}
              data-testid="send-now-btn"
            >
              <Send className="w-4 h-4 mr-2" />
              {sending ? 'Sending…' : `Send now to ${audiencePreview.count}`}
            </Button>
            <div className="flex gap-2">
              <Input type="datetime-local" value={scheduledFor}
                onChange={(e) => setScheduledFor(e.target.value)}
                data-testid="schedule-input" />
              <Button variant="outline" onClick={() => launch(true)}
                disabled={sending || !scheduledFor} data-testid="schedule-btn">
                <Calendar className="w-4 h-4" />
              </Button>
            </div>
          </div>
        </Card>
      </div>

      {/* RIGHT — LIVE PREVIEW + AUDIENCE SAMPLE */}
      <div className="space-y-5">
        <Card className="p-5">
          <h2 className="text-lg font-semibold flex items-center gap-2 mb-3">
            <Eye className="w-5 h-5 text-purple-500" /> Live preview
          </h2>
          {subject && (
            <div className="mb-3 p-3 bg-gray-50 rounded-lg border border-gray-200">
              <span className="text-xs font-bold text-gray-500 uppercase tracking-wide mr-2">Subject:</span>
              <span className="text-sm font-medium">{subject}</span>
            </div>
          )}
          <div className="border border-gray-200 rounded-lg overflow-hidden bg-gray-50">
            {previewHtml ? (
              <iframe
                title="Preview"
                srcDoc={previewHtml}
                className="w-full bg-white"
                style={{ height: 600, border: 0 }}
                data-testid="compose-preview-iframe"
              />
            ) : (
              <div className="p-12 text-center text-gray-400 text-sm">Start writing to see a preview</div>
            )}
          </div>
        </Card>

        {audiencePreview.sample?.length > 0 && (
          <Card className="p-5">
            <h2 className="text-base font-semibold mb-2 text-gray-700">Audience sample (first 10)</h2>
            <ul className="text-xs space-y-1">
              {audiencePreview.sample.map((s) => (
                <li key={s.email} className="font-mono">
                  {s.email}
                  {s.is_trade && <span className="ml-2 text-purple-700 text-[10px]">[trade]</span>}
                  {s.credit_balance > 0 && <span className="ml-2 text-emerald-700">{fmtMoney(s.credit_balance)}</span>}
                </li>
              ))}
            </ul>
          </Card>
        )}
      </div>
    </div>
  );
}

// Local preview renderer — server-side renders w/ merge tags + unsubscribe
// link, but for the Compose preview we only need cosmetic accuracy.
function renderLocalPreview({ subject, bodyHtml, heroImage, ctaText, ctaUrl }) {
  if (!subject && !bodyHtml) return '';
  const hero = heroImage
    ? `<div style="margin:-30px -24px 24px -24px;"><img src="${heroImage}" alt="" style="width:100%; max-width:620px; display:block;" /></div>`
    : '';
  const cta = (ctaText && ctaUrl)
    ? `<p style="margin:24px 0 0; text-align:center;"><a href="${ctaUrl}" style="display:inline-block; background:#1a1a2e; color:#F7EA1C; padding:14px 32px; border-radius:8px; text-decoration:none; font-weight:700; font-size:14px;">${ctaText}</a></p>`
    : '';
  return `
    <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif; max-width:620px; margin:0 auto; color:#1a1a2e; background:#f9fafb;">
      <div style="background:#1C1917; padding:18px 24px;">
        <h1 style="color:#F7EA1C; margin:0; font-size:20px;">Tile Station</h1>
      </div>
      <div style="background:#fff; padding:30px 24px;">
        ${hero}
        <div style="font-size:15px; line-height:1.65; color:#262626;">${bodyHtml || '<p style="color:#a8a29e;">Body text…</p>'}</div>
        ${cta}
      </div>
      <div style="text-align:center; padding:18px 24px; color:#a8a29e; font-size:11px;">
        Tile Station · Unit 3 Trade City, Coldharbour Road, Northfleet, Gravesend DA11 8AB<br/>
        Company No: 11982550 · VAT No: 324 251 828<br/>
        <a href="#" style="color:#a8a29e; text-decoration:underline;">Unsubscribe</a>
      </div>
    </div>
  `;
}

// =============================================================================
// CAMPAIGNS
// =============================================================================
function CampaignsTab() {
  const [campaigns, setCampaigns] = useState([]);
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState(null);
  const [detail, setDetail] = useState(null);

  const fetchList = useCallback(async () => {
    setLoading(true);
    try {
      const r = await axios.get(`${API}/api/admin/email-hub/campaigns`, { headers: tokenHdr() });
      setCampaigns(r.data.campaigns || []);
    } catch (e) {
      toast.error(`Failed to load campaigns: ${e?.response?.data?.detail || e.message}`);
    } finally { setLoading(false); }
  }, []);

  const fetchDetail = useCallback(async (id) => {
    try {
      const r = await axios.get(`${API}/api/admin/email-hub/campaigns/${id}`, { headers: tokenHdr() });
      setDetail(r.data);
    } catch (e) {
      toast.error(`Failed to load campaign: ${e?.response?.data?.detail || e.message}`);
    }
  }, []);

  useEffect(() => { fetchList(); }, [fetchList]);
  useEffect(() => { if (selectedId) fetchDetail(selectedId); }, [selectedId, fetchDetail]);

  const cancel = async (id) => {
    if (!window.confirm('Cancel this scheduled campaign?')) return;
    try {
      await axios.post(`${API}/api/admin/email-hub/campaigns/${id}/cancel`, {}, { headers: tokenHdr() });
      toast.success('Cancelled');
      fetchList();
    } catch (e) {
      toast.error(`Cancel failed: ${e?.response?.data?.detail || e.message}`);
    }
  };

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
      <Card className="p-5">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-lg font-semibold flex items-center gap-2">
            <TrendingUp className="w-5 h-5 text-indigo-500" /> Campaign history
          </h2>
          <Button variant="outline" size="sm" onClick={fetchList}>
            <RefreshCw className="w-4 h-4" />
          </Button>
        </div>
        {loading ? (
          <p className="text-sm text-gray-500">Loading…</p>
        ) : campaigns.length === 0 ? (
          <p className="text-sm text-gray-500">No campaigns yet. Send your first one in the Compose tab.</p>
        ) : (
          <div className="space-y-2 max-h-[700px] overflow-y-auto">
            {campaigns.map((c) => (
              <button
                key={c.id}
                onClick={() => setSelectedId(c.id)}
                className={`w-full text-left p-3 rounded-lg border transition ${
                  selectedId === c.id ? 'border-amber-400 bg-amber-50' : 'border-gray-200 hover:border-gray-300 bg-white'
                }`}
                data-testid={`campaign-row-${c.id}`}
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    <div className="font-medium text-sm truncate">{c.name || c.subject}</div>
                    <div className="text-xs text-gray-500 truncate">{c.subject}</div>
                    <div className="text-xs text-gray-400 mt-1">{fmtDateTime(c.created_at)}</div>
                  </div>
                  <div className="flex flex-col items-end gap-1">
                    <span className={`px-2 py-0.5 rounded-full text-[10px] font-semibold ${STATUS_BADGE[c.status] || ''}`}>
                      {c.status}
                    </span>
                    {c.result_summary && (
                      <span className="text-xs text-gray-500">{c.result_summary.sent}/{c.result_summary.audience_count}</span>
                    )}
                    {c.status === 'scheduled' && (
                      <button onClick={(e) => { e.stopPropagation(); cancel(c.id); }} className="text-xs text-red-600 hover:underline">
                        Cancel
                      </button>
                    )}
                  </div>
                </div>
              </button>
            ))}
          </div>
        )}
      </Card>

      <Card className="p-5">
        {!detail ? (
          <p className="text-sm text-gray-500">Select a campaign to see analytics.</p>
        ) : (
          <CampaignDetail detail={detail} />
        )}
      </Card>
    </div>
  );
}

function CampaignDetail({ detail }) {
  const c = detail.campaign || {};
  const a = detail.analytics || { events: {}, unique_opened: 0, unique_clicked: 0, open_rate: 0, click_rate: 0 };
  const ev = a.events || {};
  return (
    <div data-testid="campaign-detail">
      <h2 className="text-lg font-semibold">{c.name || c.subject}</h2>
      <div className="text-sm text-gray-500 mb-4">{c.subject}</div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Stat label="Sent"      value={ev.sent || 0}       icon={Send} />
        <Stat label="Delivered" value={ev.delivered || 0}  icon={CheckCircle2} />
        <Stat label="Opens"     value={a.unique_opened}    sub={`${a.open_rate}%`} icon={Eye} />
        <Stat label="Clicks"    value={a.unique_clicked}   sub={`${a.click_rate}%`} icon={MousePointerClick} />
        <Stat label="Bounced"   value={ev.bounced || 0}    icon={AlertCircle} tone="red" />
        <Stat label="Failed"    value={ev.failed || 0}     icon={X} tone="red" />
        <Stat label="Complaint" value={ev.complained || 0} icon={Ban} tone="red" />
        <Stat label="Audience"  value={c.audience_count_at_create || 0} icon={Users} />
      </div>

      <h3 className="text-sm font-semibold mt-5 mb-2 text-gray-700">Created by · {c.created_by || '—'}</h3>
      <div className="text-xs text-gray-500 space-y-0.5">
        <div>Created: {fmtDateTime(c.created_at)}</div>
        {c.scheduled_for && <div>Scheduled: {fmtDateTime(c.scheduled_for)}</div>}
        {c.sent_at && <div>Sent: {fmtDateTime(c.sent_at)}</div>}
      </div>

      {c.result_summary?.errors?.length > 0 && (
        <div className="mt-3 p-3 bg-red-50 border border-red-200 rounded-lg">
          <div className="text-xs font-bold text-red-700 mb-1">Errors ({c.result_summary.errors.length})</div>
          <ul className="text-xs space-y-0.5">
            {c.result_summary.errors.slice(0, 8).map((e, i) => (
              <li key={i} className="text-red-700"><span className="font-mono">{e.email}</span> — {e.error}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function Stat({ label, value, sub, icon: Icon, tone = 'default' }) {
  const toneClasses = tone === 'red' ? 'bg-red-50 text-red-700' : 'bg-gray-50 text-gray-700';
  return (
    <div className={`p-3 rounded-lg ${toneClasses}`}>
      <div className="text-[10px] font-bold uppercase tracking-wide opacity-70 flex items-center gap-1">
        <Icon className="w-3 h-3" /> {label}
      </div>
      <div className="text-2xl font-bold tabular-nums">{value}</div>
      {sub && <div className="text-xs opacity-70">{sub}</div>}
    </div>
  );
}

// =============================================================================
// TEMPLATES
// =============================================================================
function TemplatesTab({ onUseTemplate }) {
  const [templates, setTemplates] = useState([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [subject, setSubject] = useState('');
  const [bodyHtml, setBodyHtml] = useState('');
  const [ctaText, setCtaText] = useState('');
  const [ctaUrl, setCtaUrl] = useState('');

  const fetchList = useCallback(async () => {
    setLoading(true);
    try {
      const r = await axios.get(`${API}/api/admin/email-hub/templates`, { headers: tokenHdr() });
      setTemplates(r.data.templates || []);
    } catch (e) {
      toast.error(`Failed to load templates: ${e?.response?.data?.detail || e.message}`);
    } finally { setLoading(false); }
  }, []);
  useEffect(() => { fetchList(); }, [fetchList]);

  const create = async () => {
    if (!name.trim() || !subject.trim() || !bodyHtml.trim()) {
      toast.error('Name + subject + body required'); return;
    }
    setCreating(true);
    try {
      await axios.post(`${API}/api/admin/email-hub/templates`,
        { name, subject, body_html: bodyHtml, cta_text: ctaText || null, cta_url: ctaUrl || null },
        { headers: tokenHdr() });
      toast.success('Template saved');
      setName(''); setSubject(''); setBodyHtml(''); setCtaText(''); setCtaUrl('');
      fetchList();
    } catch (e) {
      toast.error(`Save failed: ${e?.response?.data?.detail || e.message}`);
    } finally { setCreating(false); }
  };

  const remove = async (id) => {
    if (!window.confirm('Delete this template?')) return;
    try {
      await axios.delete(`${API}/api/admin/email-hub/templates/${id}`, { headers: tokenHdr() });
      toast.success('Deleted');
      fetchList();
    } catch (e) {
      toast.error(`Delete failed: ${e?.response?.data?.detail || e.message}`);
    }
  };

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
      <Card className="p-5">
        <h2 className="text-lg font-semibold flex items-center gap-2 mb-3">
          <Plus className="w-5 h-5 text-emerald-500" /> Save a new template
        </h2>
        <div className="space-y-2">
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Template name" data-testid="template-name-input" />
          <Input value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="Subject" data-testid="template-subject-input" />
          <Textarea value={bodyHtml} onChange={(e) => setBodyHtml(e.target.value)}
            rows={6} placeholder="Body HTML" className="font-mono text-xs"
            data-testid="template-body-textarea" />
          <div className="grid grid-cols-2 gap-2">
            <Input value={ctaText} onChange={(e) => setCtaText(e.target.value)} placeholder="CTA text (optional)" />
            <Input value={ctaUrl} onChange={(e) => setCtaUrl(e.target.value)} placeholder="CTA URL (optional)" />
          </div>
          <Button onClick={create} disabled={creating} className="w-full bg-emerald-500 hover:bg-emerald-600 text-white" data-testid="save-template-btn">
            <Save className="w-4 h-4 mr-2" /> {creating ? 'Saving…' : 'Save template'}
          </Button>
        </div>
      </Card>

      <Card className="p-5">
        <h2 className="text-lg font-semibold flex items-center gap-2 mb-3">
          <FileText className="w-5 h-5 text-blue-500" /> Saved templates
          <span className="text-sm font-normal text-gray-500">· {templates.length}</span>
        </h2>
        {loading ? (
          <p className="text-sm text-gray-500">Loading…</p>
        ) : templates.length === 0 ? (
          <p className="text-sm text-gray-500">None yet.</p>
        ) : (
          <div className="space-y-2 max-h-[600px] overflow-y-auto">
            {templates.map((t) => (
              <div key={t.id} className="p-3 rounded-lg border border-gray-200 bg-white hover:border-gray-300">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="font-medium text-sm">{t.name}</div>
                    <div className="text-xs text-gray-500 truncate">{t.subject}</div>
                  </div>
                  <button onClick={() => remove(t.id)} className="text-red-500 hover:text-red-700">
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}

// =============================================================================
// SUPPRESSIONS
// =============================================================================
function SuppressionsTab() {
  const [list, setList] = useState([]);
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState('');
  const [reason, setReason] = useState('');

  const fetchList = useCallback(async () => {
    setLoading(true);
    try {
      const r = await axios.get(`${API}/api/admin/email-hub/suppressions`, { headers: tokenHdr() });
      setList(r.data.suppressions || []);
    } catch (e) {
      toast.error(`Failed to load: ${e?.response?.data?.detail || e.message}`);
    } finally { setLoading(false); }
  }, []);
  useEffect(() => { fetchList(); }, [fetchList]);

  const add = async () => {
    if (!adding.trim()) return;
    try {
      await axios.post(`${API}/api/admin/email-hub/suppressions`, { email: adding.trim(), reason }, { headers: tokenHdr() });
      toast.success('Added to suppression list');
      setAdding(''); setReason('');
      fetchList();
    } catch (e) {
      toast.error(`Failed: ${e?.response?.data?.detail || e.message}`);
    }
  };

  const remove = async (email) => {
    if (!window.confirm(`Re-subscribe ${email}?`)) return;
    try {
      await axios.delete(`${API}/api/admin/email-hub/suppressions/${encodeURIComponent(email)}`, { headers: tokenHdr() });
      toast.success('Removed (re-subscribed)');
      fetchList();
    } catch (e) {
      toast.error(`Failed: ${e?.response?.data?.detail || e.message}`);
    }
  };

  return (
    <Card className="p-5">
      <h2 className="text-lg font-semibold flex items-center gap-2 mb-3">
        <Ban className="w-5 h-5 text-red-500" /> Suppression list
        <span className="text-sm font-normal text-gray-500">· {list.length}</span>
      </h2>
      <p className="text-sm text-gray-500 mb-4">
        Customers who unsubscribed (one-click), bounced, or were manually opted out.
        These are auto-skipped on every campaign send. Transactional emails (orders, refunds) still go through.
      </p>

      <div className="flex gap-2 mb-4">
        <Input value={adding} onChange={(e) => setAdding(e.target.value)}
          placeholder="email@example.com"
          data-testid="add-suppression-input" />
        <Input value={reason} onChange={(e) => setReason(e.target.value)}
          placeholder="Reason (optional)" />
        <Button onClick={add} data-testid="add-suppression-btn"><Plus className="w-4 h-4" /> Add</Button>
      </div>

      {loading ? (
        <p className="text-sm text-gray-500">Loading…</p>
      ) : list.length === 0 ? (
        <p className="text-sm text-gray-500">No suppressions yet.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm" data-testid="suppression-table">
            <thead>
              <tr className="text-left border-b border-gray-200">
                <th className="py-2 px-2 font-medium text-gray-500">Email</th>
                <th className="py-2 px-2 font-medium text-gray-500">Source</th>
                <th className="py-2 px-2 font-medium text-gray-500">Reason</th>
                <th className="py-2 px-2 font-medium text-gray-500">When</th>
                <th className="py-2 px-2 font-medium text-gray-500"></th>
              </tr>
            </thead>
            <tbody>
              {list.map((s) => (
                <tr key={s.email} className="border-b border-gray-100 hover:bg-gray-50">
                  <td className="py-2 px-2 font-mono text-xs">{s.email}</td>
                  <td className="py-2 px-2 text-xs">
                    <span className="px-2 py-0.5 bg-gray-100 rounded-full text-gray-700">{s.source || 'unknown'}</span>
                  </td>
                  <td className="py-2 px-2 text-xs text-gray-600">{s.reason || '—'}</td>
                  <td className="py-2 px-2 text-xs text-gray-500">{fmtDateTime(s.unsubscribed_at)}</td>
                  <td className="py-2 px-2 text-right">
                    <button onClick={() => remove(s.email)} className="text-xs text-blue-600 hover:underline">
                      Re-subscribe
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}
