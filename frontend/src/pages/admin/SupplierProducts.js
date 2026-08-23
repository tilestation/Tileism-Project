import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../../lib/api';
import { toast } from 'sonner';
import { usePermissions } from '../../contexts/PermissionsContext';
import { 
  Building2, Package, Search, Plus, Edit, Trash2, Download, Upload, 
  RefreshCw, ChevronDown, ChevronRight, X, Check, Filter, FileSpreadsheet, Eye, FileText,
  Sparkles, Bell, AlertTriangle, Database, CheckSquare, EyeOff, Store, Globe,
  Settings2, Archive, Layers, PenLine, ExternalLink, Save, Edit2, Loader2, Flag, Copy, Pencil,
  Tag, Percent, DollarSign, BadgePercent, Zap, Star, Clock, AlertCircle, ArrowRight, ShoppingCart, XCircle, Minus, CheckCircle,
  Home, FolderTree, Palette, Replace, PlusCircle, Shield, ShieldCheck, History, Undo2, HelpCircle, Grid3X3
} from 'lucide-react';
import jsPDF from 'jspdf';
import autoTable from 'jspdf-autotable';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { Card, CardContent, CardHeader, CardTitle } from '../../components/ui/card';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '../../components/ui/dialog';
import { useProductOptions } from '../../hooks/useProductOptions';
import ManageOptionsModal from './components/supplier-products/ManageOptionsModal';
import BulkCategoryEditorSections from './components/supplier-products/BulkCategoryEditorSections';
import QuickEditModal from './components/supplier-products/QuickEditModal';
import SaleLabelsModal from './components/supplier-products/SaleLabelsModal';
import LabelManager from './components/supplier-products/LabelManager';
import TierPricingModal from './components/supplier-products/TierPricingModal';
import BulkSaleModal from './components/supplier-products/BulkSaleModal';
import CanopyStockModal from './components/supplier-products/CanopyStockModal';
import CustomMappingsModal from './components/supplier-products/CustomMappingsModal';
import ProductDocumentsModal from './components/supplier-products/ProductDocumentsModal';
import ScopeSummaryPanel from './components/supplier-products/ScopeSummaryPanel';
import DiscountCalculatorPreview from './components/supplier-products/DiscountCalculatorPreview';
import DryRunPreview from './components/supplier-products/DryRunPreview';
import BulkEditPresets from './components/supplier-products/BulkEditPresets';
import BulkEditHistory from './components/supplier-products/BulkEditHistory';
import NameSanityDrawer from './components/supplier-products/NameSanityDrawer';
import ProductImagesGridPanel from './components/managers/ProductImagesGridPanel';
import { useBulkUndo } from './components/managers/useBulkUndo';
import { getSeriesName, getSeriesNameFromString } from './lib/series';
import ManagerTabsBar from './components/managers/ManagerTabsBar';
import { bucketSelectionByManager } from './components/managers/classifyProductToManager';
import CustomManagerBuilder from './components/managers/CustomManagerBuilder';

const API_URL = process.env.REACT_APP_BACKEND_URL;

// Helper: Generate a unique product key. Uses sku if available, falls back to supplier_code or _id.
// This ensures products without SKUs (e.g., RSA Tiles, ThermoSphere) still get unique keys.
const getProductKey = (p) => `${p.supplier || 'unknown'}|||${p.sku || p.supplier_code || p._id}`;

// Helper: Get the best identifier and field name for a product (for backend API calls).
// Products without SKU (e.g., ThermoSphere, RSA Tiles) use supplier_code instead.
const getProductIdForApi = (p) => ({
  id: p.sku || p.supplier_code,
  field: p.sku ? 'sku' : 'supplier_code'
});

// Supplier definitions with colors
const SUPPLIERS = [
  { id: 'all', name: 'All Suppliers', color: 'bg-gray-500' },
  { id: 'Verona', name: 'Verona', color: 'bg-blue-500' },
  { id: 'Splendour', name: 'Splendour', color: 'bg-teal-500' },
  { id: 'Ceramica Impex', name: 'Ceramica Impex', color: 'bg-purple-500' },
  { id: 'Tile Rite', name: 'Tile Rite', color: 'bg-red-500' },
  { id: 'Ultra Tile', name: 'Ultra Tile', color: 'bg-amber-500' },
  { id: 'Wallcano', name: 'Wallcano', color: 'bg-orange-500' },
  { id: 'LEPORCE', name: 'LEPORCE', color: 'bg-rose-500' },
  { id: 'H Martin', name: 'H Martin', color: 'bg-cyan-500' },
  { id: 'Trimline', name: 'Trimline', color: 'bg-green-500' },
  { id: 'Tilebase', name: 'Tilebase', color: 'bg-lime-500' },
  { id: 'Bloomstone', name: 'Bloomstone', color: 'bg-indigo-500' },
  { id: 'Boyden', name: 'Boyden', color: 'bg-pink-500' },
  { id: 'Regulus', name: 'Regulus', color: 'bg-violet-500' },
  { id: 'Eagle', name: 'Eagle', color: 'bg-sky-500' },
  { id: 'Plus39', name: 'Plus39', color: 'bg-emerald-500' },
  { id: 'Canopy', name: 'Canopy', color: 'bg-amber-600' },
  { id: 'RSA Tiles', name: 'RSA Tiles', color: 'bg-red-600' },
  { id: 'ThermoSphere', name: 'ThermoSphere', color: 'bg-orange-500' },
  { id: 'Other', name: 'Other', color: 'bg-gray-400' }
];

// Protected suppliers - bulk delete NOT allowed for these (actual products)
// Bulk delete only allowed for scraping history / extension sync data
const PROTECTED_SUPPLIERS = [
  'Verona', 'Splendour', 'Wallcano', 'Ceramica Impex', 
  'Tile Rite', 'Ultra Tile', 'Trimline', 'LEPORCE', 'H Martin',
  'Tilebase', 'Bloomstone', 'Boyden', 'Regulus', 'Eagle', 'Plus39', 'LEPORCE', 'Canopy', 'RSA Tiles', 'ThermoSphere'
];

// Category options for bulk editing - used by BulkCategoryEditorModal
const CATEGORY_OPTIONS = {
  material: ['Porcelain', 'Ceramic', 'Natural Stone', 'Glass', 'Metal', 'Wood', 'Vinyl', 'Laminate'],
  rooms: ['Kitchen', 'Bathroom', 'Living Room', 'Bedroom', 'Hallway', 'Outdoor', 'Commercial'],
  styles: ['Modern', 'Traditional', 'Contemporary', 'Rustic', 'Industrial', 'Minimalist', 'Mediterranean', 'Victorian'],
  finishes: ['Matt', 'Gloss', 'Polished', 'Satin', 'Lappato', 'Natural', 'Honed', 'Textured', 'Structured', 'Anti-slip']
};

// Series grouping helpers now live in lib/series.js (shared with every
// Manager page). Any change to the parsing rules (colour list, attribute
// list, dash-prefix handling, dimension breaks) MUST happen in that file
// so /admin/supplier-products and /admin/materials never disagree.


export default function SupplierProducts() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const [products, setProducts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [selectedSupplier, setSelectedSupplier] = useState(() => {
    // Initialize from URL param if present
    const supplierFromUrl = searchParams.get('supplier');
    if (supplierFromUrl) {
      // Validate that the supplier exists in our list
      const validSupplier = SUPPLIERS.find(s => s.id === supplierFromUrl);
      return validSupplier ? supplierFromUrl : 'all';
    }
    return 'all';
  });
  const [searchTerm, setSearchTerm] = useState(() => {
    return searchParams.get('search') || '';
  });
  const [currentPage, setCurrentPage] = useState(1);
  const [totalProducts, setTotalProducts] = useState(0);
  const [stats, setStats] = useState({});
  const [supplierStats, setSupplierStats] = useState({ withPrices: 0, inStock: 0, outOfStock: 0 });
  const [showAddModal, setShowAddModal] = useState(false);
  const [showEditModal, setShowEditModal] = useState(false);
  const [editingProduct, setEditingProduct] = useState(null);
  const [uploading, setUploading] = useState(false);
  const [showNewOnly, setShowNewOnly] = useState(false);
  const [newProductCount, setNewProductCount] = useState(0);
  const [showBulkDeleteDialog, setShowBulkDeleteDialog] = useState(false);
  const [bulkDeleteConfirm, setBulkDeleteConfirm] = useState('');
  const [managerBuilderOpen, setManagerBuilderOpen] = useState(false);
  // Suppliers the admin has hard-deleted via "Delete Supplier Entirely" —
  // the chips for these are filtered out of the tab row until they're
  // restored via the "restore" chip in the footer.
  const [hiddenSuppliers, setHiddenSuppliers] = useState([]);
  const hiddenSuppliersSet = useMemo(() => new Set(hiddenSuppliers.map(h => h.name || h)), [hiddenSuppliers]);
  
  // Initialize selectedProducts from localStorage to persist across refresh
  const [selectedProducts, setSelectedProducts] = useState(() => {
    try {
      const saved = localStorage.getItem('supplierProducts_selectedProducts');
      const savedSupplier = localStorage.getItem('supplierProducts_selectedSupplier');
      // Only restore if same supplier filter
      const urlParams = new URLSearchParams(window.location.search);
      const currentSupplier = urlParams.get('supplier') || '';
      if (saved && savedSupplier === currentSupplier) {
        return new Set(JSON.parse(saved));
      }
    } catch (e) {
      console.error('Error loading selected products from localStorage:', e);
    }
    return new Set();
  });
  
  // NEW: Sub-selection for granular attribute assignment within selected products
  // When applying specs/filters, sub-selected products get the chosen value, 
  // others get the default value (e.g., Porcelain for Material)
  const [productSubSelection, setProductSubSelection] = useState(() => {
    try {
      const saved = localStorage.getItem('supplierProducts_productSubSelection');
      if (saved) {
        return new Set(JSON.parse(saved));
      }
    } catch (e) {
      console.error('Error loading sub-selection from localStorage:', e);
    }
    return new Set();
  });
  
  // Per-product attribute assignments (e.g., { "filter_thickness": { "supplier|||sku": "8mm", ... } })
  const [perProductAssignments, setPerProductAssignments] = useState({});
  
  // Per-section product scopes for granular attribute assignment
  // Each section (categories, filters, specs) has its own product scope
  // Empty set = apply to ALL selected products; non-empty = apply only to those products
  const [sectionProductScopes, setSectionProductScopes] = useState({
    categories: new Set(),
    filters: new Set(),
    specifications: new Set()
  });
  
  // Per-attribute product scopes for individual attribute-level scoping
  // Key: attribute key (e.g., "cat_outdoor-tiles", "filter_color:White")
  // Value: Set of product keys that should receive this attribute
  // Empty/missing = apply to all selected products (default)
  const [perAttributeScopes, setPerAttributeScopes] = useState({});
  
  // Track whether a scope popover is currently open (prevents dialog from closing)
  const [isScopePopoverOpen, setIsScopePopoverOpen] = useState(false);
  
  // When scope popover is open, enable scrolling of the dialog content
  // Radix's scroll lock blocks wheel events from reaching portal-rendered elements
  useEffect(() => {
    if (!isScopePopoverOpen) return;
    
    // Clear body scroll lock that Radix applies
    const origOverflow = document.body.style.overflow;
    document.body.style.overflow = '';
    document.body.style.pointerEvents = '';
    
    // Forward wheel events to the dialog's scroll container
    const handler = (e) => {
      // Find the dialog's scrollable area
      const dialogScroll = document.querySelector('[role="dialog"] .overflow-y-auto');
      if (!dialogScroll) return;
      
      // Check if we're already scrolling inside the popover's own list
      const popover = document.querySelector('[data-testid^="attr-scope-popover-"]');
      if (popover) {
        const scrollList = popover.querySelector('.max-h-52');
        if (scrollList && scrollList.contains(e.target)) {
          // Let the popover's own list scroll naturally
          const { scrollTop, scrollHeight, clientHeight } = scrollList;
          const atTop = scrollTop <= 0 && e.deltaY < 0;
          const atBottom = scrollTop + clientHeight >= scrollHeight - 1 && e.deltaY > 0;
          if (!atTop && !atBottom) return; // Allow popover list scroll
        }
      }
      
      // Forward scroll to dialog
      dialogScroll.scrollTop += e.deltaY;
    };
    
    document.addEventListener('wheel', handler, { passive: true });
    
    return () => {
      document.removeEventListener('wheel', handler);
      document.body.style.overflow = origOverflow;
    };
  }, [isScopePopoverOpen]);
  
  // Persist selectedProducts to localStorage when it changes
  useEffect(() => {
    try {
      const urlParams = new URLSearchParams(window.location.search);
      const currentSupplier = urlParams.get('supplier') || '';
      localStorage.setItem('supplierProducts_selectedProducts', JSON.stringify([...selectedProducts]));
      localStorage.setItem('supplierProducts_selectedSupplier', currentSupplier);
    } catch (e) {
      console.error('Error saving selected products to localStorage:', e);
    }
  }, [selectedProducts]);
  
  // Persist productSubSelection to localStorage when it changes
  useEffect(() => {
    try {
      localStorage.setItem('supplierProducts_productSubSelection', JSON.stringify([...productSubSelection]));
    } catch (e) {
      console.error('Error saving sub-selection to localStorage:', e);
    }
  }, [productSubSelection]);
  
  // Helper function to clear selections and localStorage
  const clearAllSelections = () => {
    setSelectedProducts(new Set());
    setProductSubSelection(new Set());
    try {
      localStorage.removeItem('supplierProducts_selectedProducts');
      localStorage.removeItem('supplierProducts_productSubSelection');
    } catch (e) {
      console.error('Error clearing localStorage:', e);
    }
  };
  
  const [showSyncDialog, setShowSyncDialog] = useState(false);
  const [showNameSanity, setShowNameSanityState] = useState(() => sessionStorage.getItem('ts_name_sanity_open') === '1');
  const setShowNameSanity = (open) => {
    setShowNameSanityState(open);
    if (open) sessionStorage.setItem('ts_name_sanity_open', '1');
    else sessionStorage.removeItem('ts_name_sanity_open');
  };
  const [syncLoading, setSyncLoading] = useState(false);
  const [userRole, setUserRole] = useState(null);
  const [previewImage, setPreviewImage] = useState(null);
  const [previewImages, setPreviewImages] = useState(null); // For multiple image gallery
  const [showBulkCategoryModal, setShowBulkCategoryModal] = useState(false);
  const [bulkCategoryLoading, setBulkCategoryLoading] = useState(false);
  const [showNameMismatches, setShowNameMismatches] = useState(false);  // Filter to show only products with different original vs display names
  const pendingModalRestoreRef = useRef(false);
  
  // Use unified product options hook (same as Sync Hub and Product Edit)
  const {
    options: productOptions,
    loading: optionsLoading,
    fetchOptions: refreshOptions,
    addOption,
    updateOption,
    deleteOption
  } = useProductOptions();
  
  // Unified bulk edit selections - includes both tile specs AND website categories
  const [bulkCategorySelections, setBulkCategorySelections] = useState({
    // Specifications
    material: '',
    finish: '',
    type: '',
    edge: '',
    slip_rating: '',
    suitability: '', // Wall, Floor
    thickness: '', // Tile thickness (e.g., 8mm, 10mm, 12mm)
    underfloor_heating: '', // Yes, No
    // Main Category & Sub-Categories (NEW hierarchical structure)
    main_category: '',
    sub_categories: [], // Multi-select sub-categories
    // Pricing
    cost_price: '',
    list_price: '',
    // Country of Origin (Made in...)
    made_in: '',
    // Website Categories (multi-select)
    rooms: [],
    materials: [],
    styles: [],
    colors: [],
    features: []
  });
  const [bulkShowOnWebsite, setBulkShowOnWebsite] = useState(false);
  const [bulkCategoryMode, setBulkCategoryMode] = useState('replace'); // 'replace' or 'append'
  const [fieldsToClear, setFieldsToClear] = useState({}); // { field: [values to remove] }
  
  // Size filter for pricing section in bulk editor
  const [pricingSizeFilter, setPricingSizeFilter] = useState('all');
  
  // Quick Apply Templates state
  const [bulkEditTemplates, setBulkEditTemplates] = useState([]);
  const [showSaveTemplateModal, setShowSaveTemplateModal] = useState(false);
  const [newTemplateName, setNewTemplateName] = useState('');
  const [savingTemplate, setSavingTemplate] = useState(false);
  
  // Options Manager state (for managing product attribute options)
  const [showOptionsManager, setShowOptionsManager] = useState(false);
  const [optionsManagerTab, setOptionsManagerTab] = useState('materials');
  
  // Product Group Context - for filtering options by group (Tiles, Flooring, etc.)
  const [categoryGroups, setCategoryGroups] = useState([]);
  const [categoryGroupsWithCats, setCategoryGroupsWithCats] = useState([]);
  const [selectedProductGroup, setSelectedProductGroup] = useState('tiles'); // Default to Tiles
  
  const [statusFilter, setStatusFilter] = useState('');
  const [seriesFilter, setSeriesFilter] = useState(''); // Series dropdown filter
  const [bulkThicknessFilter, setBulkThicknessFilter] = useState('all'); // Thickness filter inside Bulk Category Editor
  const [allSeriesOptions, setAllSeriesOptions] = useState([]); // All series from backend (not paginated)
  const [showBulkEditModal, setShowBulkEditModal] = useState(false);
  const [bulkEditLoading, setBulkEditLoading] = useState(false);
  
  // Tier Pricing Modal State
  const [showTierPricingModal, setShowTierPricingModal] = useState(false);
  const [showAssignCategoryDropdown, setShowAssignCategoryDropdown] = useState(false);
  const [backfillPreview, setBackfillPreview] = useState(null);
  const [backfillRunning, setBackfillRunning] = useState(false);
  const [tierPricingConfig, setTierPricingConfig] = useState({
    thresholds: [10, 50, 100],
    discounts: [0, 5, 10, 15],
    custom_quote_threshold: 150,
    trade_discount_default: 5,
    trade_discount_type: 'percent', // 'percent' or 'fixed'
    credit_back_default: 2,
    // Half + Full pallet pricing (bulk)
    pallet_enabled: false,
    pallet_price: null,
    half_pallet_price: null,
    m2_per_pallet: null,
    m2_per_half_pallet: null,
  });
  const [tierPricingSaving, setTierPricingSaving] = useState(false);
  const [tierProductScope, setTierProductScope] = useState(new Set()); // empty = all products
  
  // Quote Settings Modal State
  const [showQuoteSettingsModal, setShowQuoteSettingsModal] = useState(false);
  const [quoteSettings, setQuoteSettings] = useState({
    quote_disabled: false,
    custom_quote_threshold: null
  });
  const [quoteSaving, setQuoteSaving] = useState(false);
  
  // Pricing Unit Modal State (for unit-based vs m2-based pricing)
  const [showPricingUnitModal, setShowPricingUnitModal] = useState(false);
  const [pricingUnitSettings, setPricingUnitSettings] = useState({
    pricing_unit: 'unit',
    unit_price: ''
  });
  const [pricingUnitSaving, setPricingUnitSaving] = useState(false);
  const [pricingUnitTargetProducts, setPricingUnitTargetProducts] = useState(new Set()); // Filter: which of the selected products to apply pricing-unit change to
  
  // Bulk Sale/Labels Settings State (in category editor)
  const [bulkSaleSettings, setBulkSaleSettings] = useState({
    sale_active: false,
    was_markup_percent: '',
    was_price: '',
    labels: []
  });
  const [bulkSaleSaving, setBulkSaleSaving] = useState(false);
  const [saleTargetProducts, setSaleTargetProducts] = useState(new Set()); // Which products to apply sale to

  // Shared bulk-undo helper — single 15s Undo toast across all bulk modals.
  const { snapshotFor: snapshotForBulkUndo, showUndoToast: showBulkUndoToast } = useBulkUndo();

  // Images-QA overlay state — replaces the deleted /admin/supplier-images/:supplier
  // page. { supplier, initialSkuFilter, initialSeriesFilter } | null.
  const [imagesPanelState, setImagesPanelState] = useState(null);
  
  // Bulk Description/SEO Settings State
  const [bulkDescriptionSettings, setBulkDescriptionSettings] = useState({
    description_template: '',
    seo_keywords: '',
    hidden_seo_keywords: '', // NEW: Hidden SEO Keywords text area
    use_placeholders: true,
    generate_hidden_seo: false,
    add_variations: false, // NEW: Add slight wording variations per product
    showAllPreviews: false // NEW: Show preview for all products
  });
  const [bulkDescriptionSaving, setBulkDescriptionSaving] = useState(false);
  const [generatingDescription, setGeneratingDescription] = useState(false);
  const [generatingSeriesDescription, setGeneratingSeriesDescription] = useState(false);
  const [seriesDescriptionResult, setSeriesDescriptionResult] = useState(null);
  
  // Batch Series Description States
  const [showBatchSeriesModal, setShowBatchSeriesModal] = useState(false);
  const [detectedSeries, setDetectedSeries] = useState(null);
  // 24 May 2026 — map of auto-detected series name → admin-edited name.
  // When a user types "La Dolce" into the inline input shown next to
  // "Pietra Ligure" in the Quick-Generate modal, the rename is stored
  // here and sent to the backend as `series_name_overrides` so the
  // generator labels the result with the corrected name.
  const [seriesNameOverrides, setSeriesNameOverrides] = useState({});
  // 24 May 2026 — "Unified mode" toggle for the Quick-Generate modal.
  // When ON, ALL selected products are collapsed into a SINGLE
  // collection regardless of how the auto-detector split them, so the
  // admin gets one description for the whole range (e.g. all 25 "La
  // Dolce" tiles → one description) instead of 6 per-variant ones.
  // When OFF, the per-series behaviour stays exactly as before.
  const [batchUnifiedMode, setBatchUnifiedMode] = useState(true);
  const [batchUnifiedCollectionName, setBatchUnifiedCollectionName] = useState('');
  const [detectingSeriesPending, setDetectingSeriesPending] = useState(false);
  const [generatingBatchDescriptions, setGeneratingBatchDescriptions] = useState(false);
  const [batchDescriptionResults, setBatchDescriptionResults] = useState(null);
  const [selectedSeriesForBatch, setSelectedSeriesForBatch] = useState(new Set());
  const [batchDescriptionLength, setBatchDescriptionLength] = useState('standard');
  const [expandedSeriesResults, setExpandedSeriesResults] = useState(new Set());
  
  // Collection Page Description State
  const [collectionDescription, setCollectionDescription] = useState('');
  const [collectionDescriptionSaving, setCollectionDescriptionSaving] = useState(false);
  const [collectionDescriptionLoaded, setCollectionDescriptionLoaded] = useState(false);
  
  // Auto-Regeneration States
  const [showAutoRegenModal, setShowAutoRegenModal] = useState(false);
  const [autoRegenSettings, setAutoRegenSettings] = useState(null);
  const [trackedSeries, setTrackedSeries] = useState([]);
  const [pendingRegenerations, setPendingRegenerations] = useState([]);
  const [regenHistory, setRegenHistory] = useState([]);
  const [loadingAutoRegen, setLoadingAutoRegen] = useState(false);
  const [savingAutoRegenSettings, setSavingAutoRegenSettings] = useState(false);
  
  // Track value breakdowns for mixed states (shows what values exist across selected products)
  const [bulkFieldBreakdowns, setBulkFieldBreakdowns] = useState({});
  
  // Save progress state — used when the unified Save retries failed products
  // individually. Was previously called `forceSaveProgress`; unified 3 Aug 2026.
  const [saveProgress, setSaveProgress] = useState(null); // { current, total, status }
  const [lastSaveResult, setLastSaveResult] = useState(null); // { success, failed, total, failed_items: [], timestamp }
  const [showSaveResults, setShowSaveResults] = useState(false); // controls the "Save Results" dialog
  
  // Dry Run / Preview, History, and Save & Verify states
  const [showDryRun, setShowDryRun] = useState(false);
  const [showEditHistory, setShowEditHistory] = useState(false);
  const [verifyingAfterSave, setVerifyingAfterSave] = useState(false);
  const [verificationResult, setVerificationResult] = useState(null);
  const pendingApplyRef = useRef(null);
  
  // Auto-save draft state
  const [autoSaveStatus, setAutoSaveStatus] = useState(null); // 'saving' | 'saved' | 'error' | null
  const [lastAutoSaveTime, setLastAutoSaveTime] = useState(null);
  const [showDraftRecovery, setShowDraftRecovery] = useState(false);
  const [recoveredDraft, setRecoveredDraft] = useState(null);
  const autoSaveTimerRef = useRef(null);
  const lastSavedSelectionsRef = useRef(null);
  
  // Tiles per Box Settings State (with size filter)
  const [tilesPerBoxSizeFilter, setTilesPerBoxSizeFilter] = useState('all');
  const [bulkTilesPerBoxSettings, setBulkTilesPerBoxSettings] = useState({
    tiles_per_box: '',
    sqm_per_box: '',
    tile_width: '',
    tile_height: ''
  });
  const [bulkTilesPerBoxSaving, setBulkTilesPerBoxSaving] = useState(false);
  
  // Update Mode for each section (replace = overwrite all, append = only update empty fields)
  const [showApplyConfirmation, setShowApplyConfirmation] = useState(false);
  const [applyUpdateMode, setApplyUpdateMode] = useState('replace'); // 'replace' or 'append'
  const [saveAsTemplateOnApply, setSaveAsTemplateOnApply] = useState(false);
  const [quickTemplateName, setQuickTemplateName] = useState('');
  
  const [bulkEditForm, setBulkEditForm] = useState({
    price: '',
    cost_price: '',
    stock: '',
    reorder_level: '',
    markup_percentage: '',
    is_active: '',
    is_featured: '',
    clearance: ''
  });
  const [categories, setCategories] = useState([]);
  const [productsPerPage, setProductsPerPage] = useState(50);
  
  // Delete All From Database state
  const [showDeleteAllDbDialog, setShowDeleteAllDbDialog] = useState(false);
  const [deleteAllDbPassword, setDeleteAllDbPassword] = useState('');
  const [deleteAllDbLoading, setDeleteAllDbLoading] = useState(false);
  const [deleteAllDbCount, setDeleteAllDbCount] = useState(null);
  const [deleteAllDbCountLoading, setDeleteAllDbCountLoading] = useState(false);

  // Delete-Supplier-Entirely modal (per-pill Super Admin action).
  const [deleteSupplierState, setDeleteSupplierState] = useState(null); // { name, impact, password, confirmName, loading, result }
  
  // Fix Product Names state
  const [fixingProductNames, setFixingProductNames] = useState(false);
  
  // Custom Mappings state
  const [showCustomMappingsModal, setShowCustomMappingsModal] = useState(false);
  const [customMappings, setCustomMappings] = useState([]);
  const [customMappingsLoading, setCustomMappingsLoading] = useState(false);
  const [customMappingsBySupplier, setCustomMappingsBySupplier] = useState({});
  const [customMappingsFilter, setCustomMappingsFilter] = useState('all');
  const [customMappingsSearch, setCustomMappingsSearch] = useState('');
  const [editingMapping, setEditingMapping] = useState(null);
  
  // Sale/Clearance Labels state
  const [showSaleLabelsModal, setShowSaleLabelsModal] = useState(false);
  const [saleLabelsProduct, setSaleLabelsProduct] = useState(null);
  const [saleLabelsLoading, setSaleLabelsLoading] = useState(false);
  const [saleLabelsForm, setSaleLabelsForm] = useState({
    labels: [],
    custom_labels: [],
    was_price: '',
    now_price: '',
    discount_percentage: '',
    sale_active: false,
    newCustomLabel: ''
  });
  const [showBulkSaleModal, setShowBulkSaleModal] = useState(false);
  // Inline + bulk cost/list price editing
  const [priceEdit, setPriceEdit] = useState(null); // { key, field: 'cost_price'|'price', value }
  const [marginFloor, setMarginFloor] = useState(null); // Margin Guard floor % (null = not loaded)
  const [showBulkPriceModal, setShowBulkPriceModal] = useState(false);
  const [bulkPriceForm, setBulkPriceForm] = useState({ cost: '', list: '' });
  const [showDocumentsModal, setShowDocumentsModal] = useState(false);
  const [documentsModalProducts, setDocumentsModalProducts] = useState([]);
  const [descProductScope, setDescProductScope] = useState(new Set()); // empty = all products
  
  // Generate a unique key for a product (used for description scope)
  // Must be truly unique per product - use sku/supplier_code + supplier
  const getDescScopeKey = (p) => `${p.sku || p.supplier_code || p._id || p.name || ''}|||${p.supplier || 'none'}`;
  const [bulkSaleLoading, setBulkSaleLoading] = useState(false);
  const [bulkSaleForm, setBulkSaleForm] = useState({
    labels: [],
    custom_labels: [],
    discount_percentage: '',
    was_price: '',
    saleMode: 'was',
    action: 'add', // 'add', 'remove', 'replace', 'clear'
    applyDiscount: false
  });
  const PRESET_LABELS = ['Sale', 'Clearance', 'New Arrival', 'Limited Stock', 'Best Seller'];
  
  // Dynamic labels from DB
  const [dbLabels, setDbLabels] = useState([]);
  const [dbLabelsLoading, setDbLabelsLoading] = useState(false);
  
  // Fetch labels from DB
  const fetchDbLabels = useCallback(async () => {
    try {
      const response = await api.get('/supplier-sync/labels');
      if (response.data?.labels) {
        setDbLabels(response.data.labels);
      }
    } catch (error) {
      console.error('Error fetching labels:', error);
    }
  }, []);
  
  // Derived: label names for UI usage (replaces hardcoded PRESET_LABELS)
  const allLabelNames = dbLabels.length > 0 ? dbLabels.map(l => l.name) : PRESET_LABELS;
  
  // Get label color info
  const getLabelStyle = useCallback((labelName) => {
    const found = dbLabels.find(l => l.name === labelName);
    if (found) return { bg: found.bg_color, text: found.text_color, color: found.color };
    // Fallback colors for hardcoded labels
    const fallbacks = {
      'Sale': { bg: '#fef2f2', text: '#b91c1c', color: '#ef4444' },
      'Clearance': { bg: '#fff7ed', text: '#c2410c', color: '#f97316' },
      'New Arrival': { bg: '#eff6ff', text: '#1d4ed8', color: '#3b82f6' },
      'Limited Stock': { bg: '#fefce8', text: '#a16207', color: '#eab308' },
      'Best Seller': { bg: '#faf5ff', text: '#7e22ce', color: '#a855f7' },
    };
    return fallbacks[labelName] || { bg: '#f3f4f6', text: '#374151', color: '#6b7280' };
  }, [dbLabels]);
  
  const handleAddLabel = async (labelData) => {
    try {
      setDbLabelsLoading(true);
      await api.post('/supplier-sync/labels', labelData);
      toast.success(`Label "${labelData.name}" created`);
      fetchDbLabels();
    } catch (error) {
      toast.error(error.response?.data?.detail || 'Failed to create label');
    } finally {
      setDbLabelsLoading(false);
    }
  };
  
  const handleEditLabel = async (oldName, labelData) => {
    try {
      setDbLabelsLoading(true);
      await api.put(`/supplier-sync/labels/${encodeURIComponent(oldName)}`, labelData);
      toast.success(`Label updated`);
      fetchDbLabels();
      fetchProducts(); // Refresh products since label names might have changed
    } catch (error) {
      toast.error(error.response?.data?.detail || 'Failed to update label');
    } finally {
      setDbLabelsLoading(false);
    }
  };
  
  const handleDeleteLabel = async (labelName) => {
    try {
      setDbLabelsLoading(true);
      const res = await api.delete(`/supplier-sync/labels/${encodeURIComponent(labelName)}`);
      toast.success(`Label "${labelName}" deleted (${res.data.products_updated || 0} products updated)`);
      // Remove from bulk settings if selected
      setBulkSaleSettings(prev => ({
        ...prev,
        labels: prev.labels.filter(l => l !== labelName)
      }));
      fetchDbLabels();
      fetchProducts();
    } catch (error) {
      toast.error(error.response?.data?.detail || 'Failed to delete label');
    } finally {
      setDbLabelsLoading(false);
    }
  };
  
  // Bulk Rename Series state
  const [showBulkRenameModal, setShowBulkRenameModal] = useState(false);
  const [bulkRenameLoading, setBulkRenameLoading] = useState(false);
  const [selectedPreviewProductIndex, setSelectedPreviewProductIndex] = useState(0); // Index of product to preview
  const [expandedProductInGrid, setExpandedProductInGrid] = useState(null); // Product expanded in the preview grid
  const [expandedNameId, setExpandedNameId] = useState(null); // Product name expanded on mobile tap
  const [renameMode, setRenameMode] = useState('template'); // 'template' or 'advanced'
  const [editingProductSku, setEditingProductSku] = useState(null); // SKU of product being individually edited
  const [templateForm, setTemplateForm] = useState({
    template: '{Series} {Color} {Size} {Finish}',
    seriesName: '',           // New series name to use
    defaultFinish: '',        // Default finish if not detected
    defaultColor: '',         // Default color if not detected
    customText: '',           // Custom text to add
    customTextPosition: 'none', // 'none', 'after_series', 'before_size', 'at_end'
    addCmToSize: true,        // Add "cm" to sizes
    productOverrides: {},     // SKU -> custom name overrides
    productColors: {},        // SKU -> specific color for that product
    supplierNameOverrides: {} // SKU -> supplier name overrides
  });
  const [bulkRenameForm, setBulkRenameForm] = useState({
    currentSeriesName: '',
    newSeriesName: '',       // Replace series name entirely (e.g., Ardesia → Slate)
    insertText: '',          // Text to insert at specified position
    insertPosition: 'after_series', // Position: 'after_series', 'before_size', 'before_color', 'at_start', 'at_end', 'custom'
    customInsertIndex: 1,    // For custom position - which word position (0-based)
    addCmToSize: false,      // Add "cm" to sizes
    previewProducts: [],     // Preview of changes
    wordReplacements: [],    // Array of {from: 'word', to: 'newword'} for word-level changes
    supplierProductName: '', // Computed supplier_product_name after word replacements
    supplierNameReplacements: [], // Array of {from: 'word', to: 'newword'} for supplier_product_name
    wordsToDelete: []        // Array of words to remove from product name
  });
  
  // Common color words to protect from changes
  const COLOR_WORDS = [
    'White', 'Black', 'Grey', 'Gray', 'Cream', 'Beige', 'Brown', 'Red', 'Blue', 'Green', 
    'Yellow', 'Orange', 'Pink', 'Purple', 'Gold', 'Silver', 'Bronze', 'Ivory', 'Sand',
    'Charcoal', 'Anthracite', 'Taupe', 'Graphite', 'Pearl', 'Bone', 'Almond', 'Caramel',
    'Mocha', 'Espresso', 'Walnut', 'Oak', 'Ash', 'Slate', 'Stone', 'Marble', 'Granite',
    'Terracotta', 'Rust', 'Copper', 'Brass', 'Champagne', 'Rose', 'Coral', 'Mint',
    'Teal', 'Navy', 'Cobalt', 'Indigo', 'Violet', 'Lavender', 'Mauve', 'Burgundy',
    'Bordeaux', 'Wine', 'Plum', 'Aubergine', 'Olive', 'Sage', 'Forest', 'Emerald',
    'Jade', 'Aqua', 'Turquoise', 'Cyan', 'Azure', 'Sky', 'Ocean', 'Marine',
    'Noir', 'Blanc', 'Gris', 'Bianco', 'Nero', 'Grigio', 'Crema', 'Natural'
  ];
  
  // Parse a product name into words, identifying colors and sizes
  const parseProductName = (name) => {
    if (!name) return { words: [], colors: [], sizes: [], finishes: [] };
    
    // Size pattern: matches 30x60, 60x120cm, 60x60x2cm, etc. (dimensional/tile sizes)
    const sizePattern = /\d+(?:\.\d+)?[xX]\d+(?:\.\d+)?(?:[xX]\d+(?:\.\d+)?)?(?:cm|mm)?/g;
    const sizes = name.match(sizePattern) || [];
    
    // Unit size pattern: matches 3kg, 1L, 5l, 500ml, 1.5L, 20kg, 1 Litre, 5 Litres, etc. (material/tool sizes)
    const unitSizePattern = /\d+(?:\.\d+)?\s*(?:kg|KG|Kg|[lL]|ml|ML|Litre|Litres|litre|litres)\b/g;
    const unitSizes = name.match(unitSizePattern) || [];
    
    // Combine both types
    const allSizes = [...sizes, ...unitSizes];
    
    // Remove sizes from name temporarily
    let tempName = name;
    allSizes.forEach(size => {
      tempName = tempName.replace(size, '___SIZE___');
    });
    
    // Split into words
    const allWords = tempName.split(/\s+/).filter(w => w && w !== '___SIZE___');
    
    // Identify colors
    const colors = [];
    const words = [];
    const finishes = [];
    
    // Common finishes
    const FINISH_WORDS = ['Matt', 'Matte', 'Polished', 'Gloss', 'Glossy', 'Satin', 'Honed', 'Lappato', 'Natural', 'Structured', 'Textured', 'R9', 'R10', 'R11', 'R12', 'Rectified', 'Slip'];
    
    allWords.forEach(word => {
      const cleanWord = word.replace(/[^a-zA-Z]/g, '');
      if (COLOR_WORDS.some(c => c.toLowerCase() === cleanWord.toLowerCase())) {
        colors.push(word);
      } else if (FINISH_WORDS.some(f => f.toLowerCase() === cleanWord.toLowerCase())) {
        finishes.push(word);
      } else if (cleanWord.length > 0) {
        words.push(word);
      }
    });
    
    return { words, colors, sizes: allSizes, finishes };
  };
  
  // Apply naming template to generate new product name
  const applyNamingTemplate = (product, template, seriesName, defaultFinish, defaultColor, customText, customTextPosition, addCm, productColor) => {
    const currentName = product.product_name || product.name || '';
    const parsed = parseProductName(currentName);
    
    // Extract components
    const detectedSeries = parsed.words.length > 0 ? parsed.words[0] : '';
    // Use product-specific color, or detected color, or default color
    const color = productColor || (parsed.colors.length > 0 ? parsed.colors.join(' ') : defaultColor);
    // Use parsed size, or fall back to product's size field (for materials: 3kg, 1L, etc.)
    let size = parsed.sizes.length > 0 ? parsed.sizes[0] : (product.size || '');
    const finish = parsed.finishes.length > 0 ? parsed.finishes.join(' ') : defaultFinish;
    
    // Add cm to size if needed
    if (addCm && size && !size.toLowerCase().includes('cm') && !size.toLowerCase().includes('mm')) {
      size = size + 'cm';
    }
    
    // Use new series name or keep detected one
    const finalSeries = seriesName || detectedSeries;
    
    // Apply template
    let newName = template
      .replace('{Series}', finalSeries)
      .replace('{Color}', color)
      .replace('{Size}', size)
      .replace('{Finish}', finish)
      .replace(/\s+/g, ' ')  // Remove double spaces
      .trim();
    
    // Add custom text at specified position
    if (customText && customTextPosition !== 'none') {
      const parts = newName.split(' ');
      switch (customTextPosition) {
        case 'after_series':
          // Insert after all series name words, not just the first word
          const seriesWordCount = finalSeries ? finalSeries.split(/\s+/).length : 1;
          parts.splice(seriesWordCount, 0, customText);
          break;
        case 'before_size':
          const sizeIdx = parts.findIndex(p => /\d+(\.\d+)?[xX]\d+/.test(p));
          if (sizeIdx > 0) parts.splice(sizeIdx, 0, customText);
          else parts.push(customText);
          break;
        case 'at_end':
          parts.push(customText);
          break;
        default:
          break;
      }
      newName = parts.join(' ');
    }
    
    // Remove empty placeholders that weren't filled
    newName = newName
      .replace(/\{\w+\}/g, '')  // Remove any remaining placeholders
      .replace(/\s+/g, ' ')
      .trim();
    
    return {
      original: currentName,
      newName,
      components: {
        series: finalSeries,
        color,
        size,
        finish,
        detectedSeries,
        hasColor: parsed.colors.length > 0 || !!productColor || !!defaultColor,
        hasFinish: parsed.finishes.length > 0 || !!defaultFinish,
        hasSize: parsed.sizes.length > 0
      }
    };
  };
  
  // Generate preview for all selected products using template
  const generateTemplatePreview = () => {
    const selectedSkusList = Array.from(selectedProducts);
    const selectedProductsList = products.filter(p => selectedSkusList.includes(getProductKey(p)));
    
    return selectedProductsList.map(product => {
      const sku = product.sku;
      // Check for manual override first
      if (templateForm.productOverrides[sku]) {
        return {
          sku,
          product,
          original: product.product_name || product.name || '',
          newName: templateForm.productOverrides[sku],
          isOverride: true,
          components: {}
        };
      }
      
      const result = applyNamingTemplate(
        product,
        templateForm.template,
        templateForm.seriesName,
        templateForm.defaultFinish,
        templateForm.defaultColor,
        templateForm.customText,
        templateForm.customTextPosition,
        templateForm.addCmToSize,
        templateForm.productColors[sku]
      );
      
      return {
        sku,
        product,
        original: result.original,
        newName: result.newName,
        components: result.components,
        isOverride: false
      };
    });
  };

  // Get pricing data from selected products for preview
  const getSelectedProductsPricing = (sizeFilter = null) => {
    let selectedProductsList;
    
    // Use getProductsFilteredBySize for consistent filter handling
    if (sizeFilter && sizeFilter !== 'all') {
      selectedProductsList = getProductsFilteredBySize(sizeFilter);
    } else {
      const selectedSkusList = Array.from(selectedProducts);
      selectedProductsList = products.filter(p => selectedSkusList.includes(getProductKey(p)));
    }
    
    if (selectedProductsList.length === 0) {
      return { 
        avgListPrice: 50, 
        avgCostPrice: 20, 
        minListPrice: 50, 
        maxListPrice: 50,
        products: []
      };
    }
    
    let totalListPrice = 0;
    let totalCostPrice = 0;
    let countWithPrice = 0;
    let countWithCost = 0;
    let minListPrice = Infinity;
    let maxListPrice = 0;
    
    selectedProductsList.forEach(p => {
      const listPrice = p.list_price || p.price || p.room_lot_price || 0;
      const costPrice = p.cost_price || 0;
      
      if (listPrice > 0) {
        totalListPrice += listPrice;
        countWithPrice++;
        if (listPrice < minListPrice) minListPrice = listPrice;
        if (listPrice > maxListPrice) maxListPrice = listPrice;
      }
      if (costPrice > 0) {
        totalCostPrice += costPrice;
        countWithCost++;
      }
    });
    
    return {
      avgListPrice: countWithPrice > 0 ? totalListPrice / countWithPrice : 50,
      avgCostPrice: countWithCost > 0 ? totalCostPrice / countWithCost : 20,
      minListPrice: minListPrice === Infinity ? 50 : minListPrice,
      maxListPrice: maxListPrice || 50,
      products: selectedProductsList,
      count: selectedProductsList.length,
      firstProduct: selectedProductsList[0]
    };
  };
  
  // Get tier pricing from filtered products - load existing values from products
  const getTierPricingFromProducts = (sizeFilter = 'all', scopedKeys = null) => {
    let filteredProducts = getProductsFilteredBySize(sizeFilter);
    
    // If scoped keys provided, further filter to those products
    if (scopedKeys && scopedKeys.size > 0) {
      filteredProducts = filteredProducts.filter(p => scopedKeys.has(getProductKey(p)));
    }
    
    if (filteredProducts.length === 0) {
      return null; // No products, use global defaults
    }
    
    // Check if all filtered products have the same custom tier pricing
    const firstWithCustom = filteredProducts.find(p => p.has_custom_tier_pricing);
    // Try to find a product with pallet_enabled set (independent of tier customisation)
    const firstWithPallet = filteredProducts.find(p => p.pallet_enabled === true);
    
    if (firstWithCustom || firstWithPallet) {
      const source = firstWithCustom || firstWithPallet;
      return {
        thresholds: (firstWithCustom && firstWithCustom.tier_thresholds) || [10, 50, 100],
        discounts: (firstWithCustom && firstWithCustom.tier_discounts) || [0, 5, 10, 15],
        trade_discount_default: source.trade_discount ?? 5,
        trade_discount_type: source.trade_discount_type || 'percent',
        disabled: (firstWithCustom && firstWithCustom.tier_pricing_disabled) || false,
        pallet_enabled: !!source.pallet_enabled,
        pallet_price: source.pallet_price ?? null,
        half_pallet_price: source.half_pallet_price ?? null,
        m2_per_pallet: source.m2_per_pallet ?? null,
        m2_per_half_pallet: source.m2_per_half_pallet ?? null,
        hasCustom: !!firstWithCustom,
        source: 'product'
      };
    }
    
    // No custom pricing, return null to use global
    return null;
  };
  
  // Open tier pricing modal with values from filtered products
  const openTierPricingModal = () => {
    // Try to load tier pricing from current size filter + scope
    const productTierPricing = getTierPricingFromProducts(pricingSizeFilter, tierProductScope);
    
    if (productTierPricing) {
      setTierPricingConfig(prev => ({
        ...prev,
        thresholds: productTierPricing.thresholds,
        discounts: productTierPricing.discounts,
        trade_discount_default: productTierPricing.trade_discount_default,
        trade_discount_type: productTierPricing.trade_discount_type,
        disabled: productTierPricing.disabled,
        pallet_enabled: productTierPricing.pallet_enabled,
        pallet_price: productTierPricing.pallet_price,
        half_pallet_price: productTierPricing.half_pallet_price,
        m2_per_pallet: productTierPricing.m2_per_pallet,
        m2_per_half_pallet: productTierPricing.m2_per_half_pallet,
      }));
    }
    // If no custom pricing found, keep current/global values
    
    setShowTierPricingModal(true);
  };
  
  // Get unique sizes from selected products for the size filter dropdown
  const getUniqueSizesFromSelected = () => {
    const selectedSkusList = Array.from(selectedProducts);
    const selectedProductsList = products.filter(p => selectedSkusList.includes(getProductKey(p)));
    
    // Use a Map to store normalized sizes (lowercase key -> display value)
    const sizeMap = new Map();
    // Track products per size for sub-grouping
    const sizeProducts = {};
    
    selectedProductsList.forEach(p => {
      const name = p.product_name || p.name || '';
      let sizeKey = null;
      let sizeDisplay = null;
      
      const sizeMatch = name.match(/\d+(?:\.\d+)?[xX]\d+(?:\.\d+)?(?:[xX]\d+(?:\.\d+)?)?(?:cm|mm)?/i);
      if (sizeMatch) {
        sizeKey = sizeMatch[0].toLowerCase();
        sizeDisplay = sizeMatch[0];
      } else if (p.size) {
        sizeKey = p.size.toLowerCase();
        sizeDisplay = p.size;
      }
      
      if (sizeKey) {
        if (!sizeMap.has(sizeKey)) {
          sizeMap.set(sizeKey, sizeDisplay);
          sizeProducts[sizeKey] = [];
        }
        sizeProducts[sizeKey].push(p);
      }
    });
    
    // Keywords that identify special/accent tile types
    const SPECIAL_KEYWORDS = ['decor', 'feature', 'mosaic', 'border', 'listello', 'insert', 'strip', 'accent', 'muretto'];
    
    // Build enhanced options with sub-groups
    const enhancedOptions = [];
    
    const sortedSizes = Array.from(sizeMap.entries()).sort((a, b) => {
      const numA = parseInt(a[0].match(/\d+/)?.[0] || '0');
      const numB = parseInt(b[0].match(/\d+/)?.[0] || '0');
      return numB - numA;
    });
    
    for (const [sizeKey, sizeDisplay] of sortedSizes) {
      const prods = sizeProducts[sizeKey] || [];
      
      // Detect thickness variants within this size
      const thicknessGroups = {};
      // Detect special type variants (decor/feature/standard)
      let hasSpecial = false;
      let hasStandard = false;
      
      prods.forEach(p => {
        const name = (p.product_name || p.name || '').toLowerCase();
        
        // Detect thickness from product field or name
        let thickness = p.thickness;
        if (!thickness) {
          const thickMatch = name.match(/(\d+)\s*mm/);
          if (thickMatch) thickness = thickMatch[1] + 'mm';
        }
        if (thickness) {
          if (!thicknessGroups[thickness]) thicknessGroups[thickness] = [];
          thicknessGroups[thickness].push(p);
        } else {
          // No thickness detected — track as "no-thickness" for later grouping
          if (!thicknessGroups['__none__']) thicknessGroups['__none__'] = [];
          thicknessGroups['__none__'].push(p);
        }
        
        // Detect special types
        const isSpecial = SPECIAL_KEYWORDS.some(kw => name.includes(kw));
        if (isSpecial) hasSpecial = true;
        else hasStandard = true;
      });
      
      // If some products have explicit thickness and others don't, split them
      const explicitThicknesses = Object.keys(thicknessGroups).filter(k => k !== '__none__');
      const noThicknessProducts = thicknessGroups['__none__'] || [];
      const hasThicknessVariants = explicitThicknesses.length >= 1 && (explicitThicknesses.length > 1 || noThicknessProducts.length > 0);
      const hasTypeVariants = hasSpecial && hasStandard;
      
      if (hasThicknessVariants || hasTypeVariants) {
        // Add the parent size option showing all products
        enhancedOptions.push({
          value: sizeKey,
          label: `${sizeDisplay} — All`,
          count: prods.length,
          isParent: true
        });
        
        // Add thickness sub-groups
        if (hasThicknessVariants) {
          // Show products without explicit thickness as "Standard"
          if (noThicknessProducts.length > 0) {
            enhancedOptions.push({
              value: `${sizeKey}__thickness:standard`,
              label: `${sizeDisplay} — Standard`,
              count: noThicknessProducts.length,
              isSubGroup: true
            });
          }
          explicitThicknesses
            .sort((a, b) => parseInt(a) - parseInt(b))
            .forEach(thickness => {
              const count = thicknessGroups[thickness].length;
              const isOutdoor = parseInt(thickness) >= 20;
              const suffix = isOutdoor ? ' (Outdoor)' : '';
              enhancedOptions.push({
                value: `${sizeKey}__thickness:${thickness}`,
                label: `${sizeDisplay} — ${thickness}${suffix}`,
                count,
                isSubGroup: true
              });
            });
        }
        
        // Add type sub-groups (Standard vs Decor/Feature)
        if (hasTypeVariants) {
          const standardCount = prods.filter(p => {
            const name = (p.product_name || p.name || '').toLowerCase();
            return !SPECIAL_KEYWORDS.some(kw => name.includes(kw));
          }).length;
          const specialCount = prods.filter(p => {
            const name = (p.product_name || p.name || '').toLowerCase();
            return SPECIAL_KEYWORDS.some(kw => name.includes(kw));
          }).length;
          
          if (standardCount > 0) {
            enhancedOptions.push({
              value: `${sizeKey}__type:standard`,
              label: `${sizeDisplay} — Standard`,
              count: standardCount,
              isSubGroup: true
            });
          }
          if (specialCount > 0) {
            enhancedOptions.push({
              value: `${sizeKey}__type:special`,
              label: `${sizeDisplay} — Decor/Feature`,
              count: specialCount,
              isSubGroup: true
            });
          }
        }
      } else {
        // No sub-groups needed — plain size option
        enhancedOptions.push({
          value: sizeKey,
          label: sizeDisplay,
          count: prods.length,
          isParent: false
        });
      }
    }
    
    return enhancedOptions;
  };
  
  // Get products filtered by size or by individual product for pricing updates
  const getProductsFilteredBySize = (sizeFilter = 'all') => {
    const selectedSkusList = Array.from(selectedProducts);
    let selectedProductsList = products.filter(p => selectedSkusList.includes(getProductKey(p)));
    
    // Keywords that identify special/accent tile types
    const SPECIAL_KEYWORDS = ['decor', 'feature', 'mosaic', 'border', 'listello', 'insert', 'strip', 'accent', 'muretto'];
    
    if (sizeFilter && sizeFilter !== 'all') {
      if (sizeFilter.startsWith('multi:')) {
        // Multi-select size filter: multi:value1\nvalue2\n...
        const selectedFilters = sizeFilter.substring(6).split('\n').filter(Boolean);
        selectedProductsList = selectedProductsList.filter(p => {
          return selectedFilters.some(sf => {
            if (sf.includes('__')) {
              const [baseSizeKey, subFilter] = sf.split('__');
              const name = p.product_name || p.name || '';
              const sizeMatch = name.match(/\d+(?:\.\d+)?[xX]\d+(?:\.\d+)?(?:[xX]\d+(?:\.\d+)?)?(?:cm|mm)?/);
              const productSize = sizeMatch ? sizeMatch[0] : (p.size || '');
              if (productSize.toLowerCase() !== baseSizeKey.toLowerCase()) return false;
              if (subFilter === 'type:standard') {
                const pName = (p.product_name || p.name || '').toLowerCase();
                return !SPECIAL_KEYWORDS.some(kw => pName.includes(kw));
              } else if (subFilter === 'type:special') {
                const pName = (p.product_name || p.name || '').toLowerCase();
                return SPECIAL_KEYWORDS.some(kw => pName.includes(kw));
              } else if (subFilter.startsWith('thickness:')) {
                const targetThickness = subFilter.substring(10);
                if (targetThickness === 'standard') {
                  if (p.thickness) return false;
                  const pName = (p.product_name || p.name || '').toLowerCase();
                  return !pName.match(/(\d+)\s*mm/);
                }
                if (p.thickness === targetThickness) return true;
                const pName = (p.product_name || p.name || '').toLowerCase();
                const thickMatch = pName.match(/(\d+)\s*mm/);
                return thickMatch && (thickMatch[1] + 'mm') === targetThickness;
              }
              return false;
            } else {
              const name = p.product_name || p.name || '';
              const sizeMatch = name.match(/\d+(?:\.\d+)?[xX]\d+(?:\.\d+)?(?:[xX]\d+(?:\.\d+)?)?(?:cm|mm)?/);
              const productSize = sizeMatch ? sizeMatch[0] : (p.size || '');
              return productSize.toLowerCase() === sf.toLowerCase();
            }
          });
        });
      } else if (sizeFilter.startsWith('product:')) {
        // Filter by individual product(s) (product:KEY or product:KEY1\nKEY2\n...)
        const productKeys = sizeFilter.substring(8).split('\n');
        selectedProductsList = selectedProductsList.filter(p => productKeys.includes(getProductKey(p)));
      } else if (sizeFilter.includes('__')) {
        // Compound filter: size__thickness:20mm or size__type:standard
        const [baseSizeKey, subFilter] = sizeFilter.split('__');
        
        // First filter by base size
        selectedProductsList = selectedProductsList.filter(p => {
          const name = p.product_name || p.name || '';
          const sizeMatch = name.match(/\d+(?:\.\d+)?[xX]\d+(?:\.\d+)?(?:[xX]\d+(?:\.\d+)?)?(?:cm|mm)?/);
          const productSize = sizeMatch ? sizeMatch[0] : (p.size || '');
          return productSize.toLowerCase() === baseSizeKey.toLowerCase();
        });
        
        // Then apply sub-filter
        if (subFilter.startsWith('thickness:')) {
          const targetThickness = subFilter.substring(10); // e.g., "20mm" or "standard"
          if (targetThickness === 'standard') {
            // Products WITHOUT explicit thickness (no thickness field AND no Xmm in name)
            selectedProductsList = selectedProductsList.filter(p => {
              if (p.thickness) return false;
              const name = (p.product_name || p.name || '').toLowerCase();
              const thickMatch = name.match(/(\d+)\s*mm/);
              return !thickMatch;
            });
          } else {
            selectedProductsList = selectedProductsList.filter(p => {
              if (p.thickness === targetThickness) return true;
              const name = (p.product_name || p.name || '').toLowerCase();
              const thickMatch = name.match(/(\d+)\s*mm/);
              return thickMatch && (thickMatch[1] + 'mm') === targetThickness;
            });
          }
        } else if (subFilter === 'type:standard') {
          selectedProductsList = selectedProductsList.filter(p => {
            const name = (p.product_name || p.name || '').toLowerCase();
            return !SPECIAL_KEYWORDS.some(kw => name.includes(kw));
          });
        } else if (subFilter === 'type:special') {
          selectedProductsList = selectedProductsList.filter(p => {
            const name = (p.product_name || p.name || '').toLowerCase();
            return SPECIAL_KEYWORDS.some(kw => name.includes(kw));
          });
        }
      } else {
        // Original size filter
        selectedProductsList = selectedProductsList.filter(p => {
          const name = p.product_name || p.name || '';
          const sizeMatch = name.match(/\d+(?:\.\d+)?[xX]\d+(?:\.\d+)?(?:[xX]\d+(?:\.\d+)?)?(?:cm|mm)?/);
          const productSize = sizeMatch ? sizeMatch[0] : (p.size || '');
          return productSize.toLowerCase() === sizeFilter.toLowerCase();
        });
      }
    }
    
    return selectedProductsList;
  };

  // Get human-readable label for the current pricing filter
  const getFilterDisplayLabel = (filter) => {
    if (!filter || filter === 'all') return 'All';
    if (filter.startsWith('multi:')) {
      const selectedFilters = filter.substring(6).split('\n').filter(Boolean);
      const count = getProductsFilteredBySize(filter).length;
      return `${selectedFilters.length} filter${selectedFilters.length !== 1 ? 's' : ''} (${count} products)`;
    }
    if (filter.startsWith('product:')) {
      const keys = filter.substring(8).split('\n');
      if (keys.length === 1) {
        const key = keys[0];
        const selectedSkusList = Array.from(selectedProducts);
        const prod = products.find(p => selectedSkusList.includes(getProductKey(p)) && getProductKey(p) === key);
        if (prod) {
          const name = prod.product_name || prod.name || prod.sku;
          return name.length > 35 ? name.substring(0, 35) + '...' : name;
        }
        return key.split('|||')[1] || key;
      }
      return `${keys.length} products`;
    }
    if (filter.includes('__')) {
      const [baseSizeKey, subFilter] = filter.split('__');
      if (subFilter.startsWith('thickness:')) {
        const thickness = subFilter.substring(10);
        return `${baseSizeKey} — ${thickness}`;
      } else if (subFilter === 'type:standard') {
        return `${baseSizeKey} — Standard`;
      } else if (subFilter === 'type:special') {
        return `${baseSizeKey} — Decor/Feature`;
      }
    }
    return filter;
  };
  
  // Get unique editable words from selected products (excluding colors and sizes)
  const getEditableWords = () => {
    const selectedSkusList = Array.from(selectedProducts);
    const selectedProductsList = products.filter(p => selectedSkusList.includes(getProductKey(p)));
    
    const wordCounts = {};
    const seriesName = bulkRenameForm.currentSeriesName?.toLowerCase() || '';
    
    selectedProductsList.forEach(p => {
      const name = p.product_name || p.name || '';
      const { words } = parseProductName(name);
      words.forEach(word => {
        const lowerWord = word.toLowerCase();
        // Skip the series name - it's shown separately
        if (seriesName && lowerWord === seriesName) return;
        
        if (!wordCounts[lowerWord]) {
          wordCounts[lowerWord] = { original: word, count: 0 };
        }
        wordCounts[lowerWord].count++;
      });
    });
    
    // Return words that appear in multiple products, sorted by count
    return Object.values(wordCounts)
      .filter(w => w.count > 0)
      .sort((a, b) => b.count - a.count);
  };

  // Get ALL words from the display name (including colors, sizes, finishes) for deletion
  const getAllDisplayNameWords = () => {
    const selectedSkusList = Array.from(selectedProducts);
    const selectedProductsList = products.filter(p => selectedSkusList.includes(getProductKey(p)));
    
    if (selectedProductsList.length === 0) return [];
    
    // Get all unique words across selected products
    const wordCounts = {};
    
    selectedProductsList.forEach(p => {
      const name = p.product_name || p.name || '';
      // Split name into all parts including sizes
      const allParts = name.split(/\s+/).filter(Boolean);
      
      allParts.forEach(part => {
        const lowerPart = part.toLowerCase();
        if (!wordCounts[lowerPart]) {
          wordCounts[lowerPart] = { original: part, count: 0, type: 'word' };
          
          // Identify type
          if (/^\d+(\.\d+)?[xX]\d+/.test(part)) {
            wordCounts[lowerPart].type = 'size';
          } else if (COLOR_WORDS.some(c => c.toLowerCase() === part.replace(/[^a-zA-Z]/g, '').toLowerCase())) {
            wordCounts[lowerPart].type = 'color';
          } else if (['Matt', 'Matte', 'Polished', 'Gloss', 'Glossy', 'Satin', 'Honed', 'Lappato', 'Natural', 'Structured', 'Textured', 'Rectified'].some(f => f.toLowerCase() === part.replace(/[^a-zA-Z]/g, '').toLowerCase())) {
            wordCounts[lowerPart].type = 'finish';
          }
        }
        wordCounts[lowerPart].count++;
      });
    });
    
    // Return all words sorted by count
    return Object.values(wordCounts)
      .filter(w => w.count > 0)
      .sort((a, b) => b.count - a.count);
  };

  // Get editable words from supplier_product_name field
  const getSupplierNameWords = () => {
    const selectedSkusList = Array.from(selectedProducts);
    const selectedProductsList = products.filter(p => selectedSkusList.includes(getProductKey(p)));
    
    const wordCounts = {};
    
    selectedProductsList.forEach(p => {
      const supplierName = p.supplier_product_name || p.name || '';
      const { words } = parseProductName(supplierName);
      words.forEach(word => {
        const lowerWord = word.toLowerCase();
        if (!wordCounts[lowerWord]) {
          wordCounts[lowerWord] = { original: word, count: 0 };
        }
        wordCounts[lowerWord].count++;
      });
    });
    
    // Return words sorted by count
    return Object.values(wordCounts)
      .filter(w => w.count > 0)
      .sort((a, b) => b.count - a.count);
  };

  // Get selected products data for preview panel
  const getSelectedProductsForPreview = () => {
    const selectedSkusList = Array.from(selectedProducts);
    const selectedProductsList = products.filter(p => selectedSkusList.includes(getProductKey(p)));
    return selectedProductsList;
  };

  // Generate website preview URL for a product
  const getWebsitePreviewUrl = (product) => {
    if (!product) return null;
    // Create slug from admin display name first, then fallback to supplier name
    const name = product.our_product_name || product.display_name || product.product_name || product.name || '';
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    // Use the shop tiles route
    return `/tiles/${slug}`;
  };

  // Open product on website - ensures it's published first with correct slug
  const openOnWebsite = async (product) => {
    if (!product) return;
    
    const name = product.our_product_name || product.display_name || product.product_name || product.name || '';
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    const url = `/tiles/${slug}`;
    
    // First ensure the product is published to tiles with correct name/slug
    try {
      // Quick update to sync name and slug to tiles
      await api.put('/supplier-sync/products/quick-update', {
        supplier: product.supplier,
        sku: product.sku,
        product_name: name // This will trigger slug update in tiles
      });
      
      // Open in new tab
      window.open(url, '_blank');
    } catch (error) {
      console.error('Failed to sync before opening:', error);
      // Still try to open even if sync fails
      window.open(url, '_blank');
    }
  };

  // Publish selected products to website
  const publishSelectedToWebsite = async () => {
    const selectedSkusList = Array.from(selectedProducts);
    const selectedProductsList = products.filter(p => selectedSkusList.includes(getProductKey(p)));
    
    if (selectedProductsList.length === 0) {
      toast.error('No products selected');
      return;
    }

    setPublishingToWebsite(true);
    try {
      // Get SKUs of selected products
      const skus = selectedProductsList.map(p => p.sku).join(',');
      
      // Publish only the selected SKUs
      const response = await api.post(`/supplier-sync/publish-to-website?skus=${encodeURIComponent(skus)}&with_price_only=false&product_group=${encodeURIComponent(selectedProductGroup || 'tiles')}`);
      
      toast.success(`Published ${response.data.total_processed} products to website`);
      // Refresh products to update publish status
      fetchProducts();
    } catch (error) {
      console.error('Publish error:', error);
      toast.error('Failed to publish: ' + (error.response?.data?.detail || error.message));
    } finally {
      setPublishingToWebsite(false);
    }
  };

  // Unpublish selected products from website
  const [unpublishingFromWebsite, setUnpublishingFromWebsite] = useState(false);
  
  const unpublishSelectedFromWebsite = async () => {
    const selectedSkusList = Array.from(selectedProducts);
    const selectedProductsList = products.filter(p => selectedSkusList.includes(getProductKey(p)));
    
    if (selectedProductsList.length === 0) {
      toast.error('No products selected');
      return;
    }

    // Confirm action
    if (!window.confirm(`Are you sure you want to unpublish ${selectedProductsList.length} products from the website?`)) {
      return;
    }

    setUnpublishingFromWebsite(true);
    try {
      const skus = selectedProductsList.map(p => p.sku).join(',');
      const response = await api.delete(`/supplier-sync/unpublish-from-website?skus=${encodeURIComponent(skus)}`);
      
      toast.success(`Unpublished ${response.data.deleted_count} products from website`);
      // Refresh products to update status
      fetchProducts();
    } catch (error) {
      console.error('Unpublish error:', error);
      toast.error('Failed to unpublish: ' + (error.response?.data?.detail || error.message));
    } finally {
      setUnpublishingFromWebsite(false);
    }
  };
  
  // Fix draft status for selected products
  const fixDraftStatus = async () => {
    if (selectedProducts.size === 0) {
      toast.error('No products selected');
      return;
    }
    
    try {
      // Extract SKUs/identifiers from selected products
      const selectedKeys = Array.from(selectedProducts);
      const selectedProds = products.filter(p => selectedKeys.includes(getProductKey(p)));
      const skus = selectedProds.map(p => p.sku || p.supplier_code || p._id).filter(Boolean);
      
      const response = await fetch(`${API_URL}/api/supplier-sync/products/fix-draft-status`, {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${localStorage.getItem('token')}`
        },
        body: JSON.stringify({ skus: skus })
      });
      
      if (response.ok) {
        const result = await response.json();
        // Update local state
        setProducts(prev => prev.map(p => {
          if (skus.includes(p.sku) || skus.includes(p.supplier_code) || skus.includes(p._id)) {
            return { 
              ...p, 
              visibility: 'published', 
              status: 'active',
              show_on_website: true 
            };
          }
          return p;
        }));
        toast.success(result.message);
        setSelectedProducts(new Set());
      } else {
        const error = await response.json();
        toast.error(error.detail || 'Failed to fix draft status');
      }
    } catch (error) {
      console.error('Fix draft status error:', error);
      toast.error('Failed to fix draft status');
    }
  };
  
  // Quick Edit Modal state
  const [showQuickEditModal, setShowQuickEditModal] = useState(false);
  const [quickEditProduct, setQuickEditProduct] = useState(null);
  const [quickEditLoading, setQuickEditLoading] = useState(false);
  const [categorySuggestions, setCategorySuggestions] = useState([]);
  const [showCategorySuggestions, setShowCategorySuggestions] = useState(false);
  const [quickEditForm, setQuickEditForm] = useState({
    name: '',
    // Customer-facing fields
    display_name: '',
    display_code: '',
    // Internal fields
    supplier_product_name: '',
    supplier_product_code: '',
    // Legacy fields (for backwards compatibility)
    product_name: '',
    original_series: '',
    // Other fields
    price: '',
    cost_price: '',
    stock_quantity: '',
    stock_m2: '',
    category: '',
    finish: '',
    in_stock: true,
    always_in_stock: false,
    images: []  // For image management
  });
  const [quickEditImageUploading, setQuickEditImageUploading] = useState(false);
  const [draggedImageIndex, setDraggedImageIndex] = useState(null);
  
  // Display code preview state
  const [displayCodePreview, setDisplayCodePreview] = useState('');
  
  // Website preview states
  const [publishingToWebsite, setPublishingToWebsite] = useState(false);
  const [showWebsitePreviewCard, setShowWebsitePreviewCard] = useState(false);

  // Canopy Stock Update Modal state
  const [showCanopyStockModal, setShowCanopyStockModal] = useState(false);
  const [canopyStockLoading, setCanopyStockLoading] = useState(false);
  const [canopyStockText, setCanopyStockText] = useState('');
  const [canopyStockPreview, setCanopyStockPreview] = useState(null);
  const [canopyStockStep, setCanopyStockStep] = useState('input'); // 'input', 'preview', 'result'

  // ============ STATE PERSISTENCE FOR PAGE REFRESH ============
  // Keys for localStorage
  const STORAGE_KEYS = {
    selectedProducts: 'supplier_products_selected',
    showBulkCategoryModal: 'supplier_products_modal_open',
    supplierFilter: 'supplier_products_filter',
    bulkCategorySelections: 'supplier_products_bulk_selections'
  };

  // Restore state from localStorage on mount
  useEffect(() => {
    try {
      // Restore selected products
      const savedSelected = localStorage.getItem(STORAGE_KEYS.selectedProducts);
      if (savedSelected) {
        const parsed = JSON.parse(savedSelected);
        if (Array.isArray(parsed) && parsed.length > 0) {
          setSelectedProducts(new Set(parsed));
          console.log(`Restored ${parsed.length} selected products from storage`);
        }
      }
      
      // Restore bulk category selections (the actual modal values)
      const savedSelections = localStorage.getItem(STORAGE_KEYS.bulkCategorySelections);
      if (savedSelections) {
        const parsed = JSON.parse(savedSelections);
        if (parsed && typeof parsed === 'object') {
          setBulkCategorySelections(prev => ({ ...prev, ...parsed }));
          console.log('Restored bulk category selections from storage');
        }
      }
      
      // Restore modal state - flag it so we can run reconstruction after products load
      const savedModalOpen = localStorage.getItem(STORAGE_KEYS.showBulkCategoryModal);
      if (savedModalOpen === 'true') {
        pendingModalRestoreRef.current = true;
      }
      
      // Restore supplier filter from URL if present
      const urlParams = new URLSearchParams(window.location.search);
      const supplierFromUrl = urlParams.get('supplier');
      if (supplierFromUrl) {
        setSelectedSupplier(supplierFromUrl);
      }
    } catch (e) {
      console.error('Error restoring state from localStorage:', e);
    }
  }, []);

  // Save selected products to localStorage when they change
  useEffect(() => {
    try {
      if (selectedProducts.size > 0) {
        localStorage.setItem(STORAGE_KEYS.selectedProducts, JSON.stringify(Array.from(selectedProducts)));
      } else {
        localStorage.removeItem(STORAGE_KEYS.selectedProducts);
      }
    } catch (e) {
      console.error('Error saving selected products to localStorage:', e);
    }
  }, [selectedProducts]);

  // Save modal state to localStorage when it changes
  useEffect(() => {
    try {
      if (showBulkCategoryModal) {
        localStorage.setItem(STORAGE_KEYS.showBulkCategoryModal, 'true');
      } else {
        localStorage.removeItem(STORAGE_KEYS.showBulkCategoryModal);
      }
    } catch (e) {
      console.error('Error saving modal state to localStorage:', e);
    }
  }, [showBulkCategoryModal]);
  
  // Save bulk category selections to localStorage when they change
  useEffect(() => {
    try {
      // Only save if there's something meaningful selected
      const hasSelections = Object.values(bulkCategorySelections).some(val => {
        if (Array.isArray(val)) return val.length > 0;
        if (typeof val === 'boolean') return val;
        return val !== '' && val !== null && val !== undefined;
      });
      
      if (hasSelections) {
        localStorage.setItem(STORAGE_KEYS.bulkCategorySelections, JSON.stringify(bulkCategorySelections));
      } else {
        localStorage.removeItem(STORAGE_KEYS.bulkCategorySelections);
      }
    } catch (e) {
      console.error('Error saving bulk category selections to localStorage:', e);
    }
  }, [bulkCategorySelections]);

  // Clear persisted state when modal is closed intentionally (via Cancel or Apply)
  const clearPersistedState = useCallback(() => {
    try {
      localStorage.removeItem(STORAGE_KEYS.selectedProducts);
      localStorage.removeItem(STORAGE_KEYS.showBulkCategoryModal);
      localStorage.removeItem(STORAGE_KEYS.bulkCategorySelections);
    } catch (e) {
      console.error('Error clearing persisted state:', e);
    }
  }, []);

  // ============ END STATE PERSISTENCE ============

  // ============ AUTO-SAVE DRAFT ============
  
  // Save draft to server
  const saveDraftToServer = useCallback(async () => {
    const hasSelections = Object.values(bulkCategorySelections).some(val => {
      if (Array.isArray(val)) return val.length > 0;
      if (typeof val === 'boolean') return val;
      return val !== '' && val !== null && val !== undefined;
    });
    
    if (!hasSelections || !showBulkCategoryModal) return;
    
    // Skip if nothing changed since last save
    const currentJson = JSON.stringify(bulkCategorySelections);
    if (lastSavedSelectionsRef.current === currentJson) return;
    
    setAutoSaveStatus('saving');
    try {
      const res = await fetch(`${API_URL}/api/bulk-edit-tools/draft`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          user: 'admin',
          selections: bulkCategorySelections,
          selected_products: Array.from(selectedProducts),
          product_group: selectedProductGroup || '',
          supplier: selectedSupplier || '',
        }),
      });
      if (res.ok) {
        lastSavedSelectionsRef.current = currentJson;
        setAutoSaveStatus('saved');
        setLastAutoSaveTime(Date.now());
      } else {
        setAutoSaveStatus('error');
      }
    } catch (e) {
      setAutoSaveStatus('error');
    }
  }, [bulkCategorySelections, showBulkCategoryModal, selectedProducts, selectedProductGroup, selectedSupplier]);

  // Start/stop auto-save timer when modal opens/closes
  useEffect(() => {
    if (showBulkCategoryModal) {
      // Auto-save every 30 seconds
      autoSaveTimerRef.current = setInterval(() => {
        saveDraftToServer();
      }, 30000);
      return () => clearInterval(autoSaveTimerRef.current);
    } else {
      if (autoSaveTimerRef.current) {
        clearInterval(autoSaveTimerRef.current);
        autoSaveTimerRef.current = null;
      }
      setAutoSaveStatus(null);
      setLastAutoSaveTime(null);
    }
  }, [showBulkCategoryModal, saveDraftToServer]);

  // Check for server-side draft when modal opens
  const checkForDraft = useCallback(async () => {
    try {
      const res = await fetch(`${API_URL}/api/bulk-edit-tools/draft?user=admin`);
      if (res.ok) {
        const draft = await res.json();
        if (draft && draft.selections && Object.keys(draft.selections).length > 0) {
          setRecoveredDraft(draft);
          setShowDraftRecovery(true);
        }
      }
    } catch (e) {
      // Silent — draft recovery is best-effort
    }
  }, []);

  // Clear server-side draft
  const clearServerDraft = useCallback(async () => {
    try {
      await fetch(`${API_URL}/api/bulk-edit-tools/draft?user=admin`, { method: 'DELETE' });
    } catch (e) { /* silent */ }
    lastSavedSelectionsRef.current = null;
  }, []);

  // ============ END AUTO-SAVE DRAFT ============

  // Check user role on mount
  useEffect(() => {
    const user = JSON.parse(localStorage.getItem('user') || '{}');
    setUserRole(user.role || 'staff');
  }, []);

  // Restore modal from localStorage only once products and category data are loaded
  useEffect(() => {
    if (pendingModalRestoreRef.current && products.length > 0 && selectedProducts.size > 0 && categoryGroupsWithCats.length > 0) {
      pendingModalRestoreRef.current = false;
      openBulkCategoryModal();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [products, selectedProducts, categoryGroupsWithCats]);

  // Lock body scroll when Options Manager modal is open
  // Also add a class to body to disable pointer events on Dialog overlays
  useEffect(() => {
    if (showOptionsManager || showBulkCategoryModal) {
      document.body.style.overflow = 'hidden';
    } else {
      document.body.style.overflow = '';
    }
    return () => {
      document.body.style.overflow = '';
    };
  }, [showOptionsManager, showBulkCategoryModal]);

  // When Options Manager is open, disable pointer events on parent Dialog overlays
  useEffect(() => {
    if (showOptionsManager) {
      // Small delay to ensure Dialog overlay is rendered
      const timeoutId = setTimeout(() => {
        // Find and disable pointer events on all Dialog overlays
        // Target elements with specific Radix dialog attributes
        const overlays = document.querySelectorAll('[data-state="open"][aria-hidden="true"]');
        overlays.forEach(overlay => {
          overlay.style.setProperty('pointer-events', 'none', 'important');
        });
        
        // Also target by class pattern - Dialog overlays have these classes
        const allFixedElements = document.querySelectorAll('.fixed.inset-0');
        allFixedElements.forEach(el => {
          // Check if it's a dialog overlay (has z-50 and bg-black/80)
          const hasOverlayClasses = el.classList.contains('z-50') && 
            (el.className.includes('bg-black') || el.getAttribute('data-state') === 'open');
          if (hasOverlayClasses) {
            el.style.setProperty('pointer-events', 'none', 'important');
          }
        });
      }, 100);
      
      return () => {
        clearTimeout(timeoutId);
        // Re-enable pointer events on cleanup
        const overlays = document.querySelectorAll('[data-state="open"][aria-hidden="true"]');
        overlays.forEach(overlay => {
          overlay.style.removeProperty('pointer-events');
        });
        const allFixedElements = document.querySelectorAll('.fixed.inset-0');
        allFixedElements.forEach(el => {
          el.style.removeProperty('pointer-events');
        });
      };
    }
  }, [showOptionsManager]);

  const isSuperAdmin = userRole === 'SUPER_ADMIN' || userRole === 'super_admin';
  const isAdminOrHigher = isSuperAdmin || userRole === 'ADMIN' || userRole === 'admin';
  const { hasAction } = usePermissions();

  // Helper function to check if product is new (not yet added to Products database)
  // Shows NEW tag only for products with blue + sign (needs adding to database)
  const isNewProduct = (product) => {
    return !product.in_products_db;
  };

  // Form state for add/edit
  const [formData, setFormData] = useState({
    sku: '',
    name: '',
    description: '',
    category: '',
    material: '',
    finish: '',
    length_mm: '',
    width_mm: '',
    price: '',
    stock_quantity: '',
    in_stock: true
  });

  // Add supplier product to main product database
  const handleAddToDatabase = async (product) => {
    try {
      const response = await fetch(`${API_URL}/api/supplier-sync/products/add-to-database`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sku: product.sku || product.supplier_code,
          supplier: product.supplier
        })
      });

      if (response.ok) {
        const result = await response.json();
        // Update local state immediately - clear draft status
        setProducts(prev => prev.map(p => 
          (p.sku || p.supplier_code) === (product.sku || product.supplier_code) ? { 
            ...p, 
            in_products_db: true,
            visibility: 'published',
            status: 'active',
            show_on_website: true
          } : p
        ));
        
        if (result.already_existed) {
          toast.info('Product already exists in database');
        } else {
          toast.success('Product added to database');
        }
      } else {
        const error = await response.json();
        toast.error(error.detail || 'Failed to add product');
      }
    } catch (error) {
      console.error('Add to database error:', error);
      toast.error('Failed to add product to database');
    }
  };

  // Bulk add all products from selected supplier to database
  const [importingSuppliers, setImportingSuppliers] = useState(false);

  // Quick publish/unpublish a single product from the Live column badge
  const handleTogglePublish = async (product) => {
    const sku = product.sku || product.supplier_code;
    if (!sku) {
      toast.error('Product has no SKU or supplier code');
      return;
    }
    const isCurrentlyLive = product.show_on_website;

    try {
      if (isCurrentlyLive) {
        // Unpublish
        const response = await api.delete(`/supplier-sync/unpublish-from-website?skus=${encodeURIComponent(sku)}`);
        setProducts(prev => prev.map(p =>
          (p.sku || p.supplier_code) === sku ? { ...p, show_on_website: false } : p
        ));
        toast.success('Product removed from storefront');
      } else {
        // Publish
        const response = await api.post(`/supplier-sync/publish-to-website?skus=${encodeURIComponent(sku)}&with_price_only=false&product_group=${encodeURIComponent(selectedProductGroup || 'tiles')}`);
        setProducts(prev => prev.map(p =>
          (p.sku || p.supplier_code) === sku ? { ...p, show_on_website: true, in_products_db: true, visibility: 'published', status: 'active' } : p
        ));
        toast.success('Product published to storefront');
      }
    } catch (error) {
      console.error('Toggle publish error:', error);
      toast.error(`Failed to ${isCurrentlyLive ? 'unpublish' : 'publish'}: ${error.response?.data?.detail || error.message}`);
    }
  };
  const handleImportNewSuppliers = async () => {
    if (!window.confirm('Import RSA Tiles (28 products) and ThermoSphere (136 products) into the database?')) return;
    setImportingSuppliers(true);
    try {
      const token = localStorage.getItem('token');
      const response = await fetch(`${API_URL}/api/supplier-import/import-all`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` }
      });
      if (!response.ok) throw new Error('Import failed');
      const data = await response.json();
      const rsa = data.results?.rsa_tiles;
      const ts = data.results?.thermosphere;
      toast.success(`Imported: RSA Tiles (${rsa?.total || 0}), ThermoSphere (${ts?.total || 0})`);
      fetchProducts();
      fetchStats();
    } catch (error) {
      toast.error('Failed to import suppliers: ' + error.message);
    } finally {
      setImportingSuppliers(false);
    }
  };

  const handleBulkAddToDatabase = async () => {
    if (selectedSupplier === 'all') {
      toast.error('Please select a specific supplier');
      return;
    }

    if (!window.confirm(`Add all ${selectedSupplier} products to the main Products database?`)) {
      return;
    }

    try {
      const response = await fetch(`${API_URL}/api/supplier-sync/products/bulk-add-to-database`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ supplier: selectedSupplier })
      });

      if (response.ok) {
        const result = await response.json();
        toast.success(result.message);
        if (result.error_details && result.error_details.length > 0) {
          toast.warning(`${result.errors} product(s) had errors: ${result.error_details[0]}`);
        }
        fetchProducts(); // Refresh to update in_products_db status
      } else {
        let errorMsg = `Server error (${response.status})`;
        try {
          const error = await response.json();
          errorMsg = error.detail || errorMsg;
        } catch (e) {
          // Response wasn't JSON
        }
        toast.error(errorMsg);
      }
    } catch (error) {
      console.error('Bulk add error:', error);
      toast.error(`Bulk add failed: ${error.message || 'Network error - request may have timed out'}`);
    }
  };

  // Fetch the list of "hidden" suppliers — the ones an admin has hard-
  // deleted via the "Delete Supplier Entirely" flow. Those chips are
  // filtered out of the tab row until they're explicitly restored.
  const fetchHiddenSuppliers = useCallback(async () => {
    try {
      const res = await fetch(`${API_URL}/api/supplier-sync/suppliers/hidden`);
      if (!res.ok) return;
      const data = await res.json();
      setHiddenSuppliers(Array.isArray(data.hidden) ? data.hidden : []);
    } catch {
      // silent — chip filter is best-effort; falling back to full list is fine
    }
  }, []);

  useEffect(() => { fetchHiddenSuppliers(); }, [fetchHiddenSuppliers]);

  // Restore a previously hidden supplier so its chip re-appears in the
  // supplier tab row. Used by the "Restore" links in the hidden-chips
  // footer strip.
  const restoreHiddenSupplier = async (supplierName) => {
    try {
      const res = await fetch(`${API_URL}/api/supplier-sync/suppliers/${encodeURIComponent(supplierName)}/restore`, { method: 'POST' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      toast.success(`Restored '${supplierName}' — chip visible again`);
      fetchHiddenSuppliers();
    } catch (err) {
      toast.error(`Restore failed: ${err.message}`);
    }
  };

  // Open the "Delete Supplier Entirely" modal for one supplier. Fetches
  // a live impact-count from the backend so the admin sees exactly what
  // will be removed before typing anything.
  const openDeleteSupplierEntirely = async (supplierName) => {
    setDeleteSupplierState({
      name: supplierName,
      impact: null,
      password: '',
      confirmName: '',
      loading: true,
      result: null,
    });
    try {
      const res = await fetch(`${API_URL}/api/supplier-sync/suppliers/${encodeURIComponent(supplierName)}/impact`);
      if (res.ok) {
        const impact = await res.json();
        setDeleteSupplierState(prev => prev && prev.name === supplierName ? { ...prev, impact, loading: false } : prev);
      } else {
        setDeleteSupplierState(prev => prev && prev.name === supplierName ? { ...prev, loading: false } : prev);
      }
    } catch {
      setDeleteSupplierState(prev => prev && prev.name === supplierName ? { ...prev, loading: false } : prev);
    }
  };

  const confirmDeleteSupplierEntirely = async () => {
    if (!deleteSupplierState) return;
    const { name, password, confirmName } = deleteSupplierState;
    if (!(password || '').trim()) { toast.error('Super Admin password required'); return; }
    if ((confirmName || '').trim().toLowerCase() !== (name || '').trim().toLowerCase()) { toast.error(`Type the supplier name exactly: '${name}'`); return; }
    setDeleteSupplierState(prev => ({ ...prev, loading: true }));
    try {
      const res = await fetch(`${API_URL}/api/supplier-sync/suppliers/delete-entirely`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ supplier: name, password, confirm_name: confirmName }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || `HTTP ${res.status}`);
      setDeleteSupplierState(prev => ({ ...prev, loading: false, result: data }));
      toast.success(data.message);
      // If we just deleted the currently-selected supplier, drop back to 'all'.
      if (selectedSupplier === name) setSelectedSupplier('all');
      // Refresh the hidden-suppliers list so the chip disappears immediately.
      fetchHiddenSuppliers();
      fetchProducts();
    } catch (err) {
      toast.error(`Delete failed: ${err.message}`);
      setDeleteSupplierState(prev => ({ ...prev, loading: false }));
    }
  };

  // Delete all products from selected supplier from the database
  const handleDeleteAllFromDatabase = async () => {
    if (selectedSupplier === 'all') {
      toast.error('Please select a specific supplier');
      return;
    }

    if (!deleteAllDbPassword) {
      toast.error('Super Admin password is required');
      return;
    }

    setDeleteAllDbLoading(true);
    try {
      // Use the clear-supplier-products endpoint (deletes from supplier_products collection)
      const response = await fetch(`${API_URL}/api/supplier-sync/products/clear-supplier-products`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          supplier: selectedSupplier,
          password: deleteAllDbPassword
        })
      });

      if (response.ok) {
        const result = await response.json();
        toast.success(result.message);
        setShowDeleteAllDbDialog(false);
        setDeleteAllDbPassword('');
        setDeleteAllDbCount(null);
        fetchProducts(); // Refresh the product list
      } else {
        const error = await response.json();
        toast.error(error.detail || 'Delete failed');
      }
    } catch (error) {
      console.error('Clear supplier products error:', error);
      toast.error('Failed to clear supplier products');
    } finally {
      setDeleteAllDbLoading(false);
    }
  };

  // Fetch count of products in supplier_products for selected supplier
  const fetchDeleteCount = async () => {
    if (selectedSupplier === 'all') return;
    
    setDeleteAllDbCountLoading(true);
    try {
      // Use the supplier_products count endpoint (not the main products database)
      const response = await fetch(`${API_URL}/api/supplier-sync/products/count-supplier-products?supplier=${encodeURIComponent(selectedSupplier)}`);
      if (response.ok) {
        const result = await response.json();
        setDeleteAllDbCount(result.count);
      }
    } catch (error) {
      console.error('Failed to fetch delete count:', error);
    } finally {
      setDeleteAllDbCountLoading(false);
    }
  };

  // ============================================================
  // CUSTOM MAPPINGS FUNCTIONS
  // ============================================================
  
  // Fetch all custom mappings
  const fetchCustomMappings = async () => {
    setCustomMappingsLoading(true);
    try {
      const response = await fetch(`${API_URL}/api/supplier-sync/custom-mappings`);
      if (response.ok) {
        const data = await response.json();
        setCustomMappings(data.mappings || []);
        setCustomMappingsBySupplier(data.by_supplier || {});
      } else {
        toast.error('Failed to fetch custom mappings');
      }
    } catch (error) {
      console.error('Fetch custom mappings error:', error);
      toast.error('Failed to fetch custom mappings');
    } finally {
      setCustomMappingsLoading(false);
    }
  };
  
  // Open custom mappings modal
  const openCustomMappingsModal = () => {
    setShowCustomMappingsModal(true);
    setCustomMappingsFilter(selectedSupplier !== 'all' ? selectedSupplier : 'all');
    fetchCustomMappings();
  };
  
  // Delete a custom mapping
  const deleteCustomMapping = async (supplier, sku) => {
    if (!window.confirm(`Delete custom mapping for ${supplier} / ${sku}?\n\nThis will revert the product name to the auto-generated name on the next sync.`)) {
      return;
    }
    
    try {
      const response = await fetch(`${API_URL}/api/supplier-sync/custom-mappings/${encodeURIComponent(supplier)}/${encodeURIComponent(sku)}`, {
        method: 'DELETE'
      });
      
      if (response.ok) {
        toast.success('Custom mapping deleted');
        fetchCustomMappings();
      } else {
        const error = await response.json();
        toast.error(error.detail || 'Failed to delete mapping');
      }
    } catch (error) {
      console.error('Delete mapping error:', error);
      toast.error('Failed to delete mapping');
    }
  };
  
  // Update a custom mapping
  const updateCustomMapping = async (supplier, sku, newName) => {
    if (!newName.trim()) {
      toast.error('Name cannot be empty');
      return;
    }
    
    try {
      const response = await fetch(`${API_URL}/api/supplier-sync/custom-mappings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          supplier,
          sku,
          custom_name: newName.trim()
        })
      });
      
      if (response.ok) {
        toast.success('Custom mapping updated');
        setEditingMapping(null);
        fetchCustomMappings();
      } else {
        const error = await response.json();
        toast.error(error.detail || 'Failed to update mapping');
      }
    } catch (error) {
      console.error('Update mapping error:', error);
      toast.error('Failed to update mapping');
    }
  };
  
  // Filter custom mappings based on search and supplier filter
  const filteredCustomMappings = customMappings.filter(m => {
    const matchesSupplier = customMappingsFilter === 'all' || m.supplier === customMappingsFilter;
    const matchesSearch = !customMappingsSearch || 
      (m.original_name || '').toLowerCase().includes(customMappingsSearch.toLowerCase()) ||
      (m.custom_name || '').toLowerCase().includes(customMappingsSearch.toLowerCase()) ||
      (m.sku || '').toLowerCase().includes(customMappingsSearch.toLowerCase());
    return matchesSupplier && matchesSearch;
  });

  // Open delete dialog and fetch count
  const handleOpenDeleteDialog = () => {
    setShowDeleteAllDbDialog(true);
    fetchDeleteCount();
  };

  // Fix Product Names - applies name transformation to all products for selected supplier
  const handleFixProductNames = async () => {
    if (selectedSupplier === 'all') {
      toast.error('Please select a specific supplier first');
      return;
    }
    
    if (!window.confirm(`Apply name mapping to all ${selectedSupplier} products?\n\nThis will transform raw supplier names to unique display names (e.g., "Brook Grey 60x60" → "Orvieto Grey 60x60").`)) {
      return;
    }
    
    setFixingProductNames(true);
    try {
      const response = await fetch(`${API_URL}/api/supplier-sync/products/fix-product-names?supplier=${encodeURIComponent(selectedSupplier)}`, {
        method: 'POST'
      });
      
      if (response.ok) {
        const result = await response.json();
        toast.success(`Fixed ${result.fixed} product names for ${selectedSupplier}`);
        // Refresh products to show updated names
        fetchProducts();
      } else {
        const error = await response.json();
        toast.error(error.detail || 'Failed to fix product names');
      }
    } catch (error) {
      console.error('Fix product names error:', error);
      toast.error('Failed to fix product names');
    } finally {
      setFixingProductNames(false);
    }
  };

  // Get supplier code for EPOS display
  const getSupplierCode = (supplier) => {
    const codes = {
      'Verona': 'V',
      'Splendour': 'SP',
      'Wallcano': 'W',
      'Ceramica Impex': 'CI',
      'Tile Rite': 'TR',
      'Ultra Tile': 'UT',
      'Trimline': 'TL',
      'LEPORCE': 'LP',
      'H Martin': 'HM',
      'Tilebase': 'TB',
      'Bloomstone': 'BS',
      'Boyden': 'BY',
      'Regulus': 'RG',
      'Eagle': 'EG',
      'Plus39': 'P39'
    };
    return codes[supplier] || supplier?.charAt(0)?.toUpperCase() || 'S';
  };

  // Fetch products based on supplier filter
  const fetchProducts = useCallback(async () => {
    setLoading(true);
    try {
      const skip = (currentPage - 1) * productsPerPage;
      let url = `${API_URL}/api/supplier-sync/products?skip=${skip}&limit=${productsPerPage}`;
      
      if (selectedSupplier !== 'all') {
        url += `&supplier=${encodeURIComponent(selectedSupplier)}`;
      }
      if (searchTerm) {
        url += `&search=${encodeURIComponent(searchTerm)}`;
      }
      if (showNewOnly) {
        url += `&new_only=true`;
      }
      // Apply series filter at the DB layer — without this, the local
      // filter would only see the current 50-product page and could
      // return zero matches even when 13 products exist for the series
      // (just on later pages). Critical when "All Suppliers" is selected
      // and the catalogue is 1700+ products long.
      if (seriesFilter) {
        url += `&series=${encodeURIComponent(seriesFilter)}`;
      }

      const response = await fetch(url);
      if (response.ok) {
        const data = await response.json();
        const fetchedProducts = data.products || [];
        setProducts(fetchedProducts);
        setTotalProducts(data.total || 0);
        
        // Count new products
        const newCount = fetchedProducts.filter(isNewProduct).length;
        setNewProductCount(data.new_products_count || newCount);
        
        // Update supplier-specific stats from backend
        setSupplierStats({
          withPrices: data.with_prices_count || 0,
          inStock: data.in_stock_count || 0,
          outOfStock: data.out_of_stock_count || 0
        });
        
        return fetchedProducts; // Return for post-save breakdown refresh
      }
    } catch (error) {
      console.error('Error fetching products:', error);
      toast.error('Failed to load products');
    } finally {
      setLoading(false);
    }
    return null;
  }, [currentPage, selectedSupplier, searchTerm, showNewOnly, productsPerPage, seriesFilter]);

  // Fetch stats for all suppliers
  const fetchStats = async () => {
    try {
      const response = await fetch(`${API_URL}/api/supplier-sync/stats`);
      if (response.ok) {
        const data = await response.json();
        setStats(data);
      }
    } catch (error) {
      console.error('Error fetching stats:', error);
    }
  };

  // Fetch ALL series options for the current supplier (not paginated)
  const fetchAllSeriesOptions = useCallback(async () => {
    try {
      let url = `${API_URL}/api/supplier-sync/series-options`;
      if (selectedSupplier && selectedSupplier !== 'all') {
        url += `?supplier=${encodeURIComponent(selectedSupplier)}`;
      }
      
      const response = await fetch(url);
      if (response.ok) {
        const data = await response.json();
        setAllSeriesOptions(data.series || []);
        console.log(`Fetched ${data.total_series} series for ${data.supplier}`);
      }
    } catch (error) {
      console.error('Error fetching series options:', error);
    }
  }, [selectedSupplier]);

  // Fetch series options when supplier changes
  React.useEffect(() => {
    fetchAllSeriesOptions();
  }, [fetchAllSeriesOptions]);

  // Fetch DB labels on mount
  React.useEffect(() => {
    fetchDbLabels();
  }, [fetchDbLabels]);

  // Fetch tier pricing config
  const fetchTierPricingConfig = async () => {
    try {
      const response = await fetch(`${API_URL}/api/tiles/pricing/tiers`);
      if (response.ok) {
        const data = await response.json();
        setTierPricingConfig(data);
      }
    } catch (error) {
      console.error('Error fetching tier pricing config:', error);
    }
  };

  // Fetch category groups (Tiles, Flooring, Materials, etc.) for Product Group Selector
  const fetchCategoryGroups = async () => {
    try {
      const token = localStorage.getItem('token');
      const headers = { Authorization: `Bearer ${token}` };
      const [groupsRes, catsByGroupRes] = await Promise.all([
        fetch(`${API_URL}/api/website-admin/category-groups`, { headers }),
        fetch(`${API_URL}/api/website-admin/categories/by-group`, { headers })
      ]);
      if (groupsRes.ok) {
        const data = await groupsRes.json();
        setCategoryGroups(data);
      }
      if (catsByGroupRes.ok) {
        const data = await catsByGroupRes.json();
        setCategoryGroupsWithCats(data);
      }
    } catch (error) {
      console.error('Error fetching category groups:', error);
    }
  };

  // Save tier pricing config (global or per-product)
  const saveTierPricingConfig = async () => {
    setTierPricingSaving(true);
    try {
      if (selectedProducts.size > 0) {
        // Get products to update - filter by size + scope
        let productsToUpdate;
        if (pricingSizeFilter !== 'all') {
          productsToUpdate = getProductsFilteredBySize(pricingSizeFilter);
        } else {
          const selectedSkusList = Array.from(selectedProducts);
          productsToUpdate = products.filter(p => selectedSkusList.includes(getProductKey(p)));
        }
        
        // Further filter by tier product scope if any products are checked
        if (tierProductScope.size > 0) {
          productsToUpdate = productsToUpdate.filter(p => tierProductScope.has(getProductKey(p)));
        }
        
        if (productsToUpdate.length === 0) {
          toast.error('No products match the current selection');
          setTierPricingSaving(false);
          return;
        }
        
        // Convert to identifier format for API
        const skus = productsToUpdate.map(p => ({
          supplier: p.supplier,
          sku: p.sku || p.supplier_code
        }));

        // Snapshot tier pricing fields BEFORE the write so a single Undo click
        // can revert every mutation on every SKU.
        const undoSnapshot = snapshotForBulkUndo(productsToUpdate, [
          'tier_thresholds', 'tier_discounts', 'trade_discount', 'trade_discount_type',
          'credit_back_rate', 'tier_disabled', 'pallet_enabled', 'pallet_price',
          'half_pallet_price', 'm2_per_pallet', 'm2_per_half_pallet',
        ]);

        const response = await fetch(`${API_URL}/api/supplier-sync/products/bulk-tier-update`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            products: skus,
            tier_thresholds: tierPricingConfig.thresholds,
            tier_discounts: tierPricingConfig.discounts,
            trade_discount: tierPricingConfig.trade_discount_default,
            trade_discount_type: tierPricingConfig.trade_discount_type || 'percent',
            credit_back_rate: tierPricingConfig.credit_back_default,
            disabled: tierPricingConfig.disabled || false,
            // Half + Full pallet pricing (independent of tier disable)
            pallet_enabled: !!tierPricingConfig.pallet_enabled,
            pallet_price: tierPricingConfig.pallet_price,
            half_pallet_price: tierPricingConfig.half_pallet_price,
            m2_per_pallet: tierPricingConfig.m2_per_pallet,
            m2_per_half_pallet: tierPricingConfig.m2_per_half_pallet,
          })
        });
        
        if (response.ok) {
          const result = await response.json();
          const sizeInfo = pricingSizeFilter !== 'all' ? ` (${getFilterDisplayLabel(pricingSizeFilter)})` : '';

          const labelSummary = tierPricingConfig.disabled
            ? `Tier discounts DISABLED for ${result.updated_count} products${sizeInfo}`
            : `Saved: ${(tierPricingConfig.discounts || []).join('%, ')}% discounts for ${result.updated_count} products${sizeInfo}`;
          showBulkUndoToast({
            snapshot: undoSnapshot,
            labelSummary,
            onRestored: fetchProducts,
          });

          setShowTierPricingModal(false);
          // Reset disabled state and scope after save
          setTierPricingConfig(prev => ({ ...prev, disabled: false }));
          setTierProductScope(new Set());
          fetchProducts(); // Refresh product list
        } else {
          toast.error('Failed to save tier settings');
        }
      } else {
        // Save global settings
        const response = await fetch(`${API_URL}/api/tiles/pricing/tiers`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(tierPricingConfig)
        });
        if (response.ok) {
          toast.success('Global tier pricing settings saved!');
          setShowTierPricingModal(false);
        } else {
          toast.error('Failed to save tier settings');
        }
      }
    } catch (error) {
      console.error('Error saving tier pricing config:', error);
      toast.error('Failed to save tier settings');
    } finally {
      setTierPricingSaving(false);
    }
  };

  // Save quote settings for selected products
  const saveQuoteSettings = async () => {
    if (selectedProducts.size === 0) {
      toast.error('Please select products first');
      return;
    }
    
    setQuoteSaving(true);
    try {
      const selectedKeys = Array.from(selectedProducts);
      const selectedProds = products.filter(p => selectedKeys.includes(getProductKey(p)));
      const skus = selectedProds.map(p => ({ supplier: p.supplier, sku: p.sku || p.supplier_code || p._id }));
      
      const response = await fetch(`${API_URL}/api/supplier-sync/products/bulk-quote-settings`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          products: skus,
          quote_disabled: quoteSettings.quote_disabled,
          custom_quote_threshold: quoteSettings.custom_quote_threshold
        })
      });
      
      if (response.ok) {
        const result = await response.json();
        const action = result.quote_disabled ? 'disabled' : 'enabled';
        toast.success(`Quote requests ${action} for ${result.updated_count} products!`);
        setShowQuoteSettingsModal(false);
        setQuoteSettings({ quote_disabled: false, custom_quote_threshold: null });
        fetchProducts();
      } else {
        toast.error('Failed to save quote settings');
      }
    } catch (error) {
      console.error('Error saving quote settings:', error);
      toast.error('Failed to save quote settings');
    } finally {
      setQuoteSaving(false);
    }
  };

  // Save pricing unit settings for selected products
  const savePricingUnitSettings = async () => {
    if (selectedProducts.size === 0) {
      toast.error('Please select products first');
      return;
    }
    
    setPricingUnitSaving(true);
    try {
      const selectedKeys = Array.from(selectedProducts);
      let selectedProds = products.filter(p => selectedKeys.includes(getProductKey(p)));
      
      // Honour filter: if the user picked a subset, only apply to those
      if (pricingUnitTargetProducts.size > 0) {
        selectedProds = selectedProds.filter(p => pricingUnitTargetProducts.has(getProductKey(p)));
      }
      
      if (selectedProds.length === 0) {
        toast.error('No products match the current filter');
        setPricingUnitSaving(false);
        return;
      }
      
      const skus = selectedProds.map(p => ({ supplier: p.supplier, sku: p.sku || p.supplier_code || p._id }));
      
      const response = await fetch(`${API_URL}/api/supplier-sync/products/bulk-pricing-unit`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          products: skus,
          pricing_unit: pricingUnitSettings.pricing_unit,
          unit_price: pricingUnitSettings.unit_price ? parseFloat(pricingUnitSettings.unit_price) : null
        })
      });
      
      if (response.ok) {
        const result = await response.json();
        toast.success(`Pricing unit set to '${result.pricing_unit}' for ${result.updated_count} products!`);
        setShowPricingUnitModal(false);
        setPricingUnitSettings({ pricing_unit: 'm2', unit_price: '' });
        setPricingUnitTargetProducts(new Set());
        fetchProducts();
      } else {
        toast.error('Failed to save pricing unit settings');
      }
    } catch (error) {
      console.error('Error saving pricing unit settings:', error);
      toast.error('Failed to save pricing unit settings');
    } finally {
      setPricingUnitSaving(false);
    }
  };

  // Save bulk sale/labels settings for selected products
  const saveBulkSaleSettings = async () => {
    if (selectedProducts.size === 0) {
      toast.error('Please select products first');
      return;
    }
    
    setBulkSaleSaving(true);
    try {
      const selectedKeys = Array.from(selectedProducts);
      let selectedProds = products.filter(p => selectedKeys.includes(getProductKey(p)));
      
      // If specific products are targeted, filter to only those
      if (saleTargetProducts.size > 0) {
        selectedProds = selectedProds.filter(p => saleTargetProducts.has(getProductKey(p)));
      }
      
      const skus = selectedProds.map(p => ({ supplier: p.supplier, sku: p.sku || p.supplier_code || p._id }));

      // Snapshot the pre-state of every product's sale fields so a single
      // Undo click can revert every mutation. Called BEFORE the API request.
      const undoSnapshot = snapshotForBulkUndo(selectedProds, ['sale_active', 'was_price', 'was_markup_percent', 'labels', 'sale_price']);

      const response = await fetch(`${API_URL}/api/supplier-sync/products/bulk-sale-pricing`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          products: skus,
          sale_active: bulkSaleSettings.sale_active,
          was_markup_percent: bulkSaleSettings.was_markup_percent ? parseFloat(bulkSaleSettings.was_markup_percent) : null,
          was_price: bulkSaleSettings.was_price ? parseFloat(bulkSaleSettings.was_price) : null,
          labels: bulkSaleSettings.labels
        })
      });
      
      if (response.ok) {
        const result = await response.json();
        showBulkUndoToast({
          snapshot: undoSnapshot,
          labelSummary: `Sale settings updated for ${result.updated_count} product${result.updated_count !== 1 ? 's' : ''}`,
          onRestored: fetchProducts,
        });
        setBulkSaleSettings({ sale_active: false, was_markup_percent: '', was_price: '', labels: [] });
        setSaleTargetProducts(new Set());
        fetchProducts();
      } else {
        toast.error('Failed to save sale settings');
      }
    } catch (error) {
      console.error('Error saving sale settings:', error);
      toast.error('Failed to save sale settings');
    } finally {
      setBulkSaleSaving(false);
    }
  };

  // Save bulk description/SEO settings for selected products
  // Uses placeholders like {color}, {size}, {material}, {finish} to preserve each product's unique attributes
  const saveBulkDescriptionSettings = async () => {
    if (selectedProducts.size === 0) {
      toast.error('Please select products first');
      return;
    }
    
    if (!bulkDescriptionSettings.description_template && !bulkDescriptionSettings.seo_keywords && !bulkDescriptionSettings.hidden_seo_keywords && !bulkDescriptionSettings.generate_hidden_seo) {
      toast.error('Please enter a description template, SEO keywords, or hidden SEO keywords');
      return;
    }
    
    setBulkDescriptionSaving(true);
    try {
      const selectedSkusList = Array.from(selectedProducts);
      let selectedProductsList = products.filter(p => selectedSkusList.includes(getProductKey(p)));
      
      // If specific products are scoped, filter to just those
      if (descProductScope.size > 0) {
        selectedProductsList = selectedProductsList.filter(p => descProductScope.has(getDescScopeKey(p)));
      }
      
      if (selectedProductsList.length === 0) {
        toast.error('No products in the current scope');
        setBulkDescriptionSaving(false);
        return;
      }
      
      // Build products with their unique attributes for placeholder replacement
      const productsWithAttributes = selectedProductsList.map(p => ({
        supplier: p.supplier,
        sku: p.sku || p.supplier_code,
        // Attributes for placeholder replacement
        color: p.color || p.attributes?.color || '',
        size: p.size || p.attributes?.size || '',
        material: p.material || p.attributes?.material || '',
        finish: p.finish || p.attributes?.finish || '',
        // Priority: our_product_name (admin renamed) > display_name > product_name > name (supplier)
        name: p.our_product_name || p.display_name || p.product_name || p.name || '',
        display_name: p.our_product_name || p.display_name || p.product_name || p.name || '',
        product_name: p.our_product_name || p.display_name || p.product_name || p.name || '',
        series: p.series || '',
        // For hidden SEO auto-generation
        supplier_product_name: p.supplier_product_name || p.name || ''
      }));
      
      // Use axios instead of fetch to avoid "body stream already read" errors
      const response = await api.put('/supplier-sync/products/bulk-description', {
        products: productsWithAttributes,
        description_template: bulkDescriptionSettings.description_template,
        seo_keywords: bulkDescriptionSettings.seo_keywords,
        hidden_seo_keywords: bulkDescriptionSettings.hidden_seo_keywords,
        generate_hidden_seo: bulkDescriptionSettings.generate_hidden_seo,
        use_placeholders: bulkDescriptionSettings.use_placeholders,
        add_variations: bulkDescriptionSettings.add_variations,
        update_mode: applyUpdateMode // 'replace' or 'append' (only update empty)
      });
      
      const result = response.data;
      toast.success(`Description updated for ${result.updated_count} products!`);
      
      // Also save to collection_settings so the storefront collection page shows it
      if (bulkDescriptionSettings.description_template) {
        try {
          const firstProduct = selectedProductsList[0];
          const productName = firstProduct.our_product_name || firstProduct.display_name || firstProduct.product_name || firstProduct.name || '';
          const collectionName = getSeriesName(productName);
          if (collectionName) {
            // Resolve placeholders using first product's data so collection page gets a real description
            let resolvedDesc = bulkDescriptionSettings.description_template.trim();
            if (bulkDescriptionSettings.use_placeholders) {
              resolvedDesc = resolvedDesc.replace(/\{color\}/g, (firstProduct.color || firstProduct.attributes?.color || '').trim());
              resolvedDesc = resolvedDesc.replace(/\{size\}/g, (firstProduct.size || firstProduct.attributes?.size || '').trim());
              resolvedDesc = resolvedDesc.replace(/\{material\}/g, (firstProduct.material || firstProduct.attributes?.material || '').trim());
              resolvedDesc = resolvedDesc.replace(/\{finish\}/g, (firstProduct.finish || firstProduct.attributes?.finish || '').trim());
              resolvedDesc = resolvedDesc.replace(/\{name\}/g, productName.trim());
              resolvedDesc = resolvedDesc.replace(/\{series\}/g, (firstProduct.series || collectionName || '').trim());
              resolvedDesc = resolvedDesc.replace(/\s+/g, ' ').trim();
            }
            const token = localStorage.getItem('token');
            await fetch(`${process.env.REACT_APP_BACKEND_URL}/api/website-admin/collections/${encodeURIComponent(collectionName)}`, {
              method: 'PUT',
              headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
              body: JSON.stringify({ custom_description: resolvedDesc })
            });
            // Sync to the Collection Page Description textarea
            setCollectionDescription(resolvedDesc);
            setCollectionDescriptionLoaded(true);
            toast.success(`Collection page description also saved for "${collectionName}"`);
          }
        } catch (collErr) {
          console.warn('Collection settings description save skipped:', collErr);
        }
      }
      
      setBulkDescriptionSettings({ description_template: '', seo_keywords: '', hidden_seo_keywords: '', use_placeholders: true, generate_hidden_seo: false, add_variations: false, showAllPreviews: false });
      setDescProductScope(new Set());
      const freshProducts = await fetchProducts();
      if (freshProducts) refreshBreakdownsAfterSave(freshProducts);
    } catch (error) {
      console.error('Error saving description settings:', error);
      const errorMsg = error.response?.data?.detail || error.response?.data?.message || error.message || 'Unknown error';
      toast.error(`Failed to save description settings: ${errorMsg}`);
    } finally {
      setBulkDescriptionSaving(false);
    }
  };

  // Save collection page description (custom_description) for the storefront collection page
  const saveCollectionPageDescription = async () => {
    if (!collectionDescription.trim()) {
      toast.error('Please enter a collection description');
      return;
    }
    
    // Determine the collection name by extracting the series name from display_name
    // This MUST match the backend's extract_series_name() logic in website_admin.py
    // Key: Do NOT skip attribute words (matt, polished etc.) — the backend keeps them
    const selectedSkusList = Array.from(selectedProducts);
    const selectedProductsList = products.filter(p => selectedSkusList.includes(getProductKey(p)));
    
    // Color words to strip — must match backend COLOR_WORDS exactly
    const backendColorWords = new Set([
      'white','grey','gray','black','beige','cream','brown','blue','green',
      'red','pink','yellow','orange','purple','silver','gold','ivory',
      'charcoal','anthracite','taupe','sand','bone','pearl','light','dark',
      'crema','bianco','grigio','nero','avorio','noce','cenere','pietra',
      'polvere','verde','rosa','marfil',
      'blanco','gris','perla','ceniza','grafito','hueso','arena',
      'marengo','roble','terra','acacia','arce','nuez',
      'decor','feature','border','listello',
      'brilliant','bright','jet','royal','midnight','pale','deep','ultra',
      'sky','ocean','aqua','teal','azure','cobalt','turquoise','indigo','denim','navy','jean',
      'sage','olive','emerald','mint','forest','moss',
      'coral','salmon','blush','rose','orchid','magenta',
      'burgundy','maroon','garnet','bordeaux','ruby','wine','claret',
      'rust','terracotta','copper','bronze','brass','amber','honey','caramel',
      'walnut','chocolate','coffee','mocha','tobacco','cinnamon','chestnut',
      'smoke','ash','graphite','slate','onyx','ice','snow','carbon',
      'smoky','greige','platinum','titanium','pewter','lead',
      'violet','lilac','lavender','mauve','lemon',
      'pigment','leaf','romantic','storm','pepper','blonde','golden',
      'warm','cool','soft','fumes','lawa','thunder',
      'breccia','carrara','natural','stone','earth','clay',
      'alga','invisible','sugar','brillo','antrecide',
      'blu',
    ]);
    const backendAttributeWords = new Set([
      'outdoor','indoor','external','internal','anti-slip','antislip',
      'rectified','unrectified','honed','lappato','lapato','structured',
      'polished','matt','matte','gloss','glossy','satin','silk','rustic',
      'linear','plain','scored','textured','embossed','riven','tumbled',
      'brushed','glazed','unglazed','smooth','flamed','hammered','bush-hammered',
      'oiled','lacquered','whitewashed','smoked','unfinished','sanded',
      'carving','high-gloss','semi','waxed','primed','brillo','mate',
      'savage','garden','mosaic','patchwork','stripe','chevron','herringbone',
      'hexagon','split','face','endless','deluxe','lounge','unique',
      'square','flat','bumpy','bevelled','round',
      'tiles','tile','wall','floor','and','slabs','slab',
      'effect','marble','wood','concrete','ceramic','metro',
      'quarry','travertine','terrazzo','porcelain','patterned',
      'laminate','engineered','lvt','plank','straight',
    ]);
    const normalizeWord = (w) => w.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    
    const extractSeriesName = (productName) => {
      if (!productName) return '';
      if (productName.includes(' - ')) {
        const prefix = productName.split(' - ')[0].trim();
        if (prefix) return prefix;
      }
      const rawParts = productName.trim().split(/\s+/);
      // Pre-process: split concatenated word+dimension tokens (e.g., "Decor25x60cm" → "Decor" + "25x60cm")
      const parts = [];
      for (const p of rawParts) {
        const m = p.match(/^([A-Za-z]+)(\d+(?:\.\d+)?[xX]\d+.*)$/);
        if (m) { parts.push(m[1]); parts.push(m[2]); }
        else parts.push(p);
      }
      const seriesParts = [];
      for (const part of parts) {
        if (/^\d+(\.\d+)?[xX]\d+/.test(part)) break;
        if (/^\d+mm$/i.test(part)) continue;
        if (/^\d+(\.\d+)?\s*(kg|g|L|l|ml|ltr|litre|litres|mtr|m)$/i.test(part)) continue;
        if (backendAttributeWords.has(normalizeWord(part))) continue;
        seriesParts.push(part);
      }
      if (seriesParts.length === 0) return productName;
      while (seriesParts.length > 0 && backendColorWords.has(normalizeWord(seriesParts[seriesParts.length - 1]))) {
        seriesParts.pop();
      }
      if (seriesParts.length === 0) {
        return productName.trim().split(/\s+/).slice(0, 2).join(' ');
      }
      return seriesParts.join(' ');
    };
    
    // Extract series names from selected products
    const collectionNames = new Set();
    selectedProductsList.forEach(p => {
      const name = p.our_product_name || p.display_name || p.product_name || p.name || '';
      const series = extractSeriesName(name);
      if (series) collectionNames.add(series);
    });
    
    if (collectionNames.size === 0) {
      toast.error('Could not determine collection name from selected products');
      return;
    }
    
    setCollectionDescriptionSaving(true);
    const token = localStorage.getItem('token');
    let successCount = 0;
    let failCount = 0;
    
    for (const name of collectionNames) {
      try {
        const res = await fetch(`${process.env.REACT_APP_BACKEND_URL}/api/website-admin/collections/${encodeURIComponent(name)}`, {
          method: 'PUT',
          headers: { 
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ custom_description: collectionDescription.trim() })
        });
        if (res.ok) successCount++;
        else failCount++;
      } catch {
        failCount++;
      }
    }
    
    setCollectionDescriptionSaving(false);
    if (successCount > 0) {
      toast.success(`Collection description saved for ${successCount} collection${successCount > 1 ? 's' : ''}`);
      setCollectionDescriptionLoaded(true);
    }
    if (failCount > 0) {
      toast.error(`Failed for ${failCount} collection${failCount > 1 ? 's' : ''}`);
    }
  };

  // Load existing collection description when Bulk Category Editor opens
  const loadCollectionDescription = async () => {
    const selectedSkusList = Array.from(selectedProducts);
    const selectedProductsList = products.filter(p => selectedSkusList.includes(getProductKey(p)));
    
    // Get first product's series name using the same extraction as the backend
    const firstProduct = selectedProductsList[0];
    if (!firstProduct) return;
    
    const name = firstProduct.our_product_name || firstProduct.display_name || firstProduct.product_name || firstProduct.name || '';
    if (!name) return;
    
    // Extract series name matching backend's extract_series_name()
    const normalizeW = (w) => w.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    const colorWordsSet = new Set([
      'white','grey','gray','black','beige','cream','brown','blue','green',
      'red','pink','yellow','orange','purple','silver','gold','ivory',
      'charcoal','anthracite','taupe','sand','bone','pearl','light','dark',
      'crema','bianco','grigio','nero','avorio','noce','cenere','pietra',
      'polvere','verde','rosa','marfil',
      'blanco','gris','perla','ceniza','grafito','hueso','arena',
      'marengo','roble','terra','acacia','arce','nuez',
      'decor','feature','border','listello',
      'brilliant','bright','jet','royal','midnight','pale','deep','ultra',
      'sky','ocean','aqua','teal','azure','cobalt','turquoise','indigo','denim','navy','jean',
      'sage','olive','emerald','mint','forest','moss',
      'coral','salmon','blush','rose','orchid','magenta',
      'burgundy','maroon','garnet','bordeaux','ruby','wine','claret',
      'rust','terracotta','copper','bronze','brass','amber','honey','caramel',
      'walnut','chocolate','coffee','mocha','tobacco','cinnamon','chestnut',
      'smoke','ash','graphite','slate','onyx','ice','snow','carbon',
      'smoky','greige','platinum','titanium','pewter','lead',
      'violet','lilac','lavender','mauve','lemon',
      'pigment','leaf','romantic','storm','pepper','blonde','golden',
      'warm','cool','soft','fumes','lawa','thunder',
      'breccia','carrara','natural','stone','earth','clay',
      'alga','invisible','sugar','brillo','antrecide','blu',
    ]);
    const attrWordsSet = new Set([
      'outdoor','indoor','external','internal','anti-slip','antislip',
      'rectified','unrectified','honed','lappato','lapato','structured',
      'polished','matt','matte','gloss','glossy','satin','silk','rustic',
      'linear','plain','scored','textured','embossed','riven','tumbled',
      'brushed','glazed','unglazed','smooth','flamed','hammered','bush-hammered',
      'oiled','lacquered','whitewashed','smoked','unfinished','sanded',
      'carving','high-gloss','semi','waxed','primed','brillo','mate',
      'savage','garden','mosaic','patchwork','stripe','chevron','herringbone',
      'hexagon','split','face','endless','deluxe','lounge','unique',
      'square','flat','bumpy','bevelled','round',
      'tiles','tile','wall','floor','and','slabs','slab',
      'effect','marble','wood','concrete','ceramic','metro',
      'quarry','travertine','terrazzo','porcelain','patterned',
      'laminate','engineered','lvt','plank','straight',
    ]);
    
    let series = '';
    if (name.includes(' - ')) {
      series = name.split(' - ')[0].trim();
    } else {
      const rawParts = name.trim().split(/\s+/);
      // Pre-process: split concatenated word+dimension tokens (e.g., "Decor25x60cm" → "Decor" + "25x60cm")
      const parts = [];
      for (const p of rawParts) {
        const m = p.match(/^([A-Za-z]+)(\d+(?:\.\d+)?[xX]\d+.*)$/);
        if (m) { parts.push(m[1]); parts.push(m[2]); }
        else parts.push(p);
      }
      const seriesParts = [];
      for (const part of parts) {
        if (/^\d+(\.\d+)?[xX]\d+/.test(part)) break;
        if (/^\d+mm$/i.test(part)) continue;
        if (attrWordsSet.has(normalizeW(part))) continue;
        seriesParts.push(part);
      }
      while (seriesParts.length > 0 && colorWordsSet.has(normalizeW(seriesParts[seriesParts.length - 1]))) {
        seriesParts.pop();
      }
      series = seriesParts.length > 0 ? seriesParts.join(' ') : name.trim().split(/\s+/).slice(0, 2).join(' ');
    }
    if (!series) return;
    
    try {
      const token = localStorage.getItem('token');
      // Use direct collection-settings endpoint to avoid dependency on tiles collection
      const res = await fetch(`${process.env.REACT_APP_BACKEND_URL}/api/website-admin/collection-settings/${encodeURIComponent(series)}`, {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      if (res.ok) {
        const data = await res.json();
        if (data.found && data.settings?.custom_description) {
          setCollectionDescription(data.settings.custom_description);
          setCollectionDescriptionLoaded(true);
        }
      }
    } catch { /* ignore */ }
  };

  // AI Description Generation for Bulk Editor (matches ProductForm.js functionality)
  const handleBulkGenerateDescription = async (mode = 'generate') => {
    if (selectedProducts.size === 0) {
      toast.error('Please select products first');
      return;
    }
    
    setGeneratingDescription(true);
    try {
      const token = localStorage.getItem('token');
      const selectedSkusList = Array.from(selectedProducts);
      const selectedProductsList = products.filter(p => selectedSkusList.includes(getProductKey(p)));
      
      // Get a sample product to use for AI context
      const sampleProduct = selectedProductsList[0] || {};
      
      // Gather product context for AI (similar to ProductForm.js)
      // Priority: our_product_name (admin renamed) > display_name > product_name > name (raw supplier)
      const productContext = {
        name: sampleProduct.our_product_name || sampleProduct.display_name || sampleProduct.product_name || sampleProduct.name || '',
        sku: sampleProduct.sku || '',
        category: sampleProduct.category || '',
        seo_keywords: bulkDescriptionSettings.seo_keywords || '',
        material: sampleProduct.material || sampleProduct.attributes?.material || '',
        finish: sampleProduct.finish || sampleProduct.attributes?.finish || '',
        type: sampleProduct.type || '',
        size: sampleProduct.size || sampleProduct.attributes?.size || '',
        colors: sampleProduct.colors || [sampleProduct.color || sampleProduct.attributes?.color].filter(Boolean),
        suitability: sampleProduct.suitability || '',
        slip_rating: sampleProduct.slip_rating || '',
        edge: sampleProduct.edge || '',
        sub_categories: sampleProduct.sub_categories || [],
        type: sampleProduct.type || sampleProduct.product_group || '',
        // Mode and current description for modifications
        mode: mode,
        current_description: (mode !== 'generate' && mode !== 'brief' && mode !== 'long') ? bulkDescriptionSettings.description_template : '',
        // Length hints for generation
        length_hint: mode === 'brief' ? 'short' : (mode === 'long' ? 'detailed' : 'standard'),
        // Flag for bulk mode - generate with placeholders
        bulk_mode: bulkDescriptionSettings.use_placeholders,
        selected_count: selectedProducts.size
      };
      
      // Use axios instead of fetch to avoid "body stream already read" errors
      const response = await api.post('/products/generate-description', productContext);
      const data = response.data;
      
      setBulkDescriptionSettings(prev => ({ ...prev, description_template: data.description }));
      
      // Show appropriate success message
      const messages = {
        'generate': 'Standard description generated!',
        'brief': 'Brief description generated!',
        'long': 'Detailed description generated!',
        'regenerate': 'New variation generated!',
        'shorter': 'Description shortened!',
        'longer': 'Description expanded!'
      };
      toast.success(messages[mode] || 'Description updated!');
      
    } catch (error) {
      console.error('Error generating description:', error);
      toast.error(error.message || 'Failed to generate description');
    } finally {
      setGeneratingDescription(false);
    }
  };

  // Unified Series Description Generator - Creates ONE description for entire product collection
  const handleGenerateSeriesDescription = async (length = 'standard') => {
    if (selectedProducts.size === 0) {
      toast.error('Please select products first');
      return;
    }
    
    setGeneratingSeriesDescription(true);
    setSeriesDescriptionResult(null);
    
    try {
      const selectedSkusList = Array.from(selectedProducts);
      const selectedProductsList = products.filter(p => selectedSkusList.includes(getProductKey(p)));

      // 24 May 2026 — series-name detection rewrite. User reported the
      // generated description was using "Pietra Ligure Avorio 120X120"
      // (supplier name) instead of "La Dolce" (the admin-overridden
      // Collection Display Name shown on the storefront). Root cause:
      // the old logic picked the FIRST product's `original_series` /
      // `series` field — both of which carry the supplier's series
      // name, not the admin's renamed collection.
      //
      // New approach: compute the LONGEST COMMON PREFIX across the
      // admin-edited display names of ALL selected products. With
      // 25 products named "La Dolce Sabbia 60x120cm Matt", "La Dolce
      // Anthracite 30x60cm Matt", etc. — the common prefix is "La
      // Dolce", which is exactly the Collection Display Name the
      // user sees on the PDP. Falls back to the old logic only if
      // no common prefix can be found (e.g. mixed selections).
      const adminNames = selectedProductsList
        .map(p => (p.our_product_name || p.display_name || p.website_name || '').trim())
        .filter(Boolean);

      // Tokenise each name into words then find the longest prefix
      // of words shared by every name.
      const tokenLists = adminNames.map(n => n.split(/\s+/));
      let commonPrefixTokens = [];
      if (tokenLists.length > 0) {
        const first = tokenLists[0];
        for (let i = 0; i < first.length; i++) {
          const token = first[i];
          if (tokenLists.every(tl => tl[i] === token)) {
            commonPrefixTokens.push(token);
          } else {
            break;
          }
        }
        // Strip trailing tokens that look like size/colour/finish so
        // "La Dolce 60x60cm" → "La Dolce", not "La Dolce 60x60cm".
        while (commonPrefixTokens.length > 0) {
          const last = commonPrefixTokens[commonPrefixTokens.length - 1];
          if (/^\d/.test(last) || /^(matt|gloss|polished|natural|satin|honed|brushed|lappato|semi-?polished)$/i.test(last)) {
            commonPrefixTokens.pop();
          } else {
            break;
          }
        }
      }
      let seriesName = commonPrefixTokens.join(' ').trim();

      // Fallback chain — preserved for legacy edge cases where
      // display_name isn't set OR selection is genuinely mixed.
      const firstProduct = selectedProductsList[0] || {};
      if (!seriesName) {
        if (firstProduct.original_series && firstProduct.original_series.trim()) {
          seriesName = firstProduct.original_series.trim();
        } else if (firstProduct.series && firstProduct.series.trim() &&
                   firstProduct.series.trim() !== (firstProduct.name || '').split(' ')[0]) {
          seriesName = firstProduct.series.trim();
        }
      }
      
      // If no explicit series, extract from admin display name
      if (!seriesName) {
        const productName = firstProduct.our_product_name || firstProduct.display_name || firstProduct.product_name || '';
        if (productName) {
          const firstWord = productName.split(' ')[0];
          if (firstWord && firstWord.length > 1 && !/^\d+$/.test(firstWord)) {
            seriesName = firstWord;
          }
        }
      }
      // Fall back to series field only if no name-based extraction worked
      if (!seriesName && firstProduct.series && firstProduct.series.trim()) {
        seriesName = firstProduct.series.trim();
      }
      if (!seriesName) {
        // Last resort: product_name (supplier name)
        const supplierName = firstProduct.product_name || '';
        if (supplierName) {
          const firstWord = supplierName.split(' ')[0];
          if (firstWord && firstWord.length > 1 && !/^\d+$/.test(firstWord)) {
            seriesName = firstWord;
          }
        }
      }
      
      // If still no series name, try to extract from the most common first word across all selected products
      if (!seriesName && selectedProductsList.length > 0) {
        const firstWords = selectedProductsList
          .map(p => {
            const name = p.our_product_name || p.display_name || p.product_name || p.name || p.title || '';
            const word = name.split(' ')[0];
            return word && word.length > 1 && !/^\d+$/.test(word) ? word : null;
          })
          .filter(Boolean);
        
        if (firstWords.length > 0) {
          // Use the most common first word
          const wordCounts = {};
          firstWords.forEach(w => { wordCounts[w] = (wordCounts[w] || 0) + 1; });
          seriesName = Object.entries(wordCounts).sort((a, b) => b[1] - a[1])[0]?.[0] || '';
        }
      }
      
      if (!seriesName) {
        toast.error('Could not detect series name from selected products. Please ensure products have proper names.');
        setGeneratingSeriesDescription(false);
        return;
      }
      
      // Get all SKUs for the selected products
      const productSkus = selectedProductsList.map(p => p.sku || p.supplier_code).filter(Boolean);
      
      if (productSkus.length === 0) {
        toast.error('Selected products have no valid SKUs');
        setGeneratingSeriesDescription(false);
        return;
      }
      
      // Call the API
      const response = await api.post('/products/generate-series-description', {
        series_name: seriesName,
        product_skus: productSkus,
        seo_keywords: bulkDescriptionSettings.seo_keywords || '',
        length: length
      });
      
      const data = response.data;
      
      if (data.success) {
        // Store the result for display
        setSeriesDescriptionResult({
          description: data.description,
          series_name: data.series_name,
          product_count: data.product_count,
          aggregated_data: data.aggregated_data
        });
        
        // Also populate the description template for easy application
        setBulkDescriptionSettings(prev => ({ 
          ...prev, 
          description_template: data.description,
          use_placeholders: false // Unified description doesn't use placeholders
        }));
        
        toast.success(`Unified description generated for ${data.product_count} products in the "${data.series_name}" collection!`);
      } else {
        toast.error('Failed to generate series description');
      }
      
    } catch (error) {
      console.error('Error generating series description:', error);
      try {
        const errorMsg = error.response?.data?.detail || error.message || 'Failed to generate series description';
        toast.error(errorMsg);
      } catch (toastErr) {
        toast.error('Failed to generate description. Please try again.');
      }
    } finally {
      setGeneratingSeriesDescription(false);
    }
  };

  // Batch Series Description Functions
  const handleOpenBatchSeriesModal = async () => {
    if (selectedProducts.size === 0) {
      toast.error('Please select products first');
      return;
    }

    setShowBatchSeriesModal(true);
    setDetectedSeries(null);
    setBatchDescriptionResults(null);
    setSelectedSeriesForBatch(new Set());
    setExpandedSeriesResults(new Set());
    // 24 May 2026 — clear any inline rename overrides from a previous
    // session so each open of the modal starts with the freshly-
    // detected names. Admin can then re-edit as needed.
    setSeriesNameOverrides({});
    // Seed the unified collection name from the longest common prefix
    // of the selected products' admin-edited names. This is usually
    // exactly what the user wants ("La Dolce" from "La Dolce Sabbia
    // 60x120cm Matt" + "La Dolce Anthracite 30x60cm Matt" + ...).
    // Falls through to empty if no common prefix can be found.
    try {
      const selectedKeysList = Array.from(selectedProducts);
      const selectedProductsList = products.filter(p => selectedKeysList.includes(getProductKey(p)));
      const adminNames = selectedProductsList
        .map(p => (p.display_name || p.our_product_name || p.website_name || '').trim())
        .filter(Boolean);
      const tokenLists = adminNames.map(n => n.split(/\s+/));
      let commonPrefixTokens = [];
      if (tokenLists.length > 0) {
        const first = tokenLists[0];
        for (let i = 0; i < first.length; i++) {
          const token = first[i];
          if (tokenLists.every(tl => tl[i] === token)) {
            commonPrefixTokens.push(token);
          } else {
            break;
          }
        }
        while (commonPrefixTokens.length > 0) {
          const last = commonPrefixTokens[commonPrefixTokens.length - 1];
          if (/^\d/.test(last) || /^(matt|gloss|polished|natural|satin|honed|brushed|lappato|semi-?polished)$/i.test(last)) {
            commonPrefixTokens.pop();
          } else {
            break;
          }
        }
      }
      setBatchUnifiedCollectionName(commonPrefixTokens.join(' ').trim());
    } catch {
      setBatchUnifiedCollectionName('');
    }
    setBatchUnifiedMode(true);

    // Auto-detect series
    await detectSeriesFromSelection();
  };

  const detectSeriesFromSelection = async () => {
    setDetectingSeriesPending(true);
    
    try {
      const selectedKeysList = Array.from(selectedProducts);
      const selectedProductsList = products.filter(p => selectedKeysList.includes(getProductKey(p)));
      
      // Get SKUs for products that have them, filter out empty/undefined
      const productSkus = selectedProductsList
        .map(p => p.sku)
        .filter(sku => sku && sku.trim() !== '');
      
      if (productSkus.length === 0) {
        toast.error('Selected products do not have SKUs. Please select products with SKU codes.');
        setShowBatchSeriesModal(false);
        return;
      }
      
      const response = await api.post('/products/detect-series', {
        product_skus: productSkus
      });
      
      if (response.data.success) {
        setDetectedSeries(response.data);
        // Auto-select all series
        setSelectedSeriesForBatch(new Set(response.data.series.map(s => s.series_name)));
      }
    } catch (error) {
      console.error('Error detecting series:', error);
      toast.error('Failed to detect series from selection');
    } finally {
      setDetectingSeriesPending(false);
    }
  };

  const toggleBatchSeriesSelection = (seriesName) => {
    setSelectedSeriesForBatch(prev => {
      const newSet = new Set(prev);
      if (newSet.has(seriesName)) {
        newSet.delete(seriesName);
      } else {
        newSet.add(seriesName);
      }
      return newSet;
    });
  };

  const handleGenerateBatchDescriptions = async () => {
    if (selectedSeriesForBatch.size === 0) {
      toast.error('Please select at least one series');
      return;
    }
    
    setGeneratingBatchDescriptions(true);
    setBatchDescriptionResults(null);
    
    try {
      // Get SKUs only for selected series
      const selectedSeriesData = detectedSeries.series.filter(s => selectedSeriesForBatch.has(s.series_name));
      const allSkus = selectedSeriesData.flatMap(s => s.skus);

      // 24 May 2026 — in unified mode, collapse ALL selected detected
      // series into ONE collection so the backend generates a single
      // description for the whole range (user reported: "It's giving
      // me separate descriptions for each colour but I said unified
      // — One La Dolce collection"). We map every selected
      // auto-detected name to the same target name, and the backend's
      // series_name_overrides merger does the rest.
      let overridesToSend = seriesNameOverrides;
      if (batchUnifiedMode) {
        const collectionName = (batchUnifiedCollectionName || 'Collection').trim() || 'Collection';
        overridesToSend = {};
        selectedSeriesData.forEach((s) => {
          overridesToSend[s.series_name] = collectionName;
        });
      }

      const response = await api.post('/products/generate-batch-series-descriptions', {
        product_skus: allSkus,
        seo_keywords: bulkDescriptionSettings.seo_keywords || '',
        length: batchDescriptionLength,
        // 24 May 2026 — pass admin renames so the backend re-labels
        // each detected group with the user's chosen name before
        // generating the description. In unified mode every detected
        // name maps to the same target so the backend merges them
        // into one description.
        series_name_overrides: overridesToSend,
      });
      
      if (response.data.success) {
        setBatchDescriptionResults(response.data);
        // Auto-expand all results
        setExpandedSeriesResults(new Set(response.data.results.map(r => r.series_name)));
        toast.success(`Generated ${response.data.series_count} series descriptions!`);
      }
    } catch (error) {
      console.error('Error generating batch descriptions:', error);
      toast.error(error.response?.data?.detail || 'Failed to generate batch descriptions');
    } finally {
      setGeneratingBatchDescriptions(false);
    }
  };

  const toggleResultExpanded = (seriesName) => {
    setExpandedSeriesResults(prev => {
      const newSet = new Set(prev);
      if (newSet.has(seriesName)) {
        newSet.delete(seriesName);
      } else {
        newSet.add(seriesName);
      }
      return newSet;
    });
  };

  const applyDescriptionToSeries = async (result) => {
    // Apply description to all products in this series
    try {
      const skus = result.skus;
      const description = result.description;
      
      // Use existing bulk update mechanism
      const response = await api.post('/supplier-sync/products/bulk-update-field', {
        skus: skus,
        field: 'description',
        value: description
      });
      
      if (response.data.success || response.data.updated) {
        toast.success(`Applied description to ${result.product_count} products in "${result.series_name}"`);
        
        // Also save to collection_settings so storefront shows it
        try {
          await api.put(`/website-admin/collections/${encodeURIComponent(result.series_name)}`, {
            custom_description: description
          });
        } catch (collErr) {
          console.warn('Collection settings save skipped:', collErr);
        }
        
        // Refresh products
        fetchProducts();
      }
    } catch (error) {
      console.error('Error applying description:', error);
      toast.error(`Failed to apply description to ${result.series_name}`);
    }
  };

  const applyAllDescriptions = async () => {
    if (!batchDescriptionResults?.results) return;
    
    let successCount = 0;
    let failCount = 0;
    
    for (const result of batchDescriptionResults.results) {
      try {
        const response = await api.post('/supplier-sync/products/bulk-update-field', {
          skus: result.skus,
          field: 'description',
          value: result.description
        });
        
        if (response.data.success || response.data.updated) {
          successCount++;
          // Also save to collection_settings for storefront
          try {
            await api.put(`/website-admin/collections/${encodeURIComponent(result.series_name)}`, {
              custom_description: result.description
            });
          } catch (collErr) {
            console.warn('Collection settings save skipped for', result.series_name);
          }
        } else {
          failCount++;
        }
      } catch (error) {
        console.error(`Error applying to ${result.series_name}:`, error);
        failCount++;
      }
    }
    
    if (successCount > 0) {
      toast.success(`Applied descriptions to ${successCount} series!`);
      fetchProducts();
    }
    if (failCount > 0) {
      toast.error(`Failed to apply to ${failCount} series`);
    }
    
    setShowBatchSeriesModal(false);
  };

  // ============================================================================
  // AUTO-REGENERATION FUNCTIONS
  // ============================================================================
  
  const fetchAutoRegenData = async () => {
    setLoadingAutoRegen(true);
    try {
      const [settingsRes, trackedRes, pendingRes, historyRes] = await Promise.all([
        api.get('/products/description-regen/settings'),
        api.get('/products/description-regen/tracked-series'),
        api.get('/products/description-regen/pending'),
        api.get('/products/description-regen/history')
      ]);
      
      setAutoRegenSettings(settingsRes.data);
      setTrackedSeries(trackedRes.data.series || []);
      setPendingRegenerations(pendingRes.data.pending_series || []);
      setRegenHistory(historyRes.data.history || []);
    } catch (error) {
      console.error('Error fetching auto-regen data:', error);
    } finally {
      setLoadingAutoRegen(false);
    }
  };

  const handleOpenAutoRegenModal = () => {
    setShowAutoRegenModal(true);
    fetchAutoRegenData();
  };

  const saveAutoRegenSettings = async () => {
    if (!autoRegenSettings) return;
    
    setSavingAutoRegenSettings(true);
    try {
      await api.post('/products/description-regen/settings', autoRegenSettings);
      toast.success('Auto-regeneration settings saved!');
    } catch (error) {
      console.error('Error saving settings:', error);
      toast.error('Failed to save settings');
    } finally {
      setSavingAutoRegenSettings(false);
    }
  };

  const trackSeriesFromBatchResults = async () => {
    if (!batchDescriptionResults?.results) return;
    
    try {
      const response = await api.post('/products/description-regen/track-batch', {
        series: batchDescriptionResults.results.map(r => ({
          series_name: r.series_name,
          product_count: r.product_count
        })),
        auto_regenerate: true
      });
      
      if (response.data.success) {
        toast.success(`${batchDescriptionResults.results.length} series added to auto-regeneration tracking!`);
      }
    } catch (error) {
      console.error('Error tracking series:', error);
      toast.error('Failed to add series to tracking');
    }
  };

  const removeTrackedSeries = async (seriesName) => {
    try {
      await api.delete(`/products/description-regen/track-series/${encodeURIComponent(seriesName)}`);
      toast.success(`"${seriesName}" removed from tracking`);
      fetchAutoRegenData();
    } catch (error) {
      console.error('Error removing series:', error);
      toast.error('Failed to remove series');
    }
  };

  const runRegenerationNow = async () => {
    try {
      const response = await api.post('/products/description-regen/run-now');
      if (response.data.success) {
        toast.success('Regeneration started in background!');
        // Refresh data after a short delay
        setTimeout(fetchAutoRegenData, 5000);
      }
    } catch (error) {
      console.error('Error running regeneration:', error);
      toast.error('Failed to start regeneration');
    }
  };

  // Save bulk Tiles per Box settings for selected products (with optional size filter)
  const saveBulkTilesPerBoxSettings = async () => {
    if (selectedProducts.size === 0) {
      toast.error('Please select products first');
      return;
    }
    
    if (!bulkTilesPerBoxSettings.tiles_per_box && !bulkTilesPerBoxSettings.sqm_per_box) {
      toast.error('Please enter Tiles per Box or m² per Box');
      return;
    }
    
    setBulkTilesPerBoxSaving(true);
    try {
      // Get products to update (filtered by size if applicable)
      let productsToUpdate;
      if (tilesPerBoxSizeFilter !== 'all') {
        productsToUpdate = getProductsFilteredBySize(tilesPerBoxSizeFilter);
        if (productsToUpdate.length === 0) {
          toast.error('No products match the selected size filter');
          setBulkTilesPerBoxSaving(false);
          return;
        }
      } else {
        const selectedSkusList = Array.from(selectedProducts);
        productsToUpdate = products.filter(p => selectedSkusList.includes(getProductKey(p)));
      }
      
      const skus = productsToUpdate.map(p => p.sku);
      
      // Build update payload
      const updatePayload = {};
      if (bulkTilesPerBoxSettings.tiles_per_box) {
        updatePayload.tiles_per_box = parseInt(bulkTilesPerBoxSettings.tiles_per_box);
      }
      if (bulkTilesPerBoxSettings.sqm_per_box) {
        updatePayload.sqm_per_box = parseFloat(bulkTilesPerBoxSettings.sqm_per_box);
      }
      if (bulkTilesPerBoxSettings.tile_width) {
        updatePayload.tile_width = parseFloat(bulkTilesPerBoxSettings.tile_width);
      }
      if (bulkTilesPerBoxSettings.tile_height) {
        updatePayload.tile_height = parseFloat(bulkTilesPerBoxSettings.tile_height);
      }
      
      // Use the unified bulk update endpoint
      const response = await fetch(`${API_URL}/api/supplier-sync/products/bulk-update-unified`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          product_ids: skus,
          updates: updatePayload,
          mode: 'replace'
        })
      });
      
      if (response.ok) {
        const result = await response.json();
        const sizeInfo = tilesPerBoxSizeFilter !== 'all' ? ` (${tilesPerBoxSizeFilter} only)` : '';
        toast.success(`Box settings updated for ${result.supplier_products_updated || productsToUpdate.length} products${sizeInfo}`);
        setBulkTilesPerBoxSettings({ tiles_per_box: '', sqm_per_box: '', tile_width: '', tile_height: '' });
        setTilesPerBoxSizeFilter('all');
        fetchProducts();
      } else {
        toast.error('Failed to save box settings');
      }
    } catch (error) {
      console.error('Error saving box settings:', error);
      toast.error('Failed to save box settings');
    } finally {
      setBulkTilesPerBoxSaving(false);
    }
  };

  // ===== Shared filter mapping constants (used by handleBulkCategoryUpdate and perProductAssignment) =====
  const ARRAY_FILTER_MAPPING = {
    'filter_color': 'colors', 'filter_colours': 'colors',
    'filter_room': 'rooms', 'filter_rooms': 'rooms',
    'filter_material': 'materials', 'filter_materials': 'materials',
    'filter_style': 'styles', 'filter_styles': 'styles',
    'filter_feature': 'features', 'filter_features': 'features'
  };
  const SCALAR_FILTER_MAPPING = {
    'filter_slip-rating': 'slip_rating', 'filter_slip_rating': 'slip_rating',
    'filter_suitability': 'suitability',
    'filter_edge': 'edge',
    'filter_finish': 'finish',
    'filter_size': 'size',
    'filter_thickness': 'thickness',
    'filter_country-of-origin': 'made_in', 'filter_country_of_origin': 'made_in',
    'filter_in-stock': null, // computed, not a DB field
    'filter_price': null // computed, not a DB field
  };
  // Combined mapping for per-product assignments (merges array + scalar, all with filter_ prefix)
  const COMBINED_FILTER_MAPPING = { ...ARRAY_FILTER_MAPPING, ...SCALAR_FILTER_MAPPING };

  // Handle bulk category update - now uses unified product-options API
  const handleBulkCategoryUpdate = async (updateMode = 'replace', restrictToIds = null) => {
    if (selectedProducts.size === 0) {
      toast.error('No products selected');
      return;
    }

    // Check if any values are selected (including dynamic cat_*, filter_*, spec_* keys)
    const hasTileSpecs = bulkCategorySelections.material || 
                         bulkCategorySelections.finish || 
                         bulkCategorySelections.type || 
                         bulkCategorySelections.edge || 
                         bulkCategorySelections.slip_rating || 
                         bulkCategorySelections.suitability ||
                         bulkCategorySelections.thickness ||
                         bulkCategorySelections.underfloor_heating;
    const hasPricing = bulkCategorySelections.cost_price || bulkCategorySelections.list_price;
    const hasMadeIn = bulkCategorySelections.made_in;
    const hasWebsiteCategories = bulkCategorySelections.rooms?.length > 0 || 
                                  bulkCategorySelections.materials?.length > 0 ||
                                  bulkCategorySelections.styles?.length > 0 || 
                                  bulkCategorySelections.colors?.length > 0 || 
                                  bulkCategorySelections.features?.length > 0;
    const hasMainCategory = bulkCategorySelections.main_category;
    const hasSubCategories = bulkCategorySelections.sub_categories?.length > 0;
    // Check for dynamically-added cat_*, filter_*, spec_* keys from UI buttons
    const hasCategorySelections = Object.keys(bulkCategorySelections).some(k => k.startsWith('cat_') && bulkCategorySelections[k]);
    const hasFilterSelections = Object.keys(bulkCategorySelections).some(k => k.startsWith('filter_') && Array.isArray(bulkCategorySelections[k]) && bulkCategorySelections[k].length > 0);
    const hasSpecSelections = Object.keys(bulkCategorySelections).some(k => k.startsWith('spec_') && bulkCategorySelections[k]);
    
    const hasFieldsToClear = Object.keys(fieldsToClear).length > 0;
    
    if (!hasTileSpecs && !hasPricing && !hasMadeIn && !hasWebsiteCategories && !bulkShowOnWebsite && !hasMainCategory && !hasSubCategories && !hasCategorySelections && !hasFilterSelections && !hasSpecSelections && !hasFieldsToClear) {
      toast.error('Please select at least one attribute or enable "Show on Website"');
      return;
    }

    setBulkCategoryLoading(true);
    try {
      // Determine which products to update based on filters
      let productsToUpdate;
      
      if (bulkThicknessFilter !== 'all') {
        // If thickness filter is active, only update filtered products
        productsToUpdate = getProductsFilteredByThickness(bulkThicknessFilter);
        
        if (productsToUpdate.length === 0) {
          toast.error('No products match the selected thickness filter');
          setBulkCategoryLoading(false);
          return;
        }
      } else if (hasPricing && pricingSizeFilter !== 'all') {
        // If pricing is being updated AND size filter is active, only update filtered products
        productsToUpdate = getProductsFilteredBySize(pricingSizeFilter);
        
        if (productsToUpdate.length === 0) {
          toast.error('No products match the selected size filter');
          setBulkCategoryLoading(false);
          return;
        }
      } else {
        // Otherwise, update all selected products
        const selectedSkusList = Array.from(selectedProducts);
        productsToUpdate = products.filter(p => selectedSkusList.includes(getProductKey(p)));
      }

      // 3 Aug 2026 — "Re-save just the failed ones" flow. Save Results
      // dialog passes a Set of the specific product IDs that failed on
      // the previous attempt; we narrow productsToUpdate accordingly so
      // the same payload is reapplied only to those. Everything else
      // (payload build, retry loop, verify, refresh, dry-run gating)
      // works exactly as it does for a normal Save.
      if (restrictToIds instanceof Set && restrictToIds.size > 0) {
        productsToUpdate = productsToUpdate.filter(p => {
          const sku = p.sku;
          const sc = p.supplier_code;
          return (sku && restrictToIds.has(sku)) || (sc && restrictToIds.has(sc));
        });
        if (productsToUpdate.length === 0) {
          toast.error('None of the failed products are in the current selection any more');
          setBulkCategoryLoading(false);
          return;
        }
      }
      
      // Standard bulk update path
      
      // Build update payload - same format as Sync Hub
      const updatePayload = {};
      
      // Tile specifications (single values) — skip if corresponding filter_* has scoped values
      const _hasFilterFinish = (bulkCategorySelections.filter_finish?.length > 0);
      const _hasFilterEdge = (bulkCategorySelections.filter_edge?.length > 0);
      const _hasFilterSlip = (bulkCategorySelections['filter_slip-rating']?.length > 0 || bulkCategorySelections.filter_slip_rating?.length > 0);
      const _hasFilterSuit = (bulkCategorySelections.filter_suitability?.length > 0);
      const _hasFilterThick = (bulkCategorySelections.filter_thickness?.length > 0);
      
      if (bulkCategorySelections.material) updatePayload.material = bulkCategorySelections.material;
      if (bulkCategorySelections.finish && !_hasFilterFinish) updatePayload.finish = bulkCategorySelections.finish;
      if (bulkCategorySelections.type) updatePayload.type = bulkCategorySelections.type;
      if (bulkCategorySelections.edge && !_hasFilterEdge) updatePayload.edge = bulkCategorySelections.edge;
      if (bulkCategorySelections.slip_rating && !_hasFilterSlip) updatePayload.slip_rating = bulkCategorySelections.slip_rating;
      if (bulkCategorySelections.suitability && !_hasFilterSuit) updatePayload.suitability = bulkCategorySelections.suitability;
      if (bulkCategorySelections.thickness && !_hasFilterThick) updatePayload.thickness = bulkCategorySelections.thickness;
      if (bulkCategorySelections.underfloor_heating) updatePayload.underfloor_heating = bulkCategorySelections.underfloor_heating;
      
      // ===== CONVERT cat_* selections to main_category/sub_categories =====
      // UI stores categories as cat_floor-tiles: true, cat_wall-tiles: true
      // main_category = the GROUP name (e.g., "Tiles", "Flooring", "Materials")
      // sub_categories = the selected categories WITHIN that group (e.g., ["Floor Tiles", "Wall Tiles"])
      const selectedCatKeys = Object.keys(bulkCategorySelections).filter(k => k.startsWith('cat_') && bulkCategorySelections[k]);
      if (selectedCatKeys.length > 0) {
        // Group selected categories by their parent group
        const categoriesByGroup = {};
        
        for (const key of selectedCatKeys) {
          const slug = key.replace('cat_', '');
          // Use categoryGroupsWithCats which has full category data from /api/website-admin/categories/by-group
          for (const group of categoryGroupsWithCats) {
            const cat = (group.categories || []).find(c => c.slug === slug);
            if (cat) {
              const groupName = group.name || group.slug;
              if (!categoriesByGroup[groupName]) {
                categoriesByGroup[groupName] = [];
              }
              categoriesByGroup[groupName].push(cat.name);
              break;
            }
          }
        }
        
        // Get the first group with selections as main_category
        // All selected categories become sub_categories
        const groupNames = Object.keys(categoriesByGroup);
        if (groupNames.length > 0) {
          updatePayload.main_category = groupNames[0]; // Group name (e.g., "Tiles")
          
          // Collect all selected categories as sub_categories
          const allSubCategories = [];
          for (const groupName of groupNames) {
            allSubCategories.push(...categoriesByGroup[groupName]);
          }
          if (allSubCategories.length > 0) {
            updatePayload.sub_categories = allSubCategories;
          }
        }
      }
      
      // Also check direct main_category/sub_categories as FALLBACK (only if no cat_* keys were processed)
      // cat_* keys are the primary source of truth — they reflect actual button clicks
      if (!updatePayload.main_category && bulkCategorySelections.main_category) {
        updatePayload.main_category = bulkCategorySelections.main_category;
      }
      if (!updatePayload.sub_categories && bulkCategorySelections.sub_categories?.length > 0) {
        updatePayload.sub_categories = [...bulkCategorySelections.sub_categories];
      }
      
      // Pricing (convert to numbers)
      if (bulkCategorySelections.cost_price) updatePayload.cost_price = parseFloat(bulkCategorySelections.cost_price);
      if (bulkCategorySelections.list_price) updatePayload.price = parseFloat(bulkCategorySelections.list_price);
      
      // Country of Origin (Made in...)
      if (bulkCategorySelections.made_in === '__CLEAR__') updatePayload.made_in = '';
      else if (bulkCategorySelections.made_in) updatePayload.made_in = bulkCategorySelections.made_in;
      
      // Website categories (arrays)
      if (bulkCategorySelections.rooms?.length > 0) updatePayload.rooms = bulkCategorySelections.rooms;
      if (bulkCategorySelections.materials?.length > 0) updatePayload.materials = bulkCategorySelections.materials;
      if (bulkCategorySelections.styles?.length > 0) updatePayload.styles = bulkCategorySelections.styles;
      if (bulkCategorySelections.colors?.length > 0) updatePayload.colors = bulkCategorySelections.colors;
      if (bulkCategorySelections.features?.length > 0) updatePayload.features = bulkCategorySelections.features;
      
      // ===== CONVERT filter_* selections to backend fields =====
      // UI stores filters as filter_color: ['white', 'grey'], filter_slip-rating: ['R9']
      // Array filters → backend array fields; Scalar filters → backend scalar fields (first value)
      const arrayFilterMapping = ARRAY_FILTER_MAPPING;
      // Scalar filters → these map to single-value product fields
      const scalarFilterMapping = SCALAR_FILTER_MAPPING;
      
      for (const [filterKey, backendKey] of Object.entries(arrayFilterMapping)) {
        const values = bulkCategorySelections[filterKey];
        if (values?.length > 0) {
          updatePayload[backendKey] = values;
        }
      }
      
      // Handle scalar filter selections (take the first value from the array)
      for (const [filterKey, backendKey] of Object.entries(scalarFilterMapping)) {
        if (!backendKey) continue; // skip computed filters
        const values = bulkCategorySelections[filterKey];
        if (values?.length > 0 && !updatePayload[backendKey]) {
          updatePayload[backendKey] = values[0]; // scalar: use first value
        }
      }
      
      // Also handle ANY other filter_* keys dynamically (future-proof)
      for (const [key, value] of Object.entries(bulkCategorySelections)) {
        if (key.startsWith('filter_') && Array.isArray(value) && value.length > 0) {
          const slug = key.replace('filter_', '');
          const backendKey = slug.replace(/-/g, '_');
          // Only add if not already handled above
          if (!updatePayload[backendKey] && !arrayFilterMapping[key] && !scalarFilterMapping[key]) {
            // Default: treat as scalar (first value) since most custom filters are single-value
            updatePayload[backendKey] = value.length === 1 ? value[0] : value;
          }
        }
      }
      
      // ===== CONVERT spec_* selections to specification fields =====
      // UI stores specs as spec_material: ['Porcelain'], spec_edge: ['Rectified'] (arrays from toggleSpecValue)
      // Backend expects material, edge, finish, etc. as SCALAR strings for single_value_fields
      for (const [key, value] of Object.entries(bulkCategorySelections)) {
        if (key.startsWith('spec_') && value) {
          // Convert spec key to backend field name: spec_slip_rating → slip_rating, spec_pot-life → pot_life
          const backendKey = key.replace('spec_', '').replace(/-/g, '_');
          // Extract scalar value from array (specs are always single-value in DB)
          if (Array.isArray(value)) {
            if (value.length > 0) updatePayload[backendKey] = value[0];
          } else {
            updatePayload[backendKey] = value;
          }
        }
      }
      
      // Show on website
      if (bulkShowOnWebsite) updatePayload.show_on_website = true;
      
      // Debug: Log what's being sent
      console.log('[Bulk Update] bulkCategorySelections:', bulkCategorySelections);
      console.log('[Bulk Update] Final updatePayload:', updatePayload);
      
      // ===== PER-ATTRIBUTE & SECTION-SCOPED PRODUCT LOGIC =====
      // Per-attribute scopes allow individual attributes (e.g., "Outdoor Tiles" category)
      // to be applied to specific products. Section scopes apply to all attributes in a section.
      // Per-attribute scope overrides section scope.
      const hasPerAttributeScopes = Object.keys(perAttributeScopes).some(k => perAttributeScopes[k]?.size > 0);
      const hasSectionScopes = sectionProductScopes.categories.size > 0 || 
                                sectionProductScopes.filters.size > 0 || 
                                sectionProductScopes.specifications.size > 0;
      
      if (hasPerAttributeScopes || hasSectionScopes) {
        console.log('[Bulk Update] Scoped update active:', {
          perAttribute: Object.keys(perAttributeScopes).filter(k => perAttributeScopes[k]?.size > 0),
          sectionCategories: sectionProductScopes.categories.size,
          sectionFilters: sectionProductScopes.filters.size,
          sectionSpecs: sectionProductScopes.specifications.size
        });
        
        // Get all selected cat_* keys and map them to category names
        const selectedCatKeys = Object.keys(bulkCategorySelections).filter(k => k.startsWith('cat_') && bulkCategorySelections[k]);
        const catKeyToName = {};
        for (const key of selectedCatKeys) {
          const slug = key.replace('cat_', '');
          for (const group of categoryGroupsWithCats) {
            const cat = (group.categories || []).find(c => c.slug === slug);
            if (cat) {
              catKeyToName[key] = { name: cat.name, group: group.name || group.slug };
              break;
            }
          }
        }
        
        // Get selected filter_* keys — handle both array and scalar field types
        const scopedArrayFilterMapping = ARRAY_FILTER_MAPPING;
        const scopedScalarFilterMapping = SCALAR_FILTER_MAPPING;
        
        // Get selected spec_* keys
        const specKeys = Object.keys(bulkCategorySelections).filter(k => k.startsWith('spec_') && bulkCategorySelections[k]);
        
        // Common fields that go to all products (pricing, show_on_website, etc.)
        const specFieldNames = ['material', 'finish', 'type', 'edge', 'slip_rating', 'suitability', 'thickness', 
                                'size', 'color', 'pot_life', 'adhesive', 'origin', 'underfloor_heating', 'made_in'];
        const filterFieldNames = ['rooms', 'materials', 'styles', 'colors', 'features'];
        const categoryFieldNames = ['main_category', 'sub_categories'];
        const allSectionFields = new Set([...specFieldNames, ...filterFieldNames, ...categoryFieldNames]);
        
        const commonFields = {};
        for (const [key, value] of Object.entries(updatePayload)) {
          if (!allSectionFields.has(key)) {
            commonFields[key] = value;
          }
        }
        
        let successCount = 0;
        let failCount = 0;
        const batchMap = {};
        
        for (const product of productsToUpdate) {
          const productKey = getProductKey(product);
          const productPayload = { ...commonFields };
          
          // === CATEGORIES: Build per-product sub_categories ===
          const productSubCats = [];
          let productMainCategory = null;
          
          for (const catKey of selectedCatKeys) {
            const catInfo = catKeyToName[catKey];
            if (!catInfo) continue;
            
            // Check per-attribute scope first, then section scope
            const attrScope = perAttributeScopes[catKey];
            if (attrScope && attrScope.size > 0) {
              // Per-attribute scope: only if product is in this attribute's scope
              if (attrScope.has(productKey)) {
                productSubCats.push(catInfo.name);
                if (!productMainCategory) productMainCategory = catInfo.group;
              }
            } else if (sectionProductScopes.categories.size > 0) {
              // Section scope fallback: only if product is in categories section scope
              if (sectionProductScopes.categories.has(productKey)) {
                productSubCats.push(catInfo.name);
                if (!productMainCategory) productMainCategory = catInfo.group;
              }
            } else {
              // No scope: apply to all products
              productSubCats.push(catInfo.name);
              if (!productMainCategory) productMainCategory = catInfo.group;
            }
          }
          
          if (productSubCats.length > 0) {
            productPayload.sub_categories = productSubCats;
            productPayload.main_category = productMainCategory;
          }
          
          // === FILTERS: Build per-product filter values ===
          // Handle ARRAY filters (colors, rooms, styles, features, materials)
          for (const [filterKey, backendKey] of Object.entries(scopedArrayFilterMapping)) {
            const values = bulkCategorySelections[filterKey];
            if (!values?.length) continue;
            
            // Check for per-VALUE scopes (keys like filter_suitability__wall)
            const filterSlug = filterKey.replace('filter_', '');
            const hasPerValueScopes = values.some(v => {
              const pvKey = `filter_${filterSlug}__${v}`;
              return perAttributeScopes[pvKey] && perAttributeScopes[pvKey].size > 0;
            });
            
            if (hasPerValueScopes) {
              // Per-value scoping: only include values whose scope includes this product
              // First, collect all explicitly scoped product keys
              const allScopedProducts = new Set();
              values.forEach(v => {
                const pvKey = `filter_${filterSlug}__${v}`;
                const pvScope = perAttributeScopes[pvKey];
                if (pvScope && pvScope.size > 0) {
                  pvScope.forEach(pk => allScopedProducts.add(pk));
                }
              });
              
              const scopedValues = values.filter(v => {
                const pvKey = `filter_${filterSlug}__${v}`;
                const pvScope = perAttributeScopes[pvKey];
                if (pvScope && pvScope.size > 0) {
                  return pvScope.has(productKey);
                }
                // No per-value scope → only apply to products NOT covered by any scope
                return !allScopedProducts.has(productKey);
              });
              if (scopedValues.length > 0) {
                productPayload[backendKey] = scopedValues;
              }
            } else {
              // Fall back to filter-level scope or section scope
              const attrScope = perAttributeScopes[filterKey];
              if (attrScope && attrScope.size > 0) {
                if (attrScope.has(productKey)) {
                  productPayload[backendKey] = values;
                }
              } else if (sectionProductScopes.filters.size > 0) {
                if (sectionProductScopes.filters.has(productKey)) {
                  productPayload[backendKey] = values;
                }
              } else {
                productPayload[backendKey] = values;
              }
            }
          }
          
          // Handle SCALAR filters (slip_rating, suitability, edge, finish, thickness, made_in)
          for (const [filterKey, backendKey] of Object.entries(scopedScalarFilterMapping)) {
            const values = bulkCategorySelections[filterKey];
            if (!values?.length) continue;
            
            const filterSlug = filterKey.replace('filter_', '');
            // For scalar filters, per-value scoping means the specific value is scoped
            const hasPerValueScopes = values.some(v => {
              const pvKey = `filter_${filterSlug}__${v}`;
              return perAttributeScopes[pvKey] && perAttributeScopes[pvKey].size > 0;
            });
            
            if (hasPerValueScopes) {
              // Collect all explicitly scoped product keys
              const allScopedProducts = new Set();
              values.forEach(v => {
                const pvKey = `filter_${filterSlug}__${v}`;
                const pvScope = perAttributeScopes[pvKey];
                if (pvScope && pvScope.size > 0) {
                  pvScope.forEach(pk => allScopedProducts.add(pk));
                }
              });
              
              // First pass: find a SCOPED value that includes this product
              let matchedValue = values.find(v => {
                const pvKey = `filter_${filterSlug}__${v}`;
                const pvScope = perAttributeScopes[pvKey];
                return pvScope && pvScope.size > 0 && pvScope.has(productKey);
              });
              // Second pass: if no scoped value matched and product isn't explicitly scoped elsewhere
              if (!matchedValue && !allScopedProducts.has(productKey)) {
                matchedValue = values.find(v => {
                  const pvKey = `filter_${filterSlug}__${v}`;
                  const pvScope = perAttributeScopes[pvKey];
                  return !pvScope || pvScope.size === 0;
                });
              }
              if (matchedValue) productPayload[backendKey] = matchedValue;
            } else {
              const attrScope = perAttributeScopes[filterKey];
              if (attrScope && attrScope.size > 0) {
                if (attrScope.has(productKey)) productPayload[backendKey] = values[0];
              } else if (sectionProductScopes.filters.size > 0) {
                if (sectionProductScopes.filters.has(productKey)) productPayload[backendKey] = values[0];
              } else {
                productPayload[backendKey] = values[0];
              }
            }
          }
          
          // === SPECS: Build per-product spec fields ===
          for (const specKey of specKeys) {
            const rawValue = bulkCategorySelections[specKey];
            if (!rawValue) continue;
            const backendKey = specKey.replace('spec_', '').replace(/-/g, '_');
            const specSlug = specKey.replace('spec_', '');
            
            // Support both legacy string and new array format
            const values = Array.isArray(rawValue) ? rawValue : [rawValue];
            if (values.length === 0) continue;
            
            // Check for per-VALUE scopes (keys like spec_finish__matt_r11)
            const hasPerValueScopes = values.some(v => {
              const pvKey = `spec_${specSlug}__${v}`;
              return perAttributeScopes[pvKey] && perAttributeScopes[pvKey].size > 0;
            });
            
            if (hasPerValueScopes) {
              // Collect all explicitly scoped product keys
              const allScopedProducts = new Set();
              values.forEach(v => {
                const pvKey = `spec_${specSlug}__${v}`;
                const pvScope = perAttributeScopes[pvKey];
                if (pvScope && pvScope.size > 0) {
                  pvScope.forEach(pk => allScopedProducts.add(pk));
                }
              });
              
              // First pass: find a SCOPED value that includes this product
              let matchedValue = values.find(v => {
                const pvKey = `spec_${specSlug}__${v}`;
                const pvScope = perAttributeScopes[pvKey];
                return pvScope && pvScope.size > 0 && pvScope.has(productKey);
              });
              // Second pass: only apply unscoped value to products not covered by any scope
              if (!matchedValue && !allScopedProducts.has(productKey)) {
                matchedValue = values.find(v => {
                  const pvKey = `spec_${specSlug}__${v}`;
                  const pvScope = perAttributeScopes[pvKey];
                  return !pvScope || pvScope.size === 0;
                });
              }
              if (matchedValue) {
                productPayload[backendKey] = matchedValue;
              }
            } else {
              // Fall back to section scope — use first selected value
              const value = values[0];
              const attrScope = perAttributeScopes[specKey];
              if (attrScope && attrScope.size > 0) {
                if (attrScope.has(productKey)) {
                  productPayload[backendKey] = value;
                }
              } else if (sectionProductScopes.specifications.size > 0) {
                if (sectionProductScopes.specifications.has(productKey)) {
                  productPayload[backendKey] = value;
                }
              } else {
                productPayload[backendKey] = value;
              }
            }
          }
          
          // Also handle legacy spec fields from direct selections (not spec_* keys)
          // BUG FIX: Direct spec fields (material, finish, type, edge, etc.) were stripped from
          // commonFields but never re-added in the scoped path. This caused them to silently drop.
          // Re-add any direct spec fields from updatePayload that aren't already in productPayload.
          for (const field of specFieldNames) {
            if (field in updatePayload && !(field in productPayload)) {
              // Apply section scope for specifications
              const specScopeKey = `spec_${field}`;
              const attrScope = perAttributeScopes[specScopeKey];
              if (attrScope && attrScope.size > 0) {
                if (attrScope.has(productKey)) {
                  productPayload[field] = updatePayload[field];
                }
              } else if (sectionProductScopes.specifications.size > 0) {
                if (sectionProductScopes.specifications.has(productKey)) {
                  productPayload[field] = updatePayload[field];
                }
              } else {
                // No scope: apply to all products
                productPayload[field] = updatePayload[field];
              }
            }
          }
          
          // BUG FIX: Also handle dynamic filter_* keys that aren't in scopedArrayFilterMapping
          // or scopedScalarFilterMapping (custom filters). Without this, they silently drop in scoped mode.
          for (const [key, value] of Object.entries(bulkCategorySelections)) {
            if (key.startsWith('filter_') && Array.isArray(value) && value.length > 0) {
              if (scopedArrayFilterMapping[key] || scopedScalarFilterMapping[key] !== undefined) continue;
              const slug = key.replace('filter_', '');
              const backendKey = slug.replace(/-/g, '_');
              if (backendKey in productPayload) continue; // already handled
              // Apply filter section scope
              const attrScope = perAttributeScopes[key];
              if (attrScope && attrScope.size > 0) {
                if (attrScope.has(productKey)) {
                  productPayload[backendKey] = value.length === 1 ? value[0] : value;
                }
              } else if (sectionProductScopes.filters.size > 0) {
                if (sectionProductScopes.filters.has(productKey)) {
                  productPayload[backendKey] = value.length === 1 ? value[0] : value;
                }
              } else {
                productPayload[backendKey] = value.length === 1 ? value[0] : value;
              }
            }
          }
          
          // Also handle direct filter array fields (rooms, materials, etc.) from updatePayload
          // that weren't picked up via filter_* keys
          for (const field of filterFieldNames) {
            if (field in updatePayload && !(field in productPayload)) {
              const attrScope = perAttributeScopes[`filter_${field}`];
              if (attrScope && attrScope.size > 0) {
                if (attrScope.has(productKey)) {
                  productPayload[field] = updatePayload[field];
                }
              } else if (sectionProductScopes.filters.size > 0) {
                if (sectionProductScopes.filters.has(productKey)) {
                  productPayload[field] = updatePayload[field];
                }
              } else {
                productPayload[field] = updatePayload[field];
              }
            }
          }
          
          // Also handle category fields that weren't picked up via cat_* keys
          if (!productPayload.main_category && updatePayload.main_category) {
            const catScope = sectionProductScopes.categories;
            if (catScope.size > 0) {
              if (catScope.has(productKey)) {
                productPayload.main_category = updatePayload.main_category;
                if (updatePayload.sub_categories) productPayload.sub_categories = updatePayload.sub_categories;
              }
            } else {
              productPayload.main_category = updatePayload.main_category;
              if (updatePayload.sub_categories) productPayload.sub_categories = updatePayload.sub_categories;
            }
          }
          
          if (bulkCategorySelections.underfloor_heating) {
            const attrScope = perAttributeScopes['spec_underfloor_heating'];
            if (attrScope && attrScope.size > 0) {
              if (attrScope.has(productKey)) productPayload.underfloor_heating = bulkCategorySelections.underfloor_heating;
            } else if (sectionProductScopes.specifications.size === 0 || sectionProductScopes.specifications.has(productKey)) {
              productPayload.underfloor_heating = bulkCategorySelections.underfloor_heating;
            }
          }
          if (bulkCategorySelections.made_in) {
            const madeInValue = bulkCategorySelections.made_in === '__CLEAR__' ? '' : bulkCategorySelections.made_in;
            const attrScope = perAttributeScopes['spec_made_in'];
            if (attrScope && attrScope.size > 0) {
              if (attrScope.has(productKey)) productPayload.made_in = madeInValue;
            } else if (sectionProductScopes.specifications.size === 0 || sectionProductScopes.specifications.has(productKey)) {
              productPayload.made_in = madeInValue;
            }
          }
          
          if (Object.keys(productPayload).length === 0) continue;
          
          // Group products by their payload + id_field for batching
          const { id: productApiId, field: idField } = getProductIdForApi(product);
          
          // Skip products without valid IDs — they can't be updated via API
          if (!productApiId) {
            console.warn('Skipping product without valid ID:', product.name || product.product_name);
            continue;
          }
          
          const batchKey = `${idField}::${JSON.stringify(productPayload)}`;
          if (!batchMap[batchKey]) {
            batchMap[batchKey] = { ids: [], idField, payload: productPayload };
          }
          batchMap[batchKey].ids.push(productApiId);
        }
        
        // Send batched requests instead of individual ones
        const batches = Object.values(batchMap);
        
        // If only clearing fields (no new attribute selections), send a single clear request for all products
        if (batches.length === 0 && hasFieldsToClear) {
          const allProductIds = productsToUpdate.map(p => {
            const { id } = getProductIdForApi(p);
            return id;
          }).filter(id => id != null);
          const { field: idField } = getProductIdForApi(productsToUpdate[0]);
          try {
            const response = await fetch(`${API_URL}/api/supplier-sync/products/bulk-update-unified`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                product_ids: allProductIds,
                id_field: idField,
                updates: {},
                fields_to_clear: fieldsToClear
              })
            });
            if (response.ok) successCount = allProductIds.length;
            else failCount = allProductIds.length;
          } catch (err) {
            failCount = allProductIds.length;
          }
        }
        
        // Split large batches into smaller chunks to prevent timeout on production
        const MAX_BATCH_SIZE = 10;
        const splitBatches = [];
        for (const batch of batches) {
          if (batch.ids.length <= MAX_BATCH_SIZE) {
            splitBatches.push(batch);
          } else {
            // Split into chunks of MAX_BATCH_SIZE
            for (let i = 0; i < batch.ids.length; i += MAX_BATCH_SIZE) {
              splitBatches.push({
                ids: batch.ids.slice(i, i + MAX_BATCH_SIZE),
                idField: batch.idField,
                payload: batch.payload
              });
            }
          }
        }
        
        // Log the exact batches being sent so the owner can inspect what's
        // being pushed vs what actually saved (helps trace scoped-save issues).
        console.log('[Bulk Update — Scoped] Sending', splitBatches.length, 'batches:');
        splitBatches.forEach((b, i) => {
          console.log(`  Batch ${i + 1}/${splitBatches.length}:`, {
            ids: b.ids,
            idField: b.idField,
            payload: b.payload
          });
        });
        
        let scopedAutoPublished = 0;
        const verificationFailureSamples = [];
        let verificationChecked = 0;
        for (const batch of splitBatches) {
          try {
            const response = await fetch(`${API_URL}/api/supplier-sync/products/bulk-update-unified`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                product_ids: batch.ids.filter(id => id != null),
                id_field: batch.idField,
                updates: batch.payload,
                mode: bulkCategoryMode,
                ...(hasFieldsToClear && { fields_to_clear: fieldsToClear })
              })
            });
            if (response.ok) {
              const result = await response.json();
              successCount += batch.ids.length;
              scopedAutoPublished += result.auto_published || 0;
              verificationChecked += result.verification_checked || 0;
              if (Array.isArray(result.verification_failures) && result.verification_failures.length > 0) {
                verificationFailureSamples.push(...result.verification_failures);
              }
            } else {
              failCount += batch.ids.length;
              try {
                const errData = await response.json();
                console.error('Bulk update batch failed:', response.status, errData);
              } catch (e) {
                console.error('Bulk update batch failed:', response.status, response.statusText);
              }
            }
          } catch (err) {
            failCount += batch.ids.length;
            console.error('Bulk update batch error:', err);
          }
        }
        
        if (successCount > 0) {
          const scopeCount = Object.keys(perAttributeScopes).filter(k => perAttributeScopes[k]?.size > 0).length;
          const scopeMsg = scopeCount > 0 ? ` (${scopeCount} attributes individually scoped)` : '';
          toast.success(`Updated ${successCount} products with scoped attributes${scopeMsg}`);
          if (scopedAutoPublished > 0) {
            toast.info(`${scopedAutoPublished} product${scopedAutoPublished > 1 ? 's were' : ' was'} auto-published to the storefront`);
          }
          if (verificationFailureSamples.length > 0) {
            // Group failures by SKU for a readable summary in the toast + console
            const bySku = {};
            verificationFailureSamples.forEach(f => {
              if (!bySku[f.sku]) bySku[f.sku] = [];
              bySku[f.sku].push(`${f.field}: expected ${JSON.stringify(f.expected)}, got ${JSON.stringify(f.actual)}`);
            });
            console.warn('[Bulk Update — Scoped] Verification failures by SKU:', bySku);
            const failedSkuCount = Object.keys(bySku).length;
            toast.warning(
              `⚠️ ${failedSkuCount} product${failedSkuCount !== 1 ? 's' : ''} didn't save correctly — opening Save Results for full details`,
              { duration: 12000 }
            );
            // Map verification failures onto the failedItems structure so
            // the Save Results dialog can show a per-SKU diagnostic table.
            const verificationFailedItems = Object.entries(bySku).map(([sku, mismatches]) => {
              const product = productsToUpdate.find(p => p.sku === sku || p.supplier_code === sku) || {};
              return {
                id: sku,
                id_field: product.sku === sku ? 'sku' : 'supplier_code',
                product_name: product.our_product_name || product.product_name || product.name || sku,
                reason: `Save didn't stick: ${mismatches.join('; ')}`,
                verification: true,
              };
            });
            setLastSaveResult({
              success: successCount,
              failed: verificationFailedItems.length,
              total: productsToUpdate.length,
              failed_items: verificationFailedItems,
              verificationFailures: verificationFailureSamples,
              verificationChecked,
              timestamp: Date.now(),
            });
            setShowSaveResults(true);
          } else {
            setLastSaveResult({ success: successCount, failed: failCount, total: productsToUpdate.length, timestamp: Date.now(), verificationFailures: [], verificationChecked });
          }
        }
        if (failCount > 0) {
          toast.error(`Failed to update ${failCount} products`);
          if (!successCount) setLastSaveResult({ success: 0, failed: failCount, total: productsToUpdate.length, timestamp: Date.now() });
        }
        
        // Refresh products AND recompute breakdowns so "Currently Saved" updates immediately
        const freshProducts = await fetchProducts();
        if (freshProducts) {
          refreshBreakdownsAfterSave(freshProducts);
        }
        // Keep scopes intact after save so user can see what was applied
        setFieldsToClear({});
        setBulkCategoryLoading(false);
        return;
      }
      
      // If per-product assignments exist, we need to update products individually
      const hasPerProductAssignments = Object.keys(perProductAssignments).some(key => 
        Object.keys(perProductAssignments[key] || {}).length > 0
      );
      
      if (hasPerProductAssignments) {
        let successCount = 0;
        let failCount = 0;
        
        for (const product of productsToUpdate) {
          const productPayload = { ...updatePayload };
          
          // Apply per-product attribute assignments (e.g., different thickness per product)
          const productKey = getProductKey(product);
          
          // Filter mapping for per-product assignments
          const filterFieldMapping = COMBINED_FILTER_MAPPING;
          
          for (const [attrKey, assignments] of Object.entries(perProductAssignments)) {
            const assignedValue = assignments[productKey];
            if (!assignedValue) continue;
            
            const backendField = filterFieldMapping[attrKey];
            if (backendField) {
              // For array fields (colors, rooms, styles, features, sizes, materials), wrap in array
              if (['colors', 'rooms', 'styles', 'features', 'sizes', 'materials'].includes(backendField)) {
                productPayload[backendField] = [assignedValue];
              } else {
                // For scalar fields (thickness, edge, finish, etc.), set directly
                productPayload[backendField] = assignedValue;
              }
            }
          }
          
          try {
            const { id: productApiId, field: idField } = getProductIdForApi(product);
            const response = await fetch(`${API_URL}/api/supplier-sync/products/bulk-update-unified`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                product_ids: [productApiId],
                id_field: idField,
                updates: productPayload,
                mode: bulkCategoryMode,
                ...(hasFieldsToClear && { fields_to_clear: fieldsToClear })
              })
            });
            
            if (response.ok) {
              successCount++;
            } else {
              failCount++;
            }
          } catch (err) {
            failCount++;
          }
        }
        
        if (successCount > 0) {
          toast.success(`Updated ${successCount} products`);
        }
        if (failCount > 0) {
          toast.error(`Failed to update ${failCount} products`);
        }
        
        setShowBulkCategoryModal(false);
        setSelectedProducts(new Set());
        setBulkCategorySelections({
          material: '', finish: '', type: '', edge: '', slip_rating: '', suitability: '', thickness: '', underfloor_heating: '',
          cost_price: '', list_price: '', made_in: '', main_category: '', sub_categories: [],
          rooms: [], materials: [], styles: [], colors: [], features: []
        });
        setBulkShowOnWebsite(false);
        setPricingSizeFilter('all');
        setFieldsToClear({});
        clearPersistedState();
        clearServerDraft();
        fetchProducts();
        setBulkCategoryLoading(false);
        return;
      }
      
      // Extract product IDs using the proper helper (handles products without SKUs)
      // Group by id_field since different products may use sku vs supplier_code
      const bySkuProducts = productsToUpdate.filter(p => p.sku);
      const bySupplierCodeProducts = productsToUpdate.filter(p => !p.sku && p.supplier_code);
      
      // Take before-snapshot for undo support (before any writes)
      const allProductIds = [...bySkuProducts.map(p => p.sku), ...bySupplierCodeProducts.map(p => p.supplier_code)];
      const primaryIdField = bySkuProducts.length > 0 ? 'sku' : 'supplier_code';
      let beforeSnapshot = [];
      try {
        const snapRes = await fetch(`${API_URL}/api/bulk-edit-tools/snapshot`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ product_ids: allProductIds, id_field: primaryIdField, fields: Object.keys(updatePayload) }),
        });
        if (snapRes.ok) {
          const snapData = await snapRes.json();
          beforeSnapshot = snapData.snapshot || [];
        }
      } catch (e) { /* snapshot is best-effort */ }
      
      let totalSuccessCount = 0;
      let totalFailCount = 0;
      let totalAutoPublished = 0;
      // Per-product failure tracking — populated when a batch call fails or
      // reports a partial update. We then retry each product individually so
      // we can pinpoint exactly which SKU(s) failed and why. Was previously
      // Force Save's job; unified into the main Save 3 Aug 2026.
      const failedItems = []; // [{ id, id_field, product_name, reason }]

      // Helper — send ONE product's update through the same endpoint. Used
      // both for the retry pass and for surfacing per-product errors in the
      // Save Results dialog. Returns { ok, reason }.
      const retryOne = async (id, idField, product) => {
        try {
          const r = await fetch(`${API_URL}/api/supplier-sync/products/bulk-update-unified`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              product_ids: [id],
              id_field: idField,
              updates: updatePayload,
              mode: bulkCategoryMode,
              update_mode: updateMode,
              ...(hasFieldsToClear && { fields_to_clear: fieldsToClear })
            })
          });
          if (r.ok) {
            const j = await r.json();
            return { ok: (j.updated_count || j.total_updated || 0) >= 1, reason: '' };
          }
          let reason = `HTTP ${r.status}`;
          try {
            const errBody = await r.json();
            reason = errBody.detail || errBody.message || reason;
          } catch (_) { /* ignore */ }
          return { ok: false, reason };
        } catch (err) {
          return { ok: false, reason: err.message || 'Network error' };
        }
      };

      // Send request for SKU-based products
      let verificationFailures = [];
      let verificationChecked = 0;
      if (bySkuProducts.length > 0) {
        const skuIds = bySkuProducts.map(p => p.sku).filter(id => id != null && id !== '');
        if (skuIds.length > 0) {
          const response = await fetch(`${API_URL}/api/supplier-sync/products/bulk-update-unified`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              product_ids: skuIds,
              id_field: 'sku',
              updates: updatePayload,
              mode: bulkCategoryMode,
              update_mode: updateMode,
              ...(hasFieldsToClear && { fields_to_clear: fieldsToClear })
            })
          });
          let updatedCount = 0;
          if (response.ok) {
            const result = await response.json();
            updatedCount = result.updated_count || result.total_updated || skuIds.length;
            totalSuccessCount += updatedCount;
            totalAutoPublished += result.auto_published || 0;
            verificationChecked += result.verification_checked || 0;
            if (Array.isArray(result.verification_failures) && result.verification_failures.length > 0) {
              verificationFailures.push(...result.verification_failures);
            }
          } else {
            try { const err = await response.json(); console.error('SKU batch failed:', response.status, err); } catch (e) { /* ignore */ }
          }
          // If the backend didn't confirm every product was updated, retry each
          // individually so we can surface exactly which one(s) failed.
          if (updatedCount < skuIds.length) {
            setSaveProgress({ current: 0, total: skuIds.length, status: 'saving' });
            let retryOk = 0;
            for (let i = 0; i < skuIds.length; i++) {
              const id = skuIds[i];
              const product = bySkuProducts.find(p => p.sku === id) || {};
              const r = await retryOne(id, 'sku', product);
              if (r.ok) {
                retryOk += 1;
              } else {
                failedItems.push({
                  id,
                  id_field: 'sku',
                  product_name: product.our_product_name || product.product_name || product.name || id,
                  reason: r.reason,
                });
              }
              setSaveProgress({ current: i + 1, total: skuIds.length, status: 'saving' });
            }
            // Reconcile counters: batch may have already counted some as OK;
            // trust the per-product pass as the source of truth.
            totalSuccessCount = totalSuccessCount - updatedCount + retryOk;
            totalFailCount += skuIds.length - retryOk;
            setSaveProgress({ current: skuIds.length, total: skuIds.length, status: 'done' });
          }
        }
      }

      // Send request for supplier_code-based products
      if (bySupplierCodeProducts.length > 0) {
        const scIds = bySupplierCodeProducts.map(p => p.supplier_code).filter(id => id != null && id !== '');
        if (scIds.length > 0) {
          const response = await fetch(`${API_URL}/api/supplier-sync/products/bulk-update-unified`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              product_ids: scIds,
              id_field: 'supplier_code',
              updates: updatePayload,
              mode: bulkCategoryMode,
              update_mode: updateMode,
              ...(hasFieldsToClear && { fields_to_clear: fieldsToClear })
            })
          });
          let updatedCount = 0;
          if (response.ok) {
            const result = await response.json();
            updatedCount = result.updated_count || result.total_updated || scIds.length;
            totalSuccessCount += updatedCount;
            totalAutoPublished += result.auto_published || 0;
            verificationChecked += result.verification_checked || 0;
            if (Array.isArray(result.verification_failures) && result.verification_failures.length > 0) {
              verificationFailures.push(...result.verification_failures);
            }
          } else {
            try { const err = await response.json(); console.error('Supplier code batch failed:', response.status, err); } catch (e) { /* ignore */ }
          }
          if (updatedCount < scIds.length) {
            setSaveProgress({ current: 0, total: scIds.length, status: 'saving' });
            let retryOk = 0;
            for (let i = 0; i < scIds.length; i++) {
              const id = scIds[i];
              const product = bySupplierCodeProducts.find(p => p.supplier_code === id) || {};
              const r = await retryOne(id, 'supplier_code', product);
              if (r.ok) {
                retryOk += 1;
              } else {
                failedItems.push({
                  id,
                  id_field: 'supplier_code',
                  product_name: product.our_product_name || product.product_name || product.name || id,
                  reason: r.reason,
                });
              }
              setSaveProgress({ current: i + 1, total: scIds.length, status: 'saving' });
            }
            totalSuccessCount = totalSuccessCount - updatedCount + retryOk;
            totalFailCount += scIds.length - retryOk;
            setSaveProgress({ current: scIds.length, total: scIds.length, status: 'done' });
          }
        }
      }

      if (totalSuccessCount > 0) {
        const sizeInfo = pricingSizeFilter !== 'all' && hasPricing ? ` (${getFilterDisplayLabel(pricingSizeFilter)} only)` : '';
        
        // Also save description if there's a template pending
        if (bulkDescriptionSettings.description_template) {
          try {
            const productsWithAttributes = productsToUpdate.map(p => ({
              supplier: p.supplier,
              sku: p.sku || p.supplier_code,
              color: p.color || p.attributes?.color || '',
              size: p.size || p.attributes?.size || '',
              material: p.material || p.attributes?.material || '',
              finish: p.finish || p.attributes?.finish || '',
              name: p.our_product_name || p.display_name || p.product_name || p.name || '',
              display_name: p.our_product_name || p.display_name || p.product_name || p.name || '',
              product_name: p.our_product_name || p.display_name || p.product_name || p.name || '',
              series: p.series || '',
              supplier_product_name: p.supplier_product_name || p.name || ''
            }));
            
            const descResponse = await api.put('/supplier-sync/products/bulk-description', {
              products: productsWithAttributes,
              description_template: bulkDescriptionSettings.description_template,
              seo_keywords: bulkDescriptionSettings.seo_keywords || '',
              hidden_seo_keywords: bulkDescriptionSettings.hidden_seo_keywords || '',
              generate_hidden_seo: bulkDescriptionSettings.generate_hidden_seo || false,
              use_placeholders: bulkDescriptionSettings.use_placeholders !== false,
              add_variations: bulkDescriptionSettings.add_variations || false,
              update_mode: updateMode
            });
            const descResult = descResponse.data;
            toast.success(`Description also updated for ${descResult.updated_count} products`);
            
            // Also save to collection_settings so storefront picks it up
            try {
              const firstProduct = productsToUpdate[0];
              const productName = firstProduct.our_product_name || firstProduct.display_name || firstProduct.product_name || firstProduct.name || '';
              const collectionName = getSeriesName(productName);
              if (collectionName) {
                // Resolve placeholders using first product's data
                let resolvedDesc = bulkDescriptionSettings.description_template.trim();
                if (bulkDescriptionSettings.use_placeholders) {
                  resolvedDesc = resolvedDesc.replace(/\{color\}/g, (firstProduct.color || firstProduct.attributes?.color || '').trim());
                  resolvedDesc = resolvedDesc.replace(/\{size\}/g, (firstProduct.size || firstProduct.attributes?.size || '').trim());
                  resolvedDesc = resolvedDesc.replace(/\{material\}/g, (firstProduct.material || firstProduct.attributes?.material || '').trim());
                  resolvedDesc = resolvedDesc.replace(/\{finish\}/g, (firstProduct.finish || firstProduct.attributes?.finish || '').trim());
                  resolvedDesc = resolvedDesc.replace(/\{name\}/g, productName.trim());
                  resolvedDesc = resolvedDesc.replace(/\{series\}/g, (firstProduct.series || collectionName || '').trim());
                  resolvedDesc = resolvedDesc.replace(/\s+/g, ' ').trim();
                }
                await api.put(`/website-admin/collections/${encodeURIComponent(collectionName)}`, {
                  custom_description: resolvedDesc
                });
              }
            } catch (collErr) {
              console.warn('Collection settings description save skipped:', collErr);
            }
          } catch (descError) {
            console.error('Description save failed:', descError);
            toast.error('Category update succeeded but description save failed');
          }
        }
        
        toast.success(`Updated ${totalSuccessCount} products${sizeInfo}`);
        if (totalAutoPublished > 0) {
          toast.info(`${totalAutoPublished} product${totalAutoPublished > 1 ? 's were' : ' was'} auto-published to the storefront`);
        }
        // Safety check: surface any silent save failures the backend detected
        if (verificationFailures.length > 0) {
          const bySku = {};
          verificationFailures.forEach(f => {
            if (!bySku[f.sku]) bySku[f.sku] = [];
            bySku[f.sku].push(`${f.field}: expected ${JSON.stringify(f.expected)}, got ${JSON.stringify(f.actual)}`);
          });
          console.warn('[Bulk Update] Verification failures by SKU:', bySku);
          const failedSkuCount = Object.keys(bySku).length;
          toast.warning(
            `⚠️ ${failedSkuCount} product${failedSkuCount !== 1 ? 's' : ''} didn't save correctly — opening Save Results for details`,
            { duration: 12000 }
          );
          // Merge verification failures into failedItems for the Save Results dialog
          const verificationFailedItems = Object.entries(bySku).map(([sku, mismatches]) => {
            const product = productsToUpdate.find(p => p.sku === sku || p.supplier_code === sku) || {};
            return {
              id: sku,
              id_field: product.sku === sku ? 'sku' : 'supplier_code',
              product_name: product.our_product_name || product.product_name || product.name || sku,
              reason: `Save didn't stick: ${mismatches.join('; ')}`,
              verification: true,
            };
          });
          const combinedFailedItems = [...failedItems, ...verificationFailedItems];
          setLastSaveResult({
            success: totalSuccessCount,
            failed: totalFailCount + verificationFailedItems.length,
            total: productsToUpdate.length,
            failed_items: combinedFailedItems,
            verificationFailures,
            verificationChecked,
            timestamp: Date.now(),
          });
          setShowSaveResults(true);
        } else {
          if (verificationChecked > 0) {
            console.log(`[Bulk Update] Verification passed — ${verificationChecked} products confirmed`);
          }
          setLastSaveResult({
            success: totalSuccessCount,
            failed: totalFailCount,
            total: productsToUpdate.length,
            failed_items: failedItems,
            verificationFailures: [],
            verificationChecked,
            timestamp: Date.now(),
          });
        }
        // 3 Aug 2026 — auto-open Save Results dialog when ANY product
        // failed. This replaces the old "Force Save" per-product view; the
        // dialog now shows exactly which SKUs failed and why, so the owner
        // can fix them without having to "save again and hope".
        if (totalFailCount > 0) {
          setShowSaveResults(true);
        }
        
        // Log edit history with before-snapshot (async, non-blocking)
        fetch(`${API_URL}/api/bulk-edit-tools/history`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            user: 'admin', action: 'bulk_update', product_count: productsToUpdate.length,
            product_ids: allProductIds, id_field: primaryIdField,
            changes_summary: updatePayload, before_snapshot: beforeSnapshot,
            updates_applied: updatePayload, mode: bulkCategoryMode, supplier: selectedSupplier || '',
          }),
        }).catch(e => console.error('History log failed:', e));
        
        // Refresh products AND recompute breakdowns so "Currently Saved" updates immediately
        const freshProducts = await fetchProducts();
        if (freshProducts) {
          refreshBreakdownsAfterSave(freshProducts);
        }
        
        // Save & Verify: confirm data persisted in DB
        runSaveVerification(updatePayload, allProductIds, primaryIdField);
        
        setFieldsToClear({});
        clearServerDraft(); // Clear draft after successful save
        setBulkCategoryLoading(false);
        return;
      } else {
        toast.error(`Failed to update ${totalFailCount} products`);
        setLastSaveResult({
          success: 0,
          failed: totalFailCount,
          total: productsToUpdate.length,
          failed_items: failedItems,
          timestamp: Date.now(),
        });
        setShowSaveResults(true);
      }
    } catch (error) {
      console.error('Bulk update error:', error);
      toast.error('Failed to update products');
    } finally {
      setBulkCategoryLoading(false);
    }
  };

  // Take a before-snapshot and log edit to history for undo support
  const takeSnapshotAndLogHistory = async (productIds, idField, updatesApplied, productCount) => {
    try {
      // 1. Take snapshot of current values before save
      const snapshotRes = await fetch(`${API_URL}/api/bulk-edit-tools/snapshot`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          product_ids: productIds,
          id_field: idField,
          fields: Object.keys(updatesApplied),
        }),
      });
      
      let beforeSnapshot = [];
      if (snapshotRes.ok) {
        const snapshotData = await snapshotRes.json();
        beforeSnapshot = snapshotData.snapshot || [];
      }

      // 2. Log edit to history
      await fetch(`${API_URL}/api/bulk-edit-tools/history`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          user: 'admin',
          action: 'bulk_update',
          product_count: productCount,
          product_ids: productIds,
          id_field: idField,
          changes_summary: updatesApplied,
          before_snapshot: beforeSnapshot,
          updates_applied: updatesApplied,
          mode: bulkCategoryMode,
          supplier: selectedSupplier || '',
        }),
      });
    } catch (err) {
      console.error('Failed to log edit history:', err);
    }
  };

  // Save & Verify: After save, re-fetch and compare to confirm persistence
  const runSaveVerification = async (updatesApplied, productIds, idField) => {
    setVerifyingAfterSave(true);
    try {
      // Fetch the products fresh from DB
      const res = await fetch(`${API_URL}/api/bulk-edit-tools/snapshot`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          product_ids: productIds,
          id_field: idField,
          fields: Object.keys(updatesApplied),
        }),
      });
      
      if (!res.ok) {
        setVerificationResult({ verified: false, message: 'Could not verify — API error', timestamp: Date.now() });
        return;
      }
      
      const data = await res.json();
      const dbProducts = data.snapshot || [];
      
      let verified = 0;
      let mismatches = 0;
      const mismatchFields = new Set();
      
      for (const prod of dbProducts) {
        let productOk = true;
        for (const [field, expectedVal] of Object.entries(updatesApplied)) {
          const actualVal = prod[field];
          if (Array.isArray(expectedVal)) {
            const actualArr = actualVal || [];
            const hasAll = expectedVal.every(v => actualArr.includes(v));
            if (!hasAll) { productOk = false; mismatchFields.add(field); }
          } else if (expectedVal !== undefined && expectedVal !== null) {
            if (String(actualVal) !== String(expectedVal) && actualVal !== expectedVal) {
              productOk = false;
              mismatchFields.add(field);
            }
          }
        }
        if (productOk) verified++;
        else mismatches++;
      }
      
      setVerificationResult({
        verified,
        mismatches,
        total: dbProducts.length,
        mismatchFields: Array.from(mismatchFields),
        timestamp: Date.now(),
      });
    } catch (err) {
      setVerificationResult({ verified: false, message: 'Verification failed', timestamp: Date.now() });
    } finally {
      setVerifyingAfterSave(false);
    }
  };


  // Toggle category selection for bulk edit (for array fields like rooms, styles, etc.)
  const toggleBulkCategory = (categoryType, categoryId) => {
    setBulkCategorySelections(prev => {
      const current = prev[categoryType] || [];
      const isSelected = current.includes(categoryId);
      return {
        ...prev,
        [categoryType]: isSelected
          ? current.filter(id => id !== categoryId)
          : [...current, categoryId]
      };
    });
  };
  
  // Set single value for bulk edit (for single-select fields like material, finish, etc.)
  const setBulkSingleValue = (field, value) => {
    setBulkCategorySelections(prev => ({
      ...prev,
      [field]: prev[field] === value ? '' : value // Toggle off if same value clicked
    }));
  };

  // Reusable function to compute field breakdowns from a list of products
  // Called both when modal opens AND after saves to refresh "Currently Saved" tags
  const computeFieldBreakdowns = useCallback((selectedProductsList) => {
    if (!selectedProductsList || selectedProductsList.length === 0) return;
    
    const scalarFieldsSet = new Set();
    const arrayFieldsSet = new Set();
    const specsFieldsSet = new Set();
    
    selectedProductsList.forEach(p => {
      Object.entries(p).forEach(([key, val]) => {
        if (key === '_id' || key === 'images' || key === 'image') return;
        if (Array.isArray(val) && val.length > 0) {
          arrayFieldsSet.add(key);
        } else if (val !== null && val !== undefined && val !== '' && typeof val !== 'object' && typeof val !== 'boolean') {
          scalarFieldsSet.add(key);
        }
        if (key === 'specifications' && val && typeof val === 'object' && !Array.isArray(val)) {
          Object.entries(val).forEach(([sk, sv]) => {
            if (sv !== null && sv !== undefined && sv !== '') specsFieldsSet.add(sk);
          });
        }
      });
    });
    
    specsFieldsSet.forEach(f => scalarFieldsSet.add(f));
    
    const breakdowns = {};
    
    const getBreakdownForField = (field) => {
      const counts = {};
      selectedProductsList.forEach(p => {
        const v = p[field] ?? (p.attributes && p.attributes[field]) ?? (p.specifications && typeof p.specifications === 'object' && p.specifications[field]) ?? null;
        if (v !== null && v !== undefined && v !== '' && (typeof v === 'string' || typeof v === 'number')) {
          counts[v] = (counts[v] || 0) + 1;
        }
      });
      return counts;
    };
    
    scalarFieldsSet.forEach(f => {
      const bd = getBreakdownForField(f);
      if (Object.keys(bd).length > 0) breakdowns[f] = bd;
    });
    
    arrayFieldsSet.forEach(f => {
      const counts = {};
      selectedProductsList.forEach(p => {
        const arr = p[f] || [];
        if (Array.isArray(arr)) {
          // Deduplicate within the array (case-insensitive) before counting
          const seen = new Set();
          arr.forEach(v => {
            if (v) {
              const normalized = typeof v === 'string' ? v.trim() : v;
              const key = typeof normalized === 'string' ? normalized.toLowerCase() : normalized;
              if (!seen.has(key)) {
                seen.add(key);
                counts[normalized] = (counts[normalized] || 0) + 1;
              }
            }
          });
        }
      });
      if (Object.keys(counts).length > 0) breakdowns[`_array_${f}`] = counts;
    });
    
    // Deduplicate: when both scalar and array versions exist (e.g., 'color' and '_array_colors'),
    // remove the scalar to prevent duplicate "Currently saved" tags
    const arrayToScalar = {
      '_array_colors': 'color',
      '_array_materials': 'material',
      '_array_sub_categories': 'category',
      '_array_rooms': 'room',
      '_array_styles': 'style',
      '_array_features': 'feature',
    };
    Object.entries(arrayToScalar).forEach(([arrKey, scalarKey]) => {
      if (breakdowns[arrKey] && breakdowns[scalarKey]) {
        delete breakdowns[scalarKey];
      }
    });
    
    setBulkFieldBreakdowns(breakdowns);
    return breakdowns;
  }, []);

  // Refresh breakdowns after save using fresh product data
  const refreshBreakdownsAfterSave = useCallback(async (freshProducts) => {
    const productsList = freshProducts || products;
    const selectedSkusList = Array.from(selectedProducts);
    const selectedProductsList = productsList.filter(p => selectedSkusList.includes(getProductKey(p)));
    if (selectedProductsList.length > 0) {
      computeFieldBreakdowns(selectedProductsList);
    }
    // Clear stale per-attribute scopes so badges (3/8, 5/8) refresh from new data
    setPerAttributeScopes({});
  }, [products, selectedProducts, computeFieldBreakdowns]);

  // Quick Push Save — saves a single attribute immediately, respecting per-value scopes
  const handleQuickSave = useCallback(async (attrKey, attrType) => {
    // attrKey: e.g. 'spec_size', 'filter_color', 'cat_kitchen-floor-tiles'
    // attrType: 'spec' | 'filter' | 'cat'
    
    // Handle direct field saves (e.g., made_in, underfloor_heating - no spec_/filter_ prefix)
    if (attrType === 'direct') {
      const rawValue = bulkCategorySelections[attrKey];
      if (!rawValue || rawValue === '') {
        toast.error('No value selected to save');
        return;
      }
      const value = rawValue === '__CLEAR__' ? '' : rawValue;
      const backendKey = attrKey; // e.g., 'made_in'
      
      const selectedSkusList = Array.from(selectedProducts);
      let productsToUpdate = products.filter(p => selectedSkusList.includes(getProductKey(p)));
      if (bulkThicknessFilter !== 'all') {
        productsToUpdate = getProductsFilteredByThickness(bulkThicknessFilter);
      }
      
      let successCount = 0;
      let failCount = 0;
      const BATCH_SIZE = 10;
      
      for (let i = 0; i < productsToUpdate.length; i += BATCH_SIZE) {
        const batch = productsToUpdate.slice(i, i + BATCH_SIZE);
        const promises = batch.map(product => {
          const { id: productApiId, field: idField } = getProductIdForApi(product);
          return fetch(`${API_URL}/api/supplier-sync/products/bulk-update-unified`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              product_ids: [productApiId],
              id_field: idField,
              updates: { [backendKey]: value },
              mode: 'replace'
            })
          }).then(res => res.ok ? (successCount++, true) : (failCount++, false))
            .catch(() => (failCount++, false));
        });
        await Promise.all(promises);
      }
      
      if (successCount > 0) {
        toast.success(`${backendKey.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())} saved to ${successCount} products`);
        const freshProducts = await fetchProducts();
        if (freshProducts) refreshBreakdownsAfterSave(freshProducts);
      }
      if (failCount > 0) toast.error(`${failCount} products failed`);
      return;
    }
    
    // Handle category saves differently
    if (attrType === 'cat') {
      const catSlug = attrKey.replace('cat_', '');
      const isSelected = bulkCategorySelections[attrKey];
      if (!isSelected) {
        toast.error('Category not selected');
        return;
      }
      
      // Find which group this category belongs to
      const catName = catSlug.replace(/-/g, ' ');
      
      // Build per-product payloads with this category as sub_category
      const selectedSkusList = Array.from(selectedProducts);
      let productsToUpdate = products.filter(p => selectedSkusList.includes(getProductKey(p)));
      if (bulkThicknessFilter !== 'all') {
        productsToUpdate = getProductsFilteredByThickness(bulkThicknessFilter);
      }
      
      let successCount = 0;
      let failCount = 0;
      const BATCH_SIZE = 10;
      
      for (let i = 0; i < productsToUpdate.length; i += BATCH_SIZE) {
        const batch = productsToUpdate.slice(i, i + BATCH_SIZE);
        const promises = batch.map(product => {
          const { id: productApiId, field: idField } = getProductIdForApi(product);
          return fetch(`${API_URL}/api/supplier-sync/products/bulk-update-unified`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              product_ids: [productApiId],
              id_field: idField,
              updates: { sub_categories: [catSlug] },
              mode: 'append'
            })
          }).then(res => res.ok ? (successCount++, true) : (failCount++, false))
            .catch(() => (failCount++, false));
        });
        await Promise.all(promises);
      }
      
      if (successCount > 0) {
        toast.success(`Category "${catName}" saved to ${successCount} products`);
        const freshProducts = await fetchProducts();
        if (freshProducts) refreshBreakdownsAfterSave(freshProducts);
      }
      if (failCount > 0) toast.error(`${failCount} products failed`);
      return;
    }
    
    const rawValue = bulkCategorySelections[attrKey];
    if (!rawValue || (Array.isArray(rawValue) && rawValue.length === 0)) {
      toast.error('No values selected to save');
      return;
    }
    
    const values = Array.isArray(rawValue) ? rawValue : [rawValue];
    const slug = attrKey.replace(/^(spec_|filter_)/, '');
    
    // Determine backend key
    const specBackendKey = slug.replace(/-/g, '_');
    const arrayFilterMapping = {
      'color': 'colors', 'colours': 'colors',
      'room': 'rooms', 'rooms': 'rooms',
      'material': 'materials', 'materials': 'materials',
      'style': 'styles', 'styles': 'styles',
      'feature': 'features', 'features': 'features'
    };
    const scalarFilterMapping = {
      'slip-rating': 'slip_rating', 'slip_rating': 'slip_rating',
      'suitability': 'suitability', 'edge': 'edge',
      'finish': 'finish', 'size': 'size', 'thickness': 'thickness',
      'country-of-origin': 'made_in', 'country_of_origin': 'made_in'
    };
    
    const isArrayFilter = attrType === 'filter' && arrayFilterMapping[slug];
    const isScalarFilter = attrType === 'filter' && scalarFilterMapping[slug];
    const backendKey = attrType === 'spec' ? specBackendKey 
                     : isArrayFilter ? arrayFilterMapping[slug] 
                     : isScalarFilter ? scalarFilterMapping[slug] 
                     : specBackendKey;
    
    // Check for per-value scopes - respect scopes when multiple values are selected
    // (user assigned different values to different products)
    const attrScope = perAttributeScopes[attrKey];
    const hasAttrScope = attrScope && attrScope.size > 0;
    
    // Per-value scopes: use when multiple values are selected (mixed assignment)
    const hasPerValueScopes = values.length > 1 && values.some(v => {
      const pvKey = `${attrKey}__${v}`;
      return perAttributeScopes[pvKey] && perAttributeScopes[pvKey].size > 0;
    });
    
    // Build per-product payloads
    const selectedSkusList = Array.from(selectedProducts);
    let productsToUpdate = products.filter(p => selectedSkusList.includes(getProductKey(p)));
    if (bulkThicknessFilter !== 'all') {
      productsToUpdate = getProductsFilteredByThickness(bulkThicknessFilter);
    }
    
    if (productsToUpdate.length === 0) {
      toast.error('No products to update');
      return;
    }
    
    let successCount = 0;
    let failCount = 0;
    const BATCH_SIZE = 10;
    
    for (let i = 0; i < productsToUpdate.length; i += BATCH_SIZE) {
      const batch = productsToUpdate.slice(i, i + BATCH_SIZE);
      const promises = batch.map(product => {
        const productKey = getProductKey(product);
        const { id: productApiId, field: idField } = getProductIdForApi(product);
        let productPayload = {};
        
        if (isArrayFilter) {
          // Array filter: apply all values to the product
          if (hasPerValueScopes) {
            // Multiple values with scopes: filter to values scoped to this product
            // First, collect all products that ARE explicitly scoped to any value
            const allScopedProducts = new Set();
            values.forEach(v => {
              const pvKey = `${attrKey}__${v}`;
              const pvScope = perAttributeScopes[pvKey];
              if (pvScope && pvScope.size > 0) {
                pvScope.forEach(pk => allScopedProducts.add(pk));
              }
            });
            
            const scopedVals = values.filter(v => {
              const pvKey = `${attrKey}__${v}`;
              const pvScope = perAttributeScopes[pvKey];
              if (pvScope && pvScope.size > 0) {
                // This value has an explicit scope — only apply if product is in it
                return pvScope.has(productKey);
              }
              // This value has NO scope — apply only to products not covered by any scope
              return !allScopedProducts.has(productKey);
            });
            if (scopedVals.length > 0) productPayload[backendKey] = scopedVals;
          } else if (hasAttrScope) {
            if (attrScope.has(productKey)) {
              productPayload[backendKey] = values;
            }
          } else {
            productPayload[backendKey] = values;
          }
        } else {
          // Scalar (spec or scalar filter)
          if (hasPerValueScopes) {
            // Multiple values with scopes: find which value is assigned to this product
            // First, collect all explicitly scoped product keys
            const allScopedProducts = new Set();
            values.forEach(v => {
              const pvKey = `${attrKey}__${v}`;
              const pvScope = perAttributeScopes[pvKey];
              if (pvScope && pvScope.size > 0) {
                pvScope.forEach(pk => allScopedProducts.add(pk));
              }
            });
            
            let matched = values.find(v => {
              const pvKey = `${attrKey}__${v}`;
              const pvScope = perAttributeScopes[pvKey];
              return pvScope && pvScope.size > 0 && pvScope.has(productKey);
            });
            // If no explicit scope matched, apply unscoped value only to unscoped products
            if (!matched && !allScopedProducts.has(productKey)) {
              matched = values.find(v => {
                const pvKey = `${attrKey}__${v}`;
                const pvScope = perAttributeScopes[pvKey];
                return !pvScope || pvScope.size === 0;
              });
            }
            if (matched) productPayload[backendKey] = matched;
          } else if (hasAttrScope) {
            if (attrScope.has(productKey)) {
              productPayload[backendKey] = values[0];
            }
          } else {
            // Single value, no scopes: apply to ALL selected products
            productPayload[backendKey] = values[0];
          }
        }
        
        if (Object.keys(productPayload).length === 0) return Promise.resolve(true);
        
        return fetch(`${API_URL}/api/supplier-sync/products/bulk-update-unified`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            product_ids: [productApiId],
            id_field: idField,
            updates: productPayload,
            mode: bulkCategoryMode,
          })
        }).then(res => res.ok ? (successCount++, true) : (failCount++, false))
          .catch(() => (failCount++, false));
      });
      await Promise.all(promises);
    }
    
    if (successCount > 0) {
      toast.success(`${backendKey.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())} saved to ${successCount} products`);
      // Refresh products and breakdowns immediately
      const freshProducts = await fetchProducts();
      if (freshProducts) {
        refreshBreakdownsAfterSave(freshProducts);
      }
    }
    if (failCount > 0) {
      toast.error(`${failCount} products failed to save`);
    }
  }, [bulkCategorySelections, perAttributeScopes, selectedProducts, products, bulkThicknessFilter, bulkCategoryMode, fetchProducts, refreshBreakdownsAfterSave]);


  // Open bulk category modal
  const openBulkCategoryModal = () => {
    if (selectedProducts.size === 0) {
      toast.error('Please select products first');
      return;
    }
    // Options are already loaded via useProductOptions hook
    // Fetch templates if not already loaded
    if (bulkEditTemplates.length === 0) {
      fetchBulkEditTemplates();
    }
    
    // Reset size filter when opening modal
    setPricingSizeFilter('all');
    
    // Clear section-level scopes (per-attribute scopes will be reconstructed below)
    setSectionProductScopes({ categories: new Set(), filters: new Set(), specifications: new Set() });
    
    // Clear any pending field removals
    setFieldsToClear({});
    
    // Pre-populate ALL fields if all selected products have the same values
    const selectedSkusList = Array.from(selectedProducts);
    const selectedProductsList = products.filter(p => selectedSkusList.includes(getProductKey(p)));
    
    if (selectedProductsList.length > 0) {
      // Helper function to get common value from products
      const getCommonValue = (field) => {
        const values = selectedProductsList
          .map(p => p[field] || (p.attributes && p.attributes[field]))
          .filter(v => v !== null && v !== undefined && v !== '');
        const uniqueValues = [...new Set(values)];
        return uniqueValues.length === 1 ? uniqueValues[0] : '';
      };
      
      // Helper function to get value breakdown for mixed states
      // Checks top-level field, then attributes sub-doc, then specifications sub-doc
      const getValueBreakdown = (field) => {
        const values = selectedProductsList
          .map(p => {
            const v = p[field];
            if (v !== null && v !== undefined && v !== '') return v;
            if (p.attributes && p.attributes[field]) return p.attributes[field];
            if (p.specifications && typeof p.specifications === 'object' && p.specifications[field]) return p.specifications[field];
            return null;
          })
          .filter(v => v !== null && v !== undefined && v !== '');
        
        // Count occurrences of each value
        const counts = {};
        values.forEach(v => {
          if (typeof v === 'string' || typeof v === 'number') {
            counts[v] = (counts[v] || 0) + 1;
          }
        });
        
        return counts;
      };
      
      // Compute and store breakdowns using the shared function
      computeFieldBreakdowns(selectedProductsList);
      
      // Clear last save result when reopening
      setLastSaveResult(null);
      setSaveProgress(null);
      setVerificationResult(null);
      
      // Check for unsaved draft from a previous session
      checkForDraft();
      
      // Helper function to get common array values (for multi-select fields)
      const getCommonArrayValues = (field) => {
        const allArrays = selectedProductsList.map(p => p[field] || []);
        if (allArrays.length === 0) return [];
        
        // If all products have the same array, return it
        const firstArray = JSON.stringify(allArrays[0].sort());
        const allSame = allArrays.every(arr => JSON.stringify(arr.sort()) === firstArray);
        if (allSame && allArrays[0].length > 0) {
          return [...allArrays[0]];
        }
        
        // Otherwise, return intersection (values common to ALL products)
        if (allArrays[0].length === 0) return [];
        return allArrays[0].filter(val => 
          allArrays.every(arr => arr.includes(val))
        );
      };
      
      // Helper to normalize array values - convert labels to IDs
      // Database might store "Bathroom" but UI uses "bathroom" as option.id
      const normalizeArrayToIds = (values, optionsArray) => {
        if (!values || !Array.isArray(values)) return [];
        if (!optionsArray) return values;
        
        return values.map(val => {
          // Check if the value matches an option id directly
          const directMatch = optionsArray.find(opt => opt.id === val);
          if (directMatch) return val;
          
          // Check if it matches a label (case-insensitive)
          const labelMatch = optionsArray.find(opt => 
            opt.label?.toLowerCase() === val?.toLowerCase()
          );
          if (labelMatch) return labelMatch.id;
          
          // Convert to lowercase id format as fallback
          return val?.toLowerCase().replace(/\s+/g, '_');
        }).filter(Boolean);
      };
      
      // Pre-populate pricing
      const costPrices = selectedProductsList
        .map(p => p.cost_price)
        .filter(price => price !== null && price !== undefined && price !== '');
      const uniqueCostPrices = [...new Set(costPrices.map(p => parseFloat(p).toFixed(2)))];
      
      const listPrices = selectedProductsList
        .map(p => p.list_price || p.price || p.room_lot_price)
        .filter(price => price !== null && price !== undefined && price !== '');
      const uniqueListPrices = [...new Set(listPrices.map(p => parseFloat(p).toFixed(2)))];
      
      // Pre-populate show_on_website
      const showOnWebsiteValues = selectedProductsList.map(p => p.show_on_website);
      const allShowOnWebsite = showOnWebsiteValues.every(v => v === true);
      const allHideFromWebsite = showOnWebsiteValues.every(v => v === false || v === undefined);
      
      // Pre-populate all fields
      const baseSelections = {
        // Specifications (single-select) - these use labels directly
        material: getCommonValue('material'),
        finish: getCommonValue('finish'),
        type: getCommonValue('type'),
        edge: getCommonValue('edge'),
        slip_rating: getCommonValue('slip_rating'),
        suitability: getCommonValue('suitability'),
        thickness: getCommonValue('thickness'),
        underfloor_heating: getCommonValue('underfloor_heating'),
        // Main Category & Sub-Categories - these use labels directly
        main_category: getCommonValue('main_category'),
        sub_categories: getCommonArrayValues('sub_categories'),
        // Pricing
        cost_price: uniqueCostPrices.length === 1 ? uniqueCostPrices[0] : '',
        list_price: uniqueListPrices.length === 1 ? uniqueListPrices[0] : '',
        // Country of Origin — NOT pre-filled to avoid accidental re-saves
        // The "Currently saved" tags show what's stored. User must explicitly select to change.
        made_in: '',
        // Website Categories (multi-select) - normalize labels to IDs for these
        rooms: normalizeArrayToIds(getCommonArrayValues('rooms'), productOptions.rooms),
        styles: normalizeArrayToIds(getCommonArrayValues('styles'), productOptions.styles),
        colors: normalizeArrayToIds(getCommonArrayValues('colors'), productOptions.colors),
        features: normalizeArrayToIds(getCommonArrayValues('features'), productOptions.features)
      };
      
      // Pre-populate category checkboxes (cat_*) from sub_categories
      // IMPORTANT: Use actual API slugs from categoryGroupsWithCats instead of computing from names
      // This fixes "Wall & Floor" where name→slug gives "wall-floor" but API slug is "wall-and-floor"
      const commonSubCats = getCommonArrayValues('sub_categories');
      if (commonSubCats && commonSubCats.length > 0) {
        commonSubCats.forEach(catName => {
          if (catName) {
            // Look up the actual API slug from categoryGroupsWithCats (case-insensitive)
            let foundSlug = null;
            for (const group of categoryGroupsWithCats) {
              const cat = (group.categories || []).find(c => 
                c.name === catName || c.name?.toLowerCase() === catName?.toLowerCase()
              );
              if (cat) {
                foundSlug = cat.slug;
                break;
              }
            }
            if (foundSlug) {
              baseSelections[`cat_${foundSlug}`] = true;
            } else {
              // Fallback: compute slug (handles categories not yet in API)
              const catKey = `cat_${catName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '')}`;
              baseSelections[catKey] = true;
            }
          }
        });
      }
      
      // Also check main_category and add it as a cat_ key
      const mainCat = getCommonValue('main_category');
      if (mainCat) {
        // Look up actual API slug first (case-insensitive)
        let foundSlug = null;
        for (const group of categoryGroupsWithCats) {
          const cat = (group.categories || []).find(c => 
            c.name === mainCat || c.name?.toLowerCase() === mainCat?.toLowerCase()
          );
          if (cat) {
            foundSlug = cat.slug;
            break;
          }
        }
        if (foundSlug) {
          baseSelections[`cat_${foundSlug}`] = true;
        } else {
          const mainCatKey = `cat_${mainCat.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '')}`;
          baseSelections[mainCatKey] = true;
        }
      }
      
      // Pre-populate filter_* keys from colors, rooms, styles, features, materials
      // Keys MUST match API filter slugs: color, room, style, features, material
      const commonColors = getCommonArrayValues('colors');
      if (commonColors && commonColors.length > 0) {
        baseSelections['filter_color'] = commonColors.map(c => c.toLowerCase());
      }
      
      const commonRooms = getCommonArrayValues('rooms');
      if (commonRooms && commonRooms.length > 0) {
        baseSelections['filter_room'] = commonRooms.map(r => r.toLowerCase());
      }
      
      const commonStyles = getCommonArrayValues('styles');
      if (commonStyles && commonStyles.length > 0) {
        baseSelections['filter_style'] = commonStyles.map(s => s.toLowerCase());
      }
      
      const commonFeatures = getCommonArrayValues('features');
      if (commonFeatures && commonFeatures.length > 0) {
        baseSelections['filter_features'] = commonFeatures.map(f => f.toLowerCase());
      }
      
      // Pre-populate materials array AND filter_material
      const commonMaterials = getCommonArrayValues('materials');
      if (commonMaterials && commonMaterials.length > 0) {
        baseSelections.materials = commonMaterials;
        baseSelections['filter_material'] = commonMaterials.map(m => m.toLowerCase());
      }
      
      // Pre-populate spec_* keys from ALL specification fields on products
      // Dynamically detect spec fields instead of hardcoded list
      const allSpecFields = new Set();
      selectedProductsList.forEach(p => {
        // Check common spec field names
        ['material', 'finish', 'edge', 'slip_rating', 'suitability', 'thickness', 'type',
         'color', 'size', 'pot_life', 'adhesive', 'origin', 'made_in'].forEach(f => {
          if (p[f]) allSpecFields.add(f);
        });
        // Also check attributes sub-document
        if (p.attributes) {
          Object.keys(p.attributes).forEach(f => allSpecFields.add(f));
        }
      });
      allSpecFields.forEach(field => {
        const value = getCommonValue(field);
        if (value) {
          // Set both underscore and dash versions to match any API slug format
          const specKey = `spec_${field}`;
          baseSelections[specKey] = value;
          // Also set dash version (e.g., spec_pot-life) for API slugs that use dashes
          if (field.includes('_')) {
            baseSelections[`spec_${field.replace(/_/g, '-')}`] = value;
          }
        }
      });
      
      setBulkCategorySelections(baseSelections);
      
      // === RECONSTRUCT PER-ATTRIBUTE SCOPES FROM PRODUCT DATA ===
      // When re-opening the editor, rebuild scope info for attributes that aren't on ALL products
      const reconstructedScopes = {};
      const totalCount = selectedProductsList.length;
      
      // --- Categories: Detect which products have which sub_categories ---
      const allSubCats = new Set();
      selectedProductsList.forEach(p => {
        (p.sub_categories || []).forEach(cat => allSubCats.add(cat));
      });
      allSubCats.forEach(catName => {
        // Find products that have this category
        const productsWithCat = selectedProductsList.filter(p => 
          (p.sub_categories || []).includes(catName)
        );
        if (productsWithCat.length > 0 && productsWithCat.length < totalCount) {
          // Not ALL products have it — create a scope
          let catSlug = null;
          for (const group of categoryGroupsWithCats) {
            // Case-insensitive name lookup to handle legacy data variations
            const cat = (group.categories || []).find(c => 
              c.name === catName || c.name?.toLowerCase() === catName?.toLowerCase()
            );
            if (cat) { catSlug = cat.slug; break; }
          }
          if (!catSlug) {
            catSlug = catName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
          }
          const catKey = `cat_${catSlug}`;
          // Pre-select this category
          baseSelections[catKey] = true;
          // Set scope to only the products that have it
          reconstructedScopes[catKey] = new Set(
            productsWithCat.map(p => getProductKey(p))
          );
        }
      });
      
      // --- Filters: Detect per-value scopes for multi-select fields ---
      const filterFieldMap = {
        'colors': 'color', 'rooms': 'room', 'styles': 'style',
        'features': 'features', 'materials': 'material'
      };
      for (const [productField, filterSlug] of Object.entries(filterFieldMap)) {
        const allValues = new Set();
        selectedProductsList.forEach(p => {
          (p[productField] || []).forEach(v => allValues.add(v));
        });
        const filterKey = `filter_${filterSlug}`;
        const allSelectedValues = [];
        allValues.forEach(val => {
          const productsWithVal = selectedProductsList.filter(p =>
            (p[productField] || []).includes(val)
          );
          allSelectedValues.push(val.toLowerCase());
          if (productsWithVal.length > 0 && productsWithVal.length < totalCount) {
            const pvKey = `filter_${filterSlug}__${val.toLowerCase()}`;
            reconstructedScopes[pvKey] = new Set(
              productsWithVal.map(p => getProductKey(p))
            );
          }
        });
        if (allSelectedValues.length > 0) {
          baseSelections[filterKey] = allSelectedValues;
        }
      }
      
      // --- Specs: Detect per-value scopes for single-value fields ---
      const specFields = ['material', 'finish', 'edge', 'slip_rating', 'suitability', 
                          'thickness', 'type', 'made_in'];
      specFields.forEach(field => {
        const valueCounts = {};
        selectedProductsList.forEach(p => {
          const val = p[field] || (p.attributes && p.attributes[field]);
          if (val) {
            if (!valueCounts[val]) valueCounts[val] = [];
            valueCounts[val].push(getProductKey(p));
          }
        });
        const uniqueValues = Object.keys(valueCounts);
        if (uniqueValues.length > 1) {
          // Multiple different values exist — create per-value scopes
          const specKey = `spec_${field}`;
          baseSelections[specKey] = uniqueValues; // Multi-select array
          uniqueValues.forEach(val => {
            const pvKey = `spec_${field}__${val}`;
            reconstructedScopes[pvKey] = new Set(valueCounts[val]);
          });
          // Also set dash version
          if (field.includes('_')) {
            baseSelections[`spec_${field.replace(/_/g, '-')}`] = uniqueValues;
          }
        }
      });
      
      // --- Also check filter fields stored directly on products (suitability, thickness, etc.) ---
      const directFilterFields = { 'suitability': 'suitability', 'thickness': 'thickness', 'slip_rating': 'slip-rating' };
      for (const [productField, filterSlug] of Object.entries(directFilterFields)) {
        const allValues = new Set();
        selectedProductsList.forEach(p => {
          const val = p[productField] || (p.attributes && p.attributes[productField]);
          if (val) allValues.add(val);
        });
        if (allValues.size > 0) {
          const filterKey = `filter_${filterSlug}`;
          if (!baseSelections[filterKey] || baseSelections[filterKey].length === 0) {
            // Lowercase values to match filter API value IDs
            baseSelections[filterKey] = [...allValues].map(v => typeof v === 'string' ? v.toLowerCase() : v);
          }
          allValues.forEach(val => {
            const productsWithVal = selectedProductsList.filter(p => {
              const pVal = p[productField] || (p.attributes && p.attributes[productField]);
              return pVal === val;
            });
            if (productsWithVal.length > 0 && productsWithVal.length < totalCount) {
              // Lowercase scope key to match filter API value IDs
              const normalizedVal = typeof val === 'string' ? val.toLowerCase() : val;
              const pvKey = `filter_${filterSlug}__${normalizedVal}`;
              reconstructedScopes[pvKey] = new Set(
                productsWithVal.map(p => getProductKey(p))
              );
            }
          });
        }
      }
      
      // Update selections with any new entries we added
      setBulkCategorySelections(baseSelections);
      
      // Set the reconstructed scopes
      if (Object.keys(reconstructedScopes).length > 0) {
        setPerAttributeScopes(reconstructedScopes);
      } else {
        setPerAttributeScopes({});
      }
      
      // Pre-populate Description & SEO from products
      const commonDescription = getCommonValue('description');
      const commonSeoKeywords = getCommonValue('seo_keywords');
      const commonHiddenSeoKeywords = getCommonValue('hidden_seo_keywords');
      setBulkDescriptionSettings(prev => ({
        ...prev,
        description_template: commonDescription || '',
        seo_keywords: commonSeoKeywords || '',
        hidden_seo_keywords: commonHiddenSeoKeywords || ''
      }));
      
      // Pre-populate show on website checkbox
      if (allShowOnWebsite) {
        setBulkShowOnWebsite(true);
      } else if (allHideFromWebsite) {
        setBulkShowOnWebsite(false);
      } else {
        setBulkShowOnWebsite(false); // Mixed state - default to unchecked
      }
    }
    
    setShowBulkCategoryModal(true);
    
    // Load existing collection description
    setCollectionDescription('');
    setCollectionDescriptionLoaded(false);
    loadCollectionDescription();
  };

  // Fetch bulk edit templates
  const fetchBulkEditTemplates = async () => {
    try {
      const response = await fetch(`${API_URL}/api/supplier-sync/bulk-edit-templates`);
      if (response.ok) {
        const data = await response.json();
        setBulkEditTemplates(data.templates || []);
      }
    } catch (error) {
      console.error('Error fetching templates:', error);
    }
  };

  // Save current selections as a template
  const handleSaveTemplate = async () => {
    if (!newTemplateName.trim()) {
      toast.error('Please enter a template name');
      return;
    }

    setSavingTemplate(true);
    try {
      const templateData = {
        name: newTemplateName.trim(),
        selections: bulkCategorySelections,
        show_on_website: bulkShowOnWebsite
      };

      const response = await fetch(`${API_URL}/api/supplier-sync/bulk-edit-templates`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(templateData)
      });

      if (response.ok) {
        const data = await response.json();
        toast.success(`Template "${newTemplateName}" saved!`);
        setBulkEditTemplates(prev => [...prev, data.template]);
        setShowSaveTemplateModal(false);
        setNewTemplateName('');
      } else {
        const error = await response.json();
        toast.error(error.detail || 'Failed to save template');
      }
    } catch (error) {
      console.error('Error saving template:', error);
      toast.error('Failed to save template');
    } finally {
      setSavingTemplate(false);
    }
  };

  // Apply a template to current selections
  const applyTemplate = (template) => {
    setBulkCategorySelections(template.selections);
    setBulkShowOnWebsite(template.show_on_website || false);
    toast.success(`Applied template: ${template.name}`);
  };

  // Delete a template
  const deleteTemplate = async (templateId) => {
    if (!window.confirm('Delete this template?')) return;
    
    try {
      const response = await fetch(`${API_URL}/api/supplier-sync/bulk-edit-templates/${templateId}`, {
        method: 'DELETE'
      });

      if (response.ok) {
        setBulkEditTemplates(prev => prev.filter(t => t.id !== templateId));
        toast.success('Template deleted');
      } else {
        toast.error('Failed to delete template');
      }
    } catch (error) {
      console.error('Error deleting template:', error);
      toast.error('Failed to delete template');
    }
  };

  // Fetch categories for bulk edit
  const fetchCategories = async () => {
    try {
      // Use the same endpoint as ManageCategories for consistency
      const response = await fetch(`${process.env.REACT_APP_BACKEND_URL}/api/supplier-sync/categories/detailed`);
      if (response.ok) {
        const data = await response.json();
        // API returns { success: true, categories: [...] }
        const categoriesData = data.categories || data;
        // Transform to match expected format
        const formattedCategories = categoriesData.map(cat => ({
          id: cat.name,
          name: cat.name,
          description: cat.description || ''
        }));
        setCategories(formattedCategories);
      } else {
        // Fallback to old endpoint
        const res = await api.getCategories();
        setCategories(res.data || []);
      }
    } catch (error) {
      console.error('Error fetching categories:', error);
      // Fallback
      try {
        const res = await api.getCategories();
        setCategories(res.data || []);
      } catch (e) {
        console.error('Fallback also failed:', e);
      }
    }
  };

  // Open bulk edit modal
  const openBulkEditModal = () => {
    if (selectedProducts.size === 0) {
      toast.error('Please select products first');
      return;
    }
    setBulkEditForm({
      price: '',
      cost_price: '',
      stock: '',
      reorder_level: '',
      markup_percentage: '',
      is_active: '',
      is_featured: '',
      clearance: ''
    });
    if (categories.length === 0) {
      fetchCategories();
    }
    setShowBulkEditModal(true);
  };

  // Handle bulk edit submit
  const handleBulkEdit = async () => {
    if (selectedProducts.size === 0) {
      toast.error('No products selected');
      return;
    }

    setBulkEditLoading(true);
    try {
      const updateData = {
        product_ids: Array.from(selectedProducts)
      };

      // Add only non-empty fields
      if (bulkEditForm.price) updateData.price = parseFloat(bulkEditForm.price);
      if (bulkEditForm.cost_price) updateData.cost_price = parseFloat(bulkEditForm.cost_price);
      if (bulkEditForm.stock) updateData.stock = parseInt(bulkEditForm.stock);
      if (bulkEditForm.reorder_level) updateData.reorder_level = parseInt(bulkEditForm.reorder_level);
      if (bulkEditForm.markup_percentage) updateData.markup_percentage = parseFloat(bulkEditForm.markup_percentage);
      if (bulkEditForm.is_active !== '') updateData.is_active = bulkEditForm.is_active === 'true';
      if (bulkEditForm.is_featured !== '') updateData.is_featured = bulkEditForm.is_featured === 'true';
      if (bulkEditForm.clearance !== '') updateData.clearance = bulkEditForm.clearance === 'true';

      const response = await api.bulkUpdateProducts(updateData);
      
      toast.success(`Updated ${response.data.updated_count} products`);
      if (response.data.error_count > 0) {
        toast.warning(`${response.data.error_count} products failed to update`);
      }
      
      setShowBulkEditModal(false);
      setSelectedProducts(new Set());
      fetchProducts();
    } catch (error) {
      toast.error('Failed to bulk update products');
      console.error(error);
    } finally {
      setBulkEditLoading(false);
    }
  };

  // Bulk Assign Category — sets `product_group` on all selected products so they
  // route into the correct Manager on next edit. Also backfills `main_category`
  // when blank, and sets `pricing_unit=unit` for materials so tier pricing labels
  // render correctly.
  const handleBulkAssignCategory = async (productGroup) => {
    if (selectedProducts.size === 0) {
      toast.error('No products selected');
      return;
    }
    const label = {
      tiles: 'Tiles', materials: 'Materials', flooring: 'Flooring',
      bathroom: 'Bathroom', underfloor_heating: 'Underfloor Heating', tools: 'Tools & Accessories',
    }[productGroup] || productGroup;
    if (!window.confirm(`Assign ${selectedProducts.size} product(s) to "${label}"? They'll open in the ${label} Manager on next edit.`)) return;
    
    try {
      const productsList = products.filter(p => selectedProducts.has(getProductKey(p)));
      const bySku = productsList.filter(p => p.sku).map(p => p.sku);
      const bySupplierCode = productsList.filter(p => !p.sku && p.supplier_code).map(p => p.supplier_code);
      
      let totalUpdated = 0;
      for (const [ids, idField] of [[bySku, 'sku'], [bySupplierCode, 'supplier_code']]) {
        if (ids.length === 0) continue;
        const res = await fetch(`${API_URL}/api/supplier-sync/products/bulk-assign-category`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ product_ids: ids, id_field: idField, product_group: productGroup }),
        });
        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          throw new Error(err.detail || `HTTP ${res.status}`);
        }
        const data = await res.json();
        totalUpdated += data.modified_count || 0;
      }
      toast.success(`Assigned ${totalUpdated} product(s) to ${label}`);
      fetchProducts();
    } catch (err) {
      console.error('Bulk assign category failed', err);
      toast.error(`Assign failed: ${err.message}`);
    }
  };
  
  const runBackfillProductGroup = async ({ dryRun = true } = {}) => {
    setBackfillRunning(true);
    try {
      const res = await fetch(`${API_URL}/api/supplier-sync/products/backfill-product-group`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dry_run: dryRun }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setBackfillPreview(data);
      if (!dryRun) {
        toast.success(`Classified ${data.applied} products. ${data.counts.unclassified} left for manual review.`);
        fetchProducts();
      } else {
        toast.info(data.message || 'Preview ready — click Apply to write.');
      }
    } catch (err) {
      console.error('Backfill failed', err);
      toast.error(`Backfill failed: ${err.message}`);
    } finally {
      setBackfillRunning(false);
    }
  };


  // Bulk Set Series — writes the same range_name to every ticked product.
  // Uses the shared /api/admin/series/bulk-assign endpoint so it survives
  // future backend renames.
  const handleBulkSetSeries = async () => {
    if (selectedProducts.size === 0) { toast.error('No products selected'); return; }
    const seriesName = window.prompt(`Assign a Series / Collection name to ${selectedProducts.size} product(s):`);
    if (!seriesName || !seriesName.trim()) return;
    try {
      const items = Array.from(selectedProducts).map((key) => {
        const sku = key.includes('|||') ? key.split('|||')[1] : key;
        return { sku, series: seriesName.trim() };
      }).filter((it) => it.sku);
      const token = localStorage.getItem('token');
      const res = await fetch(`${process.env.REACT_APP_BACKEND_URL}/api/admin/series/bulk-assign`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ items, supplier: selectedSupplier !== 'all' ? selectedSupplier : null }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      toast.success(`Set series "${seriesName.trim()}" on ${data.updated} product${data.updated === 1 ? '' : 's'}${data.failed?.length ? ` (${data.failed.length} skipped)` : ''}`);
      fetchProducts();
      fetchStats();
    } catch (err) {
      toast.error(`Failed to set series: ${err.message}`);
    }
  };


  // Handle bulk archive (set inactive)
  const handleBulkArchive = async () => {
    if (selectedProducts.size === 0) {
      toast.error('No products selected');
      return;
    }

    if (!window.confirm(`Are you sure you want to archive ${selectedProducts.size} product(s)? They will be set to inactive.`)) {
      return;
    }
    try {
      const response = await api.bulkUpdateProducts({
        product_ids: Array.from(selectedProducts),
        is_active: false
      });
      toast.success(`Archived ${response.data.updated_count} products`);
      setSelectedProducts(new Set());
      fetchProducts();
    } catch (error) {
      toast.error('Failed to archive products');
      console.error(error);
    }
  };

  // Handle bulk rename series - add characteristics to selected products
  const handleBulkRenameSeries = async () => {
    if (selectedProducts.size === 0) {
      toast.error('No products selected');
      return;
    }

    // Check if any changes are made
    const hasWordReplacements = bulkRenameForm.wordReplacements && 
      bulkRenameForm.wordReplacements.some(r => r.from && r.to !== undefined);
    
    const hasSupplierNameReplacements = bulkRenameForm.supplierNameReplacements && 
      bulkRenameForm.supplierNameReplacements.some(r => r.from && r.to !== undefined);
    
    const hasWordsToDelete = bulkRenameForm.wordsToDelete && bulkRenameForm.wordsToDelete.length > 0;
    
    if (!bulkRenameForm.newSeriesName.trim() && !bulkRenameForm.insertText.trim() && !bulkRenameForm.addCmToSize && !hasWordReplacements && !hasSupplierNameReplacements && !hasWordsToDelete) {
      toast.error('Please make at least one change');
      return;
    }

    setBulkRenameLoading(true);
    try {
      // Extract SKUs/identifiers from selected products
      const selectedKeys = Array.from(selectedProducts);
      const selectedProds = products.filter(p => selectedKeys.includes(getProductKey(p)));
      const skus = selectedProds.map(p => p.sku || p.supplier_code || p._id).filter(Boolean);
      const response = await fetch(`${API_URL}/api/supplier-sync/products/bulk-rename-series`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${localStorage.getItem('token')}`
        },
        body: JSON.stringify({
          skus: skus,
          current_series_name: bulkRenameForm.currentSeriesName,
          new_series_name: bulkRenameForm.newSeriesName.trim(),
          insert_text: bulkRenameForm.insertText.trim(),
          insert_position: bulkRenameForm.insertPosition,
          custom_insert_index: bulkRenameForm.customInsertIndex,
          add_cm_to_size: bulkRenameForm.addCmToSize,
          word_replacements: bulkRenameForm.wordReplacements.filter(r => r.from && r.to !== undefined),
          words_to_delete: bulkRenameForm.wordsToDelete || [],
          supplier: selectedSupplier !== 'all' ? selectedSupplier : null,
          supplier_name_replacements: bulkRenameForm.supplierNameReplacements?.filter(r => r.from && r.to !== undefined) || []
        })
      });

      if (response.ok) {
        const result = await response.json();
        toast.success(`Updated ${result.updated_count || skus.length} products${result.custom_mappings_created ? ` (${result.custom_mappings_created} custom mappings saved)` : ''}`);
        setShowBulkRenameModal(false);
        setBulkRenameForm({ currentSeriesName: '', newSeriesName: '', insertText: '', insertPosition: 'after_series', customInsertIndex: 1, addCmToSize: false, previewProducts: [], wordReplacements: [], supplierProductName: '', currentSupplierProductName: '', supplierNameReplacements: [], wordsToDelete: [] });
        setSelectedProducts(new Set());
        fetchProducts();
      } else {
        // Show specific error based on status code
        if (response.status === 401) {
          toast.error('Session expired - please login again');
        } else if (response.status === 403) {
          toast.error('You don\'t have permission for this action');
        } else if (response.status === 500) {
          toast.error('Server error - please try again');
        } else {
          const errorData = await response.json().catch(() => ({}));
          toast.error(errorData.detail || 'Failed to update products');
        }
      }
    } catch (error) {
      console.error('Advanced rename error:', error);
      toast.error('Network error - please check your connection');
    } finally {
      setBulkRenameLoading(false);
    }
  };

  // Generate preview of name changes
  const generateRenamePreview = (newSeries, insertText, insertPosition, customIndex, addCm) => {
    const selectedSkusList = Array.from(selectedProducts);
    const selectedProductsList = products.filter(p => selectedSkusList.includes(p.sku));
    
    return selectedProductsList.slice(0, 5).map(p => {
      const currentName = p.product_name || p.name || '';
      const seriesName = bulkRenameForm.currentSeriesName;
      
      let newName = currentName;
      
      // Replace series name if new one provided
      if (newSeries && seriesName) {
        const regex = new RegExp(`^${seriesName}\\s+`, 'i');
        newName = newName.replace(regex, `${newSeries} `);
      }
      
      // Insert text at specified position
      const effectiveSeriesName = newSeries || seriesName;
      if (insertText) {
        const words = newName.split(/\s+/);
        
        switch (insertPosition) {
          case 'after_series':
            // Insert after series name (first word)
            if (effectiveSeriesName && words.length > 0) {
              words.splice(1, 0, insertText);
            }
            break;
          case 'before_size':
            // Find size pattern (NNxNN or NNNxNNN or NN.NxNN.N) and insert before it
            const sizeIdx = words.findIndex(w => /^\d+(\.\d+)?[xX]\d+/.test(w));
            if (sizeIdx > 0) {
              words.splice(sizeIdx, 0, insertText);
            } else if (words.length > 1) {
              // No size found, insert after first word
              words.splice(1, 0, insertText);
            }
            break;
          case 'before_color':
            // Find first color word and insert before it
            const colorWords = ['White', 'Black', 'Grey', 'Gray', 'Cream', 'Beige', 'Brown', 'Silver', 'Gold', 'Blue', 'Green', 'Red', 'Pink', 'Ivory', 'Sand', 'Charcoal', 'Anthracite', 'Taupe', 'Oak', 'Walnut', 'Pearl', 'Onyx', 'Honey', 'Copper', 'Bronze', 'Rust', 'Sage', 'Teal', 'Navy', 'Midnight', 'Slate', 'Latte', 'Mocha', 'Espresso', 'Caramel', 'Amber', 'Cobalt', 'Blu', 'Bianco', 'Nero', 'Grigio', 'Avorio', 'Noce', 'Grafite'];
            const colorIdx = words.findIndex(w => colorWords.some(c => w.toLowerCase() === c.toLowerCase()));
            if (colorIdx > 0) {
              words.splice(colorIdx, 0, insertText);
            } else if (words.length > 1) {
              words.splice(1, 0, insertText);
            }
            break;
          case 'at_start':
            words.unshift(insertText);
            break;
          case 'at_end':
            words.push(insertText);
            break;
          case 'custom':
            // Insert at specific position (1-based for user, 0-based internally)
            const idx = Math.min(Math.max(0, customIndex), words.length);
            words.splice(idx, 0, insertText);
            break;
          default:
            // Default to after series
            if (words.length > 0) {
              words.splice(1, 0, insertText);
            }
        }
        newName = words.join(' ');
      }
      
      // Add cm to sizes (e.g., 30x60 → 30x60cm)
      // Note: (?![0-9cm]) ensures we don't match partial numbers (e.g., 30x6 in 30x60cm)
      if (addCm) {
        newName = newName.replace(/(\d+(?:\.\d+)?)[xX](\d+(?:\.\d+)?)(?![0-9cm])/g, '$1x$2cm');
      }
      
      // Delete words marked for deletion
      if (bulkRenameForm.wordsToDelete?.length > 0) {
        const wordsToDeleteLower = bulkRenameForm.wordsToDelete.map(w => w.toLowerCase());
        const nameWords = newName.split(/\s+/);
        const filteredWords = nameWords.filter(word => !wordsToDeleteLower.includes(word.toLowerCase()));
        newName = filteredWords.join(' ');
      }
      
      return { sku: p.sku, current: currentName, new: newName };
    });
  };

  // Open bulk rename modal with detected series name
  const openBulkRenameModal = () => {
    const selectedSkusList = Array.from(selectedProducts);
    const selectedProductsList = products.filter(p => selectedSkusList.includes(getProductKey(p)));
    
    if (selectedProductsList.length > 0) {
      const firstName = selectedProductsList[0].our_product_name || selectedProductsList[0].product_name || selectedProductsList[0].name || '';
      const detectedSeries = getSeriesName(firstName) || firstName.split(' ')[0];
      const currentSupplierName = selectedProductsList[0].supplier_product_name || selectedProductsList[0].name || '';
      
      // Auto-fill template series name with detected series
      setTemplateForm(prev => ({
        ...prev,
        seriesName: detectedSeries,
      }));
      
      setBulkRenameForm({ 
        currentSeriesName: detectedSeries, 
        newSeriesName: '',
        insertText: '',
        insertPosition: 'after_series',
        customInsertIndex: 1,
        addCmToSize: false,
        previewProducts: [],
        wordReplacements: [],
        supplierProductName: '',
        currentSupplierProductName: currentSupplierName,
        supplierNameReplacements: []
      });
    }
    
    setSelectedPreviewProductIndex(0); // Reset to first product when opening modal
    setShowBulkRenameModal(true);
  };

  useEffect(() => {
    fetchProducts();
    fetchStats();
    fetchTierPricingConfig();
    fetchCategoryGroups();
  }, [fetchProducts]);

  // Reset page when filter changes
  useEffect(() => {
    setCurrentPage(1);
  }, [selectedSupplier, searchTerm, seriesFilter]);

  // Handle supplier tab click
  const handleSupplierChange = (supplierId) => {
    setSelectedSupplier(supplierId);
    setSeriesFilter(''); // Reset series filter when supplier changes
    // Update URL to persist the selected supplier
    if (supplierId === 'all') {
      searchParams.delete('supplier');
    } else {
      searchParams.set('supplier', supplierId);
    }
    setSearchParams(searchParams, { replace: true });
  };

  // Export to Excel (clean layout)
  const exportToExcel = async () => {
    try {
      toast.info('Preparing export...');
      
      // Fetch all products for selected supplier
      let url = `${API_URL}/api/supplier-sync/products?limit=10000`;
      if (selectedSupplier !== 'all') {
        url += `&supplier=${encodeURIComponent(selectedSupplier)}`;
      }
      if (searchTerm) {
        url += `&search=${encodeURIComponent(searchTerm)}`;
      }

      const response = await fetch(url);
      const data = await response.json();
      const productsToExport = data.products || [];

      if (productsToExport.length === 0) {
        toast.error('No products to export');
        return;
      }

      // Create clean Excel-compatible CSV with proper formatting
      const headers = [
        'Supplier',
        'Product Code',
        'Supplier Product Name',
        'Our Product Name',
        'Description',
        'Category',
        'Material',
        'Finish',
        'Color',
        'Size',
        'Cost (£)',
        'Trade Price (£)',
        'Pallet Price (£)',
        'Stock Quantity',
        'Stock (m²)',
        'In Stock',
        'Last Updated'
      ];

      const rows = productsToExport.map(p => [
        p.supplier || '',
        p.sku || '',
        p.name || '',  // Original supplier name
        p.product_name || '',  // Our unique name
        p.description || '',
        p.category || '',
        p.material || '',
        p.finish || '',
        p.color || '',
        p.size || (p.length_mm && p.width_mm ? `${p.length_mm}x${p.width_mm}mm` : ''),
        p.cost ? Number(p.cost).toFixed(2) : '',
        p.price ? Number(p.price).toFixed(2) : '',
        p.pallet_price ? Number(p.pallet_price).toFixed(2) : '',
        p.stock_quantity || '',
        p.stock_m2 || '',
        p.in_stock === true ? 'Yes' : p.in_stock === false ? 'No' : '',
        p.synced_at ? new Date(p.synced_at).toLocaleDateString('en-GB') : ''
      ]);

      // Convert to CSV with proper escaping
      const csvContent = [
        headers.join(','),
        ...rows.map(row => 
          row.map(cell => {
            const str = String(cell);
            // Escape quotes and wrap in quotes if contains comma or quote
            if (str.includes(',') || str.includes('"') || str.includes('\n')) {
              return `"${str.replace(/"/g, '""')}"`;
            }
            return str;
          }).join(',')
        )
      ].join('\n');

      // Add BOM for Excel to recognize UTF-8
      const BOM = '\uFEFF';
      const blob = new Blob([BOM + csvContent], { type: 'text/csv;charset=utf-8;' });
      const downloadUrl = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = downloadUrl;
      
      const supplierName = selectedSupplier === 'all' ? 'All-Suppliers' : selectedSupplier;
      link.download = `${supplierName}-Products-${new Date().toISOString().slice(0, 10)}.csv`;
      link.click();
      URL.revokeObjectURL(downloadUrl);

      toast.success(`Exported ${productsToExport.length} products`);
    } catch (error) {
      console.error('Export error:', error);
      toast.error('Failed to export products');
    }
  };

  // Export to PDF
  const exportToPDF = async () => {
    try {
      toast.info('Generating PDF...');
      
      // Fetch all products for selected supplier
      let url = `${API_URL}/api/supplier-sync/products?limit=10000`;
      if (selectedSupplier !== 'all') {
        url += `&supplier=${encodeURIComponent(selectedSupplier)}`;
      }
      if (searchTerm) {
        url += `&search=${encodeURIComponent(searchTerm)}`;
      }

      const response = await fetch(url);
      const data = await response.json();
      const productsToExport = data.products || [];

      if (productsToExport.length === 0) {
        toast.error('No products to export');
        return;
      }

      // Create PDF document (landscape for more columns)
      const doc = new jsPDF('landscape', 'mm', 'a4');
      const supplierName = selectedSupplier === 'all' ? 'All Suppliers' : selectedSupplier;
      
      // Add header
      doc.setFontSize(18);
      doc.setFont('helvetica', 'bold');
      doc.text(`${supplierName} - Product List`, 14, 15);
      
      // Add metadata
      doc.setFontSize(10);
      doc.setFont('helvetica', 'normal');
      doc.setTextColor(100);
      doc.text(`Generated: ${new Date().toLocaleDateString('en-GB')} at ${new Date().toLocaleTimeString('en-GB')}`, 14, 22);
      doc.text(`Total Products: ${productsToExport.length}`, 14, 27);
      doc.setTextColor(0);

      // Prepare table data
      const tableHeaders = [
        'Code', 'Supplier Product Name', 'Our Product Name', 'Category', 'Size', 'Price (£)', 'Stock', 'Status'
      ];

      const tableData = productsToExport.map(p => [
        p.sku || '-',
        (p.name || '-').substring(0, 35) + ((p.name || '').length > 35 ? '...' : ''),
        (p.product_name || '-').substring(0, 35) + ((p.product_name || '').length > 35 ? '...' : ''),
        p.category || '-',
        p.size || (p.length_mm && p.width_mm ? `${p.length_mm}x${p.width_mm}` : '-'),
        p.price ? `£${Number(p.price).toFixed(2)}` : '-',
        p.stock_quantity || '-',
        p.in_stock === true ? 'In Stock' : p.in_stock === false ? 'Out of Stock' : '-'
      ]);

      // Generate table using autoTable
      autoTable(doc, {
        head: [tableHeaders],
        body: tableData,
        startY: 32,
        theme: 'striped',
        headStyles: {
          fillColor: [31, 41, 55],
          textColor: 255,
          fontSize: 8,
          fontStyle: 'bold'
        },
        bodyStyles: {
          fontSize: 7,
          cellPadding: 2
        },
        alternateRowStyles: {
          fillColor: [249, 250, 251]
        },
        columnStyles: {
          0: { cellWidth: 22 },  // Code
          1: { cellWidth: 55 },  // Supplier Product Name
          2: { cellWidth: 55 },  // Our Product Name
          3: { cellWidth: 30 },  // Category
          4: { cellWidth: 22 },  // Size
          5: { cellWidth: 18 },  // Price
          6: { cellWidth: 15 },  // Stock
          7: { cellWidth: 20 }   // Status
        },
        margin: { top: 32, left: 14, right: 14 },
        didDrawPage: function(data) {
          // Add page number footer
          doc.setFontSize(8);
          doc.setTextColor(150);
          doc.text(
            `Page ${data.pageNumber}`,
            doc.internal.pageSize.width / 2,
            doc.internal.pageSize.height - 10,
            { align: 'center' }
          );
          // Add Tile Station branding
          doc.text(
            'Tile Station - Supplier Products Report',
            14,
            doc.internal.pageSize.height - 10
          );
        }
      });

      // Save PDF
      const fileName = `${supplierName.replace(/\s+/g, '-')}-Products-${new Date().toISOString().slice(0, 10)}.pdf`;
      doc.save(fileName);

      toast.success(`Exported ${productsToExport.length} products to PDF`);
    } catch (error) {
      console.error('PDF Export error:', error);
      toast.error('Failed to export PDF');
    }
  };

  // Handle Excel file upload
  const handleFileUpload = async (e) => {
    const file = e.target.files[0];
    if (!file) return;

    if (!file.name.endsWith('.xlsx') && !file.name.endsWith('.xls') && !file.name.endsWith('.csv')) {
      toast.error('Please upload an Excel or CSV file');
      return;
    }

    // Determine which supplier to import to
    const supplierToImport = selectedSupplier === 'all' ? 'General' : selectedSupplier;

    setUploading(true);
    try {
      const formData = new FormData();
      formData.append('file', file);
      formData.append('supplier', supplierToImport);

      const response = await fetch(`${API_URL}/api/supplier-sync/import-excel`, {
        method: 'POST',
        body: formData
      });

      if (response.ok) {
        const result = await response.json();
        toast.success(`Imported ${result.synced || result.total} products${result.new ? ` (${result.new} new, ${result.updated} updated)` : ''}`);
        fetchProducts();
        fetchStats();
      } else {
        const error = await response.json();
        toast.error(error.detail || 'Import failed');
      }
    } catch (error) {
      console.error('Upload error:', error);
      toast.error('Failed to upload file');
    } finally {
      setUploading(false);
      e.target.value = '';
    }
  };

  // Delete product - Super Admin only
  const handleDelete = async (product) => {
    if (!isSuperAdmin) {
      toast.error('Only Super Admin can delete products');
      return;
    }
    
    if (!window.confirm(`Are you sure you want to delete "${product.name}"?`)) return;

    try {
      const identifier = product.sku || product.supplier_code;
      if (!identifier) {
        toast.error('Cannot delete: product has no SKU or supplier code');
        return;
      }
      const response = await fetch(`${API_URL}/api/supplier-sync/products/${encodeURIComponent(identifier)}?supplier=${encodeURIComponent(product.supplier)}`, {
        method: 'DELETE'
      });

      if (response.ok) {
        const result = await response.json();
        const msg = result.tiles_deleted > 0 
          ? `Product deleted (also removed from storefront)` 
          : 'Product deleted';
        toast.success(msg);
        fetchProducts();
        fetchStats();
      } else {
        const errData = await response.json().catch(() => ({}));
        toast.error(errData.detail || 'Failed to delete product');
      }
    } catch (error) {
      console.error('Delete error:', error);
      toast.error('Failed to delete product');
    }
  };

  // Bulk delete all products for selected supplier - Super Admin only
  const handleBulkDelete = async () => {
    if (!isSuperAdmin) {
      toast.error('Only Super Admin can delete products');
      return;
    }
    
    if (selectedSupplier === 'all') {
      toast.error('Please select a specific supplier to bulk delete');
      return;
    }
    
    if (bulkDeleteConfirm !== selectedSupplier) {
      toast.error(`Type "${selectedSupplier}" to confirm deletion`);
      return;
    }

    try {
      const response = await fetch(
        `${API_URL}/api/supplier-sync/products/bulk/${encodeURIComponent(selectedSupplier)}?confirm=true`,
        { method: 'DELETE' }
      );

      if (response.ok) {
        const result = await response.json();
        toast.success(result.message);
        setShowBulkDeleteDialog(false);
        setBulkDeleteConfirm('');
        fetchProducts();
        fetchStats();
      } else {
        const error = await response.json();
        toast.error(error.detail || 'Bulk delete failed');
      }
    } catch (error) {
      console.error('Bulk delete error:', error);
      toast.error('Failed to bulk delete products');
    }
  };

  // Toggle product selection
  const toggleProductSelection = (product) => {
    const key = getProductKey(product);
    const newSelection = new Set(selectedProducts);
    if (newSelection.has(key)) {
      newSelection.delete(key);
    } else {
      newSelection.add(key);
    }
    setSelectedProducts(newSelection);
  };
  
  // Toggle selection for all products in a series
  const toggleSeriesSelection = (seriesName) => {
    const seriesProducts = filteredProducts.filter(p => getSeriesName(p) === seriesName);
    const seriesKeys = seriesProducts.map(p => getProductKey(p));
    const allSelected = seriesKeys.every(key => selectedProducts.has(key));
    
    const newSelection = new Set(selectedProducts);
    if (allSelected) {
      // Deselect all in series
      seriesKeys.forEach(key => newSelection.delete(key));
    } else {
      // Select all in series
      seriesKeys.forEach(key => newSelection.add(key));
    }
    setSelectedProducts(newSelection);
  };
  
  // Check if a product is selected
  const isProductSelected = (product) => {
    return selectedProducts.has(getProductKey(product));
  };
  
  // Check if all products in a series are selected
  const isSeriesSelected = (seriesName) => {
    const seriesProducts = filteredProducts.filter(p => getSeriesName(p) === seriesName);
    if (seriesProducts.length === 0) return false;
    return seriesProducts.every(p => selectedProducts.has(getProductKey(p)));
  };
  
  // Check if some (but not all) products in a series are selected
  const isSeriesPartiallySelected = (seriesName) => {
    const seriesProducts = filteredProducts.filter(p => getSeriesName(p) === seriesName);
    if (seriesProducts.length === 0) return false;
    const selectedCount = seriesProducts.filter(p => selectedProducts.has(getProductKey(p))).length;
    return selectedCount > 0 && selectedCount < seriesProducts.length;
  };

  // Helper function to extract series name — uses the module-level `getSeriesName`
  // (defined at the top of this file). Do NOT re-declare it here or it will
  // shadow the module-level version and silently strip out the aggressive
  // junk-field filtering (bug fix, Aug 2026).

  // Get unique series with counts, sorted by count descending
  // Use allSeriesOptions from backend if available, otherwise fall back to local calculation
  const seriesOptions = React.useMemo(() => {
    // If we have series options from backend (complete list), use those
    if (allSeriesOptions && allSeriesOptions.length > 0) {
      return allSeriesOptions;
    }
    
    // Fallback: calculate from current page (incomplete but works if API fails)
    const seriesCounts = {};
    products.forEach(product => {
      const series = getSeriesName(product);
      if (series) {
        seriesCounts[series] = (seriesCounts[series] || 0) + 1;
      }
    });
    // Convert to array and sort by count descending
    return Object.entries(seriesCounts)
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count);
  }, [products, allSeriesOptions]);

  // Compute thickness options from selected products (for Bulk Category Editor)
  const bulkThicknessOptions = React.useMemo(() => {
    const selectedSkusList = Array.from(selectedProducts);
    const selectedProductsList = products.filter(p => selectedSkusList.includes(getProductKey(p)));
    const thicknessCounts = {};
    selectedProductsList.forEach(product => {
      let thickness = product.thickness;
      if (!thickness) {
        const name = product.product_name || product.name || '';
        const match = name.match(/(\d+)\s*mm/i);
        if (match) thickness = match[1] + 'mm';
      }
      if (thickness) {
        thicknessCounts[thickness] = (thicknessCounts[thickness] || 0) + 1;
      }
    });
    return Object.entries(thicknessCounts)
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => parseInt(a.name) - parseInt(b.name));
  }, [products, selectedProducts]);

  // Get selected products filtered by thickness
  const getProductsFilteredByThickness = (filter = 'all') => {
    const selectedSkusList = Array.from(selectedProducts);
    let selectedProductsList = products.filter(p => selectedSkusList.includes(getProductKey(p)));
    if (filter && filter !== 'all') {
      selectedProductsList = selectedProductsList.filter(p => {
        if (p.thickness === filter) return true;
        const name = (p.product_name || p.name || '');
        const match = name.match(/(\d+)\s*mm/i);
        return match && (match[1] + 'mm') === filter;
      });
    }
    return selectedProductsList;
  };

  // Helper function to extract size from product name (e.g., "60x60", "80x120")
  const extractSize = (product) => {
    const name = product.product_name || product.name || '';
    const sizeMatch = name.match(/(\d+(?:\.\d+)?)[xX](\d+(?:\.\d+)?)/);
    if (sizeMatch) {
      return parseFloat(sizeMatch[1]) * parseFloat(sizeMatch[2]); // Area for sorting
    }
    return 0;
  };

  // Filter products by status (moved up for use in toggleSelectAll)
  const filteredProducts = (() => {
    // First, apply status filter
    let filtered = products.filter(p => {
      if (!statusFilter) return true;
      if (statusFilter === 'needs_category') return !p.product_group;
      if (statusFilter === 'in_stock') return p.in_stock === true && !p.always_in_stock && p.stock_status !== 'low_stock';
      if (statusFilter === 'low_stock') return p.stock_status === 'low_stock';
      if (statusFilter === 'out_of_stock') return p.in_stock === false && !p.always_in_stock;
      if (statusFilter === 'always_in_stock') return p.always_in_stock === true;
      // Website publish status filters
      if (statusFilter === 'published') return p.show_on_website === true;
      if (statusFilter === 'not_published') return !p.show_on_website;
      // Sale & Labels filters
      if (statusFilter === 'on_sale') return p.sale_active === true;
      if (statusFilter === 'has_labels') return (p.labels && p.labels.length > 0) || (p.custom_labels && p.custom_labels.length > 0);
      // Dynamic label filter (e.g., "label:Clearance", "label:Best Seller")
      if (statusFilter.startsWith('label:')) {
        const labelName = statusFilter.substring(6);
        return (p.labels && p.labels.includes(labelName)) || (p.custom_labels && p.custom_labels.includes(labelName));
      }
      return true;
    });

    // Apply series filter
    if (seriesFilter) {
      filtered = filtered.filter(p => getSeriesName(p) === seriesFilter);
    }

    // Filter for name mismatches (products where display name differs from original)
    if (showNameMismatches) {
      filtered = filtered.filter(p => {
        const originalName = (p.name || '').toLowerCase().trim();
        const displayName = (p.product_name || '').toLowerCase().trim();
        // Check if names are significantly different (not just case/spacing)
        return originalName && displayName && originalName !== displayName;
      });
    }

    // Group products by series name
    const seriesGroups = {};
    filtered.forEach(product => {
      const seriesName = getSeriesName(product);
      if (!seriesGroups[seriesName]) {
        seriesGroups[seriesName] = [];
      }
      seriesGroups[seriesName].push(product);
    });

    // Sort each series group by size
    Object.values(seriesGroups).forEach(group => {
      group.sort((a, b) => extractSize(a) - extractSize(b));
    });

    // Separate multi-product series from single products.
    // Rule change: any NAMED series keeps its own group (with its own header row),
    // even when only one product currently sits in it. This lets admins assign
    // a fresh series to one product and still see it grouped under that series
    // name rather than being dumped into "Individual Products".
    // The "Individual Products" bucket is now reserved for products with an
    // empty/unresolved series name.
    const multiProductSeries = [];
    const singleProducts = [];

    Object.entries(seriesGroups).forEach(([seriesName, group]) => {
      if (seriesName && seriesName.trim()) {
        // Named series — always render as its own group.
        multiProductSeries.push(...group);
      } else {
        // Truly nameless — treat as individual so it sinks to the bottom.
        singleProducts.push(...group);
      }
    });

    // Sort single products by size
    singleProducts.sort((a, b) => extractSize(a) - extractSize(b));

    // Combine: multi-product series first, then single products
    return [...multiProductSeries, ...singleProducts];
  })();

  // Select/Deselect all products on current page
  const toggleSelectAll = () => {
    if (selectedProducts.size === filteredProducts.length) {
      setSelectedProducts(new Set());
    } else {
      setSelectedProducts(new Set(filteredProducts.map(p => getProductKey(p))));
    }
  };

  // Bulk delete selected products - Super Admin only
  const handleBulkDeleteSelected = async () => {
    if (!isSuperAdmin) {
      toast.error('Only Super Admin can delete products');
      return;
    }
    
    if (selectedProducts.size === 0) {
      toast.error('No products selected');
      return;
    }

    if (!window.confirm(`Are you sure you want to delete ${selectedProducts.size} selected products?`)) {
      return;
    }

    try {
      // Extract identifiers from selected products (sku or supplier_code or _id)
      const selectedKeys = Array.from(selectedProducts);
      const selectedProds = products.filter(p => selectedKeys.includes(getProductKey(p)));
      const skusToDelete = selectedProds.map(p => p.sku || p.supplier_code || p._id).filter(Boolean);
      
      const response = await fetch(`${API_URL}/api/supplier-sync/bulk-delete-selected`, {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${localStorage.getItem('token')}`
        },
        body: JSON.stringify({
          skus: skusToDelete,
          supplier: selectedSupplier !== 'all' ? selectedSupplier : undefined
        })
      });

      if (response.ok) {
        const result = await response.json();
        toast.success(result.message);
        setSelectedProducts(new Set());
        fetchProducts();
        fetchStats();
      } else {
        const error = await response.json();
        toast.error(error.detail || 'Bulk delete failed');
      }
    } catch (error) {
      console.error('Bulk delete selected error:', error);
      toast.error('Failed to delete selected products');
    }
  };

  // Sync products from main Products collection
  const handleSyncFromProducts = async (suppliers = []) => {
    setSyncLoading(true);
    try {
      const response = await fetch(`${API_URL}/api/supplier-sync/sync-from-products`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ suppliers })
      });

      if (response.ok) {
        const result = await response.json();
        toast.success(result.message);
        setShowSyncDialog(false);
        fetchProducts();
        fetchStats();
      } else {
        const error = await response.json();
        toast.error(error.detail || 'Sync failed');
      }
    } catch (error) {
      console.error('Sync error:', error);
      toast.error('Failed to sync products');
    } finally {
      setSyncLoading(false);
    }
  };

  // Toggle "Always In Stock" for a product
  const handleToggleAlwaysInStock = async (product) => {
    try {
      const newValue = !product.always_in_stock;
      const response = await fetch(`${API_URL}/api/supplier-sync/products/toggle-always-in-stock`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sku: product.sku,
          supplier: product.supplier,
          always_in_stock: newValue
        })
      });

      if (response.ok) {
        // Update local state immediately for responsiveness
        setProducts(prev => prev.map(p => 
          p.sku === product.sku ? { ...p, always_in_stock: newValue } : p
        ));
        toast.success(newValue ? 'Product will always show as In Stock' : 'Product will show actual stock status');
      } else {
        const error = await response.json();
        toast.error(error.detail || 'Failed to update');
      }
    } catch (error) {
      console.error('Toggle always in stock error:', error);
      toast.error('Failed to update product');
    }
  };

  // Set cost and/or list price for one or many products (mirrors to website + EPOS)
  const handleSetPrices = async (skus, fields) => {
    const cleanSkus = [...new Set(skus.filter(Boolean))];
    if (cleanSkus.length === 0) return false;
    try {
      const res = await fetch(`${API_URL}/api/supplier-sync/products/set-prices`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ skus: cleanSkus, ...fields }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.detail || `HTTP ${res.status}`);
      }
      setProducts(prev => prev.map(p =>
        cleanSkus.includes(p.sku || p.supplier_code) ? { ...p, ...fields } : p
      ));
      const parts = [];
      if (fields.cost_price !== undefined) parts.push(`cost £${Number(fields.cost_price).toFixed(2)}`);
      if (fields.price !== undefined) parts.push(`list £${Number(fields.price).toFixed(2)}`);
      toast.success(`${cleanSkus.length} product${cleanSkus.length !== 1 ? 's' : ''} updated — ${parts.join(', ')}`);
      return true;
    } catch (err) {
      toast.error(`Price update failed: ${err.message}`);
      return false;
    }
  };

  const commitPriceEdit = async () => {
    if (!priceEdit) return;
    const value = parseFloat(priceEdit.value);
    if (isNaN(value) || value < 0) { toast.error('Enter a valid price'); return; }
    const { key, field } = priceEdit;
    setPriceEdit(null);
    await handleSetPrices([key], { [field]: value });
  };

  // Margin Guard floor — used for the red low-margin chips in the cost column
  useEffect(() => {
    fetch(`${API_URL}/api/supplier-sync/margin-guard`)
      .then(res => res.json())
      .then(d => setMarginFloor(d.floor_percent))
      .catch(() => {});
  }, []);

  const getMarginPercent = (product) => {
    const price = Number(product.price ?? product.list_price ?? 0);
    const cost = Number(product.cost_price ?? 0);
    if (!price || !cost) return null;
    const net = price / 1.2;
    if (net <= 0) return null;
    return Math.round(((net - cost) / net) * 1000) / 10;
  };

  const acknowledgeCostChange = async (product) => {
    const sku = product.sku || product.supplier_code;
    try {
      await fetch(`${API_URL}/api/supplier-sync/products/acknowledge-cost-change`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sku, supplier: product.supplier })
      });
      setProducts(prev => prev.map(p => (p.sku || p.supplier_code) === sku ? { ...p, last_cost_change: null } : p));
      toast.success('Cost change acknowledged');
    } catch (err) {
      toast.error('Could not dismiss the badge');
    }
  };

  const applyBulkPrices = async () => {
    const fields = {};
    if (bulkPriceForm.cost !== '' && !isNaN(parseFloat(bulkPriceForm.cost))) fields.cost_price = parseFloat(bulkPriceForm.cost);
    if (bulkPriceForm.list !== '' && !isNaN(parseFloat(bulkPriceForm.list))) fields.price = parseFloat(bulkPriceForm.list);
    if (Object.keys(fields).length === 0) { toast.error('Enter a cost and/or list price'); return; }
    const selectedKeys = Array.from(selectedProducts);
    const selectedProds = products.filter(p => selectedKeys.includes(getProductKey(p)));
    const skus = selectedProds.map(p => p.sku || p.supplier_code);
    const ok = await handleSetPrices(skus, fields);
    if (ok) {
      setShowBulkPriceModal(false);
      setBulkPriceForm({ cost: '', list: '' });
    }
  };

  // Bulk stock status from the Quick Actions bar — all selected at once
  const handleBulkSetStock = async (status) => {
    const selectedKeys = Array.from(selectedProducts);
    const selectedProds = products.filter(p => selectedKeys.includes(getProductKey(p)));
    const skus = [...new Set(selectedProds.map(p => p.sku || p.supplier_code).filter(Boolean))];
    if (skus.length === 0) { toast.error('Please select products first'); return; }
    const labels = { in_stock: 'In Stock', low_stock: 'Low Stock', out_of_stock: 'Out of Stock', always_in_stock: 'Always In Stock' };
    try {
      const url = status === 'always_in_stock'
        ? `${API_URL}/api/supplier-sync/products/bulk-toggle-always-in-stock`
        : `${API_URL}/api/supplier-sync/products/bulk-set-stock-status`;
      const body = status === 'always_in_stock' ? { skus, always_in_stock: true } : { skus, stock_status: status };
      const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const inStock = status === 'in_stock' || status === 'low_stock' || status === 'always_in_stock';
      setProducts(prev => prev.map(p =>
        skus.includes(p.sku || p.supplier_code)
          ? {
              ...p,
              stock_status: status === 'always_in_stock' ? 'in_stock' : status,
              in_stock: inStock,
              always_in_stock: status === 'always_in_stock',
            }
          : p
      ));
      toast.success(`${skus.length} product${skus.length !== 1 ? 's' : ''} marked ${labels[status]}`);
    } catch (err) {
      toast.error(`Stock update failed: ${err.message}`);
    }
  };

  // Set stock status for a product (In Stock / Low Stock / Out of Stock / Always In Stock)
  const handleSetStockStatus = async (product, stockStatus) => {
    try {
      // "Always In Stock" is a flag, not a stock_status value
      if (stockStatus === 'always_in_stock') {
        const response = await fetch(`${API_URL}/api/supplier-sync/products/toggle-always-in-stock`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sku: product.sku, supplier: product.supplier, always_in_stock: true })
        });
        if (response.ok) {
          setProducts(prev => prev.map(p =>
            p.sku === product.sku ? { ...p, always_in_stock: true, in_stock: true } : p
          ));
          toast.success('Product will always show as In Stock');
        } else {
          const error = await response.json();
          toast.error(error.detail || 'Failed to update');
        }
        return;
      }
      // Switching away from "Always In Stock" — clear the flag first
      if (product.always_in_stock) {
        await fetch(`${API_URL}/api/supplier-sync/products/toggle-always-in-stock`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sku: product.sku, supplier: product.supplier, always_in_stock: false })
        });
      }
      const inStock = stockStatus !== 'out_of_stock';
      const response = await fetch(`${API_URL}/api/supplier-sync/products/set-stock-status`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sku: product.sku,
          supplier: product.supplier,
          stock_status: stockStatus,
          in_stock: inStock
        })
      });

      if (response.ok) {
        // Update local state immediately
        setProducts(prev => prev.map(p => 
          p.sku === product.sku ? { ...p, stock_status: stockStatus, in_stock: inStock, always_in_stock: false } : p
        ));
        const statusLabels = { 'in_stock': 'In Stock', 'low_stock': 'Low Stock', 'out_of_stock': 'Out of Stock' };
        toast.success(`Stock status set to ${statusLabels[stockStatus]}`);
      } else {
        const error = await response.json();
        toast.error(error.detail || 'Failed to update stock status');
      }
    } catch (error) {
      console.error('Set stock status error:', error);
      toast.error('Failed to update stock status');
    }
  };

  // Set product visibility
  const handleSetVisibility = async (product, visibility) => {
    try {
      const response = await fetch(`${API_URL}/api/supplier-sync/products/set-visibility`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sku: product.sku,
          supplier: product.supplier,
          visibility: visibility
        })
      });

      if (response.ok) {
        // Update local state immediately
        setProducts(prev => prev.map(p => 
          p.sku === product.sku ? { ...p, visibility } : p
        ));
        
        const labels = {
          'online': 'Product visible on website',
          'in_store_only': 'Product hidden from website (in-store only)',
          'hidden': 'Product completely hidden'
        };
        toast.success(labels[visibility] || 'Visibility updated');
      } else {
        const error = await response.json();
        toast.error(error.detail || 'Failed to update visibility');
      }
    } catch (error) {
      console.error('Set visibility error:', error);
      toast.error('Failed to update visibility');
    }
  };

  // Open edit modal
  const openEditModal = (product) => {
    setEditingProduct(product);
    setFormData({
      sku: product.sku || '',
      name: product.name || '',
      description: product.description || '',
      category: product.category || '',
      material: product.material || '',
      finish: product.finish || '',
      length_mm: product.length_mm || '',
      width_mm: product.width_mm || '',
      price: product.price || '',
      stock_quantity: product.stock_quantity || '',
      in_stock: product.in_stock !== false
    });
    setShowEditModal(true);
  };

  // Navigate to full product edit page
  const handleEditFullPage = async (product) => {
    try {
      // Build query params to return to the correct supplier tab after editing
      const returnParams = `?from=supplier&supplier=${encodeURIComponent(product.supplier || selectedSupplier)}`;
      
      // ALWAYS call addSupplierProductToDb to ensure data is synced from supplier_products to products collection
      // This ensures latest description, SEO keywords, and other fields are synced before editing
      toast.loading('Syncing product data...');
      
      const response = await api.addSupplierProductToDb(
        product.sku || product.supplier_code || product._id,
        product.supplier,
        product._id  // Pass _id for robust lookup when sku is missing
      );
      
      toast.dismiss();
      
      if (response.data?.product_id) {
        if (!product.products_db_id) {
          toast.success('Product synced to database');
        }
        navigate(`/admin/products/edit/${response.data.product_id}${returnParams}`);
      } else {
        // Fallback: if products_db_id exists, try navigating directly
        if (product.products_db_id) {
          navigate(`/admin/products/edit/${product.products_db_id}${returnParams}`);
        } else {
          toast.error('Failed to prepare product for editing');
        }
      }
    } catch (error) {
      toast.dismiss();
      console.error('Edit error:', error);
      // Fallback: if products_db_id exists, try navigating directly
      if (product.products_db_id) {
        navigate(`/admin/products/edit/${product.products_db_id}?from=supplier&supplier=${encodeURIComponent(product.supplier || selectedSupplier)}`);
      } else {
        toast.error('Failed to open product for editing');
      }
    }
  };

  // Copy Product - Creates a draft copy that needs Super Admin approval
  const handleCopyProduct = async (product) => {
    const confirmCopy = window.confirm(
      `Create a copy of "${product.product_name || product.name}"?\n\n` +
      `The copied product will be:\n` +
      `• Set as DRAFT (not visible online or in EPOS)\n` +
      `• Requires Super Admin approval to publish\n` +
      `• You can edit all specifications after copying`
    );
    
    if (!confirmCopy) return;
    
    try {
      toast.loading('Creating product copy...');
      
      const response = await fetch(`${API_URL}/api/supplier-sync/products/copy`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sku: product.sku || product.supplier_code || product._id,
          supplier: product.supplier || selectedSupplier,
          product_id: product._id
        })
      });
      
      toast.dismiss();
      
      if (response.ok) {
        const data = await response.json();
        toast.success(`Product copied! New SKU: ${data.new_sku}`);
        
        // Refresh products list
        fetchProducts();
        
        // Ask if user wants to edit the new product
        if (window.confirm('Product copied successfully! Would you like to edit the new product now?')) {
          // Navigate to edit the new product
          const returnParams = `?from=supplier&supplier=${encodeURIComponent(product.supplier || selectedSupplier)}`;
          if (data.product_id) {
            navigate(`/admin/products/edit/${data.product_id}${returnParams}`);
          }
        }
      } else {
        const error = await response.json();
        toast.error(error.detail || 'Failed to copy product');
      }
    } catch (error) {
      toast.dismiss();
      console.error('Copy error:', error);
      toast.error('Failed to copy product');
    }
  };

  // Fetch category suggestions for autocomplete
  const fetchCategorySuggestions = async () => {
    try {
      const response = await fetch(`${API_URL}/api/supplier-sync/categories`);
      if (response.ok) {
        const data = await response.json();
        setCategorySuggestions(data.categories || []);
      }
    } catch (error) {
      console.error('Error fetching categories:', error);
    }
  };

  // Open Quick Edit Modal
  const handleQuickEdit = (product) => {
    // Route to category-specific Manager if product has a product_group.
    // Managers are the recommended editing surface — legacy Quick Edit
    // stays available for products that are still unclassified.
    const groupToPath = {
      tiles: '/admin/tiles',
      materials: '/admin/materials',
      // Future: flooring / bathroom / underfloor_heating / tools managers
    };
    const target = groupToPath[product.product_group];
    if (target) {
      const productId = product.sku || product.supplier_code || product._id;
      toast.info(`Opening ${product.product_group} Manager…`, { duration: 3000 });
      // Navigate to the manager with an anchor so it can auto-open the edit modal for this SKU
      navigate(`${target}?edit=${encodeURIComponent(productId)}`);
      return;
    }
    // Fallback: legacy Quick Edit modal
    setQuickEditProduct(product);
    // Get all images for this product
    const productImages = product.images && product.images.length > 0 
      ? product.images 
      : (product.image ? [product.image] : []);
    
    // Use display_name if available, otherwise fall back to product_name
    const displayName = product.display_name || product.product_name || '';
    const displayCode = product.display_code || '';
    
    setQuickEditForm({
      name: product.name || '',
      // Customer-facing fields
      display_name: displayName,
      display_code: displayCode,
      // Internal fields  
      supplier_product_name: product.supplier_product_name || product.original_series || product.name || '',
      supplier_product_code: product.sku || product.supplier_code || '',
      // Legacy fields
      product_name: displayName,
      original_series: product.original_series || product.supplier_product_name || '',
      // Other fields
      price: product.price || '',
      cost_price: product.cost_price || '',
      stock_quantity: product.stock_quantity || '',
      stock_m2: product.stock_m2 || '',
      category: product.category || '',
      finish: product.finish || '',
      in_stock: product.in_stock !== false,
      always_in_stock: product.always_in_stock || false,
      is_featured: product.is_featured || false,
      images: productImages
    });
    
    // Set initial display code preview
    setDisplayCodePreview(displayCode);
    
    setShowCategorySuggestions(false);
    fetchCategorySuggestions(); // Load categories for autocomplete
    setShowQuickEditModal(true);
  };

  // Save Quick Edit
  const handleSaveQuickEdit = async () => {
    if (!quickEditProduct) return;
    
    setQuickEditLoading(true);
    try {
      const updateData = {
        product_id: quickEditProduct._id,
        sku: quickEditProduct.sku || quickEditProduct.supplier_code || quickEditProduct._id,
        supplier_code: quickEditProduct.supplier_code,
        supplier: quickEditProduct.supplier || selectedSupplier,
        // Do NOT send 'name' — it should only change via supplier sync, never from display name edits
        // Use display_name as the primary customer-facing name
        display_name: quickEditForm.display_name,
        display_code: quickEditForm.display_code || displayCodePreview,
        supplier_product_name: quickEditForm.supplier_product_name,
        supplier_product_code: quickEditForm.supplier_product_code,  // Editable supplier code
        // If supplier code changed, update the new_sku field for backend to handle
        new_sku: quickEditForm.supplier_product_code !== quickEditProduct.sku ? quickEditForm.supplier_product_code : null,
        // Legacy fields for backwards compatibility
        product_name: quickEditForm.display_name, // Sync with display_name
        original_series: quickEditForm.original_series,
        price: quickEditForm.price ? parseFloat(quickEditForm.price) : null,
        cost_price: quickEditForm.cost_price ? parseFloat(quickEditForm.cost_price) : null,
        stock_quantity: quickEditForm.stock_quantity ? parseFloat(quickEditForm.stock_quantity) : null,
        stock_m2: quickEditForm.stock_m2 ? parseFloat(quickEditForm.stock_m2) : null,
        category: quickEditForm.category,
        finish: quickEditForm.finish,
        in_stock: quickEditForm.in_stock,
        always_in_stock: quickEditForm.always_in_stock,
        is_featured: quickEditForm.is_featured,
        images: quickEditForm.images,
        image: quickEditForm.images.length > 0 ? quickEditForm.images[0] : null  // Primary image
      };

      const response = await fetch(`${API_URL}/api/supplier-sync/products/quick-update`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updateData)
      });

      if (response.ok) {
        toast.success('Product updated successfully');
        setShowQuickEditModal(false);
        setQuickEditProduct(null);
        fetchProducts();
      } else {
        const error = await response.json();
        toast.error(error.detail || 'Failed to update product');
      }
    } catch (error) {
      console.error('Quick edit error:', error);
      toast.error('Failed to update product');
    } finally {
      setQuickEditLoading(false);
    }
  };

  // Generate display code preview from display name
  const generateDisplayCodePreview = async (displayName) => {
    if (!displayName || displayName.trim() === '') {
      setDisplayCodePreview('');
      return;
    }
    
    try {
      const response = await fetch(
        `${API_URL}/api/supplier-sync/generate-display-code?display_name=${encodeURIComponent(displayName)}`
      );
      if (response.ok) {
        const data = await response.json();
        if (data.success) {
          setDisplayCodePreview(data.display_code);
          // Also update the form
          setQuickEditForm(prev => ({
            ...prev,
            display_code: data.display_code
          }));
        }
      }
    } catch (error) {
      console.error('Error generating display code:', error);
    }
  };

  // Handle display name change with debounced code generation
  const handleDisplayNameChange = (newName) => {
    setQuickEditForm(prev => ({
      ...prev,
      display_name: newName,
      product_name: newName // Keep legacy field in sync
    }));
    
    // Debounce the API call
    if (window.displayCodeTimeout) {
      clearTimeout(window.displayCodeTimeout);
    }
    window.displayCodeTimeout = setTimeout(() => {
      generateDisplayCodePreview(newName);
    }, 300);
  };

  // Upload image for Quick Edit with progress tracking
  const handleQuickEditImageUpload = async (e) => {
    const files = Array.from(e.target.files);
    if (files.length === 0) return;
    
    setQuickEditImageUploading(true);
    const uploadPromises = [];
    
    for (const file of files) {
      const formData = new FormData();
      formData.append('image', file);
      formData.append('product_id', quickEditProduct._id);
      formData.append('supplier', quickEditProduct.supplier || 'unknown');
      
      const uploadPromise = fetch(`${API_URL}/api/supplier-sync/upload-product-image`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${localStorage.getItem('token')}`
        },
        body: formData
      }).then(async (response) => {
        if (response.ok) {
          const result = await response.json();
          // Check for R2 storage confirmation
          const imageUrl = result.image_url || result.url;
          const isR2 = imageUrl?.includes('images.tilestation.co.uk') || result.storage === 'r2';
          
          if (imageUrl) {
            setQuickEditForm(prev => ({
              ...prev,
              images: [...prev.images, imageUrl]
            }));
            
            // Show R2 confirmation
            if (isR2) {
              toast.success(`Image uploaded to cloud storage`, {
                description: 'Stored on R2 CDN for fast delivery',
                icon: '☁️'
              });
            } else {
              toast.success(`Image uploaded successfully`);
            }
          }
          return { success: true, url: imageUrl };
        } else {
          toast.error(`Failed to upload ${file.name}`);
          return { success: false };
        }
      }).catch((error) => {
        console.error('Image upload error:', error);
        toast.error(`Error uploading ${file.name}`);
        return { success: false };
      });
      
      uploadPromises.push(uploadPromise);
    }
    
    await Promise.all(uploadPromises);
    setQuickEditImageUploading(false);
  };

  // Delete image from Quick Edit
  const handleQuickEditDeleteImage = async (imageUrl, index) => {
    try {
      // Update local state immediately
      setQuickEditForm(prev => ({
        ...prev,
        images: prev.images.filter((_, i) => i !== index)
      }));
      
      // Call backend to delete (optional - depends on your needs)
      // For now just update the form state
      toast.success('Image removed');
    } catch (error) {
      console.error('Delete image error:', error);
      toast.error('Failed to remove image');
    }
  };

  // Set image as primary (first in array)
  const handleSetPrimaryImage = (index) => {
    if (index === 0) return; // Already primary
    setQuickEditForm(prev => {
      const newImages = [...prev.images];
      const [removed] = newImages.splice(index, 1);
      newImages.unshift(removed);
      return { ...prev, images: newImages };
    });
    toast.success('Primary image updated');
  };

  // Drag and drop handlers for image reordering
  const handleImageDragStart = (e, index) => {
    setDraggedImageIndex(index);
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/html', e.target.outerHTML);
    e.target.style.opacity = '0.5';
  };

  const handleImageDragEnd = (e) => {
    e.target.style.opacity = '1';
    setDraggedImageIndex(null);
  };

  const handleImageDragOver = (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
  };

  const handleImageDrop = (e, dropIndex) => {
    e.preventDefault();
    if (draggedImageIndex === null || draggedImageIndex === dropIndex) return;
    
    setQuickEditForm(prev => {
      const newImages = [...prev.images];
      const [draggedImage] = newImages.splice(draggedImageIndex, 1);
      newImages.splice(dropIndex, 0, draggedImage);
      return { ...prev, images: newImages };
    });
    
    setDraggedImageIndex(null);
    toast.success('Image order updated');
  };

  // Delete name history entry (Super Admin only)
  const handleDeleteNameHistory = async (product, field, historyIndex = null) => {
    if (!isSuperAdmin) {
      toast.error('Only Super Admin can delete name history');
      return;
    }
    
    if (!window.confirm('Are you sure you want to delete this name history entry? This action cannot be undone.')) {
      return;
    }
    
    try {
      const response = await fetch(`${API_URL}/api/supplier-sync/products/delete-name-history`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${localStorage.getItem('token')}`
        },
        body: JSON.stringify({
          sku: product.sku,
          supplier: product.supplier,
          field: field,
          history_index: historyIndex
        })
      });
      
      if (response.ok) {
        toast.success('Name history entry deleted');
        fetchProducts(); // Refresh to see changes
      } else {
        const error = await response.json();
        toast.error(error.detail || 'Failed to delete name history');
      }
    } catch (error) {
      console.error('Delete name history error:', error);
      toast.error('Failed to delete name history');
    }
  };

  // ============================================================
  // SALE / LABELS FUNCTIONS
  // ============================================================
  
  // Open Sale/Labels Modal for single product
  const openSaleLabelsModal = (product) => {
    setSaleLabelsProduct(product);
    // NOW price is always the current list price
    const listPrice = product.list_price || product.price || product.room_lot_price || 0;
    const existingWasMarkup = product.was_markup_percent || '';
    const existingWasPrice = product.was_price || '';
    
    // Calculate WAS price from markup if set
    let wasPrice = existingWasPrice;
    if (!wasPrice && existingWasMarkup && listPrice > 0) {
      wasPrice = (listPrice * (1 + parseFloat(existingWasMarkup) / 100)).toFixed(2);
    }
    
    // Calculate discount percentage
    let discountPct = '';
    if (wasPrice && listPrice > 0) {
      discountPct = (((parseFloat(wasPrice) - listPrice) / parseFloat(wasPrice)) * 100).toFixed(1);
    }
    
    setSaleLabelsForm({
      labels: product.labels || [],
      custom_labels: product.custom_labels || [],
      list_price: listPrice,  // The actual selling price (NOW)
      was_price: wasPrice,    // Inflated "original" price
      was_markup_percent: existingWasMarkup,  // % markup on top of list price
      discount_percentage: discountPct,
      sale_active: product.sale_active || false,
      newCustomLabel: ''
    });
    setShowSaleLabelsModal(true);
  };

  // Toggle a preset label
  const togglePresetLabel = (label) => {
    setSaleLabelsForm(prev => {
      const labels = prev.labels.includes(label)
        ? prev.labels.filter(l => l !== label)
        : [...prev.labels, label];
      return { ...prev, labels };
    });
  };

  // Add custom label
  const addCustomLabel = () => {
    const newLabel = saleLabelsForm.newCustomLabel.trim();
    if (newLabel && !saleLabelsForm.custom_labels.includes(newLabel)) {
      setSaleLabelsForm(prev => ({
        ...prev,
        custom_labels: [...prev.custom_labels, newLabel],
        newCustomLabel: ''
      }));
    }
  };

  // Remove custom label
  const removeCustomLabel = (label) => {
    setSaleLabelsForm(prev => ({
      ...prev,
      custom_labels: prev.custom_labels.filter(l => l !== label)
    }));
  };

  // Calculate WAS price from markup percentage
  // WAS = List Price × (1 + markup%)
  const calculateWasFromMarkup = (listPrice, markupPct) => {
    if (!listPrice || !markupPct) return '';
    const list = parseFloat(listPrice);
    const markup = parseFloat(markupPct);
    if (isNaN(list) || isNaN(markup) || list <= 0) return '';
    const rawWas = list * (1 + markup / 100);
    // Round to .99
    return (Math.ceil(rawWas) - 0.01).toFixed(2);
  };

  // Calculate discount percentage from WAS and NOW (list) prices
  // Discount = (WAS - NOW) / WAS × 100
  const calculateDiscount = (wasPrice, listPrice) => {
    if (!wasPrice || !listPrice) return '';
    const was = parseFloat(wasPrice);
    const list = parseFloat(listPrice);
    if (isNaN(was) || isNaN(list) || was <= 0 || was <= list) return '';
    return (((was - list) / was) * 100).toFixed(1);
  };

  // Calculate markup percentage from WAS and list prices
  // Markup = (WAS - List) / List × 100
  const calculateMarkupFromWas = (wasPrice, listPrice) => {
    if (!wasPrice || !listPrice) return '';
    const was = parseFloat(wasPrice);
    const list = parseFloat(listPrice);
    if (isNaN(was) || isNaN(list) || list <= 0) return '';
    return (((was - list) / list) * 100).toFixed(1);
  };

  // Handle WAS markup % change - auto-calculate WAS price and discount
  const handleWasMarkupChange = (markupPct) => {
    const wasPrice = calculateWasFromMarkup(saleLabelsForm.list_price, markupPct);
    const discount = calculateDiscount(wasPrice, saleLabelsForm.list_price);
    setSaleLabelsForm(prev => ({
      ...prev,
      was_markup_percent: markupPct,
      was_price: wasPrice,
      discount_percentage: discount
    }));
  };

  // Handle WAS price direct entry - auto-calculate markup and discount
  const handleWasPriceChange = (wasPrice) => {
    const markup = calculateMarkupFromWas(wasPrice, saleLabelsForm.list_price);
    const discount = calculateDiscount(wasPrice, saleLabelsForm.list_price);
    setSaleLabelsForm(prev => ({
      ...prev,
      was_price: wasPrice,
      was_markup_percent: markup,
      discount_percentage: discount
    }));
  };

  // Save Sale/Labels for single product
  const handleSaveSaleLabels = async () => {
    if (!saleLabelsProduct) return;
    
    setSaleLabelsLoading(true);
    try {
      // Update labels
      await fetch(`${API_URL}/api/supplier-sync/products/labels`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sku: saleLabelsProduct.sku,
          supplier: saleLabelsProduct.supplier,
          labels: saleLabelsForm.labels,
          custom_labels: saleLabelsForm.custom_labels
        })
      });

      // Update sale pricing
      await fetch(`${API_URL}/api/supplier-sync/products/sale-pricing`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sku: saleLabelsProduct.sku,
          supplier: saleLabelsProduct.supplier,
          was_price: saleLabelsForm.was_price ? parseFloat(saleLabelsForm.was_price) : null,
          was_markup_percent: saleLabelsForm.was_markup_percent ? parseFloat(saleLabelsForm.was_markup_percent) : null,
          discount_percentage: saleLabelsForm.discount_percentage ? parseFloat(saleLabelsForm.discount_percentage) : null,
          sale_active: saleLabelsForm.sale_active
        })
      });

      toast.success('Labels and pricing updated');
      setShowSaleLabelsModal(false);
      fetchProducts();
    } catch (error) {
      console.error('Error saving sale/labels:', error);
      toast.error('Failed to update');
    } finally {
      setSaleLabelsLoading(false);
    }
  };

  // Bulk Sale/Labels - Apply to selected products
  const handleBulkSaleLabels = async (targetProductKeys = null) => {
    if (selectedProducts.size === 0) {
      toast.error('No products selected');
      return;
    }

    setBulkSaleLoading(true);
    try {
      const selectedKeys = Array.from(selectedProducts);
      let selectedProds = products.filter(p => selectedKeys.includes(getProductKey(p)));
      
      // If specific products are targeted, filter to only those
      if (targetProductKeys && targetProductKeys.size > 0) {
        selectedProds = selectedProds.filter(p => targetProductKeys.has(getProductKey(p)));
      }
      
      const productIds = selectedProds.map(p => ({ sku: p.sku || p.supplier_code || p._id, supplier: p.supplier }));
      const updatedCount = selectedProds.length;

      // Apply labels if any selected
      if (bulkSaleForm.labels.length > 0 || bulkSaleForm.custom_labels.length > 0 || bulkSaleForm.action === 'clear') {
        const labelsAction = bulkSaleForm.action === 'clear' ? 'replace' : bulkSaleForm.action;
        await fetch(`${API_URL}/api/supplier-sync/products/bulk-labels`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            product_ids: productIds,
            labels: bulkSaleForm.action === 'clear' ? [] : bulkSaleForm.labels,
            custom_labels: bulkSaleForm.action === 'clear' ? [] : bulkSaleForm.custom_labels,
            action: labelsAction
          })
        });
      }

      // Apply sale pricing if enabled — explicit WAS anchor or % off current price
      const usingWasMode = (bulkSaleForm.saleMode || 'was') === 'was';
      const saleInput = usingWasMode ? bulkSaleForm.was_price : bulkSaleForm.discount_percentage;
      if (bulkSaleForm.applyDiscount && saleInput) {
        await fetch(`${API_URL}/api/supplier-sync/products/bulk-sale-pricing`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            product_ids: productIds,
            ...(usingWasMode
              ? { was_price: parseFloat(bulkSaleForm.was_price) }
              : { discount_percentage: parseFloat(bulkSaleForm.discount_percentage) }),
            sale_active: true,
            clear_sale: false
          })
        });
      }

      // Clear sale pricing if action is 'clear'
      if (bulkSaleForm.action === 'clear') {
        await fetch(`${API_URL}/api/supplier-sync/products/bulk-sale-pricing`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            product_ids: productIds,
            clear_sale: true
          })
        });
      }

      toast.success(`Updated ${updatedCount} products`);
      setShowBulkSaleModal(false);
      setBulkSaleForm({
        labels: [],
        custom_labels: [],
        discount_percentage: '',
        was_price: '',
        saleMode: 'was',
        action: 'add',
        applyDiscount: false
      });
      setSelectedProducts(new Set());
      fetchProducts();
    } catch (error) {
      console.error('Error in bulk sale/labels:', error);
      toast.error('Failed to update products');
    } finally {
      setBulkSaleLoading(false);
    }
  };

  // Calculate profit for display (based on list price which is the NOW/selling price)
  const calculateProfit = () => {
    if (!saleLabelsProduct || !saleLabelsForm.list_price) return null;
    const costPrice = saleLabelsProduct.cost_price || 0;
    const listPrice = parseFloat(saleLabelsForm.list_price) || 0;
    if (costPrice <= 0 || listPrice <= 0) return null;
    const profit = (listPrice - costPrice).toFixed(2);
    const margin = ((listPrice - costPrice) / listPrice * 100).toFixed(1);
    return { profit, margin };
  };
  
  // Calculate savings for display
  const calculateSavings = () => {
    if (!saleLabelsForm.was_price || !saleLabelsForm.list_price) return null;
    const wasPrice = parseFloat(saleLabelsForm.was_price) || 0;
    const listPrice = parseFloat(saleLabelsForm.list_price) || 0;
    if (wasPrice <= listPrice) return null;
    const savings = (wasPrice - listPrice).toFixed(2);
    const percent = (((wasPrice - listPrice) / wasPrice) * 100).toFixed(0);
    return { savings, percent };
  };

  // Save product (add or edit)
  const handleSaveProduct = async () => {
    if (!formData.sku || !formData.name) {
      toast.error('Product code and name are required');
      return;
    }

    try {
      const productData = {
        ...formData,
        supplier: editingProduct?.supplier || selectedSupplier === 'all' ? 'Verona' : selectedSupplier,
        price: formData.price ? parseFloat(formData.price) : null,
        length_mm: formData.length_mm ? parseFloat(formData.length_mm) : null,
        width_mm: formData.width_mm ? parseFloat(formData.width_mm) : null,
        stock_quantity: formData.stock_quantity ? parseInt(formData.stock_quantity) : null
      };

      const response = await fetch(`${API_URL}/api/supplier-sync/products`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ products: [productData], supplier: productData.supplier })
      });

      if (response.ok) {
        toast.success(editingProduct ? 'Product updated' : 'Product added');
        setShowAddModal(false);
        setShowEditModal(false);
        setEditingProduct(null);
        resetForm();
        fetchProducts();
        fetchStats();
      } else {
        toast.error('Failed to save product');
      }
    } catch (error) {
      console.error('Save error:', error);
      toast.error('Failed to save product');
    }
  };

  const resetForm = () => {
    setFormData({
      sku: '',
      name: '',
      description: '',
      category: '',
      material: '',
      finish: '',
      length_mm: '',
      width_mm: '',
      price: '',
      stock_quantity: '',
      in_stock: true
    });
  };

  const totalPages = Math.ceil(totalProducts / productsPerPage);

  return (
    <div className="p-6 space-y-6" data-testid="supplier-products-page">
      {/* Workspace tabs — unified across Managers + legacy Bulk Editor */}
      <div className="-mx-6 -mt-6 mb-2">
        <ManagerTabsBar
          active="all"
          onNewCustom={() => setManagerBuilderOpen(true)}
          selectionKeys={selectedProducts && selectedProducts.size > 0 ? [...selectedProducts] : null}
          selectionByCategory={selectedProducts && selectedProducts.size > 0
            ? bucketSelectionByManager(products, selectedProducts, getProductKey)
            : null}
        />
      </div>

      <CustomManagerBuilder open={managerBuilderOpen} onOpenChange={setManagerBuilderOpen} />

      {/* Header */}
      <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 flex items-center gap-2">
            <Building2 className="w-7 h-7" />
            Supplier Products
          </h1>
          <p className="text-gray-500">Manage products from all suppliers in one place</p>
        </div>
        <div className="flex flex-wrap gap-2">
          {/* New Products Filter Button */}
          <Button 
            variant={showNewOnly ? "default" : "outline"} 
            onClick={() => { setShowNewOnly(!showNewOnly); setCurrentPage(1); }}
            className={showNewOnly ? "bg-green-600 hover:bg-green-700" : ""}
          >
            <Sparkles className="w-4 h-4 mr-2" />
            New Products
            {newProductCount > 0 && (
              <span className="ml-2 bg-green-500 text-white text-xs px-2 py-0.5 rounded-full">
                {newProductCount}
              </span>
            )}
          </Button>
          <Button variant="outline" onClick={exportToExcel}>
            <FileSpreadsheet className="w-4 h-4 mr-2" />
            Export Excel
          </Button>
          <label className="cursor-pointer">
            <input
              type="file"
              accept=".xlsx,.xls,.csv"
              onChange={handleFileUpload}
              className="hidden"
              disabled={uploading}
            />
            <div className={`inline-flex items-center justify-center whitespace-nowrap rounded-md text-sm font-medium ring-offset-background transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 border border-input bg-background hover:bg-accent hover:text-accent-foreground h-10 px-4 py-2 ${uploading ? 'opacity-50 cursor-not-allowed' : ''}`}>
              <Upload className="w-4 h-4 mr-2" />
              {uploading ? 'Importing...' : 'Import Excel'}
            </div>
          </label>
          <Button onClick={() => { resetForm(); setShowAddModal(true); }}>
            <Plus className="w-4 h-4 mr-2" />
            Add Product
          </Button>
          {/* Sync from Products DB button */}
          <Button 
            variant="outline"
            onClick={() => setShowSyncDialog(true)}
            data-testid="sync-products-btn"
          >
            <Database className="w-4 h-4 mr-2" />
            Sync from Products
          </Button>
          {/* Name Sanity — inline drawer (merged from standalone page).
              When products are selected, drawer opens scoped to that selection.
              When no selection, drawer runs the full-DB scan. */}
          <Button
            variant="outline"
            className="border-emerald-500 text-emerald-700 hover:bg-emerald-50"
            onClick={() => setShowNameSanity(true)}
            data-testid="open-name-sanity-btn"
            title={selectedProducts.size > 0
              ? `Review name sanity for the ${selectedProducts.size} selected product(s) only`
              : 'Scan every supplier product for garbled or truncated names — fix them inline'}
          >
            <ShieldCheck className="w-4 h-4 mr-2" />
            Name Sanity{selectedProducts.size > 0 ? ` (${selectedProducts.size})` : ''}
          </Button>
          {/* Import New Suppliers (RSA Tiles + ThermoSphere) */}
          {isSuperAdmin && (selectedSupplier === 'RSA Tiles' || selectedSupplier === 'ThermoSphere' || selectedSupplier === 'all') && (
            <Button 
              variant="outline"
              className="border-emerald-500 text-emerald-700 hover:bg-emerald-50"
              onClick={handleImportNewSuppliers}
              disabled={importingSuppliers}
              data-testid="import-new-suppliers-btn"
            >
              {importingSuppliers ? (
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
              ) : (
                <Download className="w-4 h-4 mr-2" />
              )}
              {importingSuppliers ? 'Importing...' : 'Import New Suppliers'}
            </Button>
          )}
          {/* Bulk Add to Database - for protected suppliers */}
          {selectedSupplier !== 'all' && PROTECTED_SUPPLIERS.includes(selectedSupplier) && (
            <Button 
              variant="default"
              className="bg-blue-600 hover:bg-blue-700"
              onClick={handleBulkAddToDatabase}
              data-testid="bulk-add-db-btn"
            >
              <Plus className="w-4 h-4 mr-2" />
              Add All to Database
            </Button>
          )}
          {/* Custom Name Mappings - View/manage custom product name overrides - Admin only */}
          {isAdminOrHigher && (
            <Button 
              variant="outline"
              className="border-indigo-500 text-indigo-700 hover:bg-indigo-50"
              onClick={openCustomMappingsModal}
              data-testid="custom-mappings-btn"
            >
              <PenLine className="w-4 h-4 mr-2" />
              Custom Mappings
              {Object.values(customMappingsBySupplier).reduce((a, b) => a + b, 0) > 0 && (
                <span className="ml-1 px-1.5 py-0.5 text-xs bg-indigo-100 rounded-full">
                  {Object.values(customMappingsBySupplier).reduce((a, b) => a + b, 0)}
                </span>
              )}
            </Button>
          )}
          {/* Upload Images - Available for all suppliers except 'all'.
              Pass the current series + search + manual-selection state
              to the destination page so it lands on the same view the
              user prepared. Three filters can carry through:
                ?series=Modis      — series dropdown
                ?search=moonstone  — search bar
                ?skus=Plus39|||SKU1,Plus39|||SKU2  — manual selection
                                                     (Smart Select / checkboxes)
              The label adapts so the user can see which filter will
              carry BEFORE clicking. */}
          {selectedSupplier !== 'all' && (
            <Button 
              variant="default"
              className="bg-emerald-600 hover:bg-emerald-700"
              onClick={() => {
                // Carry current series + manual-selection state INTO the
                // in-place images panel instead of navigating away.
                const selectedKeys = Array.from(selectedProducts);
                const skuSet = new Set(
                  selectedKeys
                    .map(k => k.split('|||').pop())
                    .filter(Boolean)
                );
                setImagesPanelState({
                  supplier: selectedSupplier,
                  initialSeriesFilter: seriesFilter || '',
                  initialSkuFilter: skuSet.size > 0 ? skuSet : null,
                });
              }}
              data-testid="supplier-images-btn"
              title={
                selectedProducts.size > 0
                  ? `Upload images for ${selectedProducts.size} selected product${selectedProducts.size > 1 ? 's' : ''}`
                  : seriesFilter
                    ? `Upload images filtered to ${seriesFilter} series only`
                    : 'Upload images for ALL series of this supplier — pick a series in the dropdown to narrow the list'
              }
            >
              <Upload className="w-4 h-4 mr-2" />
              Upload Images
              <span className="ml-2 text-xs opacity-90 font-normal">
                ({selectedProducts.size > 0
                    ? `${selectedProducts.size} selected`
                    : seriesFilter || 'all series'})
              </span>
            </Button>
          )}
          {/* Canopy Stock Update - Quick access to update stock from supplier page */}
          {selectedSupplier === 'Canopy' && (
            <Button 
              variant="default"
              className="bg-amber-600 hover:bg-amber-700"
              onClick={() => {
                setShowCanopyStockModal(true);
                setCanopyStockStep('input');
                setCanopyStockText('');
                setCanopyStockPreview(null);
              }}
              data-testid="canopy-stock-update-btn"
            >
              <RefreshCw className="w-4 h-4 mr-2" />
              Update Stock
            </Button>
          )}
          {/* Delete All From Database - Super Admin only, for protected suppliers */}
          {isSuperAdmin && selectedSupplier !== 'all' && PROTECTED_SUPPLIERS.includes(selectedSupplier) && (
            <Button 
              variant="destructive"
              onClick={handleOpenDeleteDialog}
              data-testid="delete-all-db-btn"
            >
              <Trash2 className="w-4 h-4 mr-2" />
              Delete All From Database
            </Button>
          )}
          {/* Bulk delete selected - Super Admin only */}
          {isSuperAdmin && selectedProducts.size > 0 && (
            <Button 
              variant="destructive" 
              onClick={handleBulkDeleteSelected}
              data-testid="bulk-delete-selected-btn"
            >
              <Trash2 className="w-4 h-4 mr-2" />
              Delete Selected ({selectedProducts.size})
            </Button>
          )}
          {/* Bulk Category Editor — kept as a container so downstream
              conditional buttons (Publish/Unpublish/Fix Draft/Upload PDFs)
              still render as siblings. Sale/Labels, Rename Series, Edit
              Categories, and Assign Category were removed from here on
              user request (2026-08-08) — the same actions live on the
              sticky bulk-action bar at the bottom of the page. */}
          {selectedProducts.size > 0 && (
            <>
              <Button 
                variant="default"
                className="bg-green-600 hover:bg-green-700"
                onClick={publishSelectedToWebsite}
                disabled={publishingToWebsite}
                data-testid="publish-to-website-btn"
              >
                {publishingToWebsite ? (
                  <>
                    <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                    Publishing...
                  </>
                ) : (
                  <>
                    <Globe className="w-4 h-4 mr-2" />
                    Publish to Website ({selectedProducts.size})
                  </>
                )}
              </Button>
              <Button 
                variant="outline"
                className="border-red-300 text-red-600 hover:bg-red-50"
                onClick={unpublishSelectedFromWebsite}
                disabled={unpublishingFromWebsite}
                data-testid="unpublish-from-website-btn"
              >
                {unpublishingFromWebsite ? (
                  <>
                    <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                    Unpublishing...
                  </>
                ) : (
                  <>
                    <EyeOff className="w-4 h-4 mr-2" />
                    Unpublish ({selectedProducts.size})
                  </>
                )}
              </Button>
              {/* Fix Draft Status - only show if any selected products are draft */}
              <Button 
                variant="outline"
                className="border-amber-300 text-amber-600 hover:bg-amber-50"
                onClick={fixDraftStatus}
                data-testid="fix-draft-btn"
              >
                <CheckCircle className="w-4 h-4 mr-2" />
                Fix Draft ({selectedProducts.size})
              </Button>
              <Button
                variant="default"
                className="bg-red-600 hover:bg-red-700"
                onClick={() => {
                  const selectedSkusList = Array.from(selectedProducts);
                  const selectedProductsList = products.filter(p => selectedSkusList.includes(getProductKey(p)));
                  setDocumentsModalProducts(selectedProductsList);
                  setShowDocumentsModal(true);
                }}
                data-testid="bulk-upload-pdfs-btn"
              >
                <FileText className="w-4 h-4 mr-2" />
                Upload PDFs ({selectedProducts.size})
              </Button>
            </>
          )}
          {/* Bulk delete - Only for Super Admin and non-protected suppliers */}
          {isSuperAdmin && selectedSupplier !== 'all' && !PROTECTED_SUPPLIERS.includes(selectedSupplier) && (
            <Button 
              variant="destructive" 
              onClick={() => setShowBulkDeleteDialog(true)}
              data-testid="bulk-delete-btn"
            >
              <Trash2 className="w-4 h-4 mr-2" />
              Delete All {selectedSupplier}
            </Button>
          )}
        </div>
      </div>

      {/* Smart Select Toolbar removed 2026-08-08 on user request — bulk selection is done via header checkboxes + the sticky bulk-action bar. */}

      {/* Supplier Tabs */}
      <div className="flex flex-wrap gap-2 border-b pb-4">
        {SUPPLIERS.filter(s => !hiddenSuppliersSet.has(s.id)).map(supplier => {
          const count = supplier.id === 'all' 
            ? (stats._total || Object.entries(stats).reduce((a, [k, b]) => k === '_total' ? a : a + (b || 0), 0))
            : stats[supplier.id] || 0;
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
              <span className={`
                text-xs px-2 py-0.5 rounded-full
                ${isActive ? 'bg-white/20' : 'bg-gray-200'}
              `}>
                {count}
              </span>
              {/* Delete-supplier trash icon — Super Admin only. Opens a
                  password-gated confirmation modal. Rendered as a div to
                  avoid nested <button>; onClick + role='button' cover click
                  and keyboard access. */}
              {isSuperAdmin && supplier.id !== 'all' && (
                <div
                  role="button"
                  tabIndex={0}
                  onClick={(e) => {
                    e.stopPropagation();
                    openDeleteSupplierEntirely(supplier.name);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      e.stopPropagation();
                      openDeleteSupplierEntirely(supplier.name);
                    }
                  }}
                  className={`ml-1 p-0.5 rounded cursor-pointer transition-colors ${isActive ? 'text-white/70 hover:text-white hover:bg-red-500/40' : 'text-gray-400 hover:text-red-600 hover:bg-red-50'}`}
                  title={`Delete ${supplier.name} entirely (Super Admin)`}
                  data-testid={`supplier-delete-${supplier.id}`}
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </div>
              )}
            </button>
          );
        })}
      </div>

      {/* Hidden Suppliers Restore Strip — appears only when at least one
          supplier has been hard-deleted, giving admins a one-click way to
          re-show the chip if they change their mind. */}
      {hiddenSuppliers.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 text-[11px] text-gray-500 -mt-1" data-testid="hidden-suppliers-strip">
          <span className="uppercase tracking-wider font-semibold text-gray-400">Hidden:</span>
          {hiddenSuppliers.map(h => {
            const name = h.name || h;
            return (
              <button
                key={name}
                type="button"
                onClick={() => restoreHiddenSupplier(name)}
                className="inline-flex items-center gap-1 px-2 py-0.5 rounded border border-gray-200 bg-gray-50 hover:bg-emerald-50 hover:border-emerald-200 hover:text-emerald-700"
                title={`Restore '${name}' chip`}
                data-testid={`restore-supplier-${name}`}
              >
                <span className="line-through text-gray-400">{name}</span>
                <span className="text-emerald-600 font-medium">↶ restore</span>
              </button>
            );
          })}
        </div>
      )}

      {/* Category Coverage Banner — shown when the "Needs Category" filter is active
          or the backfill preview has been run. Explains the router routing and offers
          a one-click auto-classifier. */}
      {(statusFilter === 'needs_category' || backfillPreview) && (
        <div className="bg-teal-50 border border-teal-200 rounded-lg p-3 flex items-start gap-3">
          <Grid3X3 className="w-5 h-5 text-teal-600 mt-0.5" />
          <div className="flex-1">
            <p className="text-sm font-semibold text-teal-900">Category Coverage</p>
            <p className="text-xs text-teal-700 mt-0.5">
              Products with a category assigned automatically open in the matching Manager (Materials / Tiles / Flooring…). Products without a category stay in this legacy editor. Run the auto-classifier to fill in the blanks.
            </p>
            {backfillPreview && backfillPreview.counts && (
              <div className="mt-2 grid grid-cols-3 sm:grid-cols-6 gap-2 text-[11px]">
                {Object.entries(backfillPreview.counts).map(([grp, count]) => (
                  <div key={grp} className={`px-2 py-1 rounded ${grp === 'unclassified' ? 'bg-amber-100 text-amber-800' : grp === 'already_set' ? 'bg-gray-100 text-gray-700' : 'bg-white border border-teal-200 text-teal-800'}`}>
                    <div className="font-semibold">{count}</div>
                    <div className="capitalize truncate">{grp.replace(/_/g, ' ')}</div>
                  </div>
                ))}
              </div>
            )}
          </div>
          <div className="flex flex-col gap-1">
            <Button
              size="sm"
              variant="outline"
              onClick={() => runBackfillProductGroup({ dryRun: true })}
              disabled={backfillRunning}
              className="text-teal-700 border-teal-300 hover:bg-teal-100"
              data-testid="backfill-preview-btn"
            >
              {backfillRunning ? <RefreshCw className="w-3.5 h-3.5 mr-1 animate-spin" /> : <Eye className="w-3.5 h-3.5 mr-1" />}
              Preview
            </Button>
            {backfillPreview && (
              <Button
                size="sm"
                onClick={() => {
                  const c = backfillPreview.counts;
                  const total = (c.tiles||0)+(c.materials||0)+(c.flooring||0)+(c.bathroom||0)+(c.underfloor_heating||0)+(c.tools||0);
                  if (window.confirm(`Apply auto-classification to ${total} products?`)) {
                    runBackfillProductGroup({ dryRun: false });
                  }
                }}
                disabled={backfillRunning}
                className="bg-teal-600 hover:bg-teal-700 text-white"
                data-testid="backfill-apply-btn"
              >
                Apply
              </Button>
            )}
          </div>
        </div>
      )}

      {/* Stats Cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <Card>
          <CardContent className="pt-4">
            <p className="text-sm text-gray-500">Total Products</p>
            <p className="text-2xl font-bold">{totalProducts}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4">
            <p className="text-sm text-gray-500">With Prices</p>
            <p className="text-2xl font-bold text-green-600">
              {supplierStats.withPrices}
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4">
            <p className="text-sm text-gray-500">In Stock</p>
            <p className="text-2xl font-bold text-blue-600">
              {supplierStats.inStock}
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4">
            <p className="text-sm text-gray-500">Out of Stock</p>
            <p className="text-2xl font-bold text-red-600">
              {supplierStats.outOfStock}
            </p>
          </CardContent>
        </Card>
        <Card 
          className={`cursor-pointer transition-all hover:ring-2 hover:ring-rose-300 ${statusFilter === 'on_sale' ? 'ring-2 ring-rose-500 bg-rose-50' : ''}`}
          onClick={() => setStatusFilter(statusFilter === 'on_sale' ? '' : 'on_sale')}
        >
          <CardContent className="pt-4">
            <p className="text-sm text-gray-500 flex items-center gap-1">
              <Tag className="w-3 h-3" /> On Sale
            </p>
            <p className="text-2xl font-bold text-rose-600">
              {products.filter(p => p.sale_active).length}
            </p>
          </CardContent>
        </Card>
      </div>

      {/* Search and Filters */}
      <Card>
        <CardContent className="pt-4">
          <div className="flex flex-col lg:flex-row gap-4">
            <div className="flex-1 relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
              <Input
                placeholder="Search by name, code, or category..."
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                className="pl-10"
                data-testid="search-input"
              />
            </div>
            <div className="flex gap-2">
              {/* Series Filter Dropdown */}
              <select
                value={seriesFilter}
                onChange={(e) => setSeriesFilter(e.target.value)}
                className="px-3 py-2 rounded-md border border-input bg-background text-sm min-w-[180px]"
                data-testid="series-filter"
              >
                <option value="">All Series ({seriesOptions.length})</option>
                {seriesOptions.map(({ name, count }) => (
                  <option key={name} value={name}>
                    {name} ({count})
                  </option>
                ))}
              </select>
              
              {/* Status Filter Dropdown */}
              <select
                value={statusFilter}
                onChange={(e) => setStatusFilter(e.target.value)}
                className="px-3 py-2 rounded-md border border-input bg-background text-sm"
                data-testid="status-filter"
              >
                <option value="">All Status</option>
                <optgroup label="Category Coverage">
                  <option value="needs_category">⚠️ Needs Category (unclassified)</option>
                </optgroup>
                <optgroup label="Website Status">
                  <option value="published">🌐 Published (Live)</option>
                  <option value="not_published">📝 Not Published</option>
                </optgroup>
                <optgroup label="Stock Status">
                  <option value="in_stock">In Stock</option>
                  <option value="low_stock">Low Stock</option>
                  <option value="out_of_stock">Out of Stock</option>
                  <option value="always_in_stock">Always In Stock</option>
                </optgroup>
                <optgroup label="Sale & Labels">
                  <option value="on_sale">On Sale</option>
                  <option value="has_labels">Has Labels</option>
                  {allLabelNames.map(label => (
                    <option key={label} value={`label:${label}`}>{label}</option>
                  ))}
                </optgroup>
              </select>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Products Table */}
      <Card>
        <CardContent className="p-0">
          {/* Selection Info Bar */}
          {selectedProducts.size > 0 && (
            <div className="bg-blue-50 border-b border-blue-200 px-4 py-2 flex items-center justify-between">
              <div className="flex items-center gap-3">
                <span className="font-medium text-blue-800">
                  {selectedProducts.size} product{selectedProducts.size !== 1 ? 's' : ''} selected
                </span>
                {searchTerm && (
                  <span className="text-sm text-blue-600">
                    (from {filteredProducts.length} filtered results)
                  </span>
                )}
              </div>
              <div className="flex items-center gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  className="text-blue-600 border-blue-300 hover:bg-blue-100"
                  onClick={() => setSelectedProducts(new Set(filteredProducts.map(p => getProductKey(p))))}
                >
                  <CheckSquare className="w-3 h-3 mr-1" />
                  Select All {filteredProducts.length}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="text-gray-500 hover:text-red-600"
                  onClick={() => setSelectedProducts(new Set())}
                >
                  <X className="w-4 h-4 mr-1" />
                  Clear
                </Button>
              </div>
            </div>
          )}
          {loading ? (
            <div className="flex items-center justify-center py-12">
              <RefreshCw className="w-8 h-8 animate-spin text-gray-400" />
            </div>
          ) : filteredProducts.length === 0 ? (
            <div className="text-center py-12">
              <Package className="w-12 h-12 mx-auto text-gray-300 mb-3" />
              <p className="text-gray-500">No products found</p>
              <p className="text-sm text-gray-400">Try changing your search or filter</p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="bg-gray-50 border-b">
                    {/* Checkbox column with dropdown - Super Admin only */}
                    {isSuperAdmin && (
                      <th className="w-14 py-3 px-2">
                        <div className="flex items-center gap-1">
                          <input
                            type="checkbox"
                            checked={filteredProducts.length > 0 && selectedProducts.size === filteredProducts.length}
                            onChange={toggleSelectAll}
                            className="rounded border-gray-300"
                            title="Select all filtered"
                            data-testid="select-all-checkbox"
                          />
                          <div className="relative group">
                            <button 
                              className="p-0.5 hover:bg-gray-200 rounded"
                              title="Selection options"
                            >
                              <ChevronDown className="w-3 h-3 text-gray-500" />
                            </button>
                            <div className="absolute left-0 top-full mt-1 bg-white border border-gray-200 rounded-lg shadow-lg py-1 z-50 min-w-[180px] hidden group-hover:block">
                              <button
                                onClick={() => setSelectedProducts(new Set(filteredProducts.map(p => getProductKey(p))))}
                                className="w-full text-left px-3 py-1.5 text-sm hover:bg-gray-100 flex items-center gap-2"
                              >
                                <CheckSquare className="w-4 h-4 text-blue-500" />
                                Select All Filtered ({filteredProducts.length})
                              </button>
                              <button
                                onClick={() => setSelectedProducts(new Set(products.map(p => getProductKey(p))))}
                                className="w-full text-left px-3 py-1.5 text-sm hover:bg-gray-100 flex items-center gap-2"
                              >
                                <CheckSquare className="w-4 h-4 text-green-500" />
                                Select All Products ({products.length})
                              </button>
                              <div className="border-t my-1"></div>
                              <button
                                onClick={() => {
                                  const saleProducts = filteredProducts.filter(p => p.sale_active);
                                  setSelectedProducts(new Set(saleProducts.map(p => getProductKey(p))));
                                }}
                                className="w-full text-left px-3 py-1.5 text-sm hover:bg-gray-100 flex items-center gap-2"
                              >
                                <Tag className="w-4 h-4 text-red-500" />
                                Select On Sale Only
                              </button>
                              <button
                                onClick={() => {
                                  const labeledProducts = filteredProducts.filter(p => (p.labels && p.labels.length > 0) || (p.custom_labels && p.custom_labels.length > 0));
                                  setSelectedProducts(new Set(labeledProducts.map(p => getProductKey(p))));
                                }}
                                className="w-full text-left px-3 py-1.5 text-sm hover:bg-gray-100 flex items-center gap-2"
                              >
                                <Flag className="w-4 h-4 text-purple-500" />
                                Select With Labels
                              </button>
                              <button
                                onClick={() => {
                                  const noLabelsProducts = filteredProducts.filter(p => !p.labels?.length && !p.custom_labels?.length && !p.sale_active);
                                  setSelectedProducts(new Set(noLabelsProducts.map(p => getProductKey(p))));
                                }}
                                className="w-full text-left px-3 py-1.5 text-sm hover:bg-gray-100 flex items-center gap-2"
                              >
                                <Package className="w-4 h-4 text-gray-500" />
                                Select Without Labels
                              </button>
                              <div className="border-t my-1"></div>
                              <button
                                onClick={() => setSelectedProducts(new Set())}
                                className="w-full text-left px-3 py-1.5 text-sm hover:bg-gray-100 flex items-center gap-2 text-red-600"
                              >
                                <X className="w-4 h-4" />
                                Clear Selection
                              </button>
                            </div>
                          </div>
                        </div>
                        {selectedProducts.size > 0 && (
                          <span className="block text-xs text-blue-600 font-medium mt-0.5">
                            {selectedProducts.size} selected
                          </span>
                        )}
                      </th>
                    )}
                    <th className="text-left py-3 px-4 font-medium text-gray-600 text-sm">Product</th>
                    <th className="text-left py-3 px-4 font-medium text-gray-600 text-sm">Code</th>
                    <th className="text-left py-3 px-4 font-medium text-gray-600 text-sm">Category</th>
                    <th className="text-left py-3 px-4 font-medium text-gray-600 text-sm">Finish</th>
                    {hasAction('supplier_products.cost_column') && (
                      <th className="text-right py-3 px-4 font-medium text-gray-600 text-sm">Cost</th>
                    )}
                    <th className="text-right py-3 px-4 font-medium text-gray-600 text-sm">List Price</th>
                    <th className="text-right py-3 px-4 font-medium text-gray-600 text-sm">Stock (m²)</th>
                    {hasAction('supplier_products.live_column') && (
                      <th className="text-center py-3 px-2 font-medium text-gray-600 text-sm" title="Published to storefront">Live</th>
                    )}
                    {hasAction('supplier_products.status_column') && (
                      <th className="text-center py-3 px-4 font-medium text-gray-600 text-sm">Status</th>
                    )}
                    <th className="text-center py-3 px-4 font-medium text-gray-600 text-sm">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredProducts.map((product, idx) => {
                    const currentSeries = getSeriesName(product);
                    const prevSeries = idx > 0 ? getSeriesName(filteredProducts[idx - 1]) : null;
                    const isNewSeries = idx === 0 || currentSeries !== prevSeries;
                    const seriesCount = filteredProducts.filter(p => getSeriesName(p) === currentSeries).length;
                    // A "named series" gets its own header even if it's a singleton.
                    // Only truly nameless products fall into the "Individual Products" bucket.
                    const isMultiProductSeries = Boolean(currentSeries && currentSeries.trim());
                    
                    return (
                      <React.Fragment key={`${product.sku}-${idx}`}>
                        {/* Series Header Row - only show for multi-product series */}
                        {isNewSeries && isMultiProductSeries && (
                          <tr className="bg-gradient-to-r from-slate-100 to-slate-50 border-t-2 border-slate-300">
                            <td colSpan={isSuperAdmin ? 13 : 12} className="py-2 px-4">
                              <div className="flex items-center gap-3">
                                {/* Series Selection Checkbox - Super Admin only */}
                                {isSuperAdmin && (
                                  <input
                                    type="checkbox"
                                    checked={isSeriesSelected(currentSeries)}
                                    ref={el => {
                                      if (el) el.indeterminate = isSeriesPartiallySelected(currentSeries);
                                    }}
                                    onChange={() => toggleSeriesSelection(currentSeries)}
                                    className="rounded border-gray-300 w-4 h-4"
                                    title={`Select all ${seriesCount} products in ${currentSeries} Series`}
                                  />
                                )}
                                <Layers className="w-4 h-4 text-slate-600" />
                                <span className="font-semibold text-slate-700">{currentSeries} Series</span>
                                <span className="text-xs bg-slate-200 text-slate-600 px-2 py-0.5 rounded-full">
                                  {seriesCount} products
                                </span>
                                {/* Show selected count for this series */}
                                {isSuperAdmin && (() => {
                                  const seriesProducts = filteredProducts.filter(p => getSeriesName(p) === currentSeries);
                                  const selectedInSeries = seriesProducts.filter(p => selectedProducts.has(getProductKey(p))).length;
                                  return selectedInSeries > 0 ? (
                                    <span className="text-xs bg-blue-100 text-blue-700 px-2 py-0.5 rounded-full">
                                      {selectedInSeries} selected
                                    </span>
                                  ) : null;
                                })()}
                              </div>
                            </td>
                          </tr>
                        )}
                        {/* Individual Products separator — shows once when we cross
                            from named series into the truly nameless bucket. */}
                        {isNewSeries && !isMultiProductSeries && idx > 0 && (() => {
                          const prev = filteredProducts[idx - 1];
                          const prevName = getSeriesName(prev);
                          return prevName && prevName.trim();
                        })() && (
                          <tr className="bg-gradient-to-r from-amber-50 to-orange-50 border-t-2 border-amber-300">
                            <td colSpan={isSuperAdmin ? 13 : 12} className="py-2 px-4">
                              <div className="flex items-center gap-3">
                                <Package className="w-4 h-4 text-amber-600" />
                                <span className="font-semibold text-amber-700">Individual Products</span>
                                <span className="text-xs bg-amber-200 text-amber-700 px-2 py-0.5 rounded-full">
                                  {selectedSupplier === 'Canopy' ? 'Sorted by Material & Type' : 'Sorted by size'}
                                </span>
                              </div>
                            </td>
                          </tr>
                        )}
                        <tr 
                          className={`border-b hover:bg-gray-50 ${isNewProduct(product) ? 'bg-green-50 border-l-4 border-l-green-500' : ''} ${isProductSelected(product) ? 'bg-blue-50' : ''} ${isMultiProductSeries ? 'border-l-2 border-l-slate-300' : ''}`}
                        >
                      {/* Checkbox - Super Admin only */}
                      {isSuperAdmin && (
                        <td className="py-3 px-2">
                          <input
                            type="checkbox"
                            checked={isProductSelected(product)}
                            onChange={() => toggleProductSelection(product)}
                            className="rounded border-gray-300"
                          />
                        </td>
                      )}
                      <td className="py-3 px-4">
                        <div className="flex items-center gap-3">
                          {product.image ? (
                            <div className="relative group cursor-pointer" onClick={() => {
                              // Get all images for this product
                              const allImages = product.images && product.images.length > 0 
                                ? product.images 
                                : [product.image];
                              setPreviewImages({
                                images: allImages,
                                currentIndex: 0,
                                name: product.product_name || product.name,
                                sku: product.sku,
                                supplier: product.supplier
                              });
                            }}>
                              <img 
                                src={product.image} 
                                alt={product.product_name || product.name}
                                className="w-10 h-10 object-cover cursor-pointer transition-transform duration-200 group-hover:scale-150 group-hover:z-50 group-hover:shadow-xl"
                                onError={(e) => e.target.style.display = 'none'}
                              />
                              {/* Image count badge */}
                              {product.images && product.images.length > 1 && (
                                <span className="absolute -top-1 -right-1 bg-blue-600 text-white text-xs w-4 h-4 flex items-center justify-center font-bold">
                                  {product.images.length}
                                </span>
                              )}
                            </div>
                          ) : (
                            <div className="w-10 h-10 bg-gray-100 flex items-center justify-center">
                              <Package className="w-5 h-5 text-gray-400" />
                            </div>
                          )}
                          <div>
                            <div className="flex items-center gap-2">
                              <p 
                                className={`font-medium text-gray-900 cursor-pointer ${expandedNameId === (product.sku || product.supplier_code || product.name) ? '' : 'line-clamp-1'}`}
                                title={product.product_name || product.name || ''}
                                onClick={(e) => { e.stopPropagation(); setExpandedNameId(prev => prev === (product.sku || product.supplier_code || product.name) ? null : (product.sku || product.supplier_code || product.name)); }}
                                data-testid={`product-name-${product.sku || product.supplier_code}`}
                              >
                                {product.product_name || product.name}
                              </p>
                              {/* Published/Live Badge */}
                              {product.show_on_website && (
                                <span className="inline-flex items-center gap-1 bg-green-100 text-green-700 text-xs px-2 py-0.5 rounded-full font-medium border border-green-300">
                                  <Globe className="w-3 h-3" />
                                  Live
                                </span>
                              )}
                              {isNewProduct(product) && (
                                <span className="inline-flex items-center gap-1 bg-green-500 text-white text-xs px-2 py-0.5 rounded-full font-medium">
                                  <Sparkles className="w-3 h-3" />
                                  NEW
                                </span>
                              )}
                              {product.made_in && (
                                <span className={`inline-flex items-center text-xs px-2 py-0.5 rounded-full font-medium ${
                                  product.made_in === 'Italy' ? 'bg-green-100 text-green-700' :
                                  product.made_in === 'Spain' ? 'bg-red-100 text-red-700' :
                                  product.made_in === 'Europe' ? 'bg-blue-100 text-blue-700' :
                                  product.made_in === 'Poland' ? 'bg-pink-100 text-pink-700' :
                                  product.made_in === 'India' ? 'bg-orange-100 text-orange-700' :
                                  'bg-gray-100 text-gray-700'
                                }`}>
                                  {product.made_in === 'Italy' && '🇮🇹'}
                                  {product.made_in === 'Spain' && '🇪🇸'}
                                  {product.made_in === 'Europe' && '🇪🇺'}
                                  {product.made_in === 'Poland' && '🇵🇱'}
                                  {product.made_in === 'India' && '🇮🇳'}
                                  {' '}{product.made_in}
                                </span>
                              )}
                              {/* Draft/Pending Approval Badge - only show if NOT already in products database */}
                              {!product.in_products_db && (product.status === 'pending_approval' || product.visibility === 'draft') && (
                                <span className="inline-flex items-center gap-1 bg-amber-100 text-amber-700 text-xs px-2 py-0.5 rounded-full font-medium border border-amber-200">
                                  <Eye className="w-3 h-3" />
                                  DRAFT
                                </span>
                              )}
                              {/* Recently Updated Badge - shows for recently updated or dimension-fixed products */}
                              {(product.recently_updated || product.dimension_fix_applied || 
                                (product.updated_at && new Date(product.updated_at) > new Date(Date.now() - 24 * 60 * 60 * 1000)) ||
                                (product.dimension_fix_date && new Date(product.dimension_fix_date) > new Date(Date.now() - 7 * 24 * 60 * 60 * 1000))) && (
                                <span className="inline-flex items-center gap-1 bg-blue-100 text-blue-700 text-xs px-2 py-0.5 rounded-full font-medium border border-blue-300">
                                  <RefreshCw className="w-3 h-3" />
                                  Updated
                                </span>
                              )}
                            </div>
                            {/* Sale/Clearance Labels */}
                            {((product.labels && product.labels.length > 0) || (product.custom_labels && product.custom_labels.length > 0) || product.sale_active) && (
                              <div className="flex flex-wrap gap-1 mt-1">
                                {product.sale_active && (
                                  <span className="inline-flex items-center gap-1 bg-red-500 text-white text-xs px-2 py-0.5 rounded-full font-medium animate-pulse">
                                    <BadgePercent className="w-3 h-3" />
                                    {product.discount_percentage ? `${product.discount_percentage}% OFF` : 'SALE'}
                                  </span>
                                )}
                                {product.labels?.map((label, idx) => (
                                  <span key={idx} className={`inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full font-medium ${
                                    label === 'Sale' ? 'bg-red-100 text-red-700' :
                                    label === 'Clearance' ? 'bg-orange-100 text-orange-700' :
                                    label === 'New Arrival' ? 'bg-blue-100 text-blue-700' :
                                    label === 'Limited Stock' ? 'bg-yellow-100 text-yellow-700' :
                                    label === 'Best Seller' ? 'bg-purple-100 text-purple-700' :
                                    'bg-gray-100 text-gray-700'
                                  }`}>
                                    {label === 'Sale' && <Tag className="w-3 h-3" />}
                                    {label === 'Clearance' && <Percent className="w-3 h-3" />}
                                    {label === 'New Arrival' && <Zap className="w-3 h-3" />}
                                    {label === 'Limited Stock' && <AlertCircle className="w-3 h-3" />}
                                    {label === 'Best Seller' && <Star className="w-3 h-3" />}
                                    {label}
                                  </span>
                                ))}
                                {product.custom_labels?.map((label, idx) => (
                                  <span key={`custom-${idx}`} className="inline-flex items-center gap-1 bg-indigo-100 text-indigo-700 text-xs px-2 py-0.5 rounded-full font-medium">
                                    <Tag className="w-3 h-3" />
                                    {label}
                                  </span>
                                ))}
                              </div>
                            )}
                            {/* Show original supplier product name - consolidated display */}
                            {(() => {
                              // For Canopy products, prefer original_series; for others, use supplier_product_name
                              const originalName = product.supplier === 'Canopy' 
                                ? (product.original_series || product.supplier_product_name)
                                : product.supplier_product_name;
                              
                              // Build name history chain
                              const nameHistory = [];
                              if (product.name_history && product.name_history.length > 0) {
                                nameHistory.push(...product.name_history);
                              }
                              // Add current names to history if they're different
                              const currentNames = [
                                product.name,
                                product.supplier_product_name,
                                product.our_product_name,
                                product.product_name
                              ].filter((n, i, arr) => n && arr.indexOf(n) === i && n.toLowerCase() !== (product.product_name || '').toLowerCase());
                              
                              const hasNameChanges = product.name && product.name.toLowerCase() !== (product.product_name || '').toLowerCase();
                              
                              // When Name Changes filter is active, show collapsible history
                              if (showNameMismatches && hasNameChanges) {
                                return (
                                  <div className="mt-1">
                                    {/* Compact display - always visible */}
                                    <div className="flex items-center gap-2 text-xs">
                                      <span className="text-gray-500">{product.supplier}:</span>
                                      <span className="font-medium text-amber-700">{product.supplier_product_name || product.name?.split(' ')[0]}</span>
                                      <ArrowRight className="w-3 h-3 text-gray-400" />
                                      <span className="font-medium text-green-700">{product.product_name}</span>
                                      {/* History toggle button */}
                                      <button
                                        type="button"
                                        onClick={(e) => {
                                          e.stopPropagation();
                                          const historyEl = e.currentTarget.parentElement.nextElementSibling;
                                          if (historyEl) historyEl.classList.toggle('hidden');
                                        }}
                                        className="ml-1 px-1.5 py-0.5 bg-amber-100 hover:bg-amber-200 text-amber-700 rounded text-xs font-medium transition-colors"
                                        title="Show name change history"
                                      >
                                        <Clock className="w-3 h-3 inline mr-0.5" />
                                        History
                                      </button>
                                    </div>
                                    
                                    {/* Expandable history dropdown - hidden by default */}
                                    <div className="hidden mt-2 p-2 bg-slate-50 border border-slate-200 rounded-lg text-xs">
                                      <div className="font-semibold text-slate-700 mb-2 flex items-center gap-1">
                                        <Clock className="w-3 h-3" />
                                        Name Change History
                                      </div>
                                      <div className="space-y-1.5">
                                        {/* Original supplier name */}
                                        <div className="flex items-center gap-2 p-1.5 bg-amber-50 rounded border-l-2 border-amber-400">
                                          <span className="text-amber-600 font-medium min-w-[80px]">Original:</span>
                                          <span className="text-amber-800">{product.name}</span>
                                          {isSuperAdmin && product.name_history?.length > 0 && (
                                            <button
                                              type="button"
                                              onClick={(e) => {
                                                e.stopPropagation();
                                                handleDeleteNameHistory(product, 'name');
                                              }}
                                              className="ml-auto p-0.5 text-red-400 hover:text-red-600 hover:bg-red-50 rounded"
                                              title="Delete this history entry (Super Admin)"
                                            >
                                              <Trash2 className="w-3 h-3" />
                                            </button>
                                          )}
                                        </div>
                                        
                                        {/* Short name if different */}
                                        {product.supplier_product_name && product.supplier_product_name !== product.name?.split(' ')[0] && (
                                          <div className="flex items-center gap-2 p-1.5 bg-orange-50 rounded border-l-2 border-orange-400">
                                            <ArrowRight className="w-3 h-3 text-orange-400" />
                                            <span className="text-orange-600 font-medium min-w-[80px]">Short:</span>
                                            <span className="text-orange-800">{product.supplier_product_name}</span>
                                          </div>
                                        )}
                                        
                                        {/* Our internal name if different */}
                                        {product.our_product_name && product.our_product_name !== product.product_name && (
                                          <div className="flex items-center gap-2 p-1.5 bg-purple-50 rounded border-l-2 border-purple-400">
                                            <ArrowRight className="w-3 h-3 text-purple-400" />
                                            <span className="text-purple-600 font-medium min-w-[80px]">Internal:</span>
                                            <span className="text-purple-800">{product.our_product_name}</span>
                                            {isSuperAdmin && (
                                              <button
                                                type="button"
                                                onClick={(e) => {
                                                  e.stopPropagation();
                                                  handleDeleteNameHistory(product, 'our_product_name');
                                                }}
                                                className="ml-auto p-0.5 text-red-400 hover:text-red-600 hover:bg-red-50 rounded"
                                                title="Delete this history entry (Super Admin)"
                                              >
                                                <Trash2 className="w-3 h-3" />
                                              </button>
                                            )}
                                          </div>
                                        )}
                                        
                                        {/* Additional history entries from name_history array */}
                                        {product.name_history?.map((entry, idx) => (
                                          <div key={idx} className="flex items-center gap-2 p-1.5 bg-slate-100 rounded border-l-2 border-slate-400">
                                            <ArrowRight className="w-3 h-3 text-slate-400" />
                                            <span className="text-slate-500 text-[10px]">{entry.changed_at ? new Date(entry.changed_at).toLocaleDateString() : ''}</span>
                                            <span className="text-slate-600">{entry.from}</span>
                                            <ArrowRight className="w-3 h-3 text-slate-400" />
                                            <span className="text-slate-800">{entry.to}</span>
                                            {isSuperAdmin && (
                                              <button
                                                type="button"
                                                onClick={(e) => {
                                                  e.stopPropagation();
                                                  handleDeleteNameHistory(product, 'history', idx);
                                                }}
                                                className="ml-auto p-0.5 text-red-400 hover:text-red-600 hover:bg-red-50 rounded"
                                                title="Delete this history entry (Super Admin)"
                                              >
                                                <Trash2 className="w-3 h-3" />
                                              </button>
                                            )}
                                          </div>
                                        ))}
                                        
                                        {/* Current display name */}
                                        <div className="flex items-center gap-2 p-1.5 bg-green-50 rounded border-l-2 border-green-500">
                                          <ArrowRight className="w-3 h-3 text-green-500" />
                                          <span className="text-green-600 font-medium min-w-[80px]">Display:</span>
                                          <span className="text-green-800 font-semibold">{product.product_name}</span>
                                          <span className="ml-auto text-green-500 text-[10px]">CURRENT</span>
                                        </div>
                                      </div>
                                    </div>
                                  </div>
                                );
                              }
                              
                              // Only show if it's different from the display name
                              if (!originalName || originalName === product.product_name) {
                                // Show the supplier product name as the subtitle
                                // Skip product.name if it matches display name (means it was previously overwritten)
                                const displayName = product.product_name || product.display_name || '';
                                let subtitleName = product.supplier_product_name || product.original_series || '-';
                                if (subtitleName === '-' && product.name && product.name !== displayName) {
                                  subtitleName = product.name;
                                }
                                return (
                                  <p 
                                    className="text-xs text-gray-400 line-clamp-1"
                                    title={`${product.supplier}: ${subtitleName}`}
                                  >
                                    <span className="font-medium text-gray-500">{product.supplier}:</span> {subtitleName}
                                  </p>
                                );
                              }
                              
                              return (
                                <p 
                                  className="text-xs text-gray-400 line-clamp-1"
                                  title={`${product.supplier}: ${originalName}`}
                                >
                                  <span className={`font-medium ${product.supplier === 'Canopy' ? 'text-amber-600' : 'text-gray-500'}`}>
                                    {product.supplier}:
                                  </span> {originalName}
                                  {(product.original_supplier_code || product.supplier_code) && (
                                    <span className="ml-2 font-mono text-purple-500">
                                      [{product.original_supplier_code || product.supplier_code}]
                                    </span>
                                  )}
                                </p>
                              );
                            })()}
                            {selectedSupplier === 'all' && (
                              <p className="text-xs text-gray-500">{product.supplier}</p>
                            )}
                          </div>
                        </div>
                      </td>
                      <td className="py-3 px-4">
                        <span className="font-mono text-sm text-gray-600">{product.sku || product.supplier_code || '-'}</span>
                      </td>
                      <td className="py-3 px-4 text-sm text-gray-600">
                        {product.category || '-'}
                      </td>
                      <td className="py-3 px-4 text-sm text-gray-600">
                        {product.finish || '-'}
                      </td>
                      {/* Cost column — click to edit */}
                      {hasAction('supplier_products.cost_column') && (
                        <td className="py-3 px-4 text-right">
                          {priceEdit && priceEdit.key === (product.sku || product.supplier_code) && priceEdit.field === 'cost_price' ? (
                            <input
                              autoFocus
                              type="number"
                              step="0.01"
                              min="0"
                              value={priceEdit.value}
                              onChange={(e) => setPriceEdit(prev => ({ ...prev, value: e.target.value }))}
                              onKeyDown={(e) => { if (e.key === 'Enter') commitPriceEdit(); if (e.key === 'Escape') setPriceEdit(null); }}
                              onBlur={commitPriceEdit}
                              className="w-20 px-1.5 py-0.5 text-right text-sm border border-blue-400 rounded"
                              data-testid={`cost-input-${product.sku || product.supplier_code}`}
                            />
                          ) : (
                            <button
                              type="button"
                              onClick={() => setPriceEdit({ key: product.sku || product.supplier_code, field: 'cost_price', value: product.cost_price ?? '' })}
                              className="hover:bg-blue-50 hover:ring-1 hover:ring-blue-200 rounded px-1.5 py-0.5 transition-colors"
                              title="Click to edit cost"
                              data-testid={`cost-cell-${product.sku || product.supplier_code}`}
                            >
                              {product.size_unit === 'each' && product.cost_each && !isNaN(Number(product.cost_each)) ? (
                                <span className="text-gray-500">£{Number(product.cost_each).toFixed(2)} <span className="text-xs text-gray-400">/ea</span></span>
                              ) : product.cost_price && !isNaN(Number(product.cost_price)) ? (
                                <span className="text-gray-500">£{Number(product.cost_price).toFixed(2)}</span>
                              ) : product.cost_m2 && !isNaN(Number(product.cost_m2)) ? (
                                <span className="text-gray-500">£{Number(product.cost_m2).toFixed(2)}</span>
                              ) : (
                                <span className="text-gray-300">—</span>
                              )}
                            </button>
                          )}
                          {product.last_cost_change && (
                            <button
                              type="button"
                              onClick={(e) => { e.stopPropagation(); acknowledgeCostChange(product); }}
                              className={`mt-0.5 inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[10px] font-semibold whitespace-nowrap ${
                                Number(product.last_cost_change.to) > Number(product.last_cost_change.from)
                                  ? 'bg-red-100 text-red-700 hover:bg-red-200'
                                  : 'bg-green-100 text-green-700 hover:bg-green-200'
                              }`}
                              title={`Cost changed from £${Number(product.last_cost_change.from).toFixed(2)} to £${Number(product.last_cost_change.to).toFixed(2)} — click to dismiss`}
                              data-testid={`cost-change-badge-${product.sku || product.supplier_code}`}
                            >
                              {Number(product.last_cost_change.to) > Number(product.last_cost_change.from) ? '▲' : '▼'} £{Number(product.last_cost_change.from).toFixed(2)}→£{Number(product.last_cost_change.to).toFixed(2)}
                            </button>
                          )}
                          {(() => {
                            const m = getMarginPercent(product);
                            if (m === null || marginFloor === null || m >= marginFloor) return null;
                            return (
                              <span
                                className="mt-0.5 inline-block px-1.5 py-0.5 rounded text-[10px] font-bold bg-red-600 text-white whitespace-nowrap"
                                title={`Margin ${m}% is below your ${marginFloor}% floor — raise the list price or check the cost`}
                                data-testid={`margin-alert-${product.sku || product.supplier_code}`}
                              >
                                M {m}%
                              </span>
                            );
                          })()}
                        </td>
                      )}
                      <td className="py-3 px-4 text-right">
                        {priceEdit && priceEdit.key === (product.sku || product.supplier_code) && priceEdit.field === 'price' ? (
                          <input
                            autoFocus
                            type="number"
                            step="0.01"
                            min="0"
                            value={priceEdit.value}
                            onChange={(e) => setPriceEdit(prev => ({ ...prev, value: e.target.value }))}
                            onKeyDown={(e) => { if (e.key === 'Enter') commitPriceEdit(); if (e.key === 'Escape') setPriceEdit(null); }}
                            onBlur={commitPriceEdit}
                            className="w-20 px-1.5 py-0.5 text-right text-sm border border-blue-400 rounded"
                            data-testid={`price-input-${product.sku || product.supplier_code}`}
                          />
                        ) : (
                          <button
                            type="button"
                            onClick={() => setPriceEdit({ key: product.sku || product.supplier_code, field: 'price', value: product.price ?? '' })}
                            className="hover:bg-blue-50 hover:ring-1 hover:ring-blue-200 rounded px-1.5 py-0.5 transition-colors"
                            title="Click to edit list price"
                            data-testid={`price-cell-${product.sku || product.supplier_code}`}
                          >
                            {product.sale_active && product.now_price ? (
                              <div className="space-y-0.5">
                                <div className="flex items-center justify-end gap-1">
                                  <span className="text-xs text-gray-400 line-through">
                                    £{Number(product.was_price || product.price).toFixed(2)}
                                  </span>
                                  <span className="text-xs bg-red-100 text-red-600 px-1 rounded">
                                    -{product.discount_percentage}%
                                  </span>
                                </div>
                                <span className="font-bold text-red-600">£{Number(product.now_price).toFixed(2)}</span>
                              </div>
                            ) : product.price && !isNaN(Number(product.price)) ? (
                              <span className="font-semibold text-green-600">£{Number(product.price).toFixed(2)}</span>
                            ) : (
                              <span className="text-gray-400">—</span>
                            )}
                          </button>
                        )}
                      </td>
                      <td className="py-3 px-4 text-right">
                        {product.stock_m2 ? (
                          <span className="font-medium">{Number(product.stock_m2).toFixed(1)} m²</span>
                        ) : product.stock_quantity ? (
                          <span className="font-medium">{product.stock_quantity}</span>
                        ) : (
                          <span className="text-gray-400">-</span>
                        )}
                      </td>
                      {/* Publish Status - Live on storefront indicator */}
                      {hasAction('supplier_products.live_column') && (
                      <td className="py-3 px-2 text-center">
                        {product.show_on_website ? (
                          <button 
                            onClick={() => handleTogglePublish(product)}
                            className="inline-flex items-center gap-1 px-1.5 py-0.5 text-xs font-medium rounded-full bg-emerald-100 text-emerald-700 hover:bg-red-100 hover:text-red-600 transition-colors cursor-pointer group"
                            title="Click to unpublish from storefront"
                            data-testid={`publish-status-live-${product.sku || product.supplier_code}`}
                          >
                            <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse group-hover:bg-red-500 group-hover:animate-none"></span>
                            <span className="group-hover:hidden">Live</span>
                            <span className="hidden group-hover:inline">Unpublish</span>
                          </button>
                        ) : (
                          <button 
                            onClick={() => handleTogglePublish(product)}
                            className="inline-flex items-center gap-1 px-1.5 py-0.5 text-xs font-medium rounded-full bg-gray-100 text-gray-500 hover:bg-emerald-100 hover:text-emerald-700 transition-colors cursor-pointer group"
                            title="Click to publish to storefront"
                            data-testid={`publish-status-draft-${product.sku || product.supplier_code}`}
                          >
                            <span className="w-1.5 h-1.5 rounded-full bg-gray-400 group-hover:bg-emerald-500"></span>
                            <span className="group-hover:hidden">Draft</span>
                            <span className="hidden group-hover:inline">Publish</span>
                          </button>
                        )}
                      </td>
                      )}
                      {hasAction('supplier_products.status_column') && (
                      <td className="py-3 px-4 text-center">
                        {/* Direct stock-status dropdown — all suppliers */}
                        <select
                          value={product.always_in_stock ? 'always_in_stock' : (product.stock_status || (product.in_stock === false ? 'out_of_stock' : 'in_stock'))}
                          onChange={(e) => handleSetStockStatus(product, e.target.value)}
                          className={`text-xs px-2 py-1.5 rounded-full border cursor-pointer font-medium ${
                            product.always_in_stock ? 'bg-blue-100 text-blue-700 border-blue-300' :
                            product.stock_status === 'out_of_stock' || (!product.stock_status && product.in_stock === false) ? 'bg-red-100 text-red-700 border-red-300' :
                            product.stock_status === 'low_stock' ? 'bg-amber-100 text-amber-700 border-amber-300' :
                            'bg-green-100 text-green-700 border-green-300'
                          }`}
                          title="Click to change stock status — updates the website immediately"
                          data-testid={`stock-status-${product.sku || product.supplier_code || product._id}`}
                        >
                          <option value="in_stock">In Stock</option>
                          <option value="low_stock">Low Stock</option>
                          <option value="out_of_stock">Out of Stock</option>
                          <option value="always_in_stock">Always In Stock</option>
                        </select>
                      </td>
                      )}
                      <td className="py-3 px-4">
                        <div className="flex items-center justify-center gap-1">
                          {/* NOTE (Aug 3 2026): The per-row Visibility dropdown (Online / In-Store / Hidden)
                              and "Always In Stock" checkbox were removed at owner's request — they took
                              space without being used. Set visibility from the row's "Mark Not For Sale"
                              action or the Bulk Actions bar instead. */}
                          {/* Add to Database - only show if NOT already in products database */}
                          {hasAction('supplier_products.action.add_to_db') && !product.in_products_db ? (
                            <Button
                              size="sm"
                              variant="ghost"
                              className="text-blue-600 hover:text-blue-800 hover:bg-blue-50"
                              onClick={() => handleAddToDatabase(product)}
                              title="Add to product database"
                              data-testid={`add-db-${product.sku || product.supplier_code || product._id}`}
                            >
                              <Plus className="w-4 h-4" />
                            </Button>
                          ) : hasAction('supplier_products.action.add_to_db') && product.in_products_db ? (
                            <span className="text-green-500 px-2" title="Already in Products database">
                              <Check className="w-4 h-4" />
                            </span>
                          ) : null}
                          {/* Quick Edit Button - Opens popup modal */}
                          {hasAction('supplier_products.action.quick_edit') && (
                            <Button
                              size="sm"
                              variant="ghost"
                              className="text-amber-600 hover:text-amber-800 hover:bg-amber-50"
                              onClick={() => handleQuickEdit(product)}
                              data-testid={`quick-edit-${product.sku || product.supplier_code || product._id}`}
                              title="Quick edit (popup)"
                            >
                              <PenLine className="w-4 h-4" />
                            </Button>
                          )}
                          {/* Sale/Labels Button */}
                          {hasAction('supplier_products.action.sale_labels') && (
                            <Button
                              size="sm"
                              variant="ghost"
                              className={`hover:bg-rose-50 ${product.sale_active || (product.labels && product.labels.length > 0) ? 'text-rose-600' : 'text-gray-400 hover:text-rose-600'}`}
                              onClick={() => openSaleLabelsModal(product)}
                              data-testid={`sale-labels-${product.sku || product.supplier_code || product._id}`}
                              title="Sale & Labels"
                            >
                              <Tag className="w-4 h-4" />
                            </Button>
                          )}
                          {/* Full Page Edit Button */}
                          {hasAction('supplier_products.action.full_edit') && (
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() => handleEditFullPage(product)}
                              data-testid={`edit-${product.sku || product.supplier_code || product._id}`}
                              title="Edit product (full page)"
                            >
                              <Pencil className="w-4 h-4" />
                            </Button>
                          )}
                          {/* PDF Documents Button */}
                          {hasAction('supplier_products.action.pdf_documents') && (
                            <Button
                              size="sm"
                              variant="ghost"
                              className="text-red-500 hover:text-red-700 hover:bg-red-50"
                              onClick={() => {
                                setDocumentsModalProducts([product]);
                                setShowDocumentsModal(true);
                              }}
                              data-testid={`docs-${product.sku || product.supplier_code || product._id}`}
                              title="Manage PDF documents"
                            >
                              <FileText className="w-4 h-4" />
                            </Button>
                          )}
                          {/* Website Preview Button */}
                          {hasAction('supplier_products.action.preview') && (
                          <Button
                            size="sm"
                            variant="ghost"
                            className="text-green-600 hover:text-green-700 hover:bg-green-50"
                            onClick={() => {
                              const name = product.product_name || product.name || '';
                              const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
                              window.open(`/tiles/${slug}`, '_blank');
                            }}
                            data-testid={`preview-${product.sku || product.supplier_code || product._id}`}
                            title="Preview on website"
                          >
                            <Eye className="w-4 h-4" />
                          </Button>
                          )}
                          {/* Copy Product Button */}
                          {hasAction('supplier_products.action.copy') && (
                            <Button
                              size="sm"
                              variant="ghost"
                              className="text-blue-500 hover:text-blue-700 hover:bg-blue-50"
                              onClick={() => handleCopyProduct(product)}
                              data-testid={`copy-${product.sku || product.supplier_code || product._id}`}
                              title="Copy product (creates draft)"
                            >
                              <Copy className="w-4 h-4" />
                            </Button>
                          )}
                          {hasAction('supplier_products.action.delete') && (
                            <Button
                              size="sm"
                              variant="ghost"
                              className="text-red-500 hover:text-red-700"
                              onClick={() => handleDelete(product)}
                              data-testid={`delete-${product.sku || product.supplier_code || product._id}`}
                              title="Delete product"
                            >
                              <Trash2 className="w-4 h-4" />
                            </Button>
                          )}
                        </div>
                      </td>
                    </tr>
                      </React.Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          {/* Pagination */}
          {totalProducts > 0 && (
            <div className="flex items-center justify-between p-4 border-t">
              <div className="flex items-center gap-4">
                <p className="text-sm text-gray-500">
                  Showing {((currentPage - 1) * productsPerPage) + 1} - {Math.min(currentPage * productsPerPage, totalProducts)} of {totalProducts}
                </p>
                <div className="flex items-center gap-2">
                  <span className="text-sm text-gray-500">Per page:</span>
                  <select
                    value={productsPerPage}
                    onChange={(e) => {
                      const newSize = e.target.value === 'all' ? totalProducts : parseInt(e.target.value);
                      setProductsPerPage(newSize);
                      setCurrentPage(1);
                    }}
                    className="text-sm border rounded px-2 py-1 bg-white"
                  >
                    <option value={50}>50</option>
                    <option value={100}>100</option>
                    <option value={200}>200</option>
                    <option value={500}>500</option>
                    <option value="all">All</option>
                  </select>
                </div>
              </div>
              {totalPages > 1 && (
                <div className="flex gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setCurrentPage(p => Math.max(1, p - 1))}
                    disabled={currentPage === 1}
                  >
                    Previous
                  </Button>
                  <span className="px-3 py-1 text-sm text-gray-600">
                    Page {currentPage} of {totalPages}
                  </span>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setCurrentPage(p => Math.min(totalPages, p + 1))}
                    disabled={currentPage === totalPages}
                  >
                    Next
                  </Button>
                </div>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Add/Edit Product Modal */}
      <Dialog open={showAddModal || showEditModal} onOpenChange={() => { setShowAddModal(false); setShowEditModal(false); setEditingProduct(null); }}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{editingProduct ? 'Edit Product' : 'Add New Product'}</DialogTitle>
          </DialogHeader>
          
          <div className="grid gap-4 py-4">
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="text-sm font-medium">Product Code *</label>
                <Input
                  value={formData.sku}
                  onChange={(e) => setFormData({...formData, sku: e.target.value})}
                  placeholder="e.g., P12345"
                  disabled={!!editingProduct}
                />
              </div>
              <div>
                <label className="text-sm font-medium">Price (£)</label>
                <Input
                  type="number"
                  step="0.01"
                  value={formData.price}
                  onChange={(e) => setFormData({...formData, price: e.target.value})}
                  placeholder="0.00"
                />
              </div>
            </div>
            
            <div>
              <label className="text-sm font-medium">Product Name *</label>
              <Input
                value={formData.name}
                onChange={(e) => setFormData({...formData, name: e.target.value})}
                placeholder="Product name"
              />
            </div>
            
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="text-sm font-medium">Category</label>
                <Input
                  value={formData.category}
                  onChange={(e) => setFormData({...formData, category: e.target.value})}
                  placeholder="e.g., Porcelain | Ceramic"
                />
              </div>
              <div>
                <label className="text-sm font-medium">Material</label>
                <Input
                  value={formData.material}
                  onChange={(e) => setFormData({...formData, material: e.target.value})}
                  placeholder="e.g., Ceramic"
                />
              </div>
            </div>
            
            <div className="grid grid-cols-3 gap-4">
              <div>
                <label className="text-sm font-medium">Length (mm)</label>
                <Input
                  type="number"
                  value={formData.length_mm}
                  onChange={(e) => setFormData({...formData, length_mm: e.target.value})}
                  placeholder="300"
                />
              </div>
              <div>
                <label className="text-sm font-medium">Width (mm)</label>
                <Input
                  type="number"
                  value={formData.width_mm}
                  onChange={(e) => setFormData({...formData, width_mm: e.target.value})}
                  placeholder="600"
                />
              </div>
              <div>
                <label className="text-sm font-medium">Stock Qty</label>
                <Input
                  type="number"
                  value={formData.stock_quantity}
                  onChange={(e) => setFormData({...formData, stock_quantity: e.target.value})}
                  placeholder="0"
                />
              </div>
            </div>
            
            <div>
              <label className="text-sm font-medium">Finish</label>
              <Input
                value={formData.finish}
                onChange={(e) => setFormData({...formData, finish: e.target.value})}
                placeholder="e.g., Matt, Gloss"
              />
            </div>

            <div className="flex items-center gap-2">
              <input
                type="checkbox"
                id="in_stock"
                checked={formData.in_stock}
                onChange={(e) => setFormData({...formData, in_stock: e.target.checked})}
                className="rounded"
              />
              <label htmlFor="in_stock" className="text-sm">In Stock</label>
            </div>
          </div>
          
          <DialogFooter>
            <Button variant="outline" onClick={() => { setShowAddModal(false); setShowEditModal(false); setEditingProduct(null); }}>
              Cancel
            </Button>
            <Button onClick={handleSaveProduct}>
              {editingProduct ? 'Update Product' : 'Add Product'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Bulk Delete Confirmation Dialog */}
      <Dialog open={showBulkDeleteDialog} onOpenChange={() => { setShowBulkDeleteDialog(false); setBulkDeleteConfirm(''); }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-red-600">
              <AlertTriangle className="w-5 h-5" />
              Bulk Delete Products
            </DialogTitle>
          </DialogHeader>
          
          <div className="py-4 space-y-4">
            <div className="p-4 bg-red-50 border border-red-200 rounded-lg">
              <p className="text-red-800 font-medium">
                This will permanently delete ALL {stats[selectedSupplier] || 0} products for {selectedSupplier}.
              </p>
              <p className="text-sm text-red-600 mt-2">
                This action cannot be undone.
              </p>
            </div>
            
            <div>
              <label className="text-sm font-medium text-gray-700">
                Type <span className="font-bold text-red-600">"{selectedSupplier}"</span> to confirm:
              </label>
              <Input
                value={bulkDeleteConfirm}
                onChange={(e) => setBulkDeleteConfirm(e.target.value)}
                placeholder={selectedSupplier}
                className="mt-2"
                data-testid="bulk-delete-confirm-input"
              />
            </div>
          </div>
          
          <DialogFooter>
            <Button 
              variant="outline" 
              onClick={() => { setShowBulkDeleteDialog(false); setBulkDeleteConfirm(''); }}
            >
              Cancel
            </Button>
            <Button 
              variant="destructive"
              onClick={handleBulkDelete}
              disabled={bulkDeleteConfirm !== selectedSupplier}
              data-testid="confirm-bulk-delete-btn"
            >
              Delete All Products
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Sync from Products Dialog */}
      <Dialog open={showSyncDialog} onOpenChange={() => setShowSyncDialog(false)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Database className="w-5 h-5" />
              Sync from Products Database
            </DialogTitle>
          </DialogHeader>
          
          <div className="py-4 space-y-4">
            <p className="text-gray-600">
              Import products from the main Products database to Supplier Products based on SKU prefix:
            </p>
            
            <div className="bg-gray-50 p-4 rounded-lg space-y-2 text-sm">
              <div className="flex justify-between"><span className="font-medium">TIL-*</span><span className="text-gray-500">→ Tile Rite</span></div>
              <div className="flex justify-between"><span className="font-medium">TRI-*</span><span className="text-gray-500">→ Trimline</span></div>
              <div className="flex justify-between"><span className="font-medium">ULT-*</span><span className="text-gray-500">→ Ultra Tile</span></div>
              <div className="flex justify-between"><span className="font-medium">VER-*</span><span className="text-gray-500">→ Verona</span></div>
              <div className="flex justify-between"><span className="font-medium">WAL-*</span><span className="text-gray-500">→ Wallcano</span></div>
              <div className="flex justify-between"><span className="font-medium">CER-*</span><span className="text-gray-500">→ Ceramica Impex</span></div>
            </div>
            
            <p className="text-sm text-gray-500">
              This will sync products to the Supplier Products list, making them easier to organize and export.
            </p>
          </div>
          
          <DialogFooter className="flex gap-2">
            <Button 
              variant="outline" 
              onClick={() => setShowSyncDialog(false)}
            >
              Cancel
            </Button>
            <Button 
              variant="outline"
              onClick={() => handleSyncFromProducts(['Tile Rite', 'Trimline', 'Ultra Tile'])}
              disabled={syncLoading}
            >
              {syncLoading ? 'Syncing...' : 'Sync TIL/TRI/ULT Only'}
            </Button>
            <Button 
              onClick={() => handleSyncFromProducts([])}
              disabled={syncLoading}
            >
              {syncLoading ? 'Syncing...' : 'Sync All'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog 
        open={showBulkCategoryModal} 
        onOpenChange={(open) => {
          // Don't close if Options Manager or scope popover is open
          if (!open && (showOptionsManager || isScopePopoverOpen)) return;
          setShowBulkCategoryModal(open);
        }}
        modal={!showOptionsManager}
      >
        <DialogContent 
          className="max-w-3xl max-h-[90vh] flex flex-col overflow-hidden" 
          style={{ pointerEvents: showOptionsManager ? 'none' : 'auto' }}
          onPointerDownOutside={(e) => {
            if (showOptionsManager || isScopePopoverOpen) {
              e.preventDefault();
            }
          }} 
          onInteractOutside={(e) => {
            if (showOptionsManager || isScopePopoverOpen) {
              e.preventDefault();
            }
          }}
          onFocusOutside={(e) => {
            if (showOptionsManager || isScopePopoverOpen) {
              e.preventDefault();
            }
          }}
          onEscapeKeyDown={(e) => {
            if (showOptionsManager || isScopePopoverOpen) {
              e.preventDefault();
            }
          }}
        >
          <DialogHeader className="flex-shrink-0" style={{ pointerEvents: showOptionsManager ? 'none' : 'auto' }}>
            <DialogTitle className="flex items-center justify-between w-full">
              <span className="flex items-center gap-2 text-purple-700">
                <Globe className="w-5 h-5" />
                Bulk Category Editor
              </span>
              <div className="flex items-center gap-2">
                {/* Sync Indicator */}
                <div className="flex items-center gap-1 px-2 py-1 bg-green-100 text-green-700 rounded-full text-xs">
                  <RefreshCw className="w-3 h-3" />
                  <span className="hidden sm:inline">Synced</span>
                </div>
                <button
                  type="button"
                  onClick={() => setShowOptionsManager(true)}
                  className="flex items-center gap-1.5 px-3 py-1.5 text-sm bg-amber-100 text-amber-700 rounded-lg hover:bg-amber-200 transition-colors"
                  title="Add, edit or delete attribute options (syncs with Navigation & Structure)"
                  style={{ pointerEvents: 'auto' }}
                >
                  <Settings2 className="w-4 h-4" />
                  Manage Options
                </button>
              </div>
            </DialogTitle>
          </DialogHeader>
          
          <div className="flex-1 overflow-y-auto py-4 space-y-6" style={{ pointerEvents: showOptionsManager ? 'none' : 'auto' }}>
            <div className="p-4 bg-purple-50 border border-purple-200 rounded-lg">
              <p className="text-purple-800 font-medium">
                Editing categories for {bulkThicknessFilter !== 'all' ? getProductsFilteredByThickness(bulkThicknessFilter).length : selectedProducts.size} selected products
              </p>
              <p className="text-sm text-purple-600 mt-1">
                Select categories below to assign them to {bulkThicknessFilter !== 'all' ? `${bulkThicknessFilter} products only` : 'all selected products'}.
              </p>
              {/* Presets and History toolbar */}
              <div className="flex items-center gap-2 mt-2 pt-2 border-t border-purple-200">
                <BulkEditPresets
                  selections={bulkCategorySelections}
                  onLoadPreset={(presetSelections) => {
                    setBulkCategorySelections(prev => ({ ...prev, ...presetSelections }));
                  }}
                  productGroup={selectedProductGroup}
                />
                <div className="flex-1" />
                {/* Auto-save indicator */}
                {autoSaveStatus && (
                  <span className={`text-xs flex items-center gap-1 ${
                    autoSaveStatus === 'saving' ? 'text-blue-500' :
                    autoSaveStatus === 'saved' ? 'text-green-500' :
                    'text-red-400'
                  }`} data-testid="auto-save-indicator">
                    {autoSaveStatus === 'saving' && <><Loader2 className="w-3 h-3 animate-spin" /> Saving draft...</>}
                    {autoSaveStatus === 'saved' && <>
                      <CheckCircle className="w-3 h-3" />
                      Draft saved {lastAutoSaveTime ? new Date(lastAutoSaveTime).toLocaleTimeString() : ''}
                    </>}
                    {autoSaveStatus === 'error' && <><AlertCircle className="w-3 h-3" /> Draft save failed</>}
                  </span>
                )}
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setShowEditHistory(true)}
                  className="h-7 text-xs gap-1 px-2"
                  data-testid="edit-history-btn"
                >
                  <History className="w-3 h-3" />
                  Edit History
                </Button>
              </div>
            </div>

            {/* Draft Recovery Banner — 3 Aug 2026
                Colour-coded by staleness. Was previously a blue banner with
                no age / supplier / product-set check; owner was seeing
                2-month-old drafts silently offered as "restore" candidates,
                which would wipe fresh work. Now:
                  • Blue = fresh (≤7 days, same supplier, same product set)
                  • Amber = stale (>7 days OR different products/supplier)
                  • Red = ancient (>30 days)
                And a new "Ignore for this session" button keeps the draft on
                the server so the owner can decide later. */}
            {showDraftRecovery && recoveredDraft && (() => {
              // ── freshness heuristics ────────────────────────────────────
              const ageMs = recoveredDraft.updated_at
                ? Date.now() - new Date(recoveredDraft.updated_at).getTime()
                : 0;
              const ageDays = Math.floor(ageMs / (1000 * 60 * 60 * 24));
              const ageHours = Math.floor(ageMs / (1000 * 60 * 60));
              const ageMinutes = Math.floor(ageMs / (1000 * 60));
              const ageLabel = ageDays >= 1
                ? `${ageDays} day${ageDays === 1 ? '' : 's'} ago`
                : ageHours >= 1
                ? `${ageHours} hour${ageHours === 1 ? '' : 's'} ago`
                : ageMinutes >= 1
                ? `${ageMinutes} minute${ageMinutes === 1 ? '' : 's'} ago`
                : 'just now';
              const draftProductCount = Array.isArray(recoveredDraft.selected_products)
                ? recoveredDraft.selected_products.length
                : 0;
              const currentSize = selectedProducts.size;
              const sameProducts = draftProductCount > 0 && draftProductCount === currentSize
                && Array.isArray(recoveredDraft.selected_products)
                && recoveredDraft.selected_products.every(sku => selectedProducts.has(sku));
              const sameSupplier = !recoveredDraft.supplier
                || recoveredDraft.supplier === (selectedSupplier || '');
              const attributeCount = Object.values(recoveredDraft.selections || {})
                .filter(v => v && (Array.isArray(v) ? v.length > 0 : v !== '')).length;

              let level = 'fresh';
              if (ageDays > 30) level = 'ancient';
              else if (ageDays > 7 || !sameProducts || !sameSupplier) level = 'stale';

              const palettes = {
                fresh:   { bg: 'bg-blue-50',   border: 'border-blue-300',   iconWrap: 'text-blue-600',   title: 'text-blue-800',   sub: 'text-blue-600',   btn: 'bg-blue-600 hover:bg-blue-700',   pillBg: 'bg-blue-100 text-blue-800' },
                stale:   { bg: 'bg-amber-50',  border: 'border-amber-300',  iconWrap: 'text-amber-600',  title: 'text-amber-900',  sub: 'text-amber-700',  btn: 'bg-amber-600 hover:bg-amber-700',  pillBg: 'bg-amber-100 text-amber-800' },
                ancient: { bg: 'bg-red-50',    border: 'border-red-300',    iconWrap: 'text-red-600',    title: 'text-red-900',    sub: 'text-red-700',    btn: 'bg-red-600 hover:bg-red-700',    pillBg: 'bg-red-100 text-red-800' },
              };
              const p = palettes[level];
              const Icon = level === 'fresh' ? Clock : AlertCircle;
              return (
                <div className={`p-3 ${p.bg} border ${p.border} rounded-lg`} data-testid="draft-recovery-banner">
                  <div className="flex items-start gap-3">
                    <Icon className={`w-5 h-5 ${p.iconWrap} shrink-0 mt-0.5`} />
                    <div className="flex-1 min-w-0">
                      <p className={`text-sm font-semibold ${p.title} flex items-center gap-2 flex-wrap`}>
                        Unsaved draft from {recoveredDraft.updated_at ? new Date(recoveredDraft.updated_at).toLocaleString() : 'a previous session'}
                        <span className={`text-[10px] px-1.5 py-0.5 rounded-full ${p.pillBg} font-bold uppercase tracking-wider`}>
                          {ageLabel}
                        </span>
                      </p>
                      <p className={`text-xs ${p.sub} mt-1`}>
                        Draft covers <strong>{attributeCount}</strong> attribute{attributeCount === 1 ? '' : 's'}
                        {draftProductCount > 0 && (
                          <> for <strong>{draftProductCount}</strong> product{draftProductCount === 1 ? '' : 's'}</>
                        )}
                        {recoveredDraft.supplier && (
                          <> from <strong>&ldquo;{recoveredDraft.supplier}&rdquo;</strong></>
                        )}
                        .
                      </p>
                      {level !== 'fresh' && (
                        <div className={`mt-2 text-xs ${p.sub} bg-white/60 rounded p-2 border ${p.border}`}>
                          <p className="font-semibold flex items-center gap-1">
                            <AlertCircle className="w-3.5 h-3.5" /> Heads up before you restore:
                          </p>
                          <ul className="mt-1 space-y-0.5 list-disc list-inside">
                            {ageDays > 30 && (
                              <li>This draft is over a month old — values may reference options that no longer exist.</li>
                            )}
                            {ageDays > 7 && ageDays <= 30 && (
                              <li>This draft is {ageDays} days old — double-check before applying.</li>
                            )}
                            {!sameProducts && (
                              <li>
                                Draft was for {draftProductCount} product{draftProductCount === 1 ? '' : 's'};
                                you currently have {currentSize} selected. Some draft values may not apply.
                              </li>
                            )}
                            {!sameSupplier && recoveredDraft.supplier && (
                              <li>
                                Draft was for supplier <strong>&ldquo;{recoveredDraft.supplier}&rdquo;</strong>;
                                you&apos;re now working on <strong>&ldquo;{selectedSupplier || 'a different supplier'}&rdquo;</strong>.
                              </li>
                            )}
                          </ul>
                        </div>
                      )}
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-2 justify-end mt-3">
                    <Button
                      size="sm"
                      onClick={() => {
                        setBulkCategorySelections(prev => ({ ...prev, ...(recoveredDraft.selections || {}) }));
                        setShowDraftRecovery(false);
                        setRecoveredDraft(null);
                        toast.success(level === 'fresh' ? 'Draft restored' : 'Draft restored — please review the values');
                      }}
                      className={`${p.btn} text-white h-7 text-xs`}
                      data-testid="restore-draft-btn"
                    >
                      {level === 'fresh' ? 'Restore' : 'Restore Anyway'}
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        // Session-only dismiss: keep the draft on the server
                        // so the owner can come back to it later.
                        setShowDraftRecovery(false);
                        toast.info('Draft kept — will be offered again next time you open this modal');
                      }}
                      className="h-7 text-xs"
                      data-testid="ignore-draft-btn"
                    >
                      Ignore for now
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        setShowDraftRecovery(false);
                        setRecoveredDraft(null);
                        clearServerDraft();
                        toast.success('Draft discarded');
                      }}
                      className="h-7 text-xs border-red-200 text-red-700 hover:bg-red-50"
                      data-testid="discard-draft-btn"
                    >
                      Discard Draft
                    </Button>
                  </div>
                </div>
              );
            })()}

            {/* Thickness Filter - filter selected products by thickness */}
            {bulkThicknessOptions.length > 1 && (
              <div className="p-3 bg-gradient-to-r from-amber-50 to-yellow-50 border border-amber-200 rounded-lg">
                <div className="flex items-center justify-between flex-wrap gap-2">
                  <div className="flex items-center gap-2">
                    <Filter className="w-4 h-4 text-amber-600" />
                    <span className="text-sm font-medium text-gray-700">Filter by Thickness:</span>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <button
                      type="button"
                      onClick={() => setBulkThicknessFilter('all')}
                      className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${
                        bulkThicknessFilter === 'all'
                          ? 'bg-amber-600 text-white shadow-md'
                          : 'bg-white text-gray-700 hover:bg-amber-100 border border-gray-200'
                      }`}
                      data-testid="bulk-thickness-all"
                    >
                      All ({selectedProducts.size})
                    </button>
                    {bulkThicknessOptions.map(({ name, count }) => (
                      <button
                        key={name}
                        type="button"
                        onClick={() => setBulkThicknessFilter(name)}
                        className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${
                          bulkThicknessFilter === name
                            ? 'bg-amber-600 text-white shadow-md'
                            : 'bg-white text-gray-700 hover:bg-amber-100 border border-gray-200'
                        }`}
                        data-testid={`bulk-thickness-${name}`}
                      >
                        {name} ({count})
                      </button>
                    ))}
                  </div>
                </div>
                {bulkThicknessFilter !== 'all' && (
                  <p className="text-xs text-amber-700 mt-2 font-medium">
                    Changes will only apply to {getProductsFilteredByThickness(bulkThicknessFilter).length} products with {bulkThicknessFilter} thickness
                  </p>
                )}
              </div>
            )}

            {/* Product Group Context Selector */}
            <div className="p-3 bg-gradient-to-r from-blue-50 to-indigo-50 border border-blue-200 rounded-lg">
              <div className="flex items-center justify-between flex-wrap gap-2">
                <div className="flex items-center gap-2">
                  <FolderTree className="w-4 h-4 text-blue-600" />
                  <span className="text-sm font-medium text-gray-700">Working on:</span>
                </div>
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={() => setSelectedProductGroup('all')}
                    className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all flex items-center gap-1.5 ${
                      selectedProductGroup === 'all'
                        ? 'bg-blue-600 text-white shadow-md'
                        : 'bg-white text-gray-700 hover:bg-blue-100 border border-gray-200'
                    }`}
                  >
                    <Layers className="w-3.5 h-3.5" />
                    All Groups
                  </button>
                  {categoryGroups.slice(0, 5).map(group => {
                    const isSelected = selectedProductGroup === group.slug;
                    return (
                      <button
                        key={group.slug}
                        type="button"
                        onClick={() => setSelectedProductGroup(group.slug)}
                        className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all flex items-center gap-1.5 ${
                          isSelected
                            ? 'bg-blue-600 text-white shadow-md'
                            : 'bg-white text-gray-700 hover:bg-blue-100 border border-gray-200'
                        }`}
                      >
                        {group.name}
                      </button>
                    );
                  })}
                </div>
              </div>
              {selectedProductGroup !== 'all' && (
                <p className="text-xs text-blue-600 mt-2">
                  Showing options for: {categoryGroups.find(g => g.slug === selectedProductGroup)?.name || selectedProductGroup}
                </p>
              )}
            </div>

            {/* ===== UNIFIED CATEGORIES, FILTERS & SPECIFICATIONS SECTIONS ===== */}
            {/* Placed at top for immediate visibility - matches Navigation & Structure */}
            {!optionsLoading && productOptions && (
              <BulkCategoryEditorSections
                categoryGroups={categoryGroups}
                selectedProductGroup={selectedProductGroup}
                bulkCategorySelections={bulkCategorySelections}
                setBulkCategorySelections={setBulkCategorySelections}
                productOptions={productOptions}
                selectedProducts={selectedProducts}
                products={products}
                pricingSizeFilter={pricingSizeFilter}
                productSubSelection={productSubSelection}
                setProductSubSelection={setProductSubSelection}
                defaultMaterial="Porcelain"
                fieldBreakdowns={bulkFieldBreakdowns}
                fieldsToClear={fieldsToClear}
                setFieldsToClear={setFieldsToClear}
                perProductAssignments={perProductAssignments}
                setPerProductAssignments={setPerProductAssignments}
                sectionProductScopes={sectionProductScopes}
                setSectionProductScopes={setSectionProductScopes}
                perAttributeScopes={perAttributeScopes}
                setPerAttributeScopes={setPerAttributeScopes}
                onScopePopoverChange={setIsScopePopoverOpen}
                onQuickSave={handleQuickSave}
              />
            )}

            {/* WEBSITE PREVIEW PANEL */}
            {(() => {
              const previewProducts = getSelectedProductsForPreview();
              const firstProduct = previewProducts[0];
              if (!firstProduct) return null;
              
              const previewUrl = getWebsitePreviewUrl(firstProduct);
              const productImage = firstProduct.images?.[0] || firstProduct.image;
              const isPublishedToWebsite = firstProduct.show_on_website;
              const productPrice = firstProduct.price || firstProduct.list_price || (firstProduct.cost_price ? firstProduct.cost_price * 2 : 0);
              
              return (
                <div className="p-4 bg-gradient-to-r from-blue-50 to-indigo-50 border border-blue-200 rounded-lg">
                  <div className="flex items-center justify-between mb-3">
                    <h3 className="text-sm font-bold text-blue-800 flex items-center gap-2">
                      <Eye className="w-4 h-4" />
                      Website Preview
                      {!isPublishedToWebsite && (
                        <span className="text-xs bg-amber-100 text-amber-700 px-2 py-0.5 rounded-full ml-2">
                          Not Published
                        </span>
                      )}
                      {isPublishedToWebsite && (
                        <span className="text-xs bg-green-100 text-green-700 px-2 py-0.5 rounded-full ml-2">
                          Live
                        </span>
                      )}
                    </h3>
                    <div className="flex items-center gap-2">
                      {/* Publish Button */}
                      {!isPublishedToWebsite && (
                        <button
                          type="button"
                          onClick={publishSelectedToWebsite}
                          disabled={publishingToWebsite}
                          className="text-xs px-3 py-1.5 bg-green-600 text-white rounded-lg hover:bg-green-700 transition-colors flex items-center gap-1.5 disabled:opacity-50"
                        >
                          {publishingToWebsite ? (
                            <>
                              <Loader2 className="w-3 h-3 animate-spin" />
                              Publishing...
                            </>
                          ) : (
                            <>
                              <Globe className="w-3 h-3" />
                              Publish to Website
                            </>
                          )}
                        </button>
                      )}
                      {/* Open on Website Button */}
                      {isPublishedToWebsite && (
                        <button
                          type="button"
                          onClick={() => openOnWebsite(firstProduct)}
                          className="text-xs px-3 py-1.5 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors flex items-center gap-1.5"
                        >
                          <ExternalLink className="w-3 h-3" />
                          Open on Website
                        </button>
                      )}
                      {/* Toggle Preview Card Button */}
                      <button
                        type="button"
                        onClick={() => setShowWebsitePreviewCard(!showWebsitePreviewCard)}
                        className="text-xs px-3 py-1.5 bg-indigo-100 text-indigo-700 rounded-lg hover:bg-indigo-200 transition-colors flex items-center gap-1.5"
                      >
                        <Layers className="w-3 h-3" />
                        {showWebsitePreviewCard ? 'Hide' : 'Show'} Card Preview
                      </button>
                    </div>
                  </div>
                  
                  <div className="flex gap-4">
                    {/* Product Image */}
                    {productImage && (
                      <div className="w-24 h-24 flex-shrink-0 rounded-lg overflow-hidden border border-blue-200 bg-white">
                        <img 
                          src={productImage} 
                          alt={firstProduct.product_name || firstProduct.name}
                          className="w-full h-full object-cover"
                        />
                      </div>
                    )}
                    
                    {/* Product Info */}
                    <div className="flex-1 min-w-0">
                      <p className="font-medium text-gray-900 truncate" title={firstProduct.product_name || firstProduct.name}>
                        {firstProduct.product_name || firstProduct.name}
                      </p>
                      <p className="text-sm text-gray-500 mt-0.5">
                        SKU: {firstProduct.sku} • {firstProduct.supplier}
                      </p>
                      {firstProduct.size && (
                        <p className="text-sm text-gray-500">
                          Size: {firstProduct.size}
                        </p>
                      )}
                      
                      {/* Enhanced Pricing Display */}
                      <div className="mt-2 p-2 bg-white/50 rounded-lg border border-blue-100">
                        <div className="space-y-1 text-xs">
                          <div className="flex justify-between">
                            <span className="text-gray-500">Sold Price (inc VAT)</span>
                            <span className="font-semibold text-blue-600">£{productPrice.toFixed(2)}</span>
                          </div>
                          <div className="flex justify-between text-purple-600">
                            <span>÷ 1.2 (Ex-VAT)</span>
                            <span className="font-semibold">£{(productPrice / 1.2).toFixed(2)}</span>
                          </div>
                          <div className="flex justify-between text-red-500 border-b border-blue-100 pb-1">
                            <span>- Cost</span>
                            <span>-£{(firstProduct.cost_price || 0).toFixed(2)}</span>
                          </div>
                          <div className="flex justify-between pt-1">
                            <span className="font-bold text-gray-700">Net Profit</span>
                            <span className={`font-bold ${((productPrice / 1.2) - (firstProduct.cost_price || 0)) > 0 ? 'text-green-600' : 'text-red-600'}`}>
                              £{((productPrice / 1.2) - (firstProduct.cost_price || 0)).toFixed(2)}
                            </span>
                          </div>
                        </div>
                        {firstProduct.cost_price > 0 && (
                          <div className="text-center mt-1 text-xs text-gray-400">
                            Margin: {((((productPrice / 1.2) - firstProduct.cost_price) / (productPrice / 1.2)) * 100).toFixed(0)}%
                          </div>
                        )}
                      </div>
                      
                      {previewProducts.length > 1 && (
                        <p className="text-xs text-blue-600 mt-2 flex items-center gap-1">
                          <Package className="w-3 h-3" />
                          {previewProducts.length} products selected
                        </p>
                      )}
                    </div>
                  </div>
                  
                  {/* ALL SELECTED PRODUCTS PREVIEW GRID */}
                  {previewProducts.length > 1 && (
                    <div className="mt-4 pt-4 border-t border-blue-200">
                      <div className="flex items-center justify-between mb-3">
                        <p className="text-xs text-blue-600 font-medium flex items-center gap-2">
                          <Eye className="w-3 h-3" />
                          All {previewProducts.length} Selected Products:
                        </p>
                        {expandedProductInGrid && (
                          <button
                            type="button"
                            onClick={() => setExpandedProductInGrid(null)}
                            className="text-xs text-gray-500 hover:text-gray-700 flex items-center gap-1"
                          >
                            <X className="w-3 h-3" />
                            Close Details
                          </button>
                        )}
                      </div>
                      
                      {/* Expanded Product Detail Panel */}
                      {expandedProductInGrid && (
                        <div className="mb-4 p-3 bg-gradient-to-r from-indigo-50 to-purple-50 rounded-lg border border-indigo-200 animate-in fade-in duration-200">
                          <div className="flex gap-4">
                            {/* Product Image */}
                            <div className="w-24 h-24 flex-shrink-0 rounded-lg overflow-hidden border border-indigo-200 bg-white">
                              {(expandedProductInGrid.images?.[0] || expandedProductInGrid.image) ? (
                                <img 
                                  src={expandedProductInGrid.images?.[0] || expandedProductInGrid.image} 
                                  alt={expandedProductInGrid.product_name || expandedProductInGrid.name}
                                  className="w-full h-full object-cover"
                                />
                              ) : (
                                <div className="w-full h-full flex items-center justify-center text-gray-300">
                                  <Package className="w-8 h-8" />
                                </div>
                              )}
                            </div>
                            
                            {/* Product Details */}
                            <div className="flex-1 min-w-0">
                              <h4 className="font-bold text-gray-900 text-sm mb-1">
                                {expandedProductInGrid.product_name || expandedProductInGrid.name}
                              </h4>
                              <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
                                <p className="text-gray-500">
                                  <span className="font-medium">SKU:</span> {expandedProductInGrid.sku}
                                </p>
                                <p className="text-gray-500">
                                  <span className="font-medium">Supplier:</span> {expandedProductInGrid.supplier}
                                </p>
                                {expandedProductInGrid.size && (
                                  <p className="text-gray-500">
                                    <span className="font-medium">Size:</span> {expandedProductInGrid.size}
                                  </p>
                                )}
                                {expandedProductInGrid.finish && (
                                  <p className="text-gray-500">
                                    <span className="font-medium">Finish:</span> {expandedProductInGrid.finish}
                                  </p>
                                )}
                                {expandedProductInGrid.color && (
                                  <p className="text-gray-500">
                                    <span className="font-medium">Color:</span> {expandedProductInGrid.color}
                                  </p>
                                )}
                                {expandedProductInGrid.material && (
                                  <p className="text-gray-500">
                                    <span className="font-medium">Material:</span> {expandedProductInGrid.material}
                                  </p>
                                )}
                              </div>
                              
                              {/* Pricing */}
                              <div className="mt-2 flex items-center gap-4 text-xs">
                                <span className="text-blue-600 font-semibold">
                                  Price: £{(expandedProductInGrid.price || expandedProductInGrid.list_price || 0).toFixed(2)}
                                </span>
                                <span className="text-gray-500">
                                  Cost: £{(expandedProductInGrid.cost_price || 0).toFixed(2)}
                                </span>
                                {expandedProductInGrid.cost_price > 0 && (
                                  <span className={`font-semibold ${((expandedProductInGrid.price || expandedProductInGrid.list_price || 0) / 1.2) - expandedProductInGrid.cost_price > 0 ? 'text-green-600' : 'text-red-600'}`}>
                                    Margin: {(((((expandedProductInGrid.price || expandedProductInGrid.list_price || 0) / 1.2) - expandedProductInGrid.cost_price) / ((expandedProductInGrid.price || expandedProductInGrid.list_price || 0) / 1.2)) * 100).toFixed(0)}%
                                  </span>
                                )}
                              </div>
                              
                              {/* Preview on Website Button */}
                              <div className="mt-2">
                                <button
                                  type="button"
                                  onClick={() => {
                                    const name = expandedProductInGrid.product_name || expandedProductInGrid.name || '';
                                    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
                                    window.open(`/tiles/${slug}`, '_blank');
                                  }}
                                  className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-blue-600 text-white text-xs rounded-lg hover:bg-blue-700 transition-colors"
                                >
                                  <ExternalLink className="w-3 h-3" />
                                  Preview on Website
                                </button>
                              </div>
                            </div>
                          </div>
                          
                          {/* Current Selections Applied */}
                          <div className="mt-3 pt-3 border-t border-indigo-200">
                            <p className="text-xs font-bold text-indigo-700 mb-2 flex items-center gap-1">
                              <Tag className="w-3 h-3" />
                              Current Selections on this Product:
                            </p>
                            <div className="flex flex-wrap gap-2">
                              {/* Main Category */}
                              {expandedProductInGrid.main_category && (
                                <span className="inline-flex items-center gap-1 px-2 py-1 bg-purple-100 text-purple-700 rounded-full text-xs">
                                  <Layers className="w-3 h-3" />
                                  {expandedProductInGrid.main_category}
                                </span>
                              )}
                              {/* Sub Categories */}
                              {expandedProductInGrid.sub_categories?.length > 0 && expandedProductInGrid.sub_categories.map((sub, i) => (
                                <span key={i} className="inline-flex items-center gap-1 px-2 py-1 bg-blue-100 text-blue-700 rounded-full text-xs">
                                  <FolderTree className="w-3 h-3" />
                                  {sub}
                                </span>
                              ))}
                              {/* Website Categories */}
                              {expandedProductInGrid.website_categories?.rooms?.length > 0 && expandedProductInGrid.website_categories.rooms.map((room, i) => (
                                <span key={`room-${i}`} className="inline-flex items-center gap-1 px-2 py-1 bg-green-100 text-green-700 rounded-full text-xs">
                                  <Home className="w-3 h-3" />
                                  {room}
                                </span>
                              ))}
                              {expandedProductInGrid.website_categories?.materials?.length > 0 && expandedProductInGrid.website_categories.materials.map((mat, i) => (
                                <span key={`mat-${i}`} className="inline-flex items-center gap-1 px-2 py-1 bg-amber-100 text-amber-700 rounded-full text-xs">
                                  <Palette className="w-3 h-3" />
                                  {mat}
                                </span>
                              ))}
                              {expandedProductInGrid.website_categories?.styles?.length > 0 && expandedProductInGrid.website_categories.styles.map((style, i) => (
                                <span key={`style-${i}`} className="inline-flex items-center gap-1 px-2 py-1 bg-pink-100 text-pink-700 rounded-full text-xs">
                                  <Sparkles className="w-3 h-3" />
                                  {style}
                                </span>
                              ))}
                              {expandedProductInGrid.website_categories?.features?.length > 0 && expandedProductInGrid.website_categories.features.map((feat, i) => (
                                <span key={`feat-${i}`} className="inline-flex items-center gap-1 px-2 py-1 bg-cyan-100 text-cyan-700 rounded-full text-xs">
                                  <Star className="w-3 h-3" />
                                  {feat}
                                </span>
                              ))}
                              {/* Labels */}
                              {expandedProductInGrid.labels?.length > 0 && expandedProductInGrid.labels.map((label, i) => (
                                <span key={`label-${i}`} className="inline-flex items-center gap-1 px-2 py-1 bg-red-100 text-red-700 rounded-full text-xs">
                                  <Tag className="w-3 h-3" />
                                  {label}
                                </span>
                              ))}
                              {/* No selections */}
                              {!expandedProductInGrid.main_category && 
                               (!expandedProductInGrid.sub_categories || expandedProductInGrid.sub_categories.length === 0) &&
                               (!expandedProductInGrid.website_categories?.rooms || expandedProductInGrid.website_categories.rooms.length === 0) &&
                               (!expandedProductInGrid.website_categories?.materials || expandedProductInGrid.website_categories.materials.length === 0) &&
                               (!expandedProductInGrid.website_categories?.styles || expandedProductInGrid.website_categories.styles.length === 0) &&
                               (!expandedProductInGrid.website_categories?.features || expandedProductInGrid.website_categories.features.length === 0) &&
                               (!expandedProductInGrid.labels || expandedProductInGrid.labels.length === 0) && (
                                <span className="text-xs text-gray-400 italic">No categories or labels assigned yet</span>
                              )}
                            </div>
                            
                            {/* Description & SEO */}
                            {(expandedProductInGrid.description || expandedProductInGrid.seo_keywords?.length > 0) && (
                              <div className="mt-2 pt-2 border-t border-indigo-100">
                                {expandedProductInGrid.description && (
                                  <p className="text-xs text-gray-600 line-clamp-2">
                                    <span className="font-medium text-gray-700">Description:</span> {expandedProductInGrid.description}
                                  </p>
                                )}
                                {expandedProductInGrid.seo_keywords?.length > 0 && (
                                  <p className="text-xs text-gray-500 mt-1">
                                    <span className="font-medium">SEO:</span> {expandedProductInGrid.seo_keywords.join(', ')}
                                  </p>
                                )}
                              </div>
                            )}
                          </div>
                        </div>
                      )}
                      
                      {/* Product Thumbnails Grid */}
                      <div className="max-h-48 overflow-y-auto bg-white/50 rounded-lg p-2">
                        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-2">
                          {previewProducts.map((product, idx) => {
                            const pImg = product.images?.[0] || product.image;
                            const pPrice = product.price || product.list_price || (product.cost_price ? product.cost_price * 2 : 0);
                            const isPublished = product.show_on_website;
                            const isExpanded = expandedProductInGrid && (expandedProductInGrid.sku === product.sku && expandedProductInGrid.supplier === product.supplier);
                            const hasCategories = product.main_category || product.sub_categories?.length > 0 || product.website_categories?.rooms?.length > 0;
                            return (
                              <div 
                                key={product._id || product.id || idx} 
                                onClick={() => setExpandedProductInGrid(isExpanded ? null : product)}
                                className={`group relative bg-white rounded-lg border overflow-hidden transition-all cursor-pointer ${
                                  isExpanded 
                                    ? 'border-indigo-400 ring-2 ring-indigo-300 shadow-lg' 
                                    : 'border-gray-200 hover:shadow-md hover:border-blue-300'
                                }`}
                              >
                                {/* Product Image */}
                                <div className="aspect-square bg-gray-100 relative">
                                  {pImg ? (
                                    <img 
                                      src={pImg} 
                                      alt={product.product_name || product.name}
                                      className="w-full h-full object-cover"
                                    />
                                  ) : (
                                    <div className="w-full h-full flex items-center justify-center text-gray-300">
                                      <Package className="w-6 h-6" />
                                    </div>
                                  )}
                                  {/* Status Badge */}
                                  <div className={`absolute top-1 right-1 w-2 h-2 rounded-full ${isPublished ? 'bg-green-500' : 'bg-amber-400'}`} title={isPublished ? 'Live' : 'Not Published'} />
                                  {/* Preview on Website Button */}
                                  <button
                                    type="button"
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      const name = product.product_name || product.name || '';
                                      const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
                                      window.open(`/tiles/${slug}`, '_blank');
                                    }}
                                    className="absolute top-1 right-4 bg-blue-600 hover:bg-blue-700 text-white p-1 rounded opacity-0 group-hover:opacity-100 transition-opacity"
                                    title="Preview on Website"
                                  >
                                    <ExternalLink className="w-2.5 h-2.5" />
                                  </button>
                                  {/* Index Badge */}
                                  <div className="absolute top-1 left-1 bg-black/60 text-white text-[10px] px-1.5 py-0.5 rounded">
                                    #{idx + 1}
                                  </div>
                                  {/* Has Categories Indicator */}
                                  {hasCategories && (
                                    <div className="absolute bottom-1 right-1 bg-indigo-500 text-white p-0.5 rounded" title="Has categories">
                                      <Tag className="w-2.5 h-2.5" />
                                    </div>
                                  )}
                                  {/* Click indicator on hover */}
                                  <div className="absolute inset-0 bg-indigo-500/0 hover:bg-indigo-500/10 transition-colors flex items-center justify-center opacity-0 hover:opacity-100">
                                    <Eye className="w-4 h-4 text-indigo-600" />
                                  </div>
                                </div>
                                {/* Product Info */}
                                <div className="p-1.5">
                                  <p className="text-[10px] font-medium text-gray-800 line-clamp-1" title={product.product_name || product.name}>
                                    {product.product_name || product.name}
                                  </p>
                                  <p className="text-[10px] text-blue-600 font-semibold">
                                    £{pPrice > 0 ? pPrice.toFixed(2) : '—'}
                                  </p>
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    </div>
                  )}
                  
                  {/* Website Product Card Preview */}
                  {showWebsitePreviewCard && (
                    <div className="mt-4 pt-4 border-t border-blue-200">
                      <p className="text-xs text-blue-600 mb-3 font-medium">How it will appear on the website:</p>
                      <div className="flex justify-center">
                        {/* Website Product Card Mockup */}
                        <div className="w-64 bg-white rounded-xl shadow-lg overflow-hidden border border-gray-200 hover:shadow-xl transition-shadow">
                          {/* Product Image */}
                          <div className="relative aspect-square bg-gray-100">
                            {productImage ? (
                              <img 
                                src={productImage} 
                                alt={firstProduct.product_name || firstProduct.name}
                                className="w-full h-full object-cover"
                              />
                            ) : (
                              <div className="w-full h-full flex items-center justify-center text-gray-400">
                                <Package className="w-12 h-12" />
                              </div>
                            )}
                            {/* Sale Badge (if applicable) */}
                            {firstProduct.on_sale && (
                              <div className="absolute top-2 left-2 bg-red-500 text-white text-xs font-bold px-2 py-1 rounded">
                                SALE
                              </div>
                            )}
                            {/* Quick View Button */}
                            <div className="absolute inset-0 bg-black/0 hover:bg-black/20 transition-colors flex items-center justify-center opacity-0 hover:opacity-100">
                              <span className="bg-white text-gray-800 px-3 py-1.5 rounded-full text-xs font-medium shadow">
                                Quick View
                              </span>
                            </div>
                          </div>
                          
                          {/* Product Details */}
                          <div className="p-4">
                            <h3 className="font-medium text-gray-900 text-sm leading-tight line-clamp-2 min-h-[2.5rem]">
                              {firstProduct.product_name || firstProduct.name}
                            </h3>
                            <p className="text-xs text-gray-500 mt-1">
                              {firstProduct.size || '60x60cm'} • {firstProduct.finish || 'Matt'}
                            </p>
                            
                            {/* Price */}
                            <div className="mt-3 flex items-baseline gap-2">
                              <span className="text-lg font-bold text-gray-900">
                                £{productPrice > 0 ? productPrice.toFixed(2) : '—'}
                              </span>
                              <span className="text-xs text-gray-500">/m²</span>
                            </div>
                            
                            {/* Add to Cart Button */}
                            <button className="mt-3 w-full bg-yellow-400 hover:bg-yellow-500 text-gray-900 font-medium py-2 px-4 rounded-lg text-sm transition-colors flex items-center justify-center gap-2">
                              <ShoppingCart className="w-4 h-4" />
                              Add to Cart
                            </button>
                            
                            {/* Stock Status */}
                            <div className="mt-2 flex items-center justify-center gap-1 text-xs">
                              {firstProduct.in_stock || firstProduct.always_in_stock ? (
                                <>
                                  <div className="w-2 h-2 bg-green-500 rounded-full"></div>
                                  <span className="text-green-600">In Stock</span>
                                </>
                              ) : (
                                <>
                                  <div className="w-2 h-2 bg-amber-500 rounded-full"></div>
                                  <span className="text-amber-600">Made to Order</span>
                                </>
                              )}
                            </div>
                          </div>
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              );
            })()}

            {/* QUICK APPLY TEMPLATES - Only show if there are saved templates */}
            {bulkEditTemplates.length > 0 && (
              <div className="p-3 bg-amber-50 border border-amber-200 rounded-lg">
                <h3 className="text-sm font-bold text-amber-800 flex items-center gap-2 mb-2">
                  <Sparkles className="w-4 h-4" />
                  Quick Apply Template
                </h3>
                <div className="flex flex-wrap gap-2">
                  {bulkEditTemplates.map(template => (
                    <div key={template.id} className="flex items-center gap-1 bg-white border border-amber-300 rounded-lg px-2 py-1">
                      <button
                        type="button"
                        onClick={() => applyTemplate(template)}
                        className="text-xs font-medium text-amber-800 hover:text-amber-900"
                      >
                        {template.name}
                      </button>
                      <button
                        type="button"
                        onClick={() => deleteTemplate(template.id)}
                        className="text-amber-400 hover:text-red-500 ml-1"
                      >
                        <X className="w-3 h-3" />
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            )}
            
            {/* SMART AUTO-SUGGEST */}
            {(() => {
              // Analyze selected products to suggest categories
              const selectedSkusList = Array.from(selectedProducts);
              const selectedProductsList = products.filter(p => selectedSkusList.includes(getProductKey(p)));
              
              if (selectedProductsList.length === 0) return null;
              
              // Extract info from all selected products
              const allNames = selectedProductsList.map(p => (p.product_name || p.name || '').toLowerCase());
              
              // Define keyword-to-category mappings
              const suggestRooms = [];
              const suggestMaterials = [];
              const suggestStyles = [];
              const suggestFinishes = [];
              const suggestFeatures = [];
              const suggestColors = [];
              
              // Room suggestions based on keywords
              const roomKeywords = {
                'Bathroom': ['bathroom', 'bath', 'shower', 'toilet', 'ensuite', 'wetroom'],
                'Kitchen': ['kitchen', 'splashback', 'backsplash'],
                'Living Room': ['living', 'lounge', 'sitting'],
                'Bedroom': ['bedroom', 'bed'],
                'Hallway': ['hallway', 'corridor', 'entrance'],
                'Outdoor': ['outdoor', 'exterior', 'garden', 'patio', 'terrace', 'balcony', 'anti-slip', 'antislip', 'non-slip', '20mm', '2cm'],
                'Commercial': ['commercial', 'office', 'shop', 'retail', 'hotel']
              };
              
              // Material suggestions
              const materialKeywords = {
                'Porcelain': ['porcelain', 'porc'],
                'Ceramic': ['ceramic', 'cer'],
                'Natural Stone': ['marble', 'travertine', 'granite', 'slate', 'limestone', 'onyx', 'quartzite'],
                'Marble Effect': ['marble', 'carrara', 'calacatta', 'statuario', 'veined'],
                'Wood Effect': ['wood', 'timber', 'oak', 'walnut', 'ash', 'elm', 'pine', 'plank'],
                'Stone Effect': ['stone', 'slate', 'quarry', 'flagstone', 'pebble'],
                'Cement Effect': ['cement', 'concrete', 'industrial'],
                'Terrazzo': ['terrazzo'],
                'Brick Effect': ['brick', 'metro', 'subway']
              };
              
              // Style suggestions
              const styleKeywords = {
                'Modern': ['modern', 'contemporary', 'minimalist', 'sleek'],
                'Traditional': ['traditional', 'classic', 'heritage', 'victorian'],
                'Rustic': ['rustic', 'farmhouse', 'country', 'cottage', 'weathered'],
                'Industrial': ['industrial', 'urban', 'loft', 'cement', 'concrete'],
                'Mediterranean': ['mediterranean', 'spanish', 'moroccan', 'zellige'],
                'Scandinavian': ['scandi', 'nordic', 'hygge'],
                'Luxury': ['luxury', 'premium', 'designer', 'calacatta', 'statuario']
              };
              
              // Finish suggestions
              const finishKeywords = {
                'Matt': ['matt', 'matte', 'mat'],
                'Polished': ['polished', 'pol', 'gloss', 'glossy', 'shiny'],
                'Lappato': ['lappato', 'semi-polished', 'semi polished'],
                'Satin': ['satin', 'silk', 'soft'],
                'Structured': ['structured', 'textured', 'grip', 'r10', 'r11', 'anti-slip'],
                'Natural': ['natural', 'honed'],
                'Rustic': ['rustic', 'tumbled', 'aged', 'antiqued']
              };
              
              // Feature suggestions
              const featureKeywords = {
                'Anti-Slip': ['anti-slip', 'antislip', 'non-slip', 'nonslip', 'r10', 'r11', 'r12', 'grip', 'structured'],
                'Frost Resistant': ['frost', 'outdoor', 'exterior', '20mm'],
                'Rectified': ['rectified', 'rect'],
                'Large Format': ['120x120', '120x60', '100x100', '90x90', '80x80', 'large'],
                'Small Format': ['10x10', '15x15', '20x20', 'mosaic', 'small'],
                'Wall Only': ['wall', 'splashback', 'feature'],
                'Floor & Wall': ['floor', 'wall'],
                'Decor': ['decor', 'feature', 'pattern', 'border']
              };
              
              // Color suggestions based on detected colors
              const colorKeywords = {
                'White': ['white', 'bianco', 'blanco'],
                'Grey': ['grey', 'gray', 'grigio', 'anthracite', 'graphite', 'charcoal'],
                'Beige': ['beige', 'cream', 'sand', 'ivory', 'bone'],
                'Brown': ['brown', 'chocolate', 'coffee', 'walnut', 'chestnut', 'mocha'],
                'Black': ['black', 'nero', 'ebony', 'onyx'],
                'Blue': ['blue', 'navy', 'azure', 'teal', 'turquoise'],
                'Green': ['green', 'sage', 'olive', 'forest', 'mint'],
                'Taupe': ['taupe', 'greige', 'mushroom']
              };
              
              // Check all product names for keywords
              const checkKeywords = (keywords, targetArray) => {
                Object.entries(keywords).forEach(([category, words]) => {
                  if (words.some(word => allNames.some(name => name.includes(word)))) {
                    if (!targetArray.includes(category)) {
                      targetArray.push(category);
                    }
                  }
                });
              };
              
              checkKeywords(roomKeywords, suggestRooms);
              checkKeywords(materialKeywords, suggestMaterials);
              checkKeywords(styleKeywords, suggestStyles);
              checkKeywords(finishKeywords, suggestFinishes);
              checkKeywords(featureKeywords, suggestFeatures);
              checkKeywords(colorKeywords, suggestColors);
              
              const hasSuggestions = suggestRooms.length > 0 || suggestMaterials.length > 0 || 
                                     suggestStyles.length > 0 || suggestFinishes.length > 0 || 
                                     suggestFeatures.length > 0 || suggestColors.length > 0;
              
              if (!hasSuggestions) return null;
              
              return (
                <div className="p-3 bg-green-50 border border-green-200 rounded-lg">
                  <div className="flex items-center justify-between mb-2">
                    <h3 className="text-sm font-bold text-green-800 flex items-center gap-2">
                      <Sparkles className="w-4 h-4" />
                      Smart Suggestions (based on product names)
                    </h3>
                    <button
                      type="button"
                      onClick={() => {
                        // Apply all suggestions
                        setBulkCategorySelections(prev => ({
                          ...prev,
                          rooms: [...new Set([...(prev.rooms || []), ...suggestRooms])],
                          materials: [...new Set([...(prev.materials || []), ...suggestMaterials])],
                          styles: [...new Set([...(prev.styles || []), ...suggestStyles])],
                          finishes: [...new Set([...(prev.finishes || []), ...suggestFinishes])],
                          features: [...new Set([...(prev.features || []), ...suggestFeatures])],
                          colors: [...new Set([...(prev.colors || []), ...suggestColors])]
                        }));
                      }}
                      className="text-xs px-2 py-1 bg-green-600 text-white rounded hover:bg-green-700 transition-colors flex items-center gap-1"
                    >
                      <Check className="w-3 h-3" />
                      Apply All Suggestions
                    </button>
                  </div>
                  
                  <div className="flex flex-wrap gap-2">
                    {suggestRooms.map(room => (
                      <button
                        key={`suggest-room-${room}`}
                        type="button"
                        onClick={() => setBulkCategorySelections(prev => ({
                          ...prev,
                          rooms: prev.rooms?.includes(room) ? prev.rooms.filter(r => r !== room) : [...(prev.rooms || []), room]
                        }))}
                        className={`text-xs px-2 py-1 rounded border transition-all ${
                          bulkCategorySelections.rooms?.includes(room)
                            ? 'bg-purple-100 text-purple-700 border-purple-300'
                            : 'bg-white text-green-700 border-green-300 hover:bg-green-100'
                        }`}
                      >
                        {bulkCategorySelections.rooms?.includes(room) ? '✓ ' : '+ '}{room}
                      </button>
                    ))}
                    {suggestMaterials.map(mat => (
                      <button
                        key={`suggest-mat-${mat}`}
                        type="button"
                        onClick={() => setBulkCategorySelections(prev => ({
                          ...prev,
                          materials: prev.materials?.includes(mat) ? prev.materials.filter(m => m !== mat) : [...(prev.materials || []), mat]
                        }))}
                        className={`text-xs px-2 py-1 rounded border transition-all ${
                          bulkCategorySelections.materials?.includes(mat)
                            ? 'bg-blue-100 text-blue-700 border-blue-300'
                            : 'bg-white text-green-700 border-green-300 hover:bg-green-100'
                        }`}
                      >
                        {bulkCategorySelections.materials?.includes(mat) ? '✓ ' : '+ '}{mat}
                      </button>
                    ))}
                    {suggestStyles.map(style => (
                      <button
                        key={`suggest-style-${style}`}
                        type="button"
                        onClick={() => setBulkCategorySelections(prev => ({
                          ...prev,
                          styles: prev.styles?.includes(style) ? prev.styles.filter(s => s !== style) : [...(prev.styles || []), style]
                        }))}
                        className={`text-xs px-2 py-1 rounded border transition-all ${
                          bulkCategorySelections.styles?.includes(style)
                            ? 'bg-teal-100 text-teal-700 border-teal-300'
                            : 'bg-white text-green-700 border-green-300 hover:bg-green-100'
                        }`}
                      >
                        {bulkCategorySelections.styles?.includes(style) ? '✓ ' : '+ '}{style}
                      </button>
                    ))}
                    {suggestFinishes.map(finish => (
                      <button
                        key={`suggest-finish-${finish}`}
                        type="button"
                        onClick={() => setBulkCategorySelections(prev => ({
                          ...prev,
                          finishes: prev.finishes?.includes(finish) ? prev.finishes.filter(f => f !== finish) : [...(prev.finishes || []), finish]
                        }))}
                        className={`text-xs px-2 py-1 rounded border transition-all ${
                          bulkCategorySelections.finishes?.includes(finish)
                            ? 'bg-rose-100 text-rose-700 border-rose-300'
                            : 'bg-white text-green-700 border-green-300 hover:bg-green-100'
                        }`}
                      >
                        {bulkCategorySelections.finishes?.includes(finish) ? '✓ ' : '+ '}{finish}
                      </button>
                    ))}
                    {suggestFeatures.map(feature => (
                      <button
                        key={`suggest-feature-${feature}`}
                        type="button"
                        onClick={() => setBulkCategorySelections(prev => ({
                          ...prev,
                          features: prev.features?.includes(feature) ? prev.features.filter(f => f !== feature) : [...(prev.features || []), feature]
                        }))}
                        className={`text-xs px-2 py-1 rounded border transition-all ${
                          bulkCategorySelections.features?.includes(feature)
                            ? 'bg-amber-100 text-amber-700 border-amber-300'
                            : 'bg-white text-green-700 border-green-300 hover:bg-green-100'
                        }`}
                      >
                        {bulkCategorySelections.features?.includes(feature) ? '✓ ' : '+ '}{feature}
                      </button>
                    ))}
                    {suggestColors.map(color => (
                      <button
                        key={`suggest-color-${color}`}
                        type="button"
                        onClick={() => setBulkCategorySelections(prev => ({
                          ...prev,
                          colors: prev.colors?.includes(color) ? prev.colors.filter(c => c !== color) : [...(prev.colors || []), color]
                        }))}
                        className={`text-xs px-2 py-1 rounded border transition-all ${
                          bulkCategorySelections.colors?.includes(color)
                            ? 'bg-indigo-100 text-indigo-700 border-indigo-300'
                            : 'bg-white text-green-700 border-green-300 hover:bg-green-100'
                        }`}
                      >
                        {bulkCategorySelections.colors?.includes(color) ? '✓ ' : '+ '}{color}
                      </button>
                    ))}
                  </div>
                </div>
              );
            })()}

            {/* Mode Selection - Removed, now using popup confirmation */}
            {/* Show on Website Toggle - Removed, Publish button is main controller */}

            {!optionsLoading && productOptions ? (
              <>
                {/* PRICING SECTION */}
                <div className="border-b border-gray-200 pb-4" id="editor-section-pricing">
                  <h3 className="text-sm font-bold text-gray-800 mb-4 flex items-center gap-2">
                    <Store className="w-4 h-4" />
                    Pricing
                  </h3>
                  
                  {/* Size Filter or Product Filter Dropdown */}
                  {(() => {
                    const uniqueSizes = getUniqueSizesFromSelected();
                    const filteredProducts = getProductsFilteredBySize(pricingSizeFilter);
                    const filteredCount = filteredProducts.length;
                    const hasSizes = uniqueSizes.length > 1;
                    const hasSubGroups = uniqueSizes.some(s => s.isSubGroup);
                    
                    // Check if products have mixed cost prices (need product-level filter)
                    const allSelected = Array.from(selectedProducts);
                    const allSelectedProducts = products.filter(p => allSelected.includes(getProductKey(p)));
                    const costSet = new Set(allSelectedProducts.map(p => parseFloat(p.cost_price || 0).toFixed(2)));
                    const hasMixedCosts = costSet.size > 1;
                    
                    const onFilterChange = (newFilter) => {
                      setPricingSizeFilter(newFilter);
                      const filtered = getProductsFilteredBySize(newFilter);
                      if (filtered.length > 0) {
                        const costPrices = filtered.map(p => p.cost_price).filter(p => p);
                        const listPrices = filtered.map(p => p.list_price || p.price || p.room_lot_price).filter(p => p);
                        const uniqueCost = [...new Set(costPrices.map(p => parseFloat(p).toFixed(2)))];
                        const uniqueList = [...new Set(listPrices.map(p => parseFloat(p).toFixed(2)))];
                        setBulkCategorySelections(prev => ({
                          ...prev,
                          cost_price: uniqueCost.length === 1 ? uniqueCost[0] : '',
                          list_price: uniqueList.length === 1 ? uniqueList[0] : ''
                        }));
                        
                        const productTierPricing = getTierPricingFromProducts(newFilter, tierProductScope);
                        if (productTierPricing) {
                          setTierPricingConfig(prev => ({
                            ...prev,
                            thresholds: productTierPricing.thresholds,
                            discounts: productTierPricing.discounts,
                            trade_discount_default: productTierPricing.trade_discount_default,
                            disabled: productTierPricing.disabled
                          }));
                        }
                      }
                    };
                    
                    // Show size filter when multiple sizes exist
                    if (hasSizes) {
                      // Parse currently checked filter values from multi-select
                      const currentSizeKeys = pricingSizeFilter.startsWith('multi:')
                        ? pricingSizeFilter.substring(6).split('\n').filter(Boolean)
                        : [];
                      const allSizesChecked = pricingSizeFilter === 'all' || currentSizeKeys.length === 0;
                      
                      const toggleSizeFilter = (filterValue) => {
                        let newKeys;
                        if (allSizesChecked) {
                          // First click when all selected: select only this one
                          newKeys = [filterValue];
                        } else if (currentSizeKeys.includes(filterValue)) {
                          newKeys = currentSizeKeys.filter(k => k !== filterValue);
                        } else {
                          newKeys = [...currentSizeKeys, filterValue];
                        }
                        // If all or none selected, reset to 'all'
                        if (newKeys.length === 0 || newKeys.length === uniqueSizes.length) {
                          onFilterChange('all');
                        } else {
                          onFilterChange('multi:' + newKeys.join('\n'));
                        }
                      };
                      
                      const selectAllSizes = () => onFilterChange('all');
                      
                      return (
                        <div className="mb-4 p-3 bg-purple-50 border border-purple-200 rounded-lg">
                          <div className="flex items-center justify-between mb-2">
                            <label className="text-xs font-semibold text-purple-700">
                              {hasSubGroups ? 'Filter by Size & Variant:' : 'Filter by Size:'}
                            </label>
                            <div className="flex items-center gap-2">
                              {!allSizesChecked && (
                                <>
                                  <span className="text-xs text-purple-600 font-medium">
                                    {filteredCount} product{filteredCount !== 1 ? 's' : ''} selected
                                  </span>
                                  <button 
                                    onClick={selectAllSizes}
                                    className="text-xs text-purple-600 hover:text-purple-800 underline"
                                    data-testid="size-filter-select-all"
                                  >
                                    Select All
                                  </button>
                                </>
                              )}
                              {allSizesChecked && (
                                <span className="text-xs text-purple-600 font-medium">
                                  {selectedProducts.size} products selected
                                </span>
                              )}
                            </div>
                          </div>
                          <div className="max-h-48 overflow-y-auto border border-purple-200 rounded-lg bg-white" data-testid="pricing-size-filter">
                            {uniqueSizes.map(opt => {
                              const count = getProductsFilteredBySize(opt.value).length;
                              const isChecked = allSizesChecked || currentSizeKeys.includes(opt.value);
                              return (
                                <label 
                                  key={opt.value}
                                  className={`flex items-center gap-2 px-3 py-2 cursor-pointer hover:bg-purple-50 border-b border-purple-100 last:border-b-0 transition-colors ${isChecked && !allSizesChecked ? 'bg-purple-50' : ''} ${opt.isSubGroup ? 'pl-6' : ''}`}
                                  data-testid={`size-filter-item-${opt.value}`}
                                >
                                  <input 
                                    type="checkbox"
                                    checked={isChecked}
                                    onChange={() => toggleSizeFilter(opt.value)}
                                    className="rounded border-purple-300 text-purple-600 focus:ring-purple-500 h-4 w-4"
                                  />
                                  <span className="text-sm text-gray-800 flex-1">
                                    {opt.isSubGroup ? '↳ ' : ''}{opt.label}
                                  </span>
                                  <span className="text-xs text-purple-500 font-medium shrink-0">({count})</span>
                                </label>
                              );
                            })}
                          </div>
                          {!allSizesChecked && (
                            <p className="text-xs text-purple-600 mt-2">
                              Pricing changes will only apply to {filteredCount} selected product{filteredCount !== 1 ? 's' : ''}
                            </p>
                          )}
                          
                          {/* Individual product checkboxes for granular control */}
                          {(() => {
                            const currentProductKeys = pricingSizeFilter.startsWith('product:')
                              ? pricingSizeFilter.substring(8).split('\n')
                              : [];
                            const isProductMode = pricingSizeFilter.startsWith('product:');
                            // Get products based on current size selection
                            const visibleProducts = isProductMode
                              ? allSelectedProducts
                              : getProductsFilteredBySize(pricingSizeFilter);
                            const sortedVisible = [...visibleProducts].sort((a, b) => {
                              const nameA = (a.product_name || a.name || '').toLowerCase();
                              const nameB = (b.product_name || b.name || '').toLowerCase();
                              return nameA.localeCompare(nameB);
                            });
                            
                            const toggleSingleProduct = (productKey) => {
                              let newKeys;
                              if (isProductMode) {
                                if (currentProductKeys.includes(productKey)) {
                                  newKeys = currentProductKeys.filter(k => k !== productKey);
                                } else {
                                  newKeys = [...currentProductKeys, productKey];
                                }
                              } else {
                                // First product click: switch from size mode to product mode with just this product
                                newKeys = [productKey];
                              }
                              if (newKeys.length === 0 || newKeys.length === allSelectedProducts.length) {
                                onFilterChange('all');
                              } else {
                                onFilterChange('product:' + newKeys.join('\n'));
                              }
                            };
                            
                            const selectAllProducts = () => onFilterChange('all');
                            
                            return (
                              <div className="mt-3 border-t border-purple-200 pt-3">
                                <div className="flex items-center justify-between mb-2">
                                  <label className="text-xs font-semibold text-purple-700">Individual Products:</label>
                                  {isProductMode && (
                                    <div className="flex items-center gap-2">
                                      <span className="text-xs text-purple-600 font-medium">
                                        {currentProductKeys.length} of {allSelectedProducts.length}
                                      </span>
                                      <button 
                                        onClick={selectAllProducts}
                                        className="text-xs text-purple-600 hover:text-purple-800 underline"
                                        data-testid="product-filter-select-all-in-size"
                                      >
                                        Select All
                                      </button>
                                    </div>
                                  )}
                                </div>
                                <div className="max-h-48 overflow-y-auto border border-purple-200 rounded-lg bg-white" data-testid="pricing-product-filter">
                                  {sortedVisible.map(p => {
                                    const key = getProductKey(p);
                                    const name = p.product_name || p.name || p.sku;
                                    const cost = p.cost_price ? `£${parseFloat(p.cost_price).toFixed(2)}` : '';
                                    const isChecked = !isProductMode || currentProductKeys.includes(key);
                                    return (
                                      <label 
                                        key={key}
                                        className={`flex items-center gap-2 px-3 py-1.5 cursor-pointer hover:bg-purple-50 border-b border-purple-100 last:border-b-0 transition-colors ${isChecked && isProductMode ? 'bg-purple-50' : ''}`}
                                        data-testid={`product-filter-item-${p.sku || p.supplier_code}`}
                                      >
                                        <input 
                                          type="checkbox"
                                          checked={isChecked}
                                          onChange={() => toggleSingleProduct(key)}
                                          className="rounded border-purple-300 text-purple-600 focus:ring-purple-500 h-3.5 w-3.5"
                                        />
                                        <span className="text-xs text-gray-800 truncate flex-1">{name}</span>
                                        <span className="text-xs text-gray-400 shrink-0">{p.sku || p.supplier_code}</span>
                                        {cost && <span className="text-xs font-medium text-purple-600 shrink-0 ml-1">{cost}</span>}
                                      </label>
                                    );
                                  })}
                                </div>
                                {isProductMode && (
                                  <p className="text-xs text-purple-600 mt-1">
                                    Pricing will apply to {currentProductKeys.length} selected product{currentProductKeys.length !== 1 ? 's' : ''}
                                  </p>
                                )}
                              </div>
                            );
                          })()}
                        </div>
                      );
                    }
                    
                    // Show product filter when no sizes but multiple products (for materials, tools, etc.)
                    if (!hasSizes && allSelectedProducts.length > 1) {
                      const sortedProducts = [...allSelectedProducts].sort((a, b) => 
                        (a.cost_price || 0) - (b.cost_price || 0)
                      );
                      // Parse currently selected product keys from filter
                      const currentKeys = pricingSizeFilter.startsWith('product:')
                        ? pricingSizeFilter.substring(8).split('\n')
                        : [];
                      const allChecked = pricingSizeFilter === 'all' || currentKeys.length === 0;
                      
                      const toggleProduct = (productKey) => {
                        let newKeys;
                        if (currentKeys.includes(productKey)) {
                          // Uncheck: remove this key
                          newKeys = currentKeys.filter(k => k !== productKey);
                        } else {
                          // Check: add this key
                          newKeys = [...currentKeys, productKey];
                        }
                        // If all products selected or none, reset to 'all'
                        if (newKeys.length === 0 || newKeys.length === sortedProducts.length) {
                          onFilterChange('all');
                        } else {
                          onFilterChange('product:' + newKeys.join('\n'));
                        }
                      };
                      
                      const selectAll = () => onFilterChange('all');
                      
                      return (
                        <div className="mb-4 p-3 bg-teal-50 border border-teal-200 rounded-lg">
                          <div className="flex items-center justify-between mb-2">
                            <label className="text-xs font-semibold text-teal-700">Filter by Product:</label>
                            {!allChecked && (
                              <div className="flex items-center gap-2">
                                <span className="text-xs text-teal-600 font-medium">
                                  {filteredCount} of {allSelectedProducts.length} selected
                                </span>
                                <button 
                                  onClick={selectAll}
                                  className="text-xs text-teal-600 hover:text-teal-800 underline"
                                  data-testid="product-filter-select-all"
                                >
                                  Select All
                                </button>
                              </div>
                            )}
                          </div>
                          <div className="max-h-48 overflow-y-auto border border-teal-200 rounded-lg bg-white" data-testid="product-pricing-filter">
                            {sortedProducts.map(p => {
                              const key = getProductKey(p);
                              const name = p.product_name || p.name || p.sku;
                              const cost = p.cost_price ? `£${parseFloat(p.cost_price).toFixed(2)}` : 'No cost';
                              const isChecked = allChecked || currentKeys.includes(key);
                              return (
                                <label 
                                  key={key} 
                                  className={`flex items-center gap-2 px-3 py-2 cursor-pointer hover:bg-teal-50 border-b border-teal-100 last:border-b-0 transition-colors ${isChecked && !allChecked ? 'bg-teal-50' : ''}`}
                                  data-testid={`product-filter-item-${p.sku}`}
                                >
                                  <input 
                                    type="checkbox"
                                    checked={isChecked}
                                    onChange={() => {
                                      if (allChecked) {
                                        // First click when all selected: select only this one
                                        onFilterChange('product:' + key);
                                      } else {
                                        toggleProduct(key);
                                      }
                                    }}
                                    className="rounded border-teal-300 text-teal-600 focus:ring-teal-500 h-4 w-4"
                                  />
                                  <span className="text-sm text-gray-800 truncate flex-1">{name}</span>
                                  <span className="text-xs text-gray-400 shrink-0">{p.sku}</span>
                                  <span className="text-xs font-medium text-teal-700 shrink-0 ml-1">{cost}</span>
                                </label>
                              );
                            })}
                          </div>
                          {!allChecked && (
                            <p className="text-xs text-teal-600 mt-2">
                              Pricing & tier discounts will apply to {currentKeys.length} selected product{currentKeys.length !== 1 ? 's' : ''}
                            </p>
                          )}
                          {allChecked && hasMixedCosts && (
                            <p className="text-xs text-teal-600 mt-2">
                              Products have different costs (£{Math.min(...allSelectedProducts.map(p => p.cost_price || 0)).toFixed(2)} - £{Math.max(...allSelectedProducts.map(p => p.cost_price || 0)).toFixed(2)}). Uncheck products to set prices for a subset.
                            </p>
                          )}
                        </div>
                      );
                    }
                    
                    return null;
                  })()}
                  
                  {/* Show current pricing info from selected/filtered products */}
                  {(() => {
                    const filteredProducts = getProductsFilteredBySize(pricingSizeFilter);
                    const costPrices = filteredProducts.map(p => p.cost_price).filter(p => p) || [];
                    const listPrices = filteredProducts.map(p => p.list_price || p.price || p.room_lot_price).filter(p => p) || [];
                    const uniqueCostPrices = [...new Set(costPrices.map(p => parseFloat(p).toFixed(2)))];
                    const uniqueListPrices = [...new Set(listPrices.map(p => parseFloat(p).toFixed(2)))];
                    const hasMixedCost = uniqueCostPrices.length > 1;
                    const hasMixedList = uniqueListPrices.length > 1;
                    
                    return (hasMixedCost || hasMixedList) && (
                      <div className="mb-3 p-2 bg-blue-50 border border-blue-200 rounded-lg text-xs text-blue-700">
                        <span className="font-medium">Note:</span> {pricingSizeFilter !== 'all' ? `${getFilterDisplayLabel(pricingSizeFilter)} products` : 'Selected products'} have different prices.
                        {hasMixedCost && <span className="block">Cost: £{Math.min(...costPrices).toFixed(2)} - £{Math.max(...costPrices).toFixed(2)}</span>}
                        {hasMixedList && <span className="block">List: £{Math.min(...listPrices).toFixed(2)} - £{Math.max(...listPrices).toFixed(2)}</span>}
                        <span className="block mt-1 text-blue-600">Enter a value to apply to {pricingSizeFilter !== 'all' ? 'these' : 'all selected'} products.</span>
                      </div>
                    );
                  })()}
                  <div className="grid grid-cols-2 gap-4 mb-4">
                    <div>
                      <label className="text-xs font-semibold text-gray-600 mb-1.5 block">Cost Price (£)</label>
                      <input
                        type="number"
                        step="0.01"
                        min="0"
                        value={bulkCategorySelections.cost_price}
                        onChange={(e) => setBulkCategorySelections(prev => ({ ...prev, cost_price: e.target.value }))}
                        placeholder={bulkCategorySelections.cost_price ? '' : 'e.g., 15.99'}
                        className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-purple-500 focus:border-purple-500"
                      />
                    </div>
                    <div>
                      <label className="text-xs font-semibold text-gray-600 mb-1.5 block">List Price (£)</label>
                      <input
                        type="number"
                        step="0.01"
                        min="0"
                        value={bulkCategorySelections.list_price}
                        onChange={(e) => setBulkCategorySelections(prev => ({ ...prev, list_price: e.target.value }))}
                        placeholder={bulkCategorySelections.list_price ? '' : 'e.g., 29.99'}
                        className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-purple-500 focus:border-purple-500"
                      />
                    </div>
                  </div>
                  
                  {/* Save Prices Button - saves cost/list prices immediately */}
                  {(bulkCategorySelections.cost_price || bulkCategorySelections.list_price) && (
                    <button
                      onClick={async () => {
                        const productsToUpdate = pricingSizeFilter !== 'all' 
                          ? getProductsFilteredBySize(pricingSizeFilter)
                          : products.filter(p => Array.from(selectedProducts).includes(getProductKey(p)));
                        
                        if (productsToUpdate.length === 0) {
                          toast.error('No products to update');
                          return;
                        }
                        
                        const loadingToast = toast.loading(`Saving prices for ${productsToUpdate.length} products...`);
                        
                        try {
                          const updates = {};
                          if (bulkCategorySelections.cost_price) updates.cost_price = parseFloat(bulkCategorySelections.cost_price);
                          if (bulkCategorySelections.list_price) updates.price = parseFloat(bulkCategorySelections.list_price);
                          
                          const response = await fetch(`${API_URL}/api/supplier-sync/products/bulk-update-unified`, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({
                              product_ids: productsToUpdate.map(p => p.sku || p.supplier_code).filter(Boolean),
                              id_field: productsToUpdate[0]?.sku ? 'sku' : 'supplier_code',
                              supplier: selectedSupplier !== 'all' ? selectedSupplier : null,
                              updates: updates,
                              mode: 'replace'
                            })
                          });
                          
                          toast.dismiss(loadingToast);
                          
                          if (response.ok) {
                            const result = await response.json();
                            const sizeInfo = pricingSizeFilter !== 'all' ? ` (${getFilterDisplayLabel(pricingSizeFilter)})` : '';
                            toast.success(`Prices saved for ${result.updated_count || productsToUpdate.length} products${sizeInfo}`);
                            await fetchProducts(); // Refresh to see updated prices
                          } else {
                            toast.error('Failed to save prices');
                          }
                        } catch (err) {
                          toast.dismiss(loadingToast);
                          toast.error('Failed to save prices');
                        }
                      }}
                      className="w-full mb-4 px-4 py-2.5 bg-green-600 hover:bg-green-700 text-white rounded-lg text-sm font-medium flex items-center justify-center gap-2 transition-colors"
                    >
                      <Save className="w-4 h-4" />
                      Save Prices for {pricingSizeFilter !== 'all' ? getFilterDisplayLabel(pricingSizeFilter) : 'Selected'} Products
                    </button>
                  )}
                  
                  {/* Quantity Tier Pricing Settings */}
                  <div className="bg-amber-50 border border-amber-200 rounded-lg p-3">
                    <div className="flex items-center justify-between mb-3">
                      <h4 className="text-xs font-semibold text-amber-800 flex items-center gap-1.5">
                        <Percent className="w-3.5 h-3.5" />
                        Quantity Tier Discounts
                      </h4>
                    </div>
                    
                    {/* Product Selection Checklist with Status */}
                    {(() => {
                      const allSelectedProducts = products.filter(p => 
                        Array.from(selectedProducts).includes(getProductKey(p))
                      );
                      const filtered = pricingSizeFilter !== 'all' 
                        ? getProductsFilteredBySize(pricingSizeFilter) 
                        : allSelectedProducts;
                      const scopeCount = tierProductScope.size;
                      const isScoped = scopeCount > 0;
                      
                      // Type-filter groupings (within the currently-filtered list)
                      const m2List = filtered.filter(p => p.pricing_unit === 'm2');
                      const unitList = filtered.filter(p => p.pricing_unit === 'unit');
                      const noneList = filtered.filter(p => !p.pricing_unit);
                      const listMatches = (list) =>
                        list.length > 0 && scopeCount === list.length &&
                        list.every(p => tierProductScope.has(getProductKey(p)));
                      const allMode = !isScoped;
                      const m2Mode = !allMode && listMatches(m2List);
                      const unitMode = !allMode && listMatches(unitList);
                      const noneMode = !allMode && listMatches(noneList);
                      const setScopeToList = (list) => {
                        setTierProductScope(new Set(list.map(p => getProductKey(p))));
                      };
                      const chipCls = (active) =>
                        `text-[10px] px-2 py-0.5 rounded-full border transition-all ${
                          active
                            ? 'bg-amber-600 text-white border-amber-600'
                            : 'bg-white text-amber-700 border-amber-300 hover:border-amber-500'
                        }`;
                      
                      return (
                        <div className="space-y-2">
                          {/* Per-product checklist with status */}
                          <div className={`border rounded-lg p-2.5 ${isScoped ? 'bg-amber-100/60 border-amber-300' : 'bg-white border-amber-200'}`} data-testid="tier-product-scope">
                            {/* Quick filter by current pricing-unit type */}
                            <div className="flex items-center gap-1.5 flex-wrap mb-2 pb-2 border-b border-amber-200">
                              <span className="text-[10px] font-semibold text-amber-800 mr-0.5">Filter:</span>
                              <button
                                type="button"
                                data-testid="tier-filter-all"
                                onClick={() => setTierProductScope(new Set())}
                                className={chipCls(allMode)}
                              >
                                All ({filtered.length})
                              </button>
                              <button
                                type="button"
                                data-testid="tier-filter-m2"
                                disabled={m2List.length === 0}
                                onClick={() => setScopeToList(m2List)}
                                className={`${chipCls(m2Mode)} ${m2List.length === 0 ? 'opacity-40 cursor-not-allowed' : ''}`}
                              >
                                Per m² ({m2List.length})
                              </button>
                              <button
                                type="button"
                                data-testid="tier-filter-unit"
                                disabled={unitList.length === 0}
                                onClick={() => setScopeToList(unitList)}
                                className={`${chipCls(unitMode)} ${unitList.length === 0 ? 'opacity-40 cursor-not-allowed' : ''}`}
                              >
                                Per Unit ({unitList.length})
                              </button>
                              {noneList.length > 0 && (
                                <button
                                  type="button"
                                  data-testid="tier-filter-none"
                                  onClick={() => setScopeToList(noneList)}
                                  className={chipCls(noneMode)}
                                >
                                  Not Set ({noneList.length})
                                </button>
                              )}
                            </div>
                            
                            <div className="flex items-center justify-between mb-1.5">
                              <span className="text-[11px] font-semibold text-gray-600">
                                {isScoped
                                  ? `Applying to ${scopeCount} of ${filtered.length} products`
                                  : `Applying to all ${filtered.length} products`}
                              </span>
                              <div className="flex items-center gap-1.5">
                                {isScoped && (
                                  <button
                                    type="button"
                                    onClick={() => setTierProductScope(new Set())}
                                    className="text-[10px] text-amber-700 hover:text-amber-900 underline"
                                  >
                                    All Products
                                  </button>
                                )}
                              </div>
                            </div>
                            <div className="max-h-40 overflow-y-auto space-y-0.5 pr-1">
                              {filtered.map(p => {
                                const key = getProductKey(p);
                                const isChecked = tierProductScope.has(key);
                                const name = p.product_name || p.name || p.sku;
                                const truncName = name.length > 35 ? name.substring(0, 35) + '...' : name;
                                
                                // Pricing-unit type badge
                                const currentUnit = p.pricing_unit;
                                const unitBadgeCls = currentUnit === 'm2'
                                  ? 'bg-blue-100 text-blue-700'
                                  : currentUnit === 'unit'
                                    ? 'bg-green-100 text-green-700'
                                    : 'bg-gray-100 text-gray-500';
                                const unitBadgeLabel = currentUnit === 'm2' ? 'm²' : currentUnit === 'unit' ? 'unit' : 'none';
                                
                                // Determine tier pricing status
                                let statusBadge;
                                if (p.tier_pricing_disabled) {
                                  statusBadge = <span className="text-[10px] bg-red-100 text-red-700 px-1.5 rounded flex-shrink-0 font-medium">disabled</span>;
                                } else if (p.has_custom_tier_pricing) {
                                  const discounts = p.tier_discounts;
                                  statusBadge = (
                                    <span title={discounts ? `Tiers: ${discounts.join('%, ')}%` : 'Custom tiers set'} className="text-[10px] bg-green-100 text-green-700 px-1.5 rounded flex-shrink-0 font-medium">
                                      custom
                                    </span>
                                  );
                                } else {
                                  statusBadge = <span className="text-[10px] bg-gray-100 text-gray-500 px-1.5 rounded flex-shrink-0">default</span>;
                                }
                                
                                // Dim rows excluded by an active filter
                                const dimmed = isScoped && !isChecked;
                                
                                return (
                                  <div
                                    key={key}
                                    onClick={() => {
                                      setTierProductScope(prev => {
                                        const next = new Set(prev);
                                        if (next.has(key)) {
                                          next.delete(key);
                                        } else {
                                          next.add(key);
                                        }
                                        return next;
                                      });
                                    }}
                                    className={`flex items-center gap-2 px-2 py-1.5 rounded cursor-pointer text-xs transition select-none ${
                                      isChecked 
                                        ? 'bg-amber-100 border border-amber-300' 
                                        : 'hover:bg-gray-50 border border-transparent'
                                    } ${dimmed ? 'opacity-50' : ''}`}
                                    data-testid={`tier-scope-${p.sku}`}
                                  >
                                    <input
                                      type="checkbox"
                                      checked={isChecked}
                                      readOnly
                                      className="w-3.5 h-3.5 rounded border-gray-300 text-amber-600 focus:ring-amber-500 flex-shrink-0 pointer-events-none"
                                    />
                                    <span title={name} className={`flex-1 truncate ${isChecked ? 'text-amber-800 font-medium' : 'text-gray-700'}`}>
                                      {truncName}
                                    </span>
                                    <span className={`text-[10px] px-1 py-0.5 rounded flex-shrink-0 ${unitBadgeCls}`}>
                                      {unitBadgeLabel}
                                    </span>
                                    <span title={p.sku || p.supplier_code} className="text-[10px] text-gray-400 flex-shrink-0">({p.sku || p.supplier_code})</span>
                                    {statusBadge}
                                  </div>
                                );
                              })}
                            </div>
                            {isScoped && (
                              <p className="text-[10px] text-amber-700 mt-1.5 font-medium">
                                Only the checked products will be updated when you save tier settings.
                              </p>
                            )}
                          </div>
                          
                          {/* Action Button */}
                          <button
                            type="button"
                            onClick={openTierPricingModal}
                            className="w-full text-sm bg-amber-600 hover:bg-amber-700 text-white px-3 py-2 rounded-lg flex items-center justify-center gap-2"
                            data-testid="open-tier-modal-btn"
                          >
                            <Settings2 className="w-4 h-4" />
                            {isScoped 
                              ? `Set Tier Discounts for ${scopeCount} Product${scopeCount !== 1 ? 's' : ''}`
                              : filtered.some(p => p.has_custom_tier_pricing) 
                                ? 'Edit Tier Discounts' 
                                : 'Set Tier Discounts'}
                          </button>
                        </div>
                      );
                    })()}
                  </div>
                  
                  {/* Quote Request Settings */}
                  <div className="bg-blue-50 border border-blue-200 rounded-lg p-3 mt-3">
                    <div className="flex items-center justify-between mb-2">
                      <h4 className="text-xs font-semibold text-blue-800 flex items-center gap-1.5">
                        <FileSpreadsheet className="w-3.5 h-3.5" />
                        Large Order Quotes
                      </h4>
                      <button
                        type="button"
                        onClick={() => setShowQuoteSettingsModal(true)}
                        className="text-xs bg-blue-600 hover:bg-blue-700 text-white px-2 py-1 rounded flex items-center gap-1"
                      >
                        <Settings2 className="w-3 h-3" />
                        Configure
                      </button>
                    </div>
                    <p className="text-xs text-blue-700">
                      Orders over {tierPricingConfig.custom_quote_threshold || 150}m² show "Request Quote" instead of "Add to Cart"
                    </p>
                  </div>
                  
                  {/* Pricing Unit Settings (m² vs per-unit) */}
                  <div className="bg-purple-50 border border-purple-200 rounded-lg p-3 mt-3">
                    <div className="flex items-center justify-between mb-2">
                      <h4 className="text-xs font-semibold text-purple-800 flex items-center gap-1.5">
                        <Package className="w-3.5 h-3.5" />
                        Pricing Unit
                      </h4>
                      <button
                        type="button"
                        onClick={() => {
                          // Default to 'unit' for all groups except Tiles, Flooring, Underfloor Heating
                          const m2Groups = ['tiles', 'flooring', 'underfloor-heating'];
                          const defaultUnit = (selectedProductGroup === 'all' || m2Groups.includes(selectedProductGroup)) ? 'm2' : 'unit';
                          setPricingUnitSettings(prev => ({ ...prev, pricing_unit: defaultUnit }));
                          setShowPricingUnitModal(true);
                        }}
                        className="text-xs bg-purple-600 hover:bg-purple-700 text-white px-2 py-1 rounded flex items-center gap-1"
                      >
                        <Settings2 className="w-3 h-3" />
                        Configure
                      </button>
                    </div>
                    <p className="text-xs text-purple-700">
                      Set products to price per m² (tiles) or per unit (adhesive, grout, tools)
                    </p>
                  </div>
                  
                  {/* Sale/Labels Settings */}
                  <div className="bg-rose-50 border border-rose-200 rounded-lg p-3 mt-3">
                    <div className="flex items-center justify-between mb-3">
                      <h4 className="text-xs font-semibold text-rose-800 flex items-center gap-1.5">
                        <Tag className="w-3.5 h-3.5" />
                        Sale & Labels
                      </h4>
                    </div>
                    
                    {/* Show current labels applied to selected products */}
                    {(() => {
                      const selectedSkusList = Array.from(selectedProducts);
                      const selectedProductsList = products.filter(p => selectedSkusList.includes(getProductKey(p)));
                      
                      // Count how many products have each label
                      const labelCounts = {};
                      allLabelNames.forEach(label => {
                        labelCounts[label] = selectedProductsList.filter(p => 
                          p.labels?.includes(label) || p.custom_labels?.includes(label)
                        ).length;
                      });
                      
                      // Check for WAS/NOW sale settings
                      const productsWithSale = selectedProductsList.filter(p => p.on_sale || p.was_price);
                      const productsWithWasPrice = selectedProductsList.filter(p => p.was_price);
                      
                      const hasAnyLabels = Object.values(labelCounts).some(count => count > 0);
                      
                      return (hasAnyLabels || productsWithSale.length > 0) && (
                        <div className="mb-3 p-2 bg-white border border-rose-200 rounded-lg">
                          <span className="text-xs font-medium text-rose-700 block mb-2">Currently Applied:</span>
                          <div className="flex flex-wrap gap-1.5">
                            {Object.entries(labelCounts).map(([label, count]) => count > 0 && (
                              <span key={label} className="inline-flex items-center gap-1 px-2 py-1 rounded text-xs"
                                style={{ backgroundColor: getLabelStyle(label).bg, color: getLabelStyle(label).text }}>
                                <CheckCircle className="w-3 h-3 text-green-600" />
                                {label}
                                <span style={{ opacity: 0.7 }}>({count}/{selectedProductsList.length})</span>
                              </span>
                            ))}
                            {productsWithSale.length > 0 && (
                              <span className="inline-flex items-center gap-1 px-2 py-1 bg-amber-100 text-amber-700 rounded text-xs">
                                <CheckCircle className="w-3 h-3 text-green-600" />
                                WAS/NOW Active
                                <span className="text-amber-500">({productsWithSale.length}/{selectedProductsList.length})</span>
                              </span>
                            )}
                          </div>
                          {productsWithWasPrice.length > 0 && (
                            <div className="mt-2 text-xs text-rose-600">
                              WAS prices set: £{Math.min(...productsWithWasPrice.map(p => p.was_price))} - £{Math.max(...productsWithWasPrice.map(p => p.was_price))}
                            </div>
                          )}
                        </div>
                      );
                    })()}
                    
                    {/* Labels Selection */}
                    <div className="mb-3">
                      <span className="text-xs text-rose-700 font-medium block mb-2">Product Labels:</span>
                      <div className="flex flex-wrap gap-1.5">
                        {(() => {
                          const selectedSkusList = Array.from(selectedProducts);
                          const selectedProductsList = products.filter(p => selectedSkusList.includes(getProductKey(p)));
                          
                          return allLabelNames.map(label => {
                            const appliedCount = selectedProductsList.filter(p => 
                              p.labels?.includes(label) || p.custom_labels?.includes(label)
                            ).length;
                            const isFullyApplied = appliedCount === selectedProductsList.length && appliedCount > 0;
                            const isPartiallyApplied = appliedCount > 0 && appliedCount < selectedProductsList.length;
                            const isSelectedToApply = bulkSaleSettings.labels.includes(label);
                            const style = getLabelStyle(label);
                            
                            return (
                              <button
                                key={label}
                                type="button"
                                onClick={() => {
                                  setBulkSaleSettings(prev => ({
                                    ...prev,
                                    labels: prev.labels.includes(label)
                                      ? prev.labels.filter(l => l !== label)
                                      : [...prev.labels, label]
                                  }));
                                }}
                                className={`px-2 py-1 rounded text-xs font-medium transition-all relative ${
                                  isSelectedToApply
                                    ? 'text-white'
                                    : isFullyApplied
                                      ? 'border border-green-400 ring-2 ring-green-300'
                                      : isPartiallyApplied
                                        ? 'border border-amber-400'
                                        : 'border hover:opacity-80'
                                }`}
                                style={isSelectedToApply
                                  ? { backgroundColor: style.color, color: 'white' }
                                  : isFullyApplied
                                    ? { backgroundColor: '#f0fdf4', color: '#15803d' }
                                    : isPartiallyApplied
                                      ? { backgroundColor: '#fffbeb', color: '#a16207' }
                                      : { backgroundColor: style.bg, color: style.text, borderColor: style.color + '60' }
                                }
                              >
                                {isSelectedToApply && <Check className="w-3 h-3 inline mr-1" />}
                                {!isSelectedToApply && isFullyApplied && <CheckCircle className="w-3 h-3 inline mr-1 text-green-600" />}
                                {label}
                                {appliedCount > 0 && !isSelectedToApply && (
                                  <span className="ml-1 text-[10px] opacity-70">({appliedCount})</span>
                                )}
                              </button>
                            );
                          });
                        })()}
                      </div>
                      
                      {/* Label Manager - Add/Edit/Delete */}
                      <div className="mt-2 pt-2 border-t border-rose-100">
                        <span className="text-[10px] text-gray-500 block mb-1.5">Manage Labels:</span>
                        <LabelManager
                          labels={dbLabels}
                          onAdd={handleAddLabel}
                          onEdit={handleEditLabel}
                          onDelete={handleDeleteLabel}
                          loading={dbLabelsLoading}
                        />
                      </div>
                      
                      <p className="text-[10px] text-rose-500 mt-1.5">
                        <span className="inline-block w-2 h-2 bg-green-400 rounded-full mr-1"></span> = Applied to all
                        <span className="inline-block w-2 h-2 bg-amber-300 rounded-full ml-2 mr-1"></span> = Partially applied
                      </p>
                    </div>
                    
                    {/* WAS/NOW Sale Pricing */}
                    <div className="border-t border-rose-200 pt-3">
                      <div className="flex items-center gap-2 mb-2">
                        <input
                          type="checkbox"
                          id="bulk-sale-active"
                          checked={bulkSaleSettings.sale_active}
                          onChange={(e) => setBulkSaleSettings(prev => ({ ...prev, sale_active: e.target.checked }))}
                          className="w-4 h-4 rounded border-gray-300 text-rose-600 focus:ring-rose-500"
                        />
                        <label htmlFor="bulk-sale-active" className="text-xs font-medium text-rose-800">
                          Enable WAS/NOW Sale Display
                        </label>
                      </div>
                      
                      {bulkSaleSettings.sale_active && (
                        <div className="grid grid-cols-2 gap-3 mt-2">
                          <div>
                            <label className="text-xs text-rose-700 block mb-1">WAS Markup (%)</label>
                            <Input
                              type="number"
                              value={bulkSaleSettings.was_markup_percent}
                              onChange={(e) => setBulkSaleSettings(prev => ({ 
                                ...prev, 
                                was_markup_percent: e.target.value,
                                was_price: '' // Clear direct price when using markup
                              }))}
                              placeholder="e.g., 30"
                              className="h-8 text-sm"
                            />
                            <p className="text-xs text-rose-600 mt-0.5">Add % on top of list price</p>
                          </div>
                          <div>
                            <label className="text-xs text-rose-700 block mb-1">OR WAS Price (£)</label>
                            <Input
                              type="number"
                              step="0.01"
                              value={bulkSaleSettings.was_price}
                              onChange={(e) => setBulkSaleSettings(prev => ({ 
                                ...prev, 
                                was_price: e.target.value,
                                was_markup_percent: '' // Clear markup when using direct price
                              }))}
                              placeholder="e.g., 39.99"
                              className="h-8 text-sm"
                            />
                            <p className="text-xs text-rose-600 mt-0.5">Direct WAS price entry</p>
                          </div>
                        </div>
                      )}
                    </div>
                    
                    {/* Apply Button */}
                    <div className="mt-3 pt-2 border-t border-rose-200">
                      {/* Product Selection for Sale & Labels */}
                      {(bulkSaleSettings.labels.length > 0 || bulkSaleSettings.sale_active) && (() => {
                        const selectedSkusList = Array.from(selectedProducts);
                        const selectedProductsList = products.filter(p => selectedSkusList.includes(getProductKey(p)));
                        const targetCount = saleTargetProducts.size > 0 ? saleTargetProducts.size : selectedProductsList.length;
                        const allTargeted = saleTargetProducts.size === 0 || saleTargetProducts.size === selectedProductsList.length;
                        
                        return (
                          <div className="mb-3">
                            <div className="flex items-center justify-between mb-2">
                              <span className="text-xs font-semibold text-rose-700">Apply to specific products:</span>
                              <div className="flex gap-1">
                                <button
                                  type="button"
                                  onClick={() => {
                                    const allKeys = new Set(selectedProductsList.map(p => getProductKey(p)));
                                    setSaleTargetProducts(allKeys);
                                  }}
                                  className="text-[10px] px-1.5 py-0.5 bg-rose-100 text-rose-600 rounded hover:bg-rose-200"
                                >
                                  All
                                </button>
                                <button
                                  type="button"
                                  onClick={() => setSaleTargetProducts(new Set())}
                                  className="text-[10px] px-1.5 py-0.5 bg-gray-100 text-gray-600 rounded hover:bg-gray-200"
                                >
                                  Clear
                                </button>
                              </div>
                            </div>
                            
                            {/* Quick filter by current pricing-unit type */}
                            {(() => {
                              const m2List = selectedProductsList.filter(p => p.pricing_unit === 'm2');
                              const unitList = selectedProductsList.filter(p => p.pricing_unit === 'unit');
                              const noneList = selectedProductsList.filter(p => !p.pricing_unit);
                              const targetSize = saleTargetProducts.size;
                              const allMode = targetSize === 0 || targetSize === selectedProductsList.length;
                              const listMatches = (list) =>
                                list.length > 0 && targetSize === list.length &&
                                list.every(p => saleTargetProducts.has(getProductKey(p)));
                              const m2Mode = !allMode && listMatches(m2List);
                              const unitMode = !allMode && listMatches(unitList);
                              const noneMode = !allMode && listMatches(noneList);
                              const setFilterToList = (list) => {
                                setSaleTargetProducts(new Set(list.map(p => getProductKey(p))));
                              };
                              const chipCls = (active) =>
                                `text-[10px] px-2 py-0.5 rounded-full border transition-all ${
                                  active
                                    ? 'bg-rose-600 text-white border-rose-600'
                                    : 'bg-white text-rose-700 border-rose-300 hover:border-rose-500'
                                }`;
                              return (
                                <div className="flex flex-wrap gap-1 mb-2">
                                  <button
                                    type="button"
                                    data-testid="sale-filter-all"
                                    onClick={() => {
                                      const allKeys = new Set(selectedProductsList.map(p => getProductKey(p)));
                                      setSaleTargetProducts(allKeys);
                                    }}
                                    className={chipCls(allMode)}
                                  >
                                    All ({selectedProductsList.length})
                                  </button>
                                  <button
                                    type="button"
                                    data-testid="sale-filter-m2"
                                    disabled={m2List.length === 0}
                                    onClick={() => setFilterToList(m2List)}
                                    className={`${chipCls(m2Mode)} ${m2List.length === 0 ? 'opacity-40 cursor-not-allowed' : ''}`}
                                  >
                                    Per m² ({m2List.length})
                                  </button>
                                  <button
                                    type="button"
                                    data-testid="sale-filter-unit"
                                    disabled={unitList.length === 0}
                                    onClick={() => setFilterToList(unitList)}
                                    className={`${chipCls(unitMode)} ${unitList.length === 0 ? 'opacity-40 cursor-not-allowed' : ''}`}
                                  >
                                    Per Unit ({unitList.length})
                                  </button>
                                  {noneList.length > 0 && (
                                    <button
                                      type="button"
                                      data-testid="sale-filter-none"
                                      onClick={() => setFilterToList(noneList)}
                                      className={chipCls(noneMode)}
                                    >
                                      Not Set ({noneList.length})
                                    </button>
                                  )}
                                </div>
                              );
                            })()}
                            
                            <div className="max-h-36 overflow-y-auto border border-rose-200 rounded-lg bg-white">
                              {selectedProductsList.map(p => {
                                const key = getProductKey(p);
                                const isChecked = saleTargetProducts.size === 0 || saleTargetProducts.has(key);
                                const name = p.product_name || p.name || p.sku;
                                const hasLabel = p.labels?.length > 0;
                                const onSale = p.on_sale || p.was_price;
                                const currentUnit = p.pricing_unit;
                                const unitBadgeCls = currentUnit === 'm2'
                                  ? 'bg-blue-100 text-blue-700'
                                  : currentUnit === 'unit'
                                    ? 'bg-green-100 text-green-700'
                                    : 'bg-gray-100 text-gray-500';
                                const unitBadgeLabel = currentUnit === 'm2' ? 'm²' : currentUnit === 'unit' ? 'unit' : 'none';
                                return (
                                  <label
                                    key={key}
                                    className={`flex items-center gap-2 px-3 py-1.5 text-xs border-b border-rose-50 last:border-0 cursor-pointer hover:bg-rose-50 ${isChecked && saleTargetProducts.size > 0 ? 'bg-rose-50' : ''}`}
                                  >
                                    <input
                                      type="checkbox"
                                      checked={isChecked}
                                      onChange={() => {
                                        setSaleTargetProducts(prev => {
                                          const next = new Set(prev);
                                          if (prev.size === 0) {
                                            // First click: select all, then deselect this one
                                            selectedProductsList.forEach(sp => next.add(getProductKey(sp)));
                                            next.delete(key);
                                          } else if (next.has(key)) {
                                            next.delete(key);
                                          } else {
                                            next.add(key);
                                          }
                                          return next;
                                        });
                                      }}
                                      className="w-3.5 h-3.5 rounded border-rose-300 text-rose-600 focus:ring-rose-500"
                                    />
                                    <span className="flex-1 truncate text-gray-700">{name}</span>
                                    <span className={`text-[10px] px-1 py-0.5 rounded ${unitBadgeCls}`}>
                                      {unitBadgeLabel}
                                    </span>
                                    {hasLabel && (
                                      <span className="text-[10px] px-1 py-0.5 bg-green-100 text-green-700 rounded">{p.labels.join(', ')}</span>
                                    )}
                                    {onSale && (
                                      <span className="text-[10px] px-1 py-0.5 bg-amber-100 text-amber-700 rounded">On Sale</span>
                                    )}
                                  </label>
                                );
                              })}
                            </div>
                            <p className="text-[10px] text-rose-500 mt-1">
                              {saleTargetProducts.size > 0
                                ? `${saleTargetProducts.size} of ${selectedProductsList.length} products selected`
                                : `All ${selectedProductsList.length} products (uncheck to pick specific ones)`
                              }
                            </p>
                          </div>
                        );
                      })()}
                      
                      <button
                        type="button"
                        onClick={saveBulkSaleSettings}
                        disabled={bulkSaleSaving || selectedProducts.size === 0}
                        className="w-full text-xs bg-rose-600 hover:bg-rose-700 disabled:bg-gray-300 text-white px-3 py-2 rounded flex items-center justify-center gap-1"
                      >
                        {bulkSaleSaving ? (
                          <RefreshCw className="w-3 h-3 animate-spin" />
                        ) : (
                          <Save className="w-3 h-3" />
                        )}
                        Apply Sale Settings to {saleTargetProducts.size > 0 ? saleTargetProducts.size : selectedProducts.size} Products
                      </button>
                    </div>
                  </div>
                </div>

                {/* Discount Calculator Preview Widget */}
                {selectedProducts.size > 0 && (
                  <DiscountCalculatorPreview
                    selectedProduct={products.find(p => selectedProducts.has(getProductKey(p)))}
                    tierPricingConfig={tierPricingConfig}
                  />
                )}

                {/* TILES PER BOX SECTION — Only for surface product groups */}
                {['tiles', 'flooring', 'underfloor-heating'].includes(selectedProductGroup) && (
                <div className="bg-teal-50 border border-teal-200 rounded-lg p-3 mt-3">
                  <div className="flex items-center justify-between mb-3">
                    <h4 className="text-xs font-semibold text-teal-800 flex items-center gap-1.5">
                      <Package className="w-3.5 h-3.5" />
                      Tiles per Box / Box Coverage
                    </h4>
                  </div>
                  
                  {/* Size Filter for Tiles per Box */}
                  {(() => {
                    const uniqueSizes = getUniqueSizesFromSelected();
                    const filteredProducts = getProductsFilteredBySize(tilesPerBoxSizeFilter);
                    const filteredCount = filteredProducts.length;
                    
                    // Calculate current values stats
                    const tilesPerBoxValues = filteredProducts.map(p => p.tiles_per_box).filter(v => v);
                    const sqmPerBoxValues = filteredProducts.map(p => p.sqm_per_box).filter(v => v);
                    const uniqueTiles = [...new Set(tilesPerBoxValues)];
                    const uniqueSqm = [...new Set(sqmPerBoxValues.map(v => parseFloat(v).toFixed(2)))];
                    const allHaveTiles = tilesPerBoxValues.length === filteredCount;
                    const allHaveSqm = sqmPerBoxValues.length === filteredCount;
                    const allSameTiles = uniqueTiles.length === 1 && allHaveTiles;
                    const allSameSqm = uniqueSqm.length === 1 && allHaveSqm;
                    
                    return (
                      <>
                        {/* Current Values Status */}
                        <div className={`mb-3 p-2 rounded-lg border ${
                          allSameTiles && allSameSqm 
                            ? 'bg-green-50 border-green-300' 
                            : tilesPerBoxValues.length > 0 || sqmPerBoxValues.length > 0
                              ? 'bg-amber-50 border-amber-300'
                              : 'bg-gray-50 border-gray-200'
                        }`}>
                          <div className="flex items-center justify-between">
                            <span className="text-xs font-medium text-gray-700 flex items-center gap-1.5">
                              {allSameTiles && allSameSqm ? (
                                <>
                                  <CheckCircle className="w-3.5 h-3.5 text-green-600" />
                                  <span className="text-green-700">All {filteredCount} products have same box settings</span>
                                </>
                              ) : tilesPerBoxValues.length > 0 || sqmPerBoxValues.length > 0 ? (
                                <>
                                  <AlertCircle className="w-3.5 h-3.5 text-amber-600" />
                                  <span className="text-amber-700">Mixed values across products</span>
                                </>
                              ) : (
                                <>
                                  <AlertCircle className="w-3.5 h-3.5 text-gray-400" />
                                  <span className="text-gray-500">No box settings configured</span>
                                </>
                              )}
                            </span>
                            {(tilesPerBoxValues.length > 0 || sqmPerBoxValues.length > 0) && (
                              <span className="text-xs text-gray-500">
                                {tilesPerBoxValues.length}/{filteredCount} have Tiles/Box • {sqmPerBoxValues.length}/{filteredCount} have m²/Box
                              </span>
                            )}
                          </div>
                          
                          {/* Show current values */}
                          {(tilesPerBoxValues.length > 0 || sqmPerBoxValues.length > 0) && (
                            <div className="mt-2 grid grid-cols-2 gap-2 text-xs">
                              <div className={`p-1.5 rounded ${allSameTiles ? 'bg-green-100' : 'bg-white'}`}>
                                <span className="text-gray-600">Tiles/Box:</span>{' '}
                                <span className="font-semibold">
                                  {tilesPerBoxValues.length === 0 ? '—' :
                                   uniqueTiles.length === 1 ? uniqueTiles[0] :
                                   `${Math.min(...tilesPerBoxValues)} - ${Math.max(...tilesPerBoxValues)}`}
                                </span>
                              </div>
                              <div className={`p-1.5 rounded ${allSameSqm ? 'bg-green-100' : 'bg-white'}`}>
                                <span className="text-gray-600">m²/Box:</span>{' '}
                                <span className="font-semibold">
                                  {sqmPerBoxValues.length === 0 ? '—' :
                                   uniqueSqm.length === 1 ? `${uniqueSqm[0]}m²` :
                                   `${Math.min(...sqmPerBoxValues).toFixed(2)} - ${Math.max(...sqmPerBoxValues).toFixed(2)}m²`}
                                </span>
                              </div>
                            </div>
                          )}
                        </div>
                        
                        {/* Size Filter Checkboxes + Individual Products */}
                        {uniqueSizes.length > 1 && (() => {
                          const allSelected = Array.from(selectedProducts);
                          const allBoxSelectedProducts = products.filter(p => allSelected.includes(getProductKey(p)));
                          const currentBoxSizeKeys = tilesPerBoxSizeFilter.startsWith('multi:')
                            ? tilesPerBoxSizeFilter.substring(6).split('\n').filter(Boolean)
                            : [];
                          const currentBoxProductKeys = tilesPerBoxSizeFilter.startsWith('product:')
                            ? tilesPerBoxSizeFilter.substring(8).split('\n')
                            : [];
                          const isBoxProductMode = tilesPerBoxSizeFilter.startsWith('product:');
                          const allBoxSizesChecked = tilesPerBoxSizeFilter === 'all' || currentBoxSizeKeys.length === 0;
                          
                          const onBoxFilterChange = (newFilter) => {
                            setTilesPerBoxSizeFilter(newFilter);
                            const filtered = getProductsFilteredBySize(newFilter);
                            if (filtered.length > 0) {
                              const newTilesPerBoxValues = filtered.map(p => p.tiles_per_box).filter(v => v);
                              const newSqmPerBoxValues = filtered.map(p => p.sqm_per_box).filter(v => v);
                              const newUniqueTiles = [...new Set(newTilesPerBoxValues)];
                              const newUniqueSqm = [...new Set(newSqmPerBoxValues.map(v => parseFloat(v).toFixed(2)))];
                              setBulkTilesPerBoxSettings(prev => ({
                                ...prev,
                                tiles_per_box: newUniqueTiles.length === 1 ? newUniqueTiles[0].toString() : prev.tiles_per_box,
                                sqm_per_box: newUniqueSqm.length === 1 ? newUniqueSqm[0] : prev.sqm_per_box
                              }));
                            }
                          };
                          
                          const toggleBoxSizeFilter = (filterValue) => {
                            let newKeys;
                            if (allBoxSizesChecked && !isBoxProductMode) {
                              newKeys = [filterValue];
                            } else if (currentBoxSizeKeys.includes(filterValue)) {
                              newKeys = currentBoxSizeKeys.filter(k => k !== filterValue);
                            } else {
                              newKeys = [...currentBoxSizeKeys, filterValue];
                            }
                            if (newKeys.length === 0 || newKeys.length === uniqueSizes.length) {
                              onBoxFilterChange('all');
                            } else {
                              onBoxFilterChange('multi:' + newKeys.join('\n'));
                            }
                          };
                          
                          const toggleBoxProduct = (productKey) => {
                            let newKeys;
                            if (isBoxProductMode) {
                              if (currentBoxProductKeys.includes(productKey)) {
                                newKeys = currentBoxProductKeys.filter(k => k !== productKey);
                              } else {
                                newKeys = [...currentBoxProductKeys, productKey];
                              }
                            } else {
                              newKeys = [productKey];
                            }
                            if (newKeys.length === 0 || newKeys.length === allBoxSelectedProducts.length) {
                              onBoxFilterChange('all');
                            } else {
                              onBoxFilterChange('product:' + newKeys.join('\n'));
                            }
                          };
                          
                          const visibleBoxProducts = isBoxProductMode
                            ? allBoxSelectedProducts
                            : getProductsFilteredBySize(tilesPerBoxSizeFilter);
                          const sortedBoxProducts = [...visibleBoxProducts].sort((a, b) =>
                            (a.product_name || a.name || '').localeCompare(b.product_name || b.name || '')
                          );
                          
                          return (
                            <div className="mb-3 p-2 bg-white border border-teal-100 rounded-lg">
                              <div className="flex items-center justify-between mb-2">
                                <label className="text-xs font-medium text-teal-700">Filter by Size:</label>
                                <div className="flex items-center gap-2">
                                  {(tilesPerBoxSizeFilter !== 'all') && (
                                    <>
                                      <span className="text-xs text-teal-600 font-medium">
                                        {filteredCount} product{filteredCount !== 1 ? 's' : ''} selected
                                      </span>
                                      <button 
                                        onClick={() => onBoxFilterChange('all')}
                                        className="text-xs text-teal-600 hover:text-teal-800 underline"
                                      >
                                        Select All
                                      </button>
                                    </>
                                  )}
                                  {tilesPerBoxSizeFilter === 'all' && (
                                    <span className="text-xs text-teal-600 font-medium">
                                      {selectedProducts.size} products selected
                                    </span>
                                  )}
                                </div>
                              </div>
                              <div className="max-h-36 overflow-y-auto border border-teal-200 rounded-lg bg-white">
                                {uniqueSizes.map(opt => {
                                  const count = getProductsFilteredBySize(opt.value).length;
                                  const isChecked = (allBoxSizesChecked && !isBoxProductMode) || currentBoxSizeKeys.includes(opt.value);
                                  return (
                                    <label 
                                      key={opt.value}
                                      className={`flex items-center gap-2 px-3 py-1.5 cursor-pointer hover:bg-teal-50 border-b border-teal-100 last:border-b-0 transition-colors ${isChecked && !allBoxSizesChecked ? 'bg-teal-50' : ''} ${opt.isSubGroup ? 'pl-6' : ''}`}
                                    >
                                      <input 
                                        type="checkbox"
                                        checked={isChecked}
                                        onChange={() => toggleBoxSizeFilter(opt.value)}
                                        className="rounded border-teal-300 text-teal-600 focus:ring-teal-500 h-3.5 w-3.5"
                                      />
                                      <span className="text-xs text-gray-800 flex-1">
                                        {opt.isSubGroup ? '↳ ' : ''}{opt.label}
                                      </span>
                                      <span className="text-xs text-teal-500 font-medium shrink-0">({count})</span>
                                    </label>
                                  );
                                })}
                              </div>
                              
                              {/* Individual product checkboxes */}
                              <div className="mt-2 border-t border-teal-100 pt-2">
                                <div className="flex items-center justify-between mb-1">
                                  <label className="text-xs font-medium text-teal-700">Individual Products:</label>
                                  {isBoxProductMode && (
                                    <span className="text-xs text-teal-600">{currentBoxProductKeys.length} of {allBoxSelectedProducts.length}</span>
                                  )}
                                </div>
                                <div className="max-h-36 overflow-y-auto border border-teal-200 rounded-lg bg-white">
                                  {sortedBoxProducts.map(p => {
                                    const key = getProductKey(p);
                                    const name = p.product_name || p.name || p.sku;
                                    const isChecked = !isBoxProductMode || currentBoxProductKeys.includes(key);
                                    const tpb = p.tiles_per_box ? `${p.tiles_per_box}t` : '';
                                    const spb = p.sqm_per_box ? `${parseFloat(p.sqm_per_box).toFixed(2)}m²` : '';
                                    const boxInfo = [tpb, spb].filter(Boolean).join(' / ');
                                    return (
                                      <label 
                                        key={key}
                                        className={`flex items-center gap-2 px-3 py-1.5 cursor-pointer hover:bg-teal-50 border-b border-teal-100 last:border-b-0 transition-colors ${isChecked && isBoxProductMode ? 'bg-teal-50' : ''}`}
                                      >
                                        <input 
                                          type="checkbox"
                                          checked={isChecked}
                                          onChange={() => toggleBoxProduct(key)}
                                          className="rounded border-teal-300 text-teal-600 focus:ring-teal-500 h-3.5 w-3.5"
                                        />
                                        <span className="text-xs text-gray-800 truncate flex-1">{name}</span>
                                        {boxInfo && <span className="text-xs text-teal-500 shrink-0">{boxInfo}</span>}
                                        <span className="text-xs text-gray-400 shrink-0">{p.sku || p.supplier_code}</span>
                                      </label>
                                    );
                                  })}
                                </div>
                              </div>
                              
                              {tilesPerBoxSizeFilter !== 'all' && (
                                <p className="text-xs text-teal-600 mt-1">
                                  Box settings will only apply to {filteredCount} selected product{filteredCount !== 1 ? 's' : ''}
                                </p>
                              )}
                            </div>
                          );
                        })()}
                      </>
                    );
                  })()}
                  
                  {/* Input Fields */}
                  <div className="grid grid-cols-2 gap-3 mb-3">
                    <div>
                      <label className="text-xs text-teal-700 font-medium block mb-1">
                        Tiles per Box
                      </label>
                      <input
                        type="number"
                        min="1"
                        step="1"
                        value={bulkTilesPerBoxSettings.tiles_per_box}
                        onChange={(e) => setBulkTilesPerBoxSettings(prev => ({ ...prev, tiles_per_box: e.target.value }))}
                        placeholder="e.g., 4"
                        className="w-full px-3 py-2 border border-teal-200 rounded-lg text-sm focus:ring-2 focus:ring-teal-500 focus:border-teal-500"
                      />
                    </div>
                    <div>
                      <label className="text-xs text-teal-700 font-medium block mb-1">
                        m² per Box
                      </label>
                      <input
                        type="number"
                        min="0"
                        step="0.01"
                        value={bulkTilesPerBoxSettings.sqm_per_box}
                        onChange={(e) => setBulkTilesPerBoxSettings(prev => ({ ...prev, sqm_per_box: e.target.value }))}
                        placeholder="e.g., 1.44"
                        className="w-full px-3 py-2 border border-teal-200 rounded-lg text-sm focus:ring-2 focus:ring-teal-500 focus:border-teal-500"
                      />
                    </div>
                  </div>
                  
                  {/* Auto-Suggestions based on detected sizes AND most used values from database */}
                  {(() => {
                    // Common tile size configurations: { size: { tilesPerBox, sqmPerBox, dimensions } }
                    const commonConfigs = {
                      '60x60': { tiles: 4, sqm: 1.44, width: 600, height: 600, label: '60x60cm' },
                      '60x120': { tiles: 2, sqm: 1.44, width: 600, height: 1200, label: '60x120cm' },
                      '120x60': { tiles: 2, sqm: 1.44, width: 1200, height: 600, label: '120x60cm' },
                      '30x60': { tiles: 8, sqm: 1.44, width: 300, height: 600, label: '30x60cm' },
                      '60x30': { tiles: 8, sqm: 1.44, width: 600, height: 300, label: '60x30cm' },
                      '80x80': { tiles: 2, sqm: 1.28, width: 800, height: 800, label: '80x80cm' },
                      '90x90': { tiles: 2, sqm: 1.62, width: 900, height: 900, label: '90x90cm' },
                      '100x100': { tiles: 2, sqm: 2.0, width: 1000, height: 1000, label: '100x100cm' },
                      '120x120': { tiles: 2, sqm: 2.88, width: 1200, height: 1200, label: '120x120cm' },
                      '45x45': { tiles: 6, sqm: 1.215, width: 450, height: 450, label: '45x45cm' },
                      '33x33': { tiles: 9, sqm: 0.98, width: 330, height: 330, label: '33x33cm' },
                      '20x20': { tiles: 25, sqm: 1.0, width: 200, height: 200, label: '20x20cm' },
                      '60x60x2': { tiles: 2, sqm: 0.72, width: 600, height: 600, label: '60x60x2cm (20mm)' },
                      '60x120x2': { tiles: 2, sqm: 1.44, width: 600, height: 1200, label: '60x120x2cm (20mm)' },
                      '60x90x2': { tiles: 2, sqm: 1.08, width: 600, height: 900, label: '60x90x2cm (20mm)' },
                      '90x90x2': { tiles: 2, sqm: 1.62, width: 900, height: 900, label: '90x90x2cm (20mm)' },
                    };
                    
                    // Get products to analyze
                    const filteredProducts = tilesPerBoxSizeFilter !== 'all' 
                      ? getProductsFilteredBySize(tilesPerBoxSizeFilter)
                      : products.filter(p => Array.from(selectedProducts).includes(getProductKey(p)));
                    
                    // --- MOST USED tiles/box from ALL products in database ---
                    const boxConfigCounts = {};
                    products.forEach(p => {
                      const tpb = p.tiles_per_box;
                      const spb = p.sqm_per_box || p.box_coverage;
                      if (tpb && tpb > 0) {
                        const key = `${tpb}|${spb || ''}`;
                        if (!boxConfigCounts[key]) {
                          boxConfigCounts[key] = { tiles: tpb, sqm: spb, count: 0 };
                        }
                        boxConfigCounts[key].count++;
                      }
                    });
                    const mostUsed = Object.values(boxConfigCounts)
                      .sort((a, b) => b.count - a.count)
                      .slice(0, 6);
                    
                    // --- Size-based suggestions from product names ---
                    const detectedSizes = new Map();
                    filteredProducts.forEach(p => {
                      const name = (p.product_name || p.name || '').toLowerCase();
                      const sizeMatch = name.match(/(\d+(?:\.\d+)?)[xX](\d+(?:\.\d+)?)(?:[xX](\d+(?:\.\d+)?))?(?:cm|mm)?/i);
                      if (sizeMatch) {
                        let width = parseFloat(sizeMatch[1]);
                        let height = parseFloat(sizeMatch[2]);
                        const thickness = sizeMatch[3] ? parseFloat(sizeMatch[3]) : null;
                        if (width > 200) width = Math.round(width / 10);
                        if (height > 200) height = Math.round(height / 10);
                        let key = `${width}x${height}`;
                        if (thickness && thickness >= 2 && thickness <= 3) {
                          key = `${width}x${height}x${thickness}`;
                        }
                        detectedSizes.set(key, (detectedSizes.get(key) || 0) + 1);
                      }
                    });
                    
                    const sizeSuggestions = [];
                    detectedSizes.forEach((count, sizeKey) => {
                      if (commonConfigs[sizeKey]) {
                        sizeSuggestions.push({ ...commonConfigs[sizeKey], key: sizeKey, count });
                      }
                    });
                    sizeSuggestions.sort((a, b) => b.count - a.count);
                    
                    const hasSuggestions = mostUsed.length > 0 || sizeSuggestions.length > 0;
                    if (!hasSuggestions) return null;
                    
                    return (
                      <div className="bg-gradient-to-r from-teal-50 to-cyan-50 border border-teal-200 rounded-lg p-2 mb-3 space-y-2">
                        {/* Most Used from database */}
                        {mostUsed.length > 0 && (
                          <div>
                            <p className="text-xs font-semibold text-teal-700 mb-1.5 flex items-center gap-1">
                              <Sparkles className="w-3 h-3" />
                              Most Used (from your products)
                            </p>
                            <div className="flex flex-wrap gap-1.5">
                              {mostUsed.map((s, idx) => (
                                <button
                                  key={`used-${idx}`}
                                  type="button"
                                  onClick={() => {
                                    setBulkTilesPerBoxSettings(prev => ({
                                      ...prev,
                                      tiles_per_box: s.tiles.toString(),
                                      sqm_per_box: s.sqm ? s.sqm.toString() : prev.sqm_per_box
                                    }));
                                    toast.success(`Applied: ${s.tiles} tiles/box${s.sqm ? ` = ${s.sqm}m²` : ''}`);
                                  }}
                                  className="px-2 py-1.5 bg-white hover:bg-teal-100 border border-teal-300 rounded-md text-xs transition-colors"
                                >
                                  <span className="font-bold text-teal-800">{s.tiles} tiles</span>
                                  {s.sqm && <span className="text-teal-600 ml-1">= {parseFloat(s.sqm).toFixed(2)}m²</span>}
                                  <span className="ml-1 px-1 py-0.5 bg-teal-100 text-teal-700 rounded text-[10px]">
                                    {s.count} products
                                  </span>
                                </button>
                              ))}
                            </div>
                          </div>
                        )}
                        {/* Size-based suggestions */}
                        {sizeSuggestions.length > 0 && (
                          <div>
                            <p className="text-xs font-semibold text-teal-700 mb-1.5 flex items-center gap-1">
                              <Sparkles className="w-3 h-3" />
                              Auto-Suggestions (based on detected sizes)
                            </p>
                            <div className="flex flex-wrap gap-1.5">
                              {sizeSuggestions.slice(0, 4).map((s) => (
                                <button
                                  key={s.key}
                                  type="button"
                                  onClick={() => {
                                    setBulkTilesPerBoxSettings(prev => ({
                                      ...prev,
                                      tiles_per_box: s.tiles.toString(),
                                      sqm_per_box: s.sqm.toString(),
                                      tile_width: s.width.toString(),
                                      tile_height: s.height.toString()
                                    }));
                                    toast.success(`Applied ${s.label}: ${s.tiles} tiles = ${s.sqm}m²/box`);
                                  }}
                                  className="px-2 py-1.5 bg-white hover:bg-teal-100 border border-teal-300 rounded-md text-xs transition-colors group"
                                >
                                  <span className="font-medium text-teal-800">{s.label}</span>
                                  <span className="text-teal-600 ml-1">
                                    ({s.tiles} tiles = {s.sqm}m²)
                                  </span>
                                  {s.count > 1 && (
                                    <span className="ml-1 px-1 py-0.5 bg-teal-100 text-teal-700 rounded text-[10px]">
                                      {s.count} products
                                    </span>
                                  )}
                                </button>
                              ))}
                            </div>
                          </div>
                        )}
                      </div>
                    );
                  })()}
                  
                  {/* Auto-calculate helper */}
                  <div className="bg-white border border-teal-100 rounded-lg p-2 mb-3">
                    <p className="text-xs text-teal-600 mb-2">
                      <strong>Auto-calculate m² per Box:</strong> Enter tile dimensions (mm) to calculate
                    </p>
                    <div className="grid grid-cols-3 gap-2">
                      <input
                        type="number"
                        min="0"
                        value={bulkTilesPerBoxSettings.tile_width}
                        onChange={(e) => setBulkTilesPerBoxSettings(prev => ({ ...prev, tile_width: e.target.value }))}
                        placeholder="Width (mm)"
                        className="px-2 py-1 border border-teal-200 rounded text-xs"
                      />
                      <input
                        type="number"
                        min="0"
                        value={bulkTilesPerBoxSettings.tile_height}
                        onChange={(e) => setBulkTilesPerBoxSettings(prev => ({ ...prev, tile_height: e.target.value }))}
                        placeholder="Height (mm)"
                        className="px-2 py-1 border border-teal-200 rounded text-xs"
                      />
                      <button
                        type="button"
                        onClick={() => {
                          const width = parseFloat(bulkTilesPerBoxSettings.tile_width) || 0;
                          const height = parseFloat(bulkTilesPerBoxSettings.tile_height) || 0;
                          const tiles = parseInt(bulkTilesPerBoxSettings.tiles_per_box) || 0;
                          if (width > 0 && height > 0 && tiles > 0) {
                            // Convert mm to m and calculate m² per tile, then multiply by tiles per box
                            const sqmPerTile = (width / 1000) * (height / 1000);
                            const sqmPerBox = (sqmPerTile * tiles).toFixed(3);
                            setBulkTilesPerBoxSettings(prev => ({ ...prev, sqm_per_box: sqmPerBox }));
                            toast.success(`Calculated: ${sqmPerBox}m² per box`);
                          } else {
                            toast.error('Please enter width, height, and tiles per box first');
                          }
                        }}
                        className="px-2 py-1 bg-teal-600 hover:bg-teal-700 text-white rounded text-xs"
                      >
                        Calculate
                      </button>
                    </div>
                    {bulkTilesPerBoxSettings.tiles_per_box && bulkTilesPerBoxSettings.sqm_per_box && (
                      <p className="text-xs text-teal-700 mt-2 font-medium">
                        Box Coverage: {bulkTilesPerBoxSettings.tiles_per_box} tiles = {bulkTilesPerBoxSettings.sqm_per_box}m²
                      </p>
                    )}
                  </div>
                  
                  {/* Apply Button */}
                  <button
                    type="button"
                    onClick={saveBulkTilesPerBoxSettings}
                    disabled={bulkTilesPerBoxSaving || selectedProducts.size === 0 || (!bulkTilesPerBoxSettings.tiles_per_box && !bulkTilesPerBoxSettings.sqm_per_box)}
                    className="w-full text-xs bg-teal-600 hover:bg-teal-700 disabled:bg-gray-300 text-white px-3 py-2 rounded flex items-center justify-center gap-1"
                  >
                    {bulkTilesPerBoxSaving ? (
                      <RefreshCw className="w-3 h-3 animate-spin" />
                    ) : (
                      <Save className="w-3 h-3" />
                    )}
                    Apply Box Settings to {tilesPerBoxSizeFilter !== 'all' ? getProductsFilteredBySize(tilesPerBoxSizeFilter).length : selectedProducts.size} Products
                  </button>
                </div>
                )}

                {/* DESCRIPTION & SEO SECTION */}
                <div className="bg-indigo-50 border border-indigo-200 rounded-lg p-3 mt-3" id="editor-section-description">
                  <div className="flex items-center justify-between mb-3">
                    <h4 className="text-xs font-semibold text-indigo-800 flex items-center gap-1.5">
                      <FileText className="w-3.5 h-3.5" />
                      Description & SEO
                    </h4>
                  </div>
                  
                  {/* Current Status Summary - Shows what's already saved */}
                  {selectedProducts.size > 0 && (() => {
                    const selectedProductsList = products.filter(p => 
                      selectedProducts.has(getProductKey(p))
                    );
                    const withDesc = selectedProductsList.filter(p => p.description && p.description.trim()).length;
                    const withoutDesc = selectedProducts.size - withDesc;
                    
                    return withDesc > 0 ? (
                      <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 mb-3">
                        <p className="text-sm text-amber-800 font-medium flex items-center gap-2">
                          <AlertCircle className="w-4 h-4" />
                          {withDesc} of {selectedProducts.size} products already have descriptions
                        </p>
                        <p className="text-xs text-amber-600 mt-1 ml-6">
                          Choose <strong>"Only Fill Empty"</strong> to keep existing descriptions and only fill the {withoutDesc} empty ones.
                        </p>
                      </div>
                    ) : null;
                  })()}
                  
                  {/* Product Description Scope - Multi-select to target specific products */}
                  {selectedProducts.size > 1 && (() => {
                    const selectedSkusList = Array.from(selectedProducts);
                    const selectedProductsList = products.filter(p => selectedSkusList.includes(getProductKey(p)));
                    const scopeCount = descProductScope.size;
                    const isFiltered = scopeCount > 0 && scopeCount < selectedProductsList.length;
                    
                    return (
                      <div className={`border rounded-lg p-3 mb-3 ${isFiltered ? 'bg-teal-50 border-teal-300' : 'bg-white border-indigo-200'}`} data-testid="desc-product-scope">
                        <div className="flex items-center justify-between mb-2">
                          <h5 className={`text-xs font-semibold ${isFiltered ? 'text-teal-800' : 'text-indigo-800'}`}>
                            {isFiltered 
                              ? `Applying to ${scopeCount} of ${selectedProductsList.length} products` 
                              : `Apply to: All ${selectedProductsList.length} products`}
                          </h5>
                          <div className="flex gap-1">
                            <button
                              type="button"
                              onClick={() => {
                                const allKeys = new Set(selectedProductsList.map(p => getDescScopeKey(p)));
                                setDescProductScope(allKeys);
                              }}
                              className="text-[10px] px-1.5 py-0.5 rounded bg-gray-100 hover:bg-gray-200 text-gray-600"
                            >
                              Check All
                            </button>
                            <button
                              type="button"
                              onClick={() => {
                                setDescProductScope(new Set());
                                setBulkDescriptionSettings(prev => ({ ...prev, description_template: '' }));
                              }}
                              className="text-[10px] px-1.5 py-0.5 rounded bg-gray-100 hover:bg-gray-200 text-gray-600"
                            >
                              All Products
                            </button>
                          </div>
                        </div>
                        <div className="max-h-36 overflow-y-auto space-y-0.5 pr-1">
                          {selectedProductsList.map(p => {
                            const key = getDescScopeKey(p);
                            const isChecked = descProductScope.has(key);
                            const hasDesc = p.description && p.description.trim();
                            const name = p.product_name || p.name || p.sku;
                            const truncName = name.length > 40 ? name.substring(0, 40) + '...' : name;
                            return (
                              <div
                                key={key}
                                onClick={() => {
                                  setDescProductScope(prev => {
                                    const next = new Set(prev);
                                    if (prev.has(key)) {
                                      next.delete(key);
                                    } else {
                                      next.add(key);
                                    }
                                    // If exactly 1 product checked, load its current description
                                    if (next.size === 1) {
                                      const targetKey = Array.from(next)[0];
                                      const targetProduct = selectedProductsList.find(pr => getDescScopeKey(pr) === targetKey);
                                      if (targetProduct?.description) {
                                        setBulkDescriptionSettings(prev2 => ({ ...prev2, description_template: targetProduct.description }));
                                      }
                                    }
                                    return next;
                                  });
                                }}
                                className={`flex items-center gap-2 px-2 py-1.5 rounded cursor-pointer text-xs transition select-none ${
                                  isChecked 
                                    ? 'bg-teal-100 border border-teal-300' 
                                    : 'hover:bg-gray-50 border border-transparent'
                                }`}
                              >
                                <input
                                  type="checkbox"
                                  checked={isChecked}
                                  readOnly
                                  className="w-3.5 h-3.5 rounded border-gray-300 text-teal-600 focus:ring-teal-500 flex-shrink-0 pointer-events-none"
                                />
                                <span title={name} className={`flex-1 truncate ${isChecked ? 'text-teal-800 font-medium' : 'text-gray-700'}`}>
                                  {truncName}
                                </span>
                                <span title={p.sku} className="text-[10px] text-gray-400 flex-shrink-0">({p.sku})</span>
                                {hasDesc ? (
                                  <span className="text-[10px] bg-green-100 text-green-700 px-1 rounded flex-shrink-0">has desc</span>
                                ) : (
                                  <span className="text-[10px] bg-red-100 text-red-600 px-1 rounded flex-shrink-0">no desc</span>
                                )}
                              </div>
                            );
                          })}
                        </div>
                        {isFiltered && (
                          <p className="text-xs text-teal-700 mt-2 font-medium">
                            Description, SEO keywords, and hidden keywords will only apply to the {scopeCount} checked product{scopeCount !== 1 ? 's' : ''}.
                          </p>
                        )}
                      </div>
                    );
                  })()}
                  
                  {/* Placeholder Info */}
                  <div className="bg-white border border-indigo-100 rounded-lg p-2 mb-3">
                    <div className="flex items-center gap-2 mb-1">
                      <input
                        type="checkbox"
                        id="use-placeholders"
                        checked={bulkDescriptionSettings.use_placeholders}
                        onChange={(e) => setBulkDescriptionSettings(prev => ({ ...prev, use_placeholders: e.target.checked }))}
                        className="w-4 h-4 rounded border-gray-300 text-indigo-600 focus:ring-indigo-500"
                      />
                      <label htmlFor="use-placeholders" className="text-xs font-medium text-indigo-800">
                        Use Smart Placeholders (preserves each product's unique attributes)
                      </label>
                    </div>
                    {bulkDescriptionSettings.use_placeholders && (
                      <div className="text-xs text-indigo-600 flex flex-wrap gap-1.5 mt-2">
                        <span className="bg-indigo-100 px-1.5 py-0.5 rounded">{'{color}'}</span>
                        <span className="bg-indigo-100 px-1.5 py-0.5 rounded">{'{size}'}</span>
                        <span className="bg-indigo-100 px-1.5 py-0.5 rounded">{'{material}'}</span>
                        <span className="bg-indigo-100 px-1.5 py-0.5 rounded">{'{finish}'}</span>
                        <span className="bg-indigo-100 px-1.5 py-0.5 rounded" title="Uses Display Name (customer-facing)">{'{name}'}</span>
                        <span className="bg-indigo-100 px-1.5 py-0.5 rounded">{'{series}'}</span>
                      </div>
                    )}
                  </div>
                  
                  {/* WHICH GENERATOR SHOULD I USE?
                      Owner-requested signposting (3 Aug 2026). The bulk-edit
                      modal has 4 description generators (per-product template,
                      shorter/longer refinements, unified series, auto-regen),
                      each with a distinct purpose. This help block explains
                      when to reach for each — collapsible so it doesn't get
                      in the way once staff know the flow. */}
                  <details className="bg-slate-50 border border-slate-200 rounded-lg mb-3" data-testid="description-generator-help">
                    <summary className="cursor-pointer px-3 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-100 rounded-lg flex items-center gap-2">
                      <HelpCircle className="w-3.5 h-3.5 text-indigo-600" />
                      Which description generator should I use?
                    </summary>
                    <div className="px-3 pb-3 pt-1 space-y-2 text-xs text-slate-700">
                      <div className="flex gap-2 items-start">
                        <span className="inline-flex items-center justify-center bg-emerald-500 text-white w-5 h-5 rounded-full text-[10px] font-bold flex-shrink-0 mt-0.5">1</span>
                        <div>
                          <div className="font-bold text-emerald-900">Unified Series Description (green card below)</div>
                          <div className="text-slate-600">
                            One paragraph for a whole collection (e.g. &ldquo;Slate Rock&rdquo;) covering all colours &amp; sizes.
                            Writes to the <strong>collection page</strong> AND propagates to each product.
                            <span className="text-emerald-700 font-semibold"> Best for series/collection pages.</span>
                          </div>
                        </div>
                      </div>
                      <div className="flex gap-2 items-start">
                        <span className="inline-flex items-center justify-center bg-indigo-500 text-white w-5 h-5 rounded-full text-[10px] font-bold flex-shrink-0 mt-0.5">2</span>
                        <div>
                          <div className="font-bold text-indigo-900">Description Template (indigo card below)</div>
                          <div className="text-slate-600">
                            Per-product description using placeholders like <code className="bg-indigo-100 px-1 rounded">{`{color}`}</code> <code className="bg-indigo-100 px-1 rounded">{`{size}`}</code>.
                            Each product gets its own copy with its own values swapped in.
                            <span className="text-indigo-700 font-semibold"> Best for individual product tuning.</span>
                          </div>
                        </div>
                      </div>
                      <div className="flex gap-2 items-start">
                        <span className="inline-flex items-center justify-center bg-purple-500 text-white w-5 h-5 rounded-full text-[10px] font-bold flex-shrink-0 mt-0.5">3</span>
                        <div>
                          <div className="font-bold text-purple-900">Shorter / Longer / New Variation</div>
                          <div className="text-slate-600">
                            Refine whatever&apos;s already in the Description Template. Only visible once you&apos;ve generated something.
                          </div>
                        </div>
                      </div>
                      <div className="flex gap-2 items-start">
                        <span className="inline-flex items-center justify-center bg-slate-500 text-white w-5 h-5 rounded-full text-[10px] font-bold flex-shrink-0 mt-0.5">4</span>
                        <div>
                          <div className="font-bold text-slate-900">Manage Auto-Regeneration</div>
                          <div className="text-slate-600">
                            Background scheduler — keeps series descriptions fresh over time. Not something you run right now.
                          </div>
                        </div>
                      </div>
                      <div className="mt-2 pt-2 border-t border-slate-200 text-[11px] text-slate-500">
                        <strong className="text-slate-700">Rule of thumb</strong>: writing about a whole collection?
                        Use <span className="text-emerald-700 font-semibold">#1 Unified Series</span>. Fine-tuning individual products?
                        Use <span className="text-indigo-700 font-semibold">#2 Description Template</span>.
                      </div>
                    </div>
                  </details>

                  {/* UNIFIED SERIES DESCRIPTION GENERATOR - NEW */}
                  <div className="bg-gradient-to-r from-emerald-50 to-teal-50 border border-emerald-200 rounded-lg p-3 mb-3">
                    <div className="flex items-center justify-between mb-2">
                      <div className="flex items-center gap-2">
                        <div className="w-7 h-7 bg-emerald-500 rounded-lg flex items-center justify-center">
                          <Layers className="w-4 h-4 text-white" />
                        </div>
                        <div>
                          <h5 className="text-xs font-semibold text-emerald-800">Unified Series Description</h5>
                          <p className="text-[10px] text-emerald-600">Generate ONE description covering ALL variants (colors, sizes, finishes)</p>
                        </div>
                      </div>
                    </div>
                    
                    <div className="text-xs text-emerald-700 bg-emerald-100/50 rounded-lg p-2 mb-2">
                      <strong>Perfect for:</strong> Collection/series pages where you want one comprehensive description that mentions all available colors, sizes, and finishes in the range.
                    </div>
                    
                    {/* Quick Generate All Button */}
                    <button
                      type="button"
                      onClick={handleOpenBatchSeriesModal}
                      disabled={selectedProducts.size === 0}
                      className="w-full mb-2 bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-700 hover:to-teal-700 disabled:from-gray-300 disabled:to-gray-400 text-white px-3 py-2 rounded-lg text-xs font-semibold flex items-center justify-center gap-2 shadow-sm"
                      data-testid="quick-generate-all-btn"
                    >
                      <Zap className="w-4 h-4" />
                      Quick Generate All Series Descriptions
                      <span className="bg-white/20 px-1.5 py-0.5 rounded text-[10px]">
                        {selectedProducts.size} products
                      </span>
                    </button>
                    
                    <div className="text-[10px] text-emerald-600 text-center mb-2">
                      ↑ Auto-detects series & generates descriptions for all at once
                    </div>
                    
                    {/* Auto-Regeneration Settings Button */}
                    <button
                      type="button"
                      onClick={handleOpenAutoRegenModal}
                      className="w-full mb-2 bg-purple-50 hover:bg-purple-100 border border-purple-200 text-purple-700 px-2 py-1.5 rounded-lg text-xs flex items-center justify-center gap-2"
                      data-testid="auto-regen-settings-btn"
                    >
                      <Clock className="w-3.5 h-3.5" />
                      Manage Auto-Regeneration
                      {trackedSeries.length > 0 && (
                        <span className="bg-purple-200 px-1.5 py-0.5 rounded text-[10px]">
                          {trackedSeries.length} tracked
                        </span>
                      )}
                    </button>
                    
                    <div className="border-t border-emerald-200 pt-2 mt-1">
                      <p className="text-[10px] text-emerald-600 mb-1.5 font-medium">Or generate for current selection only:</p>
                      <div className="flex flex-wrap gap-1.5">
                      <button
                        type="button"
                        onClick={() => handleGenerateSeriesDescription('brief')}
                        disabled={generatingSeriesDescription || selectedProducts.size === 0}
                        className="flex-1 min-w-[80px] bg-white hover:bg-emerald-50 disabled:bg-gray-100 disabled:opacity-50 border border-emerald-300 text-emerald-700 px-2 py-1.5 rounded-lg text-xs flex items-center justify-center gap-1"
                        data-testid="series-desc-brief-btn"
                      >
                        <Sparkles className={`h-3 w-3 ${generatingSeriesDescription ? 'animate-pulse' : ''}`} />
                        Brief
                      </button>
                      <button
                        type="button"
                        onClick={() => handleGenerateSeriesDescription('standard')}
                        disabled={generatingSeriesDescription || selectedProducts.size === 0}
                        className="flex-1 min-w-[80px] bg-emerald-500 hover:bg-emerald-600 disabled:bg-gray-300 text-white px-2 py-1.5 rounded-lg text-xs font-medium flex items-center justify-center gap-1"
                        data-testid="series-desc-standard-btn"
                      >
                        <Sparkles className={`h-3 w-3 ${generatingSeriesDescription ? 'animate-pulse' : ''}`} />
                        Standard
                      </button>
                      <button
                        type="button"
                        onClick={() => handleGenerateSeriesDescription('detailed')}
                        disabled={generatingSeriesDescription || selectedProducts.size === 0}
                        className="flex-1 min-w-[80px] bg-white hover:bg-emerald-50 disabled:bg-gray-100 disabled:opacity-50 border border-emerald-300 text-emerald-700 px-2 py-1.5 rounded-lg text-xs flex items-center justify-center gap-1"
                        data-testid="series-desc-detailed-btn"
                      >
                        <Sparkles className={`h-3 w-3 ${generatingSeriesDescription ? 'animate-pulse' : ''}`} />
                        Detailed
                      </button>
                      </div>
                    </div>
                    
                    {generatingSeriesDescription && (
                      <div className="mt-2 flex items-center gap-2 text-emerald-700">
                        <div className="animate-spin h-4 w-4 border-2 border-emerald-500 border-t-transparent rounded-full"></div>
                        <span className="text-xs">Generating unified description for all {selectedProducts.size} products...</span>
                      </div>
                    )}
                    
                    {seriesDescriptionResult && (
                      <div className="mt-3 bg-white rounded-lg border border-emerald-200 p-3">
                        <div className="flex items-center justify-between mb-2">
                          <span className="text-xs font-semibold text-emerald-800">
                            "{seriesDescriptionResult.series_name}" Collection ({seriesDescriptionResult.product_count} products)
                          </span>
                          <button
                            type="button"
                            onClick={() => {
                              navigator.clipboard.writeText(seriesDescriptionResult.description);
                              toast.success('Description copied to clipboard!');
                            }}
                            className="text-xs text-emerald-600 hover:text-emerald-800 flex items-center gap-1"
                          >
                            <Copy className="w-3 h-3" />
                            Copy
                          </button>
                        </div>
                        
                        {/* Show aggregated data as badges */}
                        {seriesDescriptionResult.aggregated_data && (
                          <div className="flex flex-wrap gap-1 mb-2">
                            {seriesDescriptionResult.aggregated_data.colors?.length > 0 && (
                              <span className="text-[10px] bg-emerald-100 text-emerald-700 px-1.5 py-0.5 rounded">
                                {seriesDescriptionResult.aggregated_data.colors.length} Colors
                              </span>
                            )}
                            {seriesDescriptionResult.aggregated_data.sizes?.length > 0 && (
                              <span className="text-[10px] bg-teal-100 text-teal-700 px-1.5 py-0.5 rounded">
                                {seriesDescriptionResult.aggregated_data.sizes.length} Sizes
                              </span>
                            )}
                            {seriesDescriptionResult.aggregated_data.finishes?.length > 0 && (
                              <span className="text-[10px] bg-cyan-100 text-cyan-700 px-1.5 py-0.5 rounded">
                                {seriesDescriptionResult.aggregated_data.finishes.length} Finishes
                              </span>
                            )}
                            {seriesDescriptionResult.aggregated_data.materials?.length > 0 && (
                              <span className="text-[10px] bg-blue-100 text-blue-700 px-1.5 py-0.5 rounded">
                                {seriesDescriptionResult.aggregated_data.materials.join(', ')}
                              </span>
                            )}
                          </div>
                        )}
                        
                        <p className="text-xs text-gray-700 leading-relaxed whitespace-pre-wrap max-h-32 overflow-y-auto">
                          {seriesDescriptionResult.description}
                        </p>
                        
                        <div className="mt-2 pt-2 border-t border-emerald-100 flex items-center justify-between">
                          <span className="text-[10px] text-emerald-600">
                            Description loaded into editor above
                          </span>
                          <button
                            type="button"
                            onClick={() => setSeriesDescriptionResult(null)}
                            className="text-xs text-gray-500 hover:text-gray-700"
                          >
                            <X className="w-3 h-3" />
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                  
                  {/* Description Template — manual edit zone for the
                      collection description. AI generation lives in
                      the GREEN "Unified Series Description" card
                      above (single source of truth). The historical
                      purple "Brief/Standard/Long" buttons that lived
                      here called the per-product endpoint with the
                      first sample product's data — which produced the
                      "Pietra Ligure Avorio 120X120" bug (24 May 2026)
                      where the AI ignored the collection name and
                      used the raw supplier product name instead.
                      Removed to eliminate the confusing duplicate
                      generation entry-point. The Shorter/Longer/New
                      controls remain because they operate on the
                      already-generated text in the editor below. */}
                  <div className="mb-3">
                    <div className="flex items-center justify-between mb-1">
                      <label className="text-xs text-indigo-700 font-medium">
                        Description Template
                      </label>
                      <div className="flex items-center gap-1">
                        {/* Length Controls - Only show when description exists */}
                        {bulkDescriptionSettings.description_template && (
                          <>
                            <button
                              type="button"
                              onClick={() => handleBulkGenerateDescription('shorter')}
                              disabled={generatingDescription}
                              className="text-gray-600 hover:bg-gray-100 disabled:opacity-50 px-1.5 py-0.5 rounded text-xs flex items-center gap-0.5"
                              title="Make description shorter"
                              data-testid="bulk-make-shorter-btn"
                            >
                              <Minus className="h-3 w-3" />
                              Shorter
                            </button>
                            <button
                              type="button"
                              onClick={() => handleBulkGenerateDescription('longer')}
                              disabled={generatingDescription}
                              className="text-gray-600 hover:bg-gray-100 disabled:opacity-50 px-1.5 py-0.5 rounded text-xs flex items-center gap-0.5"
                              title="Make description longer"
                              data-testid="bulk-make-longer-btn"
                            >
                              <Plus className="h-3 w-3" />
                              Longer
                            </button>
                            <div className="w-px h-4 bg-gray-200" />
                            <button
                              type="button"
                              onClick={() => handleBulkGenerateDescription('regenerate')}
                              disabled={generatingDescription}
                              className="text-blue-600 hover:bg-blue-50 disabled:opacity-50 px-1.5 py-0.5 rounded text-xs flex items-center gap-0.5"
                              title="Generate a different variation"
                              data-testid="bulk-regenerate-btn"
                            >
                              <RefreshCw className={`h-3 w-3 ${generatingDescription ? 'animate-spin' : ''}`} />
                              New
                            </button>
                          </>
                        )}
                      </div>
                    </div>
                    
                    {/* Generating indicator */}
                    {generatingDescription && (
                      <div className="bg-purple-50 border border-purple-200 rounded-lg p-2 flex items-center gap-2 mb-2">
                        <div className="animate-spin h-3 w-3 border-2 border-purple-500 border-t-transparent rounded-full"></div>
                        <span className="text-xs text-purple-700">Generating AI description...</span>
                      </div>
                    )}
                    
                    <textarea
                      value={bulkDescriptionSettings.description_template}
                      onChange={(e) => setBulkDescriptionSettings(prev => ({ ...prev, description_template: e.target.value }))}
                      placeholder={bulkDescriptionSettings.use_placeholders 
                        ? "e.g., Beautiful {color} {material} tiles in {size}. Features a stunning {finish} finish perfect for any modern space."
                        : "Enter description to apply to all selected products..."
                      }
                      rows={3}
                      className="w-full px-3 py-2 border border-indigo-200 rounded-lg text-sm resize-none focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500"
                    />
                    {bulkDescriptionSettings.use_placeholders && (
                      <p className="text-xs text-indigo-500 mt-1">
                        Placeholders will be replaced with each product's actual values
                      </p>
                    )}
                  </div>
                  
                  {/* SEO Keywords */}
                  <div className="mb-3">
                    <label className="text-xs text-indigo-700 font-medium block mb-1">
                      SEO Keywords (comma-separated)
                    </label>
                    <input
                      type="text"
                      value={bulkDescriptionSettings.seo_keywords}
                      onChange={(e) => setBulkDescriptionSettings(prev => ({ ...prev, seo_keywords: e.target.value }))}
                      placeholder={bulkDescriptionSettings.use_placeholders
                        ? "e.g., {material} tiles, {color} flooring, {finish} tiles"
                        : "e.g., porcelain tiles, bathroom floor, kitchen wall"
                      }
                      className="w-full px-3 py-2 border border-indigo-200 rounded-lg text-sm focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500"
                    />
                  </div>
                  
                  {/* Hidden SEO Keywords */}
                  <div className="bg-purple-50 border border-purple-200 rounded-lg p-3 mb-3">
                    <div className="flex items-center justify-between mb-2">
                      <h5 className="text-xs font-medium text-purple-800 flex items-center gap-1.5">
                        <Search className="w-3.5 h-3.5" />
                        Hidden SEO Keywords
                        <span className="text-purple-500 font-normal">(invisible to customers, helps search ranking)</span>
                      </h5>
                    </div>
                    <textarea
                      value={bulkDescriptionSettings.hidden_seo_keywords}
                      onChange={(e) => setBulkDescriptionSettings(prev => ({ ...prev, hidden_seo_keywords: e.target.value }))}
                      placeholder="Enter keywords invisible to customers but indexed by search engines (e.g., supplier codes, alternate names, common misspellings)"
                      rows={2}
                      className="w-full px-3 py-2 border border-purple-200 rounded-lg text-sm focus:ring-2 focus:ring-purple-500 focus:border-purple-500 mb-2"
                    />
                    <div className="flex items-center gap-2 mb-2">
                      <button
                        type="button"
                        onClick={() => {
                          const newState = !bulkDescriptionSettings.generate_hidden_seo;
                          
                          // If enabling auto-generate, populate the field with a preview of what will be generated
                          if (newState) {
                            const selectedSkusList = Array.from(selectedProducts);
                            const selectedProductsList = products.filter(p => selectedSkusList.includes(getProductKey(p)));
                            
                            // Generate preview of hidden SEO keywords from supplier product names
                            const hiddenKeywords = selectedProductsList.slice(0, 5).map(p => {
                              const supplierName = p.supplier_product_name || p.name || '';
                              const sku = p.sku || '';
                              // Get words unique to supplier name that aren't in display name
                              const displayName = (p.product_name || '').toLowerCase();
                              const uniqueWords = supplierName.split(/\s+/)
                                .filter(word => word.length > 2 && !displayName.includes(word.toLowerCase()))
                                .slice(0, 3);
                              return [...uniqueWords, sku].filter(Boolean).join(', ');
                            }).filter(Boolean);
                            
                            const previewText = hiddenKeywords.join('; ');
                            const moreCount = selectedProductsList.length > 5 ? ` + ${selectedProductsList.length - 5} more products...` : '';
                            
                            setBulkDescriptionSettings(prev => ({ 
                              ...prev, 
                              generate_hidden_seo: true,
                              hidden_seo_keywords: `Auto-generated preview: ${previewText}${moreCount}\n\n(This will be replaced with actual keywords for each product on Apply)`
                            }));
                          } else {
                            setBulkDescriptionSettings(prev => ({ 
                              ...prev, 
                              generate_hidden_seo: false,
                              hidden_seo_keywords: ''
                            }));
                          }
                        }}
                        className={`text-xs px-2 py-1 rounded flex items-center gap-1 ${
                          bulkDescriptionSettings.generate_hidden_seo 
                            ? 'bg-purple-600 text-white' 
                            : 'bg-purple-100 text-purple-700 hover:bg-purple-200'
                        }`}
                      >
                        <RefreshCw className="w-3 h-3" />
                        {bulkDescriptionSettings.generate_hidden_seo ? 'Will Auto-Generate' : 'Auto-Generate from Supplier Names'}
                      </button>
                    </div>
                    
                    {/* Show what will be auto-generated */}
                    {bulkDescriptionSettings.generate_hidden_seo && (
                      <div className="bg-purple-50 border border-purple-200 rounded-lg p-2 mb-2">
                        <p className="text-xs text-purple-700 font-medium mb-1 flex items-center gap-1">
                          <Sparkles className="w-3 h-3" />
                          Auto-Generate Preview:
                        </p>
                        <div className="text-xs text-purple-600 space-y-1">
                          {(() => {
                            const selectedSkusList = Array.from(selectedProducts);
                            const selectedProductsList = products.filter(p => selectedSkusList.includes(getProductKey(p)));
                            
                            return selectedProductsList.slice(0, 3).map((p, idx) => {
                              const supplierName = p.supplier_product_name || p.name || '';
                              const displayName = p.product_name || '';
                              const sku = p.sku || '';
                              
                              return (
                                <div key={idx} className="bg-white rounded p-1.5 border border-purple-100">
                                  <span className="font-medium text-purple-800">{displayName || supplierName}:</span>
                                  <br />
                                  <span className="text-gray-600">→ {supplierName}, {sku}</span>
                                </div>
                              );
                            });
                          })()}
                          {selectedProducts.size > 3 && (
                            <p className="text-purple-500 italic">...and {selectedProducts.size - 3} more products</p>
                          )}
                        </div>
                      </div>
                    )}
                    
                    <div className="bg-white rounded p-2 text-xs text-gray-600">
                      <span className="font-medium text-gray-700">How it works:</span> Hidden keywords help your products rank for alternative search terms (like supplier codes "LP-3611") without cluttering the customer-facing content.
                    </div>
                  </div>
                  
                  {/* Variation Toggle */}
                  {bulkDescriptionSettings.description_template && (
                    <div className="flex items-center gap-3 mb-3">
                      <button
                        type="button"
                        onClick={() => setBulkDescriptionSettings(prev => ({ 
                          ...prev, 
                          add_variations: !prev.add_variations 
                        }))}
                        className={`text-xs px-2 py-1 rounded flex items-center gap-1 ${
                          bulkDescriptionSettings.add_variations 
                            ? 'bg-amber-500 text-white' 
                            : 'bg-amber-50 text-amber-700 hover:bg-amber-100 border border-amber-200'
                        }`}
                      >
                        <Sparkles className="w-3 h-3" />
                        {bulkDescriptionSettings.add_variations ? 'Variations Enabled' : 'Add Wording Variations'}
                      </button>
                      {bulkDescriptionSettings.add_variations && (
                        <span className="text-xs text-amber-600">
                          Each product will get slightly different wording (better for SEO)
                        </span>
                      )}
                    </div>
                  )}
                  
                  {/* Preview Section - All Products */}
                  {bulkDescriptionSettings.description_template && (
                    <div className="bg-gradient-to-r from-indigo-50 to-purple-50 border border-indigo-200 rounded-lg p-3 mb-3">
                      <div className="flex items-center justify-between mb-2">
                        <h5 className="text-xs font-bold text-indigo-700 flex items-center gap-1.5">
                          <Eye className="w-3.5 h-3.5" />
                          Description Preview
                        </h5>
                        <button
                          type="button"
                          onClick={() => setBulkDescriptionSettings(prev => ({ 
                            ...prev, 
                            showAllPreviews: !prev.showAllPreviews 
                          }))}
                          className="text-xs text-indigo-600 hover:text-indigo-800 flex items-center gap-1"
                        >
                          {bulkDescriptionSettings.showAllPreviews ? (
                            <>
                              <X className="w-3 h-3" />
                              Show Sample Only
                            </>
                          ) : (
                            <>
                              <Eye className="w-3 h-3" />
                              Show All {selectedProducts.size} Products
                            </>
                          )}
                        </button>
                      </div>
                      
                      {!bulkDescriptionSettings.showAllPreviews ? (
                        /* Single Sample Preview */
                        <div className="bg-white rounded-lg p-2 border border-indigo-100">
                          <div className="flex items-center gap-2 mb-1">
                            <span className="text-[10px] bg-indigo-100 text-indigo-700 px-1.5 py-0.5 rounded">Sample</span>
                            <span className="text-xs font-medium text-gray-700">
                              {(() => {
                                const pricing = getSelectedProductsPricing();
                                return pricing.firstProduct?.product_name || pricing.firstProduct?.name || 'Product';
                              })()}
                            </span>
                          </div>
                          <textarea
                            value={bulkDescriptionSettings.description_template}
                            onChange={(e) => setBulkDescriptionSettings(prev => ({
                              ...prev,
                              description_template: e.target.value
                            }))}
                            className="w-full text-xs text-gray-600 leading-relaxed border border-gray-200 rounded px-2 py-1.5 focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 resize-y min-h-[120px]"
                            rows={8}
                            data-testid="description-preview-textarea"
                          />
                        </div>
                      ) : (
                        /* All Products Preview */
                        <div className="max-h-64 overflow-y-auto space-y-2">
                          {(() => {
                            const selectedSkusList = Array.from(selectedProducts);
                            const selectedProductsList = products.filter(p => selectedSkusList.includes(getProductKey(p)));
                            
                            // Variation phrases to mix things up
                            const variationPhrases = {
                              openings: [
                                'Transform your living spaces with',
                                'Elevate your interiors with',
                                'Create stunning spaces with',
                                'Bring elegance to your home with',
                                'Discover the beauty of',
                                'Enhance your rooms with',
                                'Make a statement with',
                                'Upgrade your space with'
                              ],
                              qualities: [
                                'exceptional quality',
                                'premium craftsmanship',
                                'superior durability',
                                'outstanding elegance',
                                'timeless beauty',
                                'remarkable style'
                              ]
                            };
                            
                            return selectedProductsList.map((product, idx) => {
                              let desc = bulkDescriptionSettings.description_template
                                .replace(/{color}/g, product.color || product.attributes?.color || '[color]')
                                .replace(/{size}/g, product.size || product.attributes?.size || '[size]')
                                .replace(/{material}/g, product.material || product.attributes?.material || '[material]')
                                .replace(/{finish}/g, product.finish || product.attributes?.finish || '[finish]')
                                .replace(/{name}/g, product.product_name || product.display_name || product.name || '[name]')
                                .replace(/{series}/g, product.series || '[series]');
                              
                              // Apply variations if enabled
                              if (bulkDescriptionSettings.add_variations && idx > 0) {
                                // Simple variation: shuffle some phrases
                                const opening = variationPhrases.openings[idx % variationPhrases.openings.length];
                                const quality = variationPhrases.qualities[idx % variationPhrases.qualities.length];
                                
                                // Replace common opening phrases
                                desc = desc
                                  .replace(/^Transform your living spaces with/i, opening)
                                  .replace(/exceptional quality/gi, quality)
                                  .replace(/premium quality/gi, quality);
                              }
                              
                              return (
                                <div key={product.sku || idx} className="bg-white rounded-lg p-2 border border-indigo-100">
                                  <div className="flex items-center gap-2 mb-1">
                                    <span className="text-[10px] bg-gray-100 text-gray-600 px-1.5 py-0.5 rounded font-mono">#{idx + 1}</span>
                                    <span title={product.product_name || product.name} className="text-xs font-medium text-gray-700 truncate">
                                      {product.product_name || product.name}
                                    </span>
                                    {bulkDescriptionSettings.add_variations && idx > 0 && (
                                      <span className="text-[10px] bg-amber-100 text-amber-600 px-1.5 py-0.5 rounded">varied</span>
                                    )}
                                  </div>
                                  <p className="text-xs text-gray-600 leading-relaxed line-clamp-3">
                                    {desc}
                                  </p>
                                </div>
                              );
                            });
                          })()}
                        </div>
                      )}
                    </div>
                  )}
                  
                  {/* Apply Button */}
                  <button
                    type="button"
                    onClick={saveBulkDescriptionSettings}
                    disabled={bulkDescriptionSaving || selectedProducts.size === 0 || (!bulkDescriptionSettings.description_template && !bulkDescriptionSettings.seo_keywords && !bulkDescriptionSettings.hidden_seo_keywords && !bulkDescriptionSettings.generate_hidden_seo)}
                    className="w-full text-xs bg-indigo-600 hover:bg-indigo-700 disabled:bg-gray-300 text-white px-3 py-2 rounded flex items-center justify-center gap-1"
                  >
                    {bulkDescriptionSaving ? (
                      <RefreshCw className="w-3 h-3 animate-spin" />
                    ) : (
                      <Save className="w-3 h-3" />
                    )}
                    Apply Description to {descProductScope.size > 0 ? `${descProductScope.size} Product${descProductScope.size !== 1 ? 's' : ''}` : `${selectedProducts.size} Products`}
                  </button>
                </div>
              </>
            ) : (
              <div className="flex items-center justify-center py-8">
                <RefreshCw className="w-6 h-6 animate-spin text-gray-400" />
                <span className="ml-2 text-gray-500">Loading options...</span>
              </div>
            )}

            {/* Collection Page Description - for storefront collection page */}
            <div className="border-t border-gray-200 pt-4 mt-4" data-testid="collection-page-description-section">
              <h4 className="text-xs font-semibold text-gray-700 uppercase tracking-wider mb-2 flex items-center gap-1.5">
                <FileText className="w-3.5 h-3.5 text-purple-500" />
                Collection Page Description
              </h4>
              <p className="text-xs text-gray-500 mb-2">
                This description appears on the storefront collection page. It overrides the auto-generated description.
              </p>
              <textarea
                value={collectionDescription}
                onChange={(e) => setCollectionDescription(e.target.value)}
                placeholder="Write a custom description for this collection's storefront page..."
                rows={3}
                className="w-full text-xs border border-gray-200 rounded px-3 py-2 focus:ring-2 focus:ring-purple-500 focus:border-purple-500 resize-y"
                data-testid="collection-page-description-textarea"
              />
              {collectionDescriptionLoaded && collectionDescription && (
                <p className="text-[10px] text-green-600 mt-1">Currently saved on storefront</p>
              )}
              <div className="flex items-center gap-2 mt-2">
                <button
                  type="button"
                  onClick={saveCollectionPageDescription}
                  disabled={collectionDescriptionSaving || !collectionDescription.trim()}
                  className="text-xs bg-purple-600 hover:bg-purple-700 disabled:bg-gray-300 text-white px-3 py-2 rounded flex items-center gap-1"
                  data-testid="save-collection-description-btn"
                >
                  {collectionDescriptionSaving ? (
                    <RefreshCw className="w-3 h-3 animate-spin" />
                  ) : (
                    <Save className="w-3 h-3" />
                  )}
                  Save Collection Description
                </button>
                {collectionDescription && (
                  <button
                    type="button"
                    onClick={async () => {
                      setCollectionDescription('');
                      setCollectionDescriptionSaving(true);
                      const selectedSkusList = Array.from(selectedProducts);
                      const selectedProductsList = products.filter(p => selectedSkusList.includes(getProductKey(p)));
                      const collectionNames = new Set();
                      selectedProductsList.forEach(p => {
                        const name = p.our_product_name || p.display_name || p.product_name || p.name || '';
                        const series = getSeriesName(name);
                        if (series) collectionNames.add(series);
                      });
                      const token = localStorage.getItem('token');
                      for (const name of collectionNames) {
                        try {
                          await fetch(`${process.env.REACT_APP_BACKEND_URL}/api/website-admin/collections/${encodeURIComponent(name)}`, {
                            method: 'PUT',
                            headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
                            body: JSON.stringify({ custom_description: '' })
                          });
                        } catch { /* skip */ }
                      }
                      setCollectionDescriptionSaving(false);
                      setCollectionDescriptionLoaded(false);
                      toast.success('Collection description cleared');
                    }}
                    disabled={collectionDescriptionSaving}
                    className="text-xs text-red-600 hover:bg-red-50 border border-red-200 px-3 py-2 rounded flex items-center gap-1"
                    data-testid="clear-collection-description-btn"
                  >
                    <X className="w-3 h-3" />
                    Clear
                  </button>
                )}
              </div>
            </div>

            {/* Summary of selections - includes direct fields, filter_* and spec_* selections */}
            {(() => {
              // Collect all filter_* and spec_* selections
              const filterSelections = Object.entries(bulkCategorySelections)
                .filter(([k, v]) => k.startsWith('filter_') && Array.isArray(v) && v.length > 0)
                .map(([k, v]) => ({ key: k, slug: k.replace('filter_', ''), values: v }));
              const specSelections = Object.entries(bulkCategorySelections)
                .filter(([k, v]) => k.startsWith('spec_') && v && (Array.isArray(v) ? v.length > 0 : true))
                .map(([k, v]) => ({ key: k, slug: k.replace('spec_', ''), values: Array.isArray(v) ? v : [v] }));
              
              const hasDirectFields = bulkCategorySelections.material || bulkCategorySelections.finish || 
                bulkCategorySelections.type || bulkCategorySelections.edge ||
                bulkCategorySelections.slip_rating || bulkCategorySelections.suitability ||
                bulkCategorySelections.cost_price || bulkCategorySelections.list_price ||
                bulkCategorySelections.rooms?.length > 0 || 
                bulkCategorySelections.materials?.length > 0 ||
                bulkCategorySelections.styles?.length > 0 || 
                bulkCategorySelections.colors?.length > 0 || 
                bulkCategorySelections.features?.length > 0;
              
              const hasAnySelection = hasDirectFields || filterSelections.length > 0 || specSelections.length > 0;
              if (!hasAnySelection) return null;
              
              // Format slug to display name
              const formatSlug = (s) => s.replace(/[-_]/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
              
              return (
              <div className="p-4 bg-purple-50 rounded-lg border border-purple-200">
                <p className="text-xs font-semibold text-purple-700 mb-2">ATTRIBUTES TO BE APPLIED:</p>
                <div className="flex flex-wrap gap-1">
                  {bulkCategorySelections.material && (
                    <span className="px-2 py-0.5 bg-blue-100 text-blue-700 rounded text-xs">Material: {bulkCategorySelections.material}</span>
                  )}
                  {bulkCategorySelections.materials?.map(mat => (
                    <span key={`mat-${mat}`} className="px-2 py-0.5 bg-blue-100 text-blue-700 rounded text-xs">{mat}</span>
                  ))}
                  {bulkCategorySelections.finish && (
                    <span className="px-2 py-0.5 bg-blue-100 text-blue-700 rounded text-xs">Finish: {bulkCategorySelections.finish}</span>
                  )}
                  {bulkCategorySelections.type && (
                    <span className="px-2 py-0.5 bg-blue-100 text-blue-700 rounded text-xs">Type: {bulkCategorySelections.type}</span>
                  )}
                  {bulkCategorySelections.edge && (
                    <span className="px-2 py-0.5 bg-blue-100 text-blue-700 rounded text-xs">Edge: {bulkCategorySelections.edge}</span>
                  )}
                  {bulkCategorySelections.slip_rating && (
                    <span className="px-2 py-0.5 bg-blue-100 text-blue-700 rounded text-xs">Slip: {bulkCategorySelections.slip_rating}</span>
                  )}
                  {bulkCategorySelections.suitability && (
                    <span className="px-2 py-0.5 bg-blue-100 text-blue-700 rounded text-xs">Suitability: {bulkCategorySelections.suitability}</span>
                  )}
                  {bulkCategorySelections.made_in && (
                    <span className={`px-2 py-0.5 rounded text-xs ${bulkCategorySelections.made_in === '__CLEAR__' ? 'bg-red-100 text-red-700' : 'bg-green-100 text-green-700'}`}>
                      Origin: {bulkCategorySelections.made_in === '__CLEAR__' ? 'CLEAR' : bulkCategorySelections.made_in}
                    </span>
                  )}
                  {bulkCategorySelections.rooms?.map(id => {
                    const opt = productOptions?.rooms?.find(o => o.id === id);
                    return opt ? <span key={id} className="px-2 py-0.5 bg-purple-100 text-purple-700 rounded text-xs">{opt.label}</span> : null;
                  })}
                  {bulkCategorySelections.styles?.map(id => {
                    const opt = productOptions?.styles?.find(o => o.id === id);
                    return opt ? <span key={id} className="px-2 py-0.5 bg-teal-100 text-teal-700 rounded text-xs">{opt.label}</span> : null;
                  })}
                  {bulkCategorySelections.colors?.map(id => {
                    const opt = productOptions?.colors?.find(o => o.id === id);
                    return opt ? <span key={id} className="px-2 py-0.5 bg-gray-200 text-gray-700 rounded text-xs">{opt.label}</span> : null;
                  })}
                  {bulkCategorySelections.features?.map(id => {
                    const opt = productOptions?.features?.find(o => o.id === id);
                    return opt ? <span key={id} className="px-2 py-0.5 bg-green-100 text-green-700 rounded text-xs">{opt.label}</span> : null;
                  })}
                  {bulkCategorySelections.cost_price && (
                    <span className="px-2 py-0.5 bg-yellow-100 text-yellow-700 rounded text-xs">Cost: £{bulkCategorySelections.cost_price}</span>
                  )}
                  {bulkCategorySelections.list_price && (
                    <span className="px-2 py-0.5 bg-yellow-100 text-yellow-700 rounded text-xs">List: £{bulkCategorySelections.list_price}</span>
                  )}
                  {/* Filter selections (filter_suitability, filter_slip-rating, etc.) */}
                  {filterSelections.map(({ slug, values }) => (
                    <span key={`filter-${slug}`} className="px-2 py-0.5 bg-amber-100 text-amber-700 rounded text-xs">
                      {formatSlug(slug)}: {values.join(', ')}
                    </span>
                  ))}
                  {/* Spec selections (spec_material, spec_finish, etc.) */}
                  {specSelections.map(({ slug, values }) => (
                    <span key={`spec-${slug}`} className="px-2 py-0.5 bg-indigo-100 text-indigo-700 rounded text-xs">
                      {formatSlug(slug)}: {values.join(', ')}
                    </span>
                  ))}
                </div>
              </div>
              );
            })()}
          </div>

          {/* Save Status Banner */}
          {lastSaveResult && (
            <div className={`mx-0 p-3 rounded-lg border flex items-center gap-3 ${
              lastSaveResult.failed === 0
                ? 'bg-green-50 border-green-300'
                : lastSaveResult.success > 0
                ? 'bg-amber-50 border-amber-300'
                : 'bg-red-50 border-red-300'
            }`} data-testid="save-status-banner">
              {lastSaveResult.failed === 0 ? (
                <CheckCircle className="w-5 h-5 text-green-600 shrink-0" />
              ) : (
                <AlertCircle className="w-5 h-5 text-amber-600 shrink-0" />
              )}
              <div className="flex-1">
                <p className={`text-sm font-medium ${
                  lastSaveResult.failed === 0 ? 'text-green-800' : 'text-amber-800'
                }`}>
                  {lastSaveResult.failed === 0
                    ? `All ${lastSaveResult.success} products saved successfully`
                    : `${lastSaveResult.success} saved, ${lastSaveResult.failed} failed`
                  }
                </p>
                <p className="text-xs text-gray-500 mt-0.5">
                  "Currently Saved" tags updated below
                  {lastSaveResult.timestamp && ` — ${new Date(lastSaveResult.timestamp).toLocaleTimeString()}`}
                </p>
              </div>
              {lastSaveResult.failed > 0 && lastSaveResult.failed_items?.length > 0 && (
                <button
                  type="button"
                  onClick={() => setShowSaveResults(true)}
                  className="text-sm font-semibold text-amber-700 underline hover:text-amber-900"
                  data-testid="view-save-details-btn"
                >
                  View {lastSaveResult.failed_items.length} failed
                </button>
              )}
              <button
                type="button"
                onClick={() => setLastSaveResult(null)}
                className="text-gray-400 hover:text-gray-600"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
          )}

          {/* Save & Verify Banner */}
          {verifyingAfterSave && (
            <div className="mx-0 p-3 bg-blue-50 border border-blue-300 rounded-lg flex items-center gap-3" data-testid="verifying-banner">
              <Loader2 className="w-5 h-5 text-blue-600 animate-spin shrink-0" />
              <p className="text-sm font-medium text-blue-800">Verifying data persisted in database...</p>
            </div>
          )}
          {verificationResult && !verifyingAfterSave && (
            <div className={`mx-0 p-3 rounded-lg border flex items-center gap-3 ${
              verificationResult.mismatches === 0
                ? 'bg-emerald-50 border-emerald-300'
                : 'bg-amber-50 border-amber-300'
            }`} data-testid="verification-banner">
              {verificationResult.mismatches === 0 ? (
                <CheckCircle className="w-5 h-5 text-emerald-600 shrink-0" />
              ) : (
                <AlertTriangle className="w-5 h-5 text-amber-600 shrink-0" />
              )}
              <div className="flex-1">
                <p className={`text-sm font-medium ${
                  verificationResult.mismatches === 0 ? 'text-emerald-800' : 'text-amber-800'
                }`}>
                  {verificationResult.mismatches === 0
                    ? `Verified: All ${verificationResult.verified} products confirmed saved in database`
                    : `${verificationResult.verified} verified, ${verificationResult.mismatches} mismatches`
                  }
                  {verificationResult.mismatchFields?.length > 0 && ` (${verificationResult.mismatchFields.join(', ')})`}
                </p>
              </div>
              <button type="button" onClick={() => setVerificationResult(null)} className="text-gray-400 hover:text-gray-600">
                <X className="w-4 h-4" />
              </button>
            </div>
          )}

          {/* Save progress — shown when the unified Save is retrying failed
              products individually. Was previously a separate "Force Save
              progress" indicator; unified 3 Aug 2026. */}
          {saveProgress && (
            <div className="mx-0 p-3 bg-blue-50 border border-blue-300 rounded-lg" data-testid="save-progress">
              <div className="flex items-center gap-3">
                {saveProgress.status === 'saving' ? (
                  <Loader2 className="w-5 h-5 text-blue-600 animate-spin shrink-0" />
                ) : (
                  <CheckCircle className="w-5 h-5 text-green-600 shrink-0" />
                )}
                <div className="flex-1">
                  <p className="text-sm font-medium text-blue-800">
                    {saveProgress.status === 'saving'
                      ? `Retrying failed products... ${saveProgress.current}/${saveProgress.total}`
                      : 'Save complete'}
                  </p>
                  <div className="w-full bg-blue-200 rounded-full h-1.5 mt-1.5">
                    <div
                      className="bg-blue-600 h-1.5 rounded-full transition-all duration-300"
                      style={{ width: `${(saveProgress.current / saveProgress.total) * 100}%` }}
                    />
                  </div>
                </div>
              </div>
            </div>
          )}

          <DialogFooter className="flex-shrink-0 border-t pt-4">
            <Button 
              variant="outline" 
              onClick={() => {
                setShowBulkCategoryModal(false);
                setBulkThicknessFilter('all');
                setPerProductAssignments({});
                setBulkCategorySelections({
                  material: '', finish: '', type: '', edge: '', slip_rating: '', suitability: '',
                  cost_price: '', list_price: '',
                  rooms: [], materials: [], styles: [], colors: [], features: []
                });
                setBulkShowOnWebsite(false);
                clearPersistedState();
                clearServerDraft();
                setLastSaveResult(null);
                setSaveProgress(null);
                setVerificationResult(null);
                setShowDraftRecovery(false);
                setRecoveredDraft(null);
              }}
            >
              Cancel
            </Button>
            <Button 
              onClick={() => setShowDryRun(true)}
              disabled={bulkCategoryLoading}
              className="bg-green-600 hover:bg-green-700"
              data-testid="apply-btn"
            >
              {bulkCategoryLoading && !saveProgress ? (
                <>
                  <RefreshCw className="w-4 h-4 mr-2 animate-spin" />
                  Updating...
                </>
              ) : (
                <>
                  <Save className="w-4 h-4 mr-2" />
                  Save Now to {bulkThicknessFilter !== 'all' ? getProductsFilteredByThickness(bulkThicknessFilter).length : (pricingSizeFilter !== 'all' && (bulkCategorySelections.cost_price || bulkCategorySelections.list_price)) ? getProductsFilteredBySize(pricingSizeFilter).length : selectedProducts.size} Products
                </>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>



      {/* Dry Run Preview Dialog */}
      <DryRunPreview
        open={showDryRun}
        onClose={() => setShowDryRun(false)}
        onConfirm={() => {
          setShowDryRun(false);
          setShowApplyConfirmation(true);
        }}
        onEditField={(sectionId, fieldKey) => {
          setShowDryRun(false);
          // Scroll to the section after a brief delay for the dialog to close
          setTimeout(() => {
            const el = document.getElementById(sectionId);
            if (el) {
              el.scrollIntoView({ behavior: 'smooth', block: 'center' });
              // Flash highlight
              el.classList.add('ring-2', 'ring-blue-400', 'ring-offset-2', 'rounded-lg');
              setTimeout(() => el.classList.remove('ring-2', 'ring-blue-400', 'ring-offset-2', 'rounded-lg'), 2000);
            }
          }, 300);
        }}
        bulkCategorySelections={bulkCategorySelections}
        products={products}
        selectedProducts={selectedProducts}
        bulkFieldBreakdowns={bulkFieldBreakdowns}
        bulkCategoryMode={bulkCategoryMode}
        loading={bulkCategoryLoading}
      />

      {/* Edit History Dialog */}
      <BulkEditHistory
        open={showEditHistory}
        onClose={() => setShowEditHistory(false)}
        onUndoComplete={async () => {
          const freshProducts = await fetchProducts();
          if (freshProducts) {
            refreshBreakdownsAfterSave(freshProducts);
          }
          toast.success('Products restored — refresh completed');
        }}
        supplier={selectedSupplier}
      />

      {/* Apply Confirmation Popup */}
      <Dialog open={showApplyConfirmation} onOpenChange={setShowApplyConfirmation}>
        <DialogContent className="max-w-md max-h-[90vh] flex flex-col">
          <DialogHeader className="flex-shrink-0">
            <DialogTitle className="flex items-center gap-2">
              <AlertCircle className="w-5 h-5 text-purple-600" />
              Apply Changes
            </DialogTitle>
            <DialogDescription>
              How should these changes apply to your {bulkThicknessFilter !== 'all' ? getProductsFilteredByThickness(bulkThicknessFilter).length : (pricingSizeFilter !== 'all' && (bulkCategorySelections.cost_price || bulkCategorySelections.list_price)) ? getProductsFilteredBySize(pricingSizeFilter).length : selectedProducts.size} products?
            </DialogDescription>
          </DialogHeader>
          
          <div className="flex-1 overflow-y-auto py-4 space-y-3">
            {/* Replace All Option */}
            <button
              onClick={() => setApplyUpdateMode('replace')}
              className={`w-full p-4 rounded-lg border-2 text-left transition-all ${
                applyUpdateMode === 'replace' 
                  ? 'border-purple-500 bg-purple-50' 
                  : 'border-gray-200 hover:border-gray-300 hover:bg-gray-50'
              }`}
            >
              <div className="flex items-center gap-3">
                <div className={`w-5 h-5 rounded-full border-2 flex items-center justify-center ${
                  applyUpdateMode === 'replace' ? 'border-purple-500 bg-purple-500' : 'border-gray-300'
                }`}>
                  {applyUpdateMode === 'replace' && <Check className="w-3 h-3 text-white" />}
                </div>
                <div className="flex-1">
                  <p className="font-semibold text-gray-900">Save Everything</p>
                  <p className="text-sm text-gray-500 mb-2">Saves exactly what's in the editor now — changed or not</p>
                  <div className="bg-gray-50 rounded-md p-2.5 text-xs space-y-1 border border-gray-200">
                    <p className="text-gray-400 font-medium mb-1">Example:</p>
                    <div className="flex items-center gap-2">
                      <span className="text-orange-600 font-medium">Material: Porcelain</span>
                      <span className="text-orange-500 font-medium bg-orange-50 px-1.5 py-0.5 rounded">changed</span>
                      <span className="text-green-600 ml-auto">saved</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="text-gray-600">Finish: Matt</span>
                      <span className="text-gray-400 bg-gray-100 px-1.5 py-0.5 rounded">not changed</span>
                      <span className="text-green-600 ml-auto">saved</span>
                    </div>
                  </div>
                </div>
              </div>
            </button>
            
            {/* Only Empty Option */}
            <button
              onClick={() => setApplyUpdateMode('append')}
              className={`w-full p-4 rounded-lg border-2 text-left transition-all ${
                applyUpdateMode === 'append' 
                  ? 'border-purple-500 bg-purple-50' 
                  : 'border-gray-200 hover:border-gray-300 hover:bg-gray-50'
              }`}
            >
              <div className="flex items-center gap-3">
                <div className={`w-5 h-5 rounded-full border-2 flex items-center justify-center ${
                  applyUpdateMode === 'append' ? 'border-purple-500 bg-purple-500' : 'border-gray-300'
                }`}>
                  {applyUpdateMode === 'append' && <Check className="w-3 h-3 text-white" />}
                </div>
                <div className="flex-1">
                  <p className="font-semibold text-gray-900">Only Fill Blanks</p>
                  <p className="text-sm text-gray-500 mb-2">Only adds values where a product has nothing set — skips products that already have values</p>
                  <div className="bg-gray-50 rounded-md p-2.5 text-xs space-y-1 border border-gray-200">
                    <p className="text-gray-400 font-medium mb-1">Example:</p>
                    <div className="flex items-center gap-2">
                      <span className="text-gray-600">Product A — already has Finish: Matt</span>
                      <span className="text-gray-400 ml-auto">skipped</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="text-gray-600">Product B — Finish is empty</span>
                      <span className="text-green-600 ml-auto font-medium">filled in</span>
                    </div>
                  </div>
                </div>
              </div>
            </button>
            
            {/* Save as Template Option */}
            <div className="pt-2 border-t border-gray-200">
              <label className="flex items-center gap-3 p-3 rounded-lg bg-amber-50 border border-amber-200 cursor-pointer hover:bg-amber-100 transition-colors">
                <input
                  type="checkbox"
                  checked={saveAsTemplateOnApply}
                  onChange={(e) => setSaveAsTemplateOnApply(e.target.checked)}
                  className="w-4 h-4 rounded border-amber-400 text-amber-600 focus:ring-amber-500"
                />
                <div className="flex items-center gap-2">
                  <Sparkles className="w-4 h-4 text-amber-600" />
                  <div>
                    <p className="font-medium text-amber-800 text-sm">Save as Template</p>
                    <p className="text-xs text-amber-600">Save these settings to reuse on other products</p>
                  </div>
                </div>
              </label>
              
              {saveAsTemplateOnApply && (
                <div className="mt-2 ml-7">
                  <Input
                    value={quickTemplateName}
                    onChange={(e) => setQuickTemplateName(e.target.value)}
                    placeholder="Template name (e.g., Porcelain Matt)"
                    className="text-sm border-amber-300 focus:ring-amber-500"
                  />
                </div>
              )}
            </div>

          {/* Scope Summary */}
          <ScopeSummaryPanel
            perAttributeScopes={perAttributeScopes}
            bulkCategorySelections={bulkCategorySelections}
            selectedProducts={selectedProducts}
            products={products}
            compact={true}
          />
          </div>
          
          <DialogFooter className="flex-shrink-0 gap-2">
            <Button variant="outline" onClick={() => setShowApplyConfirmation(false)}>
              Cancel
            </Button>
            <Button 
              onClick={async () => {
                // Save template if checkbox is checked
                if (saveAsTemplateOnApply && quickTemplateName.trim()) {
                  const templateData = {
                    name: quickTemplateName.trim(),
                    selections: bulkCategorySelections,
                    show_on_website: bulkShowOnWebsite
                  };
                  try {
                    const response = await fetch(`${API_URL}/api/supplier-sync/bulk-edit-templates`, {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify(templateData)
                    });
                    if (response.ok) {
                      toast.success(`Template "${quickTemplateName}" saved!`);
                      fetchBulkEditTemplates();
                    } else {
                      toast.error('Failed to save template');
                    }
                  } catch (err) {
                    toast.error('Failed to save template');
                  }
                }
                setShowApplyConfirmation(false);
                setSaveAsTemplateOnApply(false);
                setQuickTemplateName('');
                handleBulkCategoryUpdate(applyUpdateMode);
              }}
              disabled={saveAsTemplateOnApply && !quickTemplateName.trim()}
              className="bg-purple-600 hover:bg-purple-700"
            >
              <Check className="w-4 h-4 mr-2" />
              {saveAsTemplateOnApply ? 'Save Template & Apply' : 'Confirm & Apply'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Save Template Modal */}
      <Dialog open={showSaveTemplateModal} onOpenChange={setShowSaveTemplateModal}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Sparkles className="w-5 h-5 text-amber-600" />
              Save as Template
            </DialogTitle>
          </DialogHeader>
          <div className="py-4 space-y-4">
            <p className="text-sm text-gray-600">
              Save your current selections as a reusable template for quick bulk editing.
            </p>
            <div>
              <label className="text-sm font-medium text-gray-700 mb-1.5 block">Template Name</label>
              <Input
                value={newTemplateName}
                onChange={(e) => setNewTemplateName(e.target.value)}
                placeholder="e.g., Porcelain Matt Floor Tile"
                className="w-full"
              />
            </div>
            <div className="p-3 bg-gray-50 rounded-lg">
              <p className="text-xs font-semibold text-gray-500 mb-2">WILL SAVE THESE ATTRIBUTES:</p>
              <div className="flex flex-wrap gap-1 text-xs">
                {bulkCategorySelections.material && <span className="px-2 py-0.5 bg-blue-100 text-blue-700 rounded">{bulkCategorySelections.material}</span>}
                {bulkCategorySelections.materials?.length > 0 && <span className="px-2 py-0.5 bg-blue-100 text-blue-700 rounded">{bulkCategorySelections.materials.length} Materials</span>}
                {bulkCategorySelections.finish && <span className="px-2 py-0.5 bg-blue-100 text-blue-700 rounded">{bulkCategorySelections.finish}</span>}
                {bulkCategorySelections.type && <span className="px-2 py-0.5 bg-blue-100 text-blue-700 rounded">{bulkCategorySelections.type}</span>}
                {bulkCategorySelections.edge && <span className="px-2 py-0.5 bg-blue-100 text-blue-700 rounded">{bulkCategorySelections.edge}</span>}
                {bulkCategorySelections.slip_rating && <span className="px-2 py-0.5 bg-blue-100 text-blue-700 rounded">{bulkCategorySelections.slip_rating}</span>}
                {bulkCategorySelections.suitability && <span className="px-2 py-0.5 bg-blue-100 text-blue-700 rounded">{bulkCategorySelections.suitability}</span>}
                {bulkCategorySelections.cost_price && <span className="px-2 py-0.5 bg-yellow-100 text-yellow-700 rounded">£{bulkCategorySelections.cost_price} (Cost)</span>}
                {bulkCategorySelections.list_price && <span className="px-2 py-0.5 bg-yellow-100 text-yellow-700 rounded">£{bulkCategorySelections.list_price} (List)</span>}
                {bulkCategorySelections.rooms?.length > 0 && <span className="px-2 py-0.5 bg-purple-100 text-purple-700 rounded">{bulkCategorySelections.rooms.length} Rooms</span>}
                {bulkCategorySelections.styles?.length > 0 && <span className="px-2 py-0.5 bg-teal-100 text-teal-700 rounded">{bulkCategorySelections.styles.length} Styles</span>}
                {bulkCategorySelections.colors?.length > 0 && <span className="px-2 py-0.5 bg-gray-200 text-gray-700 rounded">{bulkCategorySelections.colors.length} Colors</span>}
                {bulkCategorySelections.features?.length > 0 && <span className="px-2 py-0.5 bg-green-100 text-green-700 rounded">{bulkCategorySelections.features.length} Features</span>}
                {bulkShowOnWebsite && <span className="px-2 py-0.5 bg-emerald-100 text-emerald-700 rounded">Show on Website</span>}
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowSaveTemplateModal(false)}>
              Cancel
            </Button>
            <Button 
              onClick={handleSaveTemplate}
              disabled={savingTemplate || !newTemplateName.trim()}
              className="bg-amber-600 hover:bg-amber-700"
            >
              {savingTemplate ? (
                <>
                  <RefreshCw className="w-4 h-4 mr-2 animate-spin" />
                  Saving...
                </>
              ) : (
                <>
                  <Save className="w-4 h-4 mr-2" />
                  Save Template
                </>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Image Preview Modal */}
      {previewImage && (
        <div 
          className="fixed inset-0 bg-black/80 z-50 flex items-center justify-center p-4 cursor-pointer"
          onClick={() => setPreviewImage(null)}
        >
          <div className="relative max-w-4xl max-h-[90vh]">
            <button
              onClick={() => setPreviewImage(null)}
              className="absolute -top-10 right-0 text-white hover:text-gray-300 transition-colors"
            >
              <X className="w-8 h-8" />
            </button>
            <img
              src={previewImage.url}
              alt={previewImage.name}
              className="max-w-full max-h-[85vh] object-contain shadow-2xl"
              onClick={(e) => e.stopPropagation()}
            />
            <p className="text-white text-center mt-3 text-sm">{previewImage.name}</p>
          </div>
        </div>
      )}

      {/* Multi-Image Gallery Modal */}
      {previewImages && (
        <div 
          className="fixed inset-0 bg-black/90 z-50 flex flex-col items-center justify-center p-4"
          onClick={() => setPreviewImages(null)}
        >
          <div className="relative w-full max-w-5xl" onClick={(e) => e.stopPropagation()}>
            {/* Close button */}
            <button
              onClick={() => setPreviewImages(null)}
              className="absolute -top-12 right-0 text-white hover:text-gray-300 transition-colors z-10"
            >
              <X className="w-8 h-8" />
            </button>
            
            {/* Product info */}
            <div className="text-white text-center mb-4">
              <p className="font-medium text-lg">{previewImages.name}</p>
              <p className="text-sm text-gray-400">SKU: {previewImages.sku} | {previewImages.supplier}</p>
              <p className="text-xs text-gray-500 mt-1">
                Image {previewImages.currentIndex + 1} of {previewImages.images.length}
              </p>
            </div>

            {/* Main image */}
            <div className="relative flex items-center justify-center">
              {/* Previous button */}
              {previewImages.images.length > 1 && (
                <button
                  onClick={() => setPreviewImages(prev => ({
                    ...prev,
                    currentIndex: prev.currentIndex === 0 ? prev.images.length - 1 : prev.currentIndex - 1
                  }))}
                  className="absolute left-0 z-10 bg-black/50 hover:bg-black/70 text-white p-3 transition-colors"
                >
                  <ChevronDown className="w-8 h-8 rotate-90" />
                </button>
              )}
              
              <img
                src={previewImages.images[previewImages.currentIndex]}
                alt={`${previewImages.name} - Image ${previewImages.currentIndex + 1}`}
                className="max-w-full max-h-[70vh] object-contain shadow-2xl"
              />
              
              {/* Next button */}
              {previewImages.images.length > 1 && (
                <button
                  onClick={() => setPreviewImages(prev => ({
                    ...prev,
                    currentIndex: prev.currentIndex === prev.images.length - 1 ? 0 : prev.currentIndex + 1
                  }))}
                  className="absolute right-0 z-10 bg-black/50 hover:bg-black/70 text-white p-3 transition-colors"
                >
                  <ChevronDown className="w-8 h-8 -rotate-90" />
                </button>
              )}
            </div>
            
            {/* Thumbnail strip */}
            {previewImages.images.length > 1 && (
              <div className="flex justify-center gap-2 mt-4 overflow-x-auto py-2">
                {previewImages.images.map((img, idx) => (
                  <img
                    key={idx}
                    src={img}
                    alt={`Thumbnail ${idx + 1}`}
                    onClick={() => setPreviewImages(prev => ({ ...prev, currentIndex: idx }))}
                    className={`w-16 h-16 object-cover cursor-pointer transition-all ${
                      idx === previewImages.currentIndex 
                        ? 'ring-2 ring-white scale-110' 
                        : 'opacity-60 hover:opacity-100'
                    }`}
                  />
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Bulk Rename Series Modal */}
      {showBulkRenameModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-background rounded-xl w-full max-w-2xl max-h-[90vh] flex flex-col">
            <div className="p-4 border-b flex items-center justify-between flex-shrink-0">
              <div>
                <h3 className="font-semibold text-lg">Edit Series Names</h3>
                <p className="text-sm text-muted-foreground">{selectedProducts.size} products selected</p>
              </div>
              <button onClick={() => setShowBulkRenameModal(false)} className="text-muted-foreground hover:text-foreground">
                <X className="h-5 w-5" />
              </button>
            </div>
            
            {/* Mode Toggle */}
            <div className="px-4 pt-3 flex gap-2 border-b pb-3">
              <button
                onClick={() => setRenameMode('template')}
                className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
                  renameMode === 'template' 
                    ? 'bg-blue-600 text-white' 
                    : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
                }`}
              >
                📋 Template Mode
              </button>
              <button
                onClick={() => setRenameMode('advanced')}
                className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
                  renameMode === 'advanced' 
                    ? 'bg-blue-600 text-white' 
                    : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
                }`}
              >
                ⚙️ Advanced Mode
              </button>
            </div>
            
            <div className="p-4 space-y-4 max-h-[70vh] overflow-y-auto">
              {/* TEMPLATE MODE */}
              {renameMode === 'template' && (
                <>
                  {/* Template Configuration */}
                  <div className="border rounded-lg p-4 bg-gradient-to-r from-blue-50 to-indigo-50 space-y-4">
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">
                        New Series Name
                      </label>
                      <input
                        type="text"
                        value={templateForm.seriesName}
                        onChange={(e) => setTemplateForm({...templateForm, seriesName: e.target.value})}
                        placeholder="Auto-detected from products"
                        data-testid="template-series-name"
                        className="w-full px-3 py-2 border rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                      />
                    </div>
                    
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">
                        Name Template
                      </label>
                      <select
                        value={templateForm.template}
                        onChange={(e) => setTemplateForm({...templateForm, template: e.target.value})}
                        className="w-full px-3 py-2 border rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 bg-white"
                      >
                        <option value="{Series} {Color} {Size} {Finish}">{'{Series} {Color} {Size} {Finish}'} - Standard</option>
                        <option value="{Series} {Color} {Size}cm {Finish}">{'{Series} {Color} {Size}cm {Finish}'} - With cm</option>
                        <option value="{Series} {Size} {Color} {Finish}">{'{Series} {Size} {Color} {Finish}'} - Size before Color</option>
                        <option value="{Series} {Color} {Size}">{'{Series} {Color} {Size}'} - No Finish</option>
                        <option value="{Series} {Size} {Finish}">{'{Series} {Size} {Finish}'} - No Color</option>
                      </select>
                      <p className="text-xs text-gray-500 mt-1">
                        Placeholders: {'{Series}'}, {'{Color}'}, {'{Size}'}, {'{Finish}'}
                      </p>
                    </div>
                    
                    <div className="grid grid-cols-2 gap-4">
                      <div>
                        <label className="block text-sm font-medium text-gray-700 mb-1 flex items-center justify-between">
                          <span>Default Finish (if not detected)</span>
                          <button
                            type="button"
                            onClick={() => {
                              setOptionsManagerTab('finishes');
                              setShowOptionsManager(true);
                            }}
                            className="text-xs text-blue-600 hover:text-blue-800 hover:underline"
                          >
                            + Add More
                          </button>
                        </label>
                        <select
                          value={templateForm.defaultFinish}
                          onChange={(e) => setTemplateForm({...templateForm, defaultFinish: e.target.value})}
                          className="w-full px-3 py-2 border rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 bg-white"
                        >
                          <option value="">None</option>
                          {(productOptions?.finishes || []).map(opt => {
                            const val = typeof opt === 'string' ? opt : opt.id;
                            const label = typeof opt === 'string' ? opt : opt.label;
                            return <option key={val} value={val}>{label}</option>;
                          })}
                        </select>
                      </div>
                      
                      <div>
                        <label className="block text-sm font-medium text-gray-700 mb-1 flex items-center justify-between">
                          <span>Default Color (if not detected)</span>
                          <button
                            type="button"
                            onClick={() => {
                              setOptionsManagerTab('colors');
                              setShowOptionsManager(true);
                            }}
                            className="text-xs text-blue-600 hover:text-blue-800 hover:underline"
                          >
                            + Add More
                          </button>
                        </label>
                        <select
                          value={templateForm.defaultColor}
                          onChange={(e) => setTemplateForm({...templateForm, defaultColor: e.target.value})}
                          className="w-full px-3 py-2 border rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 bg-white"
                        >
                          <option value="">None</option>
                          {(productOptions?.colors || []).map(opt => {
                            const val = typeof opt === 'string' ? opt : opt.id;
                            const label = typeof opt === 'string' ? opt : opt.label;
                            return <option key={val} value={val}>{label}</option>;
                          })}
                        </select>
                      </div>
                    </div>
                    
                    {/* Custom Text Addition */}
                    <div className="grid grid-cols-2 gap-4">
                      <div>
                        <label className="block text-sm font-medium text-gray-700 mb-1">
                          Add Custom Text
                        </label>
                        <input
                          type="text"
                          value={templateForm.customText}
                          onChange={(e) => setTemplateForm({...templateForm, customText: e.target.value})}
                          placeholder="e.g., Premium, Outdoor, Anti-Slip"
                          className="w-full px-3 py-2 border rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                        />
                      </div>
                      
                      <div>
                        <label className="block text-sm font-medium text-gray-700 mb-1">
                          Position
                        </label>
                        <select
                          value={templateForm.customTextPosition}
                          onChange={(e) => setTemplateForm({...templateForm, customTextPosition: e.target.value})}
                          className="w-full px-3 py-2 border rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 bg-white"
                          disabled={!templateForm.customText}
                        >
                          <option value="none">Don't add</option>
                          <option value="after_series">After Series Name</option>
                          <option value="before_size">Before Size</option>
                          <option value="at_end">At End</option>
                        </select>
                      </div>
                    </div>
                    
                    <div className="flex items-center gap-4">
                      <label className="flex items-center gap-2 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={templateForm.addCmToSize}
                          onChange={(e) => setTemplateForm({...templateForm, addCmToSize: e.target.checked})}
                          className="w-4 h-4 text-blue-600 rounded focus:ring-blue-500"
                        />
                        <span className="text-sm text-gray-700">Add "cm" to sizes</span>
                      </label>
                    </div>
                  </div>
                  
                  {/* Batch Preview Table */}
                  <div className="border rounded-lg overflow-hidden">
                    <div className="bg-gray-50 px-4 py-2 border-b flex justify-between items-center">
                      <h4 className="font-medium text-sm text-gray-700">Preview All Products</h4>
                      <div className="flex gap-2 text-xs">
                        <span className="px-2 py-0.5 bg-green-100 text-green-700 rounded">Has Color</span>
                        <span className="px-2 py-0.5 bg-orange-100 text-orange-700 rounded">Missing Color</span>
                        <span className="px-2 py-0.5 bg-yellow-100 text-yellow-700 rounded">Editing</span>
                      </div>
                    </div>
                    <div className="max-h-80 overflow-y-auto">
                      <table className="w-full text-sm">
                        <thead className="bg-gray-50 sticky top-0 z-10">
                          <tr>
                            <th className="text-left px-2 py-2 font-medium text-gray-600 w-20">SKU</th>
                            <th className="text-left px-2 py-2 font-medium text-gray-600">New Display Name</th>
                            <th className="text-left px-2 py-2 font-medium text-gray-600">Supplier Name</th>
                            <th className="text-left px-2 py-2 font-medium text-gray-600 w-20">Color</th>
                            <th className="px-2 py-2 w-16"></th>
                          </tr>
                        </thead>
                        <tbody className="divide-y">
                          {generateTemplatePreview().map((item, idx) => {
                            const isEditing = editingProductSku === item.sku;
                            const supplierName = templateForm.supplierNameOverrides[item.sku] || item.product.supplier_product_name || item.original;
                            
                            return (
                              <React.Fragment key={item.sku}>
                                <tr className={`transition-colors ${isEditing ? 'bg-yellow-50' : item.isOverride ? 'bg-blue-50' : (!item.components?.hasColor ? 'bg-orange-50' : (idx % 2 === 0 ? 'bg-white' : 'bg-gray-50'))}`}>
                                  <td className="px-2 py-2 font-mono text-xs text-gray-600">{item.sku}</td>
                                  <td className="px-2 py-2 group relative">
                                    {/* 24 May 2026 — read-only on mobile.
                                        The inline input here was ~80px
                                        wide; iOS Safari couldn't move
                                        the cursor inside such a narrow
                                        text field. Tap the ✎ button to
                                        open the full-width popup
                                        editor instead. */}
                                    <div className="relative cursor-help">
                                      <span className={`font-medium text-xs ${item.components?.hasColor ? 'text-green-700' : 'text-orange-700'} ${item.isOverride ? 'underline decoration-dashed' : ''}`}>
                                        {(templateForm.productOverrides[item.sku] || item.newName).substring(0, 30)}
                                        {(templateForm.productOverrides[item.sku] || item.newName).length > 30 ? '…' : ''}
                                      </span>
                                      {/* Hover tooltip */}
                                      <div className="absolute bottom-full left-0 mb-2 hidden group-hover:block z-20">
                                        <div className="bg-gray-900 text-white text-xs rounded-lg px-3 py-2 shadow-lg max-w-xs whitespace-normal">
                                          <div className="font-semibold text-green-400 mb-1">New Name:</div>
                                          <div>{templateForm.productOverrides[item.sku] || item.newName}</div>
                                          <div className="border-t border-gray-700 mt-2 pt-2">
                                            <div className="text-gray-400 text-[10px]">Original: {item.original}</div>
                                          </div>
                                        </div>
                                        <div className="absolute left-4 top-full w-0 h-0 border-l-8 border-r-8 border-t-8 border-l-transparent border-r-transparent border-t-gray-900"></div>
                                      </div>
                                    </div>
                                  </td>
                                  <td className="px-2 py-2">
                                    <div className="group relative cursor-help">
                                      <span className="text-xs text-purple-600">
                                        {supplierName.substring(0, 25)}{supplierName.length > 25 ? '…' : ''}
                                      </span>
                                      {/* Hover tooltip for supplier name */}
                                      <div className="absolute bottom-full left-0 mb-2 hidden group-hover:block z-20">
                                        <div className="bg-purple-900 text-white text-xs rounded-lg px-3 py-2 shadow-lg max-w-xs whitespace-normal">
                                          <div className="font-semibold text-purple-300 mb-1">Supplier Name:</div>
                                          <div>{supplierName}</div>
                                        </div>
                                        <div className="absolute left-4 top-full w-0 h-0 border-l-8 border-r-8 border-t-8 border-l-transparent border-r-transparent border-t-purple-900"></div>
                                      </div>
                                    </div>
                                  </td>
                                  <td className="px-2 py-2">
                                    <select
                                      value={templateForm.productColors[item.sku] || ''}
                                      onChange={(e) => setTemplateForm({
                                        ...templateForm,
                                        productColors: {...templateForm.productColors, [item.sku]: e.target.value}
                                      })}
                                      className={`text-xs px-1 py-1 border rounded w-full ${!item.components?.hasColor ? 'border-orange-300 bg-orange-50' : 'border-gray-200 bg-white'}`}
                                    >
                                      <option value="">{item.components?.color || '—'}</option>
                                      {(productOptions?.colors || []).map(opt => {
                                        const val = typeof opt === 'string' ? opt : (opt.id || opt.value);
                                        const label = typeof opt === 'string' ? opt : (opt.label || opt.id || opt.value);
                                        return <option key={val} value={label}>{label}</option>;
                                      })}
                                      {/* Allow custom color entry */}
                                      {templateForm.productColors[item.sku] && 
                                       !(productOptions?.colors || []).some(opt => {
                                         const val = typeof opt === 'string' ? opt : (opt.label || opt.id);
                                         return val === templateForm.productColors[item.sku];
                                       }) && (
                                        <option value={templateForm.productColors[item.sku]}>{templateForm.productColors[item.sku]} (custom)</option>
                                      )}
                                      <option value="__CUSTOM__">+ Add Custom Color...</option>
                                    </select>
                                    {templateForm.productColors[item.sku] === '__CUSTOM__' && (
                                      <input
                                        type="text"
                                        placeholder="Type color name..."
                                        className="text-xs px-1 py-1 border border-blue-300 rounded w-full mt-1 bg-blue-50"
                                        autoFocus
                                        onKeyDown={(e) => {
                                          if (e.key === 'Enter' && e.target.value.trim()) {
                                            setTemplateForm(prev => ({
                                              ...prev,
                                              productColors: {...prev.productColors, [item.sku]: e.target.value.trim()}
                                            }));
                                          }
                                        }}
                                        onBlur={(e) => {
                                          if (e.target.value.trim()) {
                                            setTemplateForm(prev => ({
                                              ...prev,
                                              productColors: {...prev.productColors, [item.sku]: e.target.value.trim()}
                                            }));
                                          } else {
                                            setTemplateForm(prev => ({
                                              ...prev,
                                              productColors: {...prev.productColors, [item.sku]: ''}
                                            }));
                                          }
                                        }}
                                        data-testid={`custom-color-input-${item.sku}`}
                                      />
                                    )}
                                  </td>
                                  <td className="px-2 py-2">
                                    <div className="flex gap-1">
                                      {/* Edit/Save button */}
                                      <button
                                        onClick={() => {
                                          if (isEditing) {
                                            setEditingProductSku(null);
                                          } else {
                                            setEditingProductSku(item.sku);
                                            // If not already overridden, set current values
                                            if (!templateForm.productOverrides[item.sku]) {
                                              setTemplateForm(prev => ({
                                                ...prev,
                                                productOverrides: {...prev.productOverrides, [item.sku]: item.newName}
                                              }));
                                            }
                                          }
                                        }}
                                        className={`text-xs px-2 py-1 rounded transition-colors ${
                                          isEditing 
                                            ? 'bg-green-500 text-white hover:bg-green-600' 
                                            : 'bg-yellow-100 text-yellow-700 hover:bg-yellow-200'
                                        }`}
                                        title={isEditing ? 'Done editing' : 'Edit this product individually'}
                                      >
                                        {isEditing ? '✓' : '✎'}
                                      </button>
                                      {/* Clear override button */}
                                      {(item.isOverride || templateForm.supplierNameOverrides[item.sku]) && (
                                        <button
                                          onClick={() => {
                                            const newOverrides = {...templateForm.productOverrides};
                                            const newSupplierOverrides = {...templateForm.supplierNameOverrides};
                                            delete newOverrides[item.sku];
                                            delete newSupplierOverrides[item.sku];
                                            setTemplateForm({
                                              ...templateForm, 
                                              productOverrides: newOverrides,
                                              supplierNameOverrides: newSupplierOverrides
                                            });
                                            setEditingProductSku(null);
                                          }}
                                          className="text-xs px-2 py-1 rounded bg-red-100 text-red-700 hover:bg-red-200"
                                          title="Reset to template"
                                        >
                                          ↺
                                        </button>
                                      )}
                                    </div>
                                  </td>
                                </tr>
                                {/* 24 May 2026 — inline "expanded edit
                                    row" removed; replaced by the full
                                    popup editor below the table. The
                                    old row tried to compress 3 wide
                                    inputs into a mobile viewport and
                                    failed (cursor couldn't move). */}
                              </React.Fragment>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  </div>

                  {/* 24 May 2026 — full-width popup editor.
                      Opens when ✎ is tapped (state: editingProductSku).
                      Renders OVER the parent modal so iOS Safari can
                      give the inputs proper focus + cursor handling.
                      User reported the inline table inputs were too
                      narrow on mobile to move the cursor inside. */}
                  {editingProductSku && (() => {
                    const editItem = generateTemplatePreview().find((p) => p.sku === editingProductSku);
                    if (!editItem) return null;
                    const currentDisplay = templateForm.productOverrides[editingProductSku] ?? editItem.newName;
                    const currentSupplier = templateForm.supplierNameOverrides[editingProductSku] ?? (editItem.product.supplier_product_name || editItem.original);
                    return (
                      <div
                        className="fixed inset-0 z-[60] bg-black/60 flex items-end sm:items-center justify-center p-3"
                        onClick={() => setEditingProductSku(null)}
                        data-testid="rename-detail-popup-backdrop"
                      >
                        <div
                          className="bg-white rounded-t-2xl sm:rounded-2xl w-full sm:max-w-md max-h-[90vh] overflow-y-auto shadow-2xl"
                          onClick={(e) => e.stopPropagation()}
                          data-testid="rename-detail-popup"
                        >
                          <div className="px-4 py-3 border-b flex items-center justify-between">
                            <div>
                              <h4 className="font-semibold text-sm text-gray-900">Edit product</h4>
                              <p className="text-[11px] font-mono text-gray-500 mt-0.5">{editingProductSku}</p>
                            </div>
                            <button
                              type="button"
                              onClick={() => setEditingProductSku(null)}
                              className="text-gray-400 hover:text-gray-700 p-1 -m-1"
                              aria-label="Close"
                              data-testid="rename-detail-popup-close"
                            >
                              <X className="h-5 w-5" />
                            </button>
                          </div>

                          <div className="p-4 space-y-4">
                            <div>
                              <label className="block text-xs font-semibold text-gray-700 mb-1">
                                Original supplier name
                              </label>
                              <div className="text-sm bg-gray-50 border border-gray-200 rounded px-3 py-2 font-mono text-gray-600 break-all">
                                {editItem.original}
                              </div>
                            </div>

                            <div>
                              <label className="block text-xs font-semibold text-blue-700 mb-1">
                                New display name
                              </label>
                              <input
                                type="text"
                                value={currentDisplay}
                                onChange={(e) => setTemplateForm({
                                  ...templateForm,
                                  productOverrides: {...templateForm.productOverrides, [editingProductSku]: e.target.value},
                                })}
                                className="w-full px-3 py-3 text-base border border-blue-300 rounded-lg focus:outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-200"
                                autoFocus
                                data-testid="rename-detail-display-input"
                              />
                              <p className="text-[11px] text-gray-500 mt-1">
                                What customers see on the storefront.
                              </p>
                            </div>

                            <div>
                              <label className="block text-xs font-semibold text-purple-700 mb-1">
                                Supplier / internal name
                              </label>
                              <input
                                type="text"
                                value={currentSupplier}
                                onChange={(e) => setTemplateForm({
                                  ...templateForm,
                                  supplierNameOverrides: {...templateForm.supplierNameOverrides, [editingProductSku]: e.target.value},
                                })}
                                className="w-full px-3 py-3 text-base border border-purple-300 rounded-lg focus:outline-none focus:border-purple-500 focus:ring-2 focus:ring-purple-200"
                                data-testid="rename-detail-supplier-input"
                              />
                              <p className="text-[11px] text-gray-500 mt-1">
                                Only shown internally — never on the storefront.
                              </p>
                            </div>

                            <div>
                              <label className="block text-xs font-semibold text-gray-700 mb-1">Color</label>
                              <select
                                value={templateForm.productColors[editingProductSku] || ''}
                                onChange={(e) => setTemplateForm({
                                  ...templateForm,
                                  productColors: {...templateForm.productColors, [editingProductSku]: e.target.value},
                                })}
                                className="w-full px-3 py-3 text-base border border-gray-300 rounded-lg focus:outline-none focus:border-blue-500 bg-white"
                                data-testid="rename-detail-color-select"
                              >
                                <option value="">{editItem.components?.color || '— (no color)'}</option>
                                {(productOptions?.colors || []).map((opt) => {
                                  const val = typeof opt === 'string' ? opt : (opt.id || opt.value);
                                  const label = typeof opt === 'string' ? opt : (opt.label || opt.id || opt.value);
                                  return <option key={val} value={label}>{label}</option>;
                                })}
                              </select>
                            </div>
                          </div>

                          <div className="px-4 py-3 border-t bg-gray-50 flex gap-2 sticky bottom-0">
                            <button
                              type="button"
                              onClick={() => {
                                // Discard this product's overrides and close.
                                const newOverrides = {...templateForm.productOverrides};
                                const newSupplier = {...templateForm.supplierNameOverrides};
                                delete newOverrides[editingProductSku];
                                delete newSupplier[editingProductSku];
                                setTemplateForm({
                                  ...templateForm,
                                  productOverrides: newOverrides,
                                  supplierNameOverrides: newSupplier,
                                });
                                setEditingProductSku(null);
                              }}
                              className="flex-1 px-3 py-2.5 text-sm font-medium text-red-700 bg-white border border-red-200 rounded-lg hover:bg-red-50"
                              data-testid="rename-detail-reset"
                            >
                              Reset to template
                            </button>
                            <button
                              type="button"
                              onClick={() => setEditingProductSku(null)}
                              className="flex-1 px-3 py-2.5 text-sm font-bold text-white bg-green-600 rounded-lg hover:bg-green-700"
                              data-testid="rename-detail-done"
                            >
                              Done
                            </button>
                          </div>
                        </div>
                      </div>
                    );
                  })()}
                </>
              )}
              
              {/* ADVANCED MODE - Original UI */}
              {renameMode === 'advanced' && (
                <>
              {/* Selected Products Dropdown */}
              {(() => {
                const selectedSkusList = Array.from(selectedProducts);
                const selectedProductsList = products.filter(p => selectedSkusList.includes(getProductKey(p)));
                
                if (selectedProductsList.length === 0) return null;
                
                return (
                  <div className="border rounded-lg p-3 bg-blue-50 border-blue-200">
                    <label className="block text-xs font-medium text-blue-700 mb-2">
                      Preview Product ({selectedProductsList.length} selected)
                    </label>
                    <select
                      value={selectedPreviewProductIndex}
                      onChange={(e) => setSelectedPreviewProductIndex(parseInt(e.target.value))}
                      className="w-full px-3 py-2 text-sm border border-blue-300 rounded-lg bg-white focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                    >
                      {selectedProductsList.map((product, idx) => (
                        <option key={getProductKey(product)} value={idx} title={`${product.sku} - ${product.product_name || product.name || ''}`}>
                          {product.sku} - {(product.product_name || product.name || '').substring(0, 50)}{(product.product_name || product.name || '').length > 50 ? '...' : ''}
                        </option>
                      ))}
                    </select>
                  </div>
                );
              })()}
              
              {/* Live Single Product Preview - Always visible */}
              {(() => {
                const selectedSkusList = Array.from(selectedProducts);
                const selectedProductsList = products.filter(p => selectedSkusList.includes(getProductKey(p)));
                const firstProduct = selectedProductsList[selectedPreviewProductIndex] || selectedProductsList[0];
                if (!firstProduct) return null;
                
                const currentName = firstProduct.product_name || firstProduct.name || '';
                let previewName = currentName;
                const seriesName = bulkRenameForm.currentSeriesName;
                
                // Apply transformations for preview
                // Step 1: Replace series name if specified
                if (bulkRenameForm.newSeriesName && seriesName) {
                  const regex = new RegExp(`^${seriesName}\\s+`, 'i');
                  previewName = previewName.replace(regex, `${bulkRenameForm.newSeriesName} `);
                }
                
                // Step 2: Apply word replacements FIRST (before insert, to avoid duplicating inserted text)
                if (bulkRenameForm.wordReplacements && bulkRenameForm.wordReplacements.length > 0) {
                  bulkRenameForm.wordReplacements.forEach(replacement => {
                    if (replacement.from && replacement.to !== undefined && !replacement.isSeriesName) {
                      // Skip series name replacements - already handled above
                      const isColor = COLOR_WORDS.some(c => c.toLowerCase() === replacement.from.toLowerCase());
                      if (!isColor) {
                        const wordRegex = new RegExp(`\\b${replacement.from}\\b`, 'gi');
                        previewName = previewName.replace(wordRegex, replacement.to);
                      }
                    }
                  });
                }
                
                // Step 3: Apply insert text at specified position AFTER word replacements
                const effectiveSeries = bulkRenameForm.newSeriesName || seriesName;
                if (bulkRenameForm.insertText) {
                  const words = previewName.split(/\s+/);
                  const insertPos = bulkRenameForm.insertPosition;
                  const insertText = bulkRenameForm.insertText;
                  
                  switch (insertPos) {
                    case 'after_series':
                      if (words.length > 0) words.splice(1, 0, insertText);
                      break;
                    case 'before_size':
                      const sizeIdx = words.findIndex(w => /^\d+(\.\d+)?[xX]\d+/.test(w));
                      if (sizeIdx > 0) words.splice(sizeIdx, 0, insertText);
                      else if (words.length > 1) words.splice(1, 0, insertText);
                      break;
                    case 'before_color':
                      const colorWords = ['White', 'Black', 'Grey', 'Gray', 'Cream', 'Beige', 'Brown', 'Silver', 'Gold', 'Blue', 'Green', 'Red', 'Pink', 'Ivory', 'Sand', 'Charcoal', 'Anthracite', 'Taupe', 'Oak', 'Walnut', 'Pearl', 'Onyx', 'Honey', 'Copper', 'Bronze', 'Rust', 'Sage', 'Teal', 'Navy', 'Midnight', 'Slate', 'Latte', 'Mocha', 'Espresso', 'Caramel', 'Amber', 'Cobalt', 'Blu', 'Bianco', 'Nero', 'Grigio', 'Avorio', 'Noce', 'Grafite'];
                      const colorIdx = words.findIndex(w => colorWords.some(c => w.toLowerCase() === c.toLowerCase()));
                      if (colorIdx > 0) words.splice(colorIdx, 0, insertText);
                      else if (words.length > 1) words.splice(1, 0, insertText);
                      break;
                    case 'at_start':
                      words.unshift(insertText);
                      break;
                    case 'at_end':
                      words.push(insertText);
                      break;
                    case 'custom':
                      const idx = Math.min(Math.max(0, bulkRenameForm.customInsertIndex), words.length);
                      words.splice(idx, 0, insertText);
                      break;
                    default:
                      if (words.length > 0) words.splice(1, 0, insertText);
                  }
                  previewName = words.join(' ');
                }
                
                if (bulkRenameForm.addCmToSize) {
                  // Note: (?![0-9cm]) ensures we don't match partial numbers (e.g., 30x6 in 30x60cm)
                  previewName = previewName.replace(/(\d+(?:\.\d+)?)[xX](\d+(?:\.\d+)?)(?![0-9cm])/g, '$1x$2cm');
                }
                
                // Apply word deletions
                if (bulkRenameForm.wordsToDelete && bulkRenameForm.wordsToDelete.length > 0) {
                  const wordsToDeleteLower = bulkRenameForm.wordsToDelete.map(w => w.toLowerCase());
                  const nameWords = previewName.split(/\s+/);
                  const filteredWords = nameWords.filter(word => !wordsToDeleteLower.includes(word.toLowerCase()));
                  previewName = filteredWords.join(' ');
                }
                
                const hasChanges = previewName !== currentName;
                
                // Generate display code from preview name (client-side preview)
                const generateLocalDisplayCode = (name) => {
                  if (!name) return 'TS----';
                  const parts = name.split(/\s+/);
                  let seriesInit = '', colorInit = '', sizeDigits = '00', finishInit = '';
                  const colors = ['white','black','grey','gray','beige','cream','blue','green','red','brown','ivory','sand','charcoal','anthracite','pearl','coral','amber','copper','graphite','slate','ash','oak','walnut'];
                  const finishes = {polished:'P',matt:'M',matte:'M',gloss:'G',satin:'S',lappato:'L',natural:'N',textured:'T',honed:'H',rustic:'R'};
                  
                  for (const part of parts) {
                    const lower = part.toLowerCase().replace(/[^a-z0-9]/g, '');
                    const sizeMatch = part.match(/^(\d+(?:\.\d+)?)[xX](\d+(?:\.\d+)?)/);
                    if (sizeMatch) {
                      sizeDigits = sizeMatch[1][0] + sizeMatch[2][0];
                      continue;
                    }
                    if (finishes[lower]) { finishInit = finishes[lower]; continue; }
                    if (colors.includes(lower)) { if (!colorInit) colorInit = part[0].toUpperCase(); continue; }
                    if (!seriesInit && lower.length > 1 && !['tile','tiles','porcelain','ceramic','cm','mm','wall','floor'].includes(lower)) {
                      seriesInit = part[0].toUpperCase();
                    }
                  }
                  return 'TS' + (seriesInit || 'X') + (colorInit || 'X') + sizeDigits + (finishInit || 'X');
                };
                
                const previewCode = generateLocalDisplayCode(previewName);
                const currentCode = generateLocalDisplayCode(currentName);
                const codeChanged = previewCode !== currentCode;
                
                return (
                  <div className={`p-4 rounded-lg border-2 ${hasChanges ? 'bg-green-50 border-green-300' : 'bg-gray-50 border-gray-200'}`}>
                    <div className="text-xs font-medium text-gray-500 mb-2">LIVE PREVIEW</div>
                    <div className="space-y-2">
                      {/* Display Name Preview */}
                      <div>
                        <div className="text-xs text-gray-400 mb-1">Display Name:</div>
                        <div className={`text-sm ${hasChanges ? 'line-through text-gray-400' : 'text-gray-700'}`}>
                          {currentName}
                        </div>
                        {hasChanges && (
                          <div className="text-base font-semibold text-green-700">
                            → {previewName}
                          </div>
                        )}
                      </div>
                      {/* Display Code Preview */}
                      <div className="pt-2 border-t border-gray-200">
                        <div className="text-xs text-gray-400 mb-1">Display Code:</div>
                        <div className="flex items-center gap-2">
                          <span className={`font-mono text-sm ${codeChanged ? 'line-through text-gray-400' : 'text-gray-700'}`}>
                            {currentCode}
                          </span>
                          {codeChanged && (
                            <span className="font-mono text-base font-semibold text-green-700">
                              → {previewCode}
                            </span>
                          )}
                        </div>
                      </div>
                    </div>
                  </div>
                );
              })()}

              {/* Unified Word Replacement Section */}
              <div className="border rounded-lg p-4 bg-slate-50">
                <label className="block text-sm font-medium mb-3">
                  Click any word to change it <span className="text-muted-foreground font-normal">(series name, descriptors, etc.)</span>
                </label>
                
                {/* Show all editable words including series name */}
                {(() => {
                  const editableWords = getEditableWords();
                  const seriesName = bulkRenameForm.currentSeriesName;
                  
                  // Check if series name is already in word replacements
                  const isSeriesSelected = seriesName && bulkRenameForm.wordReplacements.some(
                    r => r.from.toLowerCase() === seriesName.toLowerCase() && r.isSeriesName
                  );
                  const seriesReplacement = bulkRenameForm.wordReplacements.find(
                    r => r.from.toLowerCase() === seriesName?.toLowerCase() && r.isSeriesName
                  );
                  
                  return (
                    <div className="space-y-3">
                      {/* Series name pill (highlighted separately) */}
                      {seriesName && (
                        <div className="mb-2">
                          <div className="text-xs text-slate-500 mb-2 font-medium">SERIES NAME</div>
                          <button
                            type="button"
                            onClick={() => {
                              const newForm = {...bulkRenameForm};
                              if (isSeriesSelected) {
                                newForm.wordReplacements = newForm.wordReplacements.filter(
                                  r => !(r.from.toLowerCase() === seriesName.toLowerCase() && r.isSeriesName)
                                );
                                newForm.newSeriesName = '';
                              } else {
                                newForm.wordReplacements = [...newForm.wordReplacements, { from: seriesName, to: '', isSeriesName: true }];
                              }
                              setBulkRenameForm(newForm);
                            }}
                            className={`px-4 py-2 text-sm rounded-lg transition-all font-medium ${
                              isSeriesSelected
                                ? 'bg-blue-600 text-white shadow-md'
                                : 'bg-white text-slate-700 hover:bg-blue-100 border-2 border-blue-300 hover:border-blue-500'
                            }`}
                            title={`Click to ${isSeriesSelected ? 'remove' : 'rename'} series`}
                          >
                            {isSeriesSelected && seriesReplacement?.to ? (
                              <span><s className="opacity-60">{seriesName}</s> → {seriesReplacement.to}</span>
                            ) : (
                              <span>{seriesName}</span>
                            )}
                          </button>
                        </div>
                      )}
                      
                      {/* ALL DISPLAY NAME WORDS - with delete option */}
                      {(() => {
                        const allWords = getAllDisplayNameWords();
                        if (allWords.length === 0) return null;
                        
                        return (
                          <div className="border-t border-slate-200 pt-3">
                            <div className="text-xs text-slate-500 mb-2 font-medium">ALL WORDS FROM DISPLAY NAME <span className="text-red-500">(click × to delete)</span></div>
                            <div className="flex flex-wrap gap-2">
                              {allWords.map((w, idx) => {
                                const isDeleted = bulkRenameForm.wordsToDelete?.some(d => d.toLowerCase() === w.original.toLowerCase());
                                const isReplacing = bulkRenameForm.wordReplacements.some(r => r.from.toLowerCase() === w.original.toLowerCase());
                                const isSeries = w.original.toLowerCase() === bulkRenameForm.currentSeriesName?.toLowerCase();
                                
                                // Color coding by type
                                let bgColor = 'bg-slate-100 text-slate-700 border-slate-300';
                                let typeLabel = '';
                                if (w.type === 'size') {
                                  bgColor = 'bg-purple-100 text-purple-700 border-purple-300';
                                  typeLabel = 'size';
                                } else if (w.type === 'color') {
                                  bgColor = 'bg-green-100 text-green-700 border-green-300';
                                  typeLabel = 'color';
                                } else if (w.type === 'finish') {
                                  bgColor = 'bg-blue-100 text-blue-700 border-blue-300';
                                  typeLabel = 'finish';
                                } else if (isSeries) {
                                  bgColor = 'bg-amber-100 text-amber-700 border-amber-300';
                                  typeLabel = 'series';
                                }
                                
                                if (isDeleted) {
                                  bgColor = 'bg-red-100 text-red-500 border-red-300 line-through';
                                }
                                
                                return (
                                  <div
                                    key={idx}
                                    className={`group flex items-center gap-1 px-2 py-1 text-sm rounded-lg border transition-all ${bgColor}`}
                                  >
                                    <span className={isDeleted ? 'line-through opacity-60' : ''}>
                                      {w.original}
                                    </span>
                                    {typeLabel && <span className="text-[10px] opacity-50">({typeLabel})</span>}
                                    <span className="text-[10px] opacity-40 ml-0.5">×{w.count}</span>
                                    <button
                                      type="button"
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        const newForm = {...bulkRenameForm};
                                        if (isDeleted) {
                                          // Remove from delete list
                                          newForm.wordsToDelete = (newForm.wordsToDelete || []).filter(d => d.toLowerCase() !== w.original.toLowerCase());
                                        } else {
                                          // Add to delete list
                                          newForm.wordsToDelete = [...(newForm.wordsToDelete || []), w.original];
                                        }
                                        setBulkRenameForm(newForm);
                                      }}
                                      className={`ml-1 w-4 h-4 flex items-center justify-center rounded-full transition-colors ${
                                        isDeleted 
                                          ? 'bg-green-500 text-white hover:bg-green-600' 
                                          : 'bg-red-400 text-white hover:bg-red-500 opacity-60 group-hover:opacity-100'
                                      }`}
                                      title={isDeleted ? 'Restore this word' : 'Delete this word'}
                                    >
                                      {isDeleted ? '↩' : '×'}
                                    </button>
                                  </div>
                                );
                              })}
                            </div>
                            {bulkRenameForm.wordsToDelete?.length > 0 && (
                              <div className="mt-2 p-2 bg-red-50 border border-red-200 rounded text-xs text-red-600 flex items-center justify-between">
                                <div><strong>Words to delete:</strong> {bulkRenameForm.wordsToDelete.join(', ')}</div>
                                <button
                                  type="button"
                                  onClick={() => setBulkRenameForm({...bulkRenameForm, wordsToDelete: []})}
                                  className="text-red-700 hover:text-red-900 font-medium ml-2"
                                >
                                  Clear All
                                </button>
                              </div>
                            )}
                            
                            {/* Quick delete buttons */}
                            <div className="mt-2 flex flex-wrap gap-2">
                              <button
                                type="button"
                                onClick={() => {
                                  const allWords = getAllDisplayNameWords();
                                  const sizes = allWords.filter(w => w.type === 'size').map(w => w.original);
                                  if (sizes.length > 0) {
                                    const newWordsToDelete = [...new Set([...(bulkRenameForm.wordsToDelete || []), ...sizes])];
                                    setBulkRenameForm({...bulkRenameForm, wordsToDelete: newWordsToDelete});
                                  }
                                }}
                                className="px-2 py-1 text-xs bg-purple-100 text-purple-700 rounded hover:bg-purple-200 transition-colors"
                              >
                                Delete All Sizes
                              </button>
                              <button
                                type="button"
                                onClick={() => {
                                  const allWords = getAllDisplayNameWords();
                                  const colors = allWords.filter(w => w.type === 'color').map(w => w.original);
                                  if (colors.length > 0) {
                                    const newWordsToDelete = [...new Set([...(bulkRenameForm.wordsToDelete || []), ...colors])];
                                    setBulkRenameForm({...bulkRenameForm, wordsToDelete: newWordsToDelete});
                                  }
                                }}
                                className="px-2 py-1 text-xs bg-green-100 text-green-700 rounded hover:bg-green-200 transition-colors"
                              >
                                Delete All Colors
                              </button>
                              <button
                                type="button"
                                onClick={() => {
                                  const allWords = getAllDisplayNameWords();
                                  const finishes = allWords.filter(w => w.type === 'finish').map(w => w.original);
                                  if (finishes.length > 0) {
                                    const newWordsToDelete = [...new Set([...(bulkRenameForm.wordsToDelete || []), ...finishes])];
                                    setBulkRenameForm({...bulkRenameForm, wordsToDelete: newWordsToDelete});
                                  }
                                }}
                                className="px-2 py-1 text-xs bg-blue-100 text-blue-700 rounded hover:bg-blue-200 transition-colors"
                              >
                                Delete All Finishes
                              </button>
                            </div>
                          </div>
                        );
                      })()}
                      
                      {/* Other word pills - for replacement */}
                      {editableWords.length > 0 && (
                        <div className="border-t border-slate-200 pt-3">
                          <div className="text-xs text-slate-500 mb-2 font-medium">REPLACE WORDS <span className="text-orange-500">(click to replace)</span></div>
                          <div className="flex flex-wrap gap-2">
                            {editableWords.slice(0, 20).map((w, idx) => {
                              const isSelected = bulkRenameForm.wordReplacements.some(r => r.from.toLowerCase() === w.original.toLowerCase() && !r.isSeriesName);
                              const replacement = bulkRenameForm.wordReplacements.find(r => r.from.toLowerCase() === w.original.toLowerCase() && !r.isSeriesName);
                              
                              return (
                                <button
                                  key={idx}
                                  type="button"
                                  onClick={() => {
                                    const newForm = {...bulkRenameForm};
                                    if (isSelected) {
                                      newForm.wordReplacements = newForm.wordReplacements.filter(r => !(r.from.toLowerCase() === w.original.toLowerCase() && !r.isSeriesName));
                                    } else {
                                      newForm.wordReplacements = [...newForm.wordReplacements, { from: w.original, to: '', isSeriesName: false }];
                                    }
                                    setBulkRenameForm(newForm);
                                  }}
                                  className={`px-3 py-1.5 text-sm rounded-full transition-all ${
                                    isSelected
                                      ? 'bg-orange-500 text-white shadow-md'
                                      : 'bg-white text-slate-700 hover:bg-orange-100 border border-slate-300 hover:border-orange-400'
                                  }`}
                                  title={`Found in ${w.count} product(s) - Click to ${isSelected ? 'remove' : 'replace'}`}
                                >
                                  {isSelected && replacement?.to ? (
                                    <span><s className="opacity-60">{w.original}</s> → {replacement.to}</span>
                                  ) : (
                                    <span>{w.original}</span>
                                  )}
                                  <span className={`ml-1 text-xs ${isSelected ? 'text-orange-200' : 'text-slate-400'}`}>({w.count})</span>
                                </button>
                              );
                            })}
                          </div>
                        </div>
                      )}
                      
                      {/* Input fields for selected words */}
                      {bulkRenameForm.wordReplacements.length > 0 && (
                        <div className="space-y-2 pt-3 border-t border-slate-200">
                          <div className="text-xs text-slate-500 mb-2">Enter replacement text:</div>
                          {bulkRenameForm.wordReplacements.map((replacement, idx) => (
                            <div key={idx} className={`flex items-center gap-2 p-2 rounded-lg border ${replacement.isSeriesName ? 'bg-blue-50 border-blue-200' : 'bg-white'}`}>
                              <span className={`px-2 py-1 rounded font-medium text-sm min-w-[80px] text-center ${
                                replacement.isSeriesName ? 'bg-blue-100 text-blue-700' : 'bg-orange-100 text-orange-700'
                              }`}>
                                {replacement.from}
                                {replacement.isSeriesName && <span className="ml-1 text-xs opacity-70">(series)</span>}
                              </span>
                              <span className="text-slate-400">→</span>
                              <Input
                                type="text"
                                placeholder={replacement.isSeriesName ? "New series name..." : "New word..."}
                                value={replacement.to}
                                onChange={(e) => {
                                  const newForm = {...bulkRenameForm};
                                  newForm.wordReplacements[idx].to = e.target.value;
                                  // Sync newSeriesName if this is the series replacement
                                  if (replacement.isSeriesName) {
                                    newForm.newSeriesName = e.target.value;
                                  }
                                  setBulkRenameForm(newForm);
                                }}
                                className="flex-1 text-sm h-8"
                                autoFocus={idx === bulkRenameForm.wordReplacements.length - 1}
                              />
                              <button
                                type="button"
                                onClick={() => {
                                  const newForm = {...bulkRenameForm};
                                  newForm.wordReplacements = newForm.wordReplacements.filter((_, i) => i !== idx);
                                  if (replacement.isSeriesName) {
                                    newForm.newSeriesName = '';
                                  }
                                  setBulkRenameForm(newForm);
                                }}
                                className="p-1 text-slate-400 hover:text-red-500 hover:bg-red-50 rounded"
                              >
                                <X className="w-4 h-4" />
                              </button>
                            </div>
                          ))}
                        </div>
                      )}
                      
                      {!seriesName && editableWords.length === 0 && (
                        <p className="text-sm text-slate-500 italic">No editable words found in selected products</p>
                      )}
                      
                      <p className="text-xs text-slate-400 mt-2">
                        Colors (Grey, White, etc.) and sizes (60x120cm) are protected and won't appear here
                      </p>
                    </div>
                  );
                })()}
              </div>

              {/* Insert Text at Position */}
              <div className="border rounded-lg p-4 bg-blue-50">
                <label className="block text-sm font-medium mb-2">Insert Text <span className="text-muted-foreground font-normal">(optional)</span></label>
                
                <div className="grid grid-cols-2 gap-3 mb-3">
                  <div>
                    <Input
                      type="text"
                      placeholder="e.g., Laminate, Premium, Effect..."
                      value={bulkRenameForm.insertText}
                      onChange={(e) => {
                        const newForm = {...bulkRenameForm, insertText: e.target.value};
                        newForm.previewProducts = generateRenamePreview(bulkRenameForm.newSeriesName, e.target.value, bulkRenameForm.insertPosition, bulkRenameForm.customInsertIndex, bulkRenameForm.addCmToSize);
                        setBulkRenameForm(newForm);
                      }}
                      className="text-base"
                    />
                  </div>
                  <div>
                    <select
                      value={bulkRenameForm.insertPosition}
                      onChange={(e) => {
                        const newForm = {...bulkRenameForm, insertPosition: e.target.value};
                        newForm.previewProducts = generateRenamePreview(bulkRenameForm.newSeriesName, bulkRenameForm.insertText, e.target.value, bulkRenameForm.customInsertIndex, bulkRenameForm.addCmToSize);
                        setBulkRenameForm(newForm);
                      }}
                      className="w-full h-10 px-3 rounded-md border border-input bg-background text-sm"
                    >
                      <option value="after_series">After Series Name</option>
                      <option value="before_size">Before Size (e.g., 60x120)</option>
                      <option value="before_color">Before Color</option>
                      <option value="at_start">At Start</option>
                      <option value="at_end">At End</option>
                      <option value="custom">Custom Position</option>
                    </select>
                  </div>
                </div>
                
                {bulkRenameForm.insertPosition === 'custom' && (
                  <div className="flex items-center gap-2 mb-2">
                    <span className="text-sm text-slate-600">Insert after word #</span>
                    <Input
                      type="number"
                      min="0"
                      max="20"
                      value={bulkRenameForm.customInsertIndex}
                      onChange={(e) => {
                        const idx = parseInt(e.target.value) || 0;
                        const newForm = {...bulkRenameForm, customInsertIndex: idx};
                        newForm.previewProducts = generateRenamePreview(bulkRenameForm.newSeriesName, bulkRenameForm.insertText, 'custom', idx, bulkRenameForm.addCmToSize);
                        setBulkRenameForm(newForm);
                      }}
                      className="w-20 text-center"
                    />
                    <span className="text-xs text-slate-500">(0 = at start, 1 = after first word, etc.)</span>
                  </div>
                )}
                
                <p className="text-xs text-blue-600">
                  {bulkRenameForm.insertPosition === 'after_series' && 'Text will be inserted right after the series name'}
                  {bulkRenameForm.insertPosition === 'before_size' && 'Text will be inserted before size dimensions (e.g., 60x120)'}
                  {bulkRenameForm.insertPosition === 'before_color' && 'Text will be inserted before color names (Grey, White, etc.)'}
                  {bulkRenameForm.insertPosition === 'at_start' && 'Text will be added at the beginning of the name'}
                  {bulkRenameForm.insertPosition === 'at_end' && 'Text will be added at the end of the name'}
                  {bulkRenameForm.insertPosition === 'custom' && `Text will be inserted after word #${bulkRenameForm.customInsertIndex}`}
                </p>
              </div>

              {/* Add cm to sizes */}
              <div className="flex items-center gap-3 p-3 bg-gray-50 rounded-lg">
                <input
                  type="checkbox"
                  id="addCmToSize"
                  checked={bulkRenameForm.addCmToSize}
                  onChange={(e) => {
                    const newForm = {...bulkRenameForm, addCmToSize: e.target.checked};
                    newForm.previewProducts = generateRenamePreview(bulkRenameForm.newSeriesName, bulkRenameForm.insertText, bulkRenameForm.insertPosition, bulkRenameForm.customInsertIndex, e.target.checked);
                    setBulkRenameForm(newForm);
                  }}
                  className="w-4 h-4 rounded border-gray-300 text-orange-600 focus:ring-orange-500"
                />
                <label htmlFor="addCmToSize" className="text-sm">
                  <span className="font-medium">Add "cm" to sizes</span>
                  <span className="text-muted-foreground ml-1">(e.g., 30x60 → 30x60cm)</span>
                </label>
              </div>

              {/* Supplier Product Name - Word Replacement with Preview */}
              <div className="border rounded-lg p-4 bg-purple-50">
                <label className="block text-sm font-medium mb-3">
                  Supplier Product Name <span className="text-muted-foreground font-normal">(click words to change)</span>
                </label>
                
                {/* Live Preview for Supplier Product Name */}
                {(() => {
                  const currentSupplierName = bulkRenameForm.currentSupplierProductName || '';
                  let previewSupplierName = currentSupplierName;
                  
                  // Apply word replacements
                  if (bulkRenameForm.supplierNameReplacements && bulkRenameForm.supplierNameReplacements.length > 0) {
                    bulkRenameForm.supplierNameReplacements.forEach(replacement => {
                      if (replacement.from && replacement.to !== undefined) {
                        const wordRegex = new RegExp(`\\b${replacement.from}\\b`, 'gi');
                        previewSupplierName = previewSupplierName.replace(wordRegex, replacement.to);
                      }
                    });
                  }
                  
                  const hasChanges = previewSupplierName !== currentSupplierName;
                  
                  if (!currentSupplierName) return null;
                  
                  return (
                    <div className={`p-3 rounded-lg border-2 mb-3 ${hasChanges ? 'bg-purple-100 border-purple-400' : 'bg-white border-purple-200'}`}>
                      <div className="text-xs font-medium text-purple-500 mb-1">SUPPLIER NAME PREVIEW</div>
                      <div className="space-y-1">
                        <div className={`text-sm ${hasChanges ? 'line-through text-gray-400' : 'text-gray-700'}`}>
                          {currentSupplierName}
                        </div>
                        {hasChanges && (
                          <div className="text-base font-semibold text-purple-700">
                            → {previewSupplierName}
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })()}
                
                {/* Clickable word pills for supplier_product_name */}
                {(() => {
                  const supplierWords = getSupplierNameWords();
                  
                  return (
                    <div className="space-y-3">
                      <div className="flex flex-wrap gap-2">
                        {supplierWords.slice(0, 15).map((w, idx) => {
                          const isSelected = bulkRenameForm.supplierNameReplacements?.some(r => r.from.toLowerCase() === w.original.toLowerCase());
                          const replacement = bulkRenameForm.supplierNameReplacements?.find(r => r.from.toLowerCase() === w.original.toLowerCase());
                          
                          return (
                            <button
                              key={idx}
                              type="button"
                              onClick={() => {
                                const newForm = {...bulkRenameForm};
                                if (!newForm.supplierNameReplacements) newForm.supplierNameReplacements = [];
                                if (isSelected) {
                                  newForm.supplierNameReplacements = newForm.supplierNameReplacements.filter(r => r.from.toLowerCase() !== w.original.toLowerCase());
                                } else {
                                  newForm.supplierNameReplacements = [...newForm.supplierNameReplacements, { from: w.original, to: '' }];
                                }
                                setBulkRenameForm(newForm);
                              }}
                              className={`px-3 py-1.5 text-sm rounded-full transition-all ${
                                isSelected
                                  ? 'bg-purple-600 text-white shadow-md'
                                  : 'bg-white text-slate-700 hover:bg-purple-100 border border-purple-300 hover:border-purple-500'
                              }`}
                              title={`Found in ${w.count} product(s) - Click to ${isSelected ? 'remove' : 'replace'}`}
                            >
                              {isSelected && replacement?.to ? (
                                <span><s className="opacity-60">{w.original}</s> → {replacement.to}</span>
                              ) : (
                                <span>{w.original}</span>
                              )}
                              <span className={`ml-1 text-xs ${isSelected ? 'text-purple-200' : 'text-slate-400'}`}>({w.count})</span>
                            </button>
                          );
                        })}
                      </div>
                      
                      {/* Input fields for selected supplier name words */}
                      {bulkRenameForm.supplierNameReplacements?.length > 0 && (
                        <div className="space-y-2 pt-3 border-t border-purple-200">
                          <div className="text-xs text-purple-600 mb-2">Enter replacement text:</div>
                          {bulkRenameForm.supplierNameReplacements.map((replacement, idx) => (
                            <div key={idx} className="flex items-center gap-2 bg-white p-2 rounded-lg border border-purple-200">
                              <span className="px-2 py-1 bg-purple-100 text-purple-700 rounded font-medium text-sm min-w-[80px] text-center">
                                {replacement.from}
                              </span>
                              <span className="text-slate-400">→</span>
                              <Input
                                type="text"
                                placeholder="New word..."
                                value={replacement.to}
                                onChange={(e) => {
                                  const newForm = {...bulkRenameForm};
                                  newForm.supplierNameReplacements[idx].to = e.target.value;
                                  setBulkRenameForm(newForm);
                                }}
                                className="flex-1 text-sm h-8"
                                autoFocus={idx === bulkRenameForm.supplierNameReplacements.length - 1}
                              />
                              <button
                                type="button"
                                onClick={() => {
                                  const newForm = {...bulkRenameForm};
                                  newForm.supplierNameReplacements = newForm.supplierNameReplacements.filter((_, i) => i !== idx);
                                  setBulkRenameForm(newForm);
                                }}
                                className="p-1 text-slate-400 hover:text-red-500 hover:bg-red-50 rounded"
                              >
                                <X className="w-4 h-4" />
                              </button>
                            </div>
                          ))}
                        </div>
                      )}
                      
                      {supplierWords.length === 0 && (
                        <p className="text-sm text-purple-500 italic">No supplier product name available</p>
                      )}
                    </div>
                  );
                })()}
              </div>
                </>
              )}
            </div>
            
            <div className="p-4 border-t flex justify-end gap-2">
              <Button variant="outline" onClick={() => setShowBulkRenameModal(false)}>
                Cancel
              </Button>
              
              {/* Template Mode Button */}
              {renameMode === 'template' && (
                <Button 
                  onClick={async () => {
                    if (!templateForm.seriesName.trim()) {
                      toast.error('Please enter a series name');
                      return;
                    }
                    
                    setBulkRenameLoading(true);
                    try {
                      const preview = generateTemplatePreview();
                      const updates = preview.map(item => {
                        // Get supplier name - use override if set, otherwise use existing
                        const supplierName = templateForm.supplierNameOverrides[item.sku] || 
                                            item.product.supplier_product_name || 
                                            item.original;
                        return {
                          id: item.product._id,
                          sku: item.sku,
                          supplier: item.product.supplier,
                          display_name: item.newName,
                          supplier_product_name: supplierName,
                          series_name: templateForm.seriesName.trim()
                        };
                      });
                      
                      // Call API to update products
                      const response = await fetch(`${API_URL}/api/supplier-sync/products/bulk-rename-series`, {
                        method: 'POST',
                        headers: { 
                          'Content-Type': 'application/json',
                          'Authorization': `Bearer ${localStorage.getItem('token')}`
                        },
                        body: JSON.stringify({
                          products: updates.map(u => ({
                            id: u.id,
                            sku: u.sku,
                            supplier: u.supplier,
                            new_product_name: u.display_name,
                            new_supplier_product_name: u.supplier_product_name,
                            series_name: u.series_name
                          }))
                        })
                      });
                      
                      if (response.ok) {
                        toast.success(`Updated ${updates.length} products`);
                        setShowBulkRenameModal(false);
                        setEditingProductSku(null);
                        fetchProducts();
                        setSelectedProducts(new Set());
                      } else {
                        // Show specific error based on status code
                        if (response.status === 401) {
                          toast.error('Session expired - please login again');
                        } else if (response.status === 403) {
                          toast.error('You don\'t have permission for this action');
                        } else if (response.status === 500) {
                          toast.error('Server error - please try again');
                        } else {
                          const errorData = await response.json().catch(() => ({}));
                          toast.error(errorData.detail || 'Failed to update products');
                        }
                      }
                    } catch (error) {
                      console.error('Template rename error:', error);
                      toast.error('Network error - please check your connection');
                    } finally {
                      setBulkRenameLoading(false);
                    }
                  }}
                  disabled={bulkRenameLoading || !templateForm.seriesName.trim()}
                  className="bg-blue-600 hover:bg-blue-700"
                >
                  {bulkRenameLoading ? (
                    <>
                      <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                      Updating...
                    </>
                  ) : (
                    <>
                      <Pencil className="w-4 h-4 mr-2" />
                      Apply Template to {selectedProducts.size} Products
                    </>
                  )}
                </Button>
              )}
              
              {/* Advanced Mode Button */}
              {renameMode === 'advanced' && (
              <Button 
                onClick={handleBulkRenameSeries}
                disabled={bulkRenameLoading || (
                  !bulkRenameForm.newSeriesName.trim() && 
                  !bulkRenameForm.insertText.trim() && 
                  !bulkRenameForm.addCmToSize &&
                  !bulkRenameForm.wordReplacements.some(r => r.from && r.to) &&
                  !bulkRenameForm.supplierNameReplacements?.some(r => r.from && r.to)
                )}
                className="bg-orange-600 hover:bg-orange-700"
              >
                {bulkRenameLoading ? (
                  <>
                    <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                    Updating...
                  </>
                ) : (
                  <>
                    <Pencil className="w-4 h-4 mr-2" />
                    Update {selectedProducts.size} Products
                  </>
                )}
              </Button>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Bulk Edit Modal */}
      {showBulkEditModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-background rounded-xl w-full max-w-lg max-h-[90vh] overflow-auto">
            <div className="p-4 border-b flex items-center justify-between sticky top-0 bg-background">
              <div>
                <h3 className="font-semibold text-lg">Bulk Edit Products</h3>
                <p className="text-sm text-muted-foreground">{selectedProducts.size} products selected</p>
              </div>
              <button onClick={() => setShowBulkEditModal(false)} className="text-muted-foreground hover:text-foreground">
                <X className="h-5 w-5" />
              </button>
            </div>
            
            <div className="p-4 space-y-4">
              <div className="p-3 bg-amber-50 border border-amber-200 rounded-lg text-amber-800 text-sm">
                <strong>Note:</strong> Only fill in the fields you want to update. Empty fields will be left unchanged.
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium mb-1">Price (£)</label>
                  <Input
                    type="number"
                    step="0.01"
                    placeholder="Leave empty to skip"
                    value={bulkEditForm.price}
                    onChange={(e) => setBulkEditForm({...bulkEditForm, price: e.target.value})}
                  />
                </div>
                
                {isSuperAdmin && (
                  <div>
                    <label className="block text-sm font-medium mb-1">Cost Price (£)</label>
                    <Input
                      type="number"
                      step="0.01"
                      placeholder="Leave empty to skip"
                      value={bulkEditForm.cost_price}
                      onChange={(e) => setBulkEditForm({...bulkEditForm, cost_price: e.target.value})}
                    />
                  </div>
                )}
              </div>

              {isSuperAdmin && (
                <div>
                  <label className="block text-sm font-medium mb-1">Markup Percentage (%)</label>
                  <Input
                    type="number"
                    step="1"
                    placeholder="e.g., 50 for 50% markup on cost"
                    value={bulkEditForm.markup_percentage}
                    onChange={(e) => setBulkEditForm({...bulkEditForm, markup_percentage: e.target.value})}
                  />
                  <p className="text-xs text-muted-foreground mt-1">
                    Sets price based on cost price + markup. Requires cost_price to be set on products.
                  </p>
                </div>
              )}

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium mb-1">Stock</label>
                  <Input
                    type="number"
                    placeholder="Leave empty to skip"
                    value={bulkEditForm.stock}
                    onChange={(e) => setBulkEditForm({...bulkEditForm, stock: e.target.value})}
                  />
                </div>
                
                <div>
                  <label className="block text-sm font-medium mb-1">Reorder Level</label>
                  <Input
                    type="number"
                    placeholder="Leave empty to skip"
                    value={bulkEditForm.reorder_level}
                    onChange={(e) => setBulkEditForm({...bulkEditForm, reorder_level: e.target.value})}
                  />
                </div>
              </div>

              <div className="grid grid-cols-3 gap-4">
                <div>
                  <label className="block text-sm font-medium mb-1">Active</label>
                  <select
                    value={bulkEditForm.is_active}
                    onChange={(e) => setBulkEditForm({...bulkEditForm, is_active: e.target.value})}
                    className="w-full px-3 py-2 rounded-md border border-input bg-background text-sm"
                  >
                    <option value="">Don&apos;t change</option>
                    <option value="true">Yes</option>
                    <option value="false">No</option>
                  </select>
                </div>
                
                <div>
                  <label className="block text-sm font-medium mb-1">Featured</label>
                  <select
                    value={bulkEditForm.is_featured}
                    onChange={(e) => setBulkEditForm({...bulkEditForm, is_featured: e.target.value})}
                    className="w-full px-3 py-2 rounded-md border border-input bg-background text-sm"
                  >
                    <option value="">Don&apos;t change</option>
                    <option value="true">Yes</option>
                    <option value="false">No</option>
                  </select>
                </div>
                
                <div>
                  <label className="block text-sm font-medium mb-1">Clearance</label>
                  <select
                    value={bulkEditForm.clearance}
                    onChange={(e) => setBulkEditForm({...bulkEditForm, clearance: e.target.value})}
                    className="w-full px-3 py-2 rounded-md border border-input bg-background text-sm"
                  >
                    <option value="">Don&apos;t change</option>
                    <option value="true">Yes</option>
                    <option value="false">No</option>
                  </select>
                </div>
              </div>
            </div>
            
            <div className="p-4 border-t bg-muted/30 flex justify-end gap-3 sticky bottom-0">
              <Button
                variant="outline"
                onClick={() => setShowBulkEditModal(false)}
              >
                Cancel
              </Button>
              <Button
                onClick={handleBulkEdit}
                disabled={bulkEditLoading}
                className="bg-accent hover:bg-accent/90"
                data-testid="apply-bulk-edit-btn"
              >
                {bulkEditLoading ? 'Updating...' : `Update ${selectedProducts.size} Products`}
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Delete All From Database Dialog */}
      <Dialog open={showDeleteAllDbDialog} onOpenChange={setShowDeleteAllDbDialog}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-red-600">
              <AlertTriangle className="w-5 h-5" />
              Delete All Products From Database
            </DialogTitle>
          </DialogHeader>
          
          <div className="py-4 space-y-4">
            {/* Warning Message */}
            <div className="bg-red-50 border border-red-200 rounded-lg p-4">
              <div className="flex items-start gap-3">
                <AlertTriangle className="w-5 h-5 text-red-600 flex-shrink-0 mt-0.5" />
                <div>
                  <p className="font-semibold text-red-800">Warning: This action is irreversible!</p>
                  <p className="text-sm text-red-700 mt-1">
                    This will permanently delete <span className="font-bold">{selectedSupplier}</span> products 
                    from the Supplier Products area. You will need to re-sync to get these products back.
                  </p>
                </div>
              </div>
            </div>
            
            {/* Stats Info */}
            <div className="bg-gray-50 rounded-lg p-3">
              <p className="text-sm text-gray-600">
                <span className="font-medium">Products to clear:</span>{' '}
                {deleteAllDbCountLoading ? (
                  <span className="text-gray-500">Counting...</span>
                ) : deleteAllDbCount !== null ? (
                  <span className="font-bold text-red-600">{deleteAllDbCount.toLocaleString()} {selectedSupplier} products</span>
                ) : (
                  <span>All <span className="font-bold text-red-600">{selectedSupplier}</span> products</span>
                )}
              </p>
              {deleteAllDbCount === 0 && (
                <p className="text-xs text-green-600 mt-1">
                  No products found - nothing to delete
                </p>
              )}
            </div>
            
            {/* Password Input */}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Super Admin Password <span className="text-red-500">*</span>
              </label>
              <Input
                type="password"
                value={deleteAllDbPassword}
                onChange={(e) => setDeleteAllDbPassword(e.target.value)}
                placeholder="Enter your password to confirm"
                className="w-full"
                data-testid="delete-all-db-password"
              />
              <p className="text-xs text-gray-500 mt-1">
                Required for security verification
              </p>
            </div>
          </div>
          
          <DialogFooter className="gap-2">
            <Button
              variant="outline"
              onClick={() => {
                setShowDeleteAllDbDialog(false);
                setDeleteAllDbPassword('');
                setDeleteAllDbCount(null);
              }}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={handleDeleteAllFromDatabase}
              disabled={deleteAllDbLoading || !deleteAllDbPassword}
              data-testid="confirm-delete-all-db-btn"
            >
              {deleteAllDbLoading ? 'Deleting...' : 'Delete All From Database'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Quick Edit Modal - Extracted Component */}
      <QuickEditModal
        open={showQuickEditModal}
        onOpenChange={setShowQuickEditModal}
        product={quickEditProduct}
        form={quickEditForm}
        setForm={setQuickEditForm}
        loading={quickEditLoading}
        imageUploading={quickEditImageUploading}
        draggedImageIndex={draggedImageIndex}
        displayCodePreview={displayCodePreview}
        showCategorySuggestions={showCategorySuggestions}
        setShowCategorySuggestions={setShowCategorySuggestions}
        categorySuggestions={categorySuggestions}
        onSave={handleSaveQuickEdit}
        onImageUpload={handleQuickEditImageUpload}
        onDeleteImage={handleQuickEditDeleteImage}
        onSetPrimaryImage={handleSetPrimaryImage}
        onImageDragStart={handleImageDragStart}
        onImageDragEnd={handleImageDragEnd}
        onImageDragOver={handleImageDragOver}
        onImageDrop={handleImageDrop}
        onDisplayNameChange={handleDisplayNameChange}
        setPreviewImages={setPreviewImages}
      />

      {/* Sale/Labels Modal - Extracted Component */}
      <SaleLabelsModal
        open={showSaleLabelsModal}
        onOpenChange={setShowSaleLabelsModal}
        product={saleLabelsProduct}
        form={saleLabelsForm}
        setForm={setSaleLabelsForm}
        loading={saleLabelsLoading}
        onSave={handleSaveSaleLabels}
        dbLabels={dbLabels}
        getLabelStyle={getLabelStyle}
        onTogglePresetLabel={(label) => {
          const newLabels = saleLabelsForm.labels.includes(label)
            ? saleLabelsForm.labels.filter(l => l !== label)
            : [...saleLabelsForm.labels, label];
          setSaleLabelsForm(prev => ({ ...prev, labels: newLabels }));
        }}
        onAddCustomLabel={() => {
          const newLabel = saleLabelsForm.newCustomLabel?.trim();
          if (newLabel && !saleLabelsForm.custom_labels.includes(newLabel)) {
            setSaleLabelsForm(prev => ({
              ...prev,
              custom_labels: [...prev.custom_labels, newLabel],
              newCustomLabel: ''
            }));
          }
        }}
        onRemoveCustomLabel={(label) => {
          setSaleLabelsForm(prev => ({
            ...prev,
            custom_labels: prev.custom_labels.filter(l => l !== label)
          }));
        }}
        onWasMarkupChange={handleWasMarkupChange}
        onWasPriceChange={handleWasPriceChange}
        calculateSavings={calculateSavings}
        calculateProfit={calculateProfit}
      />

      {/* Save Results Dialog — 3 Aug 2026
          Replaces the old Force Save per-product tracker. Auto-opens when
          any product fails during the unified Save; also reachable via the
          "View N failed" link inside the amber save-status banner. Lists
          each failed SKU with the exact reason so the owner can pinpoint
          what to fix instead of blindly re-saving. */}
      <Dialog open={showSaveResults} onOpenChange={setShowSaveResults}>
        <DialogContent className="max-w-2xl max-h-[80vh] overflow-y-auto" data-testid="save-results-dialog">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <AlertCircle className="w-5 h-5 text-amber-600" />
              Save Results
            </DialogTitle>
            <DialogDescription>
              {lastSaveResult && (
                <>
                  <span className="text-emerald-700 font-semibold">{lastSaveResult.success}</span> saved,{' '}
                  <span className="text-red-700 font-semibold">{lastSaveResult.failed}</span> failed
                  {' '}out of {lastSaveResult.total}.
                </>
              )}
            </DialogDescription>
          </DialogHeader>

          {lastSaveResult?.failed_items?.length > 0 ? (
            <div className="border border-red-200 rounded-lg overflow-hidden bg-red-50/40">
              <div className="max-h-[50vh] overflow-y-auto">
                <table className="w-full text-sm">
                  <thead className="bg-red-100 text-red-900 text-xs uppercase tracking-wide sticky top-0">
                    <tr>
                      <th className="text-left px-3 py-2 font-semibold">Product</th>
                      <th className="text-left px-3 py-2 font-semibold w-32">ID</th>
                      <th className="text-left px-3 py-2 font-semibold">Reason</th>
                    </tr>
                  </thead>
                  <tbody>
                    {lastSaveResult.failed_items.map((item, idx) => (
                      <tr key={idx} className="border-t border-red-100 hover:bg-red-50" data-testid={`save-results-row-${idx}`}>
                        <td className="px-3 py-2 font-medium text-slate-900">{item.product_name || '—'}</td>
                        <td className="px-3 py-2 font-mono text-xs text-slate-600">{item.id}</td>
                        <td className="px-3 py-2 text-red-800">{item.reason || 'Unknown error'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ) : (
            <div className="p-6 text-center text-emerald-700">
              <CheckCircle className="w-10 h-10 mx-auto mb-2" />
              <p className="text-sm font-semibold">Everything saved successfully.</p>
            </div>
          )}

          <DialogFooter className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              onClick={() => setShowSaveResults(false)}
              data-testid="save-results-close-btn"
            >
              Close
            </Button>
            {lastSaveResult?.failed_items?.length > 0 && (
              <>
                <Button
                  variant="outline"
                  className="border-red-300 text-red-700 hover:bg-red-50"
                  onClick={() => {
                    // Copy failure summary to clipboard so the owner can paste
                    // it into a ticket / message.
                    const lines = lastSaveResult.failed_items.map(
                      it => `${it.product_name} (${it.id_field}: ${it.id}) — ${it.reason || 'unknown'}`
                    );
                    const summary = `Save Results: ${lastSaveResult.success} saved, ${lastSaveResult.failed} failed of ${lastSaveResult.total}\n\n${lines.join('\n')}`;
                    navigator.clipboard.writeText(summary);
                    toast.success('Failure summary copied to clipboard');
                  }}
                  data-testid="save-results-copy-btn"
                >
                  Copy summary
                </Button>
                <Button
                  className="bg-emerald-600 hover:bg-emerald-700 text-white"
                  disabled={bulkCategoryLoading}
                  onClick={async () => {
                    // 3 Aug 2026 — one-click "Re-save just the failed
                    // ones". Reuses the current UI state's payload and
                    // hits the same code path via restrictToIds. The
                    // handler rebuilds lastSaveResult with the new
                    // outcome, so this dialog updates automatically.
                    const failedIds = new Set(
                      (lastSaveResult.failed_items || [])
                        .map(it => it.id)
                        .filter(Boolean)
                    );
                    if (failedIds.size === 0) {
                      toast.error('No failed items to re-save');
                      return;
                    }
                    setShowSaveResults(false);
                    await handleBulkCategoryUpdate(bulkCategoryMode, failedIds);
                  }}
                  data-testid="save-results-resave-failed-btn"
                >
                  {bulkCategoryLoading ? (
                    <>
                      <RefreshCw className="w-4 h-4 mr-2 animate-spin" />
                      Re-saving...
                    </>
                  ) : (
                    <>Re-save {lastSaveResult.failed_items.length} failed</>
                  )}
                </Button>
              </>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Bulk Sale/Labels Modal - Extracted Component */}
      <BulkSaleModal
        open={showBulkSaleModal}
        onOpenChange={setShowBulkSaleModal}
        selectedProducts={selectedProducts}
        products={products}
        getProductKey={getProductKey}
        form={bulkSaleForm}
        setForm={setBulkSaleForm}
        loading={bulkSaleLoading}
        onApply={handleBulkSaleLabels}
      />


      {/* Options Manager Modal - Synced with Navigation & Structure */}
      <ManageOptionsModal
        isOpen={showOptionsManager}
        onClose={() => setShowOptionsManager(false)}
        refreshOptions={refreshOptions}
        categoryGroups={categoryGroups}
        selectedProductGroup={selectedProductGroup}
        setSelectedProductGroup={setSelectedProductGroup}
        userRole={userRole}
      />

      {/* Canopy Stock Update Modal - Extracted Component */}
      <CanopyStockModal
        open={showCanopyStockModal}
        onOpenChange={setShowCanopyStockModal}
        canopyStockStep={canopyStockStep}
        setCanopyStockStep={setCanopyStockStep}
        canopyStockText={canopyStockText}
        setCanopyStockText={setCanopyStockText}
        canopyStockLoading={canopyStockLoading}
        setCanopyStockLoading={setCanopyStockLoading}
        canopyStockPreview={canopyStockPreview}
        setCanopyStockPreview={setCanopyStockPreview}
        api={api}
        fetchProducts={fetchProducts}
      />

      {/* Delete-Supplier-Entirely modal — Super Admin only. Removes a
          supplier's rows from every collection (supplier_products, tiles,
          products, sync_staging, sync_progress, scrape_progress, custom_mappings,
          suppliers) via /api/supplier-sync/suppliers/delete-entirely.
          Requires typing the supplier name AND a Super Admin password. */}
      {deleteSupplierState && (
        <div className="fixed inset-0 z-[100] bg-black/50 flex items-center justify-center p-4" data-testid="delete-supplier-modal">
          <div className="bg-white rounded-xl shadow-2xl w-full max-w-lg p-6">
            {deleteSupplierState.result ? (
              <>
                <div className="flex items-center gap-2 text-emerald-600 font-semibold text-lg">
                  <CheckCircle className="w-5 h-5" />
                  Supplier removed
                </div>
                <p className="text-sm text-gray-700 mt-2">{deleteSupplierState.result.message}</p>
                <div className="mt-3 rounded-lg bg-gray-50 p-3 text-xs text-gray-700 space-y-0.5">
                  {Object.entries(deleteSupplierState.result.breakdown || {}).map(([k, v]) => (
                    <div key={k} className="flex justify-between">
                      <span className="text-gray-500">{k}</span>
                      <span className={`font-mono ${v > 0 ? 'text-red-600 font-semibold' : 'text-gray-400'}`}>{v}</span>
                    </div>
                  ))}
                </div>
                <div className="mt-4 flex justify-end">
                  <Button onClick={() => setDeleteSupplierState(null)} data-testid="delete-supplier-close">
                    Close
                  </Button>
                </div>
              </>
            ) : (
              <>
                <div className="flex items-center gap-2 text-red-600 font-semibold text-lg">
                  <AlertTriangle className="w-5 h-5" />
                  Delete supplier &quot;{deleteSupplierState.name}&quot; entirely
                </div>
                <p className="text-xs text-red-600 mt-1">
                  This removes every row across products, supplier_products, tiles, sync data, mappings, and the supplier itself. <b>Cannot be undone.</b>
                </p>

                {/* Blast-radius preview */}
                <div className="mt-3 rounded-lg bg-red-50 border border-red-200 p-3 text-xs text-red-900 space-y-0.5" data-testid="delete-supplier-impact">
                  {deleteSupplierState.loading && !deleteSupplierState.impact ? (
                    <div className="text-red-500 italic">Counting impact…</div>
                  ) : deleteSupplierState.impact ? (
                    <>
                      <div className="font-semibold mb-1">Records that will be removed:</div>
                      {Object.entries(deleteSupplierState.impact).filter(([k]) => k !== 'supplier').map(([k, v]) => (
                        <div key={k} className="flex justify-between">
                          <span>{k}</span>
                          <span className={`font-mono ${v > 0 ? 'text-red-700 font-semibold' : 'text-red-400'}`}>{v}</span>
                        </div>
                      ))}
                    </>
                  ) : (
                    <div className="text-red-500 italic">Failed to load impact preview.</div>
                  )}
                </div>

                {/* Name-confirmation */}
                <label className="block text-xs font-semibold text-gray-700 mt-4">
                  Type the supplier name to confirm
                </label>
                <Input
                  value={deleteSupplierState.confirmName}
                  onChange={(e) => setDeleteSupplierState(prev => ({ ...prev, confirmName: e.target.value }))}
                  placeholder={deleteSupplierState.name}
                  className="mt-1"
                  data-testid="delete-supplier-name-input"
                />
                {deleteSupplierState.confirmName && deleteSupplierState.confirmName.trim().toLowerCase() !== (deleteSupplierState.name || '').trim().toLowerCase() && (
                  <p className="mt-1 text-[11px] text-red-600" data-testid="delete-supplier-name-mismatch">
                    Doesn&apos;t match — expected exactly <b>{deleteSupplierState.name}</b>
                  </p>
                )}

                {/* Password */}
                <label className="block text-xs font-semibold text-gray-700 mt-3">
                  Super Admin password
                </label>
                <Input
                  type="password"
                  value={deleteSupplierState.password}
                  onChange={(e) => setDeleteSupplierState(prev => ({ ...prev, password: e.target.value }))}
                  placeholder="Enter your Super Admin password"
                  className="mt-1"
                  data-testid="delete-supplier-password-input"
                />

                {(() => {
                  const nameOk = (deleteSupplierState.confirmName || '').trim().toLowerCase() === (deleteSupplierState.name || '').trim().toLowerCase();
                  const passwordOk = !!(deleteSupplierState.password || '').trim();
                  const missing = [];
                  if (!nameOk) missing.push('type the supplier name exactly');
                  if (!passwordOk) missing.push('enter your Super Admin password');
                  if (missing.length === 0) return null;
                  return (
                    <p className="mt-3 text-[11px] text-amber-700 bg-amber-50 border border-amber-200 rounded px-2 py-1" data-testid="delete-supplier-block-reason">
                      To enable <b>Delete Everything</b>, please {missing.join(' and ')}.
                    </p>
                  );
                })()}

                <div className="mt-5 flex items-center justify-end gap-2">
                  <Button
                    variant="outline"
                    onClick={() => setDeleteSupplierState(null)}
                    disabled={deleteSupplierState.loading}
                    data-testid="delete-supplier-cancel"
                  >
                    Cancel
                  </Button>
                  <Button
                    className="bg-red-600 hover:bg-red-700 text-white"
                    onClick={confirmDeleteSupplierEntirely}
                    disabled={
                      deleteSupplierState.loading
                      || !(deleteSupplierState.password || '').trim()
                      || (deleteSupplierState.confirmName || '').trim().toLowerCase() !== (deleteSupplierState.name || '').trim().toLowerCase()
                    }
                    data-testid="delete-supplier-confirm"
                  >
                    {deleteSupplierState.loading ? (
                      <><Loader2 className="w-4 h-4 mr-2 animate-spin" />Deleting…</>
                    ) : (
                      <><Trash2 className="w-4 h-4 mr-2" />Delete Everything</>
                    )}
                  </Button>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {/* Product Images QA panel — replaces the deleted
          /admin/supplier-images/:supplier page. Opens as a full-screen
          overlay in-place so admins never leave Supplier Products. */}
      {imagesPanelState && (
        <ProductImagesGridPanel
          supplier={imagesPanelState.supplier}
          initialSeriesFilter={imagesPanelState.initialSeriesFilter}
          initialSkuFilter={imagesPanelState.initialSkuFilter}
          onClose={() => { setImagesPanelState(null); fetchProducts(); }}
        />
      )}

      {/* Name Sanity Drawer — merged from the standalone /admin/product-name-sanity page.
          If products are selected on the parent list, we send those SKUs so the drawer
          shows ONLY that selection (even non-flagged ones). Otherwise it runs a global scan. */}
      <NameSanityDrawer
        open={showNameSanity}
        onClose={() => setShowNameSanity(false)}
        defaultSupplier={selectedSupplier && selectedSupplier !== 'all' ? selectedSupplier : ''}
        knownSuppliers={SUPPLIERS.filter(s => s.id !== 'all').map(s => ({ name: s.id }))}
        selectedSkus={
          showNameSanity && selectedProducts.size > 0
            ? Array.from(selectedProducts).map(k => (k.includes('|||') ? k.split('|||')[1] : k)).filter(Boolean)
            : null
        }
        onRenamed={() => { fetchProducts(); fetchStats(); }}
      />

      {/* Custom Mappings Modal - Extracted Component */}
      <CustomMappingsModal
        open={showCustomMappingsModal}
        onOpenChange={setShowCustomMappingsModal}
        customMappings={customMappings}
        customMappingsLoading={customMappingsLoading}
        customMappingsSearch={customMappingsSearch}
        setCustomMappingsSearch={setCustomMappingsSearch}
        customMappingsFilter={customMappingsFilter}
        setCustomMappingsFilter={setCustomMappingsFilter}
        customMappingsBySupplier={customMappingsBySupplier}
        filteredCustomMappings={filteredCustomMappings}
        editingMapping={editingMapping}
        setEditingMapping={setEditingMapping}
        fetchCustomMappings={fetchCustomMappings}
        updateCustomMapping={updateCustomMapping}
        deleteCustomMapping={deleteCustomMapping}
        SUPPLIERS={SUPPLIERS}
      />

      {/* Tier Pricing Modal - Extracted Component */}
      <TierPricingModal
        open={showTierPricingModal}
        onOpenChange={setShowTierPricingModal}
        selectedProducts={selectedProducts}
        pricingSizeFilter={pricingSizeFilter}
        tierPricingConfig={tierPricingConfig}
        setTierPricingConfig={setTierPricingConfig}
        tierPricingSaving={tierPricingSaving}
        onSave={saveTierPricingConfig}
        getProductsFilteredBySize={getProductsFilteredBySize}
        getSelectedProductsPricing={getSelectedProductsPricing}
        getFilterDisplayLabel={getFilterDisplayLabel}
        overrideListPrice={bulkCategorySelections.list_price}
        overrideCostPrice={bulkCategorySelections.cost_price}
        tierProductScope={tierProductScope}
        selectedPricingUnit={(() => {
          // Look at the currently-selected products and figure out if we're
          // dealing with m² surface products or per-unit materials. This drives
          // the Half + Full Pallet labels: "m² per pallet" vs "bags per pallet".
          const selectedList = getProductsFilteredBySize(pricingSizeFilter).filter(p => {
            const key = `${p.supplier || 'unknown'}|||${p.sku || p.supplier_code || p._id}`;
            return selectedProducts.has(key);
          });
          if (selectedList.length === 0) return 'm2';
          const units = new Set(selectedList.map(p => {
            if (p.pricing_unit === 'unit') return 'unit';
            if (p.pricing_unit === 'm2') return 'm2';
            // Fallback: materials without explicit pricing_unit → treat as unit
            const grp = String(p.product_group || '').toLowerCase();
            const mainCat = String(p.main_category || '').toLowerCase();
            if (grp === 'materials' || mainCat === 'materials') return 'unit';
            return 'm2';
          }));
          if (units.size === 1) return [...units][0];
          return 'mixed';
        })()}
      />


      {/* Product Documents Modal */}
      <ProductDocumentsModal
        open={showDocumentsModal}
        onOpenChange={setShowDocumentsModal}
        products={documentsModalProducts}
        selectedProducts={selectedProducts}
      />

      {/* Quote Settings Modal */}
      <Dialog open={showQuoteSettingsModal} onOpenChange={setShowQuoteSettingsModal}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <FileSpreadsheet className="w-5 h-5 text-blue-600" />
              Quote Request Settings
            </DialogTitle>
            <DialogDescription>
              {selectedProducts.size > 0 
                ? `Configure quote settings for ${selectedProducts.size} selected product(s)`
                : 'Select products first to configure quote settings'
              }
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-4">
            {selectedProducts.size === 0 ? (
              <div className="bg-gray-100 rounded-lg p-6 text-center">
                <AlertTriangle className="w-12 h-12 text-gray-400 mx-auto mb-3" />
                <p className="text-gray-600 font-medium">No Products Selected</p>
                <p className="text-sm text-gray-500 mt-1">Please select products from the list first</p>
              </div>
            ) : (
              <>
                {/* Disable Quote Requests Option */}
                <div className="border rounded-lg p-4">
                  <label className="flex items-start gap-3 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={quoteSettings.quote_disabled}
                      onChange={(e) => setQuoteSettings(prev => ({
                        ...prev,
                        quote_disabled: e.target.checked,
                        custom_quote_threshold: e.target.checked ? null : prev.custom_quote_threshold
                      }))}
                      className="w-5 h-5 mt-0.5 rounded border-gray-300 text-red-600 focus:ring-red-500"
                    />
                    <div>
                      <span className="font-medium text-gray-900 block">Disable Quote Requests</span>
                      <span className="text-sm text-gray-500">
                        Always show "Add to Cart" regardless of quantity. No quote option.
                      </span>
                    </div>
                  </label>
                </div>

                {/* Custom Quote Threshold - only show if not disabled */}
                {!quoteSettings.quote_disabled && (
                  <div className="border rounded-lg p-4">
                    <label className="block">
                      <span className="font-medium text-gray-900">Custom Quote Threshold (Optional)</span>
                      <span className="text-sm text-gray-500 block mb-2">
                        Override the global threshold ({tierPricingConfig.custom_quote_threshold || 150}m²) for these products
                      </span>
                      <div className="flex items-center gap-2">
                        <input
                          type="number"
                          min="1"
                          value={quoteSettings.custom_quote_threshold || ''}
                          onChange={(e) => setQuoteSettings(prev => ({
                            ...prev,
                            custom_quote_threshold: e.target.value ? parseInt(e.target.value) : null
                          }))}
                          placeholder="Leave empty for global"
                          className="flex-1 px-3 py-2 border border-gray-300 rounded-lg text-sm"
                        />
                        <span className="text-gray-500 text-sm">m²</span>
                      </div>
                    </label>
                  </div>
                )}

                {/* Preview */}
                <div className="bg-blue-50 border border-blue-200 rounded-lg p-3">
                  <h4 className="text-xs font-semibold text-blue-800 mb-2">Preview for Selected Products:</h4>
                  {quoteSettings.quote_disabled ? (
                    <p className="text-sm text-blue-700">
                      "Add to Cart" button will always be shown, no quote requests
                    </p>
                  ) : (
                    <p className="text-sm text-blue-700">
                      "Request Quote" button will show for orders over {quoteSettings.custom_quote_threshold || tierPricingConfig.custom_quote_threshold || 150}m²
                    </p>
                  )}
                </div>
              </>
            )}
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setShowQuoteSettingsModal(false)}>
              Cancel
            </Button>
            <Button 
              onClick={saveQuoteSettings}
              disabled={quoteSaving || selectedProducts.size === 0}
              className={quoteSettings.quote_disabled ? "bg-red-600 hover:bg-red-700" : "bg-blue-600 hover:bg-blue-700"}
            >
              {quoteSaving ? <RefreshCw className="w-4 h-4 mr-2 animate-spin" /> : <Save className="w-4 h-4 mr-2" />}
              {quoteSettings.quote_disabled 
                ? `Disable Quotes for ${selectedProducts.size} Products`
                : `Save for ${selectedProducts.size} Products`
              }
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Pricing Unit Settings Modal */}
      <Dialog open={showPricingUnitModal} onOpenChange={(open) => {
        setShowPricingUnitModal(open);
        if (!open) setPricingUnitTargetProducts(new Set());
      }}>
        <DialogContent className="max-w-md max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Package className="w-5 h-5 text-purple-600" />
              Pricing Unit Settings
            </DialogTitle>
            <DialogDescription>
              {selectedProducts.size > 0 
                ? (pricingUnitTargetProducts.size > 0
                    ? `Set pricing unit for ${pricingUnitTargetProducts.size} of ${selectedProducts.size} selected product(s)`
                    : `Set pricing unit for ${selectedProducts.size} selected product(s)`)
                : 'Select products first to configure pricing unit'
              }
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-4">
            {selectedProducts.size === 0 ? (
              <div className="bg-gray-100 rounded-lg p-6 text-center">
                <AlertTriangle className="w-12 h-12 text-gray-400 mx-auto mb-3" />
                <p className="text-gray-600 font-medium">No Products Selected</p>
                <p className="text-sm text-gray-500 mt-1">Please select products from the list first</p>
              </div>
            ) : (
              <>
                {/* Pricing Unit Selection */}
                <div className="border rounded-lg p-4">
                  <label className="block mb-3">
                    <span className="font-medium text-gray-900 block mb-2">Select Pricing Unit</span>
                    <div className="grid grid-cols-2 gap-3">
                      <button
                        type="button"
                        onClick={() => setPricingUnitSettings(prev => ({ ...prev, pricing_unit: 'm2' }))}
                        className={`p-4 rounded-lg border-2 text-center transition-all ${
                          pricingUnitSettings.pricing_unit === 'm2'
                            ? 'border-purple-500 bg-purple-50 text-purple-700'
                            : 'border-gray-200 hover:border-gray-300 text-gray-700'
                        }`}
                      >
                        <Layers className="w-6 h-6 mx-auto mb-2" />
                        <span className="font-semibold block">Per m²</span>
                        <span className="text-xs text-gray-500">Tiles, flooring</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => setPricingUnitSettings(prev => ({ ...prev, pricing_unit: 'unit' }))}
                        className={`p-4 rounded-lg border-2 text-center transition-all ${
                          pricingUnitSettings.pricing_unit === 'unit'
                            ? 'border-purple-500 bg-purple-50 text-purple-700'
                            : 'border-gray-200 hover:border-gray-300 text-gray-700'
                        }`}
                      >
                        <Package className="w-6 h-6 mx-auto mb-2" />
                        <span className="font-semibold block">Per Unit</span>
                        <span className="text-xs text-gray-500">Adhesive, grout, tools</span>
                      </button>
                    </div>
                  </label>
                </div>

                {/* Filter: Pick which product TYPE to apply to (m² / unit / not set) */}
                {(() => {
                  const selectedKeys = Array.from(selectedProducts);
                  const selectedList = products.filter(p => selectedKeys.includes(getProductKey(p)));
                  const m2List = selectedList.filter(p => p.pricing_unit === 'm2');
                  const unitList = selectedList.filter(p => p.pricing_unit === 'unit');
                  const noneList = selectedList.filter(p => !p.pricing_unit);
                  // Detect current filter mode
                  const targetSize = pricingUnitTargetProducts.size;
                  const allMode = targetSize === 0;
                  const m2Mode = !allMode && m2List.length > 0 && targetSize === m2List.length &&
                    m2List.every(p => pricingUnitTargetProducts.has(getProductKey(p)));
                  const unitMode = !allMode && unitList.length > 0 && targetSize === unitList.length &&
                    unitList.every(p => pricingUnitTargetProducts.has(getProductKey(p)));
                  const noneMode = !allMode && noneList.length > 0 && targetSize === noneList.length &&
                    noneList.every(p => pricingUnitTargetProducts.has(getProductKey(p)));
                  
                  const setFilterToList = (list) => {
                    setPricingUnitTargetProducts(new Set(list.map(p => getProductKey(p))));
                  };
                  
                  const chipCls = (active) => 
                    `text-[11px] px-2.5 py-1 rounded-full border transition-all ${
                      active 
                        ? 'bg-purple-600 text-white border-purple-600' 
                        : 'bg-white text-gray-700 border-gray-300 hover:border-purple-400'
                    }`;
                  
                  return (
                    <div className="border rounded-lg p-4">
                      <div className="flex items-center justify-between mb-2">
                        <span className="font-medium text-gray-900 text-sm">Filter by current type</span>
                        <span className="text-[10px] text-gray-500">
                          {allMode
                            ? `All ${selectedList.length} products`
                            : `${targetSize} of ${selectedList.length} selected`}
                        </span>
                      </div>
                      <div className="flex flex-wrap gap-1.5 mb-3">
                        <button
                          type="button"
                          data-testid="pricing-unit-filter-all"
                          onClick={() => setPricingUnitTargetProducts(new Set())}
                          className={chipCls(allMode)}
                        >
                          All ({selectedList.length})
                        </button>
                        <button
                          type="button"
                          data-testid="pricing-unit-filter-m2"
                          disabled={m2List.length === 0}
                          onClick={() => setFilterToList(m2List)}
                          className={`${chipCls(m2Mode)} ${m2List.length === 0 ? 'opacity-40 cursor-not-allowed' : ''}`}
                        >
                          Per m² ({m2List.length})
                        </button>
                        <button
                          type="button"
                          data-testid="pricing-unit-filter-unit"
                          disabled={unitList.length === 0}
                          onClick={() => setFilterToList(unitList)}
                          className={`${chipCls(unitMode)} ${unitList.length === 0 ? 'opacity-40 cursor-not-allowed' : ''}`}
                        >
                          Per Unit ({unitList.length})
                        </button>
                        {noneList.length > 0 && (
                          <button
                            type="button"
                            data-testid="pricing-unit-filter-none"
                            onClick={() => setFilterToList(noneList)}
                            className={chipCls(noneMode)}
                          >
                            Not Set ({noneList.length})
                          </button>
                        )}
                      </div>
                      
                      {/* Per-product checklist */}
                      <div className="max-h-44 overflow-y-auto border border-gray-200 rounded-lg bg-white">
                        {selectedList.map(p => {
                          const key = getProductKey(p);
                          const isChecked = allMode || pricingUnitTargetProducts.has(key);
                          const name = p.product_name || p.name || p.display_name || p.sku;
                          const currentUnit = p.pricing_unit;
                          const badgeCls = currentUnit === 'm2'
                            ? 'bg-blue-100 text-blue-700'
                            : currentUnit === 'unit'
                              ? 'bg-green-100 text-green-700'
                              : 'bg-gray-100 text-gray-500';
                          const badgeLabel = currentUnit === 'm2' ? 'm²' : currentUnit === 'unit' ? 'unit' : 'none';
                          return (
                            <label
                              key={key}
                              data-testid={`pricing-unit-row-${key}`}
                              className={`flex items-center gap-2 px-3 py-1.5 text-xs border-b border-gray-50 last:border-0 cursor-pointer hover:bg-purple-50 ${isChecked && !allMode ? 'bg-purple-50' : ''}`}
                            >
                              <input
                                type="checkbox"
                                checked={isChecked}
                                onChange={() => {
                                  setPricingUnitTargetProducts(prev => {
                                    const next = new Set(prev);
                                    if (prev.size === 0) {
                                      // First click in "All" mode: select all, then deselect this one
                                      selectedList.forEach(sp => next.add(getProductKey(sp)));
                                      next.delete(key);
                                    } else if (next.has(key)) {
                                      next.delete(key);
                                    } else {
                                      next.add(key);
                                    }
                                    return next;
                                  });
                                }}
                                className="w-3.5 h-3.5 rounded border-gray-300 text-purple-600 focus:ring-purple-500"
                              />
                              <span className="flex-1 truncate text-gray-700">{name}</span>
                              <span className={`text-[10px] px-1.5 py-0.5 rounded ${badgeCls}`}>
                                {badgeLabel}
                              </span>
                            </label>
                          );
                        })}
                      </div>
                    </div>
                  );
                })()}

                {/* Unit Price - only show if per-unit selected */}
                {pricingUnitSettings.pricing_unit === 'unit' && (
                  <div className="border rounded-lg p-4">
                    <label className="block">
                      <span className="font-medium text-gray-900">Unit Price (Optional)</span>
                      <span className="text-sm text-gray-500 block mb-2">
                        Set a specific price per unit for these products
                      </span>
                      <div className="flex items-center gap-2">
                        <span className="text-gray-500">£</span>
                        <input
                          type="number"
                          min="0"
                          step="0.01"
                          value={pricingUnitSettings.unit_price}
                          onChange={(e) => setPricingUnitSettings(prev => ({
                            ...prev,
                            unit_price: e.target.value
                          }))}
                          placeholder="Leave empty to keep existing"
                          className="flex-1 px-3 py-2 border border-gray-300 rounded-lg text-sm"
                        />
                        <span className="text-gray-500 text-sm">/unit</span>
                      </div>
                    </label>
                  </div>
                )}

                {/* Preview */}
                <div className="bg-purple-50 border border-purple-200 rounded-lg p-3">
                  <h4 className="text-xs font-semibold text-purple-800 mb-2">
                    Preview ({pricingUnitTargetProducts.size > 0 ? pricingUnitTargetProducts.size : selectedProducts.size} product{(pricingUnitTargetProducts.size > 0 ? pricingUnitTargetProducts.size : selectedProducts.size) === 1 ? '' : 's'}):
                  </h4>
                  <p className="text-sm text-purple-700">
                    {pricingUnitSettings.pricing_unit === 'unit' 
                      ? 'Products will be priced per unit (e.g., £5.99/unit)'
                      : 'Products will be priced per square metre (e.g., £29.99/m²)'
                    }
                  </p>
                </div>
              </>
            )}
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setShowPricingUnitModal(false)}>
              Cancel
            </Button>
            <Button 
              onClick={savePricingUnitSettings}
              disabled={pricingUnitSaving || selectedProducts.size === 0}
              data-testid="pricing-unit-save-btn"
              className="bg-purple-600 hover:bg-purple-700"
            >
              {pricingUnitSaving ? <RefreshCw className="w-4 h-4 mr-2 animate-spin" /> : <Save className="w-4 h-4 mr-2" />}
              Save for {pricingUnitTargetProducts.size > 0 ? pricingUnitTargetProducts.size : selectedProducts.size} Products
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Batch Series Description Modal */}
      <Dialog open={showBatchSeriesModal} onOpenChange={setShowBatchSeriesModal}>
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <div className="w-8 h-8 bg-gradient-to-r from-emerald-500 to-teal-500 rounded-lg flex items-center justify-center">
                <Zap className="w-5 h-5 text-white" />
              </div>
              Quick Generate All Series Descriptions
            </DialogTitle>
            <DialogDescription>
              Auto-detect series from your selection and generate unified descriptions for each
            </DialogDescription>
          </DialogHeader>

          {/* Step 1: Detecting Series */}
          {detectingSeriesPending && (
            <div className="py-8 flex flex-col items-center justify-center gap-3">
              <div className="animate-spin h-8 w-8 border-4 border-emerald-500 border-t-transparent rounded-full"></div>
              <p className="text-sm text-gray-600">Analyzing {selectedProducts.size} products...</p>
            </div>
          )}

          {/* Step 2: Show Detected Series */}
          {detectedSeries && !batchDescriptionResults && !detectingSeriesPending && (
            <div className="space-y-4">
              {/* 24 May 2026 — Unified vs Per-Series toggle. Default is
                  UNIFIED because that matches the modal subtitle
                  "generate unified descriptions" and is the most
                  common admin intent ("one La Dolce collection"). */}
              <div className="bg-blue-50 border border-blue-200 rounded-lg p-3" data-testid="batch-unified-mode-toggle">
                <div className="flex items-start gap-3">
                  <div className="flex flex-col gap-1.5 pt-0.5">
                    <label className="flex items-center gap-2 cursor-pointer">
                      <input
                        type="radio"
                        name="batch-unified-mode"
                        checked={batchUnifiedMode}
                        onChange={() => setBatchUnifiedMode(true)}
                        data-testid="batch-mode-unified-radio"
                        className="text-blue-600 focus:ring-blue-500"
                      />
                      <span className="text-sm font-semibold text-blue-900">
                        One unified description for the whole collection
                      </span>
                    </label>
                    <label className="flex items-center gap-2 cursor-pointer">
                      <input
                        type="radio"
                        name="batch-unified-mode"
                        checked={!batchUnifiedMode}
                        onChange={() => setBatchUnifiedMode(false)}
                        data-testid="batch-mode-per-series-radio"
                        className="text-blue-600 focus:ring-blue-500"
                      />
                      <span className="text-sm text-blue-900">
                        Separate description per detected series ({detectedSeries.series_count} total)
                      </span>
                    </label>
                  </div>
                </div>
                {batchUnifiedMode && (
                  <div className="mt-3 pt-3 border-t border-blue-200">
                    <label className="text-[11px] uppercase tracking-wider text-blue-700 font-bold block mb-1">
                      Collection name (used in the description)
                    </label>
                    <input
                      type="text"
                      value={batchUnifiedCollectionName}
                      onChange={(e) => setBatchUnifiedCollectionName(e.target.value)}
                      placeholder="e.g. La Dolce"
                      data-testid="batch-unified-collection-name-input"
                      className="w-full px-3 py-2 text-sm font-medium border border-blue-300 rounded focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
                    />
                    <p className="text-[11px] text-blue-700 mt-1 leading-snug">
                      All {selectedProducts.size} selected products will be combined into one description
                      using this name. Pre-filled from the longest common prefix across your selection.
                    </p>
                  </div>
                )}
              </div>

              <div className="bg-emerald-50 border border-emerald-200 rounded-lg p-3">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-sm font-semibold text-emerald-800">
                    Found {detectedSeries.series_count} series in {detectedSeries.total_products} products
                  </span>
                  <button
                    onClick={() => {
                      if (selectedSeriesForBatch.size === detectedSeries.series.length) {
                        setSelectedSeriesForBatch(new Set());
                      } else {
                        setSelectedSeriesForBatch(new Set(detectedSeries.series.map(s => s.series_name)));
                      }
                    }}
                    className="text-xs text-emerald-600 hover:text-emerald-800"
                  >
                    {selectedSeriesForBatch.size === detectedSeries.series.length ? 'Deselect All' : 'Select All'}
                  </button>
                </div>
                {/* 24 May 2026 — admin hint about the new inline rename
                    capability. Auto-detection sometimes picks the
                    supplier's original series name ("Pietra Ligure")
                    when the admin has renamed only `display_name` to
                    something else ("La Dolce"). Letting the admin edit
                    the detected name inline is the definitive fix —
                    no more guessing which DB field to pull from. */}
                {!batchUnifiedMode && (
                  <p className="text-[11px] text-emerald-700 mb-2 leading-snug">
                    ✏️ <strong>Tip:</strong> tap any series name below to rename it before generating
                    (e.g. supplier name &ldquo;Pietra Ligure&rdquo; → your collection name &ldquo;La Dolce&rdquo;).
                    Renames apply only to this generation — they don&apos;t change product data.
                  </p>
                )}
                {batchUnifiedMode && (
                  <p className="text-[11px] text-emerald-700 mb-2 leading-snug">
                    Unified mode is ON — these {detectedSeries.series_count} groups will all be
                    combined into ONE description named &ldquo;{(batchUnifiedCollectionName || '').trim() || 'Collection'}&rdquo;
                    (switch to per-series mode above to edit them individually).
                  </p>
                )}

                <div className="space-y-1.5 max-h-64 overflow-y-auto">
                  {detectedSeries.series.map((series) => {
                    const originalName = series.series_name;
                    const editedName = (seriesNameOverrides[originalName] ?? originalName);
                    const isEdited = editedName !== originalName;
                    return (
                    <div
                      key={originalName}
                      className={`flex items-center justify-between gap-2 p-2 rounded-lg transition-colors ${
                        selectedSeriesForBatch.has(originalName)
                          ? 'bg-emerald-100 border border-emerald-300'
                          : 'bg-white border border-gray-200 hover:border-emerald-200'
                      }`}
                    >
                      <div className="flex items-center gap-2 flex-1 min-w-0">
                        <input
                          type="checkbox"
                          checked={selectedSeriesForBatch.has(originalName)}
                          onChange={() => toggleBatchSeriesSelection(originalName)}
                          className="rounded border-emerald-400 text-emerald-600 focus:ring-emerald-500 flex-shrink-0"
                        />
                        <div className="min-w-0 flex-1">
                          <input
                            type="text"
                            value={editedName}
                            onChange={(e) => {
                              const newName = e.target.value;
                              setSeriesNameOverrides(prev => {
                                const next = { ...prev };
                                if (newName === originalName || newName === '') {
                                  delete next[originalName];
                                } else {
                                  next[originalName] = newName;
                                }
                                return next;
                              });
                            }}
                            onClick={(e) => e.stopPropagation()}
                            className={`text-sm font-medium bg-transparent border-b border-dashed w-full focus:outline-none focus:border-emerald-500 ${
                              isEdited ? 'text-emerald-700 border-emerald-400' : 'text-gray-800 border-gray-300'
                            }`}
                            placeholder="Series name"
                            data-testid={`batch-series-name-input-${originalName.replace(/\s+/g, '-').toLowerCase()}`}
                            title={isEdited ? `Original: ${originalName}` : 'Click to rename for this generation'}
                          />
                          <span className="text-xs text-gray-500">
                            ({series.product_count} products)
                            {isEdited && <span className="ml-1 text-emerald-600">· was &ldquo;{originalName}&rdquo;</span>}
                          </span>
                        </div>
                      </div>
                      <div className="flex gap-1 flex-shrink-0">
                        {series.colors.length > 0 && (
                          <span className="text-[10px] bg-pink-100 text-pink-700 px-1.5 py-0.5 rounded">
                            {series.colors.length} colors
                          </span>
                        )}
                        {series.sizes.length > 0 && (
                          <span className="text-[10px] bg-blue-100 text-blue-700 px-1.5 py-0.5 rounded">
                            {series.sizes.length} sizes
                          </span>
                        )}
                        {series.finishes.length > 0 && (
                          <span className="text-[10px] bg-purple-100 text-purple-700 px-1.5 py-0.5 rounded">
                            {series.finishes.length} finishes
                          </span>
                        )}
                      </div>
                    </div>
                    );
                  })}
                </div>
              </div>

              {/* Length Selector */}
              <div className="flex items-center gap-2">
                <span className="text-sm text-gray-600">Description length:</span>
                <div className="flex gap-1 bg-gray-100 rounded-lg p-0.5">
                  {['brief', 'standard', 'detailed'].map((len) => (
                    <button
                      key={len}
                      onClick={() => setBatchDescriptionLength(len)}
                      className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
                        batchDescriptionLength === len
                          ? 'bg-emerald-500 text-white'
                          : 'text-gray-600 hover:bg-gray-200'
                      }`}
                    >
                      {len.charAt(0).toUpperCase() + len.slice(1)}
                    </button>
                  ))}
                </div>
              </div>

              {/* Generate Button */}
              <button
                onClick={handleGenerateBatchDescriptions}
                disabled={selectedSeriesForBatch.size === 0 || generatingBatchDescriptions || (batchUnifiedMode && !(batchUnifiedCollectionName || '').trim())}
                className="w-full bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-700 hover:to-teal-700 disabled:from-gray-300 disabled:to-gray-400 text-white px-4 py-3 rounded-lg font-semibold flex items-center justify-center gap-2"
                data-testid="generate-batch-descriptions-btn"
              >
                {generatingBatchDescriptions ? (
                  <>
                    <div className="animate-spin h-5 w-5 border-2 border-white border-t-transparent rounded-full"></div>
                    {batchUnifiedMode
                      ? `Generating "${(batchUnifiedCollectionName || '').trim() || 'Collection'}" description...`
                      : `Generating ${selectedSeriesForBatch.size} descriptions...`}
                  </>
                ) : (
                  <>
                    <Sparkles className="w-5 h-5" />
                    {batchUnifiedMode
                      ? `Generate 1 unified "${(batchUnifiedCollectionName || '').trim() || 'Collection'}" description`
                      : `Generate ${selectedSeriesForBatch.size} Descriptions`}
                  </>
                )}
              </button>
            </div>
          )}

          {/* Step 3: Show Results */}
          {batchDescriptionResults && (
            <div className="space-y-4">
              <div className="bg-green-50 border border-green-200 rounded-lg p-3">
                <div className="flex items-center gap-2 text-green-800">
                  <CheckCircle className="w-5 h-5" />
                  <span className="font-semibold">Generated {batchDescriptionResults.series_count} descriptions!</span>
                </div>
              </div>

              <div className="space-y-2 max-h-80 overflow-y-auto">
                {batchDescriptionResults.results.map((result) => (
                  <div key={result.series_name} className="border border-gray-200 rounded-lg overflow-hidden">
                    <button
                      onClick={() => toggleResultExpanded(result.series_name)}
                      className="w-full flex items-center justify-between p-3 bg-gray-50 hover:bg-gray-100 transition-colors"
                    >
                      <div className="flex items-center gap-2">
                        {expandedSeriesResults.has(result.series_name) ? (
                          <ChevronDown className="w-4 h-4 text-gray-500" />
                        ) : (
                          <ChevronRight className="w-4 h-4 text-gray-500" />
                        )}
                        <span className="font-medium text-gray-800">{result.series_name}</span>
                        <span className="text-xs text-gray-500">({result.product_count} products)</span>
                      </div>
                      <div className="flex gap-1">
                        {result.aggregated_data.colors?.length > 0 && (
                          <span className="text-[10px] bg-pink-100 text-pink-700 px-1.5 py-0.5 rounded">
                            {result.aggregated_data.colors.length} colors
                          </span>
                        )}
                        {result.aggregated_data.sizes?.length > 0 && (
                          <span className="text-[10px] bg-blue-100 text-blue-700 px-1.5 py-0.5 rounded">
                            {result.aggregated_data.sizes.length} sizes
                          </span>
                        )}
                      </div>
                    </button>
                    
                    {expandedSeriesResults.has(result.series_name) && (
                      <div className="p-3 border-t border-gray-200 bg-white">
                        <p className="text-sm text-gray-700 leading-relaxed whitespace-pre-wrap mb-3">
                          {result.description}
                        </p>
                        <div className="flex gap-2">
                          <button
                            onClick={() => {
                              navigator.clipboard.writeText(result.description);
                              toast.success('Copied to clipboard!');
                            }}
                            className="flex-1 bg-gray-100 hover:bg-gray-200 text-gray-700 px-3 py-1.5 rounded-lg text-xs flex items-center justify-center gap-1"
                          >
                            <Copy className="w-3 h-3" />
                            Copy
                          </button>
                          <button
                            onClick={() => applyDescriptionToSeries(result)}
                            className="flex-1 bg-emerald-500 hover:bg-emerald-600 text-white px-3 py-1.5 rounded-lg text-xs font-medium flex items-center justify-center gap-1"
                          >
                            <CheckCircle className="w-3 h-3" />
                            Apply to {result.product_count} products
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                ))}
              </div>

              {/* Apply All Button */}
              <div className="flex gap-2 pt-2 border-t border-gray-200">
                <button
                  onClick={() => {
                    setBatchDescriptionResults(null);
                    setDetectedSeries(null);
                  }}
                  className="flex-1 bg-gray-100 hover:bg-gray-200 text-gray-700 px-4 py-2 rounded-lg font-medium"
                >
                  Start Over
                </button>
                <button
                  onClick={applyAllDescriptions}
                  className="flex-1 bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-700 hover:to-teal-700 text-white px-4 py-2 rounded-lg font-semibold flex items-center justify-center gap-2"
                  data-testid="apply-all-descriptions-btn"
                >
                  <CheckCircle className="w-4 h-4" />
                  Apply All Descriptions
                </button>
              </div>
              
              {/* Schedule Auto-Regeneration Option */}
              <div className="mt-3 pt-3 border-t border-gray-200">
                <button
                  onClick={trackSeriesFromBatchResults}
                  className="w-full bg-purple-50 hover:bg-purple-100 border border-purple-200 text-purple-700 px-4 py-2.5 rounded-lg font-medium flex items-center justify-center gap-2"
                  data-testid="schedule-auto-regen-btn"
                >
                  <Clock className="w-4 h-4" />
                  Schedule Auto-Regeneration for These Series
                </button>
                <p className="text-[10px] text-gray-500 text-center mt-1">
                  Descriptions will auto-update when new products are added to these series
                </p>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* Auto-Regeneration Settings Modal */}
      <Dialog open={showAutoRegenModal} onOpenChange={setShowAutoRegenModal}>
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <div className="w-8 h-8 bg-gradient-to-r from-purple-500 to-indigo-500 rounded-lg flex items-center justify-center">
                <Clock className="w-5 h-5 text-white" />
              </div>
              Auto-Regeneration Settings
            </DialogTitle>
            <DialogDescription>
              Automatically regenerate descriptions when new products are added to tracked series
            </DialogDescription>
          </DialogHeader>

          {loadingAutoRegen ? (
            <div className="py-8 flex flex-col items-center justify-center gap-3">
              <div className="animate-spin h-8 w-8 border-4 border-purple-500 border-t-transparent rounded-full"></div>
              <p className="text-sm text-gray-600">Loading settings...</p>
            </div>
          ) : (
            <div className="space-y-6">
              {/* Global Settings */}
              <div className="bg-purple-50 border border-purple-200 rounded-lg p-4">
                <div className="flex items-center justify-between mb-4">
                  <div>
                    <h4 className="font-semibold text-purple-800">Auto-Regeneration</h4>
                    <p className="text-xs text-purple-600">Enable automatic description updates</p>
                  </div>
                  <label className="relative inline-flex items-center cursor-pointer">
                    <input
                      type="checkbox"
                      checked={autoRegenSettings?.enabled || false}
                      onChange={(e) => setAutoRegenSettings(prev => ({ ...prev, enabled: e.target.checked }))}
                      className="sr-only peer"
                    />
                    <div className="w-11 h-6 bg-gray-200 peer-focus:outline-none peer-focus:ring-4 peer-focus:ring-purple-300 rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-purple-600"></div>
                  </label>
                </div>

                {autoRegenSettings?.enabled && (
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <label className="text-xs text-purple-700 font-medium">Default Length</label>
                      <select
                        value={autoRegenSettings?.default_length || 'standard'}
                        onChange={(e) => setAutoRegenSettings(prev => ({ ...prev, default_length: e.target.value }))}
                        className="w-full mt-1 px-3 py-2 border border-purple-200 rounded-lg text-sm focus:ring-2 focus:ring-purple-500"
                      >
                        <option value="brief">Brief</option>
                        <option value="standard">Standard</option>
                        <option value="detailed">Detailed</option>
                      </select>
                    </div>
                    <div>
                      <label className="text-xs text-purple-700 font-medium">Check Frequency</label>
                      <select
                        value={autoRegenSettings?.frequency_hours || 6}
                        onChange={(e) => setAutoRegenSettings(prev => ({ ...prev, frequency_hours: parseInt(e.target.value) }))}
                        className="w-full mt-1 px-3 py-2 border border-purple-200 rounded-lg text-sm focus:ring-2 focus:ring-purple-500"
                      >
                        <option value="1">Every hour</option>
                        <option value="6">Every 6 hours</option>
                        <option value="12">Every 12 hours</option>
                        <option value="24">Daily</option>
                      </select>
                    </div>
                    <div className="col-span-2">
                      <label className="text-xs text-purple-700 font-medium">Default SEO Keywords</label>
                      <input
                        type="text"
                        value={autoRegenSettings?.default_seo_keywords || ''}
                        onChange={(e) => setAutoRegenSettings(prev => ({ ...prev, default_seo_keywords: e.target.value }))}
                        placeholder="tiles, porcelain, interior design"
                        className="w-full mt-1 px-3 py-2 border border-purple-200 rounded-lg text-sm focus:ring-2 focus:ring-purple-500"
                      />
                    </div>
                  </div>
                )}

                <div className="mt-4 flex gap-2">
                  <button
                    onClick={saveAutoRegenSettings}
                    disabled={savingAutoRegenSettings}
                    className="flex-1 bg-purple-600 hover:bg-purple-700 disabled:bg-purple-300 text-white px-4 py-2 rounded-lg font-medium flex items-center justify-center gap-2"
                  >
                    {savingAutoRegenSettings ? (
                      <div className="animate-spin h-4 w-4 border-2 border-white border-t-transparent rounded-full"></div>
                    ) : (
                      <Save className="w-4 h-4" />
                    )}
                    Save Settings
                  </button>
                  {autoRegenSettings?.enabled && (
                    <button
                      onClick={runRegenerationNow}
                      className="bg-indigo-600 hover:bg-indigo-700 text-white px-4 py-2 rounded-lg font-medium flex items-center gap-2"
                    >
                      <RefreshCw className="w-4 h-4" />
                      Run Now
                    </button>
                  )}
                </div>

                {autoRegenSettings?.last_run && (
                  <p className="text-[10px] text-purple-600 mt-2">
                    Last run: {new Date(autoRegenSettings.last_run).toLocaleString()} 
                    ({autoRegenSettings.last_run_regenerated || 0} regenerated)
                  </p>
                )}
              </div>

              {/* Tracked Series */}
              <div>
                <div className="flex items-center justify-between mb-2">
                  <h4 className="font-semibold text-gray-800">Tracked Series ({trackedSeries.length})</h4>
                </div>
                
                {trackedSeries.length === 0 ? (
                  <div className="bg-gray-50 border border-gray-200 rounded-lg p-4 text-center">
                    <p className="text-sm text-gray-500">No series being tracked yet.</p>
                    <p className="text-xs text-gray-400 mt-1">Generate batch descriptions and click "Schedule Auto-Regeneration" to add series.</p>
                  </div>
                ) : (
                  <div className="space-y-1.5 max-h-48 overflow-y-auto">
                    {trackedSeries.map((series) => (
                      <div
                        key={series.series_name}
                        className="flex items-center justify-between p-2 bg-gray-50 rounded-lg"
                      >
                        <div className="flex items-center gap-2">
                          <span className="text-sm font-medium text-gray-800">{series.series_name}</span>
                          <span className="text-xs text-gray-500">({series.product_count} products)</span>
                          {series.last_generated && (
                            <span className="text-[10px] text-green-600 bg-green-50 px-1.5 py-0.5 rounded">
                              Generated {new Date(series.last_generated).toLocaleDateString()}
                            </span>
                          )}
                        </div>
                        <button
                          onClick={() => removeTrackedSeries(series.series_name)}
                          className="text-gray-400 hover:text-red-500"
                        >
                          <X className="w-4 h-4" />
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* Pending Regenerations */}
              {pendingRegenerations.length > 0 && (
                <div>
                  <div className="flex items-center gap-2 mb-2">
                    <AlertCircle className="w-4 h-4 text-amber-500" />
                    <h4 className="font-semibold text-amber-700">Pending Regenerations ({pendingRegenerations.length})</h4>
                  </div>
                  <div className="bg-amber-50 border border-amber-200 rounded-lg p-3">
                    <div className="space-y-1.5 max-h-32 overflow-y-auto">
                      {pendingRegenerations.map((series) => (
                        <div key={series.series_name} className="flex items-center justify-between">
                          <span className="text-sm text-amber-800">{series.series_name}</span>
                          <span className="text-xs text-amber-600">
                            +{series.new_products} new products
                          </span>
                        </div>
                      ))}
                    </div>
                    <p className="text-[10px] text-amber-600 mt-2">
                      These series have new products since last description generation
                    </p>
                  </div>
                </div>
              )}

              {/* Recent History */}
              {regenHistory.length > 0 && (
                <div>
                  <h4 className="font-semibold text-gray-800 mb-2">Recent Activity</h4>
                  <div className="space-y-1 max-h-32 overflow-y-auto">
                    {regenHistory.slice(-10).reverse().map((entry, idx) => (
                      <div key={idx} className="flex items-center gap-2 text-xs">
                        {entry.status === 'success' ? (
                          <CheckCircle className="w-3 h-3 text-green-500" />
                        ) : (
                          <XCircle className="w-3 h-3 text-red-500" />
                        )}
                        <span className="text-gray-600">{entry.series_name}</span>
                        <span className="text-gray-400">
                          {new Date(entry.timestamp).toLocaleString()}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* Floating Quick Actions Bar — appears when selectedProducts.size > 0 */}
      {selectedProducts.size > 0 && (
        <div
          className="fixed bottom-6 left-1/2 -translate-x-1/2 z-40 animate-in slide-in-from-bottom-6 fade-in duration-300"
          data-testid="quick-actions-bar"
        >
          <div className="flex items-center gap-2 bg-gray-900/95 backdrop-blur-md text-white px-3 py-2.5 rounded-xl shadow-2xl ring-1 ring-white/10 border border-white/5">
            {/* Counter */}
            <div className="flex items-center gap-2 pr-3 pl-1 border-r border-white/15">
              <div className="w-7 h-7 rounded-full bg-indigo-500 flex items-center justify-center text-xs font-bold shadow-md shadow-indigo-500/30">
                {selectedProducts.size}
              </div>
              <span className="text-[13px] font-medium text-white/90 whitespace-nowrap">
                product{selectedProducts.size === 1 ? '' : 's'} selected
              </span>
            </div>

            {/* Action buttons */}
            <button
              type="button"
              data-testid="qa-apply-sale"
              onClick={() => setShowBulkSaleModal(true)}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-rose-500/90 hover:bg-rose-500 transition-all text-[13px] font-medium shadow-md shadow-rose-500/20"
              title="Open Sale & Labels modal — set a sale price/percentage on all selected products"
            >
              <Tag className="w-3.5 h-3.5" />
              Apply Sale %
            </button>

            <button
              type="button"
              data-testid="qa-unpublish"
              onClick={unpublishSelectedFromWebsite}
              disabled={unpublishingFromWebsite}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-amber-500/90 hover:bg-amber-500 transition-all text-[13px] font-medium shadow-md shadow-amber-500/20 disabled:opacity-60 disabled:cursor-not-allowed"
              title="Remove selected products from the public storefront (sets show_on_website = false). They stay in the admin list."
            >
              {unpublishingFromWebsite ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <EyeOff className="w-3.5 h-3.5" />
              )}
              Mark Not For Sale
            </button>

            {/* Bulk cost / list price */}
            <button
              type="button"
              onClick={() => setShowBulkPriceModal(true)}
              className="px-2.5 py-1.5 rounded-lg bg-indigo-500/90 hover:bg-indigo-500 transition-all text-[13px] font-medium text-white shadow-md shadow-indigo-500/20"
              data-testid="qa-set-prices"
              title="Set cost and/or list price for all selected products"
            >
              £ Prices
            </button>

            {/* Bulk stock status — marks all selected In/Out of Stock immediately */}
            <select
              value=""
              onChange={(e) => { const v = e.target.value; if (v) handleBulkSetStock(v); }}
              className="px-2.5 py-1.5 rounded-lg bg-teal-500/90 hover:bg-teal-500 transition-all text-[13px] font-medium text-white cursor-pointer border-0 outline-none shadow-md shadow-teal-500/20 [&>option]:text-gray-900"
              data-testid="qa-stock-status"
              title="Mark all selected products In Stock / Out of Stock — updates the website immediately"
            >
              <option value="" disabled>Stock…</option>
              <option value="in_stock">In Stock</option>
              <option value="low_stock">Low Stock</option>
              <option value="out_of_stock">Out of Stock</option>
              <option value="always_in_stock">Always In Stock</option>
            </select>

            <button
              type="button"
              data-testid="qa-description"
              onClick={openBulkCategoryModal}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-emerald-500/90 hover:bg-emerald-500 transition-all text-[13px] font-medium shadow-md shadow-emerald-500/20"
              title="Open Bulk Category Editor — apply a description template, SEO keywords, and category settings to all selected"
            >
              <PenLine className="w-3.5 h-3.5" />
              Apply Description
            </button>

            <button
              type="button"
              data-testid="qa-change-supplier"
              onClick={openBulkEditModal}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-indigo-500/90 hover:bg-indigo-500 transition-all text-[13px] font-medium shadow-md shadow-indigo-500/20"
              title="Open Bulk Edit — change supplier, pricing and other fields on all selected"
            >
              <Building2 className="w-3.5 h-3.5" />
              Change Supplier
            </button>

            {/* Assign Category dropdown — sets product_group on all selected so they
                route to the right Manager. Sits next to Change Supplier for parity. */}
            <div className="relative group">
              <button
                type="button"
                data-testid="qa-assign-category"
                onClick={() => setShowAssignCategoryDropdown(v => !v)}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-teal-500/90 hover:bg-teal-500 transition-all text-[13px] font-medium shadow-md shadow-teal-500/20"
                title="Assign a product category (routes selected products into the matching Manager)"
              >
                <Grid3X3 className="w-3.5 h-3.5" />
                Assign Category
              </button>
              {showAssignCategoryDropdown && (
                <div className="absolute bottom-full mb-2 left-0 bg-white text-gray-900 rounded-lg shadow-xl border border-gray-200 py-1 w-56 z-50" data-testid="assign-category-dropdown">
                  {[
                    { g: 'tiles', label: '⬛ Tiles', color: 'text-blue-600' },
                    { g: 'materials', label: '📦 Materials', color: 'text-orange-600' },
                    { g: 'flooring', label: '🪵 Flooring', color: 'text-emerald-600' },
                    { g: 'bathroom', label: '🛁 Bathroom', color: 'text-cyan-600' },
                    { g: 'underfloor_heating', label: '🔥 Underfloor Heating', color: 'text-red-600' },
                    { g: 'tools', label: '🔧 Tools & Accessories', color: 'text-slate-600' },
                  ].map(opt => (
                    <button
                      key={opt.g}
                      onClick={() => { handleBulkAssignCategory(opt.g); setShowAssignCategoryDropdown(false); }}
                      className={`w-full text-left px-3 py-2 text-sm hover:bg-gray-100 ${opt.color}`}
                      data-testid={`assign-cat-${opt.g}`}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
              )}
            </div>

            <button
              type="button"
              data-testid="qa-archive"
              onClick={handleBulkArchive}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-gray-700/90 hover:bg-gray-600 transition-all text-[13px] font-medium"
              title="Archive selected products (sets is_active = false). Can be restored later."
            >
              <Archive className="w-3.5 h-3.5" />
              Archive
            </button>

            {/* Bulk Rename — opens the name-change editor (insert text, word
                replacements, template mode) for every ticked product. */}
            <button
              type="button"
              data-testid="qa-bulk-rename"
              onClick={openBulkRenameModal}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-rose-500/90 hover:bg-rose-500 transition-all text-[13px] font-medium shadow-md shadow-rose-500/20"
              title="Bulk change product names — insert text, replace words, or rename per-product in template mode"
            >
              <PenLine className="w-3.5 h-3.5" />
              Bulk Rename
            </button>

            {/* Bulk Set Series — assigns the same range_name to every ticked
                product. Prompts for a series name and posts to
                /api/admin/series/bulk-assign. */}
            <button
              type="button"
              data-testid="qa-set-series"
              onClick={handleBulkSetSeries}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-purple-500/90 hover:bg-purple-500 transition-all text-[13px] font-medium shadow-md shadow-purple-500/20"
              title="Assign a Series/Collection name to every ticked product (writes range_name)"
            >
              <Layers className="w-3.5 h-3.5" />
              Set Series
            </button>

            {/* Divider + Close */}
            <div className="w-px h-6 bg-white/15 mx-1"></div>
            <button
              type="button"
              data-testid="qa-deselect-all"
              onClick={() => setSelectedProducts(new Set())}
              className="p-1.5 rounded-lg hover:bg-white/10 transition-all text-white/60 hover:text-white"
              title="Deselect all (clear selection)"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>
      )}

      {/* Bulk cost / list price modal */}
      {showBulkPriceModal && (
        <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/40" onClick={() => setShowBulkPriceModal(false)}>
          <div className="bg-white rounded-xl shadow-2xl p-5 w-[360px]" onClick={(e) => e.stopPropagation()} data-testid="bulk-price-modal">
            <h3 className="text-sm font-bold text-gray-900 mb-1">Set prices for {selectedProducts.size} selected</h3>
            <p className="text-xs text-gray-500 mb-4">Leave a field blank to keep each product's current value. List price updates the website immediately.</p>
            <div className="space-y-3">
              <div>
                <label className="text-xs font-semibold text-gray-600 mb-1 block">Cost (£)</label>
                <input
                  type="number"
                  step="0.01"
                  min="0"
                  value={bulkPriceForm.cost}
                  onChange={(e) => setBulkPriceForm(prev => ({ ...prev, cost: e.target.value }))}
                  placeholder="e.g. 5.50"
                  className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:border-blue-400 focus:outline-none"
                  data-testid="bulk-price-cost-input"
                />
              </div>
              <div>
                <label className="text-xs font-semibold text-gray-600 mb-1 block">List Price (£)</label>
                <input
                  type="number"
                  step="0.01"
                  min="0"
                  value={bulkPriceForm.list}
                  onChange={(e) => setBulkPriceForm(prev => ({ ...prev, list: e.target.value }))}
                  placeholder="e.g. 19.99"
                  className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:border-blue-400 focus:outline-none"
                  data-testid="bulk-price-list-input"
                />
              </div>
            </div>
            <div className="flex justify-end gap-2 mt-5">
              <button
                type="button"
                onClick={() => setShowBulkPriceModal(false)}
                className="px-3 py-1.5 text-sm text-gray-600 hover:bg-gray-100 rounded-lg"
                data-testid="bulk-price-cancel"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={applyBulkPrices}
                className="px-4 py-1.5 text-sm font-semibold bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg"
                data-testid="bulk-price-apply"
              >
                Apply
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
