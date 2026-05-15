/**
 * GscConnectCard — admin card that shows Google Search Console connection
 * status and lets a super_admin connect / disconnect.
 *
 * Phase 1 only handles OAuth + connection. Future phases will hang
 * search-analytics + url-inspection + sitemaps panels off the same status
 * payload (so the card auto-upgrades when those endpoints exist).
 *
 * Lives at the top of /admin/seo above the Ahrefs header.
 */
import React, { useEffect, useState, useCallback } from 'react';
import axios from 'axios';
import { toast } from 'sonner';
import { CheckCircle2, ExternalLink, Globe, Loader2, PlugZap, Search, Unlink } from 'lucide-react';
import { Button } from '../../components/ui/button';

const API_URL = process.env.REACT_APP_BACKEND_URL;
const token = () => localStorage.getItem('token') || localStorage.getItem('access_token') || '';

const GscConnectCard = ({ onConnectionChange }) => {
  const [status, setStatus] = useState(null);
  const [loading, setLoading] = useState(true);
  const [connecting, setConnecting] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const [sites, setSites] = useState(null);

  const fetchStatus = useCallback(async () => {
    try {
      const res = await axios.get(`${API_URL}/api/admin/gsc/status`, {
        headers: { Authorization: `Bearer ${token()}` },
      });
      setStatus(res.data);
      if (typeof onConnectionChange === 'function') {
        onConnectionChange(!!res.data?.connected);
      }
      // Once connected, fetch the verified properties as a smoke test.
      if (res.data?.connected) {
        try {
          const sitesRes = await axios.get(`${API_URL}/api/admin/gsc/sites`, {
            headers: { Authorization: `Bearer ${token()}` },
          });
          setSites(sitesRes.data?.sites || []);
        } catch {
          // If listing sites fails (e.g. no properties yet), just clear.
          setSites([]);
        }
      } else {
        setSites(null);
      }
    } catch (e) {
      // 401/403 — admin not logged in or not authorised
    } finally {
      setLoading(false);
    }
  }, []);

  // Pick up the redirect-back query string after Google's OAuth round-trip.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const gsc = params.get('gsc');
    const reason = params.get('reason');
    const email = params.get('email');
    if (gsc === 'connected') {
      toast.success(email ? `Search Console connected as ${email}` : 'Search Console connected');
      // Clean the URL so refreshes don't re-toast.
      const cleanUrl = window.location.pathname + window.location.hash;
      window.history.replaceState({}, document.title, cleanUrl);
    } else if (gsc === 'error') {
      toast.error(`Search Console connection failed${reason ? ` — ${reason.replace(/_/g, ' ')}` : ''}`);
      const cleanUrl = window.location.pathname + window.location.hash;
      window.history.replaceState({}, document.title, cleanUrl);
    }
    fetchStatus();
  }, [fetchStatus]);

  const handleConnect = async () => {
    if (connecting) return;
    setConnecting(true);
    try {
      const res = await axios.get(`${API_URL}/api/admin/gsc/connect?return_to=/admin/seo`, {
        headers: { Authorization: `Bearer ${token()}` },
      });
      const url = res.data?.authorization_url;
      if (!url) throw new Error('Missing authorisation URL');
      // Full-page redirect — Google's consent screen blocks iframes.
      window.location.href = url;
    } catch (e) {
      setConnecting(false);
      toast.error(e?.response?.data?.detail || 'Could not start Search Console connection');
    }
  };

  const handleDisconnect = async () => {
    if (disconnecting) return;
    if (!window.confirm('Disconnect Google Search Console? You can reconnect any time.')) return;
    setDisconnecting(true);
    try {
      await axios.post(`${API_URL}/api/admin/gsc/disconnect`, {}, {
        headers: { Authorization: `Bearer ${token()}` },
      });
      toast.success('Search Console disconnected');
      setStatus({ connected: false, configured: status?.configured });
      setSites(null);
      if (typeof onConnectionChange === 'function') onConnectionChange(false);
    } catch (e) {
      toast.error(e?.response?.data?.detail || 'Disconnect failed');
    } finally {
      setDisconnecting(false);
    }
  };

  if (loading) {
    return (
      <div
        className="rounded-2xl border border-slate-200 bg-white p-6 flex items-center gap-3 text-slate-500"
        data-testid="gsc-connect-card-loading"
      >
        <Loader2 className="w-4 h-4 animate-spin" /> Checking Search Console connection…
      </div>
    );
  }

  const connected = !!status?.connected;
  const configured = !!status?.configured;
  const email = status?.google_account_email;
  // 16 May 2026 — if the refresh token was revoked / expired, the
  // backend now surfaces `previously_connected: true` so we can show a
  // "Reconnect" prompt rather than a generic first-time-setup blurb.
  const previouslyConnected = !connected && !!status?.previously_connected;
  const tokenRevoked = previouslyConnected && status?.reason === "token_revoked";

  return (
    <div
      className="rounded-2xl border border-slate-200 bg-gradient-to-br from-white via-white to-blue-50/50 p-6 shadow-sm"
      data-testid="gsc-connect-card"
    >
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex items-start gap-4 min-w-0">
          <div
            className={`w-11 h-11 rounded-xl flex items-center justify-center flex-shrink-0 ${
              connected ? 'bg-emerald-100 text-emerald-700' : 'bg-blue-100 text-blue-700'
            }`}
          >
            {connected ? <CheckCircle2 className="w-6 h-6" /> : <Search className="w-6 h-6" />}
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <h2 className="text-lg font-semibold text-slate-900">Google Search Console</h2>
              {connected ? (
                <span
                  className="inline-flex items-center gap-1 text-[11px] font-semibold uppercase tracking-wider px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-700"
                  data-testid="gsc-status-connected"
                >
                  <CheckCircle2 className="w-3 h-3" /> Connected
                </span>
              ) : tokenRevoked ? (
                <span
                  className="inline-flex items-center text-[11px] font-semibold uppercase tracking-wider px-2 py-0.5 rounded-full bg-amber-100 text-amber-700"
                  data-testid="gsc-status-token-revoked"
                >
                  Reconnect required
                </span>
              ) : (
                <span
                  className="inline-flex items-center text-[11px] font-semibold uppercase tracking-wider px-2 py-0.5 rounded-full bg-slate-100 text-slate-600"
                  data-testid="gsc-status-not-connected"
                >
                  Not connected
                </span>
              )}
            </div>
            {connected ? (
              <p className="text-sm text-slate-600 mt-1">
                Connected as <span className="font-medium text-slate-800">{email || 'your Google account'}</span>.
                Phase 1 done — Phase 2 will pull search analytics into this card.
              </p>
            ) : tokenRevoked ? (
              <p className="text-sm text-amber-800 mt-1 max-w-2xl" data-testid="gsc-token-revoked-blurb">
                Your previous Search Console connection
                {email ? <> (<span className="font-medium text-amber-900">{email}</span>)</> : null}
                {' '}was revoked or expired (Google rejected the refresh token). Click
                <span className="font-medium"> Reconnect Search Console</span> to restore search analytics.
              </p>
            ) : (
              <p className="text-sm text-slate-600 mt-1 max-w-2xl">
                Sign in with the Google account that owns your verified
                <span className="font-medium text-slate-800"> tilestation.co.uk</span> property.
                We&apos;ll store a refresh token so we can read your search analytics, indexed
                URLs and sitemaps without asking you to sign in again.
              </p>
            )}

            {connected && Array.isArray(sites) && (
              <div className="mt-3" data-testid="gsc-sites-list">
                <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-500 mb-1">
                  Verified properties on this Google account
                </p>
                {sites.length === 0 ? (
                  <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
                    No properties found. If you just verified <code>tilestation.co.uk</code>, give Google
                    a minute to propagate. Otherwise, ensure you&apos;re signed in with the same Google
                    account that verified the property.
                  </p>
                ) : (
                  <ul className="flex flex-wrap gap-2">
                    {sites.slice(0, 8).map((s) => (
                      <li
                        key={s.site_url}
                        className="inline-flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-lg bg-white border border-slate-200 text-slate-700"
                        data-testid={`gsc-site-${s.site_url}`}
                      >
                        <Globe className="w-3 h-3 text-slate-400" />
                        <span className="font-medium">{s.site_url}</span>
                        <span className="text-slate-400">·</span>
                        <span className="text-[10px] uppercase tracking-wider">{s.permission_level || 'unknown'}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </div>
        </div>

        <div className="flex items-center gap-2 flex-shrink-0">
          {!configured ? (
            <div
              className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 max-w-xs"
              data-testid="gsc-not-configured"
            >
              <p className="font-semibold mb-0.5">Server credentials missing</p>
              <p>Backend env needs <code>GOOGLE_CLIENT_ID</code> and <code>GOOGLE_CLIENT_SECRET</code>. Drop them in and reload.</p>
            </div>
          ) : connected ? (
            <Button
              variant="outline"
              size="sm"
              onClick={handleDisconnect}
              disabled={disconnecting}
              className="border-slate-300 text-slate-700 hover:bg-slate-50"
              data-testid="gsc-disconnect-btn"
            >
              {disconnecting ? <Loader2 className="w-3.5 h-3.5 animate-spin mr-1.5" /> : <Unlink className="w-3.5 h-3.5 mr-1.5" />}
              Disconnect
            </Button>
          ) : (
            <Button
              size="sm"
              onClick={handleConnect}
              disabled={connecting}
              className={tokenRevoked
                ? "bg-amber-600 hover:bg-amber-700 text-white"
                : "bg-blue-600 hover:bg-blue-700 text-white"}
              data-testid="gsc-connect-btn"
            >
              {connecting ? <Loader2 className="w-3.5 h-3.5 animate-spin mr-1.5" /> : <PlugZap className="w-3.5 h-3.5 mr-1.5" />}
              {tokenRevoked ? 'Reconnect Search Console' : 'Connect Search Console'}
            </Button>
          )}
          <a
            href="https://search.google.com/search-console"
            target="_blank"
            rel="noreferrer"
            className="text-xs text-slate-500 hover:text-slate-800 inline-flex items-center gap-1"
            data-testid="gsc-open-console-link"
          >
            <ExternalLink className="w-3 h-3" /> Open Console
          </a>
        </div>
      </div>
    </div>
  );
};

export default GscConnectCard;
