/**
 * Trader Credit Statement
 * ────────────────────────
 * Self-service page for trade customers to view their credit balance,
 * recent transactions, and download/email a PDF statement.
 *
 * Endpoints used (all trader-scoped, JWT-auth required):
 *   GET  /api/trader/credit-statement?days=N
 *   GET  /api/trader/credit-statement/pdf?days=N
 *   POST /api/trader/credit-statement/email   { days }
 *
 * Created 21 May 2026 per owner request.
 */
import React, { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import axios from 'axios';
import { toast } from 'sonner';
import {
  Wallet, Download, Mail, TrendingUp, TrendingDown,
  ArrowLeft, Calendar, Receipt,
} from 'lucide-react';
import { Button } from '../../components/ui/button';
import { Card } from '../../components/ui/card';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '../../components/ui/select';
import { ShopHeader, ShopFooter } from './TileStationHome';
import { TileCartProvider } from '../../contexts/TileCartContext';
import { WishlistProvider } from '../../contexts/WishlistContext';
import { SampleCartProvider } from '../../contexts/SampleCartContext';

const API_URL = process.env.REACT_APP_BACKEND_URL;
const RANGE_OPTIONS = [
  { value: 30, label: 'Last 30 days' },
  { value: 90, label: 'Last 90 days' },
  { value: 180, label: 'Last 6 months' },
  { value: 365, label: 'Last 12 months' },
  { value: 3650, label: 'All time' },
];

const formatDate = (iso) => {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleDateString('en-GB', {
      day: '2-digit', month: 'short', year: 'numeric',
    });
  } catch {
    return iso.slice(0, 10);
  }
};

const TraderCreditStatementContent = () => {
  const navigate = useNavigate();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [days, setDays] = useState(90);
  const [downloading, setDownloading] = useState(false);
  const [emailing, setEmailing] = useState(false);

  const authHeader = useCallback(() => {
    const token = localStorage.getItem('shop_token') || localStorage.getItem('token');
    return token ? { Authorization: `Bearer ${token}` } : {};
  }, []);

  const fetchStatement = useCallback(async () => {
    setLoading(true);
    try {
      const res = await axios.get(
        `${API_URL}/api/trader/credit-statement?days=${days}&limit=200`,
        { headers: authHeader() },
      );
      setData(res.data);
    } catch (err) {
      const detail = err?.response?.data?.detail;
      if (err?.response?.status === 401) {
        toast.error('Please sign in to view your credit statement');
        navigate('/shop/trade/login');
      } else if (err?.response?.status === 403) {
        toast.error(detail || 'This account is not a registered trade account');
        navigate('/shop/trade/account');
      } else if (err?.response?.status === 404) {
        toast.error(detail || 'No trade account found for this email');
        navigate('/shop/trade/account');
      } else {
        toast.error('Failed to load credit statement');
      }
    } finally {
      setLoading(false);
    }
  }, [days, authHeader, navigate]);

  useEffect(() => { fetchStatement(); }, [fetchStatement]);

  const handleDownloadPdf = async () => {
    setDownloading(true);
    try {
      const res = await axios.get(
        `${API_URL}/api/trader/credit-statement/pdf?days=${days}`,
        { headers: authHeader(), responseType: 'blob' },
      );
      const blob = new Blob([res.data], { type: 'application/pdf' });
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `trade-credit-statement-${data?.trade_account_number || 'account'}.pdf`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      window.URL.revokeObjectURL(url);
      toast.success('Statement downloaded');
    } catch {
      toast.error('Failed to download PDF');
    } finally {
      setDownloading(false);
    }
  };

  const handleEmailStatement = async () => {
    setEmailing(true);
    try {
      const res = await axios.post(
        `${API_URL}/api/trader/credit-statement/email`,
        { days },
        { headers: authHeader() },
      );
      toast.success(`Statement emailed to ${res.data.email}`);
    } catch (err) {
      toast.error(err?.response?.data?.detail || 'Failed to email statement');
    } finally {
      setEmailing(false);
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <div className="text-gray-500">Loading your credit statement…</div>
      </div>
    );
  }

  if (!data) return null;

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="max-w-5xl mx-auto px-4 py-8" data-testid="trader-credit-statement">
        {/* Back link */}
        <button
          onClick={() => navigate('/shop/trade/account')}
          className="text-sm text-gray-500 hover:text-gray-800 mb-4 inline-flex items-center gap-1"
          data-testid="back-to-trade-account"
        >
          <ArrowLeft className="w-4 h-4" /> Back to my account
        </button>

        {/* Header */}
        <div className="flex flex-wrap items-center justify-between gap-3 mb-6">
          <div>
            <h1 className="text-3xl font-bold text-gray-900">Trade Credit Statement</h1>
            <p className="text-sm text-gray-500 mt-1">
              {data.business_name || data.customer_name} ·
              Trade ref <span className="font-mono font-semibold text-gray-700 ml-1">
                {data.trade_account_number || '—'}
              </span>
            </p>
          </div>
          <Select value={String(days)} onValueChange={(v) => setDays(Number(v))}>
            <SelectTrigger className="w-44" data-testid="range-select">
              <Calendar className="w-4 h-4 mr-2 inline" />
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {RANGE_OPTIONS.map((opt) => (
                <SelectItem key={opt.value} value={String(opt.value)}>
                  {opt.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {/* Balance + summary cards */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-6">
          <Card className="p-5 border-2 border-emerald-500 bg-emerald-50">
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs font-bold uppercase tracking-wider text-emerald-700">
                Current Balance
              </span>
              <Wallet className="w-5 h-5 text-emerald-600" />
            </div>
            <div className="text-3xl font-black text-emerald-700" data-testid="current-balance">
              £{(data.balance || 0).toFixed(2)}
            </div>
            <div className="text-xs text-emerald-600/80 mt-1">
              {(data.credit_rate || 5).toFixed(1)}% credit-back rate · {data.tier || 'Bronze'}
            </div>
          </Card>
          <Card className="p-5">
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs font-bold uppercase tracking-wider text-gray-500">
                Earned (this period)
              </span>
              <TrendingUp className="w-5 h-5 text-gray-400" />
            </div>
            <div className="text-2xl font-bold text-gray-900">
              +£{(data.summary?.earned_in_window || 0).toFixed(2)}
            </div>
          </Card>
          <Card className="p-5">
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs font-bold uppercase tracking-wider text-gray-500">
                Redeemed (this period)
              </span>
              <TrendingDown className="w-5 h-5 text-gray-400" />
            </div>
            <div className="text-2xl font-bold text-gray-900">
              −£{(data.summary?.redeemed_in_window || 0).toFixed(2)}
            </div>
          </Card>
        </div>

        {/* Action buttons */}
        <div className="flex flex-wrap gap-3 mb-6">
          <Button
            onClick={handleDownloadPdf}
            disabled={downloading}
            className="bg-amber-500 hover:bg-amber-600 text-white"
            data-testid="download-pdf-btn"
          >
            <Download className="w-4 h-4 mr-2" />
            {downloading ? 'Preparing…' : 'Download PDF Statement'}
          </Button>
          <Button
            onClick={handleEmailStatement}
            disabled={emailing}
            variant="outline"
            data-testid="email-statement-btn"
          >
            <Mail className="w-4 h-4 mr-2" />
            {emailing ? 'Sending…' : 'Email statement to me'}
          </Button>
        </div>

        {/* Transactions table */}
        <Card className="overflow-hidden" data-testid="transactions-card">
          <div className="px-5 py-4 bg-gray-900 text-white flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Receipt className="w-5 h-5 text-amber-400" />
              <h2 className="font-semibold">
                Transactions
                <span className="text-xs text-gray-400 font-normal ml-2">
                  {data.summary?.transactions_in_window || 0} entries
                </span>
              </h2>
            </div>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 border-b border-gray-200">
                <tr className="text-gray-600 uppercase text-xs">
                  <th className="text-left px-4 py-3 font-semibold">Date</th>
                  <th className="text-left px-4 py-3 font-semibold">Type</th>
                  <th className="text-left px-4 py-3 font-semibold">Ref</th>
                  <th className="text-right px-4 py-3 font-semibold">Amount</th>
                  <th className="text-right px-4 py-3 font-semibold">Balance</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {(data.transactions || []).length === 0 ? (
                  <tr>
                    <td colSpan={5} className="px-4 py-12 text-center text-gray-400 italic">
                      No credit transactions in this period.
                    </td>
                  </tr>
                ) : (
                  data.transactions.map((t) => (
                    <tr key={t.id} className="hover:bg-gray-50" data-testid={`txn-row-${t.id}`}>
                      <td className="px-4 py-3 text-gray-700 whitespace-nowrap">{formatDate(t.date)}</td>
                      <td className="px-4 py-3 text-gray-700">{t.type_label}</td>
                      <td className="px-4 py-3 text-gray-500 font-mono text-xs">
                        {t.invoice_no || t.order_number || '—'}
                      </td>
                      <td className={`px-4 py-3 text-right font-semibold whitespace-nowrap ${
                        t.direction === '+' ? 'text-emerald-600' :
                        t.direction === '−' ? 'text-red-600' : 'text-gray-500'
                      }`}>
                        {t.direction}£{(t.amount || 0).toFixed(2)}
                      </td>
                      <td className="px-4 py-3 text-right text-gray-700 whitespace-nowrap">
                        {t.balance_after !== null && t.balance_after !== undefined
                          ? `£${t.balance_after.toFixed(2)}`
                          : '—'}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </Card>

        <p className="text-xs text-gray-400 mt-6 max-w-3xl">
          Credit is non-transferable, has no cash value, and can be redeemed against
          your next purchase across any Tile Station showroom or our online store.
          For questions about your balance, contact your local showroom.
        </p>
      </div>
    </div>
  );
};

const TraderCreditStatementPage = () => (
  <TileCartProvider>
    <WishlistProvider>
      <SampleCartProvider>
        <ShopHeader />
        <TraderCreditStatementContent />
        <ShopFooter />
      </SampleCartProvider>
    </WishlistProvider>
  </TileCartProvider>
);

export default TraderCreditStatementPage;
