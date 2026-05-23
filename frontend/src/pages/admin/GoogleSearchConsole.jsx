/**
 * Google Search Console — admin connect panel.
 *
 * Minimal but production-grade UI mirroring the GBP page pattern:
 *   Disconnected → green "Connect Google Search Console" button
 *   Connected    → list verified properties + Disconnect button
 *
 * The OAuth dance is handled entirely by the backend (`/api/admin/gsc/*`)
 * so this component just calls `/connect` for the consent URL, redirects
 * the browser to Google, then renders the post-callback state when
 * Google bounces back to `/admin/seo?gsc=connected`.
 *
 * Reason for existing (23 May 2026): the SEO Self-Audit "GSC connected"
 * fix hint pointed at `/admin/gsc`, but that route was never registered
 * — so clicking the link bounced the admin back to the homepage via
 * the React Router catch-all.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, CheckCircle2, ExternalLink, Loader2, Search, Unlink } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '../../components/ui/card';
import { Button } from '../../components/ui/button';
import { toast } from 'sonner';

const API = process.env.REACT_APP_BACKEND_URL || '';

export default function GoogleSearchConsole() {
  const navigate = useNavigate();
  const [statusLoading, setStatusLoading] = useState(true);
  const [status, setStatus] = useState({ connected: false, configured: false });
  const [sites, setSites] = useState([]);
  const [busy, setBusy] = useState(false);

  const token = localStorage.getItem('token') || '';

  const authedFetch = useCallback((path, opts = {}) => {
    return fetch(`${API}${path}`, {
      ...opts,
      headers: {
        'Content-Type': 'application/json',
        ...(opts.headers || {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
    });
  }, [token]);

  const fetchStatus = useCallback(async () => {
    setStatusLoading(true);
    try {
      const res = await authedFetch('/api/admin/gsc/status');
      const data = await res.json();
      setStatus(data || { connected: false, configured: false });
      if (data?.connected) {
        const sitesRes = await authedFetch('/api/admin/gsc/sites');
        if (sitesRes.ok) {
          const sitesData = await sitesRes.json();
          setSites(sitesData?.sites || []);
        }
      }
    } catch (e) {
      console.error('GSC status error', e);
    } finally {
      setStatusLoading(false);
    }
  }, [authedFetch]);

  useEffect(() => { fetchStatus(); }, [fetchStatus]);

  const handleConnect = async () => {
    setBusy(true);
    try {
      const res = await authedFetch('/api/admin/gsc/connect?return_to=/admin/gsc');
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || 'Could not start connect flow');
      window.location.href = data.authorization_url;
    } catch (e) {
      toast.error(e.message || 'GSC connect failed');
      setBusy(false);
    }
  };

  const handleDisconnect = async () => {
    if (!window.confirm('Disconnect Google Search Console? You\'ll need to re-authorise to refresh keyword + crawl data.')) return;
    setBusy(true);
    try {
      const res = await authedFetch('/api/admin/gsc/disconnect', { method: 'POST' });
      if (res.ok) {
        toast.success('Disconnected');
        setStatus({ connected: false, configured: status.configured });
        setSites([]);
      } else {
        const data = await res.json().catch(() => ({}));
        toast.error(data.detail || 'Disconnect failed');
      }
    } catch (e) {
      toast.error(e.message);
    } finally {
      setBusy(false);
    }
  };

  if (statusLoading) {
    return (
      <div className="flex items-center justify-center min-h-[60vh]" data-testid="gsc-loading">
        <Loader2 className="w-8 h-8 animate-spin text-slate-400" />
      </div>
    );
  }

  return (
    <div className="max-w-4xl mx-auto p-6 space-y-6" data-testid="gsc-page">
      {/* Header */}
      <div className="flex items-center gap-3">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => navigate('/admin/seo')}
          data-testid="gsc-back-btn"
        >
          <ArrowLeft className="w-4 h-4 mr-2" />
          Back to SEO
        </Button>
      </div>

      <div className="flex items-center gap-4">
        <div className="p-3 rounded-lg bg-blue-50">
          <Search className="w-7 h-7 text-blue-600" />
        </div>
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Google Search Console</h1>
          <p className="text-sm text-slate-500">
            Pulls real impression, click and keyword-ranking data straight from Google — no copy-pasting.
          </p>
        </div>
      </div>

      {/* Disconnected state */}
      {!status.connected && (
        <Card data-testid="gsc-disconnected-card">
          <CardHeader>
            <CardTitle>Connect your Google Search Console</CardTitle>
            <CardDescription>
              Sign in with the Google account that owns <strong>tilestation.co.uk</strong> in
              Search Console. We'll fetch your verified properties, weekly impressions and
              the queries that drive traffic — all visible in the SEO Command Centre.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {!status.configured && (
              <div className="mb-4 p-3 rounded-md bg-amber-50 border border-amber-200 text-sm text-amber-800">
                ⚠ <strong>Backend OAuth not configured.</strong> An admin needs to set
                <code className="mx-1 px-1 bg-amber-100 rounded">GOOGLE_OAUTH_CLIENT_ID</code>,
                <code className="mx-1 px-1 bg-amber-100 rounded">GOOGLE_OAUTH_CLIENT_SECRET</code>,
                and
                <code className="mx-1 px-1 bg-amber-100 rounded">GOOGLE_OAUTH_REDIRECT_URI</code>
                in Railway before this button will work.
              </div>
            )}
            <Button
              onClick={handleConnect}
              disabled={busy || !status.configured}
              className="bg-blue-600 hover:bg-blue-700 text-white"
              data-testid="gsc-connect-btn"
            >
              {busy ? (
                <><Loader2 className="w-4 h-4 mr-2 animate-spin" /> Redirecting to Google…</>
              ) : (
                <><Search className="w-4 h-4 mr-2" /> Connect Google Search Console</>
              )}
            </Button>
          </CardContent>
        </Card>
      )}

      {/* Connected state */}
      {status.connected && (
        <Card data-testid="gsc-connected-card">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <CheckCircle2 className="w-5 h-5 text-emerald-600" />
              Connected
            </CardTitle>
            <CardDescription>
              {status.email
                ? <>Signed in as <strong>{status.email}</strong></>
                : 'Refresh token stored — data syncs nightly.'}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {sites.length > 0 && (
              <div data-testid="gsc-sites">
                <p className="text-sm font-semibold text-slate-700 mb-2">Verified properties:</p>
                <ul className="space-y-1">
                  {sites.map((s, i) => (
                    <li
                      key={`${s.siteUrl || s.url || i}`}
                      className="text-sm text-slate-600 flex items-center gap-2"
                    >
                      <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500" />
                      <a
                        href={s.siteUrl || s.url}
                        target="_blank"
                        rel="noreferrer"
                        className="hover:underline"
                      >
                        {s.siteUrl || s.url}
                      </a>
                      <span className="text-xs text-slate-400">({s.permissionLevel || 'owner'})</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            <div className="flex flex-wrap gap-2 pt-2">
              <Button
                variant="outline"
                onClick={() => navigate('/admin/seo')}
                data-testid="gsc-open-seo-btn"
              >
                <ExternalLink className="w-4 h-4 mr-2" />
                Open SEO Command Centre
              </Button>
              <Button
                variant="ghost"
                onClick={handleDisconnect}
                disabled={busy}
                className="text-red-600 hover:text-red-700 hover:bg-red-50"
                data-testid="gsc-disconnect-btn"
              >
                <Unlink className="w-4 h-4 mr-2" />
                Disconnect
              </Button>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
