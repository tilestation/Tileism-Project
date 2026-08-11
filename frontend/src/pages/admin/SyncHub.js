import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { toast } from 'sonner';
import { 
  RefreshCw, Package, AlertTriangle, Check, X, Plus, 
  ArrowUp, ArrowDown, Minus, Eye, Trash2, Clock,
  CheckCircle2, XCircle, AlertCircle, ChevronDown, ChevronUp,
  FileSpreadsheet, FileText, Download, Search, Link, Loader2, Lock
} from 'lucide-react';
import { Button } from '../../components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '../../components/ui/card';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '../../components/ui/dialog';
import { Input } from '../../components/ui/input';
import jsPDF from 'jspdf';
import autoTable from 'jspdf-autotable';
import * as XLSX from 'xlsx';

const API_URL = process.env.REACT_APP_BACKEND_URL;

// Supplier definitions
const SUPPLIERS = [
  { id: 'Verona', name: 'Verona', color: 'bg-blue-500' },
  { id: 'Splendour', name: 'Splendour', color: 'bg-teal-500' },
  { id: 'Ceramica Impex', name: 'Ceramica Impex', color: 'bg-purple-500' },
  { id: 'Wallcano', name: 'Wallcano', color: 'bg-orange-500' },
  { id: 'Tile Rite', name: 'Tile Rite', color: 'bg-red-500' },
  { id: 'Ultra Tile', name: 'Ultra Tile', color: 'bg-amber-500' },
];

export default function SyncHub() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const [loading, setLoading] = useState(true);
  
  // Initialize supplier from URL param or default to 'Verona'
  const initialSupplier = searchParams.get('supplier') || 'Verona';
  const [selectedSupplier, setSelectedSupplier] = useState(
    SUPPLIERS.find(s => s.id === initialSupplier) ? initialSupplier : 'Verona'
  );
  const [stagingData, setStagingData] = useState(null);
  const [stats, setStats] = useState({});
  const [applying, setApplying] = useState(false);
  const [expandedProduct, setExpandedProduct] = useState(null);
  const [showIgnoredList, setShowIgnoredList] = useState(false);
  const [ignoredProducts, setIgnoredProducts] = useState([]);
  const [searchTerm, setSearchTerm] = useState('');
  const [filterType, setFilterType] = useState('all'); // all, updates, new, no_stock
  const [clearanceProducts, setClearanceProducts] = useState({});  // Track which products are marked as clearance
  const [previewImage, setPreviewImage] = useState(null); // Image preview modal state
  const [bulkAddingNewProducts, setBulkAddingNewProducts] = useState(false); // Loading state for bulk add
  const [bulkAddProgress, setBulkAddProgress] = useState(null); // Progress tracking for bulk add
  const [selectedNewProducts, setSelectedNewProducts] = useState(new Set()); // Selected new products for bulk actions
  
  // Server-side sync state (for Splendour)
  const [serverSyncStatus, setServerSyncStatus] = useState(null);
  const [nightlyStatus, setNightlyStatus] = useState(null);
  const [serverSyncPolling, setServerSyncPolling] = useState(false);
  
  // Ceramica Impex Server-Side Sync state
  const [ceramicaSyncStatus, setCeramicaSyncStatus] = useState(null);
  const [ceramicaSyncPolling, setCeramicaSyncPolling] = useState(false);
  
  // Wallcano Server-Side Sync state
  const [wallcanoSyncStatus, setWallcanoSyncStatus] = useState(null);
  const [wallcanoSyncPolling, setWallcanoSyncPolling] = useState(false);
  
  // Single Product Sync state
  const [singleProductUrl, setSingleProductUrl] = useState('');
  const [singleProductLoading, setSingleProductLoading] = useState(false);
  const [singleProductResult, setSingleProductResult] = useState(null);
  const [showSingleProductForm, setShowSingleProductForm] = useState(false);
  
  // Edit Stock Modal state
  const [showEditStockModal, setShowEditStockModal] = useState(false);
  const [editingStockProduct, setEditingStockProduct] = useState(null);
  const [editStockForm, setEditStockForm] = useState({ stock_m2: '', stock_quantity: '' });

  // Filter products based on search term and filter type
  const filteredData = useMemo(() => {
    if (!stagingData) return null;
    
    let updates = stagingData.updates || [];
    let newProducts = stagingData.new_products || [];
    
    // Apply search filter
    if (searchTerm.trim()) {
      const term = searchTerm.toLowerCase().trim();
      updates = updates.filter(product => 
        (product.name || '').toLowerCase().includes(term) ||
        (product.sku || '').toLowerCase().includes(term) ||
        (product.category || '').toLowerCase().includes(term)
      );
      newProducts = newProducts.filter(product => 
        (product.name || '').toLowerCase().includes(term) ||
        (product.sku || '').toLowerCase().includes(term) ||
        (product.category || '').toLowerCase().includes(term)
      );
    }
    
    // Apply filter type
    if (filterType === 'updates') {
      newProducts = [];
    } else if (filterType === 'new') {
      updates = [];
    } else if (filterType === 'no_stock') {
      updates = updates.filter(p => !p.has_stock);
      newProducts = newProducts.filter(p => !p.has_stock);
    } else if (filterType === 'has_stock') {
      updates = updates.filter(p => p.has_stock);
      newProducts = newProducts.filter(p => p.has_stock);
    }

    return {
      ...stagingData,
      updates,
      new_products: newProducts,
      total_updates: updates.length,
      total_new: newProducts.length
    };
  }, [stagingData, searchTerm, filterType]);

  // Fetch staging data for selected supplier
  const fetchStagingData = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch(`${API_URL}/api/sync-staging/${encodeURIComponent(selectedSupplier)}`);
      if (response.ok) {
        const data = await response.json();
        setStagingData(data);
      } else {
        toast.error('Failed to fetch staging data');
      }
    } catch (error) {
      console.error('Error fetching staging data:', error);
      toast.error('Failed to load staging data');
    } finally {
      setLoading(false);
    }
  }, [selectedSupplier]);

  // Fetch stats for all suppliers
  const fetchStats = async () => {
    try {
      const response = await fetch(`${API_URL}/api/sync-staging/stats`);
      if (response.ok) {
        const data = await response.json();
        setStats(data.suppliers || {});
      }
    } catch (error) {
      console.error('Error fetching stats:', error);
    }
  };

  // Fetch ignored products
  const fetchIgnoredProducts = async () => {
    try {
      const response = await fetch(`${API_URL}/api/sync-staging/ignored`);
      if (response.ok) {
        const data = await response.json();
        setIgnoredProducts(data.ignored_products || []);
      }
    } catch (error) {
      console.error('Error fetching ignored products:', error);
    }
  };

  // Server-side sync functions (for Splendour)
  const startServerSync = async (mode = 'deep') => {
    try {
      const response = await fetch(`${API_URL}/api/supplier-sync/splendour/server-sync/start?mode=${mode}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      });
      const data = await response.json();
      
      if (data.success) {
        toast.success(`Splendour ${mode.toUpperCase()} sync started!`);
        setServerSyncPolling(true);
        pollServerSyncStatus();
      } else {
        toast.error(data.message || 'Failed to start sync');
      }
    } catch (error) {
      console.error('Error starting server sync:', error);
      toast.error('Failed to start server sync');
    }
  };

  const pollServerSyncStatus = async () => {
    try {
      const response = await fetch(`${API_URL}/api/supplier-sync/splendour/server-sync/status`);
      const status = await response.json();
      setServerSyncStatus(status);
      
      if (status.is_running) {
        // Refresh staging data while sync is running to show products as they're synced
        if (selectedSupplier === 'Splendour') {
          fetchStagingData();
          fetchStats();
        }
        // Continue polling
        setTimeout(pollServerSyncStatus, 2000);
      } else {
        setServerSyncPolling(false);
        if (status.phase === 'complete') {
          toast.success(`Sync complete! ${status.products_synced} products synced`);
          fetchStagingData();
          fetchStats();
        } else if (status.phase === 'error') {
          toast.error(status.message);
        }
      }
    } catch (error) {
      console.error('Error polling sync status:', error);
      setServerSyncPolling(false);
    }
  };

  const stopServerSync = async () => {
    try {
      await fetch(`${API_URL}/api/supplier-sync/splendour/server-sync/stop`, {
        method: 'POST'
      });
      toast.info('Stop signal sent');
    } catch (error) {
      console.error('Error stopping sync:', error);
    }
  };

  // Single Product Sync - Add product from any supplier URL
  const handleSingleProductSync = async (e) => {
    e.preventDefault();
    
    if (!singleProductUrl.trim()) {
      toast.error('Please enter a product URL');
      return;
    }
    
    // Basic URL validation
    if (!singleProductUrl.startsWith('http://') && !singleProductUrl.startsWith('https://')) {
      toast.error('Invalid URL. Please enter a valid URL starting with http:// or https://');
      return;
    }
    
    setSingleProductLoading(true);
    setSingleProductResult(null);
    
    try {
      const response = await fetch(`${API_URL}/api/supplier-sync/single-product`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: singleProductUrl.trim() })
      });
      
      const data = await response.json();
      
      if (response.ok && data.success) {
        setSingleProductResult(data);
        toast.success(`Product ${data.action === 'added' ? 'added' : 'updated'} successfully!`);
        // Refresh data after successful sync
        fetchStagingData();
        fetchStats();
      } else {
        toast.error(data.detail || data.error || 'Failed to sync product');
        setSingleProductResult({ success: false, error: data.detail || data.error });
      }
    } catch (error) {
      console.error('Single product sync error:', error);
      toast.error('Failed to sync product. Please try again.');
      setSingleProductResult({ success: false, error: error.message });
    } finally {
      setSingleProductLoading(false);
    }
  };
  
  // Reset single product form
  const resetSingleProductForm = () => {
    setSingleProductUrl('');
    setSingleProductResult(null);
  };

  // ==================== CERAMICA IMPEX SERVER-SIDE SYNC ====================
  const startCeramicaSync = async (mode = 'deep') => {
    try {
      const response = await fetch(`${API_URL}/api/supplier-sync/ceramica-impex/server-sync/start?mode=${mode}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      });
      const data = await response.json();
      
      if (data.success) {
        toast.success(`Ceramica Impex ${mode.toUpperCase()} sync started!`);
        setCeramicaSyncPolling(true);
        pollCeramicaSyncStatus();
      } else {
        toast.error(data.message || data.error || 'Failed to start sync');
      }
    } catch (error) {
      console.error('Error starting Ceramica sync:', error);
      toast.error('Failed to start Ceramica Impex sync');
    }
  };

  const pollCeramicaSyncStatus = async () => {
    try {
      const response = await fetch(`${API_URL}/api/supplier-sync/ceramica-impex/server-sync/status`);
      const status = await response.json();
      setCeramicaSyncStatus(status);
      
      if (status.is_running) {
        // Refresh staging data while sync is running to show products as they're synced
        if (selectedSupplier === 'Ceramica Impex') {
          fetchStagingData();
          fetchStats();
        }
        // Continue polling
        setTimeout(pollCeramicaSyncStatus, 2000);
      } else {
        setCeramicaSyncPolling(false);
        if (status.phase === 'complete') {
          toast.success(`Ceramica Impex sync complete! ${status.products_synced} products synced`);
          fetchStagingData();
          fetchStats();
        } else if (status.phase === 'error') {
          toast.error(status.message);
        }
      }
    } catch (error) {
      console.error('Error polling Ceramica sync status:', error);
      setCeramicaSyncPolling(false);
    }
  };

  const stopCeramicaSync = async () => {
    try {
      await fetch(`${API_URL}/api/supplier-sync/ceramica-impex/server-sync/stop`, {
        method: 'POST'
      });
      toast.info('Ceramica Impex sync stop signal sent');
    } catch (error) {
      console.error('Error stopping Ceramica sync:', error);
    }
  };

  // Wallcano Server-Side Sync functions
  const startWallcanoSync = async (mode = 'deep') => {
    try {
      const response = await fetch(`${API_URL}/api/supplier-sync/wallcano/server-sync/start?mode=${mode}`, {
        method: 'POST'
      });
      const data = await response.json();
      
      if (response.ok) {
        toast.success(`Wallcano sync started! Note: Prices must be set manually after sync.`);
        setWallcanoSyncPolling(true);
        pollWallcanoSyncStatus();
      } else {
        toast.error(data.message || data.error || 'Failed to start Wallcano sync');
      }
    } catch (error) {
      console.error('Error starting Wallcano sync:', error);
      toast.error('Failed to start Wallcano sync');
    }
  };

  const pollWallcanoSyncStatus = async () => {
    try {
      const response = await fetch(`${API_URL}/api/supplier-sync/wallcano/server-sync/status`);
      const status = await response.json();
      setWallcanoSyncStatus(status);
      
      if (status.is_running) {
        // Refresh staging data while sync is running to show products as they're synced
        if (selectedSupplier === 'Wallcano') {
          fetchStagingData();
          fetchStats();
        }
        // Continue polling
        setTimeout(pollWallcanoSyncStatus, 2000);
      } else {
        setWallcanoSyncPolling(false);
        if (status.phase === 'complete') {
          toast.success(`Wallcano sync complete! ${status.products_synced} products synced. Remember to set prices manually.`);
          fetchStagingData();
          fetchStats();
        } else if (status.phase === 'error') {
          toast.error(status.message);
        }
      }
    } catch (error) {
      console.error('Error polling Wallcano sync status:', error);
      setWallcanoSyncPolling(false);
    }
  };

  const stopWallcanoSync = async () => {
    try {
      await fetch(`${API_URL}/api/supplier-sync/wallcano/server-sync/stop`, {
        method: 'POST'
      });
      toast.info('Wallcano sync stop signal sent');
    } catch (error) {
      console.error('Error stopping Wallcano sync:', error);
    }
  };

  // Nightly auto-sync status + controls
  const fetchNightlyStatus = () => {
    fetch(`${API_URL}/api/supplier-sync/nightly/status`)
      .then(res => res.json())
      .then(setNightlyStatus)
      .catch(() => {});
  };

  useEffect(() => { fetchNightlyStatus(); }, []);

  const toggleNightly = async () => {
    if (!nightlyStatus) return;
    try {
      const res = await fetch(`${API_URL}/api/supplier-sync/nightly/toggle`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${localStorage.getItem('token')}` },
        body: JSON.stringify({ enabled: !nightlyStatus.enabled })
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      toast.success(`Nightly auto-sync turned ${!nightlyStatus.enabled ? 'ON' : 'OFF'}`);
      fetchNightlyStatus();
    } catch (err) {
      toast.error(`Could not update schedule: ${err.message}`);
    }
  };

  const runNightlyNow = async () => {
    if (!window.confirm('Run the nightly light sync for Splendour, Ceramica Impex & Wallcano right now? Takes roughly 30-45 minutes and stages updates for review.')) return;
    try {
      const res = await fetch(`${API_URL}/api/supplier-sync/nightly/run-now`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${localStorage.getItem('token')}` }
      });
      const r = await res.json();
      if (!res.ok || !r.ok) throw new Error(r.message || `HTTP ${res.status}`);
      toast.success('Nightly light sync started — watch each supplier tab for live progress');
      fetchNightlyStatus();
    } catch (err) {
      toast.error(`Could not start: ${err.message}`);
    }
  };

  // Check server sync status on mount for Splendour
  useEffect(() => {
    if (selectedSupplier === 'Splendour') {
      fetch(`${API_URL}/api/supplier-sync/splendour/server-sync/status`)
        .then(res => res.json())
        .then(status => {
          setServerSyncStatus(status);
          if (status.is_running) {
            setServerSyncPolling(true);
            pollServerSyncStatus();
          }
        })
        .catch(() => {});
    }
    // Check Ceramica Impex sync status
    if (selectedSupplier === 'Ceramica Impex') {
      fetch(`${API_URL}/api/supplier-sync/ceramica-impex/server-sync/status`)
        .then(res => res.json())
        .then(status => {
          setCeramicaSyncStatus(status);
          if (status.is_running) {
            setCeramicaSyncPolling(true);
            pollCeramicaSyncStatus();
          }
        })
        .catch(() => {});
    }
    // Check Wallcano sync status
    if (selectedSupplier === 'Wallcano') {
      fetch(`${API_URL}/api/supplier-sync/wallcano/server-sync/status`)
        .then(res => res.json())
        .then(status => {
          setWallcanoSyncStatus(status);
          if (status.is_running) {
            setWallcanoSyncPolling(true);
            pollWallcanoSyncStatus();
          }
        })
        .catch(() => {});
    }
  }, [selectedSupplier]);

  useEffect(() => {
    fetchStagingData();
    fetchStats();
    setSearchTerm(''); // Reset search when supplier changes
    setFilterType('all'); // Reset filter when supplier changes
  }, [fetchStagingData]);

  // Handle supplier change - also update URL
  const handleSupplierChange = (supplierId) => {
    setSelectedSupplier(supplierId);
    setSearchParams({ supplier: supplierId });
  };

  // Apply all changes for supplier
  const handleApplyAll = async () => {
    if (!stagingData?.can_apply_all) {
      toast.error('Cannot apply - some products have missing stock data');
      return;
    }

    if (!window.confirm(`Apply all ${stagingData.total_updates} updates to ${selectedSupplier} products?`)) {
      return;
    }

    setApplying(true);
    try {
      const response = await fetch(`${API_URL}/api/sync-staging/${encodeURIComponent(selectedSupplier)}/apply`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ product_ids: [] })
      });

      if (response.ok) {
        const result = await response.json();
        toast.success(result.message);
        fetchStagingData();
        fetchStats();
      } else {
        const error = await response.json();
        toast.error(error.detail || 'Failed to apply changes');
      }
    } catch (error) {
      console.error('Apply error:', error);
      toast.error('Failed to apply changes');
    } finally {
      setApplying(false);
    }
  };

  // Add new product to database
  const handleAddNewProduct = async (product, isClearance = false) => {
    if (!product.has_stock && !product.stock_m2 && !product.stock_quantity) {
      toast.error('Cannot add product without stock data. Click "Edit Stock" to add stock first.');
      return;
    }

    try {
      const response = await fetch(
        `${API_URL}/api/sync-staging/${encodeURIComponent(selectedSupplier)}/add-new-product/${product.id}`,
        { 
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ is_clearance: isClearance })
        }
      );

      if (response.ok) {
        const result = await response.json();
        const productType = isClearance ? 'Clearance' : 'New Collection';
        toast.success(`Product ${product.sku} added as ${productType}`);
        // Clear the clearance state for this product
        setClearanceProducts(prev => {
          const updated = { ...prev };
          delete updated[product.id];
          return updated;
        });
        fetchStagingData();
        fetchStats();
      } else {
        const error = await response.json();
        toast.error(error.detail || 'Failed to add product');
      }
    } catch (error) {
      console.error('Add product error:', error);
      toast.error('Failed to add product');
    }
  };

  // Delete single staged product
  const handleDeleteProduct = async (product) => {
    if (!window.confirm(`Delete "${product.name}" from staging?`)) {
      return;
    }

    try {
      const response = await fetch(`${API_URL}/api/sync-staging/${product.id}`, {
        method: 'DELETE'
      });

      if (response.ok) {
        toast.success(`Removed ${product.sku} from staging`);
        fetchStagingData();
        fetchStats();
      } else {
        const error = await response.json();
        toast.error(error.detail || 'Failed to delete product');
      }
    } catch (error) {
      console.error('Delete error:', error);
      toast.error('Failed to delete product');
    }
  };

  // Open Edit Stock Modal
  const handleEditStock = (product) => {
    setEditingStockProduct(product);
    setEditStockForm({
      stock_m2: product.stock_m2 || '',
      stock_quantity: product.stock_quantity || ''
    });
    setShowEditStockModal(true);
  };

  // Save Stock Data
  const handleSaveStock = async () => {
    if (!editingStockProduct) return;
    
    const stockM2 = parseFloat(editStockForm.stock_m2) || 0;
    const stockQty = parseInt(editStockForm.stock_quantity) || 0;
    
    if (stockM2 <= 0 && stockQty <= 0) {
      toast.error('Please enter a valid stock value');
      return;
    }

    try {
      const response = await fetch(`${API_URL}/api/sync-staging/${editingStockProduct.id}/update-stock`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          stock_m2: stockM2 > 0 ? stockM2 : null,
          stock_quantity: stockQty > 0 ? stockQty : null
        })
      });

      if (response.ok) {
        toast.success(`Stock updated for ${editingStockProduct.sku}`);
        setShowEditStockModal(false);
        setEditingStockProduct(null);
        fetchStagingData();
      } else {
        const error = await response.json();
        toast.error(error.detail || 'Failed to update stock');
      }
    } catch (error) {
      console.error('Update stock error:', error);
      toast.error('Failed to update stock');
    }
  };

  // Bulk add all new products to supplier_products database
  // Poll for bulk add progress
  const pollBulkAddProgress = async (supplierName) => {
    try {
      const response = await fetch(`${API_URL}/api/sync-staging/${encodeURIComponent(supplierName)}/bulk-add-progress`);
      if (response.ok) {
        const progress = await response.json();
        setBulkAddProgress(progress);
        
        if (progress.status === 'running') {
          // Continue polling
          setTimeout(() => pollBulkAddProgress(supplierName), 1000);
        } else if (progress.status === 'complete') {
          setBulkAddingNewProducts(false);
          toast.success(`Successfully added ${progress.added} products to database! (${progress.skipped} skipped)`);
          fetchStagingData();
          fetchStats();
          // Clear progress after a delay
          setTimeout(() => setBulkAddProgress(null), 5000);
        } else if (progress.status === 'error') {
          setBulkAddingNewProducts(false);
          toast.error(`Error: ${progress.error_message || 'Unknown error'}`);
        } else if (progress.status === 'stopped') {
          setBulkAddingNewProducts(false);
          toast.info(`Bulk add stopped. ${progress.added || 0} products added so far.`);
          fetchStagingData();
          fetchStats();
          setTimeout(() => setBulkAddProgress(null), 3000);
        }
      }
    } catch (error) {
      console.error('Error polling bulk add progress:', error);
    }
  };

  const handleBulkAddNewProducts = async () => {
    const newCount = filteredData?.total_new || 0;
    if (newCount === 0) {
      toast.error('No new products to add');
      return;
    }

    // Check if already running
    if (bulkAddProgress?.status === 'running') {
      toast.info(`Already adding products. Progress: ${bulkAddProgress.processed}/${bulkAddProgress.total}`);
      return;
    }

    if (!window.confirm(`Add ALL ${newCount} new products for ${selectedSupplier} to the database?\n\nThis will:\n• Apply pricing rules (Cost × 1.90 × 1.20 VAT)\n• Save all product images\n• Mark as "new_collection" products\n\nNote: You can switch tabs - the process will continue in the background.`)) {
      return;
    }

    setBulkAddingNewProducts(true);
    setBulkAddProgress({ status: 'starting', total: newCount, processed: 0, added: 0, skipped: 0 });
    
    try {
      // Start the background task
      const response = await fetch(`${API_URL}/api/sync-staging/${encodeURIComponent(selectedSupplier)}/start-bulk-add`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          is_clearance: false,
          apply_price_rules: true 
        })
      });

      if (response.ok) {
        const result = await response.json();
        
        if (result.status === 'started' || result.status === 'already_running') {
          toast.info(`${result.status === 'started' ? 'Started adding' : 'Resuming'} ${result.total || newCount} products...`);
          // Start polling for progress
          pollBulkAddProgress(selectedSupplier);
        } else if (result.status === 'no_products') {
          setBulkAddingNewProducts(false);
          setBulkAddProgress(null);
          toast.info('No products to add');
        }
      } else {
        const error = await response.json();
        setBulkAddingNewProducts(false);
        setBulkAddProgress(null);
        toast.error(error.detail || 'Failed to start adding products');
      }
    } catch (error) {
      console.error('Bulk add error:', error);
      setBulkAddingNewProducts(false);
      setBulkAddProgress(null);
      toast.error('Failed to start adding products to database');
    }
  };

  // Check for in-progress bulk add on mount and supplier change
  useEffect(() => {
    const checkBulkAddProgress = async () => {
      if (!selectedSupplier) return;
      
      try {
        const response = await fetch(`${API_URL}/api/sync-staging/${encodeURIComponent(selectedSupplier)}/bulk-add-progress`);
        if (response.ok) {
          const progress = await response.json();
          if (progress.status === 'running') {
            setBulkAddingNewProducts(true);
            setBulkAddProgress(progress);
            pollBulkAddProgress(selectedSupplier);
          }
        }
      } catch (error) {
        console.error('Error checking bulk add progress:', error);
      }
    };
    
    checkBulkAddProgress();
  }, [selectedSupplier]);
  // eslint-disable-next-line react-hooks/exhaustive-deps

  // Delete all staged products for supplier (bulk delete)
  const handleClearAll = async () => {
    const total = (stagingData?.total_updates || 0) + (stagingData?.total_new || 0);
    if (!window.confirm(`Delete ALL ${total} staged products for ${selectedSupplier}? This cannot be undone.`)) {
      return;
    }

    try {
      const response = await fetch(`${API_URL}/api/sync-staging/clear/${encodeURIComponent(selectedSupplier)}`, {
        method: 'DELETE'
      });

      if (response.ok) {
        const result = await response.json();
        toast.success(result.message);
        fetchStagingData();
        fetchStats();
      } else {
        const error = await response.json();
        toast.error(error.detail || 'Failed to clear staging');
      }
    } catch (error) {
      console.error('Clear error:', error);
      toast.error('Failed to clear staging');
    }
  };

  // Ignore product forever
  const handleIgnoreProduct = async (product) => {
    if (!window.confirm(`Ignore "${product.name}" forever? It will be automatically deleted on future syncs.`)) {
      return;
    }

    try {
      const response = await fetch(`${API_URL}/api/sync-staging/ignore`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sku: product.sku,
          supplier: selectedSupplier,
          reason: 'User ignored from Sync Hub'
        })
      });

      if (response.ok) {
        toast.success(`Product ${product.sku} will be ignored in future syncs`);
        fetchStagingData();
        fetchStats();
      } else {
        const error = await response.json();
        toast.error(error.detail || 'Failed to ignore product');
      }
    } catch (error) {
      console.error('Ignore error:', error);
      toast.error('Failed to ignore product');
    }
  };

  // Remove from ignored list
  const handleRemoveFromIgnored = async (sku, supplier) => {
    try {
      const response = await fetch(
        `${API_URL}/api/sync-staging/ignored/${encodeURIComponent(supplier)}/${encodeURIComponent(sku)}`,
        { method: 'DELETE' }
      );

      if (response.ok) {
        toast.success('Product removed from ignore list');
        fetchIgnoredProducts();
      } else {
        toast.error('Failed to remove from ignore list');
      }
    } catch (error) {
      console.error('Remove from ignored error:', error);
      toast.error('Failed to remove from ignore list');
    }
  };

  // Render stock change indicator
  const renderStockChange = (change) => {
    if (change === null || change === undefined) return <Minus className="w-4 h-4 text-gray-400" />;
    if (change > 0) return <ArrowUp className="w-4 h-4 text-green-500" />;
    if (change < 0) return <ArrowDown className="w-4 h-4 text-red-500" />;
    return <Minus className="w-4 h-4 text-gray-400" />;
  };

  // Render price change indicator
  const renderPriceChange = (change) => {
    if (change === null || change === undefined) return <Minus className="w-4 h-4 text-gray-400" />;
    if (change > 0) return <ArrowUp className="w-4 h-4 text-amber-500" />;
    if (change < 0) return <ArrowDown className="w-4 h-4 text-green-500" />;
    return <Minus className="w-4 h-4 text-gray-400" />;
  };

  // Export to Excel (proper xlsx format with column widths)
  const exportToExcel = () => {
    const hasUpdates = stagingData?.updates?.length > 0;
    const hasNewProducts = stagingData?.new_products?.length > 0;
    
    if (!hasUpdates && !hasNewProducts) {
      toast.error('No data to export');
      return;
    }

    try {
      toast.info('Preparing Excel export...');

      const updates = stagingData.updates || [];
      const newProducts = stagingData.new_products || [];
      
      // Separate products with and without stock
      const validUpdates = updates.filter(p => p.has_stock);
      const missingStockUpdates = updates.filter(p => !p.has_stock);
      const validNewProducts = newProducts.filter(p => p.has_stock);
      const missingStockNewProducts = newProducts.filter(p => !p.has_stock);

      // Calculate summary stats
      const stockIncreased = validUpdates.filter(u => u.stock_change > 0).length;
      const stockDecreased = validUpdates.filter(u => u.stock_change < 0).length;
      const priceIncreased = validUpdates.filter(u => u.price_change > 0).length;
      const priceDecreased = validUpdates.filter(u => u.price_change < 0).length;

      // Create workbook
      const wb = XLSX.utils.book_new();

      // Build data for the sheet
      const wsData = [
        [`Sync Hub - ${selectedSupplier} Stock/Price Comparison Report`],
        [`Generated: ${new Date().toLocaleString('en-GB')}`],
        [],
        ['SUMMARY'],
        ['Total Existing Product Updates', updates.length],
        ['Total New Products', newProducts.length],
        ['Products with Missing Stock', missingStockUpdates.length + missingStockNewProducts.length],
        ['Stock Increased', stockIncreased],
        ['Stock Decreased', stockDecreased],
        ['Price Increased', priceIncreased],
        ['Price Decreased', priceDecreased],
        []
      ];

      // Add valid updates section
      if (validUpdates.length > 0) {
        wsData.push(['EXISTING PRODUCT UPDATES (Ready to Apply)']);
        wsData.push(['Product Name', 'SKU', 'Previous Stock', 'New Stock', 'Stock Change', 'Stock Direction', 'Previous Cost (£)', 'New Cost (£)', 'Cost Change (£)', 'Cost Direction', 'Can Apply', 'Synced At']);
        
        validUpdates.forEach(p => {
          const newStock = p.stock_quantity || p.stock_m2 || 0;
          const stockDirection = p.stock_change > 0 ? 'INCREASE' : p.stock_change < 0 ? 'DECREASE' : 'NO CHANGE';
          const priceDirection = p.price_change > 0 ? 'INCREASE' : p.price_change < 0 ? 'DECREASE' : 'NO CHANGE';
          
          wsData.push([
            p.name || '',
            p.sku || '',
            p.current_stock?.toFixed(2) || '0',
            newStock?.toFixed(2) || '0',
            p.stock_change?.toFixed(2) || '0',
            stockDirection,
            p.current_price?.toFixed(2) || '0.00',
            p.price?.toFixed(2) || '0.00',
            p.price_change?.toFixed(2) || '0.00',
            priceDirection,
            p.can_apply ? 'Yes' : 'No',
            p.synced_at ? new Date(p.synced_at).toLocaleString('en-GB') : ''
          ]);
        });
        wsData.push([]);
      }

      // Add missing stock updates section
      if (missingStockUpdates.length > 0) {
        wsData.push(['⚠️ EXISTING PRODUCTS - MISSING STOCK DATA (Manual Check Required)']);
        wsData.push(['Product Name', 'SKU', 'Supplier Code', 'Price (£)', 'Synced At', 'Issue']);
        
        missingStockUpdates.forEach(p => {
          wsData.push([
            p.name || '',
            p.sku || '',
            p.supplier_code || '',
            p.price?.toFixed(2) || 'N/A',
            p.synced_at ? new Date(p.synced_at).toLocaleString('en-GB') : '',
            'Missing Stock'
          ]);
        });
        wsData.push([]);
      }

      // Add new products section
      if (validNewProducts.length > 0) {
        wsData.push(['NEW PRODUCTS DETECTED (Ready to Add)']);
        wsData.push(['Product Name', 'SKU', 'Stock', 'Price (£)', 'Category', 'Synced At']);
        
        validNewProducts.forEach(p => {
          const stock = p.stock_quantity || p.stock_m2 || 0;
          wsData.push([
            p.name || '',
            p.sku || '',
            stock?.toFixed(2) || '0',
            p.price?.toFixed(2) || 'N/A',
            p.category || '',
            p.synced_at ? new Date(p.synced_at).toLocaleString('en-GB') : ''
          ]);
        });
        wsData.push([]);
      }

      // Add missing stock new products section
      if (missingStockNewProducts.length > 0) {
        wsData.push(['⚠️ NEW PRODUCTS - MISSING STOCK DATA (Manual Check Required)']);
        wsData.push(['Product Name', 'SKU', 'Supplier Code', 'Price (£)', 'Category', 'Synced At', 'Issue']);
        
        missingStockNewProducts.forEach(p => {
          wsData.push([
            p.name || '',
            p.sku || '',
            p.supplier_code || '',
            p.price?.toFixed(2) || 'N/A',
            p.category || '',
            p.synced_at ? new Date(p.synced_at).toLocaleString('en-GB') : '',
            'Missing Stock'
          ]);
        });
      }

      // Create worksheet
      const ws = XLSX.utils.aoa_to_sheet(wsData);

      // Set column widths (in characters)
      ws['!cols'] = [
        { wch: 45 },  // Product Name
        { wch: 18 },  // SKU
        { wch: 15 },  // Previous Stock / Stock
        { wch: 15 },  // New Stock
        { wch: 15 },  // Stock Change
        { wch: 15 },  // Stock Direction
        { wch: 18 },  // Previous Price
        { wch: 15 },  // New Price
        { wch: 15 },  // Price Change
        { wch: 15 },  // Price Direction
        { wch: 12 },  // Can Apply
        { wch: 22 }   // Synced At
      ];

      // Add worksheet to workbook
      XLSX.utils.book_append_sheet(wb, ws, `${selectedSupplier} Comparison`);

      // Generate file and download
      const fileName = `sync-hub-comparison-${selectedSupplier.toLowerCase().replace(/\s+/g, '-')}-${new Date().toISOString().split('T')[0]}.xlsx`;
      XLSX.writeFile(wb, fileName);

      toast.success('Excel export downloaded!');
    } catch (error) {
      console.error('Export error:', error);
      toast.error('Failed to export to Excel');
    }
  };

  // Export to PDF
  const exportToPDF = () => {
    const hasUpdates = stagingData?.updates?.length > 0;
    const hasNewProducts = stagingData?.new_products?.length > 0;
    
    if (!hasUpdates && !hasNewProducts) {
      toast.error('No data to export');
      return;
    }

    try {
      toast.info('Generating PDF...');

      const updates = stagingData.updates || [];
      const newProducts = stagingData.new_products || [];
      
      // Separate products with and without stock
      const validUpdates = updates.filter(p => p.has_stock);
      const missingStockUpdates = updates.filter(p => !p.has_stock);
      const validNewProducts = newProducts.filter(p => p.has_stock);
      const missingStockNewProducts = newProducts.filter(p => !p.has_stock);
      
      // Create PDF document (landscape for more columns)
      const doc = new jsPDF('landscape', 'mm', 'a4');
      
      // Add header
      doc.setFontSize(20);
      doc.setFont('helvetica', 'bold');
      doc.text(`${selectedSupplier} - Stock/Price Comparison Report`, 14, 15);
      
      // Add metadata
      doc.setFontSize(10);
      doc.setFont('helvetica', 'normal');
      doc.setTextColor(100);
      doc.text(`Generated: ${new Date().toLocaleDateString('en-GB')} at ${new Date().toLocaleTimeString('en-GB')}`, 14, 22);
      doc.text(`Total Updates: ${updates.length} | New Products: ${newProducts.length} | Missing Stock: ${missingStockUpdates.length + missingStockNewProducts.length}`, 14, 27);
      doc.setTextColor(0);

      // Calculate summary stats for valid updates
      const stockIncreased = validUpdates.filter(u => u.stock_change > 0).length;
      const stockDecreased = validUpdates.filter(u => u.stock_change < 0).length;
      const stockNoChange = validUpdates.filter(u => u.stock_change === 0 || u.stock_change === null).length;
      const priceIncreased = validUpdates.filter(u => u.price_change > 0).length;
      const priceDecreased = validUpdates.filter(u => u.price_change < 0).length;
      const priceNoChange = validUpdates.filter(u => u.price_change === 0 || u.price_change === null).length;

      // Add summary box
      doc.setFillColor(240, 249, 255);
      doc.roundedRect(14, 32, 180, 28, 3, 3, 'F');
      doc.setFontSize(11);
      doc.setFont('helvetica', 'bold');
      doc.text('SUMMARY', 18, 40);
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(9);
      doc.text(`Stock: ${stockIncreased} increased, ${stockDecreased} decreased, ${stockNoChange} no change`, 18, 47);
      doc.text(`Price: ${priceIncreased} increased, ${priceDecreased} decreased, ${priceNoChange} no change`, 18, 54);
      
      // Warning box for missing stock
      if (missingStockUpdates.length + missingStockNewProducts.length > 0) {
        doc.setFillColor(254, 243, 199); // Amber background
        doc.roundedRect(150, 32, 44, 28, 3, 3, 'F');
        doc.setTextColor(180, 83, 9);
        doc.setFontSize(9);
        doc.setFont('helvetica', 'bold');
        doc.text('NEEDS CHECK', 154, 40);
        doc.setFont('helvetica', 'normal');
        doc.text(`${missingStockUpdates.length + missingStockNewProducts.length} products`, 154, 47);
        doc.text('missing stock', 154, 54);
        doc.setTextColor(0);
      }

      let currentY = 65;

      // Valid updates table
      if (validUpdates.length > 0) {
        const tableHeaders = [
          'Product Name', 'SKU', 'Old Stock', 'New Stock', 'Stock Change', 'Old Cost', 'New Cost', 'Cost Change', 'Status'
        ];

        const tableData = validUpdates.map(p => {
          const newStock = p.stock_quantity || p.stock_m2 || 0;
          const stockChangeText = p.stock_change > 0 ? `+${p.stock_change?.toFixed(1)}` : p.stock_change?.toFixed(1) || '0';
          const priceChangeText = p.price_change > 0 ? `+£${p.price_change?.toFixed(2)}` : p.price_change ? `£${p.price_change?.toFixed(2)}` : '£0.00';
          
          return [
            (p.name || '-').substring(0, 40) + ((p.name || '').length > 40 ? '...' : ''),
            p.sku || '-',
            p.current_stock?.toFixed(1) || '0',
            newStock?.toFixed(1) || '0',
            stockChangeText,
            `£${p.current_price?.toFixed(2) || '0.00'}`,
            `£${p.price?.toFixed(2) || '0.00'}`,
            priceChangeText,
            'Ready'
          ];
        });

        autoTable(doc, {
          startY: currentY,
          head: [tableHeaders],
          body: tableData,
          theme: 'striped',
          headStyles: {
            fillColor: [51, 51, 51],
            textColor: [247, 234, 28],
            fontStyle: 'bold',
            fontSize: 8
          },
          bodyStyles: {
            fontSize: 8
          },
          columnStyles: {
            0: { cellWidth: 55 },
            1: { cellWidth: 25 },
            2: { cellWidth: 20, halign: 'right' },
            3: { cellWidth: 20, halign: 'right' },
            4: { cellWidth: 20, halign: 'right' },
            5: { cellWidth: 22, halign: 'right' },
            6: { cellWidth: 22, halign: 'right' },
            7: { cellWidth: 22, halign: 'right' },
            8: { cellWidth: 18, halign: 'center' }
          },
          didParseCell: function(data) {
            if (data.column.index === 4 && data.section === 'body') {
              const value = parseFloat(data.cell.raw);
              if (value > 0) {
                data.cell.styles.textColor = [34, 197, 94];
                data.cell.styles.fontStyle = 'bold';
              } else if (value < 0) {
                data.cell.styles.textColor = [239, 68, 68];
                data.cell.styles.fontStyle = 'bold';
              }
            }
            if (data.column.index === 7 && data.section === 'body') {
              const text = data.cell.raw;
              if (text.includes('+')) {
                data.cell.styles.textColor = [245, 158, 11];
                data.cell.styles.fontStyle = 'bold';
              } else if (text.includes('-')) {
                data.cell.styles.textColor = [34, 197, 94];
                data.cell.styles.fontStyle = 'bold';
              }
            }
            if (data.column.index === 8 && data.section === 'body') {
              data.cell.styles.textColor = [34, 197, 94];
            }
          }
        });
        currentY = doc.lastAutoTable.finalY + 10;
      }

      // Missing stock updates table (highlighted in red/amber)
      if (missingStockUpdates.length > 0) {
        doc.setFontSize(12);
        doc.setFont('helvetica', 'bold');
        doc.setTextColor(180, 83, 9);
        doc.text('⚠ MISSING STOCK - Existing Products (Manual Check Required)', 14, currentY);
        doc.setTextColor(0);
        currentY += 5;

        const missingHeaders = ['Product Name', 'SKU', 'Supplier Code', 'Price (£)', 'Synced At', 'Issue'];
        const missingData = missingStockUpdates.map(p => [
          (p.name || '-').substring(0, 45) + ((p.name || '').length > 45 ? '...' : ''),
          p.sku || '-',
          p.supplier_code || '-',
          p.price ? `£${p.price.toFixed(2)}` : 'N/A',
          p.synced_at ? new Date(p.synced_at).toLocaleString('en-GB') : '-',
          'Missing Stock'
        ]);

        autoTable(doc, {
          startY: currentY,
          head: [missingHeaders],
          body: missingData,
          theme: 'striped',
          headStyles: {
            fillColor: [180, 83, 9],
            textColor: [255, 255, 255],
            fontStyle: 'bold',
            fontSize: 8
          },
          bodyStyles: {
            fontSize: 8
          },
          columnStyles: {
            0: { cellWidth: 70 },
            1: { cellWidth: 30 },
            2: { cellWidth: 30 },
            3: { cellWidth: 25, halign: 'right' },
            4: { cellWidth: 40 },
            5: { cellWidth: 30 }
          },
          didParseCell: function(data) {
            if (data.column.index === 5 && data.section === 'body') {
              data.cell.styles.textColor = [239, 68, 68];
              data.cell.styles.fontStyle = 'bold';
            }
          }
        });
        currentY = doc.lastAutoTable.finalY + 10;
      }

      // New products with missing stock
      if (missingStockNewProducts.length > 0) {
        // Check if we need a new page
        if (currentY > 170) {
          doc.addPage();
          currentY = 20;
        }

        doc.setFontSize(12);
        doc.setFont('helvetica', 'bold');
        doc.setTextColor(180, 83, 9);
        doc.text('⚠ MISSING STOCK - New Products (Manual Check Required)', 14, currentY);
        doc.setTextColor(0);
        currentY += 5;

        const newMissingHeaders = ['Product Name', 'SKU', 'Category', 'Price (£)', 'Synced At', 'Issue'];
        const newMissingData = missingStockNewProducts.map(p => [
          (p.name || '-').substring(0, 45) + ((p.name || '').length > 45 ? '...' : ''),
          p.sku || '-',
          (p.category || '-').substring(0, 20),
          p.price ? `£${p.price.toFixed(2)}` : 'N/A',
          p.synced_at ? new Date(p.synced_at).toLocaleString('en-GB') : '-',
          'Missing Stock'
        ]);

        autoTable(doc, {
          startY: currentY,
          head: [newMissingHeaders],
          body: newMissingData,
          theme: 'striped',
          headStyles: {
            fillColor: [180, 83, 9],
            textColor: [255, 255, 255],
            fontStyle: 'bold',
            fontSize: 8
          },
          bodyStyles: {
            fontSize: 8
          },
          columnStyles: {
            0: { cellWidth: 70 },
            1: { cellWidth: 30 },
            2: { cellWidth: 30 },
            3: { cellWidth: 25, halign: 'right' },
            4: { cellWidth: 40 },
            5: { cellWidth: 30 }
          },
          didParseCell: function(data) {
            if (data.column.index === 5 && data.section === 'body') {
              data.cell.styles.textColor = [239, 68, 68];
              data.cell.styles.fontStyle = 'bold';
            }
          }
        });
      }

      // Add footer to all pages
      const pageCount = doc.internal.getNumberOfPages();
      for (let i = 1; i <= pageCount; i++) {
        doc.setPage(i);
        doc.setFontSize(8);
        doc.setTextColor(150);
        doc.text(`Page ${i} of ${pageCount}`, doc.internal.pageSize.width - 25, doc.internal.pageSize.height - 10);
        doc.text('Tile Station - Sync Hub Comparison Report', 14, doc.internal.pageSize.height - 10);
      }

      // Save PDF
      doc.save(`sync-hub-comparison-${selectedSupplier.toLowerCase()}-${new Date().toISOString().split('T')[0]}.pdf`);
      
      toast.success('PDF report downloaded!');
    } catch (error) {
      console.error('PDF export error:', error);
      toast.error('Failed to generate PDF');
    }
  };

  return (
    <div className="p-6 space-y-6" data-testid="sync-hub-page">
      {/* Floating Progress Bar - Always visible when adding products */}
      {bulkAddingNewProducts && (
        <div className="fixed top-0 left-0 right-0 z-50 bg-green-600 text-white shadow-lg">
          <div className="max-w-7xl mx-auto px-4 py-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <Loader2 className="w-5 h-5 animate-spin" />
                <span className="font-medium">
                  Adding {selectedSupplier} products to database...
                </span>
              </div>
              <div className="flex items-center gap-4">
                <span className="text-green-100">
                  ✓ {bulkAddProgress?.added || 0} added
                </span>
                <span className="text-green-100">
                  ⊘ {bulkAddProgress?.skipped || 0} skipped
                </span>
                <span className="font-bold text-lg">
                  {bulkAddProgress?.processed || 0} / {bulkAddProgress?.total || 0}
                </span>
                <Button
                  size="sm"
                  variant="ghost"
                  className="text-white hover:bg-red-600 hover:text-white border border-white/30"
                  onClick={async () => {
                    try {
                      await fetch(`${API_URL}/api/sync-staging/${encodeURIComponent(selectedSupplier)}/stop-bulk-add`, { method: 'POST' });
                      setBulkAddingNewProducts(false);
                      setBulkAddProgress(null);
                      toast.success('Bulk add stopped');
                      fetchStagingData();
                    } catch { toast.error('Failed to stop'); }
                  }}
                  data-testid="stop-bulk-add-btn"
                >
                  <X className="w-4 h-4 mr-1" /> Stop
                </Button>
              </div>
            </div>
            <div className="mt-2 w-full bg-green-500 rounded-full h-2">
              <div 
                className="bg-white h-2 rounded-full transition-all duration-300 ease-out"
                style={{ 
                  width: `${bulkAddProgress?.total > 0 ? (bulkAddProgress.processed / bulkAddProgress.total) * 100 : 0}%` 
                }}
              />
            </div>
          </div>
        </div>
      )}
      
      {/* Spacer when floating bar is visible */}
      {bulkAddingNewProducts && <div className="h-20" />}
      
      {/* Header */}
      <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 flex items-center gap-2">
            <RefreshCw className="w-7 h-7" />
            Sync Hub
          </h1>
          <p className="text-gray-500">Review and apply product sync data before updating Supplier Products</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button 
            variant="outline" 
            onClick={() => { fetchStagingData(); fetchStats(); }}
          >
            <RefreshCw className="w-4 h-4 mr-2" />
            Refresh
          </Button>
          <Button 
            variant="outline"
            onClick={exportToExcel}
            disabled={!stagingData?.updates?.length && !stagingData?.new_products?.length}
            className="text-green-600 border-green-300 hover:bg-green-50"
            data-testid="export-excel-btn"
          >
            <FileSpreadsheet className="w-4 h-4 mr-2" />
            Export Excel
          </Button>
          <Button 
            variant="outline"
            onClick={exportToPDF}
            disabled={!stagingData?.updates?.length && !stagingData?.new_products?.length}
            className="text-red-600 border-red-300 hover:bg-red-50"
            data-testid="export-pdf-btn"
          >
            <FileText className="w-4 h-4 mr-2" />
            Export PDF
          </Button>
          <Button 
            variant="outline"
            onClick={() => { setShowIgnoredList(true); fetchIgnoredProducts(); }}
          >
            <XCircle className="w-4 h-4 mr-2" />
            Ignored Products
          </Button>
          <Button 
            variant="outline"
            onClick={handleClearAll}
            disabled={!stagingData?.total_updates && !stagingData?.total_new}
            className="text-red-600 border-red-300 hover:bg-red-50"
            data-testid="clear-all-btn"
          >
            <Trash2 className="w-4 h-4 mr-2" />
            Clear All Staged
          </Button>
          <Button 
            variant="outline"
            onClick={() => navigate('/admin/supplier-products')}
          >
            <Package className="w-4 h-4 mr-2" />
            View Supplier Products
          </Button>
        </div>
      </div>

      {/* Single Product Sync - Add product from any URL */}
      <Card className="border-indigo-200 bg-gradient-to-r from-indigo-50 to-purple-50">
        <CardContent className="py-4">
          <div className="flex items-start justify-between gap-4">
            <div className="flex items-start gap-3 flex-1">
              <div className="w-10 h-10 rounded-full bg-indigo-100 flex items-center justify-center flex-shrink-0">
                <Link className="w-5 h-5 text-indigo-600" />
              </div>
              <div className="flex-1">
                <h3 className="font-semibold text-indigo-900">Single Product Sync</h3>
                <p className="text-sm text-indigo-700 mb-3">
                  Add a product from any supplier's website using just the URL. Auto-detects supplier and extracts all product details.
                </p>
                
                {!showSingleProductForm ? (
                  <Button 
                    onClick={() => setShowSingleProductForm(true)}
                    className="bg-indigo-600 hover:bg-indigo-700 text-white"
                    data-testid="show-single-product-form-btn"
                  >
                    <Plus className="w-4 h-4 mr-2" />
                    Add Product from URL
                  </Button>
                ) : (
                  <div className="space-y-4">
                    <form onSubmit={handleSingleProductSync} className="flex gap-2">
                      <div className="flex-1 relative">
                        <Link className="absolute left-3 top-1/2 transform -translate-y-1/2 w-4 h-4 text-gray-400" />
                        <Input
                          type="url"
                          placeholder="https://www.supplier-website.com/product/example-tile"
                          value={singleProductUrl}
                          onChange={(e) => setSingleProductUrl(e.target.value)}
                          className="pl-10 bg-white"
                          disabled={singleProductLoading}
                          data-testid="single-product-url-input"
                        />
                      </div>
                      <Button
                        type="submit"
                        disabled={singleProductLoading || !singleProductUrl.trim()}
                        className="bg-indigo-600 hover:bg-indigo-700 text-white min-w-[120px]"
                        data-testid="single-product-sync-btn"
                      >
                        {singleProductLoading ? (
                          <>
                            <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                            Syncing...
                          </>
                        ) : (
                          <>
                            <RefreshCw className="w-4 h-4 mr-2" />
                            Sync Product
                          </>
                        )}
                      </Button>
                      <Button
                        type="button"
                        variant="outline"
                        onClick={() => {
                          setShowSingleProductForm(false);
                          resetSingleProductForm();
                        }}
                        className="border-gray-300"
                        data-testid="cancel-single-product-btn"
                      >
                        <X className="w-4 h-4" />
                      </Button>
                    </form>
                    
                    {/* Result Display */}
                    {singleProductResult && (
                      <div className={`p-4 rounded-lg ${
                        singleProductResult.success 
                          ? 'bg-green-50 border border-green-200' 
                          : 'bg-red-50 border border-red-200'
                      }`} data-testid="single-product-result">
                        {singleProductResult.success ? (
                          <div className="space-y-3">
                            <div className="flex items-center gap-2 text-green-700">
                              <CheckCircle2 className="w-5 h-5" />
                              <span className="font-semibold">
                                Product {singleProductResult.action === 'added' ? 'Added' : 'Updated'} Successfully!
                              </span>
                            </div>
                            
                            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-sm">
                              <div className="space-y-1">
                                <p className="text-green-800">
                                  <span className="font-medium">Supplier:</span> {singleProductResult.supplier}
                                  {singleProductResult.supplier_info?.is_new && (
                                    <span className="ml-2 text-xs bg-green-500 text-white px-2 py-0.5 rounded-full">NEW</span>
                                  )}
                                </p>
                                <p className="text-green-800">
                                  <span className="font-medium">SKU:</span> {singleProductResult.product?.sku || 'N/A'}
                                </p>
                                <p className="text-green-800">
                                  <span className="font-medium">Name:</span> {singleProductResult.product?.display_name || singleProductResult.product?.original_name || 'N/A'}
                                </p>
                              </div>
                              <div className="space-y-1">
                                {singleProductResult.product?.cost_price && (
                                  <p className="text-green-800">
                                    <span className="font-medium">Cost:</span> £{singleProductResult.product.cost_price?.toFixed(2)}
                                  </p>
                                )}
                                {singleProductResult.product?.list_price && (
                                  <p className="text-green-800">
                                    <span className="font-medium">List Price:</span> £{singleProductResult.product.list_price?.toFixed(2)}
                                  </p>
                                )}
                                {singleProductResult.product?.size && (
                                  <p className="text-green-800">
                                    <span className="font-medium">Size:</span> {singleProductResult.product.size}
                                  </p>
                                )}
                                {singleProductResult.product?.images_count > 0 && (
                                  <p className="text-green-800">
                                    <span className="font-medium">Images:</span> {singleProductResult.product.images_count} extracted
                                  </p>
                                )}
                              </div>
                            </div>
                            
                            <div className="flex gap-2 pt-2">
                              <Button
                                size="sm"
                                variant="outline"
                                onClick={() => {
                                  resetSingleProductForm();
                                }}
                                className="border-green-300 text-green-700 hover:bg-green-50"
                              >
                                <Plus className="w-4 h-4 mr-1" />
                                Add Another
                              </Button>
                              <Button
                                size="sm"
                                variant="outline"
                                onClick={() => navigate('/admin/supplier-products')}
                                className="border-green-300 text-green-700 hover:bg-green-50"
                              >
                                <Package className="w-4 h-4 mr-1" />
                                View in Supplier Products
                              </Button>
                            </div>
                          </div>
                        ) : (
                          <div className="flex items-center gap-2 text-red-700">
                            <XCircle className="w-5 h-5" />
                            <span className="font-medium">
                              Failed: {singleProductResult.error || 'Unknown error occurred'}
                            </span>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Nightly Auto-Sync strip */}
      {nightlyStatus && (
        <div className="flex items-center justify-between flex-wrap gap-2 px-4 py-2 rounded-lg bg-slate-50 border border-slate-200 text-sm" data-testid="nightly-sync-strip">
          <div className="flex items-center gap-2 flex-wrap text-slate-700">
            <Clock className="w-4 h-4 text-slate-500" />
            <span className="font-medium">Nightly auto-sync</span>
            <span className={`px-1.5 py-0.5 rounded text-xs font-semibold ${nightlyStatus.enabled ? 'bg-emerald-100 text-emerald-700' : 'bg-gray-200 text-gray-600'}`} data-testid="nightly-sync-state">
              {nightlyStatus.is_running ? 'RUNNING…' : (nightlyStatus.enabled ? 'ON' : 'OFF')}
            </span>
            <span className="text-slate-500 text-xs">
              Light sync (stock &amp; prices) for Splendour, Ceramica Impex &amp; Wallcano at {nightlyStatus.schedule?.split(' ')[0]} — updates are staged here for your morning review, never auto-applied
            </span>
            {nightlyStatus.last_run && (
              <span className="text-slate-500 text-xs" data-testid="nightly-last-run">
                · Last ran {new Date(nightlyStatus.last_run.started_at).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })} ({nightlyStatus.last_run.total_synced} refreshed)
              </span>
            )}
          </div>
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={runNightlyNow}
              disabled={nightlyStatus.is_running}
              className="text-xs text-slate-500 hover:text-slate-800 underline disabled:opacity-40"
              data-testid="nightly-run-now-link"
            >
              Run now
            </button>
            <button
              type="button"
              onClick={toggleNightly}
              className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${nightlyStatus.enabled ? 'bg-emerald-500' : 'bg-gray-300'}`}
              data-testid="nightly-sync-toggle"
              title={nightlyStatus.enabled ? 'Turn nightly sync off' : 'Turn nightly sync on'}
            >
              <span className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform ${nightlyStatus.enabled ? 'translate-x-4.5 translate-x-[18px]' : 'translate-x-[3px]'}`} />
            </button>
          </div>
        </div>
      )}

      {/* Supplier Tabs */}
      <div className="flex flex-wrap gap-2 border-b pb-4">
        {SUPPLIERS.map(supplier => {
          const count = stats[supplier.id]?.count || 0;
          const isActive = selectedSupplier === supplier.id;
          
          return (
            <button
              key={supplier.id}
              onClick={() => handleSupplierChange(supplier.id)}
              className={`
                px-4 py-2 rounded-lg font-medium transition-all flex items-center gap-2
                ${isActive 
                  ? 'bg-gray-900 text-white shadow-lg' 
                  : 'bg-gray-100 text-gray-700 hover:bg-gray-200'}
              `}
              data-testid={`supplier-tab-${supplier.id}`}
            >
              <span className={`w-2 h-2 rounded-full ${supplier.color}`} />
              {supplier.name}
              {count > 0 && (
                <span className={`
                  text-xs px-2 py-0.5 rounded-full
                  ${isActive ? 'bg-white/20' : 'bg-amber-100 text-amber-700'}
                `}>
                  {count}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {/* Verona Browser Extension (Verona has no server-side sync — it uses the Chrome extension) */}
      {selectedSupplier === 'Verona' && (
        <Card className="border-blue-200 bg-blue-50">
          <CardContent className="py-4">
            <div className="flex items-center justify-between flex-wrap gap-3">
              <div className="flex items-center gap-3">
                <div className="w-3 h-3 rounded-full bg-blue-500" />
                <div>
                  <h3 className="font-semibold text-blue-900">Browser Extension Sync</h3>
                  <p className="text-sm text-blue-700">
                    Verona syncs via the Chrome extension — browse veronagroup.co, click the extension icon and it stages products here for review
                  </p>
                </div>
              </div>
              <Button
                onClick={() => { window.location.href = `${API_URL}/api/supplier-sync/verona/extension/download`; }}
                className="bg-blue-600 hover:bg-blue-700 text-white"
                data-testid="download-verona-extension-btn"
              >
                <Download className="w-4 h-4 mr-2" />
                Download Extension v4.9
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Server-Side Sync Button (Splendour) */}
      {selectedSupplier === 'Splendour' && (
        <Card className="border-teal-200 bg-teal-50">
          <CardContent className="py-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className={`w-3 h-3 rounded-full ${serverSyncStatus?.is_running ? 'bg-teal-500 animate-pulse' : 'bg-teal-500'}`} />
                <div>
                  <h3 className="font-semibold text-teal-900">Server-Side Sync</h3>
                  <p className="text-sm text-teal-700">
                    {serverSyncStatus?.is_running 
                      ? serverSyncStatus.message 
                      : 'Automatically crawl all Splendour products from the server'}
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-3">
                {serverSyncStatus?.is_running && (
                  <div className="text-sm text-teal-800">
                    <span className="font-medium">{serverSyncStatus.progress}%</span>
                    <span className="mx-2">|</span>
                    {serverSyncStatus.phase === 'syncing' ? (
                      <span>{serverSyncStatus.products_synced || 0} synced</span>
                    ) : (
                      <span>{serverSyncStatus.products_found || 0} found</span>
                    )}
                  </div>
                )}
                {serverSyncStatus?.is_running ? (
                  <Button 
                    onClick={stopServerSync}
                    variant="outline"
                    className="border-red-300 text-red-600 hover:bg-red-50"
                    data-testid="stop-server-sync-btn"
                  >
                    <X className="w-4 h-4 mr-2" />
                    Stop
                  </Button>
                ) : (
                  <div className="flex gap-2">
                    <Button 
                      onClick={() => startServerSync('light')}
                      variant="outline"
                      className="border-teal-300 text-teal-700 hover:bg-teal-100"
                      data-testid="start-splendour-light-sync-btn"
                    >
                      <RefreshCw className="w-4 h-4 mr-2" />
                      Light Sync
                    </Button>
                    <Button 
                      onClick={() => startServerSync('deep')}
                      className="bg-teal-600 hover:bg-teal-700 text-white"
                      data-testid="start-splendour-deep-sync-btn"
                    >
                      <RefreshCw className="w-4 h-4 mr-2" />
                      Full Sync
                    </Button>
                  </div>
                )}
              </div>
            </div>
            {serverSyncStatus?.is_running && (
              <div className="mt-3">
                <div className="w-full bg-teal-200 rounded-full h-2">
                  <div 
                    className="bg-teal-600 h-2 rounded-full transition-all duration-500"
                    style={{ width: `${serverSyncStatus.progress || 0}%` }}
                  />
                </div>
                
                {/* Current Product Being Synced */}
                {serverSyncStatus.current_product && (
                  <div className="mt-4 p-3 bg-white rounded-lg border border-teal-200 flex items-center gap-4">
                    {/* Product Image */}
                    <div 
                      className="w-20 h-20 flex-shrink-0 bg-gray-100 rounded-lg overflow-hidden cursor-pointer hover:ring-2 hover:ring-teal-400 transition-all"
                      onClick={() => serverSyncStatus.current_product.image && setPreviewImage({ 
                        url: serverSyncStatus.current_product.image, 
                        name: serverSyncStatus.current_product.name 
                      })}
                    >
                      {serverSyncStatus.current_product.image ? (
                        <img 
                          src={serverSyncStatus.current_product.image} 
                          alt={serverSyncStatus.current_product.name}
                          className="w-full h-full object-cover"
                          onError={(e) => { e.target.style.display = 'none'; }}
                        />
                      ) : (
                        <div className="w-full h-full flex items-center justify-center text-gray-400">
                          <Package className="w-8 h-8" />
                        </div>
                      )}
                    </div>
                    
                    {/* Product Info */}
                    <div className="flex-1 min-w-0">
                      <p className="font-medium text-teal-900 truncate">
                        {serverSyncStatus.current_product.display_name || serverSyncStatus.current_product.name || 'Loading...'}
                      </p>
                      {serverSyncStatus.current_product.display_name && serverSyncStatus.current_product.display_name !== serverSyncStatus.current_product.name && (
                        <p className="text-xs text-gray-500 truncate">
                          Original: {serverSyncStatus.current_product.name}
                        </p>
                      )}
                      <p className="text-sm text-teal-600">
                        SKU: {serverSyncStatus.current_product.sku || '-'}
                      </p>
                      <div className="flex gap-4 mt-1 text-sm">
                        <span className="text-green-600">
                          Stock: {serverSyncStatus.current_product.stock_m2?.toFixed(2) || '0'} m²
                        </span>
                        {serverSyncStatus.current_product.cost_price && (
                          <span className="text-blue-600">
                            Cost: £{serverSyncStatus.current_product.cost_price?.toFixed(2)}
                          </span>
                        )}
                        {serverSyncStatus.current_product.price && (
                          <span className="text-teal-600">
                            Price: £{serverSyncStatus.current_product.price?.toFixed(2)}
                          </span>
                        )}
                      </div>
                    </div>
                    
                    {/* Syncing Indicator */}
                    <div className="flex-shrink-0">
                      <div className="w-8 h-8 border-3 border-teal-500 border-t-transparent rounded-full animate-spin" />
                    </div>
                  </div>
                )}
              </div>
            )}
            <div className="mt-3 text-xs text-teal-600">
              <strong>Light Sync:</strong> Updates stock & prices only (10-15 min) | <strong>Full Sync:</strong> All details + images (30-45 min)
            </div>
          </CardContent>
        </Card>
      )}

      {/* Server-Side Sync Button (Ceramica Impex) */}
      {selectedSupplier === 'Ceramica Impex' && (
        <Card className="border-purple-200 bg-purple-50">
          <CardContent className="py-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className={`w-3 h-3 rounded-full ${ceramicaSyncStatus?.is_running ? 'bg-purple-500 animate-pulse' : 'bg-purple-500'}`} />
                <div>
                  <h3 className="font-semibold text-purple-900">Server-Side Sync</h3>
                  <p className="text-sm text-purple-700">
                    {ceramicaSyncStatus?.is_running 
                      ? ceramicaSyncStatus.message 
                      : 'Automatically crawl all Ceramica Impex products from the B2B portal'}
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-3">
                {ceramicaSyncStatus?.is_running && (
                  <div className="text-sm text-purple-800">
                    <span className="font-medium">{ceramicaSyncStatus.progress}%</span>
                    <span className="mx-2">|</span>
                    {ceramicaSyncStatus.phase === 'syncing' ? (
                      <span>{ceramicaSyncStatus.products_synced || 0} synced</span>
                    ) : (
                      <span>{ceramicaSyncStatus.products_found || 0} found</span>
                    )}
                  </div>
                )}
                {ceramicaSyncStatus?.is_running ? (
                  <Button 
                    onClick={stopCeramicaSync}
                    variant="outline"
                    className="border-red-300 text-red-600 hover:bg-red-50"
                    data-testid="stop-ceramica-sync-btn"
                  >
                    <X className="w-4 h-4 mr-2" />
                    Stop
                  </Button>
                ) : (
                  <div className="flex gap-2">
                    <Button 
                      onClick={() => startCeramicaSync('light')}
                      variant="outline"
                      className="border-purple-300 text-purple-700 hover:bg-purple-100"
                      data-testid="start-ceramica-light-sync-btn"
                    >
                      <RefreshCw className="w-4 h-4 mr-2" />
                      Light Sync
                    </Button>
                    <Button 
                      onClick={() => startCeramicaSync('deep')}
                      className="bg-purple-600 hover:bg-purple-700 text-white"
                      data-testid="start-ceramica-deep-sync-btn"
                    >
                      <RefreshCw className="w-4 h-4 mr-2" />
                      Full Sync
                    </Button>
                  </div>
                )}
              </div>
            </div>
            {ceramicaSyncStatus?.is_running && (
              <div className="mt-3">
                <div className="w-full bg-purple-200 rounded-full h-2">
                  <div 
                    className="bg-purple-600 h-2 rounded-full transition-all duration-500"
                    style={{ width: `${ceramicaSyncStatus.progress || 0}%` }}
                  />
                </div>
                
                {/* Current Product Being Synced */}
                {ceramicaSyncStatus.current_product && (
                  <div className="mt-4 p-3 bg-white rounded-lg border border-purple-200 flex items-center gap-4">
                    {/* Product Image */}
                    <div 
                      className="w-20 h-20 flex-shrink-0 bg-gray-100 rounded-lg overflow-hidden cursor-pointer hover:ring-2 hover:ring-purple-400 transition-all"
                      onClick={() => ceramicaSyncStatus.current_product.image && setPreviewImage({ 
                        url: ceramicaSyncStatus.current_product.image, 
                        name: ceramicaSyncStatus.current_product.name 
                      })}
                    >
                      {ceramicaSyncStatus.current_product.image ? (
                        <img 
                          src={ceramicaSyncStatus.current_product.image} 
                          alt={ceramicaSyncStatus.current_product.name}
                          className="w-full h-full object-cover"
                          onError={(e) => { e.target.style.display = 'none'; }}
                        />
                      ) : (
                        <div className="w-full h-full flex items-center justify-center text-gray-400">
                          <Package className="w-8 h-8" />
                        </div>
                      )}
                    </div>
                    
                    {/* Product Info */}
                    <div className="flex-1 min-w-0">
                      <p className="font-medium text-purple-900 truncate">
                        {ceramicaSyncStatus.current_product.display_name || ceramicaSyncStatus.current_product.name || 'Loading...'}
                      </p>
                      {ceramicaSyncStatus.current_product.display_name && ceramicaSyncStatus.current_product.display_name !== ceramicaSyncStatus.current_product.name && (
                        <p className="text-xs text-gray-500 truncate">
                          Original: {ceramicaSyncStatus.current_product.name}
                        </p>
                      )}
                      <p className="text-sm text-purple-600">
                        SKU: {ceramicaSyncStatus.current_product.sku || '-'}
                      </p>
                      <div className="flex gap-4 mt-1 text-sm">
                        <span className="text-green-600">
                          Stock: {ceramicaSyncStatus.current_product.stock_m2?.toFixed(2) || '0'} m²
                        </span>
                        <span className="text-blue-600">
                          Cost: £{ceramicaSyncStatus.current_product.cost_price?.toFixed(2) || '-'}
                        </span>
                        <span className="text-purple-600">
                          Price: £{ceramicaSyncStatus.current_product.price?.toFixed(2) || '-'}
                        </span>
                      </div>
                    </div>
                    
                    {/* Syncing Indicator */}
                    <div className="flex-shrink-0">
                      <div className="w-8 h-8 border-3 border-purple-500 border-t-transparent rounded-full animate-spin" />
                    </div>
                  </div>
                )}
              </div>
            )}
            <div className="mt-3 text-xs text-purple-600">
              <strong>Light Sync:</strong> Updates stock & prices only (10-15 min) | <strong>Full Sync:</strong> All details + images (30-45 min)
            </div>
          </CardContent>
        </Card>
      )}

      {/* Server-Side Sync Button (Wallcano) */}
      {selectedSupplier === 'Wallcano' && (
        <Card className="border-orange-200 bg-orange-50">
          <CardContent className="py-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className={`w-3 h-3 rounded-full ${wallcanoSyncStatus?.is_running ? 'bg-orange-500 animate-pulse' : 'bg-orange-500'}`} />
                <div>
                  <h3 className="font-semibold text-orange-900">Server-Side Sync</h3>
                  <p className="text-sm text-orange-700">
                    {wallcanoSyncStatus?.is_running 
                      ? wallcanoSyncStatus.message 
                      : 'Crawl all Wallcano products. NOTE: Prices must be set manually after sync.'}
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-3">
                {wallcanoSyncStatus?.is_running && (
                  <div className="text-sm text-orange-800">
                    <span className="font-medium">{wallcanoSyncStatus.progress}%</span>
                    <span className="mx-2">|</span>
                    {wallcanoSyncStatus.phase === 'syncing' ? (
                      <span>{wallcanoSyncStatus.products_synced || 0} synced</span>
                    ) : (
                      <span>{wallcanoSyncStatus.products_found || 0} found</span>
                    )}
                  </div>
                )}
                {wallcanoSyncStatus?.is_running ? (
                  <Button 
                    onClick={stopWallcanoSync}
                    variant="outline"
                    className="border-red-300 text-red-600 hover:bg-red-50"
                    data-testid="stop-wallcano-sync-btn"
                  >
                    <X className="w-4 h-4 mr-2" />
                    Stop
                  </Button>
                ) : (
                  <div className="flex gap-2">
                    <Button 
                      onClick={() => startWallcanoSync('light')}
                      variant="outline"
                      className="border-orange-300 text-orange-700 hover:bg-orange-100"
                      data-testid="start-wallcano-light-sync-btn"
                    >
                      <RefreshCw className="w-4 h-4 mr-2" />
                      Light Sync
                    </Button>
                    <Button 
                      onClick={() => startWallcanoSync('deep')}
                      className="bg-orange-600 hover:bg-orange-700 text-white"
                      data-testid="start-wallcano-deep-sync-btn"
                    >
                      <RefreshCw className="w-4 h-4 mr-2" />
                      Full Sync
                    </Button>
                  </div>
                )}
              </div>
            </div>
            {wallcanoSyncStatus?.is_running && (
              <div className="mt-3">
                <div className="w-full bg-orange-200 rounded-full h-2">
                  <div 
                    className="bg-orange-600 h-2 rounded-full transition-all duration-500"
                    style={{ width: `${wallcanoSyncStatus.progress || 0}%` }}
                  />
                </div>
                
                {/* Current Product Being Synced */}
                {wallcanoSyncStatus.current_product && (
                  <div className="mt-4 p-3 bg-white rounded-lg border border-orange-200 flex items-center gap-4">
                    {/* Product Image */}
                    <div 
                      className="w-20 h-20 flex-shrink-0 bg-gray-100 rounded-lg overflow-hidden cursor-pointer hover:ring-2 hover:ring-orange-400 transition-all"
                      onClick={() => wallcanoSyncStatus.current_product.image && setPreviewImage({ 
                        url: wallcanoSyncStatus.current_product.image, 
                        name: wallcanoSyncStatus.current_product.name 
                      })}
                    >
                      {wallcanoSyncStatus.current_product.image ? (
                        <img 
                          src={wallcanoSyncStatus.current_product.image} 
                          alt={wallcanoSyncStatus.current_product.name}
                          className="w-full h-full object-cover"
                          onError={(e) => { e.target.style.display = 'none'; }}
                        />
                      ) : (
                        <div className="w-full h-full flex items-center justify-center text-gray-400">
                          <Package className="w-8 h-8" />
                        </div>
                      )}
                    </div>
                    
                    {/* Product Info */}
                    <div className="flex-1 min-w-0">
                      <p className="font-medium text-orange-900 truncate">
                        {wallcanoSyncStatus.current_product.display_name || wallcanoSyncStatus.current_product.name || 'Loading...'}
                      </p>
                      {wallcanoSyncStatus.current_product.display_name && wallcanoSyncStatus.current_product.display_name !== wallcanoSyncStatus.current_product.name && (
                        <p className="text-xs text-gray-500 truncate">
                          Original: {wallcanoSyncStatus.current_product.name}
                        </p>
                      )}
                      <p className="text-sm text-orange-600">
                        SKU: {wallcanoSyncStatus.current_product.sku || '-'}
                      </p>
                      <div className="flex gap-4 mt-1 text-sm">
                        <span className="text-green-600">
                          Stock: {wallcanoSyncStatus.current_product.stock_m2?.toFixed(2) || '0'} m²
                        </span>
                        <span className="text-amber-600 italic">
                          Price: Set manually
                        </span>
                      </div>
                    </div>
                    
                    {/* Syncing Indicator */}
                    <div className="flex-shrink-0">
                      <div className="w-8 h-8 border-3 border-orange-500 border-t-transparent rounded-full animate-spin" />
                    </div>
                  </div>
                )}
              </div>
            )}
            <div className="mt-3 text-xs text-orange-600">
              <strong>Light Sync:</strong> Updates stock only (5-10 min) | <strong>Full Sync:</strong> All details + images (20-30 min) | <strong>Note:</strong> Prices must be set manually
            </div>
          </CardContent>
        </Card>
      )}

      {/* Search and Filter Box */}
      <div className="flex items-center gap-3 flex-wrap">
        <div className="relative flex-1 max-w-md">
          <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 w-4 h-4 text-gray-400" />
          <Input
            type="text"
            placeholder="Search by name, SKU, or category..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="pl-10 pr-10"
            data-testid="sync-hub-search-input"
          />
          {searchTerm && (
            <button
              onClick={() => setSearchTerm('')}
              className="absolute right-3 top-1/2 transform -translate-y-1/2 text-gray-400 hover:text-gray-600"
              data-testid="clear-search-btn"
            >
              <X className="w-4 h-4" />
            </button>
          )}
        </div>
        
        {/* Filter Dropdown */}
        <select
          value={filterType}
          onChange={(e) => setFilterType(e.target.value)}
          className="h-10 px-3 py-2 border border-gray-200 rounded-md text-sm bg-white focus:outline-none focus:ring-2 focus:ring-accent focus:border-transparent"
          data-testid="sync-hub-filter-select"
        >
          <option value="all">All Products</option>
          <option value="updates">Updates Only</option>
          <option value="new">New Products Only</option>
          <option value="has_stock">Has Stock</option>
          <option value="no_stock">No Stock (Blocked)</option>
        </select>
        
        {/* Clear Filters */}
        {(searchTerm || filterType !== 'all') && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setSearchTerm('');
              setFilterType('all');
            }}
            className="text-gray-500 hover:text-gray-700"
            data-testid="clear-all-filters-btn"
          >
            <X className="w-4 h-4 mr-1" />
            Clear Filters
          </Button>
        )}
      </div>
      
      {/* Filter Results Info */}
      {(searchTerm || filterType !== 'all') && filteredData && (
        <div className="text-sm text-gray-600 bg-blue-50 px-3 py-2 rounded-lg inline-flex items-center gap-2">
          <Search className="w-4 h-4 text-blue-500" />
          Showing {filteredData.total_updates + filteredData.total_new} results
          {searchTerm && <span>for "{searchTerm}"</span>}
          {filterType !== 'all' && <span>({filterType.replace('_', ' ')})</span>}
          {(filteredData.total_updates + filteredData.total_new) !== (stagingData?.total_updates + stagingData?.total_new) && (
            <span className="text-gray-400">
              (filtered from {(stagingData?.total_updates || 0) + (stagingData?.total_new || 0)} total)
            </span>
          )}
        </div>
      )}

      {loading ? (
        <div className="flex items-center justify-center py-12">
          <RefreshCw className="w-8 h-8 animate-spin text-gray-400" />
        </div>
      ) : (
        <>
          {/* Warnings Section - Collapsible with Dismiss & Remap */}
          {stagingData?.warnings?.length > 0 && (
            <Card className="border-amber-200 bg-amber-50">
              <CardContent className="pt-4">
                <button 
                  onClick={() => setExpandedProduct(expandedProduct === 'warnings' ? null : 'warnings')}
                  className="w-full flex items-center justify-between text-amber-800 hover:text-amber-900"
                >
                  <div className="flex items-center gap-2">
                    <AlertTriangle className="w-5 h-5" />
                    <span className="font-medium">
                      {stagingData.warnings.length} Validation Warnings 
                      <span className="font-normal text-sm ml-2">
                        (Products exist with different/missing codes)
                      </span>
                    </span>
                  </div>
                  {expandedProduct === 'warnings' ? (
                    <ChevronUp className="w-5 h-5" />
                  ) : (
                    <ChevronDown className="w-5 h-5" />
                  )}
                </button>
                {expandedProduct === 'warnings' && (
                  <div className="mt-4 border-t border-amber-200 pt-4">
                    {/* Bulk Dismiss Button */}
                    <div className="flex items-center justify-between mb-3">
                      <p className="text-xs text-amber-600">Review warnings below. Dismissed warnings won't reappear on next sync.</p>
                      <Button
                        size="sm"
                        variant="outline"
                        className="border-amber-400 text-amber-700 hover:bg-amber-100"
                        onClick={async () => {
                          try {
                            const res = await fetch(`${API_URL}/api/sync-staging/warnings/dismiss`, {
                              method: 'POST',
                              headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${localStorage.getItem('token')}` },
                              body: JSON.stringify({ supplier: selectedSupplier, dismiss_all: true })
                            });
                            const result = await res.json();
                            if (result.success) {
                              toast.success(`Dismissed ${result.dismissed_count} warnings`);
                              fetchStagingData();
                            }
                          } catch (err) {
                            toast.error('Failed to dismiss warnings');
                          }
                        }}
                        data-testid="dismiss-all-warnings-btn"
                      >
                        <Check className="w-3 h-3 mr-1" /> Dismiss All ({stagingData.warnings.length})
                      </Button>
                    </div>
                    <div className="space-y-2 max-h-80 overflow-y-auto">
                      {stagingData.warnings.map((warning, idx) => {
                        const warningCode = warning.details?.code || warning.details?.incoming_code || '';
                        const isNameMismatch = warning.type === 'name_change_detected';
                        return (
                          <div key={idx} className="flex items-start gap-2 text-amber-800 text-sm bg-white/60 rounded p-2 border border-amber-100">
                            <AlertTriangle className="w-4 h-4 flex-shrink-0 mt-0.5" />
                            <div className="flex-1 min-w-0">
                              <p className="break-words">{warning.message}</p>
                              {warning.type === 'missing_stock' && (
                                <p className="text-xs text-amber-600">Products without stock data cannot be applied.</p>
                              )}
                            </div>
                            {isNameMismatch && warningCode && (
                              <div className="flex gap-1 flex-shrink-0">
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  className="h-7 px-2 text-xs text-amber-700 hover:bg-amber-100"
                                  title="Dismiss this warning"
                                  onClick={async (e) => {
                                    e.stopPropagation();
                                    try {
                                      await fetch(`${API_URL}/api/sync-staging/warnings/dismiss`, {
                                        method: 'POST',
                                        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${localStorage.getItem('token')}` },
                                        body: JSON.stringify({ supplier: selectedSupplier, warning_codes: [warningCode] })
                                      });
                                      toast.success(`Dismissed warning for ${warningCode}`);
                                      fetchStagingData();
                                    } catch { toast.error('Failed'); }
                                  }}
                                  data-testid={`dismiss-warning-${warningCode}`}
                                >
                                  <Check className="w-3 h-3" />
                                </Button>
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  className="h-7 px-2 text-xs text-blue-700 hover:bg-blue-50"
                                  title="Re-link: Assign this SKU to the existing product"
                                  onClick={async (e) => {
                                    e.stopPropagation();
                                    const existingName = warning.details?.existing_name || '';
                                    const existingSku = warningCode;
                                    if (window.confirm(`Re-link SKU "${existingSku}" to existing product "${existingName}"?\n\nThis will update the existing product to use the new supplier code.`)) {
                                      try {
                                        const res = await fetch(`${API_URL}/api/sync-staging/warnings/remap-sku`, {
                                          method: 'POST',
                                          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${localStorage.getItem('token')}` },
                                          body: JSON.stringify({ supplier: selectedSupplier, sku: existingSku, action: 'relink', target_product_sku: existingSku })
                                        });
                                        const result = await res.json();
                                        if (result.success) {
                                          toast.success(result.message);
                                          fetchStagingData();
                                        } else {
                                          toast.error(result.detail || 'Remap failed');
                                        }
                                      } catch { toast.error('Failed to remap'); }
                                    }
                                  }}
                                  data-testid={`relink-warning-${warningCode}`}
                                >
                                  <Link className="w-3 h-3 mr-1" /> Re-link
                                </Button>
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  className="h-7 px-2 text-xs text-red-600 hover:bg-red-50"
                                  title="Break link: Disconnect from old product, treat as new"
                                  onClick={async (e) => {
                                    e.stopPropagation();
                                    const existingName = warning.details?.existing_name || 'unknown';
                                    const incomingName = warning.details?.incoming_name || 'unknown';
                                    if (window.confirm(`Break link for SKU "${warningCode}"?\n\nOld product: "${existingName}" will be disconnected.\nNew product: "${incomingName}" will be added as a new product.`)) {
                                      try {
                                        const res = await fetch(`${API_URL}/api/sync-staging/warnings/remap-sku`, {
                                          method: 'POST',
                                          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${localStorage.getItem('token')}` },
                                          body: JSON.stringify({ supplier: selectedSupplier, sku: warningCode, action: 'break_and_new' })
                                        });
                                        const result = await res.json();
                                        if (result.success) {
                                          toast.success(result.message);
                                          fetchStagingData();
                                        } else {
                                          toast.error(result.detail || 'Break failed');
                                        }
                                      } catch { toast.error('Failed to break link'); }
                                    }
                                  }}
                                  data-testid={`break-link-warning-${warningCode}`}
                                >
                                  <X className="w-3 h-3 mr-1" /> Break + New
                                </Button>
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}
              </CardContent>
            </Card>
          )}

          {/* Stats Summary */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <Card>
              <CardContent className="pt-4">
                <p className="text-sm text-gray-500">Pending Updates</p>
                <p className="text-2xl font-bold text-blue-600">{filteredData?.total_updates || 0}</p>
              </CardContent>
            </Card>
            <Card className="relative overflow-hidden">
              <CardContent className="pt-4">
                <p className="text-sm text-gray-500">New Products</p>
                <p className="text-2xl font-bold text-green-600">{filteredData?.total_new || 0}</p>
                {(filteredData?.total_new || 0) > 0 && !bulkAddingNewProducts && (
                  <Button
                    size="sm"
                    className="mt-2 w-full bg-green-600 hover:bg-green-700 text-white"
                    onClick={handleBulkAddNewProducts}
                    data-testid="bulk-add-new-products-btn"
                  >
                    <Plus className="w-4 h-4 mr-2" />
                    Add All to Database
                  </Button>
                )}
                {bulkAddingNewProducts && (
                  <div className="mt-3 p-3 bg-green-50 rounded-lg border border-green-200">
                    <div className="flex items-center justify-between mb-2">
                      <span className="text-sm font-medium text-green-800">
                        Adding Products...
                      </span>
                      <span className="text-sm font-bold text-green-700">
                        {bulkAddProgress?.processed || 0}/{bulkAddProgress?.total || 0}
                      </span>
                    </div>
                    <div className="w-full bg-green-200 rounded-full h-3 mb-2">
                      <div 
                        className="bg-green-600 h-3 rounded-full transition-all duration-300 ease-out"
                        style={{ 
                          width: `${bulkAddProgress?.total > 0 ? (bulkAddProgress.processed / bulkAddProgress.total) * 100 : 0}%` 
                        }}
                      />
                    </div>
                    <div className="flex justify-between text-xs text-green-700">
                      <span>✓ Added: {bulkAddProgress?.added || 0}</span>
                      <span>⊘ Skipped: {bulkAddProgress?.skipped || 0}</span>
                    </div>
                  </div>
                )}
              </CardContent>
            </Card>
            <Card>
              <CardContent className="pt-4">
                <p className="text-sm text-gray-500">Ready to Apply</p>
                <p className="text-2xl font-bold text-emerald-600">
                  {filteredData?.updates?.filter(u => u.can_apply).length || 0}
                </p>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="pt-4">
                <p className="text-sm text-gray-500">Blocked (No Stock)</p>
                <p className="text-2xl font-bold text-red-600">
                  {filteredData?.updates?.filter(u => !u.can_apply).length || 0}
                </p>
              </CardContent>
            </Card>
          </div>

          {/* Comparison Summary Card - Only show when there are updates with changes */}
          {filteredData?.updates?.length > 0 && (
            <Card className="border-blue-200 bg-gradient-to-r from-blue-50 to-indigo-50">
              <CardHeader className="pb-2">
                <CardTitle className="text-lg flex items-center gap-2">
                  <RefreshCw className="w-5 h-5 text-blue-600" />
                  Stock & Price Change Summary
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                  {/* Stock Changes Summary */}
                  <div className="space-y-3">
                    <h4 className="font-semibold text-gray-700 flex items-center gap-2">
                      <Package className="w-4 h-4" />
                      Stock Changes
                    </h4>
                    <div className="grid grid-cols-3 gap-3">
                      <div className="bg-white rounded-lg p-3 border border-green-200">
                        <div className="flex items-center gap-1 text-green-600 mb-1">
                          <ArrowUp className="w-4 h-4" />
                          <span className="text-xs font-medium">Increased</span>
                        </div>
                        <p className="text-xl font-bold text-green-700">
                          {filteredData.updates.filter(u => u.stock_change > 0).length}
                        </p>
                      </div>
                      <div className="bg-white rounded-lg p-3 border border-red-200">
                        <div className="flex items-center gap-1 text-red-600 mb-1">
                          <ArrowDown className="w-4 h-4" />
                          <span className="text-xs font-medium">Decreased</span>
                        </div>
                        <p className="text-xl font-bold text-red-700">
                          {filteredData.updates.filter(u => u.stock_change < 0).length}
                        </p>
                      </div>
                      <div className="bg-white rounded-lg p-3 border border-gray-200">
                        <div className="flex items-center gap-1 text-gray-600 mb-1">
                          <Minus className="w-4 h-4" />
                          <span className="text-xs font-medium">No Change</span>
                        </div>
                        <p className="text-xl font-bold text-gray-700">
                          {filteredData.updates.filter(u => u.stock_change === 0 || u.stock_change === null).length}
                        </p>
                      </div>
                    </div>
                  </div>
                  
                  {/* Cost Changes Summary */}
                  <div className="space-y-3">
                    <h4 className="font-semibold text-gray-700 flex items-center gap-2">
                      £ Cost Changes (from supplier)
                    </h4>
                    <div className="grid grid-cols-3 gap-3">
                      <div className="bg-white rounded-lg p-3 border border-amber-200">
                        <div className="flex items-center gap-1 text-amber-600 mb-1">
                          <ArrowUp className="w-4 h-4" />
                          <span className="text-xs font-medium">Increased</span>
                        </div>
                        <p className="text-xl font-bold text-amber-700">
                          {filteredData.updates.filter(u => u.price_change > 0).length}
                        </p>
                      </div>
                      <div className="bg-white rounded-lg p-3 border border-green-200">
                        <div className="flex items-center gap-1 text-green-600 mb-1">
                          <ArrowDown className="w-4 h-4" />
                          <span className="text-xs font-medium">Decreased</span>
                        </div>
                        <p className="text-xl font-bold text-green-700">
                          {filteredData.updates.filter(u => u.price_change < 0).length}
                        </p>
                      </div>
                      <div className="bg-white rounded-lg p-3 border border-gray-200">
                        <div className="flex items-center gap-1 text-gray-600 mb-1">
                          <Minus className="w-4 h-4" />
                          <span className="text-xs font-medium">No Change</span>
                        </div>
                        <p className="text-xl font-bold text-gray-700">
                          {filteredData.updates.filter(u => u.price_change === 0 || u.price_change === null).length}
                        </p>
                      </div>
                    </div>
                  </div>
                </div>

                {/* Products with significant changes */}
                {(() => {
                  const significantStockChanges = filteredData.updates.filter(u => u.stock_change !== null && Math.abs(u.stock_change) >= 10);
                  const significantPriceChanges = filteredData.updates.filter(u => u.price_change !== null && Math.abs(u.price_change) >= 1);
                  
                  if (significantStockChanges.length === 0 && significantPriceChanges.length === 0) return null;
                  
                  return (
                    <div className="mt-4 pt-4 border-t border-blue-200">
                      <h4 className="font-semibold text-gray-700 mb-3 flex items-center gap-2">
                        <AlertCircle className="w-4 h-4 text-amber-500" />
                        Notable Changes
                      </h4>
                      <div className="space-y-2 max-h-48 overflow-y-auto">
                        {significantStockChanges.slice(0, 5).map((product) => (
                          <div 
                            key={`stock-${product.id}`}
                            className={`flex items-center justify-between p-2 rounded text-sm ${
                              product.stock_change > 0 ? 'bg-green-100' : 'bg-red-100'
                            }`}
                          >
                            <span className="font-medium truncate max-w-[200px]">{product.name}</span>
                            <span className={`font-mono font-bold ${product.stock_change > 0 ? 'text-green-700' : 'text-red-700'}`}>
                              Stock: {product.current_stock?.toFixed(0) || '0'} → {(product.stock_quantity || product.stock_m2)?.toFixed(0) || '0'}
                              {product.stock_change > 0 ? ' ↑' : ' ↓'}
                              <span className="text-xs ml-1">({product.stock_change > 0 ? '+' : ''}{product.stock_change?.toFixed(0)})</span>
                            </span>
                          </div>
                        ))}
                        {significantPriceChanges.slice(0, 5).map((product) => (
                          <div 
                            key={`price-${product.id}`}
                            className={`flex items-center justify-between p-2 rounded text-sm ${
                              product.price_locked ? 'bg-blue-50' : product.price_change > 0 ? 'bg-amber-100' : 'bg-green-100'
                            }`}
                          >
                            <span className="font-medium truncate max-w-[200px]">{product.name}</span>
                            <span className={`font-mono font-bold ${product.price_change > 0 ? 'text-amber-700' : 'text-green-700'}`}>
                              Cost: £{product.current_price?.toFixed(2) || '0.00'} → £{product.price?.toFixed(2) || '0.00'}
                              {product.price_change > 0 ? ' ↑' : ' ↓'}
                              <span className="text-xs ml-1">({product.price_change > 0 ? '+' : ''}£{product.price_change?.toFixed(2)})</span>
                            </span>
                          </div>
                        ))}
                      </div>
                    </div>
                  );
                })()}
              </CardContent>
            </Card>
          )}

          {/* Existing Product Updates Section */}
          <Card>
            <CardHeader className="pb-2">
              <div className="flex items-center justify-between">
                <CardTitle className="text-lg flex items-center gap-2">
                  <Package className="w-5 h-5" />
                  Existing Product Updates
                </CardTitle>
                {stagingData?.total_updates > 0 && (
                  <Button
                    onClick={handleApplyAll}
                    disabled={!stagingData?.can_apply_all || applying}
                    className="bg-blue-600 hover:bg-blue-700"
                    data-testid="apply-all-btn"
                  >
                    {applying ? (
                      <>
                        <RefreshCw className="w-4 h-4 mr-2 animate-spin" />
                        Applying...
                      </>
                    ) : (
                      <>
                        <CheckCircle2 className="w-4 h-4 mr-2" />
                        Apply All {selectedSupplier} Updates ({stagingData?.updates?.filter(u => u.can_apply).length || 0})
                      </>
                    )}
                  </Button>
                )}
              </div>
              {!stagingData?.can_apply_all && stagingData?.total_updates > 0 && (
                <p className="text-sm text-red-600 mt-2">
                  Some products have missing stock data and cannot be applied.
                </p>
              )}
            </CardHeader>
            <CardContent>
              {filteredData?.updates?.length === 0 ? (
                <div className="text-center py-8 text-gray-500">
                  <Package className="w-12 h-12 mx-auto mb-2 opacity-30" />
                  <p>{searchTerm ? `No updates matching "${searchTerm}"` : `No pending updates for ${selectedSupplier}`}</p>
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full">
                    <thead>
                      <tr className="bg-gray-50 border-b">
                        <th className="text-left py-3 px-2 font-medium text-gray-600 text-sm w-16">Image</th>
                        <th className="text-left py-3 px-4 font-medium text-gray-600 text-sm">Product</th>
                        <th className="text-left py-3 px-4 font-medium text-gray-600 text-sm">SKU</th>
                        <th className="text-center py-3 px-4 font-medium text-gray-600 text-sm">Stock Comparison</th>
                        <th className="text-center py-3 px-4 font-medium text-gray-600 text-sm">Cost Comparison</th>
                        <th className="text-center py-3 px-4 font-medium text-gray-600 text-sm">Status</th>
                        <th className="text-center py-3 px-4 font-medium text-gray-600 text-sm">Actions</th>
                      </tr>
                    </thead>
                    <tbody>
                      {filteredData?.updates?.map((product, idx) => {
                        const newStock = product.stock_quantity || product.stock_m2;
                        const stockDiff = product.stock_change;
                        const priceDiff = product.price_change;
                        
                        return (
                          <tr 
                            key={product.id} 
                            className={`border-b hover:bg-gray-50 ${!product.can_apply ? 'bg-red-50' : ''}`}
                            data-testid={`update-row-${product.sku}`}
                          >
                            <td className="py-2 px-2">
                              <div 
                                className="w-12 h-12 bg-gray-100 rounded overflow-hidden flex-shrink-0 cursor-pointer hover:ring-2 hover:ring-accent transition-all"
                                onClick={() => product.image && setPreviewImage({ url: product.image, name: product.name })}
                              >
                                {product.image ? (
                                  <img 
                                    src={product.image} 
                                    alt={product.name}
                                    className="w-full h-full object-cover"
                                    onError={(e) => { e.target.style.display = 'none'; }}
                                  />
                                ) : (
                                  <div className="w-full h-full flex items-center justify-center text-gray-300">
                                    <Package className="w-6 h-6" />
                                  </div>
                                )}
                              </div>
                            </td>
                            <td className="py-3 px-4">
                              <p className="font-medium text-gray-900 line-clamp-1">{product.name}</p>
                            </td>
                            <td className="py-3 px-4">
                              <span className="font-mono text-sm text-gray-600">{product.sku}</span>
                            </td>
                            <td className="py-3 px-4">
                              {product.has_stock ? (
                                <div className="flex flex-col items-center gap-1">
                                  <div className="flex items-center gap-2 font-mono">
                                    <span className="text-gray-500 line-through text-sm">
                                      {product.current_stock?.toFixed(1) || '0'}
                                    </span>
                                    <span className="text-gray-400">→</span>
                                    <span className={`font-bold ${
                                      stockDiff > 0 ? 'text-green-600' : 
                                      stockDiff < 0 ? 'text-red-600' : 'text-gray-700'
                                    }`}>
                                      {newStock?.toFixed(1) || '0'}
                                    </span>
                                    {renderStockChange(stockDiff)}
                                  </div>
                                  {stockDiff !== null && stockDiff !== 0 && (
                                    <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${
                                      stockDiff > 0 
                                        ? 'bg-green-100 text-green-700' 
                                        : 'bg-red-100 text-red-700'
                                    }`}>
                                      {stockDiff > 0 ? '+' : ''}{stockDiff?.toFixed(1)}
                                    </span>
                                  )}
                                </div>
                              ) : (
                                <div className="flex flex-col items-center gap-1">
                                  <span className="text-red-600 flex items-center justify-center gap-1">
                                    <XCircle className="w-4 h-4" />
                                    Missing
                                  </span>
                                  <Button
                                    size="sm"
                                    variant="outline"
                                    className="text-xs text-blue-600 border-blue-300 hover:bg-blue-50 h-6 px-2"
                                    onClick={() => handleEditStock(product)}
                                  >
                                    <Plus className="w-3 h-3 mr-1" />
                                    Add
                                  </Button>
                                </div>
                              )}
                            </td>
                            <td className="py-3 px-4">
                              {product.has_price ? (
                                <div className="flex flex-col items-center gap-1">
                                  <div className="flex items-center gap-2 font-mono">
                                    <span className="text-gray-500 line-through text-sm">
                                      £{product.current_price?.toFixed(2) || '0.00'}
                                    </span>
                                    <span className="text-gray-400">→</span>
                                    <span className={`font-bold ${
                                      priceDiff > 0 ? 'text-amber-600' : 
                                      priceDiff < 0 ? 'text-green-600' : 'text-gray-700'
                                    }`}>
                                      £{product.price?.toFixed(2) || '0.00'}
                                    </span>
                                    {renderPriceChange(priceDiff)}
                                  </div>
                                  {priceDiff !== null && priceDiff !== 0 && (
                                    <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${
                                      priceDiff > 0 
                                        ? 'bg-amber-100 text-amber-700' 
                                        : 'bg-green-100 text-green-700'
                                    }`}>
                                      {priceDiff > 0 ? '+' : ''}£{priceDiff?.toFixed(2)}
                                    </span>
                                  )}
                                </div>
                              ) : (
                                <span className="text-amber-600 flex items-center justify-center gap-1">
                                  <AlertCircle className="w-4 h-4" />
                                  Missing (OK)
                                </span>
                              )}
                            </td>
                            <td className="py-3 px-4 text-center">
                              {product.can_apply ? (
                                <span className="inline-flex items-center gap-1 text-green-600 text-sm">
                                  <CheckCircle2 className="w-4 h-4" />
                                  Ready
                                </span>
                              ) : (
                                <span className="inline-flex items-center gap-1 text-red-600 text-sm">
                                  <XCircle className="w-4 h-4" />
                                  Blocked
                                </span>
                              )}
                            </td>
                            <td className="py-3 px-4 text-center">
                              <Button
                                size="sm"
                                variant="ghost"
                                className="text-red-500 hover:text-red-700 hover:bg-red-50 p-1 h-8 w-8"
                                onClick={() => handleDeleteProduct(product)}
                                data-testid={`delete-update-${product.sku}`}
                                title="Remove from staging"
                              >
                                <Trash2 className="w-4 h-4" />
                              </Button>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </CardContent>
          </Card>

          {/* New Products Section */}
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-lg flex items-center gap-2">
                <Plus className="w-5 h-5 text-green-600" />
                New Products Detected
                {filteredData?.total_new > 0 && (
                  <span className="text-sm font-normal text-green-600 bg-green-100 px-2 py-0.5 rounded-full">
                    {filteredData.total_new} new
                  </span>
                )}
              </CardTitle>
            </CardHeader>
            <CardContent>
              {filteredData?.new_products?.length === 0 ? (
                <div className="text-center py-8 text-gray-500">
                  <Package className="w-12 h-12 mx-auto mb-2 opacity-30" />
                  <p>{searchTerm ? `No new products matching "${searchTerm}"` : `No new products detected for ${selectedSupplier}`}</p>
                </div>
              ) : (
                <div className="space-y-3">
                  {/* Select All + Bulk Actions Bar */}
                  <div className="flex items-center justify-between bg-white border rounded-lg px-3 py-2 mb-2">
                    <label className="flex items-center gap-2 cursor-pointer text-sm">
                      <input
                        type="checkbox"
                        className="w-4 h-4 rounded border-gray-300"
                        checked={selectedNewProducts.size > 0 && selectedNewProducts.size === (filteredData?.new_products?.length || 0)}
                        onChange={(e) => {
                          if (e.target.checked) {
                            setSelectedNewProducts(new Set(filteredData.new_products.map(p => p.sku || p.id)));
                          } else {
                            setSelectedNewProducts(new Set());
                          }
                        }}
                        data-testid="select-all-new-products"
                      />
                      <span className="text-gray-600">
                        {selectedNewProducts.size > 0 
                          ? `${selectedNewProducts.size} selected` 
                          : 'Select All'}
                      </span>
                    </label>
                    {selectedNewProducts.size > 0 && (
                      <div className="flex items-center gap-2">
                        <Button
                          size="sm"
                          className="bg-green-600 hover:bg-green-700 text-white text-xs h-7"
                          onClick={async () => {
                            const selected = filteredData.new_products.filter(p => selectedNewProducts.has(p.sku || p.id));
                            for (const product of selected) {
                              await handleAddNewProduct(product, clearanceProducts[product.sku] || false);
                            }
                            setSelectedNewProducts(new Set());
                            toast.success(`Added ${selected.length} products`);
                          }}
                          data-testid="bulk-add-selected-btn"
                        >
                          <Plus className="w-3 h-3 mr-1" /> Add Selected ({selectedNewProducts.size})
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          className="text-red-600 border-red-200 hover:bg-red-50 text-xs h-7"
                          onClick={async () => {
                            const selected = filteredData.new_products.filter(p => selectedNewProducts.has(p.sku || p.id));
                            for (const product of selected) {
                              await handleIgnoreProduct(product);
                            }
                            setSelectedNewProducts(new Set());
                            toast.success(`Ignored ${selected.length} products`);
                          }}
                          data-testid="bulk-ignore-selected-btn"
                        >
                          <X className="w-3 h-3 mr-1" /> Ignore Selected
                        </Button>
                      </div>
                    )}
                  </div>
                  {filteredData?.new_products?.map((product) => (
                    <div 
                      key={product.id}
                      className="border rounded-lg p-4 bg-green-50 border-green-200"
                    >
                      <div className="flex items-start justify-between">
                        {/* Checkbox */}
                        <input
                          type="checkbox"
                          className="w-4 h-4 mt-5 mr-3 rounded border-gray-300 flex-shrink-0 cursor-pointer"
                          checked={selectedNewProducts.has(product.sku || product.id)}
                          onChange={(e) => {
                            const key = product.sku || product.id;
                            const next = new Set(selectedNewProducts);
                            if (e.target.checked) {
                              next.add(key);
                            } else {
                              next.delete(key);
                            }
                            setSelectedNewProducts(next);
                          }}
                          data-testid={`select-new-product-${product.sku || product.id}`}
                        />
                        {/* Product Image */}
                        <div 
                          className="w-16 h-16 bg-gray-100 rounded-lg overflow-hidden flex-shrink-0 mr-4 cursor-pointer hover:ring-2 hover:ring-accent transition-all"
                          onClick={() => product.image && setPreviewImage({ url: product.image, name: product.name })}
                        >
                          {product.image ? (
                            <img 
                              src={product.image} 
                              alt={product.name}
                              className="w-full h-full object-cover"
                              onError={(e) => { e.target.style.display = 'none'; }}
                            />
                          ) : (
                            <div className="w-full h-full flex items-center justify-center text-gray-300">
                              <Package className="w-8 h-8" />
                            </div>
                          )}
                        </div>
                        
                        <div className="flex-1">
                          <div className="flex items-center gap-2 mb-1">
                            <span className="inline-flex items-center gap-1 bg-green-500 text-white text-xs px-2 py-0.5 rounded-full font-medium">
                              NEW
                            </span>
                            <span className="font-mono text-sm text-gray-500">{product.sku}</span>
                          </div>
                          <h3 className="font-semibold text-gray-900">{product.name}</h3>
                          
                          <button
                            onClick={() => setExpandedProduct(expandedProduct === product.id ? null : product.id)}
                            className="text-sm text-blue-600 hover:text-blue-800 flex items-center gap-1 mt-2"
                          >
                            <Eye className="w-4 h-4" />
                            {expandedProduct === product.id ? 'Hide Details' : 'View Details'}
                            {expandedProduct === product.id ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
                          </button>
                          
                          {expandedProduct === product.id && (
                            <div className="mt-3 p-3 bg-white rounded border text-sm space-y-1">
                              {product.category && <p><span className="text-gray-500">Category:</span> {product.category}</p>}
                              {product.size && <p><span className="text-gray-500">Size:</span> {product.size}</p>}
                              {product.material && <p><span className="text-gray-500">Material:</span> {product.material}</p>}
                              {product.finish && <p><span className="text-gray-500">Finish:</span> {product.finish}</p>}
                              <p>
                                <span className="text-gray-500">Stock:</span>{' '}
                                {product.has_stock ? (
                                  <span className="text-green-600 font-medium">
                                    {(product.stock_quantity || product.stock_m2)?.toFixed(1)} {product.stock_m2 ? 'm²' : 'units'}
                                  </span>
                                ) : (
                                  <span className="text-red-600">Missing</span>
                                )}
                              </p>
                              <p>
                                <span className="text-gray-500">Price:</span>{' '}
                                {product.has_price ? (
                                  <span className="font-medium">£{product.price?.toFixed(2)}</span>
                                ) : (
                                  <span className="text-amber-600">Not set</span>
                                )}
                              </p>
                              {product.synced_at && (
                                <p className="text-gray-400 text-xs">
                                  <Clock className="w-3 h-3 inline mr-1" />
                                  Synced: {new Date(product.synced_at).toLocaleString()}
                                </p>
                              )}
                            </div>
                          )}
                        </div>
                        
                        <div className="flex items-center gap-3 ml-4">
                          {/* Clearance Checkbox */}
                          <label 
                            className="flex items-center gap-2 cursor-pointer group"
                            data-testid={`clearance-label-${product.sku}`}
                          >
                            <input
                              type="checkbox"
                              checked={clearanceProducts[product.id] || false}
                              onChange={(e) => {
                                setClearanceProducts(prev => ({
                                  ...prev,
                                  [product.id]: e.target.checked
                                }));
                              }}
                              className="w-4 h-4 rounded border-amber-400 text-amber-600 focus:ring-amber-500"
                              data-testid={`clearance-checkbox-${product.sku}`}
                            />
                            <span className="text-sm font-medium text-amber-700 group-hover:text-amber-800">
                              Clearance
                            </span>
                          </label>
                          
                          <Button
                            size="sm"
                            variant="ghost"
                            className="text-gray-400 hover:text-red-600 hover:bg-red-50"
                            onClick={() => handleDeleteProduct(product)}
                            data-testid={`delete-new-${product.sku}`}
                            title="Remove from staging"
                          >
                            <Trash2 className="w-4 h-4" />
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            className="text-red-600 hover:text-red-700 hover:bg-red-50"
                            onClick={() => handleIgnoreProduct(product)}
                            data-testid={`ignore-${product.sku}`}
                          >
                            <X className="w-4 h-4 mr-1" />
                            Ignore Forever
                          </Button>
                          <Button
                            size="sm"
                            onClick={() => handleAddNewProduct(product, clearanceProducts[product.id] || false)}
                            disabled={!product.has_stock}
                            className={clearanceProducts[product.id] 
                              ? "bg-amber-600 hover:bg-amber-700" 
                              : "bg-green-600 hover:bg-green-700"
                            }
                            data-testid={`add-${product.sku}`}
                          >
                            <Plus className="w-4 h-4 mr-1" />
                            {clearanceProducts[product.id] ? 'Add as Clearance' : 'Add as New Collection'}
                          </Button>
                        </div>
                      </div>
                      
                      {!product.has_stock && (
                        <div className="mt-2 flex items-center gap-2">
                          <p className="text-red-600 text-sm flex items-center gap-1">
                            <XCircle className="w-4 h-4" />
                            Missing stock data
                          </p>
                          <Button
                            size="sm"
                            variant="outline"
                            className="text-blue-600 border-blue-300 hover:bg-blue-50"
                            onClick={() => handleEditStock(product)}
                            data-testid={`edit-stock-${product.sku}`}
                          >
                            <Plus className="w-4 h-4 mr-1" />
                            Add Stock
                          </Button>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </>
      )}

      {/* Edit Stock Modal */}
      <Dialog open={showEditStockModal} onOpenChange={setShowEditStockModal}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Package className="w-5 h-5 text-blue-600" />
              Edit Stock Data
            </DialogTitle>
          </DialogHeader>
          
          {editingStockProduct && (
            <div className="py-4 space-y-4">
              <div className="p-3 bg-gray-50 rounded-lg">
                <p className="font-medium text-sm">{editingStockProduct.product_name || editingStockProduct.name}</p>
                <p className="text-xs text-gray-500">SKU: {editingStockProduct.sku}</p>
              </div>
              
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Stock (m²)
                  </label>
                  <Input
                    type="number"
                    step="0.01"
                    min="0"
                    value={editStockForm.stock_m2}
                    onChange={(e) => setEditStockForm(prev => ({ ...prev, stock_m2: e.target.value }))}
                    placeholder="e.g., 25.5"
                    data-testid="edit-stock-m2"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Stock (Units)
                  </label>
                  <Input
                    type="number"
                    min="0"
                    value={editStockForm.stock_quantity}
                    onChange={(e) => setEditStockForm(prev => ({ ...prev, stock_quantity: e.target.value }))}
                    placeholder="e.g., 100"
                    data-testid="edit-stock-qty"
                  />
                </div>
              </div>
              
              <p className="text-xs text-gray-500">
                Enter at least one stock value (m² or units)
              </p>
            </div>
          )}
          
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowEditStockModal(false)}>
              Cancel
            </Button>
            <Button onClick={handleSaveStock} className="bg-blue-600 hover:bg-blue-700">
              <Check className="w-4 h-4 mr-1" />
              Save Stock
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Ignored Products Dialog */}
      <Dialog open={showIgnoredList} onOpenChange={setShowIgnoredList}>
        <DialogContent className="max-w-2xl max-h-[80vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <XCircle className="w-5 h-5 text-red-500" />
              Ignored Products
            </DialogTitle>
          </DialogHeader>
          
          <div className="py-4">
            {ignoredProducts.length === 0 ? (
              <p className="text-center text-gray-500 py-8">No products in the ignore list</p>
            ) : (
              <div className="space-y-2">
                {ignoredProducts.map((product, idx) => (
                  <div key={idx} className="flex items-center justify-between p-3 bg-gray-50 rounded-lg">
                    <div>
                      <p className="font-medium">{product.sku}</p>
                      <p className="text-sm text-gray-500">{product.supplier}</p>
                      {product.ignored_at && (
                        <p className="text-xs text-gray-400">
                          Ignored: {new Date(product.ignored_at).toLocaleDateString()}
                        </p>
                      )}
                    </div>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => handleRemoveFromIgnored(product.sku, product.supplier)}
                    >
                      <X className="w-4 h-4 mr-1" />
                      Unignore
                    </Button>
                  </div>
                ))}
              </div>
            )}
          </div>
          
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowIgnoredList(false)}>
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Image Preview Modal */}
      {previewImage && (
        <div 
          className="fixed inset-0 bg-black/80 z-50 flex items-center justify-center p-4 cursor-pointer"
          onClick={() => setPreviewImage(null)}
          data-testid="image-preview-modal"
        >
          <div className="relative max-w-4xl max-h-[90vh]">
            <button
              onClick={() => setPreviewImage(null)}
              className="absolute -top-10 right-0 text-white hover:text-gray-300 transition-colors"
              data-testid="close-image-preview-btn"
            >
              <X className="w-8 h-8" />
            </button>
            <img
              src={previewImage.url}
              alt={previewImage.name}
              className="max-w-full max-h-[85vh] object-contain rounded-lg shadow-2xl"
              onClick={(e) => e.stopPropagation()}
            />
            <p className="text-white text-center mt-3 text-sm">{previewImage.name}</p>
          </div>
        </div>
      )}
    </div>
  );
}
