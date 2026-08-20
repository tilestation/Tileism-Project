/**
 * MarginGuardCard — admin-dashboard card surfacing catalog-wide loss-makers
 * (ex-VAT trade price − cost − credit back < 0) before you open a Manager.
 * Group links open the matching Manager with the Margin Guard filter on (?margin=1).
 */
import React, { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { ShieldAlert, ShieldCheck } from 'lucide-react';

const API_URL = process.env.REACT_APP_BACKEND_URL;

const GROUP_ROUTES = {
  tiles: '/admin/tiles',
  materials: '/admin/materials',
  flooring: '/admin/flooring',
  bathroom: '/admin/bathroom',
  underfloor_heating: '/admin/underfloor-heating',
  'underfloor-heating': '/admin/underfloor-heating',
  tools: '/admin/tools',
};

const GROUP_LABELS = {
  tiles: 'Tiles',
  materials: 'Materials',
  flooring: 'Flooring',
  bathroom: 'Bathroom',
  underfloor_heating: 'Underfloor Heat',
  'underfloor-heating': 'Underfloor Heat',
  tools: 'Tools',
};

export const MarginGuardCard = () => {
  const [data, setData] = useState(null);

  useEffect(() => {
    fetch(`${API_URL}/api/supplier-sync/products/margin-guard-summary`)
      .then(res => (res.ok ? res.json() : null))
      .then(setData)
      .catch(() => setData(null));
  }, []);

  if (!data) return null;

  if (data.flagged_count === 0) {
    return (
      <div className="flex items-center gap-2 px-4 py-2.5 rounded-xl bg-emerald-50 border border-emerald-200 text-sm text-emerald-700" data-testid="margin-guard-card">
        <ShieldCheck className="w-4 h-4" />
        Margin Guard: every product sells at a profit at its current trade price.
      </div>
    );
  }

  return (
    <div className="rounded-xl border-2 border-red-300 bg-red-50 p-4" data-testid="margin-guard-card">
      <div className="flex items-start gap-3">
        <ShieldAlert className="w-5 h-5 text-red-600 flex-shrink-0 mt-0.5" />
        <div className="flex-1 min-w-0">
          <p className="font-semibold text-red-800 text-sm" data-testid="margin-guard-card-summary">
            Margin Guard: {data.flagged_count} product{data.flagged_count !== 1 ? 's' : ''} sell{data.flagged_count === 1 ? 's' : ''} at a loss — combined £{Number(data.total_loss).toFixed(2)}/unit
          </p>
          <p className="text-xs text-red-600 mt-0.5">
            Ex-VAT trade price − cost − credit back is negative. Open a Manager to review and fix pricing.
          </p>
          <div className="flex flex-wrap gap-2 mt-2">
            {Object.entries(data.groups || {}).map(([grp, count]) => (
              <Link
                key={grp}
                to={`${GROUP_ROUTES[grp] || '/admin/tiles'}?margin=1`}
                className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full bg-white border border-red-300 text-red-700 hover:bg-red-100 text-xs font-medium transition-colors"
                data-testid={`margin-guard-card-link-${grp}`}
              >
                {GROUP_LABELS[grp] || grp}: {count}
              </Link>
            ))}
          </div>
          {(data.worst || []).length > 0 && (
            <div className="mt-2 text-[11px] text-red-700/80">
              Worst: {data.worst.slice(0, 3).map(w => `${w.name || w.sku} (−£${Number(w.loss).toFixed(2)})`).join(' · ')}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default MarginGuardCard;
