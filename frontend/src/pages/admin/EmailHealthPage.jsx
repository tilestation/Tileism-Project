import React, { useEffect, useState } from 'react';
import axios from 'axios';
import { toast } from 'sonner';
import { Mail, CheckCircle2, AlertTriangle, Send, Loader2, ExternalLink } from 'lucide-react';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';

const API_URL = process.env.REACT_APP_BACKEND_URL;

/**
 * Admin → Email Health
 *
 * At-a-glance dashboard for the transactional-email pipeline (Resend).
 * Surfaces:
 *   • Resend API key configured? (probe via the existing test-email
 *     endpoint — anything other than 500/"key missing" means OK)
 *   • Configured sender address (`SENDER_EMAIL` env on the backend,
 *     returned in the test-email response).
 *   • "Email me a test" button — sends to the logged-in admin by
 *     default; editable in case you want to verify a showroom inbox.
 *
 * Backend: POST /api/shop/admin/test-email already exists. We don't
 * add a separate /email-health/status endpoint because the test-email
 * endpoint itself is a perfectly fine liveness probe (and avoids
 * duplicating the Resend-init logic in two places).
 */
const tokenHdr = () => {
  const t = localStorage.getItem('token');
  return t ? { Authorization: `Bearer ${t}` } : {};
};

const EmailHealthPage = () => {
  const [status, setStatus] = useState({ checking: true, ok: null, sender: null, error: null });
  const [recipient, setRecipient] = useState('');
  const [sending, setSending] = useState(false);
  const [lastSentAt, setLastSentAt] = useState(null);

  // Prefill the recipient input with the currently logged-in admin's
  // email (the most common case is "send myself a test"). Reads from
  // localStorage so we don't need to thread props through.
  useEffect(() => {
    try {
      const userJson = localStorage.getItem('user');
      if (userJson) {
        const user = JSON.parse(userJson);
        if (user?.email) setRecipient(user.email);
      }
    } catch (_e) {
      /* ignore */
    }
  }, []);

  // On mount, probe the Resend status by attempting a no-op send.
  // We use a syntactically-valid but obviously-fake address so the
  // endpoint runs the full code path (and thus tells us whether the
  // API key is configured) without actually delivering anything if
  // Resend rejects the recipient.
  //
  // Possible outcomes:
  //   • 200 OK → key is configured + sender domain works → status OK,
  //     read `sender` from the response.
  //   • 422 (Pydantic validation on the address) → key path was never
  //     reached, treat as "unknown until user sends a real test"
  //     rather than red. Show neutral state.
  //   • 500 with "Resend API key missing" → key NOT configured → red.
  //   • Any other error → red with the raw message.
  useEffect(() => {
    let alive = true;
    const stringifyError = (raw) => {
      if (!raw) return null;
      if (typeof raw === 'string') return raw;
      if (Array.isArray(raw)) {
        return raw.map((x) => x?.msg || JSON.stringify(x)).join('; ');
      }
      if (typeof raw === 'object') {
        return raw.msg || raw.message || JSON.stringify(raw);
      }
      return String(raw);
    };
    const probe = async () => {
      try {
        const r = await axios.post(
          `${API_URL}/api/shop/admin/test-email`,
          { to_email: 'healthcheck@example.invalid' },
          { headers: tokenHdr() }
        );
        if (alive) setStatus({ checking: false, ok: true, sender: r.data?.sender, error: null });
      } catch (err) {
        if (!alive) return;
        const code = err?.response?.status;
        const detail = stringifyError(err?.response?.data?.detail) || err.message;
        // 422 on the address means the key path wasn't even reached →
        // we genuinely don't know yet. Show neutral state instead of
        // a red alarm; the user clicking "Email me a test" will give
        // us a definitive answer.
        if (code === 422) {
          setStatus({ checking: false, ok: null, sender: null, error: null });
          return;
        }
        const looksLikeAddressRejection =
          typeof detail === 'string' &&
          (detail.toLowerCase().includes('invalid') ||
           detail.toLowerCase().includes('recipient') ||
           detail.toLowerCase().includes('address') ||
           detail.toLowerCase().includes('domain'));
        if (looksLikeAddressRejection) {
          setStatus({ checking: false, ok: true, sender: null, error: null });
        } else {
          setStatus({ checking: false, ok: false, sender: null, error: detail });
        }
      }
    };
    probe();
    return () => { alive = false; };
  }, []);

  const sendTest = async () => {
    if (!recipient || !recipient.trim()) {
      toast.error('Enter an email address first');
      return;
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipient.trim())) {
      toast.error('That doesn\'t look like a valid email address');
      return;
    }
    setSending(true);
    try {
      const r = await axios.post(
        `${API_URL}/api/shop/admin/test-email`,
        { to_email: recipient.trim() },
        { headers: tokenHdr() }
      );
      toast.success(`Test email sent to ${recipient}`, {
        description: r.data?.sender ? `From: ${r.data.sender}` : undefined,
      });
      setLastSentAt(new Date().toISOString());
      // Refresh status with the real sender now that we have it
      if (r.data?.sender) {
        setStatus((s) => ({ ...s, ok: true, sender: r.data.sender, error: null }));
      }
    } catch (err) {
      const raw = err?.response?.data?.detail;
      let msg;
      if (typeof raw === 'string') msg = raw;
      else if (Array.isArray(raw)) msg = raw.map((x) => x?.msg || JSON.stringify(x)).join('; ');
      else if (raw && typeof raw === 'object') msg = raw.msg || raw.message || JSON.stringify(raw);
      else msg = err.message || 'Failed to send test email';
      toast.error(msg);
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="max-w-3xl mx-auto p-4 sm:p-6 space-y-6" data-testid="email-health-page">
      <header className="flex items-start gap-3">
        <div className="p-2 rounded-lg bg-blue-50 text-blue-600">
          <Mail className="w-6 h-6" />
        </div>
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Email Health</h1>
          <p className="text-sm text-gray-500 mt-1">
            Verify the transactional-email pipeline is wired up correctly.
            Send a test email to any address to confirm Resend + your
            sender domain are working.
          </p>
        </div>
      </header>

      {/* Status card */}
      <div className="bg-white border border-gray-200 rounded-xl p-5 shadow-sm" data-testid="email-health-status-card">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <div className="flex items-center gap-2">
            <h2 className="text-sm font-bold uppercase tracking-wider text-gray-500">Resend status</h2>
          </div>
          {status.checking && (
            <span className="text-xs text-gray-400 flex items-center gap-1">
              <Loader2 className="w-3 h-3 animate-spin" />
              Probing…
            </span>
          )}
        </div>
        <div className="mt-3 flex items-center gap-3" data-testid="email-health-status-row">
          {status.checking ? (
            <Loader2 className="w-5 h-5 text-gray-400 animate-spin" />
          ) : status.ok === true ? (
            <CheckCircle2 className="w-5 h-5 text-emerald-500" />
          ) : status.ok === false ? (
            <AlertTriangle className="w-5 h-5 text-rose-500" />
          ) : (
            <Mail className="w-5 h-5 text-gray-400" />
          )}
          <div>
            <div className={`font-semibold ${
              status.checking ? 'text-gray-500'
                : status.ok === true ? 'text-emerald-700'
                : status.ok === false ? 'text-rose-700'
                : 'text-gray-600'
            }`} data-testid="email-health-status-label">
              {status.checking
                ? 'Checking Resend…'
                : status.ok === true
                  ? 'Resend API key configured · ready to send'
                  : status.ok === false
                    ? 'Resend not configured'
                    : 'Send a test below to confirm setup'}
            </div>
            {status.sender && (
              <div className="text-xs text-gray-500 mt-0.5" data-testid="email-health-sender">
                Sender: <span className="font-mono text-gray-700">{status.sender}</span>
              </div>
            )}
            {status.error && !status.ok && (
              <div className="text-xs text-rose-600 mt-0.5" data-testid="email-health-error">
                {status.error}
              </div>
            )}
          </div>
        </div>
        {!status.checking && status.ok === false && (
          <div className="mt-3 bg-rose-50 border border-rose-200 rounded-lg p-3 text-xs text-rose-700">
            Add <code className="font-mono bg-rose-100 px-1 rounded">RESEND_API_KEY</code> to the
            backend <code className="font-mono bg-rose-100 px-1 rounded">.env</code>, then redeploy.
            Get a key at{' '}
            <a
              href="https://resend.com/api-keys"
              target="_blank"
              rel="noopener noreferrer"
              className="underline inline-flex items-center gap-1"
            >
              resend.com/api-keys
              <ExternalLink className="w-3 h-3" />
            </a>
            .
          </div>
        )}
      </div>

      {/* Send-test card */}
      <div className="bg-white border border-gray-200 rounded-xl p-5 shadow-sm" data-testid="email-health-test-card">
        <h2 className="text-sm font-bold uppercase tracking-wider text-gray-500 mb-3">Send a test email</h2>
        <p className="text-sm text-gray-600 mb-3">
          Verify your sender domain is delivering. Useful after adding a new
          showroom's <code className="font-mono text-xs bg-gray-100 px-1 rounded">SENDER_EMAIL</code> or
          flipping DNS records in Resend.
        </p>
        <div className="flex flex-col sm:flex-row gap-2 items-start sm:items-end">
          <div className="flex-1 w-full">
            <label htmlFor="email-health-recipient" className="block text-xs font-medium text-gray-600 mb-1">
              Recipient
            </label>
            <Input
              id="email-health-recipient"
              type="email"
              placeholder="you@example.com"
              value={recipient}
              onChange={(e) => setRecipient(e.target.value)}
              disabled={sending}
              data-testid="email-health-recipient-input"
              className="w-full"
            />
          </div>
          <Button
            onClick={sendTest}
            disabled={sending || status.checking}
            data-testid="email-health-send-btn"
            className="bg-emerald-600 hover:bg-emerald-700 text-white"
          >
            {sending ? (
              <>
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                Sending…
              </>
            ) : (
              <>
                <Send className="w-4 h-4 mr-2" />
                Email me a test
              </>
            )}
          </Button>
        </div>
        {lastSentAt && (
          <div className="text-xs text-gray-500 mt-3" data-testid="email-health-last-sent">
            Last sent: {new Date(lastSentAt).toLocaleString('en-GB', {
              dateStyle: 'short',
              timeStyle: 'short',
            })}
            {' '}— check your inbox (and the spam folder).
          </div>
        )}
      </div>
    </div>
  );
};

export default EmailHealthPage;
