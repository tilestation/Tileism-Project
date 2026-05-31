import React, { useEffect, useState } from 'react';
import axios from 'axios';
import { Radio, ExternalLink } from 'lucide-react';

const API_URL = process.env.REACT_APP_BACKEND_URL;
const STATUS_URL = `${API_URL}/api/admin/radio-studio/tune-in/status`;
const POLL_MS = 15_000;

/**
 * Compact pill in the admin topbar that polls /tune-in/status and
 * surfaces "🟢 N stores · Now: {track}" or "🔴 OFF AIR".
 *
 * Clicking it opens /radio in a new tab (same destination as the
 * sidebar "Play Store Radio" item).
 *
 * Failure mode: on any network error we silently render nothing —
 * radio is non-critical, the rest of the topbar must keep working.
 */
const RadioStatusPill = () => {
  const [status, setStatus] = useState(null);
  const [hidden, setHidden] = useState(false);

  useEffect(() => {
    let alive = true;
    const fetchStatus = async () => {
      try {
        const token = localStorage.getItem('token');
        const r = await axios.get(STATUS_URL, {
          headers: token ? { Authorization: `Bearer ${token}` } : {},
          timeout: 6000,
        });
        if (alive) setStatus(r.data || null);
      } catch (_e) {
        if (alive) setHidden(true);
      }
    };
    fetchStatus();
    const t = setInterval(fetchStatus, POLL_MS);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  if (hidden || !status) return null;

  const activeCount = status.active_count || 0;
  const isOn = activeCount > 0;
  const nowName = status.now_playing?.name;
  const tooltip = isOn
    ? `${activeCount} ${activeCount === 1 ? 'device' : 'devices'} tuned in${
        nowName ? ` · Now playing: ${nowName}` : ''
      }${
        status.devices && status.devices.length
          ? '\n\n' +
            status.devices
              .map((d) => `• ${d.device_label || d.device_id.slice(0, 8)}`)
              .join('\n')
          : ''
      }`
    : 'No stores currently tuned in. Click to open the radio page.';

  return (
    <a
      href="/radio"
      target="_blank"
      rel="noopener noreferrer"
      data-testid="topbar-radio-pill"
      title={tooltip}
      className={`hidden md:inline-flex items-center gap-2 px-3 py-1.5 mr-3 rounded-full border text-xs font-bold transition-colors ${
        isOn
          ? 'bg-emerald-500/15 border-emerald-500/40 text-emerald-300 hover:bg-emerald-500/25'
          : 'bg-rose-500/10 border-rose-500/30 text-rose-300 hover:bg-rose-500/20'
      }`}
    >
      <span className="relative flex h-2 w-2">
        <span
          className={`absolute inline-flex h-full w-full rounded-full opacity-75 ${
            isOn ? 'bg-emerald-400 animate-ping' : 'bg-rose-500'
          }`}
        />
        <span
          className={`relative inline-flex rounded-full h-2 w-2 ${
            isOn ? 'bg-emerald-400' : 'bg-rose-500'
          }`}
        />
      </span>
      <Radio className="w-3.5 h-3.5" strokeWidth={2} />
      <span data-testid="topbar-radio-pill-text">
        {isOn ? (
          <>
            <span data-testid="topbar-radio-pill-count">{activeCount}</span>
            {' tuned in'}
            {nowName && (
              <>
                {' · '}
                <span className="text-emerald-200/80 font-normal">{nowName}</span>
              </>
            )}
          </>
        ) : (
          'OFF AIR'
        )}
      </span>
      <ExternalLink className="w-3 h-3 opacity-60" strokeWidth={2} />
    </a>
  );
};

export default RadioStatusPill;
