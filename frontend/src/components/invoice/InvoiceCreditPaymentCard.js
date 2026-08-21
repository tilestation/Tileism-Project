import React, { useState, useEffect } from 'react';
import axios from 'axios';
import { Wallet, Sparkles } from 'lucide-react';
import { Input } from '../ui/input';
import { Button } from '../ui/button';

const API_URL = process.env.REACT_APP_BACKEND_URL;

/**
 * "Pay with Credit" payment-method tile for the EPOS Invoice screen.
 * Lives next to the regular Payments Received block so staff has an
 * unmistakable second payment lane for trade customers redeeming their
 * accrued credit back balance.
 *
 * Renders only when a trade account is matched on the customer email/phone
 * AND that account has a positive balance. Fully wired into the same
 * `creditRedeemedAmount` / `creditRedeemedAccount` state the chip writes to.
 */
export const InvoiceCreditPaymentCard = ({
  customerEmail,
  customerPhone,
  applied = 0,
  maxRedeemable = 0,
  onApplyCredit,
}) => {
  const [trade, setTrade] = useState(null);
  const [draft, setDraft] = useState('');

  useEffect(() => {
    let cancelled = false;
    const cleanEmail = (customerEmail || '').trim();
    const cleanPhone = (customerPhone || '').trim();
    const emailReady = cleanEmail.length > 5 && cleanEmail.includes('@');
    const phoneReady = cleanPhone.replace(/\D/g, '').length >= 6;
    if (!emailReady && !phoneReady) {
      setTrade(null);
      return undefined;
    }
    const t = setTimeout(async () => {
      try {
        const token = localStorage.getItem('token') || localStorage.getItem('access_token') || '';
        const params = {};
        if (emailReady) params.email = cleanEmail;
        if (phoneReady && !emailReady) params.phone = cleanPhone;
        const res = await axios.get(`${API_URL}/api/shop/customers/lookup`, {
          params,
          headers: token ? { Authorization: `Bearer ${token}` } : {},
        });
        if (!cancelled) setTrade(res.data?.customer || null);
      } catch {
        if (!cancelled) setTrade(null);
      }
    }, 350);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [customerEmail, customerPhone]);

  if (!trade || !trade.trade_account_number) return null;
  const balance = Number(trade.credit_balance || 0);
  if (balance <= 0) return null;

  const cap = Number(maxRedeemable) || 0;
  const ceiling = Math.min(balance, cap > 0 ? cap : balance);
  const appliedNum = Number(applied) || 0;
  const remaining = Math.max(0, balance - appliedNum);

  const commit = (raw) => {
    const num = parseFloat(raw);
    if (!Number.isFinite(num) || num <= 0) {
      onApplyCredit({ amount: 0, account: trade.trade_account_number, customer: trade });
      setDraft('');
      return;
    }
    const clamped = Math.min(num, ceiling);
    onApplyCredit({
      amount: Math.round(clamped * 100) / 100,
      account: trade.trade_account_number,
      customer: trade,
    });
    setDraft(clamped.toFixed(2));
  };

  const applyMax = () => {
    if (ceiling <= 0) return;
    onApplyCredit({
      amount: Math.round(ceiling * 100) / 100,
      account: trade.trade_account_number,
      customer: trade,
    });
    setDraft(ceiling.toFixed(2));
  };

  const clear = () => {
    onApplyCredit({ amount: 0, account: trade.trade_account_number, customer: trade });
    setDraft('');
  };

  return (
    <div
      className="mb-6 rounded-lg border-2 border-emerald-200 bg-gradient-to-br from-emerald-50 to-teal-50 p-4"
      data-testid="epos-credit-payment-card"
    >
      <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
        <div className="flex items-center gap-2">
          <div className="w-9 h-9 rounded-md bg-emerald-600 text-white flex items-center justify-center shadow-sm">
            <Wallet className="w-4 h-4" />
          </div>
          <div>
            <h3 className="font-semibold text-emerald-900 leading-tight">Pay with Trade Credit</h3>
            <p className="text-[11px] text-emerald-800/80 mt-0.5">
              {trade.business_name || trade.name} · {trade.trade_account_number} · Balance{' '}
              <strong className="tabular-nums">£{balance.toFixed(2)}</strong>
            </p>
          </div>
        </div>
        {/* Always rendered (invisible when unapplied) so applying credit never
            shifts the layout — a blur-commit layout shift was eating the first
            click on the Save button below this card. */}
        <span
          className={`px-3 py-1 rounded-full text-xs font-semibold bg-emerald-600 text-white inline-flex items-center gap-1 ${appliedNum > 0 ? '' : 'invisible'}`}
        >
          <Sparkles className="w-3 h-3" />£{appliedNum.toFixed(2)} applied
        </span>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-12 gap-2 items-end">
        <div className="md:col-span-5">
          <label className="text-xs text-emerald-900/70 font-medium block mb-1">
            Amount to redeem (£)
          </label>
          <Input
            type="number"
            step="0.01"
            min="0"
            max={ceiling}
            value={appliedNum > 0 ? appliedNum.toFixed(2) : draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={(e) => commit(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') commit(e.currentTarget.value); }}
            placeholder={`0.00 (max £${ceiling.toFixed(2)})`}
            className="h-9 bg-white"
            data-testid="epos-credit-amount-input"
          />
        </div>
        <div className="md:col-span-3">
          <Button
            type="button"
            onClick={applyMax}
            variant="outline"
            className="w-full h-9 border-emerald-300 text-emerald-800 hover:bg-emerald-100"
            data-testid="epos-credit-apply-max-btn"
          >
            Apply max (£{ceiling.toFixed(2)})
          </Button>
        </div>
        <div className="md:col-span-2">
          <Button
            type="button"
            onClick={clear}
            variant="outline"
            disabled={appliedNum <= 0}
            className={`w-full h-9 border-rose-200 text-rose-700 hover:bg-rose-50 ${appliedNum > 0 ? '' : 'invisible'}`}
            data-testid="epos-credit-clear-btn"
          >
            Clear
          </Button>
        </div>
        <div className="md:col-span-2 text-right">
          <p className="text-[10px] text-emerald-800/70">After redemption</p>
          <p className="text-sm font-semibold text-emerald-900 tabular-nums">
            £{remaining.toFixed(2)}
          </p>
        </div>
      </div>

      <div className="mt-2 min-h-[26px]">
        <p
          className={`text-[11px] text-emerald-800 bg-white/60 rounded px-2 py-1 inline-block ${appliedNum > 0 ? '' : 'invisible'}`}
          data-testid="epos-credit-deduct-line"
        >
          → Will deduct <strong>£{appliedNum.toFixed(2)}</strong> from{' '}
          {trade.trade_account_number} on save. Remaining balance:{' '}
          <strong>£{remaining.toFixed(2)}</strong>.
        </p>
      </div>
    </div>
  );
};
