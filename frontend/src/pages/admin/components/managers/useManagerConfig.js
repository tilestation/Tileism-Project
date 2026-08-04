/**
 * useManagerConfig — fetches the config for a Manager (built-in or custom).
 * Returns { config, loading, error, refresh, save }.
 *
 * The backend seeds hardcoded defaults for built-in Managers on the first read
 * (?with_defaults=true), so this hook always returns something usable — even
 * for a brand-new install.
 *
 * Every write goes through PATCH /api/manager-definitions/{slug} which is
 * per-slug — so a filter added to Materials does NOT leak into Tiles.
 */

import { useState, useEffect, useCallback } from 'react';
import { toast } from 'sonner';

const API_URL = process.env.REACT_APP_BACKEND_URL;

export const useManagerConfig = (slug) => {
  const [config, setConfig] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const fetchConfig = useCallback(async () => {
    if (!slug) return;
    setLoading(true);
    try {
      const res = await fetch(`${API_URL}/api/manager-definitions/${encodeURIComponent(slug)}?with_defaults=true`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setConfig(data);
      setError(null);
    } catch (err) {
      setError(err.message);
      setConfig(null);
    } finally {
      setLoading(false);
    }
  }, [slug]);

  useEffect(() => { fetchConfig(); }, [fetchConfig]);

  // Save one or more of the 3 arrays. Send only the changed field to keep the
  // PATCH surface small and preserve fields we didn't touch.
  const save = useCallback(async (patch) => {
    if (!slug) return null;
    try {
      const token = localStorage.getItem('token');
      const res = await fetch(`${API_URL}/api/manager-definitions/${encodeURIComponent(slug)}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify(patch),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.detail || `HTTP ${res.status}`);
      }
      const updated = await res.json();
      setConfig(updated);
      return updated;
    } catch (err) {
      toast.error(`Save failed: ${err.message}`);
      throw err;
    }
  }, [slug]);

  return { config, loading, error, refresh: fetchConfig, save };
};
