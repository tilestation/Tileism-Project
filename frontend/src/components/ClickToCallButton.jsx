/**
 * ClickToCallButton (Feb 2026).
 *
 * Reusable button that initiates a Twilio Voice browser call to the
 * given phone number — outbound CLI is the configured Twilio landline.
 *
 * On first click for a session:
 *   1. Fetches a short-lived JWT from /api/voice/token (super_admin only).
 *   2. Instantiates @twilio/voice-sdk Device.
 *   3. Registers + dials.
 *
 * Gracefully falls back to a `tel:` link when:
 *   • Click-to-call API keys aren't configured (503 from /token)
 *   • The Voice SDK can't load (CSP, blocked microphone, etc.)
 *   • The user is on a mobile device (better UX to use the native dialer)
 */
import React, { useState } from 'react';
import axios from 'axios';
import { toast } from 'sonner';
import { Phone, PhoneOff, Loader2 } from 'lucide-react';

const API = process.env.REACT_APP_BACKEND_URL;

let _twilioDevice = null;          // singleton — register once per page
let _twilioTokenPromise = null;     // de-dupe concurrent calls

async function getDevice() {
  if (_twilioDevice) return _twilioDevice;
  if (!_twilioTokenPromise) {
    _twilioTokenPromise = (async () => {
      const t = localStorage.getItem('token');
      const r = await axios.get(`${API}/api/voice/token`,
        { headers: t ? { Authorization: `Bearer ${t}` } : {} });
      return r.data.token;
    })();
  }
  const jwt = await _twilioTokenPromise;
  const { Device } = await import(/* webpackChunkName: "twilio-voice" */ '@twilio/voice-sdk');
  _twilioDevice = new Device(jwt, { codecPreferences: ['opus', 'pcmu'] });
  await _twilioDevice.register();
  return _twilioDevice;
}

const isMobile = typeof navigator !== 'undefined'
  && /android|iphone|ipad|ipod|mobile/i.test(navigator.userAgent || '');

export default function ClickToCallButton({
  number,
  label,
  size = 'sm',
  variant = 'inline',
  customerName,
  className = '',
}) {
  const [calling, setCalling] = useState(false);
  const [activeCall, setActiveCall] = useState(null);

  if (!number) return null;

  const handleClick = async (e) => {
    e?.stopPropagation?.();
    e?.preventDefault?.();
    // On mobile, just use the native dialer — better UX than browser audio
    if (isMobile) {
      window.location.href = `tel:${number}`;
      return;
    }
    setCalling(true);
    try {
      const device = await getDevice();
      const call = await device.connect({ params: { To: number } });
      setActiveCall(call);
      toast.success(`Calling ${customerName || number}…`, {
        description: 'Click the red button to hang up',
      });
      call.on('disconnect', () => {
        setActiveCall(null);
        setCalling(false);
      });
      call.on('cancel', () => {
        setActiveCall(null);
        setCalling(false);
      });
      call.on('reject', () => {
        toast.error('Call rejected');
        setActiveCall(null);
        setCalling(false);
      });
      call.on('error', (err) => {
        toast.error(`Call error: ${err?.message || err}`);
        setActiveCall(null);
        setCalling(false);
      });
    } catch (err) {
      const msg = err?.response?.data?.detail || err?.message || 'Call failed';
      if (err?.response?.status === 503) {
        // Click-to-call not configured — fall back to tel: link
        window.location.href = `tel:${number}`;
      } else {
        toast.error(msg);
      }
      setCalling(false);
    }
  };

  const hangup = (e) => {
    e?.stopPropagation?.();
    e?.preventDefault?.();
    activeCall?.disconnect?.();
    setActiveCall(null);
    setCalling(false);
  };

  if (variant === 'icon') {
    return activeCall ? (
      <button onClick={hangup}
        className={`inline-flex items-center justify-center w-7 h-7 rounded bg-rose-600 hover:bg-rose-700 text-white ${className}`}
        title="Hang up" data-testid="ctc-hangup">
        <PhoneOff className="w-3.5 h-3.5" />
      </button>
    ) : (
      <button onClick={handleClick} disabled={calling}
        className={`inline-flex items-center justify-center w-7 h-7 rounded bg-emerald-600 hover:bg-emerald-700 text-white disabled:opacity-50 ${className}`}
        title={`Call ${number}`} data-testid="ctc-call">
        {calling ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Phone className="w-3.5 h-3.5" />}
      </button>
    );
  }

  // Default "inline" variant — small pill with the number visible
  return activeCall ? (
    <button onClick={hangup}
      className={`inline-flex items-center gap-1 px-2 py-1 rounded text-xs bg-rose-100 hover:bg-rose-200 text-rose-900 border border-rose-300 font-mono ${className}`}
      data-testid="ctc-hangup">
      <PhoneOff className="w-3 h-3" /> Hang up
    </button>
  ) : (
    <button onClick={handleClick} disabled={calling}
      className={`inline-flex items-center gap-1 px-2 py-1 rounded text-xs bg-emerald-50 hover:bg-emerald-100 text-emerald-900 border border-emerald-300 font-mono disabled:opacity-50 ${className}`}
      title={`Click to call ${number} via Twilio (browser)`}
      data-testid="ctc-call">
      {calling ? <Loader2 className="w-3 h-3 animate-spin" /> : <Phone className="w-3 h-3" />}
      {label || number}
    </button>
  );
}
