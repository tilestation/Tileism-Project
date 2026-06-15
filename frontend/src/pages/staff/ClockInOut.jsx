/**
 * Mobile clock-in / clock-out screen for the showroom door QR (13 Jun 2026).
 *
 * Route: `/clock?token=<showroom_qr_secret>`. Staff scan the door QR
 * with their phone, log in if they aren't already (existing auth flow
 * handles that), then this page either clocks them in or out
 * depending on whether they currently have an open entry.
 *
 * Big touch-friendly buttons because this is the first thing a tired
 * fitter sees at 7am with cold fingers — no fancy UI here, just
 * "what's going to happen" + a fat green/red button.
 */
import React, { useState, useEffect, useCallback } from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';
import axios from 'axios';
import { toast } from 'sonner';
import { Play, Square, Clock, LogIn } from 'lucide-react';
import { Button } from '../../components/ui/button';

const API = process.env.REACT_APP_BACKEND_URL;

export default function ClockInOut() {
  const [params] = useSearchParams();
  const token = params.get('token');
  const navigate = useNavigate();
  const [profile, setProfile] = useState(null);
  const [currentClock, setCurrentClock] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  const authHeader = () => {
    const t = localStorage.getItem('token');
    return t ? { Authorization: `Bearer ${t}` } : {};
  };

  const fetchState = useCallback(async () => {
    setLoading(true);
    try {
      const [me, curr] = await Promise.all([
        axios.get(`${API}/api/hr/employees/me`, { headers: authHeader() }).catch(() => ({ data: null })),
        axios.get(`${API}/api/hr/time/current`, { headers: authHeader() }).catch(() => ({ data: null })),
      ]);
      setProfile(me.data);
      setCurrentClock(curr.data);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchState(); }, [fetchState]);

  const doClockIn = async () => {
    setBusy(true);
    try {
      const r = await axios.post(`${API}/api/hr/time/clock-in`, { qr_token: token }, { headers: authHeader() });
      toast.success(`Clocked in at ${new Date(r.data.clock_in_at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}.`);
      await fetchState();
    } catch (e) {
      toast.error(`Clock-in failed: ${e?.response?.data?.detail || e.message}`);
    } finally {
      setBusy(false);
    }
  };

  const doClockOut = async () => {
    setBusy(true);
    try {
      const r = await axios.post(`${API}/api/hr/time/clock-out`, { break_minutes: 0 }, { headers: authHeader() });
      const dur = r.data?.duration_minutes || 0;
      toast.success(`Clocked out. Total: ${Math.floor(dur / 60)}h ${Math.round(dur % 60)}m.`);
      await fetchState();
    } catch (e) {
      toast.error(`Clock-out failed: ${e?.response?.data?.detail || e.message}`);
    } finally {
      setBusy(false);
    }
  };

  if (!token) {
    return (
      <div className="min-h-screen flex items-center justify-center p-6 bg-gradient-to-b from-slate-50 to-slate-100">
        <div className="max-w-sm text-center" data-testid="clock-no-token">
          <h1 className="text-2xl font-bold">Clock in / out</h1>
          <p className="text-sm text-muted-foreground mt-2">
            No QR token found. Scan the door QR code at your showroom.
          </p>
        </div>
      </div>
    );
  }

  if (loading) {
    return <div className="min-h-screen flex items-center justify-center text-muted-foreground">Loading…</div>;
  }

  if (!profile) {
    return (
      <div className="min-h-screen flex items-center justify-center p-6 bg-gradient-to-b from-slate-50 to-slate-100">
        <div className="max-w-sm text-center" data-testid="clock-needs-auth">
          <h1 className="text-2xl font-bold">Sign in to clock</h1>
          <p className="text-sm text-muted-foreground mt-2">
            Log in with your Tile Station account, then re-scan the door QR.
          </p>
          <Button onClick={() => navigate(`/admin/login?next=${encodeURIComponent(`/clock?token=${token}`)}`)} className="mt-4 bg-indigo-600 hover:bg-indigo-700 text-white">
            <LogIn className="w-4 h-4 mr-2" /> Log in
          </Button>
        </div>
      </div>
    );
  }

  const isClockedIn = !!currentClock;

  return (
    <div className="min-h-screen flex items-center justify-center p-6 bg-gradient-to-b from-slate-50 to-slate-100">
      <div className="w-full max-w-sm text-center space-y-6" data-testid="clock-main">
        <header>
          <Clock className="w-12 h-12 mx-auto text-indigo-600" />
          <h1 className="text-2xl font-bold mt-2">
            Hi, {profile.preferred_name || profile.first_name}
          </h1>
          <p className="text-sm text-muted-foreground">
            {isClockedIn ? `Clocked in since ${new Date(currentClock.clock_in_at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}` : 'Ready to start your shift?'}
          </p>
        </header>

        {isClockedIn ? (
          <Button
            onClick={doClockOut}
            disabled={busy}
            className="w-full h-20 text-xl bg-rose-600 hover:bg-rose-700 text-white"
            data-testid="clock-out-big"
          >
            <Square className="w-6 h-6 mr-2" />
            {busy ? 'Clocking out…' : 'Clock OUT'}
          </Button>
        ) : (
          <Button
            onClick={doClockIn}
            disabled={busy}
            className="w-full h-20 text-xl bg-emerald-600 hover:bg-emerald-700 text-white"
            data-testid="clock-in-big"
          >
            <Play className="w-6 h-6 mr-2" />
            {busy ? 'Clocking in…' : 'Clock IN'}
          </Button>
        )}

        <p className="text-[10px] text-muted-foreground">
          QR-verified at showroom door — your manager will see this entry in the timesheet.
        </p>
      </div>
    </div>
  );
}
