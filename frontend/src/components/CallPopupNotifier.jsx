/**
 * CallPopupNotifier (Feb 2026).
 *
 * Mounted once at the admin Layout level. Polls /api/admin/voice/incoming-now
 * every 4 seconds and pops a sticky modal when a new inbound call is
 * ringing. Shows the matched customer's name + last order details so the
 * admin can answer with full context ("Hello Carolina, calling about
 * order TS-260616-30E725?") instead of "What's your reference?"
 *
 * Dedupes by call_sid so the same ringing call doesn't keep re-popping;
 * dismissed sids are remembered in sessionStorage so a page refresh
 * doesn't re-fire the alert.
 */
import React, { useEffect, useState, useRef, useCallback } from 'react';
import axios from 'axios';
import {
  PhoneIncoming, X, UserRound, ShoppingBag, AlertCircle, ExternalLink,
} from 'lucide-react';

const API = process.env.REACT_APP_BACKEND_URL;
const POLL_MS = 4000;
const DISMISSED_KEY = 'call_popup_dismissed_sids';

const getDismissed = () => {
  try {
    return new Set(JSON.parse(sessionStorage.getItem(DISMISSED_KEY) || '[]'));
  } catch { return new Set(); }
};
const saveDismissed = (set) => {
  try {
    sessionStorage.setItem(DISMISSED_KEY, JSON.stringify(Array.from(set).slice(-50)));
  } catch { /* ignore quota */ }
};

export default function CallPopupNotifier() {
  const [activeCall, setActiveCall] = useState(null);
  const dismissedRef = useRef(getDismissed());
  const audioRef = useRef(null);

  const poll = useCallback(async () => {
    const token = localStorage.getItem('token');
    if (!token) return;
    try {
      const r = await axios.get(`${API}/api/admin/voice/incoming-now`,
        { headers: { Authorization: `Bearer ${token}` }, timeout: 8000 });
      const calls = r.data?.calls || [];
      // Find the first call we haven't already dismissed
      const next = calls.find((c) => c.call_sid && !dismissedRef.current.has(c.call_sid));
      if (next && (!activeCall || next.call_sid !== activeCall.call_sid)) {
        setActiveCall(next);
        // Play a soft notification ping (data URI; no asset needed)
        try { audioRef.current?.play(); } catch { /* user gesture not granted yet */ }
      } else if (!next && activeCall) {
        // Call ended naturally → close the popup
        setActiveCall(null);
      }
    } catch {
      // Silent — admin shouldn't see polling errors
    }
  }, [activeCall]);

  useEffect(() => {
    poll();
    const id = setInterval(poll, POLL_MS);
    return () => clearInterval(id);
  }, [poll]);

  const dismiss = () => {
    if (activeCall?.call_sid) {
      dismissedRef.current.add(activeCall.call_sid);
      saveDismissed(dismissedRef.current);
    }
    setActiveCall(null);
  };

  if (!activeCall) {
    return (
      <audio ref={audioRef} preload="auto" data-testid="call-popup-audio">
        {/* Tiny "ding" tone as a base64 WAV — no asset to bundle */}
        <source
          src="data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA="
          type="audio/wav"
        />
      </audio>
    );
  }

  const m = activeCall.customer_match || {};
  const lo = m.last_order || {};

  return (
    <>
      <div className="fixed top-4 right-4 z-[200] w-[360px] max-w-[92vw] rounded-xl shadow-2xl bg-white border-2 border-emerald-500 overflow-hidden animate-pulse-slow"
        data-testid="call-popup">
        <div className="bg-emerald-600 text-white px-4 py-2 flex items-center justify-between">
          <span className="text-xs font-bold uppercase tracking-wider flex items-center gap-1.5">
            <PhoneIncoming className="w-4 h-4 animate-pulse" />
            Incoming call
          </span>
          <button onClick={dismiss} className="hover:bg-emerald-700 rounded p-1"
            aria-label="Dismiss" data-testid="call-popup-dismiss">
            <X className="w-4 h-4" />
          </button>
        </div>
        <div className="px-4 py-3 space-y-2">
          {m.matched ? (
            <>
              <div>
                <p className="text-xl font-bold leading-tight" data-testid="call-popup-name">
                  {m.name || 'Customer'}
                </p>
                <p className="text-xs font-mono text-gray-600">{activeCall.from_number}</p>
                {m.email && (
                  <p className="text-xs text-gray-600 truncate" title={m.email}>{m.email}</p>
                )}
              </div>
              {m.match_type === 'shop_orders' && (
                <div className="bg-emerald-50 rounded-md px-2 py-1.5 text-xs">
                  <div className="flex items-center gap-1.5 font-bold text-emerald-900">
                    <UserRound className="w-3.5 h-3.5" />
                    Returning customer · {m.order_count || 1} order{(m.order_count || 1) > 1 ? 's' : ''}
                    {m.lifetime_value > 0 && ` · £${Number(m.lifetime_value).toLocaleString('en-GB')} lifetime`}
                  </div>
                </div>
              )}
              {lo.order_number && (
                <a href={`/admin/online-orders?q=${encodeURIComponent(lo.order_number)}`}
                   className="block bg-gray-50 hover:bg-indigo-50 rounded-md px-2 py-1.5 text-xs border border-gray-200"
                   data-testid="call-popup-last-order">
                  <div className="flex items-center justify-between">
                    <span className="font-bold flex items-center gap-1.5">
                      <ShoppingBag className="w-3.5 h-3.5 text-indigo-700" />
                      {m.match_type === 'sample_order' ? 'Sample request' :
                       m.match_type === 'quote' ? 'Quote' : 'Last order'}
                    </span>
                    <ExternalLink className="w-3 h-3 text-gray-400" />
                  </div>
                  <div className="font-mono text-[11px] mt-0.5">{lo.order_number}</div>
                  {(lo.total || lo.status) && (
                    <div className="text-[11px] text-gray-700 mt-0.5">
                      {lo.total > 0 && <>£{Number(lo.total).toLocaleString('en-GB')} · </>}
                      {lo.status}
                      {lo.created_at && <> · {String(lo.created_at).slice(0, 10)}</>}
                    </div>
                  )}
                </a>
              )}
            </>
          ) : (
            <div className="space-y-1">
              <p className="text-lg font-bold font-mono" data-testid="call-popup-name">
                {activeCall.from_number}
              </p>
              <div className="flex items-center gap-1.5 text-xs text-amber-700">
                <AlertCircle className="w-3.5 h-3.5" />
                Unknown caller — no order/quote on file
              </div>
            </div>
          )}
        </div>
      </div>
    </>
  );
}
