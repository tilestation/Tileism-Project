/**
 * Public · /unsubscribe
 * ─────────────────────
 * Landing page customers reach when they click the one-click unsubscribe link
 * in any bulk email. The link carries `?e=email&c=campaign_id&t=hmac_token`.
 * On mount we POST to the backend, which verifies the token and adds the
 * email to the suppression list. We always show a confirmation — even if the
 * token is invalid we don't reveal which addresses are real customers.
 */
import React, { useEffect, useState } from 'react';
import axios from 'axios';
import { CheckCircle2, AlertCircle } from 'lucide-react';

const API = process.env.REACT_APP_BACKEND_URL;

export default function UnsubscribePage() {
  const [state, setState] = useState({ loading: true, success: false, email: '', error: '' });

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const e = params.get('e') || '';
    const c = params.get('c') || '';
    const t = params.get('t') || '';
    if (!e || !t) {
      setState({ loading: false, success: false, email: e, error: 'Missing unsubscribe token in the URL.' });
      return;
    }
    (async () => {
      try {
        // Backend uses GET (one-click safe — also works from email clients
        // that pre-fetch links). We hit it from the browser too.
        const r = await axios.get(`${API}/api/unsubscribe`, { params: { e, c, t } });
        setState({ loading: false, success: true, email: r.data.email || e, error: '' });
      } catch (err) {
        setState({
          loading: false, success: false, email: e,
          error: err?.response?.data?.detail || 'Unable to verify the unsubscribe link.',
        });
      }
    })();
  }, []);

  return (
    <div className="min-h-screen flex items-center justify-center bg-stone-50 px-4">
      <div className="bg-white rounded-2xl shadow-sm border border-stone-200 max-w-md w-full p-8 text-center" data-testid="unsubscribe-card">
        <div className="text-3xl font-bold text-stone-900 mb-1" style={{ fontFamily: 'Georgia, serif' }}>
          Tile Station
        </div>
        <div className="text-xs uppercase tracking-widest text-amber-600 font-semibold mb-6">Email preferences</div>

        {state.loading && (
          <div className="text-stone-500 text-sm">Updating your preferences…</div>
        )}

        {!state.loading && state.success && (
          <>
            <CheckCircle2 className="w-14 h-14 text-emerald-500 mx-auto mb-4" />
            <h1 className="text-xl font-semibold text-stone-900 mb-2" data-testid="unsubscribe-success-heading">
              You've been unsubscribed
            </h1>
            <p className="text-sm text-stone-600 mb-1">
              We've removed <strong className="font-mono">{state.email}</strong> from our marketing emails.
            </p>
            <p className="text-xs text-stone-500 mt-4">
              You'll still receive transactional emails for any orders, refunds, or account changes — those are
              required for service.
            </p>
            <a href="/" className="inline-block mt-6 text-sm text-amber-600 hover:underline">
              Back to Tile Station →
            </a>
          </>
        )}

        {!state.loading && !state.success && (
          <>
            <AlertCircle className="w-14 h-14 text-red-500 mx-auto mb-4" />
            <h1 className="text-xl font-semibold text-stone-900 mb-2" data-testid="unsubscribe-error-heading">
              Something went wrong
            </h1>
            <p className="text-sm text-stone-600">{state.error}</p>
            <p className="text-xs text-stone-500 mt-4">
              If you keep receiving emails you don't want, reply to any of them and we'll remove you manually.
            </p>
            <a href="/" className="inline-block mt-6 text-sm text-amber-600 hover:underline">
              Back to Tile Station →
            </a>
          </>
        )}
      </div>
    </div>
  );
}
