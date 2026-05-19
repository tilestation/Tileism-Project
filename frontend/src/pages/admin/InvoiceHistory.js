import React, { useEffect, useState } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { api } from '../../lib/api';
import { toast } from 'sonner';
import { 
  FileText, Search, Eye, Edit2, Trash2, Calendar, User, 
  PoundSterling, Filter, X, ChevronDown, ChevronUp, Download, Mail, Share2, MessageCircle,
  ArrowRightLeft, CheckSquare, Square, Building2, RotateCcw, Copy, FileOutput, MessageSquare, AlertTriangle, TrendingUp
} from 'lucide-react';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { Card } from '../../components/ui/card';
import { Textarea } from '../../components/ui/textarea';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../../components/ui/dialog';
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip as RechartsTooltip,
  Legend, ResponsiveContainer, ReferenceLine
} from 'recharts';

// Small trend indicator pill used under revenue cards.
// Renders "▲ £420 (+8.7%) vs yesterday", "▼ £60 (-3%)", "— new (no prior)", etc.
const TrendPill = ({ current, prior, label, testId }) => {
  const c = Number(current) || 0;
  const p = Number(prior) || 0;
  const delta = c - p;
  const direction = Math.abs(delta) < 0.005 ? 'flat' : (delta > 0 ? 'up' : 'down');
  const pctText = p > 0
    ? `${((delta / p) * 100).toFixed(1)}%`
    : (c > 0 ? 'new' : '0%');
  const arrow = direction === 'up' ? '▲' : direction === 'down' ? '▼' : '•';
  const cls = direction === 'up'
    ? 'bg-green-100 text-green-800 border-green-200'
    : direction === 'down'
      ? 'bg-red-100 text-red-800 border-red-200'
      : 'bg-gray-100 text-gray-600 border-gray-200';
  const fmtDelta = `£${Math.abs(delta).toFixed(2)}`;
  const pctSign = p > 0 ? (delta >= 0 ? '+' : '-') : '';
  const pctLabel = p > 0 ? ` (${pctSign}${pctText.replace('-', '')})` : (c > 0 ? ' (new)' : '');
  return (
    <div className="mt-2" data-testid={testId}>
      <span
        className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full border text-xs font-medium ${cls}`}
        title={`Current: £${c.toFixed(2)} · Prior: £${p.toFixed(2)}`}
      >
        <span className="leading-none">{arrow}</span>
        <span>{fmtDelta}{pctLabel}</span>
      </span>
      <span className="ml-2 text-xs text-gray-500">{label}</span>
    </div>
  );
};

export const InvoiceHistory = () => {
  const navigate = useNavigate();
  const location = useLocation();
  const [invoices, setInvoices] = useState([]);
  const [staffList, setStaffList] = useState([]);
  const [showrooms, setStores] = useState([]);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState('');
  const [staffFilter, setStaffFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [showroomFilter, setStoreFilter] = useState('');
  const [showFilters, setShowFilters] = useState(false);
  const [selectedInvoice, setSelectedInvoice] = useState(null);
  const [showViewDialog, setShowViewDialog] = useState(false);
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const [showShareDialog, setShowShareDialog] = useState(false);
  const [showBreakdownDialog, setShowBreakdownDialog] = useState(false);
  const [showCompareDialog, setShowCompareDialog] = useState(false);
  // Weekly Compare dialog state (week identifiers are the Sunday date in YYYY-MM-DD)
  const [showWeekCompareDialog, setShowWeekCompareDialog] = useState(false);
  const [compareCurWeek, setCompareCurWeek] = useState(null);
  const [comparePriorWeek, setComparePriorWeek] = useState(null);
  // Compare dialog month pickers (YYYY-MM format). Null = use defaults (current month / prior month).
  const [compareCurMonth, setCompareCurMonth] = useState(null);
  const [comparePriorMonth, setComparePriorMonth] = useState(null);
  const [showTransferDialog, setShowTransferDialog] = useState(false);
  const [showRefundDialog, setShowRefundDialog] = useState(false);
  const [showRefundDetailsDialog, setShowRefundDetailsDialog] = useState(false);
  const [selectedDateRefunds, setSelectedDateRefunds] = useState([]);
  const [selectedRefundDate, setSelectedRefundDate] = useState('');
  const [breakdownType, setBreakdownType] = useState(null); // 'weekly' or 'monthly'
  const [deleting, setDeleting] = useState(false);
  const [sending, setSending] = useState(false);
  const [transferring, setTransferring] = useState(false);
  const [refunding, setRefunding] = useState(false);
  const [shareEmail, setShareEmail] = useState('');

  // Helper to clean None patterns from product names
  const cleanNonePatterns = (str) => {
    if (!str) return '';
    return str
      .replace(/\s*NonexNone\s*/gi, ' ')
      .replace(/\s*NoneXNone\s*/gi, ' ')
      .replace(/\s*None\s*x\s*None\s*/gi, ' ')
      .replace(/\s*xNone\s*/gi, ' ')
      .replace(/\s*Nonex\s*/gi, ' ')
      .replace(/\s*\(None\)\s*/gi, ' ')
      .replace(/\s*\(None\d*[Kk]?g?\)\s*/gi, ' ')
      .replace(/\s*None\s*[Kk]g\s*/gi, ' ')
      .replace(/\s+None\s*$/gi, '')
      .replace(/\s+/g, ' ')
      .trim();
  };
  
  // SMS notification state
  const [showSmsDialog, setShowSmsDialog] = useState(false);
  const [smsInvoice, setSmsInvoice] = useState(null);
  const [smsMessage, setSmsMessage] = useState('');
  const [sendingSms, setSendingSms] = useState(false);
  const [smsAvailable, setSmsAvailable] = useState(false);
  const [shareMessage, setShareMessage] = useState('');
  const [expandedRow, setExpandedRow] = useState(null);
  
  // Refund state
  const [refundItems, setRefundItems] = useState([]);
  const [refundReason, setRefundReason] = useState('');
  const [refundMethod, setRefundMethod] = useState('original_payment');
  
  // Invoice search state
  const [invoiceSearchTerm, setInvoiceSearchTerm] = useState('');
  const [showInvoiceSearch, setShowInvoiceSearch] = useState(false);
  
  // Bulk selection state
  const [selectedInvoices, setSelectedInvoices] = useState([]);
  const [targetStore, setTargetStore] = useState('');
  
  // Get current user role from localStorage
  const [currentUser, setCurrentUser] = useState(null);
  
  // Date filter - default to today
  const today = new Date().toISOString().split('T')[0];
  const [dateFilter, setDateFilter] = useState(today);
  const [allInvoices, setAllInvoices] = useState([]); // Store all invoices for revenue calculations
  const [allRefunds, setAllRefunds] = useState([]); // Store all refunds for revenue calculations
  const [dataVersion, setDataVersion] = useState(0); // Used to force re-renders when data changes

  // Deposit-date audit: invoices whose payment date differs from invoice date by > 1 day
  const [depositAudit, setDepositAudit] = useState({ count: 0, invoices: [] });
  const [showDepositAuditList, setShowDepositAuditList] = useState(false);
  const [syncingDeposit, setSyncingDeposit] = useState(false);

  const fetchDepositAudit = async () => {
    try {
      const response = await api.getMisDatedDepositInvoices();
      setDepositAudit(response.data || { count: 0, invoices: [] });
    } catch (error) {
      console.warn('[InvoiceHistory] Deposit audit unavailable:', error?.message);
    }
  };

  const handleSyncDepositDates = async (invoiceIds = null) => {
    // 24 Feb 2026 — confirmation dialog added after a near-miss where
    // "Sync Now" was about to re-attribute a legitimate part-payment
    // back to the invoice date. The button is destructive — moves
    // revenue from the payment date to the invoice date — so we now
    // make absolutely sure the user knows what they're doing.
    const targetCount = invoiceIds ? invoiceIds.length : depositAudit.count;
    if (targetCount === 0) {
      toast.info('No invoices to sync');
      return;
    }
    const confirmed = window.confirm(
      `Sync ${targetCount} invoice${targetCount === 1 ? '' : 's'}?\n\n` +
      `This will set EVERY deposit date on the selected invoice${targetCount === 1 ? '' : 's'} ` +
      `to match the invoice date — moving that revenue from the payment ` +
      `date back to the invoice date on Sales reports.\n\n` +
      `Only use this if you originally took the payment on the invoice ` +
      `date but the form accidentally defaulted to today.\n\n` +
      `DO NOT use this for legitimate part-payments taken on a later date — ` +
      `it will re-attribute their revenue to the wrong day.`
    );
    if (!confirmed) return;
    try {
      setSyncingDeposit(true);
      const res = await api.syncDepositDates(invoiceIds);
      const { updated_invoices = 0, updated_deposits = 0 } = res.data || {};
      if (updated_invoices === 0) {
        toast.info('No deposit dates needed syncing');
      } else {
        toast.success(`Synced ${updated_deposits} deposit${updated_deposits === 1 ? '' : 's'} across ${updated_invoices} invoice${updated_invoices === 1 ? '' : 's'}`);
      }
      await Promise.all([fetchData(), fetchDepositAudit()]);
    } catch (error) {
      const msg = error.response?.data?.detail || 'Failed to sync deposit dates';
      toast.error(msg);
    } finally {
      setSyncingDeposit(false);
    }
  };

  // Check SMS availability on mount
  useEffect(() => {
    const checkSmsStatus = async () => {
      try {
        const response = await api.getSmsStatus();
        setSmsAvailable(response.data.available);
      } catch (error) {
        setSmsAvailable(false);
      }
    };
    checkSmsStatus();
  }, []);

  // Refetch data whenever user navigates to this page (same-tab navigation)
  useEffect(() => {
    fetchData();
    fetchDepositAudit();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.pathname, location.key]); // Added location.key to detect same-path navigations

  useEffect(() => {
    // Refetch data when window regains focus (user switches back to this tab/page)
    const handleFocus = () => {
      fetchData();
      fetchDepositAudit();
    };
    
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        fetchData();
      }
    };
    
    // Listen for cross-page data sync events (localStorage - works across tabs)
    const handleStorageChange = (e) => {
      if (e.key === 'dataSync') {
        fetchData();
      }
    };
    
    // Listen for custom dataSync event (for same-tab sync)
    const handleDataSync = async () => {
      console.log('[InvoiceHistory] Data sync event received');
      await fetchData();
    };
    
    window.addEventListener('focus', handleFocus);
    document.addEventListener('visibilitychange', handleVisibilityChange);
    window.addEventListener('storage', handleStorageChange);
    window.addEventListener('dataSync', handleDataSync);
    window.addEventListener('data-sync-event', handleDataSync);
    
    // Get current user from localStorage
    const token = localStorage.getItem('token');
    if (token) {
      try {
        const payload = JSON.parse(atob(token.split('.')[1]));
        setCurrentUser({ email: payload.sub, role: payload.role });
      } catch (e) {
        console.error('Error parsing token', e);
      }
    }
    
    return () => {
      window.removeEventListener('focus', handleFocus);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      window.removeEventListener('storage', handleStorageChange);
      window.removeEventListener('dataSync', handleDataSync);
      window.removeEventListener('data-sync-event', handleDataSync);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  
  const isSuperAdmin = currentUser?.role === 'super_admin';

  // Helper to parse DD/MM/YYYY date format to Date object
  const parseInvoiceDate = (dateStr) => {
    if (!dateStr) return null;
    const parts = dateStr.split('/');
    if (parts.length === 3) {
      // DD/MM/YYYY format
      return new Date(parts[2], parts[1] - 1, parts[0]);
    }
    return new Date(dateStr);
  };

  // Helper to format date as DD/MM/YYYY
  const formatDateDDMMYYYY = (date) => {
    const d = new Date(date);
    const day = String(d.getDate()).padStart(2, '0');
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const year = d.getFullYear();
    return `${day}/${month}/${year}`;
  };

  // Anchor week/month boundaries to the selected dateFilter (not today) so the
  // Weekly / Monthly revenue cards reflect the week/month OF the filter date.
  // End is capped at the filter date itself — future days within the same week/month
  // are NOT included, so numbers are always "week/month-to-date" for the chosen date.
  const getAnchorDate = () => {
    if (dateFilter) {
      const d = new Date(dateFilter + 'T00:00:00');
      if (!isNaN(d.getTime())) return d;
    }
    return new Date();
  };

  // Get week boundaries (Sunday to Saturday), end-capped at the anchor date
  const getWeekBoundaries = () => {
    const anchor = getAnchorDate();
    const dayOfWeek = anchor.getDay(); // 0 = Sunday
    const sunday = new Date(anchor);
    sunday.setDate(anchor.getDate() - dayOfWeek);
    sunday.setHours(0, 0, 0, 0);
    
    const saturday = new Date(sunday);
    saturday.setDate(sunday.getDate() + 6);
    saturday.setHours(23, 59, 59, 999);
    
    // Cap end at anchor (filter date) — don't include future days
    const anchorEnd = new Date(anchor);
    anchorEnd.setHours(23, 59, 59, 999);
    const end = anchorEnd < saturday ? anchorEnd : saturday;
    
    return { start: sunday, end, fullEnd: saturday };
  };

  // Get month boundaries (1st to last day), end-capped at the anchor date
  const getMonthBoundaries = () => {
    const anchor = getAnchorDate();
    const firstDay = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
    firstDay.setHours(0, 0, 0, 0);
    
    const lastDay = new Date(anchor.getFullYear(), anchor.getMonth() + 1, 0);
    lastDay.setHours(23, 59, 59, 999);
    
    // Cap end at anchor (filter date) — don't include future days
    const anchorEnd = new Date(anchor);
    anchorEnd.setHours(23, 59, 59, 999);
    const end = anchorEnd < lastDay ? anchorEnd : lastDay;
    
    return { start: firstDay, end, fullEnd: lastDay };
  };

  // NOTE: calculateRevenue function was removed as it was unused and had a bug
  // (used grossTotal instead of actual paid for non-deposit invoices)
  // All revenue calculations now use getDepositAmount() which correctly calculates
  // gross_total - amount_outstanding

  // Get invoices filtered by showroom (for calculations)
  const getShowroomFilteredInvoices = () => {
    console.log('[getShowroomFilteredInvoices] showroomFilter:', showroomFilter, 'allInvoices.length:', allInvoices.length);
    if (showroomFilter) {
      const filtered = allInvoices.filter(inv => inv.showroom_id === showroomFilter);
      console.log('[getShowroomFilteredInvoices] Filtered by showroom:', filtered.length);
      return filtered;
    }
    return allInvoices;
  };

  // Helper function to calculate actual deposit amount (money actually received)
  // Uses amount_outstanding for accuracy - this is the source of truth
  const getDepositAmount = (invoice) => {
    const grossTotal = invoice.gross_total || 0;
    const outstanding = invoice.amount_outstanding || 0;
    // Deposit = Total - Outstanding (what's been paid)
    return Math.round((grossTotal - outstanding) * 100) / 100;
  };

  // Helper to get the payment amount for a specific date
  // Returns the sum of deposits made on the given date (DD/MM/YYYY format)
  const getPaymentForDate = (invoice, dateStr) => {
    const deposits = invoice.deposits || [];
    if (deposits.length === 0) {
      // No deposits - if invoice date matches, return full paid amount
      if (invoice.date === dateStr) {
        return getDepositAmount(invoice);
      }
      return 0;
    }
    // Sum all deposits that match the date
    return deposits
      .filter(dep => dep.date === dateStr)
      .reduce((sum, dep) => sum + (parseFloat(dep.amount) || 0), 0);
  };

  // Check if an invoice has any payment on a specific date
  const hasPaymentOnDate = (invoice, dateStr) => {
    // Check if invoice was created on this date
    if (invoice.date === dateStr) return true;
    // Check if any deposit was made on this date
    const deposits = invoice.deposits || [];
    return deposits.some(dep => dep.date === dateStr && parseFloat(dep.amount) > 0);
  };

  // Calculate revenue directly during render (no state dependency)
  // Revenue = actual deposits taken on this specific date, NOT invoice totals
  // IMPORTANT: Deposits are attributed to their payment date, not the invoice date
  const getDailyRevenue = () => {
    const invoicesToUse = getShowroomFilteredInvoices();
    const filterDate = formatDateDDMMYYYY(dateFilter);
    
    let total = 0;
    
    // Process all invoices, attributing deposits to their payment dates
    invoicesToUse.forEach(inv => {
      const deposits = inv.deposits || [];
      const grossTotal = inv.gross_total || 0;
      
      if (deposits.length > 0) {
        // For invoices with deposits, count each deposit on its payment date
        deposits.forEach(dep => {
          const depDate = dep.date;
          const depAmount = parseFloat(dep.amount) || 0;
          
          if (depAmount > 0 && depDate === filterDate) {
            total += depAmount;
          }
        });
      } else {
        // No deposits - count full amount on invoice date if it matches
        if (inv.date === filterDate) {
          total += getDepositAmount(inv);
        }
      }
    });
    
    // Subtract refunds for this date
    const dayRefunds = allRefunds.filter(refund => refund.date === filterDate);
    const refundTotal = dayRefunds.reduce((sum, refund) => sum + (refund.net_refund || refund.gross_total || 0), 0);
    
    const netTotal = total - refundTotal;
    console.log('[getDailyRevenue] dataVersion:', dataVersion, 'Date:', filterDate, 'Deposits:', total.toFixed(2), 'Refunds:', refundTotal.toFixed(2), 'Net:', netTotal.toFixed(2));
    return netTotal;
  };

  const getWeeklyRevenue = () => {
    const invoicesToUse = getShowroomFilteredInvoices();
    // Use the same anchor-and-cap logic as getWeekBoundaries so the revenue matches
    // the label shown on the card (week-to-filter-date, not full calendar week).
    const { start: weekStart, end: weekEnd } = getWeekBoundaries();
    
    let total = 0;
    
    // Process all invoices, attributing deposits to their payment dates
    invoicesToUse.forEach(inv => {
      const deposits = inv.deposits || [];
      
      if (deposits.length > 0) {
        // For invoices with deposits, count each deposit on its payment date
        deposits.forEach(dep => {
          const depDate = parseInvoiceDate(dep.date);
          const depAmount = parseFloat(dep.amount) || 0;
          
          if (depAmount > 0 && depDate && depDate >= weekStart && depDate <= weekEnd) {
            total += depAmount;
          }
        });
      } else {
        // No deposits - count full amount if invoice date is in range
        const invDate = parseInvoiceDate(inv.date);
        if (invDate && invDate >= weekStart && invDate <= weekEnd) {
          total += getDepositAmount(inv);
        }
      }
    });
    
    // Subtract refunds for this week
    const weekRefunds = allRefunds.filter(refund => {
      const refundDate = parseInvoiceDate(refund.date);
      return refundDate && refundDate >= weekStart && refundDate <= weekEnd;
    });
    const refundTotal = weekRefunds.reduce((sum, refund) => sum + (refund.net_refund || refund.gross_total || 0), 0);
    
    const netTotal = total - refundTotal;
    console.log('[getWeeklyRevenue] Week:', formatDateDDMMYYYY(weekStart), '-', formatDateDDMMYYYY(weekEnd), 'Deposits:', total.toFixed(2), 'Refunds:', refundTotal.toFixed(2), 'Net:', netTotal.toFixed(2));
    return netTotal;
  };

  const getMonthlyRevenue = () => {
    const invoicesToUse = getShowroomFilteredInvoices();
    // Use the same anchor-and-cap logic as getMonthBoundaries so revenue matches
    // the label shown on the card (month-to-filter-date, not full calendar month).
    const { start: monthStart, end: monthEnd } = getMonthBoundaries();
    
    let total = 0;
    
    // Process all invoices, attributing deposits to their payment dates
    invoicesToUse.forEach(inv => {
      const deposits = inv.deposits || [];
      
      if (deposits.length > 0) {
        // For invoices with deposits, count each deposit on its payment date
        deposits.forEach(dep => {
          const depDate = parseInvoiceDate(dep.date);
          const depAmount = parseFloat(dep.amount) || 0;
          
          if (depAmount > 0 && depDate && depDate >= monthStart && depDate <= monthEnd) {
            total += depAmount;
          }
        });
      } else {
        // No deposits - count full amount if invoice date is in range
        const invDate = parseInvoiceDate(inv.date);
        if (invDate && invDate >= monthStart && invDate <= monthEnd) {
          total += getDepositAmount(inv);
        }
      }
    });
    
    // Subtract refunds for this month
    const monthRefunds = allRefunds.filter(refund => {
      const refundDate = parseInvoiceDate(refund.date);
      return refundDate && refundDate >= monthStart && refundDate <= monthEnd;
    });
    const refundTotal = monthRefunds.reduce((sum, refund) => sum + (refund.net_refund || refund.gross_total || 0), 0);
    
    const netTotal = total - refundTotal;
    console.log('[getMonthlyRevenue] Month:', formatDateDDMMYYYY(monthStart), '-', formatDateDDMMYYYY(monthEnd), 'Deposits:', total.toFixed(2), 'Refunds:', refundTotal.toFixed(2), 'Net:', netTotal.toFixed(2));
    return netTotal;
  };

  // Sum net revenue (deposits received − refunds issued) in an inclusive date window.
  // Used by the prior-period trend pills so comparisons are apples-to-apples with
  // how getDailyRevenue / getWeeklyRevenue / getMonthlyRevenue are calculated.
  const sumRevenueInWindow = (start, end) => {
    if (!start || !end) return 0;
    const invoicesToUse = getShowroomFilteredInvoices();
    let total = 0;
    invoicesToUse.forEach(inv => {
      const deposits = inv.deposits || [];
      if (deposits.length > 0) {
        deposits.forEach(dep => {
          const depDate = parseInvoiceDate(dep.date);
          const depAmount = parseFloat(dep.amount) || 0;
          if (depAmount > 0 && depDate && depDate >= start && depDate <= end) {
            total += depAmount;
          }
        });
      } else {
        const invDate = parseInvoiceDate(inv.date);
        if (invDate && invDate >= start && invDate <= end) {
          total += getDepositAmount(inv);
        }
      }
    });
    const refundTotal = (allRefunds || []).reduce((sum, refund) => {
      const refundDate = parseInvoiceDate(refund.date);
      if (refundDate && refundDate >= start && refundDate <= end) {
        return sum + (refund.net_refund || refund.gross_total || 0);
      }
      return sum;
    }, 0);
    return total - refundTotal;
  };

  // Prior-period revenues (for trend comparison pills)
  const getPriorDailyRevenue = () => {
    const anchor = getAnchorDate();
    const prior = new Date(anchor);
    prior.setDate(anchor.getDate() - 1);
    const start = new Date(prior); start.setHours(0, 0, 0, 0);
    const end = new Date(prior); end.setHours(23, 59, 59, 999);
    return sumRevenueInWindow(start, end);
  };

  const getPriorWeeklyRevenue = () => {
    // Shift the current week window back by 7 days, keeping the same # of days-to-date
    const { start, end } = getWeekBoundaries();
    const priorStart = new Date(start); priorStart.setDate(start.getDate() - 7);
    const priorEnd = new Date(end); priorEnd.setDate(end.getDate() - 7);
    return sumRevenueInWindow(priorStart, priorEnd);
  };

  const getPriorMonthlyRevenue = () => {
    // Same day-of-month cap in the previous month
    const anchor = getAnchorDate();
    const priorMonthStart = new Date(anchor.getFullYear(), anchor.getMonth() - 1, 1);
    priorMonthStart.setHours(0, 0, 0, 0);
    const priorMonthLast = new Date(anchor.getFullYear(), anchor.getMonth(), 0).getDate();
    const cappedDay = Math.min(anchor.getDate(), priorMonthLast);
    const priorMonthEnd = new Date(priorMonthStart.getFullYear(), priorMonthStart.getMonth(), cappedDay);
    priorMonthEnd.setHours(23, 59, 59, 999);
    return sumRevenueInWindow(priorMonthStart, priorMonthEnd);
  };

  // Same month, previous year — up to the same day-of-month as the anchor.
  // Used by the YoY mini-pill on the Monthly Revenue card.
  const getYoYMonthlyRevenue = () => {
    const anchor = getAnchorDate();
    const yoyStart = new Date(anchor.getFullYear() - 1, anchor.getMonth(), 1);
    yoyStart.setHours(0, 0, 0, 0);
    const yoyLastDay = new Date(anchor.getFullYear() - 1, anchor.getMonth() + 1, 0).getDate();
    const cappedDay = Math.min(anchor.getDate(), yoyLastDay);
    const yoyEnd = new Date(yoyStart.getFullYear(), yoyStart.getMonth(), cappedDay);
    yoyEnd.setHours(23, 59, 59, 999);
    return sumRevenueInWindow(yoyStart, yoyEnd);
  };

  // Build daily + cumulative series for an arbitrary month vs an arbitrary prior month.
  // Default: use the current filter anchor's month as current, and the preceding month as prior.
  // Pass explicit `{year, month}` (0-indexed) objects to compare any two months.
  // If `currentSpec` is the SAME calendar month as the filter anchor, results are truncated
  // at the anchor day so you see "month-to-date vs prior". Otherwise, full months are shown.
  const buildMonthlyCompareSeries = (currentSpec = null, priorSpec = null) => {
    const anchor = getAnchorDate();
    const defaultCurrent = { year: anchor.getFullYear(), month: anchor.getMonth() };
    const defaultPrior = { year: anchor.getFullYear(), month: anchor.getMonth() - 1 };
    const cur = currentSpec || defaultCurrent;
    const pri = priorSpec || defaultPrior;

    // Build full-month start/end for each spec (normalises prior-year rollover)
    const curStart = new Date(cur.year, cur.month, 1); curStart.setHours(0, 0, 0, 0);
    const curLastDay = new Date(cur.year, cur.month + 1, 0).getDate();
    const curFullEnd = new Date(cur.year, cur.month, curLastDay); curFullEnd.setHours(23, 59, 59, 999);

    const priStart = new Date(pri.year, pri.month, 1); priStart.setHours(0, 0, 0, 0);
    const priLastDay = new Date(pri.year, pri.month + 1, 0).getDate();
    const priEnd = new Date(pri.year, pri.month, priLastDay); priEnd.setHours(23, 59, 59, 999);

    // Truncate current at anchor day ONLY when current = filter anchor's calendar month.
    const sameAsAnchor = cur.year === anchor.getFullYear() && cur.month === anchor.getMonth();
    const anchorDay = sameAsAnchor ? anchor.getDate() : curLastDay;
    const curEnd = new Date(cur.year, cur.month, anchorDay); curEnd.setHours(23, 59, 59, 999);

    const maxDays = Math.max(curLastDay, priLastDay);

    // Helper: day-by-day net revenue for a given month range
    const dailyForMonth = (start, end) => {
      const map = {};
      const iter = new Date(start);
      while (iter <= end) {
        const dayStart = new Date(iter); dayStart.setHours(0, 0, 0, 0);
        const dayEnd = new Date(iter); dayEnd.setHours(23, 59, 59, 999);
        map[iter.getDate()] = sumRevenueInWindow(dayStart, dayEnd);
        iter.setDate(iter.getDate() + 1);
      }
      return map;
    };
    const curDaily = dailyForMonth(curStart, curEnd);
    const priorDaily = dailyForMonth(priStart, priEnd);

    const series = [];
    let curCum = 0, priorCum = 0;
    for (let d = 1; d <= maxDays; d++) {
      // Current: fill up to anchorDay (== last day of month when not current-month mode)
      const curVal = d <= anchorDay && curDaily[d] !== undefined ? curDaily[d] : null;
      if (curVal !== null) curCum += curVal;
      const priorVal = priorDaily[d] !== undefined ? priorDaily[d] : null;
      if (priorVal !== null) priorCum += priorVal;
      series.push({
        day: d,
        current: curVal !== null ? Math.round(curVal * 100) / 100 : null,
        currentCum: curVal !== null ? Math.round(curCum * 100) / 100 : null,
        prior: priorVal !== null ? Math.round(priorVal * 100) / 100 : null,
        priorCum: priorVal !== null ? Math.round(priorCum * 100) / 100 : null,
      });
    }
    return {
      series,
      currentMonthLabel: curStart.toLocaleString('default', { month: 'long', year: 'numeric' }),
      priorMonthLabel: priStart.toLocaleString('default', { month: 'long', year: 'numeric' }),
      anchorDay,
      isLiveCurrentMonth: sameAsAnchor,
      currentTotalToDate: Math.round(curCum * 100) / 100,
      priorTotalSameDay: (() => {
        let c = 0;
        for (let d = 1; d <= Math.min(anchorDay, priLastDay); d++) {
          c += priorDaily[d] || 0;
        }
        return Math.round(c * 100) / 100;
      })(),
      priorTotalFullMonth: Math.round(priorCum * 100) / 100,
    };
  };

  // ---------- Weekly Compare ----------
  // Weeks run Sunday → Saturday. A week is identified by its Sunday-start YYYY-MM-DD.

  const getSundayOf = (date) => {
    const d = new Date(date);
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() - d.getDay()); // Sunday = 0
    return d;
  };

  const fmtWeekLabel = (sunday) => {
    const sat = new Date(sunday); sat.setDate(sunday.getDate() + 6);
    const opts = { day: 'numeric', month: 'short', year: 'numeric' };
    return `${sunday.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })} – ${sat.toLocaleDateString('en-GB', opts)}`;
  };

  const toYMD = (d) => {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  };

  const parseYMD = (s) => {
    if (!s) return null;
    const [y, m, d] = s.split('-').map(n => parseInt(n, 10));
    if (!y || !m || !d) return null;
    const dt = new Date(y, m - 1, d);
    dt.setHours(0, 0, 0, 0);
    return dt;
  };

  // Build Sun-Sat cumulative series for current week vs prior week.
  // Both weeks mapped to dayIndex 0..6 so they overlay on the same x-axis.
  const buildWeeklyCompareSeries = (curSundayStr = null, priSundayStr = null) => {
    const anchor = getAnchorDate();
    const anchorSunday = getSundayOf(anchor);
    const defaultPrior = new Date(anchorSunday); defaultPrior.setDate(anchorSunday.getDate() - 7);

    const curSunday = parseYMD(curSundayStr) || anchorSunday;
    const priSunday = parseYMD(priSundayStr) || defaultPrior;

    // "Live" mode = current week contains the filter anchor; truncate at anchor day index
    const sameAsAnchor = curSunday.getTime() === anchorSunday.getTime();
    const anchorDayIdx = sameAsAnchor ? anchor.getDay() : 6; // 0..6 inclusive

    const dayRevenue = (start, dayIdx) => {
      const s = new Date(start); s.setDate(start.getDate() + dayIdx); s.setHours(0, 0, 0, 0);
      const e = new Date(s); e.setHours(23, 59, 59, 999);
      return sumRevenueInWindow(s, e);
    };

    const series = [];
    const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    let curCum = 0, priCum = 0;
    for (let i = 0; i < 7; i++) {
      const curVal = i <= anchorDayIdx ? dayRevenue(curSunday, i) : null;
      if (curVal !== null) curCum += curVal;
      const priVal = dayRevenue(priSunday, i); // always full week for prior
      priCum += priVal;
      series.push({
        day: dayNames[i],
        dayIdx: i,
        current: curVal !== null ? Math.round(curVal * 100) / 100 : null,
        currentCum: curVal !== null ? Math.round(curCum * 100) / 100 : null,
        prior: Math.round(priVal * 100) / 100,
        priorCum: Math.round(priCum * 100) / 100,
      });
    }

    // Prior's cumulative at the same day index (for pace delta card)
    let priorTotalSameDay = 0;
    for (let i = 0; i <= anchorDayIdx; i++) {
      priorTotalSameDay += dayRevenue(priSunday, i);
    }

    return {
      series,
      currentWeekLabel: fmtWeekLabel(curSunday),
      priorWeekLabel: fmtWeekLabel(priSunday),
      anchorDayIdx,
      anchorDayName: dayNames[anchorDayIdx],
      isLiveCurrentWeek: sameAsAnchor,
      currentTotalToDate: Math.round(curCum * 100) / 100,
      priorTotalSameDay: Math.round(priorTotalSameDay * 100) / 100,
      priorTotalFullWeek: Math.round(priCum * 100) / 100,
    };
  };







  // Get daily breakdown for a date range - counts deposits by their payment date
  const getDailyBreakdown = (type) => {
    const { start, end } = type === 'weekly' ? getWeekBoundaries() : getMonthBoundaries();
    const breakdown = {};
    const invoicesToUse = getShowroomFilteredInvoices();
    
    // Initialize all days in the range
    const currentDate = new Date(start);
    while (currentDate <= end) {
      const dateKey = formatDateDDMMYYYY(currentDate);
      breakdown[dateKey] = { 
        revenue: 0, 
        invoiceCount: 0, 
        vat: 0,
        paymentMethods: {}, // Track by payment method
        refundCount: 0,
        refundTotal: 0,
        refundMethod: null
      };
      currentDate.setDate(currentDate.getDate() + 1);
    }
    
    // Process each invoice
    invoicesToUse.forEach(inv => {
      const deposits = inv.deposits || [];
      const paymentMethodsArray = inv.payment_methods || [];
      const grossTotal = inv.gross_total || 0;
      const vat = inv.vat || 0;
      
      // Helper to get method name for a deposit
      const getMethodName = (deposit, idx) => {
        // Only use deposit.method field - do not use note as fallback
        if (deposit.method && deposit.method.trim()) return deposit.method;
        // Fallback to payment_methods array if available
        if (paymentMethodsArray[idx]?.method) return paymentMethodsArray[idx].method;
        // Try to match by amount
        const matchByAmount = paymentMethodsArray.find(pm => 
          Math.abs(parseFloat(pm.amount) - parseFloat(deposit.amount)) < 0.01
        );
        if (matchByAmount?.method) return matchByAmount.method;
        // Only use note as fallback if it looks like a valid payment method name (not a number)
        if (deposit.note && isNaN(parseFloat(deposit.note)) && deposit.note.trim()) {
          return deposit.note;
        }
        return inv.payment_method && inv.payment_method.trim() 
          ? inv.payment_method 
          : (inv.payment_methods?.[0]?.method || 'Not Specified');
      };
      
      if (deposits.length > 0) {
        // For invoices with deposits, count each deposit on its payment date
        deposits.forEach((dep, idx) => {
          const depDate = dep.date;
          const depAmount = parseFloat(dep.amount) || 0;
          const depMethod = getMethodName(dep, idx);
          
          if (depAmount > 0 && breakdown[depDate]) {
            breakdown[depDate].revenue += depAmount;
            // Prorate VAT based on deposit amount relative to gross total
            if (grossTotal > 0) {
              breakdown[depDate].vat += (depAmount / grossTotal) * vat;
            }
            
            // Track payment method for this deposit
            if (!breakdown[depDate].paymentMethods[depMethod]) {
              breakdown[depDate].paymentMethods[depMethod] = { count: 0, total: 0 };
            }
            breakdown[depDate].paymentMethods[depMethod].total += depAmount;
          }
        });
        
        // Count invoice on its original date for invoice count
        const invDate = inv.date;
        if (breakdown[invDate]) {
          breakdown[invDate].invoiceCount += 1;
          const method = getMethodName(deposits[0], 0);
          if (!breakdown[invDate].paymentMethods[method]) {
            breakdown[invDate].paymentMethods[method] = { count: 0, total: 0 };
          }
          breakdown[invDate].paymentMethods[method].count += 1;
        }
      } else {
        // No deposits - use actual paid amount (gross_total - amount_outstanding)
        const invDate = parseInvoiceDate(inv.date);
        if (invDate && invDate >= start && invDate <= end) {
          const dateKey = inv.date;
          if (breakdown[dateKey]) {
            const actualPaid = getDepositAmount(inv); // Use actual paid, not grossTotal
            breakdown[dateKey].revenue += actualPaid;
            breakdown[dateKey].invoiceCount += 1;
            // Prorate VAT based on actual paid
            if (grossTotal > 0) {
              breakdown[dateKey].vat += (actualPaid / grossTotal) * vat;
            }
            
            // Track payment method
            const method = inv.payment_method && inv.payment_method.trim() 
              ? inv.payment_method 
              : (inv.payment_methods?.[0]?.method || 'Not Specified');
            if (!breakdown[dateKey].paymentMethods[method]) {
              breakdown[dateKey].paymentMethods[method] = { count: 0, total: 0 };
            }
            breakdown[dateKey].paymentMethods[method].count += 1;
            breakdown[dateKey].paymentMethods[method].total += actualPaid;
          }
        }
      }
    });
    
    // Add refund data
    allRefunds.forEach(refund => {
      const refundDate = parseInvoiceDate(refund.date);
      if (refundDate && refundDate >= start && refundDate <= end) {
        const dateKey = refund.date;
        if (breakdown[dateKey]) {
          breakdown[dateKey].refundCount += 1;
          breakdown[dateKey].refundTotal += refund.net_refund || refund.gross_total || 0;
          // Track refund payment method
          if (refund.refund_method) {
            breakdown[dateKey].refundMethod = refund.refund_method;
          }
        }
      }
    });
    
    // Convert to array and sort by date
    return Object.entries(breakdown)
      .map(([date, data]) => ({ date, ...data }))
      .sort((a, b) => {
        const dateA = parseInvoiceDate(a.date);
        const dateB = parseInvoiceDate(b.date);
        return dateA - dateB;
      });
  };

  // Get refunds for a specific date
  const getRefundsForDate = (dateStr) => {
    return allRefunds.filter(refund => refund.date === dateStr);
  };

  // Handle clicking on refunds in breakdown to show details
  const handleBreakdownRefundClick = (dateStr) => {
    const refundsForDate = getRefundsForDate(dateStr);
    if (refundsForDate.length > 0) {
      setSelectedDateRefunds(refundsForDate);
      setSelectedRefundDate(dateStr);
      setShowRefundDetailsDialog(true);
    }
  };

  // Get payment method totals for a period (using actual paid amounts)
  const getPaymentMethodTotals = (type) => {
    const { start, end } = type === 'daily' 
      ? { start: parseInvoiceDate(formatDateDDMMYYYY(dateFilter || today)), end: parseInvoiceDate(formatDateDDMMYYYY(dateFilter || today)) }
      : type === 'weekly' 
        ? getWeekBoundaries() 
        : getMonthBoundaries();
    
    if (type === 'daily' && start) {
      start.setHours(0, 0, 0, 0);
      end.setHours(23, 59, 59, 999);
    }
    
    const methods = {};
    const invoicesToUse = getShowroomFilteredInvoices();
    const filterDateStr = type === 'daily' ? formatDateDDMMYYYY(dateFilter || today) : null;
    
    invoicesToUse.forEach(inv => {
      const invDate = parseInvoiceDate(inv.date);
      const deposits = inv.deposits || [];
      const validDeposits = deposits.filter(d => d.amount && parseFloat(d.amount) > 0);
      const paymentMethodsArray = inv.payment_methods || [];
      
      // Helper to get method name for a deposit
      const getMethodName = (deposit, idx) => {
        // Only use deposit.method field - do not use note as fallback
        if (deposit.method && deposit.method.trim()) return deposit.method;
        // Fallback to payment_methods array if available
        if (paymentMethodsArray[idx]?.method) return paymentMethodsArray[idx].method;
        // Try to match by amount
        const matchByAmount = paymentMethodsArray.find(pm => 
          Math.abs(parseFloat(pm.amount) - parseFloat(deposit.amount)) < 0.01
        );
        if (matchByAmount?.method) return matchByAmount.method;
        // Only use note as fallback if it looks like a valid payment method name (not a number)
        if (deposit.note && isNaN(parseFloat(deposit.note)) && deposit.note.trim()) {
          return deposit.note;
        }
        return inv.payment_method && inv.payment_method.trim() 
          ? inv.payment_method 
          : (inv.payment_methods?.[0]?.method || 'Not Specified');
      };
      
      if (validDeposits.length > 0) {
        // Process each deposit - check deposit date, not invoice date
        // This is critical for balance payments made on different days
        let invoiceCounted = false;
        
        validDeposits.forEach((deposit, idx) => {
          const depDate = parseInvoiceDate(deposit.date);
          const depositInRange = depDate && depDate >= start && depDate <= end;
          
          // For daily view, also match by exact date string for accuracy
          const depositMatchesDate = type === 'daily' 
            ? deposit.date === filterDateStr
            : depositInRange;
          
          if (depositMatchesDate) {
            const method = getMethodName(deposit, idx);
            const amount = parseFloat(deposit.amount) || 0;
            if (!methods[method]) {
              methods[method] = { count: 0, total: 0 };
            }
            methods[method].total += amount;
            
            // Count invoice once under the first method that matches the date
            if (!invoiceCounted) {
              methods[method].count += 1;
              invoiceCounted = true;
            }
          }
        });
      } else {
        // Fallback to payment_method for invoices without deposits
        // Only count if invoice date is in range
        if (invDate && invDate >= start && invDate <= end) {
          const method = inv.payment_method || 'Unknown';
          const paidAmount = getActualPaidAmount(inv);
          if (!methods[method]) {
            methods[method] = { count: 0, total: 0 };
          }
          methods[method].count += 1;
          methods[method].total += paidAmount;
        }
      }
    });
    
    return methods;
  };

  // Handle clicking on revenue cards
  const handleRevenueCardClick = (type) => {
    setBreakdownType(type);
    setShowBreakdownDialog(true);
  };

  // Sort invoices by date and time (newest first)
  const sortInvoicesByDateTime = (invoiceList) => {
    return [...invoiceList].sort((a, b) => {
      // First compare by date
      const dateA = parseInvoiceDate(a.date);
      const dateB = parseInvoiceDate(b.date);
      
      if (dateA && dateB) {
        const dateDiff = dateB.getTime() - dateA.getTime();
        if (dateDiff !== 0) return dateDiff;
      }
      
      // If same date, compare by time (format: HH:MM)
      const timeA = a.time || '00:00';
      const timeB = b.time || '00:00';
      
      // Parse time strings to compare
      const [hoursA, minsA] = timeA.split(':').map(Number);
      const [hoursB, minsB] = timeB.split(':').map(Number);
      
      const totalMinsA = (hoursA * 60) + minsA;
      const totalMinsB = (hoursB * 60) + minsB;
      
      return totalMinsB - totalMinsA; // Newest time first
    });
  };

  const fetchData = async () => {
    console.log('[InvoiceHistory] fetchData called, current dateFilter:', dateFilter);
    try {
      const [invoicesRes, staffRes, showroomsRes, refundsRes] = await Promise.all([
        api.getInvoices(),
        api.getStaffPins().catch(() => ({ data: [] })),
        api.getStores().catch(() => ({ data: [] })),
        api.getRefunds().catch(() => ({ data: [] }))
      ]);
      // Sort all invoices by date/time
      const sortedInvoices = sortInvoicesByDateTime(invoicesRes.data);
      console.log('[InvoiceHistory] Fetched', sortedInvoices.length, 'invoices');
      
      // Update all invoices state
      setAllInvoices(sortedInvoices);
      setAllRefunds(refundsRes.data || []);
      
      // Filter to show invoices for the CURRENT dateFilter, not today
      // Include invoices that were CREATED on this date OR have PAYMENTS on this date
      const filterDate = dateFilter ? formatDateDDMMYYYY(dateFilter) : formatDateDDMMYYYY(today);
      const filtered = sortedInvoices.filter(inv => hasPaymentOnDate(inv, filterDate));
      console.log('[InvoiceHistory] Filtered to', filtered.length, 'invoices for date:', filterDate, '(includes invoices with deposits on this date)');
      setInvoices(filtered);
      setStaffList(staffRes.data || []);
      setStores(showroomsRes.data || []);
      
      // Increment data version to force re-render of revenue calculations
      setDataVersion(prev => prev + 1);
    } catch (error) {
      toast.error('Failed to load invoices');
      console.error('[InvoiceHistory] fetchData error:', error);
    } finally {
      setLoading(false);
    }
  };

  // Filter invoices by selected date
  // Include invoices that were CREATED on this date OR have PAYMENTS on this date
  useEffect(() => {
    if (allInvoices.length > 0 && dateFilter) {
      const filterDate = formatDateDDMMYYYY(dateFilter);
      const filtered = allInvoices.filter(inv => hasPaymentOnDate(inv, filterDate));
      setInvoices(filtered);
    }
  }, [dateFilter, allInvoices]);

  const handleSearch = async () => {
    setLoading(true);
    try {
      const params = {};
      if (searchTerm) params.search = searchTerm;
      if (staffFilter) params.staff_id = staffFilter;
      
      const res = await api.getInvoices(params);
      const sortedResults = sortInvoicesByDateTime(res.data);
      setAllInvoices(sortedResults);
      
      // When searching, show all results (ignore date filter)
      // Only apply date filter if no search term
      if (searchTerm || staffFilter) {
        setInvoices(sortedResults);
        // Clear date filter when searching to show user all results are displayed
        setDateFilter('');
      } else if (dateFilter) {
        const filterDate = formatDateDDMMYYYY(dateFilter);
        const filtered = sortedResults.filter(inv => inv.date === filterDate);
        setInvoices(filtered);
      } else {
        setInvoices(sortedResults);
      }
    } catch (error) {
      toast.error('Search failed');
    } finally {
      setLoading(false);
    }
  };

  const handleClearFilters = () => {
    setSearchTerm('');
    setStaffFilter('');
    setStatusFilter('');
    setStoreFilter('');
    setDateFilter(today);
    fetchData();
  };

  const handleShowAllDates = () => {
    setDateFilter('');
    setInvoices(allInvoices);
  };

  const handleView = (invoice) => {
    setSelectedInvoice(invoice);
    setShowViewDialog(true);
  };

  const handleEdit = (invoice) => {
    // Navigate to invoice page with the invoice data
    navigate('/admin/invoice', { state: { editInvoice: invoice } });
  };

  const handleDeleteConfirm = (invoice) => {
    setSelectedInvoice(invoice);
    setShowDeleteDialog(true);
  };

  const handleDelete = async () => {
    if (!selectedInvoice) return;
    
    const deletedInvoiceId = selectedInvoice.id;
    const deletedAmount = selectedInvoice.gross_total || 0;
    console.log('[InvoiceHistory] Deleting invoice:', deletedInvoiceId, 'Amount:', deletedAmount);
    
    setDeleting(true);
    try {
      const resp = await api.deleteInvoice(deletedInvoiceId);
      console.log('[InvoiceHistory] Delete API call successful');
      const reversed = resp?.data?.credits_reversed;
      let msg = 'Invoice deleted and stock restored';
      if (reversed && (reversed.earned_reversed > 0 || reversed.redeemed_reversed > 0)) {
        const parts = [];
        if (reversed.earned_reversed > 0) parts.push(`-£${Number(reversed.earned_reversed).toFixed(2)} earned`);
        if (reversed.redeemed_reversed > 0) parts.push(`+£${Number(reversed.redeemed_reversed).toFixed(2)} redeemed refunded`);
        msg += ` · Trade credit: ${parts.join(', ')}`;
      }
      toast.success(msg, { duration: 6000 });
      setShowDeleteDialog(false);
      setSelectedInvoice(null);
      
      // Trigger data sync events for other components
      window.dispatchEvent(new CustomEvent('data-sync-event'));
      window.dispatchEvent(new CustomEvent('dataSync'));
      localStorage.setItem('dataSync', Date.now().toString());
      
      // IMPORTANT: Immediately remove the deleted invoice from local state
      // This ensures the UI updates BEFORE the API call completes
      setAllInvoices(prev => {
        const updated = prev.filter(inv => inv.id !== deletedInvoiceId);
        console.log('[InvoiceHistory] Local state updated: removed invoice, now have', updated.length, 'invoices');
        return updated;
      });
      
      setInvoices(prev => {
        const updated = prev.filter(inv => inv.id !== deletedInvoiceId);
        console.log('[InvoiceHistory] Filtered invoices updated: now have', updated.length, 'invoices');
        return updated;
      });
      
      // Force a re-render by updating the data version
      setDataVersion(prev => prev + 1);
      
      // Also refetch to ensure consistency with backend
      // Use setTimeout to allow state update to process first
      setTimeout(async () => {
        console.log('[InvoiceHistory] Refetching data from server...');
        await fetchData();
        console.log('[InvoiceHistory] Refetch complete');
      }, 100);
      
    } catch (error) {
      console.error('[InvoiceHistory] Delete error:', error);
      toast.error(error.response?.data?.detail || 'Failed to delete invoice');
    } finally {
      setDeleting(false);
    }
  };

  // Refund handlers
  const handleRefundClick = (invoice) => {
    setSelectedInvoice(invoice);
    // Pre-populate refund items with all invoice line items (unchecked)
    const items = (invoice.line_items || []).map(item => ({
      ...item,
      selected: false,
      refund_quantity: item.quantity || 1
    }));
    setRefundItems(items);
    setRefundReason('');
    setRefundMethod('original_payment');
    setShowRefundDialog(true);
  };

  // Convert Invoice to Quotation
  const handleConvertToQuotation = (invoice, type = 'quotation') => {
    // Prepare quotation data from invoice
    const quotationData = {
      customerName: invoice.customer_name || '',
      customerPhone: invoice.customer_phone || '',
      customerEmail: invoice.customer_email || '',
      customerAddress: invoice.customer_address || '',
      notes: invoice.notes || '',
      lineItems: (invoice.line_items || []).map(item => ({
        productId: item.product_id || '',
        product: item.product_name || '',
        sku: item.sku || '',
        qty: item.quantity?.toString() || '1',
        m2: item.m2?.toString() || '0',
        price: item.price?.toString() || '0',
        duePrice: (item.due_price !== undefined && item.due_price !== null 
          ? item.due_price 
          : item.price * (1 - (item.discount || 0) / 100)).toString(),
        discount: item.discount?.toString() || (item.price > 0 && item.due_price !== undefined && item.due_price !== item.price 
          ? ((item.price - item.due_price) / item.price * 100).toString() 
          : '0')
      })),
      showroom_id: invoice.showroom_id,
      showroom_name: invoice.showroom_name,
      fromInvoice: invoice.invoice_no
    };

    // Navigate to appropriate quotation page
    if (type === 'cash') {
      navigate('/admin/cash-quotation', { state: { convertFromInvoice: quotationData } });
      toast.success(`Converting Invoice ${invoice.invoice_no} to Cash Quotation`);
    } else {
      navigate('/admin/quotation', { state: { convertFromInvoice: quotationData } });
      toast.success(`Converting Invoice ${invoice.invoice_no} to Quotation`);
    }
  };

  const toggleRefundItem = (index) => {
    const updated = [...refundItems];
    updated[index].selected = !updated[index].selected;
    setRefundItems(updated);
  };

  const updateRefundQuantity = (index, quantity) => {
    const updated = [...refundItems];
    const maxQty = updated[index].quantity || 1;
    updated[index].refund_quantity = Math.min(Math.max(1, parseInt(quantity) || 1), maxQty);
    setRefundItems(updated);
  };

  const calculateRefundTotal = () => {
    return refundItems
      .filter(item => item.selected)
      .reduce((sum, item) => {
        const price = item.unit_price || item.price || 0;
        return sum + (price * item.refund_quantity);
      }, 0);
  };

  const handleCreateRefund = async () => {
    const selectedItems = refundItems.filter(item => item.selected);
    if (selectedItems.length === 0) {
      toast.error('Please select at least one item to refund');
      return;
    }

    setRefunding(true);
    try {
      const subtotal = calculateRefundTotal();
      const vatAmount = subtotal * 0.2; // 20% VAT
      const grossTotal = subtotal + vatAmount;

      // Generate refund number
      const now = new Date();
      const dateStr = now.toISOString().slice(0, 10).replace(/-/g, '');
      const timeStr = now.toTimeString().slice(0, 5);
      const refundNo = `RF-${dateStr}-${now.getTime().toString().slice(-4)}`;

      const refundData = {
        refund_no: refundNo,
        date: now.toLocaleDateString('en-GB'),
        time: timeStr,
        original_invoice_id: selectedInvoice.id,
        original_invoice_no: selectedInvoice.invoice_no,
        customer_name: selectedInvoice.customer_name || '',
        customer_email: selectedInvoice.customer_email || '',
        customer_phone: selectedInvoice.customer_phone || '',
        customer_address: selectedInvoice.customer_address || '',
        line_items: selectedItems.map(item => {
          const unitPrice = item.unit_price || item.price || 0;
          return {
            product_id: item.product_id || null,
            product_name: item.product_name || item.name || 'Unknown Product',
            sku: item.sku || '',
            quantity: item.refund_quantity || 1,
            original_price: unitPrice,
            refund_price: unitPrice,
            total: unitPrice * (item.refund_quantity || 1),
            reason: refundReason || ''
          };
        }),
        subtotal: subtotal,
        vat: vatAmount,
        gross_total: grossTotal,
        notes: refundReason || '',
        refund_method: refundMethod || 'Cash',
        refund_type: 'Partial Refund',
        showroom_id: selectedInvoice.showroom_id || null,
        showroom_name: selectedInvoice.showroom_name || '',
        restocking_fee: 0
      };

      console.log('Submitting refund:', refundData);
      const response = await api.createRefund(refundData);
      console.log('Refund response:', response.data);
      const reversed = response?.data?.credits_reversed;
      let msg = 'Refund created successfully';
      if (reversed && (reversed.earned_reversed > 0 || reversed.redeemed_reversed > 0)) {
        const parts = [];
        if (reversed.earned_reversed > 0) parts.push(`-£${Number(reversed.earned_reversed).toFixed(2)} earned`);
        if (reversed.redeemed_reversed > 0) parts.push(`+£${Number(reversed.redeemed_reversed).toFixed(2)} redeemed refunded`);
        msg += ` · Trade credit: ${parts.join(', ')}`;
      }
      toast.success(msg, { duration: 6000 });
      setShowRefundDialog(false);
      setSelectedInvoice(null);
      fetchData(); // Refresh the list
      // Trigger cross-page data sync
      localStorage.setItem('dataSync', Date.now().toString());
      window.dispatchEvent(new CustomEvent('dataSync'));
    } catch (error) {
      console.error('Refund error:', error);
      console.error('Error response:', error.response?.data);
      toast.error(error.response?.data?.detail || error.message || 'Failed to create refund');
    } finally {
      setRefunding(false);
    }
  };

  // Invoice search by number
  const handleInvoiceSearch = () => {
    if (!invoiceSearchTerm.trim()) {
      toast.error('Please enter an invoice number');
      return;
    }
    setSearchTerm(invoiceSearchTerm.trim());
    setDateFilter(''); // Clear date filter to search all dates
    setShowInvoiceSearch(false);
  };

  const handleDownloadPdf = async (invoice) => {
    try {
      toast.loading('Generating PDF...');
      const response = await api.downloadInvoicePdf(invoice.id);
      
      // Create blob and download
      const blob = new Blob([response.data], { type: 'application/pdf' });
      const url = window.URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `Invoice_${invoice.invoice_no}.pdf`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      window.URL.revokeObjectURL(url);
      
      toast.dismiss();
      toast.success('PDF downloaded successfully');
    } catch (error) {
      toast.dismiss();
      toast.error(error.response?.data?.detail || 'Failed to generate PDF');
    }
  };

  const handleShareClick = (invoice) => {
    setSelectedInvoice(invoice);
    setShareEmail(invoice.customer_email || '');
    setShareMessage('');
    setShowShareDialog(true);
  };

  const handleSendEmail = async () => {
    if (!shareEmail) {
      toast.error('Please enter an email address');
      return;
    }
    
    setSending(true);
    try {
      await api.emailInvoicePdf(selectedInvoice.id, shareEmail, shareMessage);
      toast.success(`Invoice sent to ${shareEmail}`);
      setShowShareDialog(false);
      setShareEmail('');
      setShareMessage('');
    } catch (error) {
      toast.error(error.response?.data?.detail || 'Failed to send email');
    } finally {
      setSending(false);
    }
  };

  const handleShareWhatsApp = async (invoice) => {
    const invToUse = invoice || selectedInvoice;
    if (!invToUse) return;
    
    const customerPhone = invToUse.customer_phone || '';
    const invoiceNo = invToUse.invoice_no;
    const grossTotal = invToUse.gross_total || 0;
    
    // Calculate outstanding
    const deposits = invToUse.deposits || [];
    const totalDeposits = deposits.reduce((sum, d) => sum + (parseFloat(d.amount) || 0), 0);
    const outstanding = grossTotal - totalDeposits;
    
    const message = encodeURIComponent(
      `Hi${invToUse.customer_name ? ' ' + invToUse.customer_name : ''},\n\n` +
      `Your invoice #${invoiceNo} from Tile Station:\n` +
      `• Total: £${grossTotal.toFixed(2)}\n` +
      `• Paid: £${totalDeposits.toFixed(2)}\n` +
      `• Outstanding: £${outstanding.toFixed(2)}\n\n` +
      `Thank you for your business!\n` +
      `Tile Station\n` +
      `Tel: 01474 878 989`
    );
    
    // Clean phone number for WhatsApp
    let phoneForWA = customerPhone.replace(/\D/g, '');
    if (phoneForWA.startsWith('0')) {
      phoneForWA = '44' + phoneForWA.substring(1); // UK format
    }
    
    const whatsappUrl = phoneForWA 
      ? `https://wa.me/${phoneForWA}?text=${message}`
      : `https://wa.me/?text=${message}`;
    
    window.open(whatsappUrl, '_blank');
  };

  // SMS notification - Open dialog with pre-filled message
  const handleSmsClick = (invoice) => {
    const invToUse = invoice || selectedInvoice;
    if (!invToUse) return;
    
    if (!invToUse.customer_phone) {
      toast.error('No phone number available for this customer');
      return;
    }
    
    // Find showroom name
    const showroom = showrooms.find(s => s.id === invToUse.showroom_id);
    const showroomName = showroom?.name || invToUse.showroom_name || 'our store';
    
    // Pre-fill message template
    const defaultMessage = `Hi ${invToUse.customer_name || 'Customer'}, your order ${invToUse.invoice_no} is ready for collection at ${showroomName}. Please bring your ID and order confirmation. Thank you! - Tile Station`;
    
    setSmsInvoice(invToUse);
    setSmsMessage(defaultMessage);
    setShowSmsDialog(true);
  };

  // Send SMS notification
  const handleSendSms = async () => {
    if (!smsInvoice || !smsMessage.trim()) {
      toast.error('Please enter a message');
      return;
    }
    
    if (!smsInvoice.customer_phone) {
      toast.error('No phone number available');
      return;
    }
    
    setSendingSms(true);
    try {
      await api.sendSms({
        phone_number: smsInvoice.customer_phone,
        message: smsMessage,
        invoice_id: smsInvoice.id,
        invoice_no: smsInvoice.invoice_no,
        customer_name: smsInvoice.customer_name
      });
      
      toast.success('SMS sent successfully');
      setShowSmsDialog(false);
      setSmsMessage('');
      setSmsInvoice(null);
    } catch (error) {
      const errorMsg = error.response?.data?.detail || 'Failed to send SMS';
      toast.error(errorMsg);
    } finally {
      setSendingSms(false);
    }
  };

  // Bulk selection functions
  const toggleInvoiceSelection = (invoiceId) => {
    setSelectedInvoices(prev => 
      prev.includes(invoiceId) 
        ? prev.filter(id => id !== invoiceId)
        : [...prev, invoiceId]
    );
  };

  const toggleSelectAll = () => {
    if (selectedInvoices.length === filteredInvoices.length) {
      setSelectedInvoices([]);
    } else {
      setSelectedInvoices(filteredInvoices.map(inv => inv.id));
    }
  };

  const clearSelection = () => {
    setSelectedInvoices([]);
  };

  const openTransferDialog = () => {
    if (selectedInvoices.length === 0) {
      toast.error('Please select at least one invoice to transfer');
      return;
    }
    setTargetStore('');
    setShowTransferDialog(true);
  };

  const handleBulkTransfer = async () => {
    if (!targetStore) {
      toast.error('Please select a target showroom');
      return;
    }
    
    const showroom = showrooms.find(s => s.id === targetStore);
    if (!showroom) {
      toast.error('Invalid showroom selected');
      return;
    }
    
    setTransferring(true);
    try {
      const response = await api.bulkTransferInvoices({
        invoice_ids: selectedInvoices,
        target_showroom_id: targetStore,
        target_showroom_name: showroom.name
      });
      
      toast.success(
        `Transferred ${response.data.transferred_count} invoice(s) to ${showroom.name}. ` +
        `Revenue: £${response.data.total_revenue_transferred.toFixed(2)}`
      );
      
      setShowTransferDialog(false);
      setSelectedInvoices([]);
      setTargetStore('');
      fetchData();
    } catch (error) {
      if (error.response?.status === 403) {
        toast.error('Super Admin access required for bulk transfers');
      } else {
        toast.error(error.response?.data?.detail || 'Failed to transfer invoices');
      }
    } finally {
      setTransferring(false);
    }
  };

  // Get selected invoices details for transfer dialog
  const getSelectedInvoicesDetails = () => {
    return filteredInvoices.filter(inv => selectedInvoices.includes(inv.id));
  };

  const toggleRowExpand = (invoiceId) => {
    setExpandedRow(expandedRow === invoiceId ? null : invoiceId);
  };

  const formatCurrency = (amount) => {
    return `£${(amount || 0).toFixed(2)}`;
  };

  // Capitalize first letter of every word (Title Case)
  const toTitleCase = (str) => {
    if (!str) return '';
    return str.replace(/\b\w/g, char => char.toUpperCase());
  };

  // Copy all line items to clipboard for spreadsheet pasting
  const copyLineItemsToClipboard = (invoice) => {
    if (!invoice.line_items || invoice.line_items.length === 0) {
      toast.error('No line items to copy');
      return;
    }

    // Create tab-separated data for spreadsheet compatibility
    const headers = ['SKU', 'Product', 'Qty', 'Price', 'Due Price', 'Discount %', 'Total'];
    const rows = invoice.line_items.map(item => {
      const originalPrice = item.price || 0;
      // Use stored due_price if available, otherwise calculate from discount
      const duePrice = item.due_price !== undefined && item.due_price !== null 
        ? item.due_price 
        : originalPrice * (1 - (item.discount || 0) / 100);
      // Calculate discount percentage from price difference if not stored
      const discount = item.discount || (originalPrice > 0 && duePrice !== originalPrice 
        ? ((originalPrice - duePrice) / originalPrice * 100) 
        : 0);
      const total = item.total || (item.quantity * duePrice);
      return [
        item.sku || '-',
        toTitleCase(item.product_name),
        item.quantity,
        originalPrice.toFixed(2),
        duePrice.toFixed(2),
        `${discount.toFixed(0)}%`,
        total.toFixed(2)
      ].join('\t');
    });

    // Add totals row
    const totalsRow = ['', '', '', '', 'Subtotal:', (invoice.subtotal || 0).toFixed(2)];
    const vatRow = ['', '', '', '', 'VAT (20%):', (invoice.vat || 0).toFixed(2)];
    const grandTotalRow = ['', '', '', '', 'Total:', (invoice.gross_total || 0).toFixed(2)];

    const clipboardText = [
      headers.join('\t'),
      ...rows,
      '',
      totalsRow.join('\t'),
      vatRow.join('\t'),
      grandTotalRow.join('\t')
    ].join('\n');

    navigator.clipboard.writeText(clipboardText).then(() => {
      toast.success('Line items copied to clipboard!');
    }).catch(() => {
      toast.error('Failed to copy to clipboard');
    });
  };

  // Helper to calculate deposit totals and outstanding balance
  const getDepositInfo = (invoice) => {
    const deposits = invoice.deposits || [];
    const totalDeposits = deposits.reduce((sum, d) => sum + (parseFloat(d.amount) || 0), 0);
    const grossTotal = invoice.gross_total || 0;
    // Use amount_outstanding if available (more reliable), otherwise calculate from deposits
    const outstanding = invoice.amount_outstanding !== undefined 
      ? Math.round((invoice.amount_outstanding || 0) * 100) / 100
      : Math.round(Math.max(0, grossTotal - totalDeposits) * 100) / 100;
    // Half-penny tolerance — legacy rows may store amount_outstanding as 0.01 from
    // rounding drift; treat anything under a penny as fully paid.
    const safeOutstanding = Math.abs(outstanding) < 0.005 ? 0 : outstanding;
    // It's a deposit order only if there ARE deposits AND there's still money outstanding
    const isDepositOrder = totalDeposits > 0 && safeOutstanding > 0;
    const isFullyPaid = grossTotal > 0 && safeOutstanding === 0;
    // Actual paid amount = gross_total - outstanding
    const paidAmount = Math.round((grossTotal - safeOutstanding) * 100) / 100;
    return { totalDeposits, outstanding: safeOutstanding, isDepositOrder, isFullyPaid, grossTotal, paidAmount };
  };

  // Calculate actual paid revenue for an invoice (exclude outstanding amounts)
  const getActualPaidAmount = (invoice) => {
    const depositInfo = getDepositInfo(invoice);
    return depositInfo.paidAmount;
  };

  // Get invoice status with proper display - ALWAYS recalculate based on actual outstanding
  const getInvoiceStatus = (invoice) => {
    const depositInfo = getDepositInfo(invoice);
    
    // If fully paid (had deposits but now outstanding is 0), mark as completed
    if (depositInfo.isFullyPaid) {
      return 'completed';
    }
    
    // If still has outstanding balance with deposits, it's a deposit order
    if (depositInfo.isDepositOrder) {
      return 'deposit_order';
    }
    
    // If has explicit status and not a deposit situation, use it
    if (invoice.status && invoice.status !== 'deposit_order') {
      return invoice.status;
    }
    
    // Default to open order
    return 'open_order';
  };

  // Status badge styling
  const getStatusBadge = (status) => {
    const styles = {
      open_order: 'bg-blue-100 text-blue-800',
      deposit_order: 'bg-amber-100 text-amber-800',
      processing: 'bg-purple-100 text-purple-800',
      completed: 'bg-green-100 text-green-800'
    };
    const labels = {
      open_order: 'Open Order',
      deposit_order: 'Deposit Order',
      processing: 'Processing',
      completed: 'Completed'
    };
    return {
      className: styles[status] || 'bg-gray-100 text-gray-800',
      label: labels[status] || status
    };
  };

  // Update invoice status
  const handleStatusChange = async (invoiceId, newStatus) => {
    try {
      await api.updateInvoiceStatus(invoiceId, newStatus);
      toast.success(`Invoice status updated to ${getStatusBadge(newStatus).label}`);
      fetchData();
    } catch (error) {
      toast.error('Failed to update status');
      console.error(error);
    }
  };

  const handleStoreChange = async (invoiceId, showroomId) => {
    // Only Super Admin can transfer invoices
    if (!isSuperAdmin) {
      toast.error('Super Admin access required for showroom transfers');
      return;
    }
    try {
      const showroom = showrooms.find(s => s.id === showroomId);
      await api.updateInvoiceStore(invoiceId, {
        showroom_id: showroomId || null,
        showroom_name: showroom?.name || null
      });
      toast.success(showroomId ? `Invoice assigned to ${showroom?.name}` : 'Invoice unassigned from showroom');
      fetchData();
    } catch (error) {
      toast.error('Failed to update showroom');
      console.error(error);
    }
  };

  // Filter invoices by status and showroom
  let filteredInvoices = invoices;
  
  // Filter by showroom
  if (showroomFilter) {
    filteredInvoices = filteredInvoices.filter(invoice => invoice.showroom_id === showroomFilter);
  }
  
  // Filter by status
  if (statusFilter) {
    filteredInvoices = filteredInvoices.filter(invoice => {
      const status = getInvoiceStatus(invoice);
      if (statusFilter === 'deposit') {
        return status === 'deposit_order';
      } else if (statusFilter === 'open') {
        return status === 'open_order';
      } else if (statusFilter === 'processing') {
        return status === 'processing';
      } else if (statusFilter === 'completed') {
        return status === 'completed';
      }
      return true;
    });
  }

  if (loading) {
    return <div className="flex items-center justify-center h-64">Loading invoices...</div>;
  }

  return (
    <div className="space-y-6" data-testid="invoice-history-page">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-4xl font-heading font-bold tracking-tightest mb-2">Invoice History</h1>
          <p className="text-muted-foreground">Search, view and edit saved invoices</p>
        </div>
        <Button onClick={() => navigate('/admin/invoice')} data-testid="create-invoice-btn">
          <FileText className="h-4 w-4 mr-2" />
          Create New Invoice
        </Button>
      </div>

      {/* Mis-dated Deposit Audit Banner — surfaces invoices whose payment date doesn't match invoice date */}
      {depositAudit.count > 0 && (
        <div
          className="rounded-lg border border-amber-300 bg-amber-50 p-4"
          data-testid="deposit-audit-banner"
        >
          <div className="flex flex-col md:flex-row md:items-start md:justify-between gap-3">
            <div className="flex items-start gap-3">
              <AlertTriangle className="h-5 w-5 text-amber-600 mt-0.5 shrink-0" />
              <div>
                <p className="font-semibold text-amber-900">
                  {depositAudit.count} invoice{depositAudit.count === 1 ? '' : 's'} where every deposit is dated away from the invoice date
                </p>
                <p className="text-sm text-amber-800 mt-0.5">
                  None of the deposit dates match the invoice date, which usually means the
                  invoice was backdated but the deposit auto-defaulted to today. Sales for these
                  invoices are landing on the deposit date — open each invoice to confirm.
                  Legitimate part-payments (one deposit on the invoice date plus a later balance
                  payment) are already excluded from this list and counted on the correct day.
                </p>
              </div>
            </div>
            <div className="flex gap-2 shrink-0">
              <Button
                size="sm"
                onClick={() => handleSyncDepositDates(null)}
                disabled={syncingDeposit}
                className="bg-amber-600 hover:bg-amber-700 text-white"
                data-testid="deposit-audit-sync-all-btn"
              >
                {syncingDeposit ? 'Syncing…' : `Sync All (${depositAudit.count})`}
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => setShowDepositAuditList((v) => !v)}
                data-testid="deposit-audit-toggle-btn"
              >
                {showDepositAuditList ? 'Hide' : 'Review'}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={fetchDepositAudit}
                title="Re-run audit"
                data-testid="deposit-audit-refresh-btn"
              >
                <RotateCcw className="h-4 w-4" />
              </Button>
            </div>
          </div>

          {showDepositAuditList && (
            <div className="mt-3 border-t border-amber-200 pt-3">
              <div className="overflow-x-auto">
                <table className="min-w-full text-sm">
                  <thead>
                    <tr className="text-left text-amber-900 border-b border-amber-200">
                      <th className="py-1.5 pr-3 font-medium">Invoice #</th>
                      <th className="py-1.5 pr-3 font-medium">Invoice Date</th>
                      <th className="py-1.5 pr-3 font-medium">Customer</th>
                      <th className="py-1.5 pr-3 font-medium">Total</th>
                      <th className="py-1.5 pr-3 font-medium">Mis-dated Deposit(s)</th>
                      <th className="py-1.5 pr-3 font-medium">Diff</th>
                      <th className="py-1.5 pr-3 font-medium">Action</th>
                    </tr>
                  </thead>
                  <tbody>
                    {depositAudit.invoices.map((inv) => (
                      <tr
                        key={inv.id}
                        className="border-b border-amber-100 last:border-0"
                        data-testid={`deposit-audit-row-${inv.invoice_no}`}
                      >
                        <td className="py-1.5 pr-3 font-mono text-amber-900">{inv.invoice_no}</td>
                        <td className="py-1.5 pr-3">{inv.date}</td>
                        <td className="py-1.5 pr-3">{inv.customer_name || '—'}</td>
                        <td className="py-1.5 pr-3">£{(inv.total || 0).toFixed(2)}</td>
                        <td className="py-1.5 pr-3 text-amber-900">
                          {(inv.deposits || []).map((d, i) => (
                            <span key={i} className="inline-block mr-2">
                              {d.date} {d.method ? `(${d.method})` : ''} £{(d.amount || 0).toFixed(2)}
                            </span>
                          ))}
                        </td>
                        <td className="py-1.5 pr-3">
                          <span className="inline-block px-1.5 py-0.5 rounded bg-amber-200 text-amber-900 font-semibold text-xs">
                            {inv.max_diff_days} day{inv.max_diff_days === 1 ? '' : 's'}
                          </span>
                        </td>
                        <td className="py-1.5 pr-3">
                          <div className="flex gap-1 flex-wrap">
                            <Button
                              size="sm"
                              className="h-7 px-2 text-xs bg-amber-600 hover:bg-amber-700 text-white"
                              onClick={() => handleSyncDepositDates([inv.id])}
                              disabled={syncingDeposit}
                              data-testid={`deposit-audit-sync-btn-${inv.invoice_no}`}
                              title={`Set deposit date(s) to ${inv.date}`}
                            >
                              <RotateCcw className="h-3 w-3 mr-1" /> Sync Now
                            </Button>
                            <Button
                              size="sm"
                              variant="outline"
                              className="h-7 px-2 text-xs"
                              onClick={() => {
                                const fullInv = allInvoices.find(i => i.id === inv.id);
                                if (fullInv) {
                                  navigate('/admin/invoice', { state: { editInvoice: fullInv } });
                                } else {
                                  toast.error('Invoice data not loaded — refresh the page and retry');
                                }
                              }}
                              data-testid={`deposit-audit-edit-btn-${inv.invoice_no}`}
                              title="Open invoice to edit manually"
                            >
                              <Edit2 className="h-3 w-3" />
                            </Button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Search and Filters */}
      <Card className="p-4">
        <div className="flex flex-col md:flex-row gap-4">
          <div className="flex-1 relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              onKeyPress={(e) => e.key === 'Enter' && handleSearch()}
              placeholder="Search by invoice number, customer name, phone, or staff..."
              className="pl-10"
              data-testid="search-input"
            />
          </div>
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => setShowFilters(!showFilters)}>
              <Filter className="h-4 w-4 mr-2" />
              Filters
            </Button>
            <Button onClick={handleSearch} data-testid="search-btn">
              Search
            </Button>
            {(searchTerm || staffFilter || statusFilter || showroomFilter) && (
              <Button variant="ghost" onClick={handleClearFilters}>
                <X className="h-4 w-4" />
              </Button>
            )}
          </div>
        </div>

        {/* Expanded Filters */}
        {showFilters && (
          <div className="mt-4 pt-4 border-t grid grid-cols-1 md:grid-cols-4 gap-4">
            <div>
              <label className="text-sm font-medium mb-1 block">Staff Member</label>
              <select
                value={staffFilter}
                onChange={(e) => setStaffFilter(e.target.value)}
                className="w-full h-10 px-3 border rounded-md"
                data-testid="staff-filter"
              >
                <option value="">All Staff</option>
                {staffList.map(staff => (
                  <option key={staff.id} value={staff.id}>{staff.name}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="text-sm font-medium mb-1 block">Store</label>
              <select
                value={showroomFilter}
                onChange={(e) => setStoreFilter(e.target.value)}
                className="w-full h-10 px-3 border rounded-md"
                data-testid="showroom-filter"
              >
                <option value="">All Stores</option>
                {showrooms.map(showroom => (
                  <option key={showroom.id} value={showroom.id}>{showroom.name}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="text-sm font-medium mb-1 block">Status</label>
              <select
                value={statusFilter}
                onChange={(e) => setStatusFilter(e.target.value)}
                className="w-full h-10 px-3 border rounded-md"
                data-testid="status-filter"
              >
                <option value="">All Statuses</option>
                <option value="open">Open Order</option>
                <option value="deposit">Deposit Order</option>
                <option value="processing">Processing</option>
                <option value="completed">Completed</option>
              </select>
            </div>
          </div>
        )}
      </Card>

      {/* Date Filter */}
      <Card className="p-4">
        <div className="flex flex-wrap items-center gap-4">
          <div className="flex items-center gap-2">
            <Calendar className="h-5 w-5 text-muted-foreground" />
            <span className="font-medium">Filter by Date:</span>
          </div>
          <Input
            type="date"
            value={dateFilter}
            onChange={(e) => setDateFilter(e.target.value)}
            className="w-auto"
            data-testid="date-filter"
          />
          <Button 
            variant={dateFilter === today ? "default" : "outline"} 
            size="sm"
            onClick={() => setDateFilter(today)}
          >
            Today
          </Button>
          <Button 
            variant={!dateFilter ? "default" : "outline"} 
            size="sm"
            onClick={handleShowAllDates}
          >
            All Dates
          </Button>
          
          {/* Find Invoice Button */}
          <div className="ml-auto flex items-center gap-2">
            {showInvoiceSearch ? (
              <div className="flex items-center gap-2">
                <Input
                  type="text"
                  placeholder="Enter invoice number..."
                  value={invoiceSearchTerm}
                  onChange={(e) => setInvoiceSearchTerm(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && handleInvoiceSearch()}
                  className="w-48"
                  autoFocus
                />
                <Button size="sm" onClick={handleInvoiceSearch}>
                  <Search className="h-4 w-4" />
                </Button>
                <Button size="sm" variant="ghost" onClick={() => {
                  setShowInvoiceSearch(false);
                  setInvoiceSearchTerm('');
                }}>
                  <X className="h-4 w-4" />
                </Button>
              </div>
            ) : (
              <Button 
                variant="outline" 
                size="sm"
                onClick={() => setShowInvoiceSearch(true)}
                className="text-indigo-600 border-indigo-200 hover:bg-indigo-50"
              >
                <Search className="h-4 w-4 mr-2" />
                Find Invoice
              </Button>
            )}
          </div>
          
          {dateFilter && (
            <span className="text-sm text-muted-foreground">
              Showing invoices for: <strong>{formatDateDDMMYYYY(dateFilter)}</strong>
            </span>
          )}
        </div>
      </Card>

      {/* Revenue Summary */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4" key={`revenue-${allInvoices.length}-${dateFilter}-${dataVersion}`}>
        {/* Daily Stats */}
        <Card className="p-4 bg-blue-50/50 border-blue-200">
          <div className="flex items-center justify-between mb-2">
            <p className="text-xs font-mono uppercase text-blue-700">Daily Revenue</p>
            <span className="text-xs text-blue-600">{dateFilter ? formatDateDDMMYYYY(dateFilter) : 'Today'}</span>
          </div>
          <p className="text-3xl font-bold text-blue-800">{formatCurrency(getDailyRevenue())}</p>
          <p className="text-sm text-blue-600 mt-1">{invoices.length} invoice(s)</p>
          <TrendPill
            current={getDailyRevenue()}
            prior={getPriorDailyRevenue()}
            label="vs yesterday"
            testId="daily-trend-pill"
          />
          {/* Payment Method Breakdown */}
          <div className="mt-3 pt-3 border-t border-blue-200 space-y-1">
            {Object.entries(getPaymentMethodTotals('daily')).map(([method, data]) => (
              <div key={method} className="flex justify-between text-xs">
                <span className="text-blue-600">{method} ({data.count})</span>
                <span className="font-medium text-blue-700">{formatCurrency(data.total)}</span>
              </div>
            ))}
            {Object.keys(getPaymentMethodTotals('daily')).length === 0 && (
              <p className="text-xs text-blue-400 italic">No payments</p>
            )}
          </div>
        </Card>

        {/* Weekly Stats - Clickable */}
        <Card 
          className="p-4 bg-green-50/50 border-green-200 cursor-pointer hover:bg-green-100/50 transition-colors"
          onClick={() => handleRevenueCardClick('weekly')}
          data-testid="weekly-revenue-card"
        >
          <div className="flex items-center justify-between mb-2">
            <p className="text-xs font-mono uppercase text-green-700">Weekly Revenue</p>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); setShowWeekCompareDialog(true); }}
                className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full border border-green-300 bg-white text-green-700 text-xs hover:bg-green-100 transition-colors"
                title="Compare this week to another week (daily trajectory)"
                data-testid="compare-weekly-btn"
              >
                <TrendingUp className="h-3 w-3" />
                Compare
              </button>
              <span className="text-xs text-green-600">Sun - Sat • Click for details</span>
            </div>
          </div>
          <p className="text-3xl font-bold text-green-800">{formatCurrency(getWeeklyRevenue())}</p>
          <p className="text-sm text-green-600 mt-1">
            {(() => {
              const { start, end, fullEnd } = getWeekBoundaries();
              const capped = end.getTime() < fullEnd.getTime();
              return `${formatDateDDMMYYYY(start)} - ${formatDateDDMMYYYY(end)}${capped ? ' (to date)' : ''}`;
            })()}
          </p>
          <TrendPill
            current={getWeeklyRevenue()}
            prior={getPriorWeeklyRevenue()}
            label="vs prior week"
            testId="weekly-trend-pill"
          />
          {/* Payment Method Breakdown */}
          <div className="mt-3 pt-3 border-t border-green-200 space-y-1">
            {Object.entries(getPaymentMethodTotals('weekly')).map(([method, data]) => (
              <div key={method} className="flex justify-between text-xs">
                <span className="text-green-600">{method} ({data.count})</span>
                <span className="font-medium text-green-700">{formatCurrency(data.total)}</span>
              </div>
            ))}
          </div>
        </Card>

        {/* Monthly Stats - Clickable */}
        <Card 
          className="p-4 bg-purple-50/50 border-purple-200 cursor-pointer hover:bg-purple-100/50 transition-colors"
          onClick={() => handleRevenueCardClick('monthly')}
          data-testid="monthly-revenue-card"
        >
          <div className="flex items-center justify-between mb-2">
            <p className="text-xs font-mono uppercase text-purple-700">Monthly Revenue</p>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); setShowCompareDialog(true); }}
                className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full border border-purple-300 bg-white text-purple-700 text-xs hover:bg-purple-100 transition-colors"
                title="Compare this month to last month (daily trajectory)"
                data-testid="compare-monthly-btn"
              >
                <TrendingUp className="h-3 w-3" />
                Compare
              </button>
              <span className="text-xs text-purple-600">
                {(() => {
                  const { start } = getMonthBoundaries();
                  return start.toLocaleString('default', { month: 'long' });
                })()} • Click for details
              </span>
            </div>
          </div>
          <p className="text-3xl font-bold text-purple-800">{formatCurrency(getMonthlyRevenue())}</p>
          <p className="text-sm text-purple-600 mt-1">
            {(() => {
              const { start, end, fullEnd } = getMonthBoundaries();
              const capped = end.getTime() < fullEnd.getTime();
              return `${formatDateDDMMYYYY(start)} - ${formatDateDDMMYYYY(end)}${capped ? ' (to date)' : ''}`;
            })()}
          </p>
          <TrendPill
            current={getMonthlyRevenue()}
            prior={getPriorMonthlyRevenue()}
            label="vs prior month"
            testId="monthly-trend-pill"
          />
          <TrendPill
            current={getMonthlyRevenue()}
            prior={getYoYMonthlyRevenue()}
            label="YoY"
            testId="monthly-yoy-trend-pill"
          />
          {/* Payment Method Breakdown */}
          <div className="mt-3 pt-3 border-t border-purple-200 space-y-1">
            {Object.entries(getPaymentMethodTotals('monthly')).map(([method, data]) => (
              <div key={method} className="flex justify-between text-xs">
                <span className="text-purple-600">{method} ({data.count})</span>
                <span className="font-medium text-purple-700">{formatCurrency(data.total)}</span>
              </div>
            ))}
          </div>
        </Card>
      </div>

      {/* Invoice Stats for Current View */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <Card className="p-4">
          <p className="text-xs font-mono uppercase text-muted-foreground">Invoices Shown</p>
          <p className="text-2xl font-bold">{invoices.length}</p>
        </Card>
        <Card className="p-4">
          <p className="text-xs font-mono uppercase text-muted-foreground">Total VAT</p>
          <p className="text-2xl font-bold">{formatCurrency(invoices.reduce((sum, inv) => sum + (inv.vat || 0), 0))}</p>
        </Card>
        <Card className="p-4 border-amber-200 bg-amber-50/30">
          <p className="text-xs font-mono uppercase text-amber-700">Deposit Orders</p>
          <p className="text-2xl font-bold text-amber-800">{invoices.filter(inv => getDepositInfo(inv).isDepositOrder).length}</p>
        </Card>
        <Card className="p-4 border-amber-200 bg-amber-50/30">
          <p className="text-xs font-mono uppercase text-amber-700">Outstanding</p>
          <p className="text-2xl font-bold text-amber-800">{formatCurrency(invoices.reduce((sum, inv) => sum + getDepositInfo(inv).outstanding, 0))}</p>
        </Card>
      </div>

      {/* Net Profit Summary - Super Admin Only */}
      {isSuperAdmin && (
        <Card className="p-4 bg-green-50/50 border-green-200">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div>
              <p className="text-xs font-mono uppercase text-green-700">Total Net Profit (Invoices with Cost Data)</p>
              <p className="text-3xl font-bold text-green-800">
                {formatCurrency(invoices.filter(inv => inv.net_profit != null).reduce((sum, inv) => sum + (inv.net_profit || 0), 0))}
              </p>
              <p className="text-xs text-green-600 mt-1">
                {invoices.filter(inv => inv.net_profit != null).length} of {invoices.length} invoices have cost data
              </p>
            </div>
            <div className="grid grid-cols-3 gap-6 text-center">
              <div>
                <p className="text-xs text-green-600">Paid Revenue</p>
                <p className="font-bold text-green-700">{formatCurrency(invoices.filter(inv => inv.net_profit != null).reduce((sum, inv) => sum + getActualPaidAmount(inv), 0))}</p>
              </div>
              <div>
                <p className="text-xs text-green-600">Total Cost</p>
                <p className="font-bold text-green-700">{formatCurrency(invoices.filter(inv => inv.total_cost != null).reduce((sum, inv) => sum + (inv.total_cost || 0), 0))}</p>
              </div>
              <div>
                <p className="text-xs text-green-600">Avg Margin</p>
                <p className="font-bold text-green-700">
                  {(() => {
                    const invoicesWithMargin = invoices.filter(inv => inv.profit_margin != null);
                    if (invoicesWithMargin.length === 0) return '-';
                    const avgMargin = invoicesWithMargin.reduce((sum, inv) => sum + (inv.profit_margin || 0), 0) / invoicesWithMargin.length;
                    return `${avgMargin.toFixed(1)}%`;
                  })()}
                </p>
              </div>
            </div>
          </div>
        </Card>
      )}

      {/* Bulk Actions Bar (Super Admin Only) */}
      {isSuperAdmin && selectedInvoices.length > 0 && (
        <Card className="p-4 bg-indigo-50 border-indigo-200">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div className="flex items-center gap-3">
              <CheckSquare className="h-5 w-5 text-indigo-600" />
              <span className="font-medium text-indigo-800">
                {selectedInvoices.length} invoice{selectedInvoices.length > 1 ? 's' : ''} selected
              </span>
              <span className="text-sm text-indigo-600">
                (Paid: {formatCurrency(getSelectedInvoicesDetails().reduce((sum, inv) => sum + getActualPaidAmount(inv), 0))})
              </span>
            </div>
            <div className="flex items-center gap-2">
              <Button variant="outline" size="sm" onClick={clearSelection}>
                <X className="h-4 w-4 mr-1" />
                Clear
              </Button>
              <Button 
                onClick={openTransferDialog}
                className="bg-indigo-600 hover:bg-indigo-700"
                data-testid="transfer-selected-btn"
              >
                <ArrowRightLeft className="h-4 w-4 mr-2" />
                Transfer to Store
              </Button>
            </div>
          </div>
        </Card>
      )}

      {/* Invoices Table */}
      <Card className="overflow-hidden">
        <div 
          className="overflow-x-auto"
          style={{ 
            WebkitOverflowScrolling: 'touch',
            overflowX: 'auto'
          }}
        >
          <table className="w-full min-w-[900px]">
            <thead className="bg-muted sticky top-0 z-10">
              <tr>
                {/* Checkbox column - only for Super Admin */}
                {isSuperAdmin && (
                  <th className="px-3 py-3 text-center w-10" onClick={(e) => e.stopPropagation()}>
                    <button
                      onClick={toggleSelectAll}
                      className="p-1 hover:bg-gray-200 rounded"
                      title={selectedInvoices.length === filteredInvoices.length ? "Deselect all" : "Select all"}
                    >
                      {selectedInvoices.length === filteredInvoices.length && filteredInvoices.length > 0 ? (
                        <CheckSquare className="h-4 w-4 text-indigo-600" />
                      ) : (
                        <Square className="h-4 w-4 text-gray-400" />
                      )}
                    </button>
                  </th>
                )}
                <th className="px-4 py-3 text-left text-sm font-semibold w-8"></th>
                <th className="px-4 py-3 text-left text-sm font-semibold">Invoice #</th>
                <th className="px-4 py-3 text-left text-sm font-semibold">Date</th>
                <th className="px-4 py-3 text-left text-sm font-semibold">Customer</th>
                <th className="px-4 py-3 text-left text-sm font-semibold">Staff</th>
                <th className="px-4 py-3 text-left text-sm font-semibold">Store</th>
                <th className="px-4 py-3 text-center text-sm font-semibold">Status</th>
                <th className="px-4 py-3 text-right text-sm font-semibold">Total</th>
                {dateFilter && (
                  <th className="px-4 py-3 text-right text-sm font-semibold text-blue-700">Day's Payment</th>
                )}
                {isSuperAdmin && (
                  <th className="px-4 py-3 text-right text-sm font-semibold text-green-700">Net Profit</th>
                )}
                <th className="px-4 py-3 text-right text-sm font-semibold">Outstanding</th>
                <th className="px-4 py-3 text-center text-sm font-semibold">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {filteredInvoices.length === 0 ? (
                <tr>
                  <td colSpan={isSuperAdmin ? (dateFilter ? 13 : 12) : (dateFilter ? 11 : 10)} className="px-4 py-12 text-center text-muted-foreground">
                    <FileText className="h-12 w-12 mx-auto mb-3 opacity-30" />
                    <p className="font-medium">No invoices found</p>
                    <p className="text-sm">{statusFilter ? 'Try changing your filters' : 'Create your first invoice to get started'}</p>
                  </td>
                </tr>
              ) : (
                filteredInvoices.map((invoice) => {
                  const depositInfo = getDepositInfo(invoice);
                  const status = getInvoiceStatus(invoice);
                  const statusBadge = getStatusBadge(status);
                  const isSelected = selectedInvoices.includes(invoice.id);
                  return (
                  <React.Fragment key={invoice.id}>
                    <tr 
                      className={`hover:bg-muted/50 cursor-pointer ${
                        isSelected
                          ? 'bg-indigo-50 border-l-4 border-l-indigo-500'
                          : status === 'deposit_order' 
                          ? 'bg-amber-50 border-l-4 border-l-amber-500' 
                          : status === 'completed'
                          ? 'bg-green-50 border-l-4 border-l-green-500'
                          : status === 'processing'
                          ? 'bg-purple-50 border-l-4 border-l-purple-500'
                          : ''
                      }`}
                      onClick={() => toggleRowExpand(invoice.id)}
                      data-testid={`invoice-row-${invoice.id}`}
                    >
                      {/* Checkbox cell - only for Super Admin */}
                      {isSuperAdmin && (
                        <td className="px-3 py-3 text-center" onClick={(e) => e.stopPropagation()}>
                          <button
                            onClick={() => toggleInvoiceSelection(invoice.id)}
                            className="p-1 hover:bg-gray-200 rounded"
                          >
                            {isSelected ? (
                              <CheckSquare className="h-4 w-4 text-indigo-600" />
                            ) : (
                              <Square className="h-4 w-4 text-gray-400" />
                            )}
                          </button>
                        </td>
                      )}
                      <td className="px-4 py-3">
                        {expandedRow === invoice.id ? (
                          <ChevronUp className="h-4 w-4 text-muted-foreground" />
                        ) : (
                          <ChevronDown className="h-4 w-4 text-muted-foreground" />
                        )}
                      </td>
                      <td className="px-4 py-3">
                        <span className={`font-mono font-medium ${status === 'deposit_order' ? 'text-amber-800' : ''}`}>
                          {invoice.invoice_no}
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-2 text-sm">
                          <Calendar className="h-4 w-4 text-muted-foreground" />
                          {invoice.date} {invoice.time}
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        {invoice.customer_name || <span className="text-muted-foreground italic">No customer</span>}
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-2">
                          <User className="h-4 w-4 text-muted-foreground" />
                          <span>{invoice.staff_name || invoice.sales_person || '-'}</span>
                        </div>
                      </td>
                      <td className="px-4 py-3" onClick={(e) => e.stopPropagation()}>
                        {isSuperAdmin ? (
                          <select
                            value={invoice.showroom_id || ''}
                            onChange={(e) => handleStoreChange(invoice.id, e.target.value)}
                            className={`w-full px-2 py-1 rounded text-xs font-medium border cursor-pointer ${
                              invoice.showroom_id 
                                ? 'bg-green-50 border-green-200 text-green-700' 
                                : 'bg-amber-50 border-amber-200 text-amber-700'
                            }`}
                            data-testid={`showroom-select-${invoice.id}`}
                          >
                            <option value="">Unassigned</option>
                            {showrooms.map(showroom => (
                              <option key={showroom.id} value={showroom.id}>
                                {showroom.name}
                              </option>
                            ))}
                          </select>
                        ) : (
                          <span className={`px-2 py-1 rounded text-xs font-medium ${
                            invoice.showroom_id 
                              ? 'bg-green-50 text-green-700' 
                              : 'bg-amber-50 text-amber-700'
                          }`}>
                            {invoice.showroom_name || 'Unassigned'}
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-center" onClick={(e) => e.stopPropagation()}>
                        <select
                          value={status}
                          onChange={(e) => handleStatusChange(invoice.id, e.target.value)}
                          className={`px-2 py-1 rounded-full text-xs font-medium border-0 cursor-pointer ${statusBadge.className}`}
                          data-testid={`status-select-${invoice.id}`}
                        >
                          <option value="open_order">Open Order</option>
                          <option value="deposit_order">Deposit Order</option>
                          <option value="processing">Processing</option>
                          <option value="completed">Completed</option>
                        </select>
                      </td>
                      <td className="px-4 py-3 text-right">
                        <span className="font-semibold">{formatCurrency(invoice.gross_total)}</span>
                      </td>
                      {dateFilter && (
                        <td className="px-4 py-3 text-right">
                          {(() => {
                            const filterDate = formatDateDDMMYYYY(dateFilter);
                            const dayPayment = getPaymentForDate(invoice, filterDate);
                            const isFromDifferentDay = invoice.date !== filterDate;
                            return (
                              <div>
                                <span className={`font-semibold ${isFromDifferentDay ? 'text-blue-600' : ''}`}>
                                  {formatCurrency(dayPayment)}
                                </span>
                                {isFromDifferentDay && (
                                  <div className="text-xs text-blue-500">
                                    (Invoice: {invoice.date})
                                  </div>
                                )}
                              </div>
                            );
                          })()}
                        </td>
                      )}
                      {isSuperAdmin && (
                        <td className="px-4 py-3 text-right">
                          {invoice.net_profit != null ? (
                            <div>
                              <span className={`font-semibold ${invoice.net_profit >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                                {formatCurrency(invoice.net_profit)}
                              </span>
                              {invoice.profit_margin != null && (
                                <span className="text-xs text-muted-foreground ml-1">
                                  ({invoice.profit_margin}%)
                                </span>
                              )}
                            </div>
                          ) : (
                            <span className="text-xs text-muted-foreground italic">No cost data</span>
                          )}
                        </td>
                      )}
                      <td className="px-4 py-3 text-right">
                        <span className={`font-semibold ${depositInfo.outstanding > 0 ? 'text-amber-600' : ''}`}>
                          {formatCurrency(depositInfo.outstanding)}
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex items-center justify-center gap-0.5" onClick={(e) => e.stopPropagation()}>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => handleDownloadPdf(invoice)}
                            title="Download PDF"
                            data-testid={`download-pdf-${invoice.id}`}
                          >
                            <Download className="h-4 w-4" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => handleShareClick(invoice)}
                            title="Share via Email"
                            className="text-blue-600 hover:text-blue-700 hover:bg-blue-50"
                            data-testid={`email-invoice-${invoice.id}`}
                          >
                            <Mail className="h-4 w-4" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => handleShareWhatsApp(invoice)}
                            title="Share via WhatsApp"
                            className="text-green-600 hover:text-green-700 hover:bg-green-50"
                            data-testid={`whatsapp-invoice-${invoice.id}`}
                          >
                            <MessageCircle className="h-4 w-4" />
                          </Button>
                          {smsAvailable && invoice.customer_phone && (
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => handleSmsClick(invoice)}
                              title="Send SMS Notification"
                              className="text-purple-600 hover:text-purple-700 hover:bg-purple-50"
                              data-testid={`sms-invoice-${invoice.id}`}
                            >
                              <MessageSquare className="h-4 w-4" />
                            </Button>
                          )}
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => handleView(invoice)}
                            title="View"
                            data-testid={`view-invoice-${invoice.id}`}
                          >
                            <Eye className="h-4 w-4" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => handleEdit(invoice)}
                            title="Edit"
                            data-testid={`edit-invoice-${invoice.id}`}
                          >
                            <Edit2 className="h-4 w-4" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="text-orange-600 hover:text-orange-700 hover:bg-orange-50"
                            onClick={() => handleRefundClick(invoice)}
                            title="Create Refund"
                            data-testid={`refund-invoice-${invoice.id}`}
                          >
                            <RotateCcw className="h-4 w-4" />
                          </Button>
                          {isSuperAdmin && (
                          <Button
                            variant="ghost"
                            size="sm"
                            className="text-red-600 hover:text-red-700 hover:bg-red-50"
                            onClick={() => handleDeleteConfirm(invoice)}
                            title="Delete (Super Admin only)"
                            data-testid={`delete-invoice-${invoice.id}`}
                          >
                            <Trash2 className="h-4 w-4" />
                          </Button>
                          )}
                        </div>
                      </td>
                    </tr>
                    {/* Expanded Row - Line Items */}
                    {expandedRow === invoice.id && (
                      <tr>
                        <td colSpan={10} className="bg-muted/30 px-4 py-3">
                          <div className="pl-8">
                            <div className="flex items-center justify-between mb-2">
                              <h4 className="font-semibold text-sm">Line Items</h4>
                              <Button
                                variant="outline"
                                size="sm"
                                onClick={(e) => { e.stopPropagation(); copyLineItemsToClipboard(invoice); }}
                                className="text-blue-600 border-blue-200 hover:bg-blue-50"
                                data-testid={`copy-line-items-${invoice.id}`}
                              >
                                <Copy className="h-3 w-3 mr-1" />
                                Copy All
                              </Button>
                            </div>
                            <table className="w-full text-sm" style={{ userSelect: 'text' }}>
                              <thead>
                                <tr className="text-muted-foreground">
                                  <th className="text-left py-1 w-24">SKU</th>
                                  <th className="text-left py-1 min-w-[200px]">Product</th>
                                  <th className="text-right py-1 w-16">Qty</th>
                                  <th className="text-right py-1 w-20">Price</th>
                                  <th className="text-right py-1 w-24">Due Price</th>
                                  <th className="text-right py-1 w-16">Disc %</th>
                                  <th className="text-right py-1 w-20">Total</th>
                                  {isSuperAdmin && <th className="text-right py-1 text-green-700 w-20">Profit</th>}
                                </tr>
                              </thead>
                              <tbody>
                                {invoice.line_items?.map((item, idx) => {
                                  const originalPrice = item.price || 0;
                                  // Use stored due_price if available, otherwise calculate from discount
                                  const duePrice = item.due_price !== undefined && item.due_price !== null 
                                    ? item.due_price 
                                    : originalPrice * (1 - (item.discount || 0) / 100);
                                  // Calculate discount percentage from price difference if not stored
                                  const discount = item.discount || (originalPrice > 0 && duePrice !== originalPrice 
                                    ? ((originalPrice - duePrice) / originalPrice * 100) 
                                    : 0);
                                  const lineTotal = item.total || (item.quantity * duePrice);
                                  const lineCost = item.cost_price ? item.quantity * item.cost_price : null;
                                  const lineProfit = lineCost !== null ? lineTotal - lineCost : null;
                                  return (
                                  <tr key={idx} className="border-t border-border/50">
                                    <td className="py-1 font-mono text-xs" style={{ userSelect: 'text' }}>{item.sku || '-'}</td>
                                    <td className="py-1" style={{ userSelect: 'text' }}>{cleanNonePatterns(toTitleCase(item.product_name))}</td>
                                    <td className="py-1 text-right" style={{ userSelect: 'text' }}>{item.quantity}</td>
                                    <td className="py-1 text-right" style={{ userSelect: 'text' }}>
                                      {formatCurrency(originalPrice)}
                                    </td>
                                    <td className="py-1 text-right" style={{ userSelect: 'text' }}>
                                      <span className={discount > 0 ? 'text-green-600 font-medium' : ''}>
                                        {formatCurrency(duePrice)}
                                      </span>
                                    </td>
                                    <td className="py-1 text-right" style={{ userSelect: 'text' }}>
                                      {discount > 0 ? <span className="text-green-600">{discount}%</span> : '-'}
                                    </td>
                                    <td className="py-1 text-right font-medium" style={{ userSelect: 'text' }}>
                                      {formatCurrency(lineTotal)}
                                    </td>
                                    {isSuperAdmin && (
                                      <td className="py-1 text-right" style={{ userSelect: 'text' }}>
                                        {lineProfit !== null ? (
                                          <span className={lineProfit >= 0 ? 'text-green-600 font-medium' : 'text-red-600 font-medium'}>
                                            {formatCurrency(lineProfit)}
                                          </span>
                                        ) : (
                                          <span className="text-muted-foreground text-xs italic">N/A</span>
                                        )}
                                      </td>
                                    )}
                                  </tr>
                                  );
                                })}
                              </tbody>
                            </table>
                            <div className="flex justify-end gap-8 mt-3 pt-2 border-t text-sm">
                              <div><span className="text-muted-foreground">Subtotal:</span> <span className="font-medium">{formatCurrency(invoice.subtotal)}</span></div>
                              <div><span className="text-muted-foreground">VAT (20%):</span> <span className="font-medium">{formatCurrency(invoice.vat)}</span></div>
                              <div><span className="text-muted-foreground">Total:</span> <span className="font-bold">{formatCurrency(invoice.gross_total)}</span></div>
                              {isSuperAdmin && (
                                <div>
                                  <span className="text-green-700">Total Profit:</span>{' '}
                                  <span className={`font-bold ${(invoice.net_profit || 0) >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                                    {invoice.net_profit != null ? formatCurrency(invoice.net_profit) : 'N/A'}
                                  </span>
                                </div>
                              )}
                              <Button
                                variant="outline"
                                size="sm"
                                onClick={(e) => { e.stopPropagation(); handleRefundClick(invoice); }}
                                className="text-orange-600 border-orange-200 hover:bg-orange-50 ml-4"
                                data-testid={`create-refund-expanded-${invoice.id}`}
                              >
                                <RotateCcw className="h-3 w-3 mr-1" />
                                Refund
                              </Button>
                              <Button
                                variant="outline"
                                size="sm"
                                onClick={(e) => { e.stopPropagation(); handleConvertToQuotation(invoice, 'quotation'); }}
                                className="text-blue-600 border-blue-200 hover:bg-blue-50"
                                data-testid={`convert-to-quotation-${invoice.id}`}
                              >
                                <FileOutput className="h-3 w-3 mr-1" />
                                To Quotation
                              </Button>
                              <Button
                                variant="outline"
                                size="sm"
                                onClick={(e) => { e.stopPropagation(); handleConvertToQuotation(invoice, 'cash'); }}
                                className="text-green-600 border-green-200 hover:bg-green-50"
                                data-testid={`convert-to-cash-quotation-${invoice.id}`}
                              >
                                <FileOutput className="h-3 w-3 mr-1" />
                                To Cash Quote
                              </Button>
                            </div>
                          </div>
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </Card>

      {/* View Invoice Dialog */}
      <Dialog open={showViewDialog} onOpenChange={setShowViewDialog}>
        <DialogContent className="sm:max-w-2xl max-h-[80vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <FileText className="h-5 w-5" />
              Invoice {selectedInvoice?.invoice_no}
            </DialogTitle>
          </DialogHeader>
          
          {selectedInvoice && (
            <div className="space-y-4">
              {/* Invoice Details */}
              <div className="grid grid-cols-2 gap-4 text-sm">
                <div>
                  <span className="text-muted-foreground">Date:</span>
                  <span className="ml-2 font-medium">{selectedInvoice.date} {selectedInvoice.time}</span>
                </div>
                <div>
                  <span className="text-muted-foreground">Payment:</span>
                  <span className="ml-2 font-medium">
                    {(() => {
                      // Check if there are multiple payments (split payment)
                      const deposits = selectedInvoice.deposits || [];
                      const validDeposits = deposits.filter(d => d.amount && parseFloat(d.amount) > 0);
                      
                      // If multiple deposits with amounts, it's a split payment
                      if (validDeposits.length > 1) {
                        // Try to get method names, fallback to payment_methods array
                        const methods = validDeposits.map(d => d.method).filter(Boolean);
                        const paymentMethodsArray = selectedInvoice.payment_methods || [];
                        const fallbackMethods = paymentMethodsArray.map(pm => pm.method).filter(Boolean);
                        const allMethods = methods.length > 0 ? methods : fallbackMethods;
                        const uniqueMethods = [...new Set(allMethods)];
                        
                        if (uniqueMethods.length > 0) {
                          return 'Split (' + uniqueMethods.join(' + ') + ')';
                        }
                        return 'Split Payment';
                      } else if (validDeposits.length === 1 && validDeposits[0].method) {
                        return validDeposits[0].method;
                      } else {
                        return selectedInvoice.payment_method || '-';
                      }
                    })()}
                  </span>
                </div>
                <div>
                  <span className="text-muted-foreground">Staff:</span>
                  <span className="ml-2 font-medium">{selectedInvoice.staff_name || selectedInvoice.sales_person || '-'}</span>
                </div>
                <div>
                  <span className="text-muted-foreground">Created by:</span>
                  <span className="ml-2 font-medium">{selectedInvoice.created_by}</span>
                </div>
              </div>

              {/* Customer Details */}
              {selectedInvoice.customer_name && (
                <div className="bg-muted/50 p-3 rounded-md">
                  <h4 className="font-semibold text-sm mb-2">Customer</h4>
                  <div className="grid grid-cols-2 gap-2 text-sm">
                    <div><span className="text-muted-foreground">Name:</span> {selectedInvoice.customer_name}</div>
                    <div><span className="text-muted-foreground">Phone:</span> {selectedInvoice.customer_phone || '-'}</div>
                    <div><span className="text-muted-foreground">Email:</span> {selectedInvoice.customer_email || '-'}</div>
                    <div><span className="text-muted-foreground">Address:</span> {selectedInvoice.customer_address || '-'}</div>
                  </div>
                </div>
              )}

              {/* Line Items */}
              <div>
                <h4 className="font-semibold text-sm mb-2">Items</h4>
                <table className="w-full text-sm border" style={{ userSelect: 'text' }}>
                  <thead className="bg-muted">
                    <tr>
                      <th className="px-2 py-1 text-left min-w-[200px]">Product</th>
                      <th className="px-2 py-1 text-right w-16">Qty</th>
                      <th className="px-2 py-1 text-right w-24">Price</th>
                      <th className="px-2 py-1 text-right w-24">Total</th>
                    </tr>
                  </thead>
                  <tbody>
                    {selectedInvoice.line_items?.map((item, idx) => {
                      // Use stored due_price if available, otherwise calculate from discount
                      const duePrice = item.due_price !== undefined && item.due_price !== null 
                        ? item.due_price 
                        : item.price * (1 - (item.discount || 0) / 100);
                      // Calculate discount percentage from price difference if not stored
                      const discount = item.discount || (item.price > 0 && duePrice !== item.price 
                        ? ((item.price - duePrice) / item.price * 100) 
                        : 0);
                      const lineTotal = item.total || (item.quantity * duePrice);
                      return (
                      <tr key={idx} className="border-t">
                        <td className="px-2 py-1" style={{ userSelect: 'text' }}>
                          <div>{cleanNonePatterns(toTitleCase(item.product_name))}</div>
                          <div className="text-xs text-muted-foreground">{item.sku}</div>
                        </td>
                        <td className="px-2 py-1 text-right" style={{ userSelect: 'text' }}>{item.quantity}</td>
                        <td className="px-2 py-1 text-right" style={{ userSelect: 'text' }}>
                          {formatCurrency(duePrice)}
                          {discount > 0 && <span className="text-green-600 text-xs ml-1">(-{discount.toFixed(0)}%)</span>}
                        </td>
                        <td className="px-2 py-1 text-right" style={{ userSelect: 'text' }}>{formatCurrency(lineTotal)}</td>
                      </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              {/* Totals */}
              <div className="flex justify-end">
                <div className="w-64 space-y-1 text-sm">
                  <div className="flex justify-between">
                    <span>Subtotal:</span>
                    <span>{formatCurrency(selectedInvoice.subtotal)}</span>
                  </div>
                  <div className="flex justify-between">
                    <span>VAT (20%):</span>
                    <span>{formatCurrency(selectedInvoice.vat)}</span>
                  </div>
                  <div className="flex justify-between font-bold text-lg border-t pt-1">
                    <span>Total:</span>
                    <span>{formatCurrency(selectedInvoice.gross_total)}</span>
                  </div>
                </div>
              </div>

              {/* Payments Received - Show breakdown of each payment */}
              {(() => {
                const deposits = selectedInvoice.deposits || [];
                const paymentMethodsArray = selectedInvoice.payment_methods || [];
                const validDeposits = deposits.filter(d => {
                  const amt = parseFloat(d.amount) || 0;
                  return amt > 0;
                });
                
                if (validDeposits.length === 0) return null;
                
                // Try to match payment methods from payment_methods array by amount
                const getMethodName = (deposit, idx) => {
                  // First try deposit.method (only if not empty)
                  if (deposit.method && deposit.method.trim()) return deposit.method;
                  // Try to match from payment_methods array by index or amount
                  if (paymentMethodsArray[idx]?.method) return paymentMethodsArray[idx].method;
                  // Try to find matching amount in payment_methods
                  const matchByAmount = paymentMethodsArray.find(pm => 
                    Math.abs(parseFloat(pm.amount) - parseFloat(deposit.amount)) < 0.01
                  );
                  if (matchByAmount?.method) return matchByAmount.method;
                  // Only use note as fallback if it looks like a valid payment method name (not a number)
                  if (deposit.note && isNaN(parseFloat(deposit.note)) && deposit.note.trim()) {
                    return deposit.note;
                  }
                  // Fallback
                  return 'Payment';
                };
                
                return (
                  <div className="bg-green-50 border border-green-200 p-3 rounded-md">
                    <h4 className="font-semibold text-sm mb-2 text-green-800">Payments Received</h4>
                    <div className="space-y-1">
                      {validDeposits.map((deposit, idx) => (
                        <div key={idx} className="flex justify-between text-sm">
                          <span className="text-green-700">
                            {getMethodName(deposit, idx)} {deposit.date && <span className="text-xs text-green-600">({deposit.date})</span>}
                          </span>
                          <span className="font-medium text-green-800">{formatCurrency(parseFloat(deposit.amount))}</span>
                        </div>
                      ))}
                      <div className="flex justify-between font-bold text-sm border-t border-green-300 pt-1 mt-2">
                        <span className="text-green-800">Total Paid:</span>
                        <span className="text-green-800">
                          {formatCurrency(validDeposits.reduce((sum, d) => sum + parseFloat(d.amount), 0))}
                        </span>
                      </div>
                      {(selectedInvoice.amount_outstanding || 0) > 0.01 && (
                        <div className="flex justify-between font-bold text-sm text-amber-700">
                          <span>Outstanding:</span>
                          <span>{formatCurrency(selectedInvoice.amount_outstanding)}</span>
                        </div>
                      )}
                    </div>
                  </div>
                );
              })()}

              {/* Notes */}
              {selectedInvoice.notes && (
                <div className="bg-yellow-50 p-3 rounded-md">
                  <h4 className="font-semibold text-sm mb-1">Notes</h4>
                  <p className="text-sm">{selectedInvoice.notes}</p>
                </div>
              )}
            </div>
          )}
          
          <DialogFooter className="flex-wrap gap-2">
            <Button variant="outline" onClick={() => setShowViewDialog(false)}>
              Close
            </Button>
            <Button variant="outline" onClick={() => handleDownloadPdf(selectedInvoice)}>
              <Download className="h-4 w-4 mr-2" />
              PDF
            </Button>
            <Button variant="outline" className="text-blue-600 border-blue-200 hover:bg-blue-50" onClick={() => { setShowViewDialog(false); handleShareClick(selectedInvoice); }}>
              <Mail className="h-4 w-4 mr-2" />
              Email
            </Button>
            <Button variant="outline" className="text-green-600 border-green-200 hover:bg-green-50" onClick={() => handleShareWhatsApp(selectedInvoice)}>
              <MessageCircle className="h-4 w-4 mr-2" />
              WhatsApp
            </Button>
            <Button variant="outline" className="text-orange-600 border-orange-200 hover:bg-orange-50" onClick={() => { setShowViewDialog(false); handleRefundClick(selectedInvoice); }}>
              <RotateCcw className="h-4 w-4 mr-2" />
              Refund
            </Button>
            <Button variant="outline" className="text-purple-600 border-purple-200 hover:bg-purple-50" onClick={() => { setShowViewDialog(false); handleConvertToQuotation(selectedInvoice, 'quotation'); }}>
              <FileOutput className="h-4 w-4 mr-2" />
              To Quote
            </Button>
            {smsAvailable && selectedInvoice?.customer_phone && (
              <Button 
                variant="outline" 
                className="text-purple-600 border-purple-200 hover:bg-purple-50" 
                onClick={() => handleSmsClick(selectedInvoice)}
              >
                <MessageSquare className="h-4 w-4 mr-2" />
                SMS
              </Button>
            )}
            <Button onClick={() => { setShowViewDialog(false); handleEdit(selectedInvoice); }}>
              <Edit2 className="h-4 w-4 mr-2" />
              Edit
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Share via Email Dialog */}
      <Dialog open={showShareDialog} onOpenChange={setShowShareDialog}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Mail className="h-5 w-5 text-blue-600" />
              Share Invoice via Email
            </DialogTitle>
            <DialogDescription>
              Send invoice <strong>#{selectedInvoice?.invoice_no}</strong> as a PDF attachment.
            </DialogDescription>
          </DialogHeader>
          
          <div className="space-y-4 py-4">
            <div>
              <label className="text-sm font-medium mb-1 block">Recipient Email *</label>
              <Input
                type="email"
                value={shareEmail}
                onChange={(e) => setShareEmail(e.target.value)}
                placeholder="customer@example.com"
                data-testid="share-email-input"
              />
            </div>
            <div>
              <label className="text-sm font-medium mb-1 block">Personal Message (optional)</label>
              <Textarea
                value={shareMessage}
                onChange={(e) => setShareMessage(e.target.value)}
                placeholder="Add a personal note to include in the email..."
                rows={3}
                data-testid="share-message-input"
              />
            </div>
          </div>
          
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowShareDialog(false)}>
              Cancel
            </Button>
            <Button 
              onClick={handleSendEmail}
              disabled={sending || !shareEmail}
              className="bg-blue-600 hover:bg-blue-700"
              data-testid="send-email-btn"
            >
              {sending ? (
                <>Sending...</>
              ) : (
                <>
                  <Mail className="h-4 w-4 mr-2" />
                  Send Invoice
                </>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation Dialog */}
      <Dialog open={showDeleteDialog} onOpenChange={setShowDeleteDialog}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="text-red-600">Delete Invoice</DialogTitle>
            <DialogDescription>
              Are you sure you want to delete invoice <strong>{selectedInvoice?.invoice_no}</strong>? 
              This will also restore the stock for all items in this invoice. This action cannot be undone.
            </DialogDescription>
          </DialogHeader>
          
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowDeleteDialog(false)}>
              Cancel
            </Button>
            <Button 
              variant="destructive" 
              onClick={handleDelete}
              disabled={deleting}
              data-testid="confirm-delete-btn"
            >
              {deleting ? 'Deleting...' : 'Delete Invoice'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Revenue Breakdown Dialog */}


      {/* Weekly Compare Dialog — any two Sun-Sat weeks overlaid by day-of-week */}
      <Dialog open={showWeekCompareDialog} onOpenChange={setShowWeekCompareDialog}>
        <DialogContent className="sm:max-w-5xl max-h-[90vh] overflow-auto">
          <DialogHeader>
            <DialogTitle className="text-green-700 flex items-center gap-2">
              <TrendingUp className="h-5 w-5" />
              Weekly Pace — Current vs Prior Week
            </DialogTitle>
            <DialogDescription>
              Cumulative revenue by day of the week (Sunday → Saturday). Dashed line = the prior week chosen for comparison so you can see if this week is tracking ahead or behind.
            </DialogDescription>
          </DialogHeader>

          {showWeekCompareDialog && (() => {
            const anchor = getAnchorDate();
            const anchorSunday = getSundayOf(anchor);
            const defaultPrior = new Date(anchorSunday); defaultPrior.setDate(anchorSunday.getDate() - 7);

            const curValue = compareCurWeek || toYMD(anchorSunday);
            const priValue = comparePriorWeek || toYMD(defaultPrior);
            const curSunday = parseYMD(curValue) || anchorSunday;

            const cmp = buildWeeklyCompareSeries(curValue, priValue);
            const diff = cmp.currentTotalToDate - cmp.priorTotalSameDay;
            const diffPct = cmp.priorTotalSameDay > 0
              ? ((diff / cmp.priorTotalSameDay) * 100).toFixed(1)
              : null;
            const ahead = diff > 0;

            // Build week options: anchor week back to the Sunday containing the oldest invoice.
            const anchorWeekMs = anchorSunday.getTime();
            let earliestMs = anchorWeekMs;
            (getShowroomFilteredInvoices() || []).forEach(inv => {
              const d = parseInvoiceDate(inv.date);
              if (d && d.getTime() < earliestMs) earliestMs = d.getTime();
            });
            (allRefunds || []).forEach(r => {
              const d = parseInvoiceDate(r.date);
              if (d && d.getTime() < earliestMs) earliestMs = d.getTime();
            });
            const earliestSunday = getSundayOf(new Date(earliestMs));
            const weeksBack = Math.max(
              12,
              Math.ceil((anchorWeekMs - earliestSunday.getTime()) / (7 * 86400000)) + 1
            );
            const weekOptions = [];
            for (let i = 0; i < weeksBack; i++) {
              const sun = new Date(anchorSunday); sun.setDate(anchorSunday.getDate() - i * 7);
              weekOptions.push({ value: toYMD(sun), label: fmtWeekLabel(sun) });
            }

            const setPriorRelative = (weekOffset) => {
              const sun = new Date(curSunday); sun.setDate(curSunday.getDate() + weekOffset * 7);
              setComparePriorWeek(toYMD(sun));
            };
            const isActive = (weekOffset) => {
              const sun = new Date(curSunday); sun.setDate(curSunday.getDate() + weekOffset * 7);
              return priValue === toYMD(sun);
            };

            return (
              <div className="space-y-4">
                {/* Week pickers */}
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs font-mono uppercase text-green-700 mb-1">Current Week</label>
                    <select
                      value={curValue}
                      onChange={(e) => setCompareCurWeek(e.target.value)}
                      className="w-full border rounded-md px-3 py-2 text-sm bg-white focus:ring-2 focus:ring-green-300 focus:outline-none"
                      data-testid="compare-current-week-select"
                    >
                      {weekOptions.map(o => (
                        <option key={`curw-${o.value}`} value={o.value}>{o.label}</option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="block text-xs font-mono uppercase text-gray-700 mb-1">Compare Against</label>
                    <select
                      value={priValue}
                      onChange={(e) => setComparePriorWeek(e.target.value)}
                      className="w-full border rounded-md px-3 py-2 text-sm bg-white focus:ring-2 focus:ring-green-300 focus:outline-none"
                      data-testid="compare-prior-week-select"
                    >
                      {weekOptions.map(o => (
                        <option key={`priw-${o.value}`} value={o.value}>{o.label}</option>
                      ))}
                    </select>
                    <div className="flex flex-wrap gap-2 mt-2">
                      <button
                        type="button"
                        onClick={() => setPriorRelative(-1)}
                        className={`px-2 py-0.5 rounded-full border text-xs transition-colors ${
                          isActive(-1) ? 'bg-green-600 text-white border-green-600' : 'bg-white text-green-700 border-green-300 hover:bg-green-50'
                        }`}
                        data-testid="compare-week-quick-prior-btn"
                      >
                        Prior Week
                      </button>
                      <button
                        type="button"
                        onClick={() => setPriorRelative(-52)}
                        className={`px-2 py-0.5 rounded-full border text-xs transition-colors ${
                          isActive(-52) ? 'bg-green-600 text-white border-green-600' : 'bg-white text-green-700 border-green-300 hover:bg-green-50'
                        }`}
                        title="Same week (index) one year ago"
                        data-testid="compare-week-quick-yoy-btn"
                      >
                        YoY (52 weeks ago)
                      </button>
                      <button
                        type="button"
                        onClick={() => setPriorRelative(-4)}
                        className={`px-2 py-0.5 rounded-full border text-xs transition-colors ${
                          isActive(-4) ? 'bg-green-600 text-white border-green-600' : 'bg-white text-green-700 border-green-300 hover:bg-green-50'
                        }`}
                        data-testid="compare-week-quick-4wk-btn"
                      >
                        4 Weeks Ago
                      </button>
                    </div>
                  </div>
                </div>

                {/* Summary stats */}
                <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                  <Card className="p-3 bg-green-50/50 border-green-200">
                    <p className="text-xs uppercase font-mono text-green-700">
                      {cmp.currentWeekLabel} {cmp.isLiveCurrentWeek ? `• To ${cmp.anchorDayName}` : '• Full Week'}
                    </p>
                    <p className="text-2xl font-bold text-green-900 mt-1">{formatCurrency(cmp.currentTotalToDate)}</p>
                  </Card>
                  <Card className="p-3 bg-gray-50 border-gray-200">
                    <p className="text-xs uppercase font-mono text-gray-700">
                      {cmp.priorWeekLabel} • {cmp.isLiveCurrentWeek ? `Thru ${cmp.anchorDayName}` : 'Full Week'}
                    </p>
                    <p className="text-2xl font-bold text-gray-900 mt-1">{formatCurrency(cmp.priorTotalSameDay)}</p>
                    <p className="text-xs text-gray-500 mt-0.5">Full week: {formatCurrency(cmp.priorTotalFullWeek)}</p>
                  </Card>
                  <Card className={`p-3 ${ahead ? 'bg-green-50 border-green-200' : diff < 0 ? 'bg-red-50 border-red-200' : 'bg-gray-50 border-gray-200'}`}>
                    <p className={`text-xs uppercase font-mono ${ahead ? 'text-green-700' : diff < 0 ? 'text-red-700' : 'text-gray-700'}`}>Pace Delta</p>
                    <p className={`text-2xl font-bold mt-1 ${ahead ? 'text-green-900' : diff < 0 ? 'text-red-900' : 'text-gray-900'}`}>
                      {ahead ? '▲' : diff < 0 ? '▼' : '•'} {formatCurrency(Math.abs(diff))}
                    </p>
                    <p className={`text-xs mt-0.5 ${ahead ? 'text-green-600' : diff < 0 ? 'text-red-600' : 'text-gray-500'}`}>
                      {diffPct !== null ? `${ahead ? '+' : '-'}${diffPct.replace('-', '')}% vs ${cmp.priorWeekLabel}` : (cmp.currentTotalToDate > 0 ? 'No prior data' : 'No activity yet')}
                    </p>
                  </Card>
                </div>

                {/* Chart */}
                <div className="bg-white rounded-lg border p-3" style={{ height: 340 }}>
                  <ResponsiveContainer width="100%" height="100%">
                    <LineChart data={cmp.series} margin={{ top: 10, right: 20, bottom: 10, left: 10 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
                      <XAxis dataKey="day" tick={{ fontSize: 11 }} />
                      <YAxis
                        tick={{ fontSize: 11 }}
                        tickFormatter={(v) => `£${v >= 1000 ? (v/1000).toFixed(1) + 'k' : v.toFixed(0)}`}
                      />
                      <RechartsTooltip
                        formatter={(value, name) => [formatCurrency(value || 0), name]}
                        labelFormatter={(day) => day}
                      />
                      <Legend wrapperStyle={{ fontSize: 12 }} />
                      {cmp.isLiveCurrentWeek && (
                        <ReferenceLine x={cmp.anchorDayName} stroke="#16a34a" strokeDasharray="4 4" label={{ value: 'today', fontSize: 10, fill: '#16a34a', position: 'top' }} />
                      )}
                      <Line type="monotone" dataKey="priorCum" name={`${cmp.priorWeekLabel} (cumulative)`} stroke="#9ca3af" strokeWidth={2} strokeDasharray="5 5" dot={false} connectNulls />
                      <Line type="monotone" dataKey="currentCum" name={`${cmp.currentWeekLabel} (cumulative)`} stroke="#16a34a" strokeWidth={3} dot={{ r: 3 }} connectNulls />
                    </LineChart>
                  </ResponsiveContainer>
                </div>

                <p className="text-xs text-gray-500">
                  Solid green = current-week cumulative. Dashed grey = chosen prior week. {cmp.isLiveCurrentWeek ? `The green reference line marks today (${formatDateDDMMYYYY(anchor)}).` : 'Both weeks shown in full.'}
                </p>
              </div>
            );
          })()}

          <DialogFooter>
            <Button variant="outline" onClick={() => setShowWeekCompareDialog(false)} data-testid="compare-weekly-close-btn">
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>


      {/* Monthly Compare Dialog — current month vs prior month daily trajectory */}
      <Dialog open={showCompareDialog} onOpenChange={setShowCompareDialog}>
        <DialogContent className="sm:max-w-5xl max-h-[90vh] overflow-auto">
          <DialogHeader>
            <DialogTitle className="text-purple-700 flex items-center gap-2">
              <TrendingUp className="h-5 w-5" />
              Monthly Pace — Current vs Prior Month
            </DialogTitle>
            <DialogDescription>
              Cumulative revenue over each day of the month. The dashed line shows prior-month pace so you can see whether the current month is tracking ahead or behind at the same day.
            </DialogDescription>
          </DialogHeader>

          {showCompareDialog && (() => {
            // Parse picker values (YYYY-MM). Fall back to anchor-based defaults.
            const anchor = getAnchorDate();
            const parseSpec = (s, fallback) => {
              if (!s) return fallback;
              const [yStr, mStr] = s.split('-');
              const y = parseInt(yStr, 10), m = parseInt(mStr, 10) - 1;
              if (isNaN(y) || isNaN(m)) return fallback;
              return { year: y, month: m };
            };
            const curSpec = parseSpec(compareCurMonth, { year: anchor.getFullYear(), month: anchor.getMonth() });
            const priSpec = parseSpec(comparePriorMonth, { year: anchor.getFullYear(), month: anchor.getMonth() - 1 });
            const cmp = buildMonthlyCompareSeries(curSpec, priSpec);
            const diff = cmp.currentTotalToDate - cmp.priorTotalSameDay;
            const diffPct = cmp.priorTotalSameDay > 0
              ? ((diff / cmp.priorTotalSameDay) * 100).toFixed(1)
              : null;
            const ahead = diff > 0;

            // Build YYYY-MM options: from the anchor month back to the earliest invoice
            // (or the earliest refund). Minimum 12 months so the dropdown is never tiny.
            // Effectively unbounded — whatever historical range the data covers, is shown.
            const anchorMs = new Date(anchor.getFullYear(), anchor.getMonth(), 1).getTime();
            let earliestMs = anchorMs;
            (getShowroomFilteredInvoices() || []).forEach(inv => {
              const d = parseInvoiceDate(inv.date);
              if (d && d.getTime() < earliestMs) earliestMs = d.getTime();
            });
            (allRefunds || []).forEach(r => {
              const d = parseInvoiceDate(r.date);
              if (d && d.getTime() < earliestMs) earliestMs = d.getTime();
            });
            const earliest = new Date(earliestMs);
            const monthsBack = Math.max(
              12,
              (anchor.getFullYear() - earliest.getFullYear()) * 12
                + (anchor.getMonth() - earliest.getMonth())
                + 1
            );
            const monthOptions = [];
            for (let i = 0; i < monthsBack; i++) {
              const d = new Date(anchor.getFullYear(), anchor.getMonth() - i, 1);
              const y = d.getFullYear();
              const m = d.getMonth();
              const value = `${y}-${String(m + 1).padStart(2, '0')}`;
              const label = d.toLocaleString('default', { month: 'long', year: 'numeric' });
              monthOptions.push({ value, label });
            }

            const curValue = compareCurMonth || `${curSpec.year}-${String(curSpec.month + 1).padStart(2, '0')}`;
            const priValue = comparePriorMonth || `${priSpec.year}-${String(priSpec.month + 1).padStart(2, '0')}`;

            // Quick-pick helpers — wire the prior picker to a logical default relative to the
            // currently-selected current month.
            const setPriorRelative = (yearOffset, monthOffset) => {
              const y = curSpec.year + yearOffset;
              const m = curSpec.month + monthOffset;
              // Normalise m to 0..11 with year rollover
              const d = new Date(y, m, 1);
              const value = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
              setComparePriorMonth(value);
            };
            const isActive = (yearOffset, monthOffset) => {
              const d = new Date(curSpec.year + yearOffset, curSpec.month + monthOffset, 1);
              const v = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
              return priValue === v;
            };

            return (
              <div className="space-y-4">
                {/* Month pickers */}
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs font-mono uppercase text-purple-700 mb-1">Current Month</label>
                    <select
                      value={curValue}
                      onChange={(e) => setCompareCurMonth(e.target.value)}
                      className="w-full border rounded-md px-3 py-2 text-sm bg-white focus:ring-2 focus:ring-purple-300 focus:outline-none"
                      data-testid="compare-current-month-select"
                    >
                      {monthOptions.map(o => (
                        <option key={`cur-${o.value}`} value={o.value}>{o.label}</option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="block text-xs font-mono uppercase text-gray-700 mb-1">Compare Against</label>
                    <select
                      value={priValue}
                      onChange={(e) => setComparePriorMonth(e.target.value)}
                      className="w-full border rounded-md px-3 py-2 text-sm bg-white focus:ring-2 focus:ring-purple-300 focus:outline-none"
                      data-testid="compare-prior-month-select"
                    >
                      {monthOptions.map(o => (
                        <option key={`pri-${o.value}`} value={o.value}>{o.label}</option>
                      ))}
                    </select>
                    <div className="flex flex-wrap gap-2 mt-2">
                      <button
                        type="button"
                        onClick={() => setPriorRelative(0, -1)}
                        className={`px-2 py-0.5 rounded-full border text-xs transition-colors ${
                          isActive(0, -1)
                            ? 'bg-purple-600 text-white border-purple-600'
                            : 'bg-white text-purple-700 border-purple-300 hover:bg-purple-50'
                        }`}
                        data-testid="compare-quick-prior-month-btn"
                      >
                        Prior Month
                      </button>
                      <button
                        type="button"
                        onClick={() => setPriorRelative(-1, 0)}
                        className={`px-2 py-0.5 rounded-full border text-xs transition-colors ${
                          isActive(-1, 0)
                            ? 'bg-purple-600 text-white border-purple-600'
                            : 'bg-white text-purple-700 border-purple-300 hover:bg-purple-50'
                        }`}
                        data-testid="compare-quick-yoy-btn"
                        title="Same month, previous year"
                      >
                        YoY (same month, last year)
                      </button>
                      <button
                        type="button"
                        onClick={() => setPriorRelative(0, -3)}
                        className={`px-2 py-0.5 rounded-full border text-xs transition-colors ${
                          isActive(0, -3)
                            ? 'bg-purple-600 text-white border-purple-600'
                            : 'bg-white text-purple-700 border-purple-300 hover:bg-purple-50'
                        }`}
                        data-testid="compare-quick-qoq-btn"
                        title="3 months ago"
                      >
                        3 Months Ago
                      </button>
                    </div>
                  </div>
                </div>

                {/* Summary stats */}
                <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                  <Card className="p-3 bg-purple-50/50 border-purple-200">
                    <p className="text-xs uppercase font-mono text-purple-700">
                      {cmp.currentMonthLabel} {cmp.isLiveCurrentMonth ? `• To Day ${cmp.anchorDay}` : '• Full Month'}
                    </p>
                    <p className="text-2xl font-bold text-purple-900 mt-1">{formatCurrency(cmp.currentTotalToDate)}</p>
                  </Card>
                  <Card className="p-3 bg-gray-50 border-gray-200">
                    <p className="text-xs uppercase font-mono text-gray-700">{cmp.priorMonthLabel} • {cmp.isLiveCurrentMonth ? 'Same Day' : `To Day ${cmp.anchorDay}`}</p>
                    <p className="text-2xl font-bold text-gray-900 mt-1">{formatCurrency(cmp.priorTotalSameDay)}</p>
                    <p className="text-xs text-gray-500 mt-0.5">Full month: {formatCurrency(cmp.priorTotalFullMonth)}</p>
                  </Card>
                  <Card className={`p-3 ${ahead ? 'bg-green-50 border-green-200' : diff < 0 ? 'bg-red-50 border-red-200' : 'bg-gray-50 border-gray-200'}`}>
                    <p className={`text-xs uppercase font-mono ${ahead ? 'text-green-700' : diff < 0 ? 'text-red-700' : 'text-gray-700'}`}>
                      Pace Delta
                    </p>
                    <p className={`text-2xl font-bold mt-1 ${ahead ? 'text-green-900' : diff < 0 ? 'text-red-900' : 'text-gray-900'}`}>
                      {ahead ? '▲' : diff < 0 ? '▼' : '•'} {formatCurrency(Math.abs(diff))}
                    </p>
                    <p className={`text-xs mt-0.5 ${ahead ? 'text-green-600' : diff < 0 ? 'text-red-600' : 'text-gray-500'}`}>
                      {diffPct !== null ? `${ahead ? '+' : '-'}${diffPct.replace('-', '')}% vs ${cmp.priorMonthLabel}` : (cmp.currentTotalToDate > 0 ? 'No prior data' : 'No activity yet')}
                    </p>
                  </Card>
                </div>

                {/* Chart */}
                <div className="bg-white rounded-lg border p-3" style={{ height: 360 }}>
                  <ResponsiveContainer width="100%" height="100%">
                    <LineChart data={cmp.series} margin={{ top: 10, right: 20, bottom: 10, left: 10 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
                      <XAxis
                        dataKey="day"
                        tick={{ fontSize: 11 }}
                        label={{ value: 'Day of Month', position: 'insideBottom', offset: -5, fontSize: 11 }}
                      />
                      <YAxis
                        tick={{ fontSize: 11 }}
                        tickFormatter={(v) => `£${v >= 1000 ? (v/1000).toFixed(1) + 'k' : v.toFixed(0)}`}
                      />
                      <RechartsTooltip
                        formatter={(value, name) => [formatCurrency(value || 0), name]}
                        labelFormatter={(day) => `Day ${day}`}
                      />
                      <Legend wrapperStyle={{ fontSize: 12 }} />
                      {cmp.isLiveCurrentMonth && (
                        <ReferenceLine x={cmp.anchorDay} stroke="#a855f7" strokeDasharray="4 4" label={{ value: 'today', fontSize: 10, fill: '#a855f7', position: 'top' }} />
                      )}
                      <Line
                        type="monotone"
                        dataKey="priorCum"
                        name={`${cmp.priorMonthLabel} (cumulative)`}
                        stroke="#9ca3af"
                        strokeWidth={2}
                        strokeDasharray="5 5"
                        dot={false}
                        connectNulls
                      />
                      <Line
                        type="monotone"
                        dataKey="currentCum"
                        name={`${cmp.currentMonthLabel} (cumulative)`}
                        stroke="#7c3aed"
                        strokeWidth={3}
                        dot={{ r: 3 }}
                        connectNulls
                      />
                    </LineChart>
                  </ResponsiveContainer>
                </div>

                <p className="text-xs text-gray-500">
                  Solid purple = {cmp.currentMonthLabel} cumulative revenue. Dashed grey = {cmp.priorMonthLabel} cumulative.
                  {cmp.isLiveCurrentMonth ? ` The vertical dashed line marks the selected date (${formatDateDDMMYYYY(anchor)}).` : ' Both months shown in full.'}
                  {' '}Data respects the store/showroom filter if one is active.
                </p>
              </div>
            );
          })()}

          <DialogFooter>
            <Button variant="outline" onClick={() => setShowCompareDialog(false)} data-testid="compare-monthly-close-btn">
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>


      <Dialog open={showBreakdownDialog} onOpenChange={setShowBreakdownDialog}>
        <DialogContent className="sm:max-w-6xl max-h-[85vh] overflow-hidden flex flex-col">
          <DialogHeader>
            <DialogTitle className={breakdownType === 'weekly' ? 'text-green-700' : 'text-purple-700'}>
              {breakdownType === 'weekly' ? '📊 Weekly Revenue Breakdown' : '📊 Monthly Revenue Breakdown'}
            </DialogTitle>
            <DialogDescription>
              {breakdownType === 'weekly' ? (
                <>Daily sales from {(() => { const { start, end } = getWeekBoundaries(); return `${formatDateDDMMYYYY(start)} to ${formatDateDDMMYYYY(end)}`; })()}</>
              ) : (
                <>Daily sales for {new Date().toLocaleString('default', { month: 'long', year: 'numeric' })}</>
              )}
            </DialogDescription>
          </DialogHeader>
          
          {/* Payment Method Summary for Period */}
          <div className={`p-3 rounded-lg mb-3 ${breakdownType === 'weekly' ? 'bg-green-50' : 'bg-purple-50'}`}>
            <p className={`text-xs font-semibold mb-2 ${breakdownType === 'weekly' ? 'text-green-700' : 'text-purple-700'}`}>
              Payment Method Summary
            </p>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
              {Object.entries(getPaymentMethodTotals(breakdownType)).map(([method, data]) => (
                <div key={method} className="bg-white rounded p-2">
                  <p className="text-xs text-muted-foreground">{method}</p>
                  <p className={`font-bold ${breakdownType === 'weekly' ? 'text-green-700' : 'text-purple-700'}`}>
                    {formatCurrency(data.total)}
                  </p>
                  <p className="text-xs text-muted-foreground">{data.count} invoice(s)</p>
                </div>
              ))}
            </div>
          </div>
          
          <div className="flex-1 overflow-y-auto">
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-white">
                <tr className={breakdownType === 'weekly' ? 'bg-green-50' : 'bg-purple-50'}>
                  <th className="text-left py-2 px-3 font-semibold">Date</th>
                  <th className="text-left py-2 px-3 font-semibold">Day</th>
                  <th className="text-right py-2 px-3 font-semibold">Invoices</th>
                  <th className="text-left py-2 px-3 font-semibold">Payment Methods</th>
                  <th className="text-right py-2 px-3 font-semibold">VAT</th>
                  <th className="text-right py-2 px-3 font-semibold">Revenue</th>
                  <th className="text-right py-2 px-3 font-semibold text-red-600">Refunds</th>
                  <th className="text-right py-2 px-3 font-semibold">Net</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {breakdownType && getDailyBreakdown(breakdownType).map((day, index) => {
                  const dayDate = parseInvoiceDate(day.date);
                  const dayName = dayDate ? dayDate.toLocaleDateString('en-GB', { weekday: 'short' }) : '';
                  const isToday = day.date === formatDateDDMMYYYY(new Date());
                  const netRevenue = day.revenue - day.refundTotal;
                  
                  return (
                    <tr 
                      key={index} 
                      className={`${isToday ? 'bg-yellow-50 font-medium' : 'hover:bg-gray-50'} ${day.revenue === 0 && day.refundTotal === 0 ? 'text-gray-400' : ''}`}
                    >
                      <td className="py-2 px-3">
                        {day.date}
                        {isToday && <span className="ml-2 text-xs bg-yellow-200 text-yellow-800 px-1.5 py-0.5 rounded">Today</span>}
                      </td>
                      <td className="py-2 px-3">{dayName}</td>
                      <td className="py-2 px-3 text-right">{day.invoiceCount}</td>
                      <td className="py-2 px-3">
                        {Object.entries(day.paymentMethods).length > 0 ? (
                          <div className="flex flex-wrap gap-1">
                            {Object.entries(day.paymentMethods).map(([method, data]) => (
                              <span key={method} className="text-xs bg-gray-100 px-1.5 py-0.5 rounded">
                                {method}: {formatCurrency(data.total)}
                              </span>
                            ))}
                          </div>
                        ) : (
                          <span className="text-xs text-gray-400">-</span>
                        )}
                      </td>
                      <td className="py-2 px-3 text-right">{formatCurrency(day.vat)}</td>
                      <td className={`py-2 px-3 text-right font-medium ${day.revenue > 0 ? (breakdownType === 'weekly' ? 'text-green-700' : 'text-purple-700') : ''}`}>
                        {formatCurrency(day.revenue)}
                      </td>
                      <td 
                        className={`py-2 px-3 text-right ${day.refundTotal > 0 ? 'text-red-600 font-medium cursor-pointer hover:bg-red-50 rounded' : 'text-gray-400'}`}
                        onClick={() => day.refundTotal > 0 && handleBreakdownRefundClick(day.date)}
                        title={day.refundTotal > 0 ? 'Click to view refund details' : ''}
                      >
                        {day.refundTotal > 0 ? (
                          <span className="underline decoration-dotted">-{formatCurrency(day.refundTotal)} ({day.refundCount})</span>
                        ) : (
                          <span>-</span>
                        )}
                      </td>
                      <td className={`py-2 px-3 text-right font-medium ${netRevenue > 0 ? (breakdownType === 'weekly' ? 'text-green-800' : 'text-purple-800') : netRevenue < 0 ? 'text-red-700' : ''}`}>
                        {formatCurrency(netRevenue)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
              <tfoot className={breakdownType === 'weekly' ? 'bg-green-100' : 'bg-purple-100'}>
                <tr className="font-bold">
                  <td className="py-3 px-3" colSpan={2}>TOTAL</td>
                  <td className="py-3 px-3 text-right">
                    {breakdownType && getDailyBreakdown(breakdownType).reduce((sum, d) => sum + d.invoiceCount, 0)}
                  </td>
                  <td className="py-3 px-3"></td>
                  <td className="py-3 px-3 text-right">
                    {formatCurrency(breakdownType && getDailyBreakdown(breakdownType).reduce((sum, d) => sum + d.vat, 0))}
                  </td>
                  <td className={`py-3 px-3 text-right ${breakdownType === 'weekly' ? 'text-green-800' : 'text-purple-800'}`}>
                    {formatCurrency(breakdownType === 'weekly' ? getWeeklyRevenue() : getMonthlyRevenue())}
                  </td>
                  <td className="py-3 px-3 text-right text-red-600">
                    -{formatCurrency(breakdownType && getDailyBreakdown(breakdownType).reduce((sum, d) => sum + d.refundTotal, 0))}
                    <span className="text-xs ml-1">({breakdownType && getDailyBreakdown(breakdownType).reduce((sum, d) => sum + d.refundCount, 0)})</span>
                  </td>
                  <td className={`py-3 px-3 text-right text-lg ${breakdownType === 'weekly' ? 'text-green-800' : 'text-purple-800'}`}>
                    {formatCurrency(
                      (breakdownType === 'weekly' ? getWeeklyRevenue() : getMonthlyRevenue()) - 
                      (breakdownType && getDailyBreakdown(breakdownType).reduce((sum, d) => sum + d.refundTotal, 0))
                    )}
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>
          
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowBreakdownDialog(false)}>
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Bulk Transfer Dialog (Super Admin Only) */}
      <Dialog open={showTransferDialog} onOpenChange={setShowTransferDialog}>
        <DialogContent className="sm:max-w-2xl" data-testid="transfer-dialog">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-indigo-700">
              <ArrowRightLeft className="h-5 w-5" />
              Transfer Invoices to Store
            </DialogTitle>
            <DialogDescription>
              Transfer {selectedInvoices.length} selected invoice(s) and their associated revenue to a different showroom.
            </DialogDescription>
          </DialogHeader>
          
          {/* Summary of Selected Invoices */}
          <div className="bg-indigo-50 rounded-lg p-4 space-y-3">
            <div className="flex justify-between items-center">
              <span className="text-sm font-medium text-indigo-800">Selected Invoices</span>
              <span className="text-lg font-bold text-indigo-700">{selectedInvoices.length}</span>
            </div>
            <div className="flex justify-between items-center">
              <span className="text-sm font-medium text-indigo-800">Total Revenue</span>
              <span className="text-lg font-bold text-indigo-700">
                {formatCurrency(getSelectedInvoicesDetails().reduce((sum, inv) => sum + (inv.gross_total || 0), 0))}
              </span>
            </div>
            
            {/* Invoice List Preview */}
            <div className="max-h-40 overflow-y-auto bg-white rounded p-2 text-sm">
              <table className="w-full">
                <thead>
                  <tr className="text-xs text-muted-foreground border-b">
                    <th className="text-left py-1">Invoice #</th>
                    <th className="text-left py-1">Current Store</th>
                    <th className="text-right py-1">Amount</th>
                  </tr>
                </thead>
                <tbody>
                  {getSelectedInvoicesDetails().slice(0, 10).map(inv => (
                    <tr key={inv.id} className="border-b border-gray-100">
                      <td className="py-1 font-mono">{inv.invoice_no}</td>
                      <td className="py-1 text-muted-foreground">{inv.showroom_name || 'Unassigned'}</td>
                      <td className="py-1 text-right">{formatCurrency(inv.gross_total)}</td>
                    </tr>
                  ))}
                  {getSelectedInvoicesDetails().length > 10 && (
                    <tr>
                      <td colSpan={3} className="py-1 text-center text-muted-foreground italic">
                        +{getSelectedInvoicesDetails().length - 10} more invoices...
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
          
          {/* Target Store Selection */}
          <div className="space-y-2">
            <label className="text-sm font-medium flex items-center gap-2">
              <Building2 className="h-4 w-4" />
              Transfer to Store
            </label>
            <select
              value={targetStore}
              onChange={(e) => setTargetStore(e.target.value)}
              className="w-full h-10 px-3 border rounded-md"
              data-testid="target-showroom-select"
            >
              <option value="">Select target showroom...</option>
              {showrooms.map(showroom => (
                <option key={showroom.id} value={showroom.id}>
                  {showroom.name}
                </option>
              ))}
            </select>
          </div>
          
          {/* Warning */}
          <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 text-sm text-amber-800">
            <strong>Note:</strong> This action will transfer all selected invoices and their associated revenue to the target showroom. 
            All transfers are logged in the audit trail.
          </div>
          
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowTransferDialog(false)}>
              Cancel
            </Button>
            <Button 
              onClick={handleBulkTransfer}
              disabled={transferring || !targetStore}
              className="bg-indigo-600 hover:bg-indigo-700"
              data-testid="confirm-transfer-btn"
            >
              {transferring ? 'Transferring...' : `Transfer ${selectedInvoices.length} Invoice${selectedInvoices.length > 1 ? 's' : ''}`}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Refund Dialog */}
      <Dialog open={showRefundDialog} onOpenChange={setShowRefundDialog}>
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="text-orange-600 flex items-center gap-2">
              <RotateCcw className="h-5 w-5" />
              Create Refund
            </DialogTitle>
            <DialogDescription>
              Invoice: <strong>{selectedInvoice?.invoice_no}</strong> | Customer: <strong>{selectedInvoice?.customer_name}</strong>
            </DialogDescription>
          </DialogHeader>
          
          <div className="space-y-4">
            {/* Items to Refund */}
            <div>
              <h4 className="font-medium mb-2">Select Items to Refund</h4>
              <div className="border rounded-lg divide-y max-h-60 overflow-y-auto">
                {refundItems.map((item, index) => (
                  <div key={index} className={`p-3 flex items-center gap-3 ${item.selected ? 'bg-orange-50' : ''}`}>
                    <button 
                      onClick={() => toggleRefundItem(index)}
                      className="flex-shrink-0"
                    >
                      {item.selected ? (
                        <CheckSquare className="h-5 w-5 text-orange-600" />
                      ) : (
                        <Square className="h-5 w-5 text-gray-400" />
                      )}
                    </button>
                    <div className="flex-1 min-w-0">
                      <p className="font-medium truncate">{cleanNonePatterns(toTitleCase(item.product_name || item.name))}</p>
                      <p className="text-sm text-muted-foreground">SKU: {item.sku || 'N/A'}</p>
                    </div>
                    <div className="text-right">
                      <p className="font-medium">£{(item.unit_price || item.price || 0).toFixed(2)}</p>
                      {item.selected && (
                        <div className="flex items-center gap-2 mt-1">
                          <span className="text-xs text-muted-foreground">Qty:</span>
                          <Input
                            type="number"
                            min="1"
                            max={item.quantity || 1}
                            value={item.refund_quantity}
                            onChange={(e) => updateRefundQuantity(index, e.target.value)}
                            className="w-16 h-7 text-sm"
                          />
                          <span className="text-xs text-muted-foreground">/ {item.quantity || 1}</span>
                        </div>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* Refund Reason */}
            <div>
              <label className="block text-sm font-medium mb-1">Reason for Refund</label>
              <Textarea
                value={refundReason}
                onChange={(e) => setRefundReason(e.target.value)}
                placeholder="Enter reason for refund..."
                rows={2}
              />
            </div>

            {/* Refund Method */}
            <div>
              <label className="block text-sm font-medium mb-1">Refund Method</label>
              <select
                value={refundMethod}
                onChange={(e) => setRefundMethod(e.target.value)}
                className="w-full px-3 py-2 border rounded-md"
              >
                <option value="original_payment">Original Payment Method</option>
                <option value="cash">Cash</option>
                <option value="bank_transfer">Bank Transfer</option>
                <option value="store_credit">Store Credit</option>
              </select>
            </div>

            {/* Refund Summary */}
            <div className="bg-orange-50 border border-orange-200 rounded-lg p-4">
              <div className="flex justify-between items-center">
                <div>
                  <p className="text-sm text-orange-700">Items Selected: {refundItems.filter(i => i.selected).length}</p>
                  <p className="text-sm text-orange-700">Total Quantity: {refundItems.filter(i => i.selected).reduce((sum, i) => sum + i.refund_quantity, 0)}</p>
                </div>
                <div className="text-right">
                  <p className="text-sm text-orange-700">Subtotal</p>
                  <p className="text-2xl font-bold text-orange-800">£{calculateRefundTotal().toFixed(2)}</p>
                  <p className="text-xs text-orange-600">+ VAT: £{(calculateRefundTotal() * 0.2).toFixed(2)}</p>
                </div>
              </div>
            </div>
          </div>

          <DialogFooter className="gap-2 sm:gap-0">
            <Button variant="outline" onClick={() => setShowRefundDialog(false)}>
              Cancel
            </Button>
            <Button 
              onClick={handleCreateRefund} 
              disabled={refunding || refundItems.filter(i => i.selected).length === 0}
              className="bg-orange-600 hover:bg-orange-700"
            >
              {refunding ? 'Creating...' : `Create Refund (£${(calculateRefundTotal() * 1.2).toFixed(2)})`}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Refund Details Dialog */}
      <Dialog open={showRefundDetailsDialog} onOpenChange={setShowRefundDetailsDialog}>
        <DialogContent className="sm:max-w-2xl max-h-[80vh] overflow-hidden flex flex-col">
          <DialogHeader>
            <DialogTitle className="text-red-600 flex items-center gap-2">
              <RotateCcw className="h-5 w-5" />
              Refunds for {selectedRefundDate}
            </DialogTitle>
            <DialogDescription>
              {selectedDateRefunds.length} refund{selectedDateRefunds.length !== 1 ? 's' : ''} totaling {formatCurrency(selectedDateRefunds.reduce((sum, r) => sum + (r.net_refund || r.gross_total || 0), 0))}
            </DialogDescription>
          </DialogHeader>
          
          <div className="flex-1 overflow-y-auto">
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-white">
                <tr className="bg-red-50">
                  <th className="text-left py-2 px-3 font-semibold">Refund #</th>
                  <th className="text-left py-2 px-3 font-semibold">Customer</th>
                  <th className="text-left py-2 px-3 font-semibold">Original Invoice</th>
                  <th className="text-left py-2 px-3 font-semibold">Items</th>
                  <th className="text-right py-2 px-3 font-semibold">Gross</th>
                  <th className="text-right py-2 px-3 font-semibold">Net Refund</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {selectedDateRefunds.map((refund, idx) => (
                  <tr key={idx} className="hover:bg-gray-50">
                    <td className="py-2 px-3 font-mono text-xs">{refund.refund_no}</td>
                    <td className="py-2 px-3">
                      <div>{refund.customer_name || '-'}</div>
                      <div className="text-xs text-muted-foreground">{refund.customer_phone || ''}</div>
                    </td>
                    <td className="py-2 px-3 font-mono text-xs">{refund.original_invoice || '-'}</td>
                    <td className="py-2 px-3">
                      {refund.line_items?.length > 0 ? (
                        <div className="space-y-1">
                          {refund.line_items.slice(0, 2).map((item, i) => (
                            <div key={i} className="text-xs">
                              {item.quantity || 1}x {cleanNonePatterns(item.product_name)?.substring(0, 25)}{item.product_name?.length > 25 ? '...' : ''}
                            </div>
                          ))}
                          {refund.line_items.length > 2 && (
                            <div className="text-xs text-muted-foreground">+{refund.line_items.length - 2} more</div>
                          )}
                        </div>
                      ) : (
                        <span className="text-xs text-muted-foreground">-</span>
                      )}
                    </td>
                    <td className="py-2 px-3 text-right">{formatCurrency(refund.gross_total || 0)}</td>
                    <td className="py-2 px-3 text-right font-medium text-red-600">{formatCurrency(refund.net_refund || refund.gross_total || 0)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot className="bg-red-100">
                <tr className="font-bold">
                  <td className="py-3 px-3" colSpan={4}>TOTAL</td>
                  <td className="py-3 px-3 text-right">
                    {formatCurrency(selectedDateRefunds.reduce((sum, r) => sum + (r.gross_total || 0), 0))}
                  </td>
                  <td className="py-3 px-3 text-right text-red-700">
                    {formatCurrency(selectedDateRefunds.reduce((sum, r) => sum + (r.net_refund || r.gross_total || 0), 0))}
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>
          
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowRefundDetailsDialog(false)}>
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* SMS Notification Dialog */}
      <Dialog open={showSmsDialog} onOpenChange={setShowSmsDialog}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <MessageSquare className="h-5 w-5 text-purple-600" />
              Send SMS Notification
            </DialogTitle>
            <DialogDescription>
              Notify {smsInvoice?.customer_name || 'customer'} about their order
            </DialogDescription>
          </DialogHeader>
          
          <div className="space-y-4 py-4">
            <div>
              <label className="text-sm font-medium text-gray-700">Sending to:</label>
              <p className="text-sm text-gray-900">{smsInvoice?.customer_phone || '-'}</p>
            </div>
            
            <div>
              <label className="text-sm font-medium text-gray-700">Order:</label>
              <p className="text-sm text-gray-900">{smsInvoice?.invoice_no || '-'}</p>
            </div>
            
            <div>
              <label className="text-sm font-medium text-gray-700 block mb-2">
                Message (editable):
              </label>
              <Textarea
                value={smsMessage}
                onChange={(e) => setSmsMessage(e.target.value)}
                rows={5}
                placeholder="Enter your message..."
                className="w-full"
              />
              <p className="text-xs text-gray-500 mt-1">
                {smsMessage.length}/160 characters (standard SMS limit)
              </p>
            </div>
            
            <div className="bg-amber-50 border border-amber-200 rounded-md p-3">
              <p className="text-xs text-amber-700">
                <strong>Templates:</strong> Click to use
              </p>
              <div className="flex flex-wrap gap-2 mt-2">
                <Button
                  variant="outline"
                  size="sm"
                  className="text-xs"
                  onClick={() => {
                    const showroom = showrooms.find(s => s.id === smsInvoice?.showroom_id);
                    setSmsMessage(`Hi ${smsInvoice?.customer_name || 'Customer'}, your order ${smsInvoice?.invoice_no} is ready for collection at ${showroom?.name || smsInvoice?.showroom_name || 'our store'}. Please bring your ID. Thank you! - Tile Station`);
                  }}
                >
                  Ready for Collection
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  className="text-xs"
                  onClick={() => {
                    const outstanding = smsInvoice?.amount_outstanding || 0;
                    setSmsMessage(`Hi ${smsInvoice?.customer_name || 'Customer'}, your order ${smsInvoice?.invoice_no} has an outstanding balance of £${outstanding.toFixed(2)}. Please contact us to arrange payment. - Tile Station`);
                  }}
                >
                  Payment Reminder
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  className="text-xs"
                  onClick={() => {
                    setSmsMessage(`Hi ${smsInvoice?.customer_name || 'Customer'}, your order ${smsInvoice?.invoice_no} has been dispatched! Thank you for choosing Tile Station.`);
                  }}
                >
                  Order Dispatched
                </Button>
              </div>
            </div>
          </div>
          
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowSmsDialog(false)}>
              Cancel
            </Button>
            <Button 
              onClick={handleSendSms} 
              disabled={sendingSms || !smsMessage.trim()}
              className="bg-purple-600 hover:bg-purple-700"
            >
              {sendingSms ? 'Sending...' : 'Send SMS'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
};

export default InvoiceHistory;
