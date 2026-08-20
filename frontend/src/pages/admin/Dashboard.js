import React, { useEffect, useState } from 'react';
import { Link, useNavigate, useLocation } from 'react-router-dom';
import { api } from '../../lib/api';
import { toast } from 'sonner';
import { Package, AlertTriangle, ShoppingCart, PoundSterling, TrendingUp, Building2, ArrowRight, Trophy, Star, Monitor, Zap, Target, AlertCircle, Settings, FileText, Calendar, X, RotateCcw } from 'lucide-react';
import { Card } from '../../components/ui/card';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, PieChart, Pie, Cell } from 'recharts';
import { useAuth } from '../../contexts/AuthContext';
import { SalesComparison } from '../../components/dashboard/SalesComparison';
import QuoteConversionWidget from '../../components/dashboard/QuoteConversionWidget';
import AbandonedCartRecoveryCard from '../../components/dashboard/AbandonedCartRecoveryCard';
import MarketingFunnelCard from '../../components/dashboard/MarketingFunnelCard';
import ReturnHeatmapCard from '../../components/dashboard/ReturnHeatmapCard';
import ConversionFunnelCard from './ConversionFunnelCard';
import ShopTabGapsCard from './components/ShopTabGapsCard';
import MarginGuardCard from './components/MarginGuardCard';
import DataHealthCard from './components/DataHealthCard';
import { normaliseImageUrl } from '../../utils/safeStr';
import AutoExportSchedulerCard from '../../components/AutoExportSchedulerCard';

const COLORS = ['#f97316', '#3b82f6', '#22c55e', '#a855f7', '#ef4444', '#06b6d4'];

// Motivational quotes categorized by context
const MOTIVATIONAL_QUOTES = {
  morning: [
    { text: "Rise and grind! Every tile you sell today builds someone's dream home.", author: "Start Strong" },
    { text: "Good morning! Today is full of opportunities waiting to be seized.", author: "Daily Motivation" },
    { text: "A new day, a fresh start. Let's make today count!", author: "Morning Boost" },
    { text: "Success is built one customer at a time. Let's get started!", author: "Team Spirit" },
  ],
  onTrack: [
    { text: "You're crushing it! Keep that momentum going!", author: "Performance" },
    { text: "Fantastic progress! Your hard work is paying off.", author: "Recognition" },
    { text: "On track and unstoppable! The target is within reach.", author: "Encouragement" },
    { text: "Great job! You're proving that consistency wins.", author: "Achievement" },
  ],
  behindTarget: [
    { text: "Every expert was once a beginner. Keep pushing forward!", author: "Persistence" },
    { text: "Challenges make us stronger. You've got this!", author: "Resilience" },
    { text: "The comeback is always stronger than the setback.", author: "Determination" },
    { text: "Don't watch the clock; do what it does. Keep going!", author: "Sam Levenson" },
  ],
  targetAchieved: [
    { text: "🎉 Target smashed! You're a sales superstar!", author: "Celebration" },
    { text: "🏆 Champion! You've exceeded expectations today!", author: "Victory" },
    { text: "⭐ Outstanding performance! Time to set new goals!", author: "Excellence" },
    { text: "🚀 Mission accomplished! Your dedication inspires us all!", author: "Success" },
  ],
  general: [
    { text: "Quality is remembered long after the price is forgotten.", author: "Gucci" },
    { text: "The best way to predict the future is to create it.", author: "Peter Drucker" },
    { text: "Success is not final, failure is not fatal: it is the courage to continue that counts.", author: "Winston Churchill" },
    { text: "Your attitude determines your direction.", author: "Positivity" },
    { text: "Great things never come from comfort zones.", author: "Growth Mindset" },
    { text: "Every sale starts with a conversation. Be genuine, be helpful.", author: "Sales Wisdom" },
  ]
};

// Get appropriate quote based on context
const getMotivationalQuote = (salesSummary) => {
  const hour = new Date().getHours();
  let category = 'general';
  
  if (hour >= 6 && hour < 10) {
    category = 'morning';
  } else if (salesSummary?.has_target) {
    if (salesSummary.today.progress >= 100) {
      category = 'targetAchieved';
    } else if (salesSummary.today.on_track) {
      category = 'onTrack';
    } else {
      category = 'behindTarget';
    }
  }
  
  const quotes = MOTIVATIONAL_QUOTES[category];
  const randomIndex = Math.floor(Math.random() * quotes.length);
  return { ...quotes[randomIndex], category };
};

// VERSION MARKER: v4.8.0 - Separate layouts for Store vs Super Admin dashboards (Mar 2026)
// This line confirms the latest code is deployed. Check browser console for this log.
console.log('[Dashboard] VERSION 4.8.0 DEPLOYED - Store dashboard old-style layout restored');

export const AdminDashboard = () => {
  const [stats, setStats] = useState(null);
  const [products, setProducts] = useState([]);
  const [orders, setOrders] = useState([]);
  const [analytics, setAnalytics] = useState(null);
  const [bestSellers, setBestSellers] = useState(null);
  const [showrooms, setStores] = useState([]);
  const [salesSummary, setSalesSummary] = useState(null);
  const [loading, setLoading] = useState(true);
  const [motivationalQuote, setMotivationalQuote] = useState(null);
  const [showMilestonePopup, setShowMilestonePopup] = useState(false);
  const [milestoneMessage, setMilestoneMessage] = useState('');
  const [selectedShowroom, setSelectedShowroom] = useState(''); // For super admin filter
  const [showTargetModal, setShowTargetModal] = useState(false);
  const [showBonusTargetModal, setShowBonusTargetModal] = useState(false);
  const [showCompanyTargetModal, setShowCompanyTargetModal] = useState(false);
  const [showReportModal, setShowReportModal] = useState(false);
  const [targetShowroomId, setTargetShowroomId] = useState(''); // Showroom selection for setting targets
  const [targetMonth, setTargetMonth] = useState(new Date().getMonth() + 1); // Month for setting targets
  const [targetYear, setTargetYear] = useState(new Date().getFullYear()); // Year for setting targets
  const [viewMonth, setViewMonth] = useState(new Date().getMonth() + 1); // Month for viewing targets
  const [viewYear, setViewYear] = useState(new Date().getFullYear()); // Year for viewing targets
  const [targetsHistory, setTargetsHistory] = useState([]); // Available months with targets
  const [reportData, setReportData] = useState(null);
  const [generatingReport, setGeneratingReport] = useState(false);
  
  // Historical Sales State (Manual Revenue Entry)
  const [showHistoricalModal, setShowHistoricalModal] = useState(false);
  const [historicalEntries, setHistoricalEntries] = useState([]);
  const [historicalShowroomId, setHistoricalShowroomId] = useState('');
  const [historicalMonth, setHistoricalMonth] = useState(new Date().getMonth()); // Previous month
  const [historicalYear, setHistoricalYear] = useState(new Date().getFullYear());
  const [historicalRevenue, setHistoricalRevenue] = useState('');
  const [historicalVisible, setHistoricalVisible] = useState(true);
  const [historicalNotes, setHistoricalNotes] = useState('');
  const [savingHistorical, setSavingHistorical] = useState(false);
  
  // Sales Target State (Monthly → auto-calculate Weekly & Daily)
  const [monthlyTarget, setMonthlyTarget] = useState(0);
  const [weeklyTarget, setWeeklyTarget] = useState(0);
  const [dailyTarget, setDailyTarget] = useState(0);
  
  // Bonus Target State (Monthly → auto-calculate Weekly & Daily)
  const [monthlyBonusTarget, setMonthlyBonusTarget] = useState(0);
  const [weeklyBonusTarget, setWeeklyBonusTarget] = useState(0);
  const [dailyBonusTarget, setDailyBonusTarget] = useState(0);
  
  // Company Target State (Monthly → auto-calculate Weekly & Daily) - Super Admin only
  const [monthlyCompanyTarget, setMonthlyCompanyTarget] = useState(0);
  const [weeklyCompanyTarget, setWeeklyCompanyTarget] = useState(0);
  const [dailyCompanyTarget, setDailyCompanyTarget] = useState(0);
  
  // All Showroom Targets State - for displaying individual store targets
  const [allShowroomTargets, setAllShowroomTargets] = useState(null);
  
  // Showroom Sales Breakdown (daily/weekly/monthly per store) - Super Admin only
  const [showroomsBreakdown, setShowroomsBreakdown] = useState(null);
  
  const { user } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  
  // Only super admin can see profit data AND set targets
  const isSuperAdmin = user?.role === 'super_admin';
  const isAdmin = user?.role === 'super_admin' || user?.role === 'admin' || user?.role === 'manager';

  // Initialize selectedShowroom based on user's assigned showroom (for staff users)
  // Also reload targets when user data becomes available
  useEffect(() => {
    if (user?.showroom_id && !isSuperAdmin) {
      console.log('[Dashboard] Setting selectedShowroom for staff user:', user.showroom_id);
      setSelectedShowroom(user.showroom_id);
      // Immediately load targets for this showroom
      loadTargetsFromDB(user.showroom_id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.showroom_id, isSuperAdmin]);

  // CRITICAL: Refetch data when navigating to this page
  // Using pathname as key to detect when we navigate TO this page from elsewhere
  useEffect(() => {
    console.log('[Dashboard] Page loaded/navigated - pathname:', location.pathname, 'key:', location.key);
    fetchData();
    loadTargetsFromDB();
    loadAllShowroomTargets(); // Load individual showroom targets
    loadShowroomsBreakdown(); // Load daily/weekly/monthly breakdown per showroom
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.pathname, location.key]);

  // Listen for dataSync events from other components (Invoice deletion, etc.)
  useEffect(() => {
    const handleDataSync = () => {
      console.log('[Dashboard] Data sync event received - refreshing');
      fetchData();
      loadTargetsFromDB();
    };
    
    // Custom event listener
    window.addEventListener('dataSync', handleDataSync);
    
    // Storage event listener (for cross-tab sync)
    const handleStorage = (e) => {
      if (e.key === 'dataSync') {
        console.log('[Dashboard] Storage dataSync detected - refreshing');
        fetchData();
        loadTargetsFromDB();
      }
    };
    window.addEventListener('storage', handleStorage);
    
    // Window focus listener
    const handleFocus = () => {
      console.log('[Dashboard] Window focused - refreshing');
      fetchData();
    };
    window.addEventListener('focus', handleFocus);
    
    return () => {
      window.removeEventListener('dataSync', handleDataSync);
      window.removeEventListener('storage', handleStorage);
      window.removeEventListener('focus', handleFocus);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Load saved targets from DATABASE - moved outside useEffect so it can be called from multiple places
  const loadTargetsFromDB = async (showroomIdParam = undefined, month = null, year = null) => {
    try {
      // Priority: explicit param > selectedShowroom state > user's assigned showroom (for staff)
      let filterShowroom = null;
      if (showroomIdParam !== undefined) {
        filterShowroom = showroomIdParam || null;
      } else if (selectedShowroom) {
        filterShowroom = selectedShowroom;
      } else if (user?.showroom_id && !isSuperAdmin) {
        // For staff users, use their assigned showroom
        filterShowroom = user.showroom_id;
      }
      
      // Use provided month/year or current viewing month
      const loadMonth = month || viewMonth;
      const loadYear = year || viewYear;
      
      console.log('[Dashboard] Loading targets for showroom:', filterShowroom || 'overall', '| month:', loadMonth, '/', loadYear);
      const res = await api.getAllTargetTypes(filterShowroom, loadMonth, loadYear);
      const targets = res.data;
      console.log('[Dashboard] Targets received:', targets);
      
      // Sales Target
      if (targets.sales) {
        setMonthlyTarget(targets.sales.monthly || 0);
        setWeeklyTarget(targets.sales.weekly || 0);
        setDailyTarget(targets.sales.daily || 0);
        // Also cache in localStorage (only for overall targets)
        if (!filterShowroom) {
          localStorage.setItem('monthlyTarget', (targets.sales.monthly || 0).toString());
        }
        console.log('[Dashboard] Sales target set:', targets.sales.monthly);
      } else {
        // Reset if no target found
        setMonthlyTarget(0);
        setWeeklyTarget(0);
        setDailyTarget(0);
      }
      
      // Bonus Target
      if (targets.bonus) {
        setMonthlyBonusTarget(targets.bonus.monthly || 0);
        setWeeklyBonusTarget(targets.bonus.weekly || 0);
        setDailyBonusTarget(targets.bonus.daily || 0);
        if (!filterShowroom) {
          localStorage.setItem('monthlyBonusTarget', (targets.bonus.monthly || 0).toString());
        }
        console.log('[Dashboard] Bonus target set:', targets.bonus.monthly);
      } else {
        setMonthlyBonusTarget(0);
        setWeeklyBonusTarget(0);
        setDailyBonusTarget(0);
      }
      
      // Company Target
      if (targets.company) {
        setMonthlyCompanyTarget(targets.company.monthly || 0);
        setWeeklyCompanyTarget(targets.company.weekly || 0);
        setDailyCompanyTarget(targets.company.daily || 0);
        if (!filterShowroom) {
          localStorage.setItem('monthlyCompanyTarget', (targets.company.monthly || 0).toString());
        }
        console.log('[Dashboard] Company target set:', targets.company.monthly);
      } else {
        setMonthlyCompanyTarget(0);
        setWeeklyCompanyTarget(0);
        setDailyCompanyTarget(0);
      }
    } catch (error) {
      console.log('[Dashboard] Failed to load targets from DB, using localStorage fallback', error);
      // Fallback to localStorage if API fails
      const savedMonthlyTarget = localStorage.getItem('monthlyTarget');
      if (savedMonthlyTarget) {
        const monthly = parseFloat(savedMonthlyTarget);
        setMonthlyTarget(monthly);
        setWeeklyTarget(Math.round(monthly / 4));
        setDailyTarget(Math.round(monthly / 30));
      }
      
      const savedMonthlyBonusTarget = localStorage.getItem('monthlyBonusTarget');
      if (savedMonthlyBonusTarget) {
        const monthlyBonus = parseFloat(savedMonthlyBonusTarget);
        setMonthlyBonusTarget(monthlyBonus);
        setWeeklyBonusTarget(Math.round(monthlyBonus / 4));
        setDailyBonusTarget(Math.round(monthlyBonus / 30));
      }
      
      const savedMonthlyCompanyTarget = localStorage.getItem('monthlyCompanyTarget');
      if (savedMonthlyCompanyTarget) {
        const monthlyCompany = parseFloat(savedMonthlyCompanyTarget);
        setMonthlyCompanyTarget(monthlyCompany);
        setWeeklyCompanyTarget(Math.round(monthlyCompany / 4));
        setDailyCompanyTarget(Math.round(monthlyCompany / 30));
      }
    }
  };
  
  // Load targets for ALL showrooms at once (for displaying individual store targets)
  const loadAllShowroomTargets = async (month = null, year = null) => {
    if (!isSuperAdmin) return; // Only super admin sees all showroom targets
    
    try {
      const loadMonth = month || viewMonth;
      const loadYear = year || viewYear;
      
      console.log('[Dashboard] Loading ALL showroom targets for month:', loadMonth, '/', loadYear);
      const res = await api.getAllShowroomTargets(loadMonth, loadYear);
      console.log('[Dashboard] All showroom targets received:', res.data);
      setAllShowroomTargets(res.data);
    } catch (error) {
      console.error('[Dashboard] Failed to load all showroom targets:', error);
    }
  };
  
  // Load showrooms breakdown (daily/weekly/monthly per store) - Super Admin only
  const loadShowroomsBreakdown = async () => {
    if (!isSuperAdmin) return;
    
    try {
      console.log('[Dashboard] Loading showrooms breakdown...');
      const res = await api.getShowroomsBreakdown();
      console.log('[Dashboard] Showrooms breakdown received:', res.data);
      setShowroomsBreakdown(res.data);
    } catch (error) {
      console.error('[Dashboard] Failed to load showrooms breakdown:', error);
    }
  };
  
  // Load available months with targets
  const loadTargetsHistory = async () => {
    try {
      const res = await api.getTargetsHistory();
      setTargetsHistory(res.data || []);
    } catch (error) {
      console.log('Failed to load targets history');
    }
  };
  
  // Generate PDF report
  const generateReport = async () => {
    setGeneratingReport(true);
    try {
      const res = await api.getTargetsReport(viewMonth, viewYear, selectedShowroom || null);
      setReportData(res.data);
      setShowReportModal(true);
    } catch (error) {
      toast.error('Failed to generate report');
    } finally {
      setGeneratingReport(false);
    }
  };
  
  // Download report as PDF
  const downloadReportPDF = () => {
    if (!reportData) return;
    
    // Create printable content
    const printContent = `
      <html>
        <head>
          <title>Targets Report - ${reportData.month_name} ${reportData.year}</title>
          <style>
            body { font-family: Arial, sans-serif; padding: 20px; }
            h1 { color: #1e3a5f; border-bottom: 2px solid #1e3a5f; padding-bottom: 10px; }
            table { width: 100%; border-collapse: collapse; margin-top: 20px; }
            th, td { border: 1px solid #ddd; padding: 12px; text-align: left; }
            th { background-color: #1e3a5f; color: white; }
            tr:nth-child(even) { background-color: #f9f9f9; }
            .achievement { font-weight: bold; }
            .over-target { color: green; }
            .under-target { color: red; }
            .footer { margin-top: 20px; font-size: 12px; color: #666; }
          </style>
        </head>
        <body>
          <h1>Tile Station - Targets Report</h1>
          <p><strong>Period:</strong> ${reportData.month_name} ${reportData.year}</p>
          <p><strong>Generated:</strong> ${new Date(reportData.generated_at).toLocaleString()}</p>
          
          <table>
            <thead>
              <tr>
                <th>Store</th>
                <th>Sales Target</th>
                <th>Bonus Target</th>
                <th>Actual Revenue</th>
                <th>Sales %</th>
                <th>Bonus %</th>
              </tr>
            </thead>
            <tbody>
              ${reportData.data.map(row => `
                <tr>
                  <td>${row.showroom}</td>
                  <td>£${row.sales_target.toLocaleString()}</td>
                  <td>£${row.bonus_target.toLocaleString()}</td>
                  <td>£${row.actual_revenue.toLocaleString()}</td>
                  <td class="achievement ${row.sales_achievement >= 100 ? 'over-target' : 'under-target'}">${row.sales_achievement}%</td>
                  <td class="achievement ${row.bonus_achievement >= 100 ? 'over-target' : 'under-target'}">${row.bonus_achievement}%</td>
                </tr>
              `).join('')}
            </tbody>
          </table>
          
          <div class="footer">
            <p>Report generated by Tile Station Inventory System</p>
          </div>
        </body>
      </html>
    `;
    
    // Open print window
    const printWindow = window.open('', '_blank');
    printWindow.document.write(printContent);
    printWindow.document.close();
    printWindow.print();
  };
  
  // Load targets on mount
  useEffect(() => {
    console.log('[Dashboard] Mount effect - loading targets');
    loadTargetsFromDB();
    loadTargetsHistory();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Reload targets when showroom filter changes
  useEffect(() => {
    console.log('[Dashboard] Showroom filter changed, reloading targets for:', selectedShowroom || 'All Stores');
    // Pass selectedShowroom directly to avoid stale state issues
    loadTargetsFromDB(selectedShowroom || null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedShowroom]);
  
  // Reload targets when viewing month changes
  useEffect(() => {
    const now = new Date();
    // Only reload if viewing a different month than current
    if (viewMonth !== now.getMonth() + 1 || viewYear !== now.getFullYear()) {
      console.log('[Dashboard] View month changed, reloading targets for:', viewMonth, '/', viewYear);
      loadTargetsFromDB(selectedShowroom || null, viewMonth, viewYear);
      loadAllShowroomTargets(viewMonth, viewYear); // Also reload individual showroom targets
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewMonth, viewYear]);

  // Calculate weekly and daily when monthly changes
  const handleMonthlyTargetChange = (value) => {
    const monthly = parseFloat(value) || 0;
    setMonthlyTarget(monthly);
    setWeeklyTarget(Math.round(monthly / 4));
    setDailyTarget(Math.round(monthly / 30));
  };

  const handleMonthlyBonusTargetChange = (value) => {
    const monthly = parseFloat(value) || 0;
    setMonthlyBonusTarget(monthly);
    setWeeklyBonusTarget(Math.round(monthly / 4));
    setDailyBonusTarget(Math.round(monthly / 30));
  };

  const handleMonthlyCompanyTargetChange = (value) => {
    const monthly = parseFloat(value) || 0;
    setMonthlyCompanyTarget(monthly);
    setWeeklyCompanyTarget(Math.round(monthly / 4));
    setDailyCompanyTarget(Math.round(monthly / 30));
  };

  // Save sales target to DATABASE (Super Admin only)
  const saveSalesTarget = async () => {
    if (!isSuperAdmin) {
      toast.error('Only Super Admin can set targets');
      return;
    }
    try {
      // Save to DATABASE
      const targetData = {
        showroom_id: targetShowroomId || null, // Use selected showroom or null for overall
        monthly_target: monthlyTarget,
        month: targetMonth,
        year: targetYear,
        target_type: 'sales'
      };
      await api.createSalesTarget(targetData);
      
      // Also cache in localStorage for instant UI updates (only for overall targets in current month)
      const now = new Date();
      if (!targetShowroomId && targetMonth === now.getMonth() + 1 && targetYear === now.getFullYear()) {
        localStorage.setItem('monthlyTarget', monthlyTarget.toString());
      }
      
      const showroomName = targetShowroomId 
        ? showrooms.find(s => s.id === targetShowroomId)?.name || 'Selected Store'
        : 'All Stores';
      const monthName = new Date(targetYear, targetMonth - 1).toLocaleString('default', { month: 'long' });
      toast.success(`Sales target saved for ${showroomName} (${monthName} ${targetYear})!`);
      
      // If saving for a specific showroom, also update the dashboard filter to show that showroom
      if (targetShowroomId) {
        setSelectedShowroom(targetShowroomId);
      }
      
      // Update view month to the saved month
      setViewMonth(targetMonth);
      setViewYear(targetYear);
      
      setShowTargetModal(false);
      setTargetShowroomId(''); // Reset modal selection
      fetchSalesSummary();
      loadTargetsHistory(); // Reload history to include new month
      loadAllShowroomTargets(targetMonth, targetYear); // Reload individual showroom targets
      // loadTargetsFromDB will be triggered by selectedShowroom/viewMonth change
    } catch (error) {
      toast.error('Failed to save target');
      console.error('Save target error:', error);
    }
  };

  // Save bonus target to DATABASE (Super Admin only)
  const saveBonusTarget = async () => {
    if (!isSuperAdmin) {
      toast.error('Only Super Admin can set targets');
      return;
    }
    try {
      // Save to DATABASE
      const targetData = {
        showroom_id: targetShowroomId || null, // Use selected showroom or null for overall
        monthly_target: monthlyBonusTarget,
        month: targetMonth,
        year: targetYear,
        target_type: 'bonus'
      };
      await api.createSalesTarget(targetData);
      
      // Also cache in localStorage (only for overall targets)
      if (!targetShowroomId) {
        localStorage.setItem('monthlyBonusTarget', monthlyBonusTarget.toString());
      }
      
      const showroomName = targetShowroomId 
        ? showrooms.find(s => s.id === targetShowroomId)?.name || 'Selected Store'
        : 'All Stores';
      const monthName = new Date(targetYear, targetMonth - 1).toLocaleString('default', { month: 'long' });
      toast.success(`Bonus target saved for ${showroomName} (${monthName} ${targetYear})!`);
      
      // If saving for a specific showroom, also update the dashboard filter to show that showroom
      if (targetShowroomId) {
        setSelectedShowroom(targetShowroomId);
      }
      
      // Update view month to the saved month
      setViewMonth(targetMonth);
      setViewYear(targetYear);
      
      setShowBonusTargetModal(false);
      setTargetShowroomId(''); // Reset modal selection
      loadTargetsHistory(); // Reload history to include new month
      loadAllShowroomTargets(targetMonth, targetYear); // Reload individual showroom targets
      // loadTargetsFromDB will be triggered by selectedShowroom/viewMonth change
    } catch (error) {
      toast.error('Failed to save bonus target');
      console.error('Save bonus target error:', error);
    }
  };

  // Save company target to DATABASE (Super Admin only)
  const saveCompanyTarget = async () => {
    if (!isSuperAdmin) {
      toast.error('Only Super Admin can set targets');
      return;
    }
    try {
      // Save to DATABASE
      const targetData = {
        showroom_id: null, // Overall target
        monthly_target: monthlyCompanyTarget,
        month: targetMonth,
        year: targetYear,
        target_type: 'company'
      };
      await api.createSalesTarget(targetData);
      
      // Also cache in localStorage (only for current month)
      const now = new Date();
      if (targetMonth === now.getMonth() + 1 && targetYear === now.getFullYear()) {
        localStorage.setItem('monthlyCompanyTarget', monthlyCompanyTarget.toString());
      }
      
      const monthName = new Date(targetYear, targetMonth - 1).toLocaleString('default', { month: 'long' });
      toast.success(`Company target saved for ${monthName} ${targetYear}!`);
      
      // Update view month to the saved month
      setViewMonth(targetMonth);
      setViewYear(targetYear);
      
      setShowCompanyTargetModal(false);
      loadTargetsHistory(); // Reload history
    } catch (error) {
      toast.error('Failed to save company target');
    }
  };

  // Fetch historical revenue entries
  const fetchHistoricalEntries = async () => {
    try {
      const res = await api.getManualRevenueEntries();
      setHistoricalEntries(res.data || []);
    } catch (error) {
      console.error('Failed to fetch historical entries:', error);
    }
  };

  // Save historical revenue entry
  const saveHistoricalEntry = async () => {
    if (!historicalShowroomId) {
      toast.error('Please select a showroom');
      return;
    }
    if (!historicalRevenue || parseFloat(historicalRevenue) < 0) {
      toast.error('Please enter a valid revenue amount');
      return;
    }

    setSavingHistorical(true);
    try {
      await api.createManualRevenueEntry({
        showroom_id: historicalShowroomId,
        month: historicalMonth,
        year: historicalYear,
        revenue: parseFloat(historicalRevenue),
        visible_to_showroom: historicalVisible,
        notes: historicalNotes || null
      });
      
      const monthName = new Date(historicalYear, historicalMonth - 1).toLocaleString('default', { month: 'long' });
      toast.success(`Historical revenue saved for ${monthName} ${historicalYear}!`);
      
      // Reset form
      setHistoricalRevenue('');
      setHistoricalNotes('');
      
      // Refresh entries
      fetchHistoricalEntries();
    } catch (error) {
      toast.error('Failed to save historical revenue');
      console.error(error);
    } finally {
      setSavingHistorical(false);
    }
  };

  // Toggle visibility of historical entry
  const toggleHistoricalVisibility = async (entryId) => {
    try {
      await api.toggleManualRevenueVisibility(entryId);
      toast.success('Visibility updated');
      fetchHistoricalEntries();
    } catch (error) {
      toast.error('Failed to update visibility');
    }
  };

  // Delete historical entry
  const deleteHistoricalEntry = async (entryId) => {
    if (!window.confirm('Are you sure you want to delete this entry?')) return;
    
    try {
      await api.deleteManualRevenueEntry(entryId);
      toast.success('Entry deleted');
      fetchHistoricalEntries();
    } catch (error) {
      toast.error('Failed to delete entry');
    }
  };

  // Fetch historical entries on mount (for super admin)
  useEffect(() => {
    if (isSuperAdmin) {
      fetchHistoricalEntries();
    }
  }, [isSuperAdmin]);

  // Fetch sales summary when showroom filter changes (for super admin)
  useEffect(() => {
    if (isSuperAdmin && showrooms.length > 0) {
      fetchSalesSummary();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedShowroom]);

  const fetchSalesSummary = async () => {
    try {
      const params = selectedShowroom ? { showroom_id: selectedShowroom } : {};
      const salesSummaryRes = await api.getStaffSalesSummary(params);
      setSalesSummary(salesSummaryRes.data);
      
      // Update motivational quote
      const quote = getMotivationalQuote(salesSummaryRes.data);
      setMotivationalQuote(quote);
    } catch (error) {
      console.error('Failed to fetch sales summary:', error);
    }
  };

  const fetchData = async () => {
    console.log('[Dashboard] fetchData called, selectedShowroom:', selectedShowroom);
    try {
      // Build params for showroom-filtered APIs
      const showroomParams = selectedShowroom ? { showroom_id: selectedShowroom } : {};
      
      const [statsRes, productsRes, ordersRes, analyticsRes, bestSellersRes, showroomsRes, salesSummaryRes] = await Promise.all([
        api.getDashboardStats().catch(e => { console.error('[Dashboard] getDashboardStats error:', e); return { data: { total_products: 0, low_stock_count: 0, total_orders: 0, pending_orders: 0, total_revenue: 0 } }; }),
        api.getProducts({ low_stock: true }).catch(e => { console.error('[Dashboard] getProducts error:', e); return { data: [] }; }),
        api.getOrders().catch(e => { console.error('[Dashboard] getOrders error:', e); return { data: [] }; }),
        api.getStoreAnalytics({ period: 'month' }).catch(() => ({ data: null })),
        api.getBestSellers({ period: 'month', limit: 5 }).catch(() => ({ data: null })),
        api.getStores().catch(() => ({ data: [] })),
        api.getStaffSalesSummary(showroomParams).catch(() => ({ data: null }))
      ]);
      
      // Log the actual revenue data received
      console.log('[Dashboard] Sales Summary received - Today revenue:', salesSummaryRes.data?.today?.revenue, 'Net:', salesSummaryRes.data?.today?.net_revenue);
      
      setStats(statsRes.data);
      setProducts(productsRes.data);
      setOrders(ordersRes.data?.slice(0, 5) || []);
      setAnalytics(analyticsRes.data);
      setBestSellers(bestSellersRes.data);
      setStores(showroomsRes.data || []);
      setSalesSummary(salesSummaryRes.data);
      
      // Record that we've fetched data
      sessionStorage.setItem('dashboardLastFetch', Date.now().toString());
      console.log('[Dashboard] Data fetched and state updated successfully');
      
      // Set motivational quote based on sales data
      const quote = getMotivationalQuote(salesSummaryRes.data);
      setMotivationalQuote(quote);
      
      // Check for milestone achievements and show popup
      if (salesSummaryRes.data?.has_target) {
        const progress = salesSummaryRes.data.today.progress;
        const lastProgress = sessionStorage.getItem('lastProgress');
        
        // Show milestone popup if just crossed a threshold
        if (progress >= 100 && (!lastProgress || parseFloat(lastProgress) < 100)) {
          setMilestoneMessage('🎉 Incredible! You\'ve hit your daily target!');
          setShowMilestonePopup(true);
        } else if (progress >= 75 && (!lastProgress || parseFloat(lastProgress) < 75) && progress < 100) {
          setMilestoneMessage('🔥 75% there! You\'re so close to the finish line!');
          setShowMilestonePopup(true);
        } else if (progress >= 50 && (!lastProgress || parseFloat(lastProgress) < 50) && progress < 75) {
          setMilestoneMessage('💪 Halfway there! Keep up the great work!');
          setShowMilestonePopup(true);
        }
        
        sessionStorage.setItem('lastProgress', progress.toString());
      }
    } catch (error) {
      toast.error('Failed to load dashboard data');
      console.error('[Dashboard] fetchData error:', error);
    } finally {
      setLoading(false);
    }
  };

  const getStoreSlug = (name) => name.toLowerCase().replace(/\s+/g, '-');
  
  const getStorePrefix = (showroomName) => {
    const prefixes = {
      'gravesend': 'GRV',
      'tonbridge': 'TNB',
      'chingford': 'CHG',
      'sydenham': 'SYD'
    };
    return prefixes[showroomName?.toLowerCase()] || showroomName?.substring(0, 3).toUpperCase() || 'INV';
  };

  const getStoreColor = (index) => {
    const colors = [
      { bg: 'bg-orange-500', light: 'bg-orange-50', border: 'border-orange-200', text: 'text-orange-700' },
      { bg: 'bg-blue-500', light: 'bg-blue-50', border: 'border-blue-200', text: 'text-blue-700' },
      { bg: 'bg-emerald-500', light: 'bg-emerald-50', border: 'border-emerald-200', text: 'text-emerald-700' },
      { bg: 'bg-purple-500', light: 'bg-purple-50', border: 'border-purple-200', text: 'text-purple-700' }
    ];
    return colors[index % colors.length];
  };

  if (loading) {
    return <div className="flex items-center justify-center h-64">Loading...</div>;
  }

  const formatCurrency = (value) => `£${value?.toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) || '0.00'}`;

  const statCards = [
    { label: 'Revenue', value: formatCurrency(analytics?.total_revenue), icon: PoundSterling, color: 'text-green-600' },
    { label: 'Invoices', value: analytics?.total_invoices || 0, icon: ShoppingCart, color: 'text-blue-600' },
    { label: 'Products Sold', value: stats?.total_products_sold || analytics?.total_products_sold || 0, icon: Package, color: 'text-purple-600' },
    { label: 'Avg per Invoice', value: formatCurrency((analytics?.total_revenue || 0) / Math.max(analytics?.total_invoices || 1, 1)), icon: TrendingUp, color: 'text-amber-600' },
  ];

  // Prepare showroom chart data
  const showroomBarData = analytics?.showroom_analytics?.map(s => ({
    name: s.showroom_name?.split(' ')[0] || 'Unknown',
    revenue: s.total_revenue,
    invoices: s.invoice_count
  })) || [];

  const pieData = analytics?.showroom_analytics?.map((s, i) => ({
    name: s.showroom_name,
    value: s.total_revenue,
    percentage: s.percentage_of_total,
    color: COLORS[i % COLORS.length]
  })) || [];

  return (
    <div className="space-y-8" data-testid="admin-dashboard">
      {/* Conversion funnel — compounds with the SEO + uptime dashboards */}
      <ConversionFunnelCard />
      {/* Products not assigned to any shop tab — spot gaps before they pile up */}
      <ShopTabGapsCard />

      <MarginGuardCard />
      {/* Catalogue hygiene — missing photos + one-click name cleanup */}
      <DataHealthCard />
      {/* Milestone Achievement Popup */}
      {showMilestonePopup && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 animate-in fade-in duration-300">
          <div className="bg-white rounded-2xl p-8 max-w-md mx-4 text-center shadow-2xl animate-in zoom-in duration-300">
            <div className="text-6xl mb-4">🏆</div>
            <h2 className="text-2xl font-bold mb-2">Milestone Achieved!</h2>
            <p className="text-lg text-gray-600 mb-6">{milestoneMessage}</p>
            <Button 
              onClick={() => setShowMilestonePopup(false)}
              className="bg-gradient-to-r from-amber-500 to-orange-500 hover:from-amber-600 hover:to-orange-600"
            >
              Keep Going! 💪
            </Button>
          </div>
        </div>
      )}

      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-4xl font-heading font-bold tracking-tightest mb-2">Dashboard</h1>
          <p className="text-muted-foreground">Overview</p>
        </div>
        <Button 
          variant="outline" 
          size="sm"
          onClick={async () => {
            console.log('[Dashboard] Manual refresh clicked');
            toast.info('Fetching fresh data...');
            try {
              const showroomParams = selectedShowroom ? { showroom_id: selectedShowroom } : {};
              const response = await api.getStaffSalesSummary(showroomParams);
              const data = response.data;
              console.log('[Dashboard] API Response:', data);
              
              // Show the actual values from API
              toast.success(`API returned: Today £${data?.today?.net_revenue || 0}, Week £${data?.week?.net_revenue || 0}, Month £${data?.month?.net_revenue || 0}`);
              
              // Update state
              setSalesSummary(data);
              
              // Also fetch other data
              const statsRes = await api.getDashboardStats();
              setStats(statsRes.data);
              
              loadTargetsFromDB();
            } catch (error) {
              console.error('[Dashboard] Refresh error:', error);
              toast.error('Failed to refresh: ' + error.message);
            }
          }}
          className="flex items-center gap-2"
          data-testid="refresh-dashboard-btn"
        >
          <RotateCcw className="h-4 w-4" />
          Refresh
        </Button>
      </div>

      {/* Motivational Quote Card */}
      {motivationalQuote && (
        <Card className={`p-4 border-l-4 ${
          motivationalQuote.category === 'targetAchieved' ? 'border-l-green-500 bg-green-50' :
          motivationalQuote.category === 'onTrack' ? 'border-l-blue-500 bg-blue-50' :
          motivationalQuote.category === 'behindTarget' ? 'border-l-amber-500 bg-amber-50' :
          motivationalQuote.category === 'morning' ? 'border-l-purple-500 bg-purple-50' :
          'border-l-gray-400 bg-gray-50'
        }`} data-testid="motivational-quote">
          <div className="flex items-start gap-3">
            <div className={`text-2xl ${
              motivationalQuote.category === 'targetAchieved' ? '' :
              motivationalQuote.category === 'onTrack' ? '' :
              motivationalQuote.category === 'behindTarget' ? '' :
              motivationalQuote.category === 'morning' ? '' : ''
            }`}>
              {motivationalQuote.category === 'targetAchieved' ? '🏆' :
               motivationalQuote.category === 'onTrack' ? '🚀' :
               motivationalQuote.category === 'behindTarget' ? '💪' :
               motivationalQuote.category === 'morning' ? '☀️' : '💡'}
            </div>
            <div className="flex-1">
              <p className="text-sm md:text-base font-medium text-gray-800 italic">
                &ldquo;{motivationalQuote.text}&rdquo;
              </p>
              <p className="text-xs text-gray-500 mt-1">— {motivationalQuote.author}</p>
            </div>
            <Button 
              variant="ghost" 
              size="sm"
              className="text-xs"
              onClick={() => setMotivationalQuote(getMotivationalQuote(salesSummary))}
            >
              New Quote
            </Button>
          </div>
        </Card>
      )}

      {/* Prominent Daily Target Progress Bar - Show for Super Admin even without targets set */}
      {salesSummary && (salesSummary.has_target || isSuperAdmin) && (
        <Card className="p-4 border-2 border-primary/20 bg-gradient-to-r from-primary/5 to-transparent" data-testid="daily-target-bar">
          {/* Warning alert if below 50% */}
          {salesSummary.has_target && salesSummary.today.progress < 50 && (
            <div className="flex items-center gap-2 mb-3 p-2 bg-amber-50 border border-amber-200 rounded-lg text-sm text-amber-700">
              <AlertCircle className="h-4 w-4" />
              <span>Today&apos;s revenue is below 50% of daily target</span>
            </div>
          )}
          
          {/* Month Selector and Report Button (Super Admin Only) */}
          {isSuperAdmin && (
            <div className="flex flex-wrap items-center gap-4 mb-4 p-3 bg-gray-50 rounded-lg">
              <div className="flex items-center gap-2">
                <Calendar className="h-4 w-4 text-gray-600" />
                <span className="text-sm font-medium text-gray-700">View Month:</span>
                <select
                  value={`${viewYear}-${viewMonth}`}
                  onChange={(e) => {
                    const [y, m] = e.target.value.split('-');
                    setViewYear(parseInt(y));
                    setViewMonth(parseInt(m));
                  }}
                  className="px-2 py-1 border border-gray-300 rounded text-sm"
                  data-testid="view-month-select"
                >
                  {/* Current month and previous 11 months */}
                  {Array.from({ length: 12 }, (_, i) => {
                    const d = new Date();
                    d.setMonth(d.getMonth() - i);
                    const m = d.getMonth() + 1;
                    const y = d.getFullYear();
                    const monthName = d.toLocaleString('default', { month: 'long' });
                    return (
                      <option key={`${y}-${m}`} value={`${y}-${m}`}>
                        {monthName} {y}
                      </option>
                    );
                  })}
                </select>
              </div>
              
              <Button
                variant="outline"
                size="sm"
                onClick={generateReport}
                disabled={generatingReport}
                className="bg-white hover:bg-gray-100"
                data-testid="generate-report-btn"
              >
                <FileText className="h-4 w-4 mr-1" />
                {generatingReport ? 'Generating...' : 'Generate Report'}
              </Button>
            </div>
          )}
          
          {/* STORE TARGETS - Different layouts for Super Admin vs Store Users */}
          
          {/* OLD-STYLE LAYOUT FOR STORE USERS (Non-Super Admin) */}
          {!isSuperAdmin && (
            <>
              {/* Sales Target Card */}
              <Card className="p-5 mb-4 bg-gradient-to-r from-orange-50 to-amber-50 border-orange-200">
                <div className="flex items-center gap-2 mb-4">
                  <Target className="h-5 w-5 text-orange-500" />
                  <h3 className="font-semibold text-orange-700">Sales Target</h3>
                </div>
                
                <div className="grid grid-cols-3 gap-4">
                  {/* Daily */}
                  <div className="border-r border-orange-100 pr-4">
                    <div className="flex justify-between items-start mb-1">
                      <span className="text-sm text-gray-600">Daily</span>
                      <span className="text-xs text-gray-400">Target: £{dailyTarget.toLocaleString()}</span>
                    </div>
                    <div className="text-xl font-bold text-gray-900 mb-2">
                      £{(salesSummary?.today?.net_revenue ?? 0).toLocaleString()}
                    </div>
                    <div className="h-3 bg-orange-100 rounded-full overflow-hidden mb-1">
                      <div 
                        className={`h-full transition-all duration-500 ${
                          dailyTarget > 0 && ((salesSummary?.today?.net_revenue ?? 0) / dailyTarget * 100) >= 100 ? 'bg-green-500' : 'bg-orange-400'
                        }`}
                        style={{ width: `${Math.min(dailyTarget > 0 ? ((salesSummary?.today?.net_revenue ?? 0) / dailyTarget * 100) : 0, 100)}%` }}
                      />
                    </div>
                    <div className="text-center text-xs text-gray-500">
                      {dailyTarget > 0 ? `${((salesSummary?.today?.net_revenue ?? 0) / dailyTarget * 100).toFixed(1)}%` : '-'}
                    </div>
                  </div>
                  
                  {/* Weekly */}
                  <div className="border-r border-orange-100 pr-4">
                    <div className="flex justify-between items-start mb-1">
                      <span className="text-sm text-gray-600">Weekly</span>
                      <span className="text-xs text-gray-400">Target: £{weeklyTarget.toLocaleString()}</span>
                    </div>
                    <div className="text-xl font-bold text-gray-900 mb-2">
                      £{(salesSummary?.week?.net_revenue ?? 0).toLocaleString()}
                    </div>
                    <div className="h-3 bg-orange-100 rounded-full overflow-hidden mb-1">
                      <div 
                        className={`h-full transition-all duration-500 ${
                          weeklyTarget > 0 && ((salesSummary?.week?.net_revenue ?? 0) / weeklyTarget * 100) >= 100 ? 'bg-green-500' : 'bg-amber-400'
                        }`}
                        style={{ width: `${Math.min(weeklyTarget > 0 ? ((salesSummary?.week?.net_revenue ?? 0) / weeklyTarget * 100) : 0, 100)}%` }}
                      />
                    </div>
                    <div className="text-center text-xs text-gray-500">
                      {weeklyTarget > 0 ? `${((salesSummary?.week?.net_revenue ?? 0) / weeklyTarget * 100).toFixed(1)}%` : '-'}
                    </div>
                  </div>
                  
                  {/* Monthly */}
                  <div>
                    <div className="flex justify-between items-start mb-1">
                      <span className="text-sm text-gray-600">Monthly</span>
                      <span className="text-xs text-gray-400">Target: £{monthlyTarget.toLocaleString()}</span>
                    </div>
                    <div className="text-xl font-bold text-gray-900 mb-2">
                      £{(salesSummary?.month?.net_revenue ?? 0).toLocaleString()}
                    </div>
                    <div className="h-3 bg-orange-100 rounded-full overflow-hidden mb-1">
                      <div 
                        className={`h-full transition-all duration-500 ${
                          monthlyTarget > 0 && ((salesSummary?.month?.net_revenue ?? 0) / monthlyTarget * 100) >= 100 ? 'bg-green-500' : 'bg-red-400'
                        }`}
                        style={{ width: `${Math.min(monthlyTarget > 0 ? ((salesSummary?.month?.net_revenue ?? 0) / monthlyTarget * 100) : 0, 100)}%` }}
                      />
                    </div>
                    <div className="text-center text-xs text-gray-500">
                      {monthlyTarget > 0 ? `${((salesSummary?.month?.net_revenue ?? 0) / monthlyTarget * 100).toFixed(1)}%` : '-'}
                    </div>
                  </div>
                </div>
              </Card>
              
              {/* Bonus Target Card */}
              <Card className="p-5 mb-4 bg-gradient-to-r from-purple-50 to-pink-50 border-purple-200">
                <div className="flex items-center gap-2 mb-4">
                  <Trophy className="h-5 w-5 text-purple-500" />
                  <h3 className="font-semibold text-purple-700">Bonus Target</h3>
                </div>
                
                <div className="grid grid-cols-3 gap-4">
                  {/* Daily */}
                  <div className="border-r border-purple-100 pr-4">
                    <div className="flex justify-between items-start mb-1">
                      <span className="text-sm text-gray-600">Daily</span>
                      <span className="text-xs text-gray-400">Target: £{dailyBonusTarget.toLocaleString()}</span>
                    </div>
                    <div className="text-xl font-bold text-gray-900 mb-2">
                      £{(salesSummary?.today?.net_revenue ?? 0).toLocaleString()}
                    </div>
                    <div className="h-3 bg-purple-100 rounded-full overflow-hidden mb-1">
                      <div 
                        className={`h-full transition-all duration-500 ${
                          dailyBonusTarget > 0 && ((salesSummary?.today?.net_revenue ?? 0) / dailyBonusTarget * 100) >= 100 ? 'bg-green-500' : 'bg-purple-400'
                        }`}
                        style={{ width: `${Math.min(dailyBonusTarget > 0 ? ((salesSummary?.today?.net_revenue ?? 0) / dailyBonusTarget * 100) : 0, 100)}%` }}
                      />
                    </div>
                    <div className="text-center text-xs text-gray-500">
                      {dailyBonusTarget > 0 ? `${((salesSummary?.today?.net_revenue ?? 0) / dailyBonusTarget * 100).toFixed(1)}%` : '-'}
                    </div>
                  </div>
                  
                  {/* Weekly */}
                  <div className="border-r border-purple-100 pr-4">
                    <div className="flex justify-between items-start mb-1">
                      <span className="text-sm text-gray-600">Weekly</span>
                      <span className="text-xs text-gray-400">Target: £{weeklyBonusTarget.toLocaleString()}</span>
                    </div>
                    <div className="text-xl font-bold text-gray-900 mb-2">
                      £{(salesSummary?.week?.net_revenue ?? 0).toLocaleString()}
                    </div>
                    <div className="h-3 bg-purple-100 rounded-full overflow-hidden mb-1">
                      <div 
                        className={`h-full transition-all duration-500 ${
                          weeklyBonusTarget > 0 && ((salesSummary?.week?.net_revenue ?? 0) / weeklyBonusTarget * 100) >= 100 ? 'bg-green-500' : 'bg-purple-400'
                        }`}
                        style={{ width: `${Math.min(weeklyBonusTarget > 0 ? ((salesSummary?.week?.net_revenue ?? 0) / weeklyBonusTarget * 100) : 0, 100)}%` }}
                      />
                    </div>
                    <div className="text-center text-xs text-gray-500">
                      {weeklyBonusTarget > 0 ? `${((salesSummary?.week?.net_revenue ?? 0) / weeklyBonusTarget * 100).toFixed(1)}%` : '-'}
                    </div>
                  </div>
                  
                  {/* Monthly */}
                  <div>
                    <div className="flex justify-between items-start mb-1">
                      <span className="text-sm text-gray-600">Monthly</span>
                      <span className="text-xs text-gray-400">Target: £{monthlyBonusTarget.toLocaleString()}</span>
                    </div>
                    <div className="text-xl font-bold text-gray-900 mb-2">
                      £{(salesSummary?.month?.net_revenue ?? 0).toLocaleString()}
                    </div>
                    <div className="h-3 bg-purple-100 rounded-full overflow-hidden mb-1">
                      <div 
                        className={`h-full transition-all duration-500 ${
                          monthlyBonusTarget > 0 && ((salesSummary?.month?.net_revenue ?? 0) / monthlyBonusTarget * 100) >= 100 ? 'bg-green-500' : 'bg-purple-400'
                        }`}
                        style={{ width: `${Math.min(monthlyBonusTarget > 0 ? ((salesSummary?.month?.net_revenue ?? 0) / monthlyBonusTarget * 100) : 0, 100)}%` }}
                      />
                    </div>
                    <div className="text-center text-xs text-gray-500">
                      {monthlyBonusTarget > 0 ? `${((salesSummary?.month?.net_revenue ?? 0) / monthlyBonusTarget * 100).toFixed(1)}%` : '-'}
                    </div>
                  </div>
                </div>
              </Card>
            </>
          )}
          
          {/* SUPER ADMIN UNIFIED STORE TARGETS */}
          {isSuperAdmin && (
          <Card className="p-6 mb-4 bg-gradient-to-r from-slate-50 to-gray-50 border-gray-200">
            <div className="flex items-center justify-between mb-6">
              <div className="flex items-center gap-3">
                <Target className="h-6 w-6 text-gray-700" />
                <h3 className="text-lg font-semibold text-gray-800">Store Targets</h3>
                <span className="text-sm text-gray-500 bg-gray-100 px-3 py-1 rounded">
                  {new Date(viewYear, viewMonth - 1).toLocaleString('default', { month: 'long' })} {viewYear}
                </span>
              </div>
              <div className="flex gap-2">
                <Button 
                  variant="outline" 
                  size="sm" 
                  onClick={() => setShowTargetModal(true)}
                  className="bg-white hover:bg-blue-50 border-blue-200 text-blue-600"
                  data-testid="set-sales-target-btn"
                >
                  <Settings className="h-4 w-4 mr-1" />
                  Set Sales
                </Button>
                <Button 
                  variant="outline" 
                  size="sm" 
                  onClick={() => setShowBonusTargetModal(true)}
                  className="bg-white hover:bg-purple-50 border-purple-200 text-purple-600"
                  data-testid="set-bonus-target-btn"
                >
                  <Trophy className="h-4 w-4 mr-1" />
                  Set Bonus
                </Button>
              </div>
            </div>
            
            {/* Current Period Summary - Daily, Weekly, Monthly - BIGGER CARDS */}
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
              {/* Daily */}
              <div className="p-5 bg-white rounded-xl border border-gray-200 shadow-sm">
                <div className="text-base font-semibold text-gray-700 mb-3">Daily</div>
                <div className="text-2xl font-bold text-gray-900 mb-2">
                  £{(salesSummary?.today?.net_revenue ?? 0).toLocaleString()}
                </div>
                <div className="flex gap-3 text-sm mb-3">
                  <span className="text-blue-600">Sales: £{dailyTarget.toLocaleString()}</span>
                  <span className="text-purple-600">Bonus: £{dailyBonusTarget.toLocaleString()}</span>
                </div>
                <div className="space-y-2">
                  <div className="flex items-center gap-3">
                    <span className="text-sm text-blue-600 w-12">Sales</span>
                    <div className="flex-1 h-3 bg-blue-100 rounded-full overflow-hidden">
                      <div 
                        className={`h-full transition-all duration-500 ${
                          dailyTarget > 0 && ((salesSummary?.today?.net_revenue ?? 0) / dailyTarget * 100) >= 100 ? 'bg-green-500' : 'bg-blue-500'
                        }`}
                        style={{ width: `${Math.min(dailyTarget > 0 ? ((salesSummary?.today?.net_revenue ?? 0) / dailyTarget * 100) : 0, 100)}%` }}
                      />
                    </div>
                    <span className="text-sm font-medium text-gray-600 w-12">{dailyTarget > 0 ? `${Math.round((salesSummary?.today?.net_revenue ?? 0) / dailyTarget * 100)}%` : '0%'}</span>
                  </div>
                  <div className="flex items-center gap-3">
                    <span className="text-sm text-purple-600 w-12">Bonus</span>
                    <div className="flex-1 h-3 bg-purple-100 rounded-full overflow-hidden">
                      <div 
                        className={`h-full transition-all duration-500 ${
                          dailyBonusTarget > 0 && ((salesSummary?.today?.net_revenue ?? 0) / dailyBonusTarget * 100) >= 100 ? 'bg-green-500' : 'bg-purple-500'
                        }`}
                        style={{ width: `${Math.min(dailyBonusTarget > 0 ? ((salesSummary?.today?.net_revenue ?? 0) / dailyBonusTarget * 100) : 0, 100)}%` }}
                      />
                    </div>
                    <span className="text-sm font-medium text-gray-600 w-12">{dailyBonusTarget > 0 ? `${Math.round((salesSummary?.today?.net_revenue ?? 0) / dailyBonusTarget * 100)}%` : '0%'}</span>
                  </div>
                </div>
              </div>
              
              {/* Weekly */}
              <div className="p-5 bg-white rounded-xl border border-gray-200 shadow-sm">
                <div className="text-base font-semibold text-gray-700 mb-3">Weekly</div>
                <div className="text-2xl font-bold text-gray-900 mb-2">
                  £{(salesSummary?.week?.net_revenue ?? 0).toLocaleString()}
                </div>
                <div className="flex gap-3 text-sm mb-3">
                  <span className="text-blue-600">Sales: £{weeklyTarget.toLocaleString()}</span>
                  <span className="text-purple-600">Bonus: £{weeklyBonusTarget.toLocaleString()}</span>
                </div>
                <div className="space-y-2">
                  <div className="flex items-center gap-3">
                    <span className="text-sm text-blue-600 w-12">Sales</span>
                    <div className="flex-1 h-3 bg-blue-100 rounded-full overflow-hidden">
                      <div 
                        className={`h-full transition-all duration-500 ${
                          weeklyTarget > 0 && ((salesSummary?.week?.net_revenue ?? 0) / weeklyTarget * 100) >= 100 ? 'bg-green-500' : 'bg-blue-500'
                        }`}
                        style={{ width: `${Math.min(weeklyTarget > 0 ? ((salesSummary?.week?.net_revenue ?? 0) / weeklyTarget * 100) : 0, 100)}%` }}
                      />
                    </div>
                    <span className="text-sm font-medium text-gray-600 w-12">{weeklyTarget > 0 ? `${Math.round((salesSummary?.week?.net_revenue ?? 0) / weeklyTarget * 100)}%` : '0%'}</span>
                  </div>
                  <div className="flex items-center gap-3">
                    <span className="text-sm text-purple-600 w-12">Bonus</span>
                    <div className="flex-1 h-3 bg-purple-100 rounded-full overflow-hidden">
                      <div 
                        className={`h-full transition-all duration-500 ${
                          weeklyBonusTarget > 0 && ((salesSummary?.week?.net_revenue ?? 0) / weeklyBonusTarget * 100) >= 100 ? 'bg-green-500' : 'bg-purple-500'
                        }`}
                        style={{ width: `${Math.min(weeklyBonusTarget > 0 ? ((salesSummary?.week?.net_revenue ?? 0) / weeklyBonusTarget * 100) : 0, 100)}%` }}
                      />
                    </div>
                    <span className="text-sm font-medium text-gray-600 w-12">{weeklyBonusTarget > 0 ? `${Math.round((salesSummary?.week?.net_revenue ?? 0) / weeklyBonusTarget * 100)}%` : '0%'}</span>
                  </div>
                </div>
              </div>
              
              {/* Monthly */}
              <div className="p-5 bg-white rounded-xl border border-gray-200 shadow-sm">
                <div className="text-base font-semibold text-gray-700 mb-3">Monthly</div>
                <div className="text-2xl font-bold text-gray-900 mb-2">
                  £{(salesSummary?.month?.net_revenue ?? 0).toLocaleString()}
                </div>
                <div className="flex gap-3 text-sm mb-3">
                  <span className="text-blue-600">Sales: £{monthlyTarget.toLocaleString()}</span>
                  <span className="text-purple-600">Bonus: £{monthlyBonusTarget.toLocaleString()}</span>
                </div>
                <div className="space-y-2">
                  <div className="flex items-center gap-3">
                    <span className="text-sm text-blue-600 w-12">Sales</span>
                    <div className="flex-1 h-3 bg-blue-100 rounded-full overflow-hidden">
                      <div 
                        className={`h-full transition-all duration-500 ${
                          monthlyTarget > 0 && ((salesSummary?.month?.net_revenue ?? 0) / monthlyTarget * 100) >= 100 ? 'bg-green-500' : 'bg-blue-500'
                        }`}
                        style={{ width: `${Math.min(monthlyTarget > 0 ? ((salesSummary?.month?.net_revenue ?? 0) / monthlyTarget * 100) : 0, 100)}%` }}
                      />
                    </div>
                    <span className="text-sm font-medium text-gray-600 w-12">{monthlyTarget > 0 ? `${Math.round((salesSummary?.month?.net_revenue ?? 0) / monthlyTarget * 100)}%` : '0%'}</span>
                  </div>
                  <div className="flex items-center gap-3">
                    <span className="text-sm text-purple-600 w-12">Bonus</span>
                    <div className="flex-1 h-3 bg-purple-100 rounded-full overflow-hidden">
                      <div 
                        className={`h-full transition-all duration-500 ${
                          monthlyBonusTarget > 0 && ((salesSummary?.month?.net_revenue ?? 0) / monthlyBonusTarget * 100) >= 100 ? 'bg-green-500' : 'bg-purple-500'
                        }`}
                        style={{ width: `${Math.min(monthlyBonusTarget > 0 ? ((salesSummary?.month?.net_revenue ?? 0) / monthlyBonusTarget * 100) : 0, 100)}%` }}
                      />
                    </div>
                    <span className="text-sm font-medium text-gray-600 w-12">{monthlyBonusTarget > 0 ? `${Math.round((salesSummary?.month?.net_revenue ?? 0) / monthlyBonusTarget * 100)}%` : '0%'}</span>
                  </div>
                </div>
              </div>
            </div>
            
            {/* STORE SALES BREAKDOWN - Super Admin Only - Keep compact grid view */}
            {isSuperAdmin && showroomsBreakdown?.showrooms && showroomsBreakdown.showrooms.length > 0 && (
              <div className="border-t border-gray-200 pt-5 mb-5">
                <div className="flex items-center justify-between mb-4">
                  <div className="flex items-center gap-2">
                    <Building2 className="h-5 w-5 text-blue-600" />
                    <h3 className="text-base font-semibold text-gray-700">Store Performance</h3>
                  </div>
                  <span className="text-xs text-gray-500 bg-gray-100 px-2 py-1 rounded">
                    {showroomsBreakdown.period_info?.month_name}
                  </span>
                </div>
                
                {/* Compact grid for Super Admin */}
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                  {showroomsBreakdown.showrooms.map((store, idx) => {
                    const dailyTarget = store.targets?.sales?.daily || 0;
                    const weeklyTarget = store.targets?.sales?.weekly || 0;
                    const monthlyTargetStore = store.targets?.sales?.monthly || 0;
                    const dailyProgress = dailyTarget > 0 ? (store.today.revenue / dailyTarget * 100) : 0;
                    
                    return (
                      <div key={idx} className="p-5 bg-white rounded-xl border border-gray-100 shadow-sm hover:shadow-md transition-shadow">
                        {/* Store Name */}
                        <div className="flex items-center justify-between mb-4">
                          <span className="font-bold text-gray-800 text-lg">{store.showroom_name}</span>
                          <span className={`text-xs px-2 py-1 rounded-full ${
                            dailyProgress >= 100 ? 'bg-green-100 text-green-700' :
                            dailyProgress >= 50 ? 'bg-amber-100 text-amber-700' :
                            'bg-gray-100 text-gray-500'
                          }`}>
                            {store.today.invoices} today
                          </span>
                        </div>
                        
                        {/* DAILY - BOLD and prominent */}
                        <div className="mb-4">
                          <div className="text-sm text-gray-500 mb-1">Today's Sales</div>
                          <div className="text-3xl font-bold text-gray-900">
                            £{store.today.revenue.toLocaleString()}
                          </div>
                          {dailyTarget > 0 && (
                            <div className="mt-2">
                              <div className="flex justify-between text-xs text-gray-500 mb-1">
                                <span>Target: £{dailyTarget.toLocaleString()}</span>
                                <span>{Math.round(dailyProgress)}%</span>
                              </div>
                              <div className="h-2 bg-gray-100 rounded-full overflow-hidden">
                                <div 
                                  className={`h-full transition-all duration-500 ${
                                    dailyProgress >= 100 ? 'bg-green-500' : 
                                    dailyProgress >= 50 ? 'bg-amber-500' : 'bg-red-400'
                                  }`}
                                  style={{ width: `${Math.min(dailyProgress, 100)}%` }}
                                />
                              </div>
                            </div>
                          )}
                        </div>
                        
                        {/* Weekly & Monthly - Smaller tabs */}
                        <div className="grid grid-cols-2 gap-3 pt-3 border-t border-gray-100">
                          {/* Weekly */}
                          <div className="p-2 bg-gray-50 rounded-lg">
                            <div className="text-xs text-gray-500">This Week</div>
                            <div className="text-lg font-semibold text-gray-800">
                              £{store.week.revenue.toLocaleString()}
                            </div>
                            <div className="text-xs text-gray-400">
                              {store.week.invoices} inv • {weeklyTarget > 0 ? `${Math.round(store.week.revenue / weeklyTarget * 100)}%` : '-'}
                            </div>
                          </div>
                          
                          {/* Monthly */}
                          <div className="p-2 bg-gray-50 rounded-lg">
                            <div className="text-xs text-gray-500">This Month</div>
                            <div className="text-lg font-semibold text-gray-800">
                              £{store.month.revenue.toLocaleString()}
                            </div>
                            <div className="text-xs text-gray-400">
                              {store.month.invoices} inv • {monthlyTargetStore > 0 ? `${Math.round(store.month.revenue / monthlyTargetStore * 100)}%` : '-'}
                            </div>
                          </div>
                        </div>
                        
                        {/* Targets Row */}
                        <div className="mt-3 pt-3 border-t border-gray-100 flex justify-between text-xs text-gray-500">
                          <span>Sales Target: <strong className="text-blue-600">£{monthlyTargetStore.toLocaleString()}</strong></span>
                          <span>Bonus: <strong className="text-purple-600">£{(store.targets?.bonus?.monthly || 0).toLocaleString()}</strong></span>
                        </div>
                      </div>
                    );
                  })}
                </div>
                
                {/* Overall Company Target */}
                {allShowroomTargets?.overall && (allShowroomTargets.overall.sales || allShowroomTargets.overall.bonus) && (
                  <div className="mt-4 p-4 bg-gradient-to-r from-gray-100 to-gray-50 rounded-xl">
                    <div className="flex items-center justify-between">
                      <span className="font-semibold text-gray-700">Overall Company Targets</span>
                      <div className="flex gap-6 text-sm">
                        {allShowroomTargets.overall.sales && (
                          <span className="text-blue-600">
                            Sales: <strong className="text-base">£{(allShowroomTargets.overall.sales.monthly || 0).toLocaleString()}</strong>
                          </span>
                        )}
                        {allShowroomTargets.overall.bonus && (
                          <span className="text-purple-600">
                            Bonus: <strong className="text-base">£{(allShowroomTargets.overall.bonus.monthly || 0).toLocaleString()}</strong>
                          </span>
                        )}
                      </div>
                    </div>
                  </div>
                )}
              </div>
            )}
          </Card>
          )}

          {/* Set Sales Target Modal (Super Admin Only) */}
          {showTargetModal && isSuperAdmin && (
            <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
              <Card className="w-full max-w-md p-6 bg-white">
                <h3 className="text-lg font-semibold mb-4 flex items-center gap-2">
                  <Target className="h-5 w-5 text-blue-600" />
                  Set Sales Target
                </h3>
                <p className="text-sm text-muted-foreground mb-4">
                  Set the monthly target. Weekly and daily targets will be calculated automatically.
                </p>
                <div className="space-y-4">
                  {/* Month Selection */}
                  <div>
                    <label className="text-sm font-medium text-gray-700">Target Month</label>
                    <select
                      value={`${targetYear}-${targetMonth}`}
                      onChange={(e) => {
                        const [y, m] = e.target.value.split('-');
                        setTargetYear(parseInt(y));
                        setTargetMonth(parseInt(m));
                      }}
                      className="w-full mt-1 px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                      data-testid="target-month-select"
                    >
                      {/* Current month and previous 11 months */}
                      {Array.from({ length: 12 }, (_, i) => {
                        const d = new Date();
                        d.setMonth(d.getMonth() - i);
                        const m = d.getMonth() + 1;
                        const y = d.getFullYear();
                        const monthName = d.toLocaleString('default', { month: 'long' });
                        return (
                          <option key={`${y}-${m}`} value={`${y}-${m}`}>
                            {monthName} {y}
                          </option>
                        );
                      })}
                    </select>
                  </div>
                  {/* Showroom Selection */}
                  <div>
                    <label className="text-sm font-medium text-gray-700">Select Store</label>
                    <select
                      value={targetShowroomId}
                      onChange={(e) => setTargetShowroomId(e.target.value)}
                      className="w-full mt-1 px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                      data-testid="target-showroom-select"
                    >
                      <option value="">All Stores (Overall)</option>
                      {showrooms.map(store => (
                        <option key={store.id} value={store.id}>{store.name}</option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="text-sm font-medium text-gray-700">Monthly Target (£)</label>
                    <Input
                      type="number"
                      value={monthlyTarget}
                      onChange={(e) => handleMonthlyTargetChange(e.target.value)}
                      placeholder="Enter monthly target..."
                      className="mt-1"
                      data-testid="monthly-target-input"
                    />
                  </div>
                  <div className="grid grid-cols-2 gap-4 p-3 bg-gray-50 rounded-lg">
                    <div>
                      <label className="text-xs text-muted-foreground">Weekly (auto)</label>
                      <p className="text-lg font-bold">£{weeklyTarget.toLocaleString()}</p>
                    </div>
                    <div>
                      <label className="text-xs text-muted-foreground">Daily (auto)</label>
                      <p className="text-lg font-bold">£{dailyTarget.toLocaleString()}</p>
                    </div>
                  </div>
                  <div className="flex gap-2 justify-end">
                    <Button variant="outline" onClick={() => { setShowTargetModal(false); setTargetShowroomId(''); }}>
                      Cancel
                    </Button>
                    <Button onClick={saveSalesTarget} className="bg-blue-600 hover:bg-blue-700">
                      Save Target
                    </Button>
                  </div>
                </div>
              </Card>
            </div>
          )}

          {/* Set Bonus Target Modal (Super Admin Only) */}
          {showBonusTargetModal && isSuperAdmin && (
            <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
              <Card className="w-full max-w-md p-6 bg-white">
                <h3 className="text-lg font-semibold mb-4 flex items-center gap-2">
                  <Trophy className="h-5 w-5 text-purple-600" />
                  Set Bonus Target
                </h3>
                <p className="text-sm text-muted-foreground mb-4">
                  Set the monthly bonus target. Weekly and daily bonus targets will be calculated automatically.
                </p>
                <div className="space-y-4">
                  {/* Month Selection */}
                  <div>
                    <label className="text-sm font-medium text-gray-700">Target Month</label>
                    <select
                      value={`${targetYear}-${targetMonth}`}
                      onChange={(e) => {
                        const [y, m] = e.target.value.split('-');
                        setTargetYear(parseInt(y));
                        setTargetMonth(parseInt(m));
                      }}
                      className="w-full mt-1 px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-purple-500"
                    >
                      {Array.from({ length: 12 }, (_, i) => {
                        const d = new Date();
                        d.setMonth(d.getMonth() - i);
                        const m = d.getMonth() + 1;
                        const y = d.getFullYear();
                        const monthName = d.toLocaleString('default', { month: 'long' });
                        return (
                          <option key={`${y}-${m}`} value={`${y}-${m}`}>
                            {monthName} {y}
                          </option>
                        );
                      })}
                    </select>
                  </div>
                  {/* Showroom Selection */}
                  <div>
                    <label className="text-sm font-medium text-gray-700">Select Store</label>
                    <select
                      value={targetShowroomId}
                      onChange={(e) => setTargetShowroomId(e.target.value)}
                      className="w-full mt-1 px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-purple-500"
                      data-testid="bonus-target-showroom-select"
                    >
                      <option value="">All Stores (Overall)</option>
                      {showrooms.map(store => (
                        <option key={store.id} value={store.id}>{store.name}</option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="text-sm font-medium text-gray-700">Monthly Bonus Target (£)</label>
                    <Input
                      type="number"
                      value={monthlyBonusTarget}
                      onChange={(e) => handleMonthlyBonusTargetChange(e.target.value)}
                      placeholder="Enter monthly bonus target..."
                      className="mt-1"
                      data-testid="monthly-bonus-target-input"
                    />
                  </div>
                  <div className="grid grid-cols-2 gap-4 p-3 bg-purple-50 rounded-lg">
                    <div>
                      <label className="text-xs text-muted-foreground">Weekly (auto)</label>
                      <p className="text-lg font-bold text-purple-700">£{weeklyBonusTarget.toLocaleString()}</p>
                    </div>
                    <div>
                      <label className="text-xs text-muted-foreground">Daily (auto)</label>
                      <p className="text-lg font-bold text-purple-700">£{dailyBonusTarget.toLocaleString()}</p>
                    </div>
                  </div>
                  <div className="flex gap-2 justify-end">
                    <Button variant="outline" onClick={() => { setShowBonusTargetModal(false); setTargetShowroomId(''); }}>
                      Cancel
                    </Button>
                    <Button onClick={saveBonusTarget} className="bg-purple-600 hover:bg-purple-700">
                      Save Bonus Target
                    </Button>
                  </div>
                </div>
              </Card>
            </div>
          )}

          {/* Report Modal */}
          {showReportModal && reportData && (
            <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
              <Card className="w-full max-w-4xl max-h-[90vh] overflow-auto p-6 bg-white">
                <div className="flex items-center justify-between mb-4">
                  <h3 className="text-lg font-semibold flex items-center gap-2">
                    <FileText className="h-5 w-5 text-gray-600" />
                    Targets Report - {reportData.month_name} {reportData.year}
                  </h3>
                  <div className="flex items-center gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={downloadReportPDF}
                      className="bg-blue-50 hover:bg-blue-100 text-blue-700"
                    >
                      <FileText className="h-4 w-4 mr-1" />
                      Print / Save PDF
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setShowReportModal(false)}
                    >
                      <X className="h-4 w-4" />
                    </Button>
                  </div>
                </div>
                
                <p className="text-sm text-muted-foreground mb-4">
                  Generated: {new Date(reportData.generated_at).toLocaleString()}
                </p>
                
                <div className="overflow-x-auto">
                  <table className="w-full border-collapse">
                    <thead>
                      <tr className="bg-gray-100">
                        <th className="border p-3 text-left font-medium">Store</th>
                        <th className="border p-3 text-right font-medium">Sales Target</th>
                        <th className="border p-3 text-right font-medium">Bonus Target</th>
                        <th className="border p-3 text-right font-medium">Actual Revenue</th>
                        <th className="border p-3 text-right font-medium">Sales %</th>
                        <th className="border p-3 text-right font-medium">Bonus %</th>
                      </tr>
                    </thead>
                    <tbody>
                      {reportData.data.map((row, idx) => (
                        <tr key={idx} className={idx % 2 === 0 ? 'bg-white' : 'bg-gray-50'}>
                          <td className="border p-3 font-medium">{row.showroom}</td>
                          <td className="border p-3 text-right">£{row.sales_target.toLocaleString()}</td>
                          <td className="border p-3 text-right">£{row.bonus_target.toLocaleString()}</td>
                          <td className="border p-3 text-right font-bold">£{row.actual_revenue.toLocaleString()}</td>
                          <td className={`border p-3 text-right font-bold ${row.sales_achievement >= 100 ? 'text-green-600' : 'text-red-600'}`}>
                            {row.sales_achievement}%
                          </td>
                          <td className={`border p-3 text-right font-bold ${row.bonus_achievement >= 100 ? 'text-green-600' : 'text-red-600'}`}>
                            {row.bonus_achievement}%
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                
                <div className="mt-4 flex justify-end">
                  <Button variant="outline" onClick={() => setShowReportModal(false)}>
                    Close
                  </Button>
                </div>
              </Card>
            </div>
          )}

          {/* COMPANY TARGET SECTION (Super Admin Only) */}
          {isSuperAdmin && (
            <Card className="p-4 bg-gradient-to-r from-emerald-50 to-teal-50 border-emerald-200">
              <div className="flex items-center justify-between mb-4">
                <div className="flex items-center gap-2">
                  <Building2 className="h-5 w-5 text-emerald-600" />
                  <h3 className="font-semibold text-emerald-800">Company Target</h3>
                </div>
                <Button 
                  variant="outline" 
                  size="sm" 
                  onClick={() => setShowCompanyTargetModal(true)}
                  className="bg-white hover:bg-emerald-50"
                  data-testid="set-company-target-btn"
                >
                  <Settings className="h-4 w-4 mr-1" />
                  Set Target
                </Button>
              </div>
              
              {/* Daily, Weekly, Monthly Company Target Bars */}
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                {/* Daily Company Target */}
                <div className="p-3 bg-white rounded-lg border border-emerald-100">
                  <div className="flex justify-between items-center mb-2">
                    <span className="text-sm font-medium text-emerald-700">Daily</span>
                    <span className="text-xs text-emerald-600">Target: £{dailyCompanyTarget.toLocaleString()}</span>
                  </div>
                  <div className="flex justify-between text-sm mb-1">
                    <span className="font-bold text-gray-900">£{(salesSummary?.today?.net_revenue ?? salesSummary?.today?.revenue ?? 0).toLocaleString()}</span>
                  </div>
                  <div className="h-3 bg-emerald-100 rounded-full overflow-hidden">
                    <div 
                      className={`h-full transition-all duration-500 ${
                        dailyCompanyTarget > 0 && ((salesSummary?.today?.net_revenue ?? 0) / dailyCompanyTarget * 100) >= 100 ? 'bg-green-500' : 
                        dailyCompanyTarget > 0 && ((salesSummary?.today?.net_revenue ?? 0) / dailyCompanyTarget * 100) >= 50 ? 'bg-amber-500' : 'bg-emerald-500'
                      }`}
                      style={{ width: `${Math.min(dailyCompanyTarget > 0 ? ((salesSummary?.today?.net_revenue ?? 0) / dailyCompanyTarget * 100) : 0, 100)}%` }}
                    />
                  </div>
                  <p className="text-xs text-emerald-600 text-center mt-1">
                    {dailyCompanyTarget > 0 ? `${((salesSummary?.today?.net_revenue ?? 0) / dailyCompanyTarget * 100).toFixed(1)}%` : '0%'}
                  </p>
                </div>
                
                {/* Weekly Company Target */}
                <div className="p-3 bg-white rounded-lg border border-emerald-100">
                  <div className="flex justify-between items-center mb-2">
                    <span className="text-sm font-medium text-emerald-700">Weekly</span>
                    <span className="text-xs text-emerald-600">Target: £{weeklyCompanyTarget.toLocaleString()}</span>
                  </div>
                  <div className="flex justify-between text-sm mb-1">
                    <span className="font-bold text-gray-900">£{(salesSummary?.week?.net_revenue ?? salesSummary?.week?.revenue ?? 0).toLocaleString()}</span>
                  </div>
                  <div className="h-3 bg-emerald-100 rounded-full overflow-hidden">
                    <div 
                      className={`h-full transition-all duration-500 ${
                        weeklyCompanyTarget > 0 && ((salesSummary?.week?.net_revenue ?? 0) / weeklyCompanyTarget * 100) >= 100 ? 'bg-green-500' : 
                        weeklyCompanyTarget > 0 && ((salesSummary?.week?.net_revenue ?? 0) / weeklyCompanyTarget * 100) >= 50 ? 'bg-amber-500' : 'bg-emerald-500'
                      }`}
                      style={{ width: `${Math.min(weeklyCompanyTarget > 0 ? ((salesSummary?.week?.net_revenue ?? 0) / weeklyCompanyTarget * 100) : 0, 100)}%` }}
                    />
                  </div>
                  <p className="text-xs text-emerald-600 text-center mt-1">
                    {weeklyCompanyTarget > 0 ? `${((salesSummary?.week?.net_revenue ?? 0) / weeklyCompanyTarget * 100).toFixed(1)}%` : '0%'}
                  </p>
                </div>
                
                {/* Monthly Company Target */}
                <div className="p-3 bg-white rounded-lg border border-emerald-100">
                  <div className="flex justify-between items-center mb-2">
                    <span className="text-sm font-medium text-emerald-700">Monthly</span>
                    <span className="text-xs text-emerald-600">Target: £{monthlyCompanyTarget.toLocaleString()}</span>
                  </div>
                  <div className="flex justify-between text-sm mb-1">
                    <span className="font-bold text-gray-900">£{(salesSummary?.month?.net_revenue ?? salesSummary?.month?.revenue ?? 0).toLocaleString()}</span>
                  </div>
                  <div className="h-3 bg-emerald-100 rounded-full overflow-hidden">
                    <div 
                      className={`h-full transition-all duration-500 ${
                        monthlyCompanyTarget > 0 && ((salesSummary?.month?.net_revenue ?? 0) / monthlyCompanyTarget * 100) >= 100 ? 'bg-green-500' : 
                        monthlyCompanyTarget > 0 && ((salesSummary?.month?.net_revenue ?? 0) / monthlyCompanyTarget * 100) >= 50 ? 'bg-amber-500' : 'bg-emerald-500'
                      }`}
                      style={{ width: `${Math.min(monthlyCompanyTarget > 0 ? ((salesSummary?.month?.net_revenue ?? 0) / monthlyCompanyTarget * 100) : 0, 100)}%` }}
                    />
                  </div>
                  <p className="text-xs text-emerald-600 text-center mt-1">
                    {monthlyCompanyTarget > 0 ? `${((salesSummary?.month?.net_revenue ?? 0) / monthlyCompanyTarget * 100).toFixed(1)}%` : '0%'}
                  </p>
                </div>
              </div>
            </Card>
          )}

          {/* Set Company Target Modal (Super Admin Only) */}
          {showCompanyTargetModal && isSuperAdmin && (
            <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
              <Card className="w-full max-w-md p-6 bg-white">
                <h3 className="text-lg font-semibold mb-4 flex items-center gap-2">
                  <Building2 className="h-5 w-5 text-emerald-600" />
                  Set Company Target
                </h3>
                <p className="text-sm text-muted-foreground mb-4">
                  Set the monthly company target. Weekly and daily company targets will be calculated automatically.
                </p>
                <div className="space-y-4">
                  <div>
                    <label className="text-sm font-medium text-gray-700">Monthly Company Target (£)</label>
                    <Input
                      type="number"
                      value={monthlyCompanyTarget}
                      onChange={(e) => handleMonthlyCompanyTargetChange(e.target.value)}
                      placeholder="Enter monthly company target..."
                      className="mt-1"
                      data-testid="monthly-company-target-input"
                    />
                  </div>
                  <div className="grid grid-cols-2 gap-4 p-3 bg-emerald-50 rounded-lg">
                    <div>
                      <label className="text-xs text-muted-foreground">Weekly (auto)</label>
                      <p className="text-lg font-bold text-emerald-700">£{weeklyCompanyTarget.toLocaleString()}</p>
                    </div>
                    <div>
                      <label className="text-xs text-muted-foreground">Daily (auto)</label>
                      <p className="text-lg font-bold text-emerald-700">£{dailyCompanyTarget.toLocaleString()}</p>
                    </div>
                  </div>
                  <div className="flex gap-2 justify-end">
                    <Button variant="outline" onClick={() => setShowCompanyTargetModal(false)}>
                      Cancel
                    </Button>
                    <Button onClick={saveCompanyTarget} className="bg-emerald-600 hover:bg-emerald-700">
                      Save Company Target
                    </Button>
                  </div>
                </div>
              </Card>
            </div>
          )}
        </Card>
      )}

      {/* HISTORICAL SALES SECTION (Super Admin Only) */}
      {isSuperAdmin && (
        <Card className="p-4 bg-gradient-to-r from-amber-50 to-orange-50 border-amber-200" data-testid="historical-sales-section">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-2">
              <Calendar className="h-5 w-5 text-amber-600" />
              <h3 className="font-semibold text-amber-800">Historical Sales Data</h3>
              <span className="text-xs text-amber-600 bg-amber-100 px-2 py-0.5 rounded">Super Admin</span>
            </div>
            <Button 
              variant="outline" 
              size="sm" 
              onClick={() => setShowHistoricalModal(true)}
              className="bg-white hover:bg-amber-50 border-amber-300 text-amber-700"
              data-testid="add-historical-btn"
            >
              <FileText className="h-4 w-4 mr-1" />
              Add Past Month Revenue
            </Button>
          </div>
          
          {/* Existing Historical Entries */}
          {historicalEntries.length > 0 ? (
            <div className="space-y-2 max-h-64 overflow-y-auto">
              {historicalEntries.slice(0, 10).map((entry) => (
                <div 
                  key={entry.id} 
                  className={`flex items-center justify-between p-3 rounded-lg border ${
                    entry.visible_to_showroom 
                      ? 'bg-white border-amber-200' 
                      : 'bg-gray-50 border-gray-200 opacity-60'
                  }`}
                >
                  <div className="flex items-center gap-3">
                    <div>
                      <p className="font-medium text-gray-800">
                        {entry.showroom_name} - {new Date(entry.year, entry.month - 1).toLocaleString('default', { month: 'short' })} {entry.year}
                      </p>
                      <p className="text-xs text-gray-500">
                        {entry.notes || 'No notes'}
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-3">
                    <p className="text-lg font-bold text-amber-700">
                      £{entry.revenue.toLocaleString()}
                    </p>
                    <div className="flex gap-1">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => toggleHistoricalVisibility(entry.id)}
                        title={entry.visible_to_showroom ? 'Hide from showroom' : 'Show to showroom'}
                        className={entry.visible_to_showroom ? 'text-green-600' : 'text-gray-400'}
                      >
                        {entry.visible_to_showroom ? '👁️' : '🚫'}
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => deleteHistoricalEntry(entry.id)}
                        className="text-red-500 hover:text-red-700"
                      >
                        <X className="h-4 w-4" />
                      </Button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-sm text-amber-600 italic">No historical revenue entries yet. Click "Add Past Month Revenue" to add data.</p>
          )}
          
          {/* Historical Sales Modal */}
          {showHistoricalModal && (
            <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
              <Card className="w-full max-w-lg p-6 bg-white">
                <div className="flex items-center justify-between mb-4">
                  <h3 className="text-lg font-semibold flex items-center gap-2">
                    <Calendar className="h-5 w-5 text-amber-600" />
                    Add Historical Monthly Revenue
                  </h3>
                  <Button variant="ghost" size="sm" onClick={() => setShowHistoricalModal(false)}>
                    <X className="h-4 w-4" />
                  </Button>
                </div>
                <p className="text-sm text-muted-foreground mb-4">
                  Manually add historical revenue data for showrooms. This data can be made visible or hidden from showroom staff.
                </p>
                <div className="space-y-4">
                  {/* Showroom Selection */}
                  <div>
                    <label className="text-sm font-medium text-gray-700">Showroom *</label>
                    <select
                      value={historicalShowroomId}
                      onChange={(e) => setHistoricalShowroomId(e.target.value)}
                      className="w-full mt-1 p-2 border rounded-lg focus:ring-2 focus:ring-amber-500"
                    >
                      <option value="">Select showroom...</option>
                      {showrooms.map((s) => (
                        <option key={s.id} value={s.id}>{s.name}</option>
                      ))}
                    </select>
                  </div>
                  
                  {/* Month & Year */}
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <label className="text-sm font-medium text-gray-700">Month *</label>
                      <select
                        value={historicalMonth}
                        onChange={(e) => setHistoricalMonth(parseInt(e.target.value))}
                        className="w-full mt-1 p-2 border rounded-lg focus:ring-2 focus:ring-amber-500"
                      >
                        {Array.from({ length: 12 }, (_, i) => (
                          <option key={i + 1} value={i + 1}>
                            {new Date(2000, i).toLocaleString('default', { month: 'long' })}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <label className="text-sm font-medium text-gray-700">Year *</label>
                      <select
                        value={historicalYear}
                        onChange={(e) => setHistoricalYear(parseInt(e.target.value))}
                        className="w-full mt-1 p-2 border rounded-lg focus:ring-2 focus:ring-amber-500"
                      >
                        {Array.from({ length: 10 }, (_, i) => {
                          const year = new Date().getFullYear() - i;
                          return <option key={year} value={year}>{year}</option>;
                        })}
                      </select>
                    </div>
                  </div>
                  
                  {/* Revenue Amount */}
                  <div>
                    <label className="text-sm font-medium text-gray-700">Revenue Amount (£) *</label>
                    <Input
                      type="number"
                      value={historicalRevenue}
                      onChange={(e) => setHistoricalRevenue(e.target.value)}
                      placeholder="Enter total revenue..."
                      className="mt-1"
                    />
                  </div>
                  
                  {/* Visibility Toggle */}
                  <div className="flex items-center gap-3 p-3 bg-amber-50 rounded-lg">
                    <input
                      type="checkbox"
                      id="visibility-toggle"
                      checked={historicalVisible}
                      onChange={(e) => setHistoricalVisible(e.target.checked)}
                      className="h-4 w-4 text-amber-600 rounded"
                    />
                    <label htmlFor="visibility-toggle" className="text-sm text-gray-700">
                      <span className="font-medium">Visible to showroom staff</span>
                      <p className="text-xs text-gray-500">If unchecked, only Super Admin can see this data</p>
                    </label>
                  </div>
                  
                  {/* Notes */}
                  <div>
                    <label className="text-sm font-medium text-gray-700">Notes (optional)</label>
                    <Input
                      type="text"
                      value={historicalNotes}
                      onChange={(e) => setHistoricalNotes(e.target.value)}
                      placeholder="Any notes about this entry..."
                      className="mt-1"
                    />
                  </div>
                  
                  {/* Action Buttons */}
                  <div className="flex gap-2 justify-end pt-2">
                    <Button variant="outline" onClick={() => setShowHistoricalModal(false)}>
                      Cancel
                    </Button>
                    <Button 
                      onClick={saveHistoricalEntry} 
                      disabled={savingHistorical}
                      className="bg-amber-600 hover:bg-amber-700"
                    >
                      {savingHistorical ? 'Saving...' : 'Save Revenue Entry'}
                    </Button>
                  </div>
                </div>
              </Card>
            </div>
          )}
        </Card>
      )}

      {/* Show target section even without has_target if targets are set locally */}
      {salesSummary && !salesSummary.has_target && (monthlyTarget > 0 || monthlyBonusTarget > 0 || monthlyCompanyTarget > 0) && (
        <Card className="p-4 border-2 border-primary/20 bg-gradient-to-r from-primary/5 to-transparent" data-testid="local-target-bar">
          {/* SALES TARGET SECTION */}
          {monthlyTarget > 0 && (
            <Card className="p-4 mb-4 bg-gradient-to-r from-blue-50 to-indigo-50 border-blue-200">
              <div className="flex items-center justify-between mb-4">
                <div className="flex items-center gap-2">
                  <Target className="h-5 w-5 text-blue-600" />
                  <h3 className="font-semibold text-blue-800">Sales Target</h3>
                </div>
                {isSuperAdmin && (
                  <Button 
                    variant="outline" 
                    size="sm" 
                    onClick={() => setShowTargetModal(true)}
                    className="bg-white hover:bg-blue-50"
                  >
                    <Settings className="h-4 w-4 mr-1" />
                    Set Target
                  </Button>
                )}
              </div>
              
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                {/* Daily Target */}
                <div className="p-3 bg-white rounded-lg border border-blue-100">
                  <div className="flex justify-between items-center mb-2">
                    <span className="text-sm font-medium text-blue-700">Daily</span>
                    <span className="text-xs text-blue-600">Target: £{dailyTarget.toLocaleString()}</span>
                  </div>
                  <div className="flex justify-between text-sm mb-1">
                    <span className="font-bold text-gray-900">£{(salesSummary?.today?.net_revenue ?? 0).toLocaleString()}</span>
                  </div>
                  <div className="h-3 bg-blue-100 rounded-full overflow-hidden">
                    <div 
                      className={`h-full transition-all duration-500 ${
                        dailyTarget > 0 && ((salesSummary?.today?.net_revenue ?? 0) / dailyTarget * 100) >= 100 ? 'bg-green-500' : 
                        dailyTarget > 0 && ((salesSummary?.today?.net_revenue ?? 0) / dailyTarget * 100) >= 50 ? 'bg-amber-500' : 'bg-red-500'
                      }`}
                      style={{ width: `${Math.min(dailyTarget > 0 ? ((salesSummary?.today?.net_revenue ?? 0) / dailyTarget * 100) : 0, 100)}%` }}
                    />
                  </div>
                  <p className="text-xs text-blue-600 text-center mt-1">
                    {dailyTarget > 0 ? `${((salesSummary?.today?.net_revenue ?? 0) / dailyTarget * 100).toFixed(1)}%` : '0%'}
                  </p>
                </div>
                
                {/* Weekly Target */}
                <div className="p-3 bg-white rounded-lg border border-blue-100">
                  <div className="flex justify-between items-center mb-2">
                    <span className="text-sm font-medium text-blue-700">Weekly</span>
                    <span className="text-xs text-blue-600">Target: £{weeklyTarget.toLocaleString()}</span>
                  </div>
                  <div className="flex justify-between text-sm mb-1">
                    <span className="font-bold text-gray-900">£{(salesSummary?.week?.net_revenue ?? 0).toLocaleString()}</span>
                  </div>
                  <div className="h-3 bg-blue-100 rounded-full overflow-hidden">
                    <div 
                      className={`h-full transition-all duration-500 ${
                        weeklyTarget > 0 && ((salesSummary?.week?.net_revenue ?? 0) / weeklyTarget * 100) >= 100 ? 'bg-green-500' : 
                        weeklyTarget > 0 && ((salesSummary?.week?.net_revenue ?? 0) / weeklyTarget * 100) >= 50 ? 'bg-amber-500' : 'bg-red-500'
                      }`}
                      style={{ width: `${Math.min(weeklyTarget > 0 ? ((salesSummary?.week?.net_revenue ?? 0) / weeklyTarget * 100) : 0, 100)}%` }}
                    />
                  </div>
                  <p className="text-xs text-blue-600 text-center mt-1">
                    {weeklyTarget > 0 ? `${((salesSummary?.week?.net_revenue ?? 0) / weeklyTarget * 100).toFixed(1)}%` : '0%'}
                  </p>
                </div>
                
                {/* Monthly Target */}
                <div className="p-3 bg-white rounded-lg border border-blue-100">
                  <div className="flex justify-between items-center mb-2">
                    <span className="text-sm font-medium text-blue-700">Monthly</span>
                    <span className="text-xs text-blue-600">Target: £{monthlyTarget.toLocaleString()}</span>
                  </div>
                  <div className="flex justify-between text-sm mb-1">
                    <span className="font-bold text-gray-900">£{(salesSummary?.month?.net_revenue ?? 0).toLocaleString()}</span>
                  </div>
                  <div className="h-3 bg-blue-100 rounded-full overflow-hidden">
                    <div 
                      className={`h-full transition-all duration-500 ${
                        monthlyTarget > 0 && ((salesSummary?.month?.net_revenue ?? 0) / monthlyTarget * 100) >= 100 ? 'bg-green-500' : 
                        monthlyTarget > 0 && ((salesSummary?.month?.net_revenue ?? 0) / monthlyTarget * 100) >= 50 ? 'bg-amber-500' : 'bg-red-500'
                      }`}
                      style={{ width: `${Math.min(monthlyTarget > 0 ? ((salesSummary?.month?.net_revenue ?? 0) / monthlyTarget * 100) : 0, 100)}%` }}
                    />
                  </div>
                  <p className="text-xs text-blue-600 text-center mt-1">
                    {monthlyTarget > 0 ? `${((salesSummary?.month?.net_revenue ?? 0) / monthlyTarget * 100).toFixed(1)}%` : '0%'}
                  </p>
                </div>
              </div>
            </Card>
          )}

          {/* BONUS TARGET SECTION */}
          {monthlyBonusTarget > 0 && (
            <Card className="p-4 bg-gradient-to-r from-purple-50 to-pink-50 border-purple-200">
              <div className="flex items-center justify-between mb-4">
                <div className="flex items-center gap-2">
                  <Trophy className="h-5 w-5 text-purple-600" />
                  <h3 className="font-semibold text-purple-800">Bonus Target</h3>
                </div>
                {isSuperAdmin && (
                  <Button 
                    variant="outline" 
                    size="sm" 
                    onClick={() => setShowBonusTargetModal(true)}
                    className="bg-white hover:bg-purple-50"
                  >
                    <Settings className="h-4 w-4 mr-1" />
                    Set Target
                  </Button>
                )}
              </div>
              
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                {/* Daily Bonus */}
                <div className="p-3 bg-white rounded-lg border border-purple-100">
                  <div className="flex justify-between items-center mb-2">
                    <span className="text-sm font-medium text-purple-700">Daily</span>
                    <span className="text-xs text-purple-600">Target: £{dailyBonusTarget.toLocaleString()}</span>
                  </div>
                  <div className="flex justify-between text-sm mb-1">
                    <span className="font-bold text-gray-900">£{(salesSummary?.today?.net_revenue ?? 0).toLocaleString()}</span>
                  </div>
                  <div className="h-3 bg-purple-100 rounded-full overflow-hidden">
                    <div 
                      className={`h-full transition-all duration-500 ${
                        dailyBonusTarget > 0 && ((salesSummary?.today?.net_revenue ?? 0) / dailyBonusTarget * 100) >= 100 ? 'bg-green-500' : 
                        dailyBonusTarget > 0 && ((salesSummary?.today?.net_revenue ?? 0) / dailyBonusTarget * 100) >= 50 ? 'bg-amber-500' : 'bg-purple-500'
                      }`}
                      style={{ width: `${Math.min(dailyBonusTarget > 0 ? ((salesSummary?.today?.net_revenue ?? 0) / dailyBonusTarget * 100) : 0, 100)}%` }}
                    />
                  </div>
                  <p className="text-xs text-purple-600 text-center mt-1">
                    {dailyBonusTarget > 0 ? `${((salesSummary?.today?.net_revenue ?? 0) / dailyBonusTarget * 100).toFixed(1)}%` : '0%'}
                  </p>
                </div>
                
                {/* Weekly Bonus */}
                <div className="p-3 bg-white rounded-lg border border-purple-100">
                  <div className="flex justify-between items-center mb-2">
                    <span className="text-sm font-medium text-purple-700">Weekly</span>
                    <span className="text-xs text-purple-600">Target: £{weeklyBonusTarget.toLocaleString()}</span>
                  </div>
                  <div className="flex justify-between text-sm mb-1">
                    <span className="font-bold text-gray-900">£{(salesSummary?.week?.net_revenue ?? 0).toLocaleString()}</span>
                  </div>
                  <div className="h-3 bg-purple-100 rounded-full overflow-hidden">
                    <div 
                      className={`h-full transition-all duration-500 ${
                        weeklyBonusTarget > 0 && ((salesSummary?.week?.net_revenue ?? 0) / weeklyBonusTarget * 100) >= 100 ? 'bg-green-500' : 
                        weeklyBonusTarget > 0 && ((salesSummary?.week?.net_revenue ?? 0) / weeklyBonusTarget * 100) >= 50 ? 'bg-amber-500' : 'bg-purple-500'
                      }`}
                      style={{ width: `${Math.min(weeklyBonusTarget > 0 ? ((salesSummary?.week?.net_revenue ?? 0) / weeklyBonusTarget * 100) : 0, 100)}%` }}
                    />
                  </div>
                  <p className="text-xs text-purple-600 text-center mt-1">
                    {weeklyBonusTarget > 0 ? `${((salesSummary?.week?.net_revenue ?? 0) / weeklyBonusTarget * 100).toFixed(1)}%` : '0%'}
                  </p>
                </div>
                
                {/* Monthly Bonus */}
                <div className="p-3 bg-white rounded-lg border border-purple-100">
                  <div className="flex justify-between items-center mb-2">
                    <span className="text-sm font-medium text-purple-700">Monthly</span>
                    <span className="text-xs text-purple-600">Target: £{monthlyBonusTarget.toLocaleString()}</span>
                  </div>
                  <div className="flex justify-between text-sm mb-1">
                    <span className="font-bold text-gray-900">£{(salesSummary?.month?.net_revenue ?? 0).toLocaleString()}</span>
                  </div>
                  <div className="h-3 bg-purple-100 rounded-full overflow-hidden">
                    <div 
                      className={`h-full transition-all duration-500 ${
                        monthlyBonusTarget > 0 && ((salesSummary?.month?.net_revenue ?? 0) / monthlyBonusTarget * 100) >= 100 ? 'bg-green-500' : 
                        monthlyBonusTarget > 0 && ((salesSummary?.month?.net_revenue ?? 0) / monthlyBonusTarget * 100) >= 50 ? 'bg-amber-500' : 'bg-purple-500'
                      }`}
                      style={{ width: `${Math.min(monthlyBonusTarget > 0 ? ((salesSummary?.month?.net_revenue ?? 0) / monthlyBonusTarget * 100) : 0, 100)}%` }}
                    />
                  </div>
                  <p className="text-xs text-purple-600 text-center mt-1">
                    {monthlyBonusTarget > 0 ? `${((salesSummary?.month?.net_revenue ?? 0) / monthlyBonusTarget * 100).toFixed(1)}%` : '0%'}
                  </p>
                </div>
              </div>
            </Card>
          )}

          {/* COMPANY TARGET SECTION (Super Admin Only - Fallback) */}
          {isSuperAdmin && monthlyCompanyTarget > 0 && (
            <Card className="p-4 mb-4 bg-gradient-to-r from-emerald-50 to-teal-50 border-emerald-200">
              <div className="flex items-center justify-between mb-4">
                <div className="flex items-center gap-2">
                  <Building2 className="h-5 w-5 text-emerald-600" />
                  <h3 className="font-semibold text-emerald-800">Company Target</h3>
                </div>
                <Button 
                  variant="outline" 
                  size="sm" 
                  onClick={() => setShowCompanyTargetModal(true)}
                  className="bg-white hover:bg-emerald-50"
                >
                  <Settings className="h-4 w-4 mr-1" />
                  Set Target
                </Button>
              </div>
              
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                {/* Daily Company */}
                <div className="p-3 bg-white rounded-lg border border-emerald-100">
                  <div className="flex justify-between items-center mb-2">
                    <span className="text-sm font-medium text-emerald-700">Daily</span>
                    <span className="text-xs text-emerald-600">Target: £{dailyCompanyTarget.toLocaleString()}</span>
                  </div>
                  <div className="flex justify-between text-sm mb-1">
                    <span className="font-bold text-gray-900">£{(salesSummary?.today?.net_revenue ?? 0).toLocaleString()}</span>
                  </div>
                  <div className="h-3 bg-emerald-100 rounded-full overflow-hidden">
                    <div 
                      className={`h-full transition-all duration-500 ${
                        dailyCompanyTarget > 0 && ((salesSummary?.today?.net_revenue ?? 0) / dailyCompanyTarget * 100) >= 100 ? 'bg-green-500' : 
                        dailyCompanyTarget > 0 && ((salesSummary?.today?.net_revenue ?? 0) / dailyCompanyTarget * 100) >= 50 ? 'bg-amber-500' : 'bg-emerald-500'
                      }`}
                      style={{ width: `${Math.min(dailyCompanyTarget > 0 ? ((salesSummary?.today?.net_revenue ?? 0) / dailyCompanyTarget * 100) : 0, 100)}%` }}
                    />
                  </div>
                  <p className="text-xs text-emerald-600 text-center mt-1">
                    {dailyCompanyTarget > 0 ? `${((salesSummary?.today?.net_revenue ?? 0) / dailyCompanyTarget * 100).toFixed(1)}%` : '0%'}
                  </p>
                </div>
                
                {/* Weekly Company */}
                <div className="p-3 bg-white rounded-lg border border-emerald-100">
                  <div className="flex justify-between items-center mb-2">
                    <span className="text-sm font-medium text-emerald-700">Weekly</span>
                    <span className="text-xs text-emerald-600">Target: £{weeklyCompanyTarget.toLocaleString()}</span>
                  </div>
                  <div className="flex justify-between text-sm mb-1">
                    <span className="font-bold text-gray-900">£{(salesSummary?.week?.net_revenue ?? 0).toLocaleString()}</span>
                  </div>
                  <div className="h-3 bg-emerald-100 rounded-full overflow-hidden">
                    <div 
                      className={`h-full transition-all duration-500 ${
                        weeklyCompanyTarget > 0 && ((salesSummary?.week?.net_revenue ?? 0) / weeklyCompanyTarget * 100) >= 100 ? 'bg-green-500' : 
                        weeklyCompanyTarget > 0 && ((salesSummary?.week?.net_revenue ?? 0) / weeklyCompanyTarget * 100) >= 50 ? 'bg-amber-500' : 'bg-emerald-500'
                      }`}
                      style={{ width: `${Math.min(weeklyCompanyTarget > 0 ? ((salesSummary?.week?.net_revenue ?? 0) / weeklyCompanyTarget * 100) : 0, 100)}%` }}
                    />
                  </div>
                  <p className="text-xs text-emerald-600 text-center mt-1">
                    {weeklyCompanyTarget > 0 ? `${((salesSummary?.week?.net_revenue ?? 0) / weeklyCompanyTarget * 100).toFixed(1)}%` : '0%'}
                  </p>
                </div>
                
                {/* Monthly Company */}
                <div className="p-3 bg-white rounded-lg border border-emerald-100">
                  <div className="flex justify-between items-center mb-2">
                    <span className="text-sm font-medium text-emerald-700">Monthly</span>
                    <span className="text-xs text-emerald-600">Target: £{monthlyCompanyTarget.toLocaleString()}</span>
                  </div>
                  <div className="flex justify-between text-sm mb-1">
                    <span className="font-bold text-gray-900">£{(salesSummary?.month?.net_revenue ?? 0).toLocaleString()}</span>
                  </div>
                  <div className="h-3 bg-emerald-100 rounded-full overflow-hidden">
                    <div 
                      className={`h-full transition-all duration-500 ${
                        monthlyCompanyTarget > 0 && ((salesSummary?.month?.net_revenue ?? 0) / monthlyCompanyTarget * 100) >= 100 ? 'bg-green-500' : 
                        monthlyCompanyTarget > 0 && ((salesSummary?.month?.net_revenue ?? 0) / monthlyCompanyTarget * 100) >= 50 ? 'bg-amber-500' : 'bg-emerald-500'
                      }`}
                      style={{ width: `${Math.min(monthlyCompanyTarget > 0 ? ((salesSummary?.month?.net_revenue ?? 0) / monthlyCompanyTarget * 100) : 0, 100)}%` }}
                    />
                  </div>
                  <p className="text-xs text-emerald-600 text-center mt-1">
                    {monthlyCompanyTarget > 0 ? `${((salesSummary?.month?.net_revenue ?? 0) / monthlyCompanyTarget * 100).toFixed(1)}%` : '0%'}
                  </p>
                </div>
              </div>
            </Card>
          )}

          {/* Modals for setting targets when no backend targets exist */}
          {showTargetModal && isSuperAdmin && (
            <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
              <Card className="w-full max-w-md p-6 bg-white">
                <h3 className="text-lg font-semibold mb-4 flex items-center gap-2">
                  <Target className="h-5 w-5 text-blue-600" />
                  Set Sales Target
                </h3>
                <p className="text-sm text-muted-foreground mb-4">
                  Set the monthly target. Weekly and daily targets will be calculated automatically.
                </p>
                <div className="space-y-4">
                  <div>
                    <label className="text-sm font-medium text-gray-700">Monthly Target (£)</label>
                    <Input
                      type="number"
                      value={monthlyTarget}
                      onChange={(e) => handleMonthlyTargetChange(e.target.value)}
                      placeholder="Enter monthly target..."
                      className="mt-1"
                    />
                  </div>
                  <div className="grid grid-cols-2 gap-4 p-3 bg-gray-50 rounded-lg">
                    <div>
                      <label className="text-xs text-muted-foreground">Weekly (auto)</label>
                      <p className="text-lg font-bold">£{weeklyTarget.toLocaleString()}</p>
                    </div>
                    <div>
                      <label className="text-xs text-muted-foreground">Daily (auto)</label>
                      <p className="text-lg font-bold">£{dailyTarget.toLocaleString()}</p>
                    </div>
                  </div>
                  <div className="flex gap-2 justify-end">
                    <Button variant="outline" onClick={() => setShowTargetModal(false)}>
                      Cancel
                    </Button>
                    <Button onClick={saveSalesTarget} className="bg-blue-600 hover:bg-blue-700">
                      Save Target
                    </Button>
                  </div>
                </div>
              </Card>
            </div>
          )}

          {showBonusTargetModal && isSuperAdmin && (
            <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
              <Card className="w-full max-w-md p-6 bg-white">
                <h3 className="text-lg font-semibold mb-4 flex items-center gap-2">
                  <Trophy className="h-5 w-5 text-purple-600" />
                  Set Bonus Target
                </h3>
                <p className="text-sm text-muted-foreground mb-4">
                  Set the monthly bonus target. Weekly and daily bonus targets will be calculated automatically.
                </p>
                <div className="space-y-4">
                  <div>
                    <label className="text-sm font-medium text-gray-700">Monthly Bonus Target (£)</label>
                    <Input
                      type="number"
                      value={monthlyBonusTarget}
                      onChange={(e) => handleMonthlyBonusTargetChange(e.target.value)}
                      placeholder="Enter monthly bonus target..."
                      className="mt-1"
                    />
                  </div>
                  <div className="grid grid-cols-2 gap-4 p-3 bg-purple-50 rounded-lg">
                    <div>
                      <label className="text-xs text-muted-foreground">Weekly (auto)</label>
                      <p className="text-lg font-bold text-purple-700">£{weeklyBonusTarget.toLocaleString()}</p>
                    </div>
                    <div>
                      <label className="text-xs text-muted-foreground">Daily (auto)</label>
                      <p className="text-lg font-bold text-purple-700">£{dailyBonusTarget.toLocaleString()}</p>
                    </div>
                  </div>
                  <div className="flex gap-2 justify-end">
                    <Button variant="outline" onClick={() => setShowBonusTargetModal(false)}>
                      Cancel
                    </Button>
                    <Button onClick={saveBonusTarget} className="bg-purple-600 hover:bg-purple-700">
                      Save Bonus Target
                    </Button>
                  </div>
                </div>
              </Card>
            </div>
          )}

          {showCompanyTargetModal && isSuperAdmin && (
            <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
              <Card className="w-full max-w-md p-6 bg-white">
                <h3 className="text-lg font-semibold mb-4 flex items-center gap-2">
                  <Building2 className="h-5 w-5 text-emerald-600" />
                  Set Company Target
                </h3>
                <p className="text-sm text-muted-foreground mb-4">
                  Set the monthly company target. Weekly and daily company targets will be calculated automatically.
                </p>
                <div className="space-y-4">
                  <div>
                    <label className="text-sm font-medium text-gray-700">Monthly Company Target (£)</label>
                    <Input
                      type="number"
                      value={monthlyCompanyTarget}
                      onChange={(e) => handleMonthlyCompanyTargetChange(e.target.value)}
                      placeholder="Enter monthly company target..."
                      className="mt-1"
                    />
                  </div>
                  <div className="grid grid-cols-2 gap-4 p-3 bg-emerald-50 rounded-lg">
                    <div>
                      <label className="text-xs text-muted-foreground">Weekly (auto)</label>
                      <p className="text-lg font-bold text-emerald-700">£{weeklyCompanyTarget.toLocaleString()}</p>
                    </div>
                    <div>
                      <label className="text-xs text-muted-foreground">Daily (auto)</label>
                      <p className="text-lg font-bold text-emerald-700">£{dailyCompanyTarget.toLocaleString()}</p>
                    </div>
                  </div>
                  <div className="flex gap-2 justify-end">
                    <Button variant="outline" onClick={() => setShowCompanyTargetModal(false)}>
                      Cancel
                    </Button>
                    <Button onClick={saveCompanyTarget} className="bg-emerald-600 hover:bg-emerald-700">
                      Save Company Target
                    </Button>
                  </div>
                </div>
              </Card>
            </div>
          )}
        </Card>
      )}

      {/* Sales Summary - Daily, Weekly, Monthly with Targets */}
      {salesSummary && (
        <Card className="p-6" data-testid="sales-summary">
          <div className="flex items-center justify-between mb-6">
            <div className="flex items-center gap-2">
              <div className="p-2 bg-emerald-100 rounded-lg">
                <TrendingUp className="h-5 w-5 text-emerald-600" strokeWidth={2} />
              </div>
              <div>
                <h2 className="text-xl font-heading font-bold tracking-tightest">Sales Performance</h2>
                <p className="text-sm text-muted-foreground">
                  {selectedShowroom 
                    ? showrooms.find(s => s.id === selectedShowroom)?.name 
                    : salesSummary.store_name
                  } • {salesSummary.has_target ? 'Tracking against targets' : 'No target set'}
                </p>
              </div>
            </div>
            {/* Super Admin Showroom Filter */}
            {isSuperAdmin && showrooms.length > 0 && (
              <div className="flex items-center gap-2">
                <Building2 className="h-4 w-4 text-muted-foreground" />
                <select
                  value={selectedShowroom}
                  onChange={(e) => setSelectedShowroom(e.target.value)}
                  className="px-3 py-2 border rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:ring-emerald-500"
                  data-testid="showroom-filter-select"
                >
                  <option value="">All Showrooms</option>
                  {showrooms.map((showroom) => (
                    <option key={showroom.id} value={showroom.id}>
                      {showroom.name}
                    </option>
                  ))}
                </select>
              </div>
            )}
          </div>
          
          {/* Daily, Weekly, Monthly Cards */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
            {/* Today */}
            <div className={`p-4 rounded-xl border-2 ${salesSummary.today.on_track ? 'bg-emerald-50 border-emerald-200' : 'bg-orange-50 border-orange-200'}`}>
              <div className="flex items-center justify-between mb-2">
                <span className="text-sm font-medium text-gray-600">Today</span>
                {salesSummary.has_target && (
                  <span className={`text-xs px-2 py-1 rounded-full font-medium ${salesSummary.today.on_track ? 'bg-emerald-200 text-emerald-800' : 'bg-orange-200 text-orange-800'}`}>
                    {salesSummary.today.on_track ? '✓ On Track' : '↓ Behind'}
                  </span>
                )}
              </div>
              <p className="text-3xl font-bold text-gray-900">£{(salesSummary.today.net_revenue ?? salesSummary.today.revenue).toLocaleString()}</p>
              {salesSummary.today.refunds > 0 && (
                <p className="text-xs text-red-500 mt-1">
                  Refunds: -£{salesSummary.today.refunds.toLocaleString()} ({salesSummary.today.refund_count})
                </p>
              )}
              {salesSummary.has_target && (
                <div className="mt-2">
                  <div className="flex justify-between text-xs text-gray-500 mb-1">
                    <span>Target: £{salesSummary.today.target.toLocaleString()}</span>
                    <span>{salesSummary.today.progress}%</span>
                  </div>
                  <div className="w-full bg-gray-200 rounded-full h-2">
                    <div 
                      className={`h-2 rounded-full ${salesSummary.today.on_track ? 'bg-emerald-500' : 'bg-orange-500'}`}
                      style={{ width: `${Math.min(salesSummary.today.progress, 100)}%` }}
                    />
                  </div>
                </div>
              )}
              <p className="text-xs text-gray-500 mt-2">{salesSummary.today.invoices} invoices • {salesSummary.today.items_sold} items</p>
            </div>

            {/* This Week */}
            <div className={`p-4 rounded-xl border-2 ${salesSummary.week.on_track ? 'bg-blue-50 border-blue-200' : 'bg-orange-50 border-orange-200'}`}>
              <div className="flex items-center justify-between mb-2">
                <span className="text-sm font-medium text-gray-600">This Week</span>
                {salesSummary.has_target && (
                  <span className={`text-xs px-2 py-1 rounded-full font-medium ${salesSummary.week.on_track ? 'bg-blue-200 text-blue-800' : 'bg-orange-200 text-orange-800'}`}>
                    {salesSummary.week.on_track ? '✓ On Track' : '↓ Behind'}
                  </span>
                )}
              </div>
              <p className="text-3xl font-bold text-gray-900">£{(salesSummary.week.net_revenue ?? salesSummary.week.revenue).toLocaleString()}</p>
              {salesSummary.week.refunds > 0 && (
                <p className="text-xs text-red-500 mt-1">
                  Refunds: -£{salesSummary.week.refunds.toLocaleString()} ({salesSummary.week.refund_count})
                </p>
              )}
              {salesSummary.has_target && (
                <div className="mt-2">
                  <div className="flex justify-between text-xs text-gray-500 mb-1">
                    <span>Target: £{salesSummary.week.target.toLocaleString()}</span>
                    <span>{salesSummary.week.progress}%</span>
                  </div>
                  <div className="w-full bg-gray-200 rounded-full h-2">
                    <div 
                      className={`h-2 rounded-full ${salesSummary.week.on_track ? 'bg-blue-500' : 'bg-orange-500'}`}
                      style={{ width: `${Math.min(salesSummary.week.progress, 100)}%` }}
                    />
                  </div>
                </div>
              )}
              <p className="text-xs text-gray-500 mt-2">{salesSummary.week.invoices} invoices • {salesSummary.week.items_sold} items</p>
            </div>

            {/* This Month */}
            <div className={`p-4 rounded-xl border-2 ${salesSummary.month.on_track ? 'bg-purple-50 border-purple-200' : 'bg-orange-50 border-orange-200'}`}>
              <div className="flex items-center justify-between mb-2">
                <span className="text-sm font-medium text-gray-600">This Month</span>
                {salesSummary.has_target && (
                  <span className={`text-xs px-2 py-1 rounded-full font-medium ${salesSummary.month.on_track ? 'bg-purple-200 text-purple-800' : 'bg-orange-200 text-orange-800'}`}>
                    {salesSummary.month.on_track ? '✓ On Track' : '↓ Behind'}
                  </span>
                )}
              </div>
              <p className="text-3xl font-bold text-gray-900">£{(salesSummary.month.net_revenue ?? salesSummary.month.revenue).toLocaleString()}</p>
              {salesSummary.month.refunds > 0 && (
                <p className="text-xs text-red-500 mt-1">
                  Refunds: -£{salesSummary.month.refunds.toLocaleString()} ({salesSummary.month.refund_count})
                </p>
              )}
              {salesSummary.has_target && (
                <div className="mt-2">
                  <div className="flex justify-between text-xs text-gray-500 mb-1">
                    <span>Target: £{salesSummary.month.target.toLocaleString()}</span>
                    <span>{salesSummary.month.progress}%</span>
                  </div>
                  <div className="w-full bg-gray-200 rounded-full h-2">
                    <div 
                      className={`h-2 rounded-full ${salesSummary.month.on_track ? 'bg-purple-500' : 'bg-orange-500'}`}
                      style={{ width: `${Math.min(salesSummary.month.progress, 100)}%` }}
                    />
                  </div>
                  <p className="text-xs text-gray-400 mt-1">Day {salesSummary.month.days_passed} of {salesSummary.month.days_total} • Expected: {salesSummary.month.expected_progress}%</p>
                </div>
              )}
              <p className="text-xs text-gray-500 mt-2">{salesSummary.month.invoices} invoices • {salesSummary.month.items_sold} items</p>
            </div>
          </div>

          {/* Payment Method Breakdown */}
          {salesSummary.month.by_payment_method && salesSummary.month.by_payment_method.length > 0 && (
            <div className="mt-4 p-4 rounded-xl border bg-white">
              <h3 className="text-sm font-medium text-gray-600 mb-3 flex items-center gap-2">
                <PoundSterling className="h-4 w-4" />
                Payment Method Breakdown (This Month)
              </h3>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                {salesSummary.month.by_payment_method.map((pm, idx) => {
                  const total = salesSummary.month.by_payment_method.reduce((sum, p) => sum + p.amount, 0);
                  const percentage = total > 0 ? ((pm.amount / total) * 100).toFixed(1) : 0;
                  const colors = [
                    { bg: 'bg-blue-100', text: 'text-blue-700', bar: 'bg-blue-500' },
                    { bg: 'bg-green-100', text: 'text-green-700', bar: 'bg-green-500' },
                    { bg: 'bg-purple-100', text: 'text-purple-700', bar: 'bg-purple-500' },
                    { bg: 'bg-amber-100', text: 'text-amber-700', bar: 'bg-amber-500' },
                    { bg: 'bg-rose-100', text: 'text-rose-700', bar: 'bg-rose-500' },
                    { bg: 'bg-cyan-100', text: 'text-cyan-700', bar: 'bg-cyan-500' },
                  ];
                  const color = colors[idx % colors.length];
                  return (
                    <div key={pm.method} className={`p-3 rounded-lg ${color.bg}`}>
                      <div className="flex items-center justify-between mb-1">
                        <span className={`text-xs font-medium ${color.text}`}>{pm.method}</span>
                        <span className="text-xs text-gray-500">{percentage}%</span>
                      </div>
                      <p className={`text-lg font-bold ${color.text}`}>£{pm.amount.toLocaleString()}</p>
                      <div className="w-full bg-white/50 rounded-full h-1.5 mt-2">
                        <div 
                          className={`h-1.5 rounded-full ${color.bar}`}
                          style={{ width: `${percentage}%` }}
                        />
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* 7-Day Trend Chart */}
          {salesSummary.daily_trend && salesSummary.daily_trend.length > 0 && (
            <div className="mt-4">
              <h3 className="text-sm font-medium text-gray-600 mb-3">Last 7 Days Revenue</h3>
              <div className="h-40">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={salesSummary.daily_trend}>
                    <XAxis dataKey="day" tick={{ fontSize: 12 }} />
                    <YAxis tick={{ fontSize: 12 }} tickFormatter={(v) => `£${v}`} />
                    <Tooltip 
                      formatter={(value) => [`£${value.toLocaleString()}`, 'Revenue']}
                      labelFormatter={(label, payload) => payload[0]?.payload?.date || label}
                    />
                    <Bar dataKey="revenue" fill="#3b82f6" radius={[4, 4, 0, 0]} />
                    {salesSummary.has_target && (
                      <Bar dataKey="target" fill="#e5e7eb" radius={[4, 4, 0, 0]} />
                    )}
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>
          )}

          {/* Top Products Today */}
          {salesSummary.top_products_today && salesSummary.top_products_today.length > 0 && (
            <div className="mt-6 pt-4 border-t">
              <h3 className="text-sm font-medium text-gray-600 mb-3">Top Products Today</h3>
              <div className="space-y-2">
                {salesSummary.top_products_today.map((product, index) => (
                  <div key={index} className="flex items-center justify-between p-2 bg-gray-50 rounded-lg">
                    <div className="flex items-center gap-3">
                      <span className="w-6 h-6 bg-primary/10 rounded-full flex items-center justify-center text-xs font-bold text-primary">{index + 1}</span>
                      <span className="text-sm font-medium truncate max-w-[200px]">{product.name}</span>
                    </div>
                    <div className="text-right">
                      <p className="text-sm font-bold">£{product.revenue.toLocaleString()}</p>
                      <p className="text-xs text-gray-500">{product.quantity} sold</p>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </Card>
      )}

      {/* Quick Launch - Store EPOS */}
      {showrooms.length > 0 && (
        <Card className="p-6" data-testid="quick-launch-showroom-epos">
          <div className="flex items-center justify-between mb-4 pb-3 border-b border-border/50">
            <div className="flex items-center gap-2">
              <div className="p-2 bg-primary/10 rounded-lg">
                <Zap className="h-5 w-5 text-primary" strokeWidth={2} />
              </div>
              <div>
                <h2 className="text-xl font-heading font-bold tracking-tightest">Quick Launch</h2>
                <p className="text-sm text-muted-foreground">Jump directly to your showroom&apos;s EPOS</p>
              </div>
            </div>
            <Link to="/admin/epos">
              <Button variant="outline" size="sm">
                <Monitor className="h-4 w-4 mr-1" /> Main EPOS
              </Button>
            </Link>
          </div>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            {showrooms
              .filter(showroom => {
                // Staff/Manager can only see their assigned showroom
                const isStaffOrManager = user?.role === 'staff' || user?.role === 'manager';
                if (isStaffOrManager && user?.showroom_id) {
                  return showroom.id === user.showroom_id;
                }
                return true; // Admin/Super Admin see all
              })
              .map((showroom, index) => {
              const colors = getStoreColor(index);
              const slug = getStoreSlug(showroom.name);
              const prefix = getStorePrefix(showroom.name);
              
              return (
                <div
                  key={showroom.id}
                  onClick={() => navigate(`/admin/showroom/${slug}/epos`)}
                  className={`group cursor-pointer p-4 rounded-xl ${colors.light} ${colors.border} border-2 hover:shadow-lg transition-all duration-200 hover:scale-[1.02]`}
                  data-testid={`quick-launch-${slug}`}
                >
                  <div className="flex items-start justify-between mb-3">
                    <div className={`w-10 h-10 ${colors.bg} rounded-lg flex items-center justify-center shadow-sm`}>
                      <Building2 className="h-5 w-5 text-white" />
                    </div>
                    <span className={`text-xs font-mono font-bold px-2 py-1 rounded ${colors.text} bg-white/80`}>
                      {prefix}
                    </span>
                  </div>
                  <h3 className="font-bold text-gray-900 mb-1 group-hover:text-primary transition-colors">
                    {showroom.name}
                  </h3>
                  <p className="text-xs text-gray-500 line-clamp-1">{showroom.address?.split(',')[0]}</p>
                  <div className="mt-3 flex items-center gap-1 text-xs font-medium text-primary opacity-0 group-hover:opacity-100 transition-opacity">
                    <span>Open EPOS</span>
                    <ArrowRight className="h-3 w-3" />
                  </div>
                </div>
              );
            })}
          </div>
        </Card>
      )}

      {/* Store Analytics Section */}
      {analytics && analytics.showroom_analytics?.length > 0 && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <Card className="p-6" data-testid="showroom-revenue-chart">
            <div className="flex items-center justify-between mb-4 pb-3 border-b border-border/50">
              <div className="flex items-center gap-2">
                <Building2 className="h-5 w-5 text-orange-600" strokeWidth={1.5} />
                <h2 className="text-xl font-heading font-bold tracking-tightest">
                  {analytics.access_level === 'store' && analytics.user_showroom_name
                    ? `${analytics.user_showroom_name} Revenue (30 days)`
                    : 'Store Revenue (30 days)'
                  }
                </h2>
              </div>
              <Link to="/admin/analytics">
                <Button variant="ghost" size="sm" className="text-primary">
                  View All <ArrowRight className="h-4 w-4 ml-1" />
                </Button>
              </Link>
            </div>
            <div className="h-64">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={showroomBarData} layout="vertical">
                  <CartesianGrid strokeDasharray="3 3" horizontal={true} vertical={false} />
                  <XAxis type="number" tickFormatter={(v) => `£${(v/1000).toFixed(0)}k`} />
                  <YAxis type="category" dataKey="name" width={70} fontSize={12} />
                  <Tooltip 
                    formatter={(value) => formatCurrency(value)}
                    labelFormatter={(label) => `${label} Store`}
                  />
                  <Bar dataKey="revenue" fill="#f97316" radius={[0, 4, 4, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </Card>

          <Card className="p-6" data-testid="showroom-distribution-chart">
            <div className="flex items-center gap-2 mb-4 pb-3 border-b border-border/50">
              <TrendingUp className="h-5 w-5 text-purple-600" strokeWidth={1.5} />
              <h2 className="text-xl font-heading font-bold tracking-tightest">
                {analytics.access_level === 'store' ? 'Your Performance' : 'Revenue Distribution'}
              </h2>
            </div>
            <div className="h-64 flex">
              <div className="flex-1">
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart>
                    <Pie
                      data={pieData}
                      cx="50%"
                      cy="50%"
                      innerRadius={45}
                      outerRadius={80}
                      paddingAngle={2}
                      dataKey="value"
                    >
                      {pieData.map((entry, index) => (
                        <Cell key={`cell-${index}`} fill={entry.color} />
                      ))}
                    </Pie>
                    <Tooltip formatter={(value) => formatCurrency(value)} />
                  </PieChart>
                </ResponsiveContainer>
              </div>
              <div className="flex flex-col justify-center gap-2 min-w-[140px]">
                {pieData.map((entry, idx) => (
                  <div key={idx} className="flex items-center gap-2 text-sm">
                    <div 
                      className="w-3 h-3 rounded-full flex-shrink-0" 
                      style={{ backgroundColor: entry.color }}
                    />
                    <span className="truncate">{entry.name?.split(' ')[0]}</span>
                    <span className="font-mono text-muted-foreground ml-auto">{entry.percentage}%</span>
                  </div>
                ))}
              </div>
            </div>
          </Card>
        </div>
      )}

      {/* Historical Sales Comparison - Store by Store */}
      {isAdmin && <SalesComparison />}

      {/* Best Selling Products */}
      {bestSellers && (bestSellers.top_by_quantity?.length > 0 || bestSellers.top_by_revenue?.length > 0) && (
        <>
          {/* Profit Summary - Only for Super Admin */}
          {bestSellers.show_profit && (
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
              <Card className="p-4 bg-emerald-50 border-emerald-200">
                <p className="text-xs font-mono uppercase tracking-widest text-emerald-700 mb-1">Total Profit</p>
                <p className="text-2xl font-heading font-bold text-emerald-700">{formatCurrency(bestSellers.total_profit)}</p>
              </Card>
              <Card className="p-4">
                <p className="text-xs font-mono uppercase tracking-widest text-muted-foreground mb-1">Total Revenue</p>
                <p className="text-2xl font-heading font-bold">{formatCurrency(bestSellers.total_revenue)}</p>
              </Card>
              <Card className="p-4">
                <p className="text-xs font-mono uppercase tracking-widest text-muted-foreground mb-1">Total Cost</p>
                <p className="text-2xl font-heading font-bold">{formatCurrency(bestSellers.total_cost)}</p>
              </Card>
              <Card className="p-4">
                <p className="text-xs font-mono uppercase tracking-widest text-muted-foreground mb-1">Avg Margin</p>
                <p className={`text-2xl font-heading font-bold ${bestSellers.overall_margin >= 30 ? 'text-emerald-600' : bestSellers.overall_margin >= 15 ? 'text-amber-600' : 'text-red-600'}`}>
                  {bestSellers.overall_margin}%
                </p>
              </Card>
            </div>
          )}

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <Card className="p-6" data-testid="best-sellers-quantity">
              <div className="flex items-center gap-2 mb-4 pb-3 border-b border-border/50">
                <Trophy className="h-5 w-5 text-amber-500" strokeWidth={1.5} />
                <h2 className="text-xl font-heading font-bold tracking-tightest">Top Sellers by Quantity</h2>
                <span className="ml-auto text-xs text-muted-foreground">Last 30 days</span>
              </div>
              <div className="space-y-3">
                {bestSellers.top_by_quantity?.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No sales data yet</p>
                ) : (
                  bestSellers.top_by_quantity?.map((product, idx) => (
                    <div key={product.product_id} className="flex items-center gap-3 p-3 bg-secondary rounded-md">
                      <div className={`w-8 h-8 rounded-full flex items-center justify-center text-sm font-bold ${
                        idx === 0 ? 'bg-amber-500 text-white' :
                        idx === 1 ? 'bg-gray-400 text-white' :
                        idx === 2 ? 'bg-amber-700 text-white' :
                        'bg-gray-200 text-gray-600'
                      }`}>
                        {idx + 1}
                      </div>
                      {product.image ? (
                        <img src={normaliseImageUrl(product.image)} alt={product.name} className="w-10 h-10 rounded object-cover" />
                      ) : (
                        <div className="w-10 h-10 rounded bg-muted flex items-center justify-center">
                          <Package className="h-5 w-5 text-muted-foreground" />
                        </div>
                      )}
                      <div className="flex-1 min-w-0">
                        <p className="font-medium truncate">{product.name}</p>
                        <p className="text-xs text-muted-foreground font-mono">{product.sku}</p>
                      </div>
                      <div className="text-right">
                        <p className="text-lg font-bold tabular-nums">{product.quantity}</p>
                        <p className="text-xs text-muted-foreground">units sold</p>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </Card>

            <Card className="p-6" data-testid="best-sellers-revenue">
              <div className="flex items-center gap-2 mb-4 pb-3 border-b border-border/50">
                <Star className="h-5 w-5 text-emerald-500" strokeWidth={1.5} />
                <h2 className="text-xl font-heading font-bold tracking-tightest">
                  {bestSellers.show_profit ? 'Top Sellers by Profit' : 'Top Sellers by Revenue'}
                </h2>
                <span className="ml-auto text-xs text-muted-foreground">Last 30 days</span>
              </div>
              <div className="space-y-3">
                {bestSellers.top_by_revenue?.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No sales data yet</p>
                ) : (
                  bestSellers.top_by_revenue?.map((product, idx) => (
                    <div key={product.product_id} className="flex items-center gap-3 p-3 bg-secondary rounded-md">
                      <div className={`w-8 h-8 rounded-full flex items-center justify-center text-sm font-bold ${
                        idx === 0 ? 'bg-emerald-500 text-white' :
                        idx === 1 ? 'bg-gray-400 text-white' :
                        idx === 2 ? 'bg-emerald-700 text-white' :
                        'bg-gray-200 text-gray-600'
                      }`}>
                        {idx + 1}
                      </div>
                      {product.image ? (
                        <img src={normaliseImageUrl(product.image)} alt={product.name} className="w-10 h-10 rounded object-cover" />
                      ) : (
                        <div className="w-10 h-10 rounded bg-muted flex items-center justify-center">
                          <Package className="h-5 w-5 text-muted-foreground" />
                        </div>
                      )}
                      <div className="flex-1 min-w-0">
                        <p className="font-medium truncate">{product.name}</p>
                        <div className="flex items-center gap-2 text-xs">
                          <span className="text-muted-foreground">Rev: {formatCurrency(product.revenue)}</span>
                          {bestSellers.show_profit && product.margin > 0 && (
                            <span className={`font-mono ${product.margin >= 30 ? 'text-emerald-600' : product.margin >= 15 ? 'text-amber-600' : 'text-red-600'}`}>
                              {product.margin}%
                            </span>
                          )}
                        </div>
                      </div>
                      <div className="text-right">
                        {bestSellers.show_profit ? (
                          <>
                            <p className={`text-lg font-bold tabular-nums ${product.profit > 0 ? 'text-emerald-600' : 'text-red-600'}`}>
                              {formatCurrency(product.profit)}
                            </p>
                            <p className="text-xs text-muted-foreground">profit</p>
                          </>
                        ) : (
                          <>
                            <p className="text-lg font-bold tabular-nums">{formatCurrency(product.revenue)}</p>
                            <p className="text-xs text-muted-foreground">{product.quantity} units</p>
                          </>
                        )}
                      </div>
                    </div>
                  ))
                )}
              </div>
            </Card>
          </div>
        </>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Card className="p-6" data-testid="low-stock-alerts">
          <div className="flex items-center gap-2 mb-4 pb-3 border-b border-border/50">
            <AlertTriangle className="h-5 w-5 text-accent" strokeWidth={1.5} />
            <h2 className="text-xl font-heading font-bold tracking-tightest">Low Stock Alerts</h2>
          </div>
          <div className="space-y-3">
            {products.length === 0 ? (
              <p className="text-sm text-muted-foreground">No low stock items</p>
            ) : (
              products.map((product) => (
                <div key={product.id} className="flex items-center justify-between p-3 bg-secondary rounded-md" data-testid={`low-stock-${product.id}`}>
                  <div>
                    <p className="font-medium">{product.name}</p>
                    <p className="text-xs text-muted-foreground font-mono">SKU: {product.sku}</p>
                  </div>
                  <div className="text-right">
                    <p className="text-sm font-bold text-accent tabular-nums">{product.stock} pcs</p>
                    <p className="text-xs text-muted-foreground">Reorder at {product.reorder_level}</p>
                  </div>
                </div>
              ))
            )}
          </div>
        </Card>

        <Card className="p-6" data-testid="recent-orders">
          <div className="flex items-center gap-2 mb-4 pb-3 border-b border-border/50">
            <ShoppingCart className="h-5 w-5 text-emerald-600" strokeWidth={1.5} />
            <h2 className="text-xl font-heading font-bold tracking-tightest">Recent Orders</h2>
          </div>
          <div className="space-y-3">
            {orders.length === 0 ? (
              <p className="text-sm text-muted-foreground">No orders yet</p>
            ) : (
              orders.map((order) => (
                <div key={order.id} className="flex items-center justify-between p-3 bg-secondary rounded-md" data-testid={`order-${order.id}`}>
                  <div>
                    <p className="font-medium">{order.customer_name}</p>
                    <p className="text-xs text-muted-foreground">{order.items.length} items</p>
                  </div>
                  <div className="text-right">
                    <p className="text-sm font-bold tabular-nums">£{order.total_amount.toFixed(2)}</p>
                    <span className={`text-xs px-2 py-0.5 rounded-full ${
                      order.status === 'pending' ? 'bg-yellow-100 text-yellow-800' :
                      order.status === 'completed' ? 'bg-emerald-100 text-emerald-800' :
                      'bg-gray-100 text-gray-800'
                    }`}>
                      {order.status}
                    </span>
                  </div>
                </div>
              ))
            )}
          </div>
        </Card>
      </div>

      {/* Revenue & Conversion Widgets - Super Admin Only */}
      {isSuperAdmin && (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          <div className="lg:col-span-2">
            <QuoteConversionWidget showroomId={selectedShowroom} />
          </div>
          <AbandonedCartRecoveryCard />
        </div>
      )}

      {/* Marketing Funnel — last 7/30 days lead capture & recovery snapshot */}
      {isSuperAdmin && <MarketingFunnelCard />}

      {/* Return Heatmap — which products / suppliers drive refunds. Available
          to anyone who can see the dashboard (showroom managers benefit from
          knowing their own store's refund pattern too). */}
      <ReturnHeatmapCard />

      {/* 13 Jun 2026 — Owner Monthly Telegram Digest. Sends a compact
          "last month's totals" message to the configured Telegram chat
          on the chosen day of each month. Super-admin only — the card
          itself silently no-ops via 403 for other roles. */}
      {isSuperAdmin && (
        <AutoExportSchedulerCard
          kind="owner_digest"
          scope="global"
          title="Owner monthly Telegram digest"
          description="One Telegram message on the 1st of each month with last month's sales, quotes, petty cash, accountant emails delivered, and anything that needs your attention."
          testIdPrefix="auto-export-owner-digest"
        />
      )}

      {/* Stat Cards - At Bottom of Page */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {statCards.map((stat, index) => (
          <Card 
            key={index} 
            className="p-6 hover:shadow-md duration-200"
            data-testid={`stat-card-${stat.label.toLowerCase().replace(' ', '-')}`}
          >
            <div className="flex items-start justify-between">
              <div>
                <p className="text-xs font-mono uppercase tracking-widest text-muted-foreground mb-2">{stat.label}</p>
                <p className="text-3xl font-heading font-bold tracking-tightest tabular-nums">{stat.value}</p>
              </div>
              <stat.icon className={`h-8 w-8 ${stat.color}`} strokeWidth={1.5} />
            </div>
          </Card>
        ))}
      </div>
    </div>
  );
};
