import React, { useEffect, useState, useRef } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api } from '../../lib/api';
import { toast } from 'sonner';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { Label } from '../../components/ui/label';
import { Card } from '../../components/ui/card';
import { ArrowLeft, Plus, X, Package, Layers, Truck, Ruler, Upload, Image, FolderPlus, Grid3X3, Globe, Check, Wand2, Sparkles, Minus, RefreshCw, Tag, Star } from 'lucide-react';
import { useAuth } from '../../contexts/AuthContext';
import { useProductOptions } from '../../hooks/useProductOptions';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../../components/ui/dialog';

export const ProductForm = () => {
  const { id } = useParams();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const isEdit = Boolean(id);
  const isFromSupplier = searchParams.get('from') === 'supplier';
  const supplierParam = searchParams.get('supplier') || '';
  const fileInputRef = useRef(null);
  const { user } = useAuth();
  
  // Load product options from the same source as Bulk Category Editor
  const { options: productOptions, loading: optionsLoading } = useProductOptions();
  
  // Build return URL based on where user came from
  const getReturnUrl = () => {
    if (isFromSupplier && supplierParam) {
      return `/admin/supplier-products?supplier=${encodeURIComponent(supplierParam)}`;
    }
    if (isFromSupplier) {
      return '/admin/supplier-products';
    }
    return '/admin/products';
  };
  
  // Only super admin can see and edit cost
  const isSuperAdmin = user?.role === 'super_admin';
  
  // New category state
  const [showNewCategoryDialog, setShowNewCategoryDialog] = useState(false);
  const [newCategoryName, setNewCategoryName] = useState('');
  const [newCategoryDescription, setNewCategoryDescription] = useState('');
  const [creatingCategory, setCreatingCategory] = useState(false);
  const [generatingDescription, setGeneratingDescription] = useState(false);
  const [regeneratingSEO, setRegeneratingSEO] = useState(false);
  const [descriptionNameMismatch, setDescriptionNameMismatch] = useState(false);
  const [previousName, setPreviousName] = useState('');
  const nameChangeTimeoutRef = useRef(null);
  
  const [formData, setFormData] = useState({
    name: '',
    supplier_product_name: '',  // Secondary name from supplier
    sku: '',
    description: '',
    seo_keywords: '',  // SEO friendly keywords
    seo_alternate_names: [],  // Auto-generated from supplier data
    category_id: '',
    colors: [],  // Available color options
    // Visibility & Status
    visibility: 'published',  // draft, published
    status: 'active',  // pending_approval, approved, active
    show_in_epos: true,
    is_featured: false,  // Show in "Featured Tiles" section on homepage
    // Stocktake fields
    finish: '',  // e.g., Matt, Gloss, Polished
    material: '',  // e.g., Porcelain, Ceramic, Natural Stone
    type: '',  // e.g., Floor Tile, Wall Tile, Mosaic
    edge: '',  // e.g., Rectified, Non-Rectified, Bevelled
    slip_rating: '',  // e.g., R9, R10, R11, PEI 1-5
    size: '',  // e.g., 60x60, 30x60
    series: '',  // Product series/collection name (shown on website)
    rectified_edges: false,
    underfloor_heating: false,
    suitability: '',  // e.g., Wall, Floor, Wall & Floor
    thickness: '',  // Thickness in mm
    made_in: '',  // Country of Origin e.g., Italy, Spain, Europe
    stock: 0,
    m2_quantity: 0,
    // Supplier stock tracking
    supplier_stock: false, // Flag for supplier-sourced products
    supplier_name: '',     // e.g., Verona, Splendour
    supplier_code: '',     // e.g., V, S, T (for EPOS display)
    supplier_sku: '',      // Original supplier SKU from spreadsheet
    original_supplier_code: '', // Website/URL code from extension sync (e.g., G30149, D10909)
    // Tile size for m² calculation
    tile_width: '',
    tile_height: '',
    // Box configuration
    tiles_per_box: '',
    price: 0,
    cost: '',  // Cost price for profit calculation
    // Unit type dropdowns (m² or each)
    size_unit: 'm2',  // Default to m²
    cost_unit: 'm2',  // Default to m²
    // Additional cost field for "each" pricing
    cost_each: '',
    // Room lot pricing
    room_lot_enabled: false,
    room_lot_quantity: '',
    room_lot_price: '',
    // Pallet pricing
    pallet_enabled: false,
    pallet_quantity: '',
    pallet_price: '',
    // Half + Full pallet pricing (Feb 2026) — minimum m² thresholds + half rate
    m2_per_pallet: '',
    m2_per_half_pallet: '',
    half_pallet_price: '',
    // Clearance
    clearance: false,
    clearance_price: 0,
    // Sample availability — per-product opt-out
    samples_hidden: false,
    // Maximum discount
    max_discount: '',
    reorder_level: 10,
    images: [],
    // Main Category & Sub-Categories (SYNCS with Bulk Category Editor)
    main_category: '',
    sub_categories: [],
    // Website Categories (multi-select for e-commerce)
    website_categories: {
      rooms: [],      // Floor, Wall, Wall & Floor, Bathroom, Kitchen, Living Room, Hallway, Outdoor
      materials: [],  // Porcelain, Ceramic, Natural Stone, Marble, Glass, etc.
      styles: [],     // Marble Effect, Wood Effect, Stone Effect, Patterned, Metro, etc.
      colors: [],     // Grey, White, Beige, Black, Blue, Green, etc.
      finishes: [],   // Matt, Gloss, Polished, Satin, Lappato, etc.
      features: []    // Anti-Slip, Large Format, Small Format, Rectified, Underfloor Heating
    },
    show_on_website: false  // Toggle to display on e-commerce website
  });
  
  // Force create mode when product not found (for duplicate/copy scenarios)
  const [forceCreateMode, setForceCreateMode] = useState(false);
  const effectiveIsEdit = isEdit && !forceCreateMode;
  const [categories, setCategories] = useState([]);
  const [loading, setLoading] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [newImageUrl, setNewImageUrl] = useState('');
  const [newColor, setNewColor] = useState('');
  
  // Dynamic Website Category Options (loaded from API, includes custom options)
  const [websiteCategoryOptions, setWebsiteCategoryOptions] = useState(null);
  const [showAddOptionModal, setShowAddOptionModal] = useState(false);
  const [addOptionType, setAddOptionType] = useState(null);
  const [newOptionLabel, setNewOptionLabel] = useState('');
  const [addingOption, setAddingOption] = useState(false);
  
  // Default options (fallback if API fails)
  const DEFAULT_CATEGORY_OPTIONS = {
    rooms: [
      { id: 'floor', label: 'Floor Tiles', color: 'bg-amber-500' },
      { id: 'wall', label: 'Wall Tiles', color: 'bg-blue-500' },
      { id: 'wall_floor', label: 'Wall & Floor Tiles', color: 'bg-purple-500' },
      { id: 'bathroom', label: 'Bathroom', color: 'bg-cyan-500' },
      { id: 'kitchen', label: 'Kitchen', color: 'bg-orange-500' },
      { id: 'living_room', label: 'Living Room', color: 'bg-indigo-500' },
      { id: 'hallway', label: 'Hallway', color: 'bg-violet-500' },
      { id: 'outdoor', label: 'Outdoor', color: 'bg-green-500' },
      { id: 'commercial', label: 'Commercial', color: 'bg-slate-500' }
    ],
    materials: [
      { id: 'porcelain', label: 'Porcelain', color: 'bg-blue-600' },
      { id: 'ceramic', label: 'Ceramic', color: 'bg-amber-600' },
      { id: 'natural_stone', label: 'Natural Stone', color: 'bg-stone-600' },
      { id: 'marble', label: 'Marble', color: 'bg-gray-300 border border-gray-400' },
      { id: 'travertine', label: 'Travertine', color: 'bg-amber-300' },
      { id: 'slate', label: 'Slate', color: 'bg-slate-600' },
      { id: 'limestone', label: 'Limestone', color: 'bg-stone-400' },
      { id: 'granite', label: 'Granite', color: 'bg-gray-600' },
      { id: 'glass', label: 'Glass', color: 'bg-sky-400' },
      { id: 'terracotta', label: 'Terracotta', color: 'bg-orange-600' },
      { id: 'quarry', label: 'Quarry', color: 'bg-red-700' },
      { id: 'encaustic', label: 'Encaustic', color: 'bg-rose-500' }
    ],
    styles: [
      { id: 'marble_effect', label: 'Marble Effect', color: 'bg-gray-400' },
      { id: 'wood_effect', label: 'Wood Effect', color: 'bg-amber-700' },
      { id: 'stone_effect', label: 'Stone Effect', color: 'bg-stone-500' },
      { id: 'concrete_effect', label: 'Concrete Effect', color: 'bg-gray-500' },
      { id: 'patterned', label: 'Patterned', color: 'bg-pink-500' },
      { id: 'metro', label: 'Metro/Subway', color: 'bg-sky-500' },
      { id: 'terrazzo', label: 'Terrazzo', color: 'bg-rose-400' },
      { id: 'hexagon', label: 'Hexagon', color: 'bg-violet-500' },
      { id: 'mosaic', label: 'Mosaic', color: 'bg-teal-500' },
      { id: 'brick_effect', label: 'Brick Effect', color: 'bg-red-600' },
      { id: 'plain', label: 'Plain/Solid', color: 'bg-neutral-400' },
      { id: 'onyx_effect', label: 'Onyx Effect', color: 'bg-emerald-600' },
      { id: 'zellige', label: 'Zellige', color: 'bg-cyan-600' },
      { id: 'splitface', label: 'Splitface/3D', color: 'bg-stone-700' }
    ],
    colors: [
      { id: 'white', label: 'White', color: 'bg-white border border-gray-300' },
      { id: 'grey', label: 'Grey', color: 'bg-gray-400' },
      { id: 'black', label: 'Black', color: 'bg-gray-900' },
      { id: 'beige', label: 'Beige', color: 'bg-amber-200' },
      { id: 'cream', label: 'Cream', color: 'bg-amber-50 border border-gray-200' },
      { id: 'brown', label: 'Brown', color: 'bg-amber-800' },
      { id: 'blue', label: 'Blue', color: 'bg-blue-500' },
      { id: 'green', label: 'Green', color: 'bg-green-500' },
      { id: 'pink', label: 'Pink', color: 'bg-pink-400' },
      { id: 'gold', label: 'Gold', color: 'bg-yellow-500' },
      { id: 'silver', label: 'Silver', color: 'bg-slate-300' },
      { id: 'multicolour', label: 'Multicolour', color: 'bg-gradient-to-r from-red-500 via-yellow-500 to-blue-500' }
    ],
    finishes: [
      { id: 'matt', label: 'Matt', color: 'bg-gray-500' },
      { id: 'gloss', label: 'Gloss', color: 'bg-blue-400' },
      { id: 'polished', label: 'Polished', color: 'bg-slate-300' },
      { id: 'satin', label: 'Satin', color: 'bg-purple-400' },
      { id: 'lappato', label: 'Lappato', color: 'bg-indigo-400' },
      { id: 'natural', label: 'Natural', color: 'bg-stone-500' },
      { id: 'textured', label: 'Textured', color: 'bg-amber-600' },
      { id: 'honed', label: 'Honed', color: 'bg-gray-400' },
      { id: 'brushed', label: 'Brushed', color: 'bg-zinc-400' }
    ],
    features: [
      { id: 'anti_slip', label: 'Anti-Slip', color: 'bg-yellow-500' },
      { id: 'large_format', label: 'Large Format', color: 'bg-indigo-500' },
      { id: 'small_format', label: 'Small Format', color: 'bg-pink-500' },
      { id: 'rectified', label: 'Rectified', color: 'bg-blue-600' },
      { id: 'underfloor_heating', label: 'Underfloor Heating', color: 'bg-orange-500' },
      { id: 'frost_resistant', label: 'Frost Resistant', color: 'bg-cyan-600' },
      { id: 'wet_room', label: 'Wet Room Safe', color: 'bg-teal-500' },
      { id: 'eco_friendly', label: 'Eco Friendly', color: 'bg-green-600' }
    ]
  };
  
  // Use dynamic options if loaded, otherwise use defaults
  const WEBSITE_CATEGORY_OPTIONS = websiteCategoryOptions || DEFAULT_CATEGORY_OPTIONS;

  // Quick Categorize: Keyword to category mapping
  const KEYWORD_CATEGORY_MAP = {
    // Room/Location keywords
    rooms: {
      'floor': 'floor',
      'wall': 'wall',
      'bathroom': 'bathroom',
      'bath': 'bathroom',
      'kitchen': 'kitchen',
      'living': 'living_room',
      'lounge': 'living_room',
      'hallway': 'hallway',
      'hall': 'hallway',
      'entrance': 'hallway',
      'outdoor': 'outdoor',
      'exterior': 'outdoor',
      'garden': 'outdoor',
      'patio': 'outdoor',
      'commercial': 'commercial',
      'shop': 'commercial',
      'office': 'commercial'
    },
    // Style/Effect keywords
    styles: {
      'marble': 'marble_effect',
      'carrara': 'marble_effect',
      'calacatta': 'marble_effect',
      'statuario': 'marble_effect',
      'wood': 'wood_effect',
      'oak': 'wood_effect',
      'walnut': 'wood_effect',
      'timber': 'wood_effect',
      'plank': 'wood_effect',
      'stone': 'stone_effect',
      'slate': 'stone_effect',
      'travertine': 'stone_effect',
      'limestone': 'stone_effect',
      'concrete': 'concrete_effect',
      'cement': 'concrete_effect',
      'industrial': 'concrete_effect',
      'pattern': 'patterned',
      'patterned': 'patterned',
      'decor': 'patterned',
      'encaustic': 'patterned',
      'geometric': 'patterned',
      'metro': 'metro',
      'subway': 'metro',
      'brick': 'brick_effect',
      'terrazzo': 'terrazzo',
      'hexagon': 'hexagon',
      'hex': 'hexagon',
      'mosaic': 'mosaic',
      'onyx': 'onyx_effect',
      'plain': 'plain',
      'solid': 'plain'
    },
    // Color keywords
    colors: {
      'white': 'white',
      'bianco': 'white',
      'grey': 'grey',
      'gray': 'grey',
      'grigio': 'grey',
      'anthracite': 'grey',
      'charcoal': 'grey',
      'black': 'black',
      'nero': 'black',
      'beige': 'beige',
      'cream': 'cream',
      'ivory': 'cream',
      'brown': 'brown',
      'bronze': 'brown',
      'rust': 'brown',
      'blue': 'blue',
      'navy': 'blue',
      'azzurro': 'blue',
      'green': 'green',
      'emerald': 'green',
      'sage': 'green',
      'pink': 'pink',
      'blush': 'pink',
      'rose': 'pink',
      'gold': 'gold',
      'brass': 'gold',
      'silver': 'silver',
      'multi': 'multicolour',
      'multicolour': 'multicolour'
    },
    // Material keywords
    materials: {
      'porcelain': 'porcelain',
      'ceramic': 'ceramic',
      'natural stone': 'natural_stone',
      'stone': 'natural_stone',
      'marble': 'marble',
      'travertine': 'travertine',
      'slate': 'slate',
      'limestone': 'limestone',
      'granite': 'granite',
      'glass': 'glass',
      'terracotta': 'terracotta',
      'quarry': 'quarry',
      'encaustic': 'encaustic'
    },
    // Finish keywords
    finishes: {
      'matt': 'matt',
      'matte': 'matt',
      'gloss': 'gloss',
      'glossy': 'gloss',
      'polished': 'polished',
      'satin': 'satin',
      'lappato': 'lappato',
      'semi-polished': 'lappato',
      'natural': 'natural',
      'textured': 'textured',
      'structured': 'textured',
      'honed': 'honed',
      'brushed': 'brushed'
    },
    // Feature keywords
    features: {
      'anti-slip': 'anti_slip',
      'antislip': 'anti_slip',
      'slip': 'anti_slip',
      'r10': 'anti_slip',
      'r11': 'anti_slip',
      'large': 'large_format',
      '120x60': 'large_format',
      '120x120': 'large_format',
      '100x100': 'large_format',
      '80x80': 'large_format',
      'small': 'small_format',
      '10x10': 'small_format',
      '15x15': 'small_format',
      '20x20': 'small_format',
      'rectified': 'rectified',
      'underfloor': 'underfloor_heating',
      'heating': 'underfloor_heating',
      'ufh': 'underfloor_heating',
      'frost': 'frost_resistant',
      'wet': 'wet_room',
      'wetroom': 'wet_room',
      'eco': 'eco_friendly',
      'sustainable': 'eco_friendly',
      'recycled': 'eco_friendly'
    }
  };

  // State for Quick Categorize suggestions
  const [quickSuggestions, setQuickSuggestions] = useState([]);
  const [showQuickSuggestions, setShowQuickSuggestions] = useState(false);

  // Function to generate category suggestions from product name
  const generateQuickSuggestions = () => {
    const productName = formData.name?.toLowerCase() || '';
    const suggestions = [];
    
    // Check each category type
    Object.entries(KEYWORD_CATEGORY_MAP).forEach(([categoryType, keywords]) => {
      Object.entries(keywords).forEach(([keyword, categoryId]) => {
        if (productName.includes(keyword)) {
          // Check if this category exists in options and isn't already selected
          const optionExists = WEBSITE_CATEGORY_OPTIONS[categoryType]?.find(opt => opt.id === categoryId);
          const alreadySelected = formData.website_categories?.[categoryType]?.includes(categoryId);
          
          if (optionExists && !alreadySelected) {
            // Avoid duplicates in suggestions
            const exists = suggestions.find(s => s.categoryType === categoryType && s.categoryId === categoryId);
            if (!exists) {
              suggestions.push({
                categoryType,
                categoryId,
                label: optionExists.label,
                color: optionExists.color,
                matchedKeyword: keyword
              });
            }
          }
        }
      });
    });
    
    setQuickSuggestions(suggestions);
    setShowQuickSuggestions(true);
  };

  // Apply a single suggestion
  const applySuggestion = (suggestion) => {
    toggleWebsiteCategory(suggestion.categoryType, suggestion.categoryId);
    // Remove from suggestions list
    setQuickSuggestions(prev => prev.filter(s => 
      !(s.categoryType === suggestion.categoryType && s.categoryId === suggestion.categoryId)
    ));
  };

  // Apply all suggestions at once
  const applyAllSuggestions = () => {
    quickSuggestions.forEach(suggestion => {
      // Check if not already selected (in case user manually selected during viewing)
      if (!isCategorySelected(suggestion.categoryType, suggestion.categoryId)) {
        toggleWebsiteCategory(suggestion.categoryType, suggestion.categoryId);
      }
    });
    setQuickSuggestions([]);
    setShowQuickSuggestions(false);
  };

  // Toggle website category selection
  const toggleWebsiteCategory = (categoryType, categoryId) => {
    setFormData(prev => {
      const currentCategories = prev.website_categories?.[categoryType] || [];
      const isSelected = currentCategories.includes(categoryId);
      
      return {
        ...prev,
        website_categories: {
          ...prev.website_categories,
          [categoryType]: isSelected
            ? currentCategories.filter(id => id !== categoryId)
            : [...currentCategories, categoryId]
        }
      };
    });
  };

  // Check if a category is selected
  const isCategorySelected = (categoryType, categoryId) => {
    return formData.website_categories?.[categoryType]?.includes(categoryId) || false;
  };
  
  // Calculate m² per piece from tile dimensions
  const tileM2PerPiece = formData.tile_width && formData.tile_height 
    ? ((parseFloat(formData.tile_width) / 100) * (parseFloat(formData.tile_height) / 100)).toFixed(4)
    : null;
  
  // Smart tile dimension handler - auto-converts mm to cm and validates
  const handleTileDimensionChange = (field, value) => {
    let numValue = parseFloat(value);
    let warning = null;
    let autoConverted = false;
    
    if (!isNaN(numValue) && numValue > 0) {
      // If value > 200, it's likely in mm - auto-convert to cm
      if (numValue > 200) {
        numValue = numValue / 10;
        autoConverted = true;
      }
      // Validate reasonable tile size (max 200cm = 2 meters)
      if (numValue > 200) {
        warning = `Warning: ${numValue}cm seems too large for a tile. Please check.`;
      }
    }
    
    setFormData(prev => ({ 
      ...prev, 
      [field]: autoConverted ? numValue.toString() : value,
      [`${field}_warning`]: warning,
      [`${field}_auto_converted`]: autoConverted
    }));
    
    if (autoConverted) {
      toast.info(`Auto-converted from ${value}mm to ${numValue}cm`, { duration: 3000 });
    }
  };
  
  // Check if tile dimensions seem suspicious (likely data error)
  const tileDimensionWarning = (() => {
    const width = parseFloat(formData.tile_width);
    const height = parseFloat(formData.tile_height);
    if (!width || !height) return null;
    
    const m2PerPiece = (width / 100) * (height / 100);
    
    // A single tile > 4m² is almost certainly wrong
    if (m2PerPiece > 4) {
      return {
        type: 'error',
        message: `⚠️ CRITICAL: ${m2PerPiece.toFixed(2)}m² per tile is unrealistic! A ${width}x${height}cm tile would be ${(width/100).toFixed(1)}m × ${(height/100).toFixed(1)}m. Did you mean ${width/10}x${height/10}cm?`,
        suggestedWidth: width / 10,
        suggestedHeight: height / 10
      };
    }
    // A single tile > 1m² should be flagged as unusual
    if (m2PerPiece > 1) {
      return {
        type: 'warning',
        message: `Large format tile: ${m2PerPiece.toFixed(2)}m² per piece. Please verify dimensions are correct.`
      };
    }
    return null;
  })();
  
  // Calculate box m² coverage
  const boxM2Coverage = tileM2PerPiece && formData.tiles_per_box
    ? (parseFloat(tileM2PerPiece) * parseInt(formData.tiles_per_box)).toFixed(3)
    : null;
  
  // Calculate box price (Price per m² × Box coverage in m²)
  // NOT Price × Tiles per box (which would be wrong)
  const boxPrice = formData.price && boxM2Coverage
    ? (parseFloat(formData.price) * parseFloat(boxM2Coverage)).toFixed(2)
    : null;

  useEffect(() => {
    fetchCategories();
    if (isEdit) {
      fetchProduct();
    } else if (isFromSupplier) {
      // Load supplier product data from localStorage
      loadSupplierProductData();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, isFromSupplier]);

  // Check if description contains a different product name
  useEffect(() => {
    if (formData.name && formData.description && formData.supplier_product_name) {
      const productName = formData.name.toLowerCase().trim();
      const supplierName = formData.supplier_product_name.toLowerCase().trim();
      const description = formData.description.toLowerCase();
      
      // Skip if names are the same
      if (productName === supplierName) {
        setDescriptionNameMismatch(false);
        return;
      }
      
      // Extract FIRST significant word only (the actual product identifier like "Dolomite" vs "Dolmen")
      // Skip common words like Grey, White, Black, sizes, finishes
      const commonWords = new Set(['grey', 'gray', 'white', 'black', 'beige', 'cream', 'brown', 'blue', 'green', 'red', 'pink', 'matt', 'matte', 'polished', 'gloss', 'glossy', 'satin', 'rectified', 'lappato', 'honed', 'natural', 'outdoor', 'indoor', 'wall', 'floor', 'tile', 'tiles', 'porcelain', 'ceramic', 'stone', 'marble', 'wood', 'effect', 'look', 'style']);
      
      const getFirstDistinctiveWord = (name) => {
        const words = name.split(/[\s\-\/]+/)
          .filter(w => w.length > 2 && !w.match(/^\d+x?\d*/i) && !w.match(/^(cm|mm)$/i) && !commonWords.has(w));
        return words[0] || '';
      };
      
      const productFirstWord = getFirstDistinctiveWord(productName);
      const supplierFirstWord = getFirstDistinctiveWord(supplierName);
      
      // If distinctive words are different (Dolomite vs Dolmen)
      if (productFirstWord && supplierFirstWord && productFirstWord !== supplierFirstWord) {
        // Check which one appears in description
        const productWordInDesc = description.includes(productFirstWord);
        const supplierWordInDesc = description.includes(supplierFirstWord);
        
        // Mismatch if supplier word is in description but product word is not
        const hasMismatch = supplierWordInDesc && !productWordInDesc;
        setDescriptionNameMismatch(hasMismatch);
      } else {
        setDescriptionNameMismatch(false);
      }
    } else {
      setDescriptionNameMismatch(false);
    }
  }, [formData.name, formData.description, formData.supplier_product_name]);

  // Auto-regenerate description when product name changes significantly
  useEffect(() => {
    // Skip if no previous name set (initial load), no description, or name hasn't really changed
    if (!previousName || !formData.description || !formData.name) {
      if (formData.name && !previousName) {
        setPreviousName(formData.name);
      }
      return;
    }
    
    // Normalize names for comparison
    const oldName = previousName.toLowerCase().trim();
    const newName = formData.name.toLowerCase().trim();
    
    // Skip if names are the same
    if (oldName === newName) return;
    
    // Common words to skip when finding distinctive word
    const commonWords = new Set(['grey', 'gray', 'white', 'black', 'beige', 'cream', 'brown', 'blue', 'green', 'red', 'pink', 'matt', 'matte', 'polished', 'gloss', 'glossy', 'satin', 'rectified', 'lappato', 'honed', 'natural', 'outdoor', 'indoor', 'wall', 'floor', 'tile', 'tiles', 'porcelain', 'ceramic', 'stone', 'marble', 'wood', 'effect', 'look', 'style']);
    
    // Get first distinctive word (the actual product identifier)
    const getFirstDistinctiveWord = (name) => {
      const words = name.split(/[\s\-\/]+/)
        .filter(w => w.length > 2 && !w.match(/^\d+x?\d*/i) && !w.match(/^(cm|mm)$/i) && !commonWords.has(w));
      return words[0] || '';
    };
    
    const oldDistinctive = getFirstDistinctiveWord(oldName);
    const newDistinctive = getFirstDistinctiveWord(newName);
    
    // Only auto-regenerate if the distinctive word changed (e.g., Dolmen -> Dolomite)
    if (oldDistinctive && newDistinctive && oldDistinctive !== newDistinctive) {
      // Clear any pending timeout
      if (nameChangeTimeoutRef.current) {
        clearTimeout(nameChangeTimeoutRef.current);
      }
      
      // Debounce: wait 2 seconds after user stops typing to regenerate
      nameChangeTimeoutRef.current = setTimeout(() => {
        // Check if the old distinctive word appears in description
        const description = formData.description.toLowerCase();
        const oldWordInDescription = description.includes(oldDistinctive);
        
        if (oldWordInDescription) {
          toast.info('Product name changed - regenerating description...', { duration: 2000 });
          handleGenerateDescription('generate');
        }
        
        setPreviousName(formData.name);
      }, 2000);
    } else {
      // Update previousName even if we don't regenerate
      setPreviousName(formData.name);
    }
    
    return () => {
      if (nameChangeTimeoutRef.current) {
        clearTimeout(nameChangeTimeoutRef.current);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [formData.name]);

  // Load pre-filled data from supplier product
  const loadSupplierProductData = () => {
    try {
      const storedData = localStorage.getItem('supplierProductData');
      if (storedData) {
        const supplierProduct = JSON.parse(storedData);
        setFormData(prev => ({
          ...prev,
          name: supplierProduct.name || '',
          supplier_product_name: supplierProduct.supplier_product_name || '',
          sku: supplierProduct.sku || '',
          description: supplierProduct.description || '',
          material: supplierProduct.material || '',
          finish: supplierProduct.finish || '',
          size: supplierProduct.size || '',
          tile_width: supplierProduct.tile_width || '',
          tile_height: supplierProduct.tile_height || '',
          price: supplierProduct.price || 0,
          cost: supplierProduct.cost || '',
          // New unit fields
          size_unit: supplierProduct.size_unit || 'm2',
          cost_unit: supplierProduct.cost_unit || 'm2',
          // Supplier stock info
          supplier_stock: supplierProduct.supplier_stock || false,
          supplier_name: supplierProduct.supplier_name || '',
          supplier_code: supplierProduct.supplier_code || '',
          supplier_sku: supplierProduct.supplier_sku || '',
          original_supplier_code: supplierProduct.original_supplier_code || '',  // Website/URL code
          stock: supplierProduct.stock || 0,
          m2_quantity: supplierProduct.m2_quantity || 0,
          images: supplierProduct.images || [],
          // Additional fields from supplier
          type: supplierProduct.type || '',
          category: supplierProduct.category || '',
          tiles_per_box: supplierProduct.tiles_per_box || '',
          thickness: supplierProduct.thickness || ''
        }));
        
        // Clear the stored data
        localStorage.removeItem('supplierProductData');
        
        const stockInfo = supplierProduct.m2_quantity 
          ? `${supplierProduct.m2_quantity}m² in stock at supplier`
          : `${supplierProduct.stock || 0} units in stock at supplier`;
        
        toast.success(`Loaded ${supplierProduct.supplier_name || 'supplier'} product - ${stockInfo}`);
      }
    } catch (error) {
      console.error('Error loading supplier product data:', error);
    }
  };

  const fetchCategories = async () => {
    try {
      // Use the same endpoint as ManageCategories for consistency
      const response = await fetch(`${process.env.REACT_APP_BACKEND_URL}/api/supplier-sync/categories/detailed`);
      if (response.ok) {
        const data = await response.json();
        // API returns { success: true, categories: [...] }
        const categoriesData = data.categories || data;
        // Transform to match expected format: { id, name, description }
        const formattedCategories = categoriesData.map(cat => ({
          id: cat.name, // Use name as ID for consistency
          name: cat.name,
          description: cat.description || ''
        }));
        setCategories(formattedCategories);
      } else {
        // Fallback to old endpoint if new one fails
        const fallbackResponse = await api.getCategories();
        setCategories(fallbackResponse.data);
      }
    } catch (error) {
      console.error('Error fetching categories:', error);
      // Fallback to old endpoint
      try {
        const fallbackResponse = await api.getCategories();
        setCategories(fallbackResponse.data);
      } catch (fallbackError) {
        toast.error('Failed to load categories');
      }
    }
  };

  // Fetch website category options (including custom ones)
  const fetchWebsiteCategoryOptions = async () => {
    try {
      const response = await fetch(`${process.env.REACT_APP_BACKEND_URL}/api/supplier-sync/website-category-options`);
      if (response.ok) {
        const data = await response.json();
        // Merge API response with defaults to ensure new category types are included
        setWebsiteCategoryOptions({
          rooms: data.rooms || DEFAULT_CATEGORY_OPTIONS.rooms,
          materials: data.materials || DEFAULT_CATEGORY_OPTIONS.materials,
          styles: data.styles || DEFAULT_CATEGORY_OPTIONS.styles,
          colors: data.colors || DEFAULT_CATEGORY_OPTIONS.colors,
          finishes: data.finishes || DEFAULT_CATEGORY_OPTIONS.finishes,
          features: data.features || DEFAULT_CATEGORY_OPTIONS.features
        });
      }
    } catch (error) {
      console.error('Error fetching website category options:', error);
      // Fall back to defaults if API fails
    }
  };

  // Add a new custom category option
  const handleAddCustomOption = async () => {
    if (!newOptionLabel.trim()) {
      toast.error('Please enter a label for the new option');
      return;
    }

    setAddingOption(true);
    try {
      // Generate ID from label
      const optionId = newOptionLabel.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_');
      
      const response = await fetch(`${process.env.REACT_APP_BACKEND_URL}/api/supplier-sync/website-category-options`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          category_type: addOptionType,
          id: optionId,
          label: newOptionLabel.trim(),
          color: 'bg-gray-500'  // Default color
        })
      });

      if (response.ok) {
        const result = await response.json();
        toast.success(`Added "${newOptionLabel}" to ${addOptionType}`);
        
        // Refresh options
        await fetchWebsiteCategoryOptions();
        
        // Auto-select the new option
        toggleWebsiteCategory(addOptionType, result.option.id);
        
        // Close modal
        setShowAddOptionModal(false);
        setNewOptionLabel('');
        setAddOptionType(null);
      } else {
        const error = await response.json();
        toast.error(error.detail || 'Failed to add option');
      }
    } catch (error) {
      console.error('Add custom option error:', error);
      toast.error('Failed to add option');
    } finally {
      setAddingOption(false);
    }
  };

  // Open add option modal
  const openAddOptionModal = (categoryType) => {
    setAddOptionType(categoryType);
    setNewOptionLabel('');
    setShowAddOptionModal(true);
  };

  // Fetch website category options on mount
  useEffect(() => {
    fetchWebsiteCategoryOptions();
  }, []);

  const fetchProduct = async () => {
    try {
      const response = await api.getProduct(id);
      setFormData({
        ...response.data,
        // Ensure arrays are always arrays (prevent "Cannot read properties of undefined (reading 'length')" errors)
        images: response.data.images || [],
        colors: response.data.colors || [],
        tile_width: response.data.tile_width || '',
        tile_height: response.data.tile_height || '',
        tiles_per_box: response.data.tiles_per_box || '',
        cost: response.data.cost || '',
        room_lot_quantity: response.data.room_lot_quantity || '',
        room_lot_price: response.data.room_lot_price || '',
        pallet_quantity: response.data.pallet_quantity || '',
        pallet_price: response.data.pallet_price || '',
        m2_per_pallet: response.data.m2_per_pallet || '',
        m2_per_half_pallet: response.data.m2_per_half_pallet || '',
        half_pallet_price: response.data.half_pallet_price || '',
        seo_keywords: response.data.seo_keywords || '',
        seo_alternate_names: response.data.seo_alternate_names || [],
        // Main Category & Sub-Categories (SYNCS with Bulk Category Editor)
        main_category: response.data.main_category || '',
        sub_categories: response.data.sub_categories || [],
        // Website categories - load from top-level fields first (Bulk Editor format), fallback to nested
        website_categories: {
          rooms: response.data.rooms || response.data.website_categories?.rooms || [],
          materials: response.data.materials || response.data.website_categories?.materials || [],
          styles: response.data.styles || response.data.website_categories?.styles || [],
          colors: response.data.colors || response.data.website_categories?.colors || [],
          finishes: response.data.finishes || response.data.website_categories?.finishes || [],
          features: response.data.features || response.data.website_categories?.features || []
        },
        // Visibility & Status
        visibility: response.data.visibility || 'published',
        status: response.data.status || 'active',
        show_on_website: response.data.show_on_website !== false,  // Default to true
        show_in_epos: response.data.show_in_epos !== false  // Default to true
      });
      // Set previous name for auto-regenerate tracking
      setPreviousName(response.data.name || '');
    } catch (error) {
      // If product not found (404), switch to create mode instead of navigating away
      // This allows "duplicate product" workflow where URL has an ID but product doesn't exist
      if (error.response?.status === 404) {
        setForceCreateMode(true);
        toast.info('Product not found - switched to create mode. Enter a new SKU to save as a new product.');
        // Generate a new unique SKU
        const newSku = `NEW-${Date.now().toString(36).toUpperCase()}`;
        setFormData(prev => ({ ...prev, sku: newSku }));
      } else {
        toast.error('Failed to load product');
        navigate('/admin/products');
      }
    }
  };

  const handleCreateCategory = async () => {
    if (!newCategoryName.trim()) {
      toast.error('Please enter a category name');
      return;
    }
    
    setCreatingCategory(true);
    try {
      const response = await api.createCategory({
        name: newCategoryName.trim(),
        description: newCategoryDescription.trim()
      });
      
      // Add to categories list and select it
      const newCategory = response.data;
      setCategories(prev => [...prev, newCategory]);
      setFormData(prev => ({ ...prev, category_id: newCategory.id }));
      
      toast.success(`Category "${newCategoryName}" created`);
      setShowNewCategoryDialog(false);
      setNewCategoryName('');
      setNewCategoryDescription('');
    } catch (error) {
      toast.error(error.response?.data?.detail || 'Failed to create category');
    } finally {
      setCreatingCategory(false);
    }
  };

  // AI Description Generator
  const handleGenerateDescription = async (mode = 'generate') => {
    setGeneratingDescription(true);
    try {
      const token = localStorage.getItem('token');
      
      // Gather product context for AI
      const productContext = {
        name: formData.name,
        sku: formData.sku,
        category: categories.find(c => c.id === formData.category_id)?.name || '',
        seo_keywords: formData.seo_keywords || '',
        material: formData.material || '',
        finish: formData.finish || '',
        type: formData.type || '',
        size: formData.size || '',
        colors: formData.colors || [],
        suitability: formData.suitability || '',
        slip_rating: formData.slip_rating || '',
        edge: formData.edge || '',
        // Include website categories if selected
        website_categories: {
          rooms: formData.website_categories?.rooms || [],
          materials: formData.website_categories?.materials || [],
          styles: formData.website_categories?.styles || [],
          colors: formData.website_categories?.colors || [],
          finishes: formData.website_categories?.finishes || [],
          features: formData.website_categories?.features || []
        },
        // Mode and current description for modifications
        mode: mode,
        current_description: (mode !== 'generate' && mode !== 'brief' && mode !== 'long') ? formData.description : '',
        // Length hints for generation
        length_hint: mode === 'brief' ? 'short' : (mode === 'long' ? 'detailed' : 'standard')
      };
      
      const response = await fetch(`${process.env.REACT_APP_BACKEND_URL}/api/products/generate-description`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify(productContext)
      });
      
      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.detail || 'Failed to generate description');
      }
      
      const data = await response.json();
      setFormData(prev => ({ ...prev, description: data.description }));
      
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

  // Regenerate SEO alternate names from supplier data
  const handleRegenerateSEO = async () => {
    if (!id) {
      // For new products, generate locally
      const alternateNames = [];
      if (formData.supplier_product_name) {
        alternateNames.push(formData.supplier_product_name);
        // Extract keywords
        const words = formData.supplier_product_name.replace(/[\/\-]/g, ' ').split(' ');
        const stopWords = new Set(['the', 'and', 'or', 'a', 'an', 'cm', 'mm', 'x', 'for', 'with', 'in', 'on']);
        words.forEach(word => {
          const clean = word.trim().toLowerCase();
          if (clean.length > 2 && !stopWords.has(clean) && !clean.match(/^\d+$/)) {
            const titleCase = clean.charAt(0).toUpperCase() + clean.slice(1);
            if (!alternateNames.includes(titleCase)) {
              alternateNames.push(titleCase);
            }
          }
        });
      }
      if (formData.supplier_sku) alternateNames.push(formData.supplier_sku);
      setFormData(prev => ({ ...prev, seo_alternate_names: alternateNames }));
      toast.success('SEO keywords generated!');
      return;
    }
    
    setRegeneratingSEO(true);
    try {
      const token = localStorage.getItem('token');
      const response = await fetch(`${process.env.REACT_APP_BACKEND_URL}/api/products/${id}/regenerate-seo`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`
        }
      });
      
      if (!response.ok) throw new Error('Failed to regenerate SEO');
      
      const data = await response.json();
      setFormData(prev => ({ ...prev, seo_alternate_names: data.seo_alternate_names }));
      toast.success('SEO keywords regenerated!');
    } catch (error) {
      console.error('Error regenerating SEO:', error);
      toast.error('Failed to regenerate SEO keywords');
    } finally {
      setRegeneratingSEO(false);
    }
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setLoading(true);

    // Prepare data for submission
    const submitData = {
      ...formData,
      tile_width: formData.tile_width ? parseFloat(formData.tile_width) : null,
      tile_height: formData.tile_height ? parseFloat(formData.tile_height) : null,
      tiles_per_box: formData.tiles_per_box ? parseInt(formData.tiles_per_box) : null,
      cost: formData.cost ? parseFloat(formData.cost) : null,
      room_lot_quantity: formData.room_lot_enabled && formData.room_lot_quantity ? parseInt(formData.room_lot_quantity) : null,
      room_lot_price: formData.room_lot_enabled && formData.room_lot_price ? parseFloat(formData.room_lot_price) : null,
      pallet_quantity: formData.pallet_enabled && formData.pallet_quantity ? parseInt(formData.pallet_quantity) : null,
      pallet_price: formData.pallet_enabled && formData.pallet_price ? parseFloat(formData.pallet_price) : null,
      // Half + Full pallet pricing (Feb 2026)
      m2_per_pallet: formData.pallet_enabled && formData.m2_per_pallet ? parseFloat(formData.m2_per_pallet) : null,
      m2_per_half_pallet: formData.pallet_enabled && formData.m2_per_half_pallet ? parseFloat(formData.m2_per_half_pallet) : null,
      half_pallet_price: formData.pallet_enabled && formData.half_pallet_price ? parseFloat(formData.half_pallet_price) : null,
      // Supplier stock fields
      supplier_stock: formData.supplier_stock || false,
      supplier_name: formData.supplier_name || null,
      supplier_code: formData.supplier_code || null,
      supplier_sku: formData.supplier_sku || null,
      original_supplier_code: formData.original_supplier_code || null,  // Website/URL code for sync matching
      // New unit fields
      size_unit: formData.size_unit || 'm2',
      cost_unit: formData.cost_unit || 'm2',
      // SYNC WITH BULK EDITOR: Save categories at top level (matching SupplierProducts.js structure)
      main_category: formData.main_category || '',
      sub_categories: formData.sub_categories || [],
      rooms: formData.website_categories?.rooms || [],
      styles: formData.website_categories?.styles || [],
      colors: formData.website_categories?.colors || [],
      features: formData.website_categories?.features || [],
      materials: formData.website_categories?.materials || [],
      finishes: formData.website_categories?.finishes || [],
    };

    try {
      if (effectiveIsEdit) {
        await api.updateProduct(id, submitData);
        toast.success('Product updated successfully');
      } else {
        await api.createProduct(submitData);
        toast.success('Product created successfully');
      }
      navigate(getReturnUrl());
    } catch (error) {
      toast.error(error.response?.data?.detail || 'Failed to save product');
    } finally {
      setLoading(true);
    }
  };

  const addImage = () => {
    if (newImageUrl.trim()) {
      setFormData({ ...formData, images: [...formData.images, newImageUrl.trim()] });
      setNewImageUrl('');
    }
  };

  const handleFileUpload = async (event) => {
    const files = event.target.files;
    if (!files || files.length === 0) return;

    setUploading(true);
    const uploadedUrls = [];

    try {
      for (const file of files) {
        // Validate file type
        if (!file.type.startsWith('image/')) {
          toast.error(`${file.name} is not an image file`);
          continue;
        }

        // Validate file size (max 10MB)
        if (file.size > 10 * 1024 * 1024) {
          toast.error(`${file.name} is too large. Maximum size is 10MB`);
          continue;
        }

        toast.loading(`Uploading ${file.name}...`);
        const response = await api.uploadImage(file);
        toast.dismiss();
        
        if (response.data?.url) {
          uploadedUrls.push(response.data.url);
          toast.success(`${file.name} uploaded successfully`);
        }
      }

      if (uploadedUrls.length > 0) {
        setFormData(prev => ({
          ...prev,
          images: [...prev.images, ...uploadedUrls]
        }));
      }
    } catch (error) {
      toast.dismiss();
      toast.error(error.response?.data?.detail || 'Failed to upload image');
    } finally {
      setUploading(false);
      // Reset file input
      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }
    }
  };

  const removeImage = (index) => {
    const updatedImages = formData.images.filter((_, i) => i !== index);
    setFormData({ ...formData, images: updatedImages });
  };

  return (
    <div className="space-y-6" data-testid="product-form-page">
      <div className="flex items-center gap-4">
        <Button variant="outline" size="sm" onClick={() => navigate(getReturnUrl())} data-testid="back-button">
          <ArrowLeft className="h-4 w-4 mr-2" /> Back
        </Button>
        <div>
          <h1 className="text-4xl font-heading font-bold tracking-tightest">{effectiveIsEdit ? 'Edit Product' : 'New Product'}</h1>
        </div>
      </div>

      <Card className="p-8">
        {/* Force Create Mode Banner */}
        {forceCreateMode && (
          <div className="mb-6 p-4 bg-blue-50 border-2 border-blue-300 rounded-lg">
            <div className="flex items-center gap-3">
              <span className="text-2xl">📋</span>
              <div>
                <p className="font-semibold text-blue-800">Creating New Product</p>
                <p className="text-sm text-blue-600">
                  The original product was not found. Enter product details below to create a new product.
                  Make sure to enter a unique SKU.
                </p>
              </div>
            </div>
          </div>
        )}
        
        <form onSubmit={handleSubmit} className="space-y-8 max-w-3xl">
          {/* Basic Info Section */}
          <div>
            <h2 className="text-lg font-heading font-bold mb-4 flex items-center gap-2">
              <Package className="h-5 w-5" />
              Basic Information
            </h2>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              <div className="space-y-2">
                <Label htmlFor="name" data-testid="name-label">Product Name *</Label>
                <Input
                  id="name"
                  data-testid="name-input"
                  value={formData.name}
                  onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                  required
                  placeholder="Enter product name (shown on invoices)"
                />
                <p className="text-xs text-muted-foreground">This name will appear on invoices and quotations</p>
              </div>

              <div className="space-y-2">
                <Label htmlFor="sku" data-testid="sku-label">SKU *</Label>
                <Input
                  id="sku"
                  data-testid="sku-input"
                  value={formData.sku}
                  onChange={(e) => setFormData({ ...formData, sku: e.target.value })}
                  required
                  placeholder="e.g., TILE-001"
                  className="font-mono"
                />
              </div>
            </div>

            <div className="space-y-2 mt-4">
              <Label htmlFor="supplier_product_name" data-testid="supplier-name-label">Supplier Product Name</Label>
              <Input
                id="supplier_product_name"
                data-testid="supplier-product-name-input"
                value={formData.supplier_product_name || ''}
                onChange={(e) => setFormData({ ...formData, supplier_product_name: e.target.value })}
                placeholder="Enter supplier's name for this product (for internal reference only)"
              />
              <p className="text-xs text-muted-foreground">This is for internal reference only - not shown on invoices</p>
            </div>

            <div className="space-y-2 mt-4">
              <div className="flex items-center justify-between">
                <Label htmlFor="description" data-testid="description-label">Description</Label>
                <div className="flex items-center gap-2">
                  {/* AI Generation Options - Always visible */}
                  <div className="flex items-center gap-1 bg-purple-50 rounded-lg p-1">
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => handleGenerateDescription('brief')}
                      disabled={generatingDescription}
                      className="text-purple-600 hover:bg-purple-100 h-7 px-2 text-xs"
                      title="Generate a brief, concise description"
                      data-testid="generate-brief-btn"
                    >
                      <Sparkles className={`h-3 w-3 mr-1 ${generatingDescription ? 'animate-pulse' : ''}`} />
                      Brief
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => handleGenerateDescription('generate')}
                      disabled={generatingDescription}
                      className="text-purple-600 hover:bg-purple-100 h-7 px-2 text-xs font-medium"
                      title="Generate a standard description"
                      data-testid="generate-standard-btn"
                    >
                      <Sparkles className={`h-3 w-3 mr-1 ${generatingDescription ? 'animate-pulse' : ''}`} />
                      Standard
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => handleGenerateDescription('long')}
                      disabled={generatingDescription}
                      className="text-purple-600 hover:bg-purple-100 h-7 px-2 text-xs"
                      title="Generate a detailed, long description"
                      data-testid="generate-long-btn"
                    >
                      <Sparkles className={`h-3 w-3 mr-1 ${generatingDescription ? 'animate-pulse' : ''}`} />
                      Long
                    </Button>
                  </div>
                  
                  {/* Length Controls - Only show when description exists */}
                  {formData.description && (
                    <>
                      <div className="w-px h-6 bg-gray-200" />
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => handleGenerateDescription('shorter')}
                        disabled={generatingDescription}
                        className="text-gray-600 hover:bg-gray-100 h-7 px-2"
                        title="Make description shorter"
                        data-testid="make-shorter-btn"
                      >
                        <Minus className="h-3 w-3 mr-1" />
                        Shorter
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => handleGenerateDescription('longer')}
                        disabled={generatingDescription}
                        className="text-gray-600 hover:bg-gray-100 h-7 px-2"
                        title="Make description longer"
                        data-testid="make-longer-btn"
                      >
                        <Plus className="h-3 w-3 mr-1" />
                        Longer
                      </Button>
                      <div className="w-px h-6 bg-gray-200" />
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => handleGenerateDescription('regenerate')}
                        disabled={generatingDescription}
                        className="text-blue-600 hover:bg-blue-50 h-7 px-2"
                        title="Generate a different variation"
                        data-testid="regenerate-btn"
                      >
                        <RefreshCw className={`h-3 w-3 mr-1 ${generatingDescription ? 'animate-spin' : ''}`} />
                        New
                      </Button>
                    </>
                  )}
                </div>
              </div>
              
              {/* Generating indicator */}
              {generatingDescription && (
                <div className="bg-purple-50 border border-purple-200 rounded-lg p-3 flex items-center gap-2">
                  <div className="animate-spin h-4 w-4 border-2 border-purple-500 border-t-transparent rounded-full"></div>
                  <span className="text-sm text-purple-700">Generating AI description...</span>
                </div>
              )}
              
              {/* Name mismatch warning */}
              {descriptionNameMismatch && !generatingDescription && (
                <div className="bg-amber-50 border border-amber-300 rounded-lg p-3 flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <svg className="h-5 w-5 text-amber-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                    </svg>
                    <span className="text-sm text-amber-800">
                      <strong>Name mismatch:</strong> Description uses "<span className="font-mono">{formData.supplier_product_name?.split(' ').slice(0, 2).join(' ')}</span>" but Product Name is "<span className="font-mono">{formData.name?.split(' ').slice(0, 2).join(' ')}</span>"
                    </span>
                  </div>
                  <Button
                    type="button"
                    size="sm"
                    onClick={() => handleGenerateDescription('generate')}
                    className="bg-amber-600 hover:bg-amber-700 text-white h-8 px-3"
                  >
                    <RefreshCw className="h-3 w-3 mr-1" />
                    Regenerate
                  </Button>
                </div>
              )}
              
              <textarea
                id="description"
                data-testid="description-input"
                value={formData.description || ''}
                onChange={(e) => setFormData({ ...formData, description: e.target.value })}
                placeholder="Enter product description or use AI generation buttons above"
                className="flex min-h-[120px] w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              />
              
              {/* Description Preview */}
              {formData.description && (
                <div className="mt-3">
                  <div className="flex items-center justify-between mb-2">
                    <Label className="text-xs font-medium text-gray-600">Preview</Label>
                    <span className="text-xs text-gray-400">
                      {formData.description.split(' ').length} words
                    </span>
                  </div>
                  <div className="bg-gray-50 border border-gray-200 rounded-lg p-4">
                    <div className="prose prose-sm max-w-none text-gray-700" dangerouslySetInnerHTML={{ 
                      __html: formData.description
                        .replace(/\n\n/g, '</p><p>')
                        .replace(/\n/g, '<br/>')
                        .replace(/^/, '<p>')
                        .replace(/$/, '</p>')
                    }} />
                  </div>
                </div>
              )}
            </div>

            {/* SEO Keywords */}
            <div className="space-y-2 mt-4">
              <Label htmlFor="seo_keywords" data-testid="seo-keywords-label">
                SEO Keywords
                <span className="text-xs text-muted-foreground ml-2">(comma-separated, used for AI description)</span>
              </Label>
              <Input
                id="seo_keywords"
                data-testid="seo-keywords-input"
                value={formData.seo_keywords || ''}
                onChange={(e) => setFormData({ ...formData, seo_keywords: e.target.value })}
                placeholder="e.g., luxury tiles, marble effect, bathroom floor, polished finish"
              />
              <p className="text-xs text-muted-foreground">
                Add keywords to improve search visibility. These will be included in AI-generated descriptions.
              </p>
            </div>

            {/* SEO Alternate Names (Auto-generated from Supplier Product Name) */}
            {formData.supplier_product_name && (
              <div className="space-y-2 mt-4 p-4 bg-gray-50 rounded-lg border border-gray-200">
                <div className="flex items-center justify-between">
                  <Label className="text-sm font-semibold text-gray-700">
                    🔍 Hidden SEO Keywords
                    <span className="text-xs text-muted-foreground ml-2 font-normal">(auto-generated, invisible to customers)</span>
                  </Label>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={handleRegenerateSEO}
                    disabled={regeneratingSEO}
                    className="text-blue-600 hover:bg-blue-50 h-7 text-xs"
                    data-testid="regenerate-seo-btn"
                  >
                    <RefreshCw className={`h-3 w-3 mr-1 ${regeneratingSEO ? 'animate-spin' : ''}`} />
                    Refresh
                  </Button>
                </div>
                <div className="flex flex-wrap gap-2 mt-2">
                  {(formData.seo_alternate_names || []).map((name, idx) => (
                    <span 
                      key={idx} 
                      className="px-2 py-1 bg-white border border-gray-300 rounded text-xs text-gray-600"
                    >
                      {name}
                    </span>
                  ))}
                  {(!formData.seo_alternate_names || formData.seo_alternate_names.length === 0) && (
                    <span className="text-xs text-gray-400 italic">
                      Click "Refresh" to generate SEO keywords from supplier product name
                    </span>
                  )}
                </div>
                <p className="text-xs text-gray-500 mt-2">
                  <strong>How it works:</strong> When customers search for "{formData.supplier_product_name?.split(' ')[0] || 'Supplier Name'}" on Google, 
                  they'll find your product showing as "<strong>{formData.name || 'Your Product Name'}</strong>". 
                  The supplier name is indexed but never visible to customers.
                </p>
              </div>
            )}

            <div className="space-y-2 mt-4">
              <Label htmlFor="category" data-testid="category-label">Category</Label>
              <div className="flex gap-2">
                <select
                  id="category"
                  data-testid="category-select"
                  value={formData.category_id || ''}
                  onChange={(e) => setFormData({ ...formData, category_id: e.target.value })}
                  className="flex h-11 flex-1 rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <option value="">Select a category</option>
                  {categories.map(cat => (
                    <option key={cat.id} value={cat.id}>{cat.name}</option>
                  ))}
                </select>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => setShowNewCategoryDialog(true)}
                  className="h-11 px-3 text-teal-600 border-teal-200 hover:bg-teal-50"
                  title="Create New Category"
                >
                  <FolderPlus className="h-5 w-5" />
                </Button>
              </div>
            </div>

            {/* Colors Section */}
            <div className="space-y-2 mt-4">
              <Label data-testid="colors-label">Color Options</Label>
              <div className="flex gap-2">
                <Input
                  placeholder="Enter color name (e.g., White, Grey, Beige)"
                  value={newColor}
                  onChange={(e) => setNewColor(e.target.value)}
                  onKeyPress={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      if (newColor.trim() && !formData.colors.includes(newColor.trim())) {
                        setFormData({ ...formData, colors: [...formData.colors, newColor.trim()] });
                        setNewColor('');
                      }
                    }
                  }}
                  data-testid="color-input"
                  className="flex-1"
                />
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => {
                    if (newColor.trim() && !formData.colors.includes(newColor.trim())) {
                      setFormData({ ...formData, colors: [...formData.colors, newColor.trim()] });
                      setNewColor('');
                    }
                  }}
                  className="h-11 px-3"
                  data-testid="add-color-button"
                >
                  <Plus className="h-4 w-4 mr-1" /> Add
                </Button>
              </div>
              {formData.colors.length > 0 && (
                <div className="flex flex-wrap gap-2 mt-2">
                  {formData.colors.map((color, index) => (
                    <span
                      key={index}
                      className="inline-flex items-center gap-1 px-3 py-1 rounded-full bg-gray-100 text-sm"
                      data-testid={`color-tag-${index}`}
                    >
                      <span 
                        className="w-3 h-3 rounded-full border border-gray-300"
                        style={{ backgroundColor: color.toLowerCase() }}
                      />
                      {color}
                      <button
                        type="button"
                        onClick={() => setFormData({ 
                          ...formData, 
                          colors: formData.colors.filter((_, i) => i !== index) 
                        })}
                        className="ml-1 text-gray-500 hover:text-red-500"
                        data-testid={`remove-color-${index}`}
                      >
                        <X className="h-3 w-3" />
                      </button>
                    </span>
                  ))}
                </div>
              )}
              <p className="text-xs text-muted-foreground">Add available color options for this product</p>
            </div>
          </div>

          {/* Specifications Section - Matches Bulk Category Editor layout */}
          <div className="border border-border rounded-lg p-6 bg-gradient-to-br from-gray-50 to-slate-50">
            <h2 className="text-lg font-heading font-bold mb-4 flex items-center gap-2">
              <Grid3X3 className="h-5 w-5 text-gray-600" />
              Specifications
            </h2>
            
            {/* Row 1: Material & Finish */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
              {/* Material */}
              <div className="space-y-2">
                <Label htmlFor="material">Material</Label>
                <select
                  id="material"
                  data-testid="material-select"
                  value={formData.material || ''}
                  onChange={(e) => setFormData({ ...formData, material: e.target.value })}
                  className="flex h-11 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <option value="">Select material</option>
                  <option value="Porcelain">Porcelain</option>
                  <option value="Ceramic">Ceramic</option>
                  <option value="Natural Stone">Natural Stone</option>
                  <option value="Marble">Marble</option>
                  <option value="Travertine">Travertine</option>
                  <option value="Slate">Slate</option>
                  <option value="Limestone">Limestone</option>
                  <option value="Granite">Granite</option>
                  <option value="Glass">Glass</option>
                  <option value="Terracotta">Terracotta</option>
                  <option value="Quarry">Quarry</option>
                  <option value="Encaustic">Encaustic</option>
                  <option value="Mosaic">Mosaic</option>
                  <option value="SPC">SPC (Stone Plastic Composite)</option>
                  <option value="LVT">LVT (Luxury Vinyl Tile)</option>
                  <option value="Quartz">Quartz</option>
                </select>
              </div>

              {/* Finish */}
              <div className="space-y-2">
                <Label htmlFor="finish">Finish</Label>
                <select
                  id="finish"
                  data-testid="finish-select"
                  value={formData.finish || ''}
                  onChange={(e) => setFormData({ ...formData, finish: e.target.value })}
                  className="flex h-11 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <option value="">Select finish</option>
                  <option value="Polished">Polished</option>
                  <option value="Matt">Matt</option>
                  <option value="Satin">Satin</option>
                  <option value="Lappato">Lappato</option>
                  <option value="Honed">Honed</option>
                  <option value="Textured">Textured</option>
                  <option value="Natural">Natural</option>
                  <option value="Gloss">Gloss</option>
                  <option value="Satin Matt">Satin Matt</option>
                  <option value="Anti-Slip">Anti-Slip</option>
                </select>
              </div>
            </div>

            {/* Row 2: Edge & Slip Rating */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
              {/* Edge */}
              <div className="space-y-2">
                <Label htmlFor="edge">Edge</Label>
                <select
                  id="edge"
                  data-testid="edge-select"
                  value={formData.edge || ''}
                  onChange={(e) => setFormData({ ...formData, edge: e.target.value })}
                  className="flex h-11 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <option value="">Select edge</option>
                  <option value="Rectified">Rectified</option>
                  <option value="Cushion Edge">Cushion Edge</option>
                  <option value="Bevelled">Bevelled</option>
                  <option value="Pressed Edge">Pressed Edge</option>
                  <option value="Natural Edge">Natural Edge</option>
                  <option value="Non Rectified">Non Rectified</option>
                </select>
              </div>

              {/* Slip Rating */}
              <div className="space-y-2">
                <Label htmlFor="slip_rating">Slip Rating</Label>
                <select
                  id="slip_rating"
                  data-testid="slip-rating-select"
                  value={formData.slip_rating || ''}
                  onChange={(e) => setFormData({ ...formData, slip_rating: e.target.value })}
                  className="flex h-11 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <option value="">Select slip rating</option>
                  <option value="R9">R9</option>
                  <option value="R10">R10</option>
                  <option value="R11">R11</option>
                  <option value="R12">R12</option>
                  <option value="R13">R13</option>
                  <option value="PEI 1">PEI 1</option>
                  <option value="PEI 2">PEI 2</option>
                  <option value="PEI 3">PEI 3</option>
                  <option value="PEI 4">PEI 4</option>
                  <option value="PEI 5">PEI 5</option>
                  <option value="PTV 36+">PTV 36+</option>
                  <option value="Not Rated">Not Rated</option>
                </select>
              </div>
            </div>

            {/* Row 3: Thickness & Suitability */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
              {/* Thickness */}
              <div className="space-y-2">
                <Label htmlFor="thickness">Thickness</Label>
                <select
                  id="thickness"
                  data-testid="thickness-select"
                  value={formData.thickness || ''}
                  onChange={(e) => setFormData({ ...formData, thickness: e.target.value })}
                  className="flex h-11 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <option value="">Select thickness</option>
                  <option value="6mm">6mm</option>
                  <option value="8mm">8mm</option>
                  <option value="9mm">9mm</option>
                  <option value="10mm">10mm</option>
                  <option value="11mm">11mm</option>
                  <option value="12mm">12mm</option>
                  <option value="14mm">14mm</option>
                  <option value="20mm">20mm</option>
                </select>
              </div>

              {/* Suitability */}
              <div className="space-y-2">
                <Label htmlFor="suitability">Suitability</Label>
                <select
                  id="suitability"
                  data-testid="suitability-select"
                  value={formData.suitability || ''}
                  onChange={(e) => setFormData({ ...formData, suitability: e.target.value })}
                  className="flex h-11 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <option value="">Select suitability</option>
                  <option value="Wall">Wall</option>
                  <option value="Floor">Floor</option>
                  <option value="Wall & Floor">Wall & Floor</option>
                  <option value="Outdoor">Outdoor</option>
                  <option value="Indoor & Outdoor">Indoor & Outdoor</option>
                </select>
              </div>
            </div>

            {/* Row 4: Underfloor Heating & Country of Origin */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
              {/* Underfloor Heating */}
              <div className="space-y-2">
                <Label>Underfloor Heating Suitable</Label>
                <div className="flex items-center gap-3 h-11">
                  <button
                    type="button"
                    onClick={() => setFormData({ ...formData, underfloor_heating: true })}
                    className={`px-4 py-2 rounded-lg text-sm font-medium transition-all ${
                      formData.underfloor_heating === true
                        ? 'bg-green-500 text-white'
                        : 'bg-gray-100 text-gray-700 hover:bg-gray-200 border border-gray-200'
                    }`}
                    data-testid="underfloor-heating-yes"
                  >
                    Yes
                  </button>
                  <button
                    type="button"
                    onClick={() => setFormData({ ...formData, underfloor_heating: false })}
                    className={`px-4 py-2 rounded-lg text-sm font-medium transition-all ${
                      formData.underfloor_heating === false
                        ? 'bg-gray-500 text-white'
                        : 'bg-gray-100 text-gray-700 hover:bg-gray-200 border border-gray-200'
                    }`}
                    data-testid="underfloor-heating-no"
                  >
                    No
                  </button>
                </div>
              </div>

              {/* Country of Origin */}
              <div className="space-y-2">
                <Label htmlFor="made_in">Country of Origin</Label>
                <select
                  id="made_in"
                  data-testid="made-in-select"
                  value={formData.made_in || ''}
                  onChange={(e) => setFormData({ ...formData, made_in: e.target.value })}
                  className="flex h-11 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <option value="">Select country</option>
                  {(productOptions?.countries || [
                    { id: 'Italy', label: '🇮🇹 Italy' },
                    { id: 'Spain', label: '🇪🇸 Spain' },
                    { id: 'Europe', label: '🇪🇺 Europe' },
                    { id: 'Poland', label: '🇵🇱 Poland' },
                    { id: 'India', label: '🇮🇳 India' },
                    { id: 'China', label: '🇨🇳 China' },
                    { id: 'Turkey', label: '🇹🇷 Turkey' },
                    { id: 'Portugal', label: '🇵🇹 Portugal' },
                    { id: 'UK', label: '🇬🇧 UK' },
                    { id: 'Morocco', label: '🇲🇦 Morocco' },
                    { id: 'Vietnam', label: '🇻🇳 Vietnam' },
                    { id: 'Brazil', label: '🇧🇷 Brazil' }
                  ]).map(country => (
                    <option key={country.id} value={country.id}>{country.label}</option>
                  ))}
                </select>
              </div>
            </div>

            {/* Row 5: Size, Series, Type */}
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              {/* Size */}
              <div className="space-y-2">
                <Label htmlFor="size">Size</Label>
                <Input
                  id="size"
                  data-testid="size-input"
                  value={formData.size || ''}
                  onChange={(e) => setFormData({ ...formData, size: e.target.value })}
                  placeholder="e.g., 60x60cm, 30x60cm"
                />
              </div>

              {/* Series */}
              <div className="space-y-2">
                <Label htmlFor="series">Series</Label>
                <Input
                  id="series"
                  data-testid="series-input"
                  value={formData.series || ''}
                  onChange={(e) => setFormData({ ...formData, series: e.target.value })}
                  placeholder="e.g., Calacatta, Nordic"
                  list="series-suggestions"
                />
                <datalist id="series-suggestions">
                  <option value="Calacatta" />
                  <option value="Carrara" />
                  <option value="Statuario" />
                  <option value="Nordic" />
                  <option value="Urban" />
                  <option value="Terra" />
                  <option value="Onyx" />
                  <option value="Terrazzo" />
                  <option value="Wood Effect" />
                  <option value="Stone Effect" />
                </datalist>
              </div>

              {/* Type */}
              <div className="space-y-2">
                <Label htmlFor="type">Type</Label>
                <select
                  id="type"
                  data-testid="type-select"
                  value={formData.type || ''}
                  onChange={(e) => setFormData({ ...formData, type: e.target.value })}
                  className="flex h-11 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <option value="">Select type</option>
                  <option value="Floor Tile">Floor Tile</option>
                  <option value="Wall Tile">Wall Tile</option>
                  <option value="Wall & Floor Tile">Wall & Floor Tile</option>
                  <option value="Feature Tile">Feature Tile</option>
                  <option value="Mosaic">Mosaic</option>
                  <option value="Border">Border</option>
                  <option value="Decor">Decor</option>
                  <option value="Outdoor Tile">Outdoor Tile</option>
                  <option value="Splashback">Splashback</option>
                  <option value="SPC Flooring">SPC Flooring</option>
                  <option value="LVT Flooring">LVT Flooring</option>
                  <option value="Natural Stone Splitface">Natural Stone Splitface</option>
                  <option value="Cladding">Cladding</option>
                  <option value="Accessories">Accessories</option>
                  <option value="Essentials">Essentials</option>
                </select>
              </div>
            </div>
          </div>

          {/* Website Categories Section */}
          <div className="border border-border rounded-lg p-6 bg-gradient-to-br from-purple-50 to-blue-50">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-lg font-heading font-bold flex items-center gap-2">
                <Globe className="h-5 w-5 text-purple-600" />
                Website Categories
              </h2>
              <div className="flex items-center gap-6">
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={formData.is_featured || false}
                    onChange={(e) => setFormData({ ...formData, is_featured: e.target.checked })}
                    className="w-5 h-5 rounded border-gray-300 text-yellow-500 focus:ring-yellow-500"
                    data-testid="is-featured-checkbox"
                  />
                  <span className="text-sm font-medium flex items-center gap-1">
                    <Star className="w-4 h-4 text-yellow-500" />
                    Featured on Homepage
                  </span>
                </label>
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={formData.show_on_website || false}
                    onChange={(e) => setFormData({ ...formData, show_on_website: e.target.checked })}
                    className="w-5 h-5 rounded border-gray-300 text-purple-600 focus:ring-purple-500"
                    data-testid="show-on-website-checkbox"
                  />
                  <span className="text-sm font-medium">Show on Website</span>
                </label>
              </div>
            </div>
            <p className="text-sm text-muted-foreground mb-6">
              Select multiple categories to help customers find this product. The product will appear in all selected categories on your e-commerce website.
            </p>

            {/* ===== MAIN CATEGORIES SECTION (SYNCS WITH BULK CATEGORY EDITOR) ===== */}
            <div className="mb-6 p-4 bg-white rounded-lg border border-purple-200">
              <h3 className="text-sm font-bold text-gray-800 mb-3 flex items-center gap-2">
                <Layers className="w-4 h-4 text-purple-600" />
                Main Categories
                <span className="text-xs font-normal text-gray-400">(select one)</span>
              </h3>
              
              <div className="flex flex-wrap gap-2">
                {(productOptions.main_categories || []).map(opt => {
                  const optLabel = typeof opt === 'string' ? opt : opt.label;
                  const optId = typeof opt === 'string' ? opt : opt.id;
                  return (
                    <button
                      key={optId}
                      type="button"
                      onClick={() => setFormData(prev => ({
                        ...prev,
                        main_category: prev.main_category === optLabel ? '' : optLabel
                      }))}
                      className={`px-3 py-2 rounded-lg text-sm font-medium transition-all ${
                        formData.main_category === optLabel
                          ? 'bg-purple-600 text-white shadow-md ring-2 ring-purple-300'
                          : 'bg-gray-100 text-gray-700 hover:bg-purple-50 hover:text-purple-700 border border-gray-200'
                      }`}
                      data-testid={`main-category-${optId}`}
                    >
                      {formData.main_category === optLabel && <Check className="w-4 h-4 inline mr-1" />}
                      {optLabel}
                    </button>
                  );
                })}
              </div>
            </div>

            {/* ===== SUB-CATEGORIES SECTION (SYNCS WITH BULK CATEGORY EDITOR) ===== */}
            <div className="mb-6 p-4 bg-white rounded-lg border border-indigo-200">
              <h3 className="text-sm font-bold text-gray-800 mb-3 flex items-center gap-2">
                <Tag className="w-4 h-4 text-indigo-600" />
                Sub-Categories
                <span className="text-xs font-normal text-gray-400">(select multiple)</span>
                {formData.sub_categories?.length > 0 && (
                  <span className="text-indigo-600 font-medium">({formData.sub_categories.length} selected)</span>
                )}
              </h3>
              
              <div className="flex flex-wrap gap-2">
                {(productOptions.sub_categories || []).map(opt => {
                  const optLabel = typeof opt === 'string' ? opt : opt.label;
                  const optId = typeof opt === 'string' ? opt : opt.id;
                  const isSelected = formData.sub_categories?.includes(optLabel);
                  return (
                    <button
                      key={optId}
                      type="button"
                      onClick={() => {
                        setFormData(prev => ({
                          ...prev,
                          sub_categories: isSelected
                            ? prev.sub_categories.filter(c => c !== optLabel)
                            : [...(prev.sub_categories || []), optLabel]
                        }));
                      }}
                      className={`px-2.5 py-1.5 rounded-lg text-xs font-medium transition-all ${
                        isSelected
                          ? 'bg-indigo-600 text-white shadow-md'
                          : 'bg-gray-100 text-gray-700 hover:bg-indigo-50 hover:text-indigo-700'
                      }`}
                      data-testid={`sub-category-${optId}`}
                    >
                      {isSelected && <Check className="w-3 h-3 inline mr-1" />}
                      {optLabel}
                    </button>
                  );
                })}
              </div>
              
              {formData.sub_categories?.length > 0 && (
                <button
                  type="button"
                  onClick={() => setFormData(prev => ({ ...prev, sub_categories: [] }))}
                  className="text-xs text-red-500 hover:text-red-700 mt-2"
                >
                  Clear all sub-categories
                </button>
              )}
            </div>

            {/* Quick Categorize Feature */}
            <div className="mb-6 p-4 bg-white rounded-lg border border-purple-200">
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-2">
                  <Wand2 className="h-4 w-4 text-purple-600" />
                  <span className="text-sm font-semibold text-purple-700">Quick Categorize</span>
                </div>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={generateQuickSuggestions}
                  disabled={!formData.name}
                  className="h-8 px-3 text-purple-600 border-purple-300 hover:bg-purple-50 hover:border-purple-400"
                  data-testid="quick-categorize-button"
                >
                  <Sparkles className="h-3.5 w-3.5 mr-1.5" />
                  Suggest Categories
                </Button>
              </div>
              <p className="text-xs text-gray-500 mb-3">
                Automatically suggests categories based on keywords in the product name. Click &quot;Suggest Categories&quot; to get started.
              </p>
              
              {/* Show suggestions when available */}
              {showQuickSuggestions && (
                <div className="mt-3 pt-3 border-t border-purple-100">
                  {quickSuggestions.length > 0 ? (
                    <>
                      <div className="flex items-center justify-between mb-2">
                        <span className="text-xs font-medium text-purple-600">
                          Found {quickSuggestions.length} suggestion{quickSuggestions.length !== 1 ? 's' : ''} based on &quot;{formData.name}&quot;
                        </span>
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          onClick={applyAllSuggestions}
                          className="h-7 px-2 text-xs text-purple-600 hover:bg-purple-100"
                          data-testid="apply-all-suggestions-button"
                        >
                          <Check className="h-3 w-3 mr-1" />
                          Apply All
                        </Button>
                      </div>
                      <div className="flex flex-wrap gap-2" data-testid="quick-suggestions-container">
                        {quickSuggestions.map((suggestion, idx) => (
                          <button
                            key={`${suggestion.categoryType}-${suggestion.categoryId}`}
                            type="button"
                            onClick={() => applySuggestion(suggestion)}
                            className={`px-3 py-1.5 rounded-full text-xs font-medium ${suggestion.color} text-white shadow-sm hover:shadow-md transition-all flex items-center gap-1.5 animate-pulse-once`}
                            data-testid={`suggestion-${suggestion.categoryId}`}
                            title={`Matched keyword: "${suggestion.matchedKeyword}"`}
                          >
                            <Plus className="w-3 h-3" />
                            {suggestion.label}
                          </button>
                        ))}
                      </div>
                      <p className="text-xs text-gray-400 mt-2">
                        Click a suggestion to add it, or &quot;Apply All&quot; to add all at once.
                      </p>
                    </>
                  ) : (
                    <div className="text-center py-2">
                      <p className="text-sm text-gray-500">
                        {formData.name ? 'No new suggestions found. Categories may already be selected or no matching keywords detected.' : 'Enter a product name first to get suggestions.'}
                      </p>
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* Room/Location Categories */}
            <div className="mb-6">
              <Label className="text-sm font-semibold text-gray-700 mb-3 block">
                Room / Location <span className="text-muted-foreground font-normal">(select all that apply)</span>
              </Label>
              <div className="flex flex-wrap gap-2">
                {WEBSITE_CATEGORY_OPTIONS.rooms.map(option => (
                  <button
                    key={option.id}
                    type="button"
                    onClick={() => toggleWebsiteCategory('rooms', option.id)}
                    data-testid={`room-${option.id}`}
                    className={`px-3 py-1.5 rounded-full text-sm font-medium transition-all flex items-center gap-1.5 ${
                      isCategorySelected('rooms', option.id)
                        ? `${option.color} text-white shadow-md ring-2 ring-offset-1 ring-gray-400`
                        : 'bg-white border border-gray-300 text-gray-700 hover:border-gray-400 hover:bg-gray-50'
                    }`}
                  >
                    {isCategorySelected('rooms', option.id) && <Check className="w-3 h-3" />}
                    {option.label}
                    {option.custom && <span className="text-xs opacity-70">(custom)</span>}
                  </button>
                ))}
                <button
                  type="button"
                  onClick={() => openAddOptionModal('rooms')}
                  className="px-3 py-1.5 rounded-full text-sm font-medium border-2 border-dashed border-gray-300 text-gray-500 hover:border-purple-400 hover:text-purple-600 transition-all flex items-center gap-1"
                  data-testid="add-room-option"
                >
                  <Plus className="w-3 h-3" />
                  Add New
                </button>
              </div>
            </div>

            {/* Material Categories */}
            <div className="mb-6">
              <Label className="text-sm font-semibold text-gray-700 mb-3 block">
                Material <span className="text-muted-foreground font-normal">(select all that apply)</span>
              </Label>
              <div className="flex flex-wrap gap-2">
                {WEBSITE_CATEGORY_OPTIONS.materials?.map(option => (
                  <button
                    key={option.id}
                    type="button"
                    onClick={() => toggleWebsiteCategory('materials', option.id)}
                    data-testid={`material-${option.id}`}
                    className={`px-3 py-1.5 rounded-full text-sm font-medium transition-all flex items-center gap-1.5 ${
                      isCategorySelected('materials', option.id)
                        ? `${option.color} text-white shadow-md ring-2 ring-offset-1 ring-gray-400`
                        : 'bg-white border border-gray-300 text-gray-700 hover:border-gray-400 hover:bg-gray-50'
                    }`}
                  >
                    {isCategorySelected('materials', option.id) && <Check className="w-3 h-3" />}
                    {option.label}
                    {option.custom && <span className="text-xs opacity-70">(custom)</span>}
                  </button>
                ))}
                <button
                  type="button"
                  onClick={() => openAddOptionModal('materials')}
                  className="px-3 py-1.5 rounded-full text-sm font-medium border-2 border-dashed border-gray-300 text-gray-500 hover:border-purple-400 hover:text-purple-600 transition-all flex items-center gap-1"
                  data-testid="add-material-option"
                >
                  <Plus className="w-3 h-3" />
                  Add New
                </button>
              </div>
            </div>

            {/* Style/Effect Categories */}
            <div className="mb-6">
              <Label className="text-sm font-semibold text-gray-700 mb-3 block">
                Style / Effect <span className="text-muted-foreground font-normal">(select all that apply)</span>
              </Label>
              <div className="flex flex-wrap gap-2">
                {WEBSITE_CATEGORY_OPTIONS.styles.map(option => (
                  <button
                    key={option.id}
                    type="button"
                    onClick={() => toggleWebsiteCategory('styles', option.id)}
                    data-testid={`style-${option.id}`}
                    className={`px-3 py-1.5 rounded-full text-sm font-medium transition-all flex items-center gap-1.5 ${
                      isCategorySelected('styles', option.id)
                        ? `${option.color} text-white shadow-md ring-2 ring-offset-1 ring-gray-400`
                        : 'bg-white border border-gray-300 text-gray-700 hover:border-gray-400 hover:bg-gray-50'
                    }`}
                  >
                    {isCategorySelected('styles', option.id) && <Check className="w-3 h-3" />}
                    {option.label}
                    {option.custom && <span className="text-xs opacity-70">(custom)</span>}
                  </button>
                ))}
                <button
                  type="button"
                  onClick={() => openAddOptionModal('styles')}
                  className="px-3 py-1.5 rounded-full text-sm font-medium border-2 border-dashed border-gray-300 text-gray-500 hover:border-purple-400 hover:text-purple-600 transition-all flex items-center gap-1"
                  data-testid="add-style-option"
                >
                  <Plus className="w-3 h-3" />
                  Add New
                </button>
              </div>
            </div>

            {/* Color Categories */}
            <div className="mb-6">
              <Label className="text-sm font-semibold text-gray-700 mb-3 block">
                Color <span className="text-muted-foreground font-normal">(select all that apply)</span>
              </Label>
              <div className="flex flex-wrap gap-2">
                {WEBSITE_CATEGORY_OPTIONS.colors.map(option => (
                  <button
                    key={option.id}
                    type="button"
                    onClick={() => toggleWebsiteCategory('colors', option.id)}
                    data-testid={`color-${option.id}`}
                    className={`px-3 py-1.5 rounded-full text-sm font-medium transition-all flex items-center gap-1.5 ${
                      isCategorySelected('colors', option.id)
                        ? `${option.color} ${option.id === 'white' || option.id === 'cream' ? 'text-gray-800' : 'text-white'} shadow-md ring-2 ring-offset-1 ring-purple-400`
                        : 'bg-white border border-gray-300 text-gray-700 hover:border-gray-400 hover:bg-gray-50'
                    }`}
                  >
                    {isCategorySelected('colors', option.id) && <Check className="w-3 h-3" />}
                    <span className={`w-3 h-3 rounded-full ${option.color} ${!isCategorySelected('colors', option.id) ? 'mr-1' : ''}`}></span>
                    {option.label}
                    {option.custom && <span className="text-xs opacity-70">(custom)</span>}
                  </button>
                ))}
                <button
                  type="button"
                  onClick={() => openAddOptionModal('colors')}
                  className="px-3 py-1.5 rounded-full text-sm font-medium border-2 border-dashed border-gray-300 text-gray-500 hover:border-purple-400 hover:text-purple-600 transition-all flex items-center gap-1"
                  data-testid="add-color-option"
                >
                  <Plus className="w-3 h-3" />
                  Add New
                </button>
              </div>
            </div>

            {/* Finish Categories */}
            <div className="mb-6">
              <Label className="text-sm font-semibold text-gray-700 mb-3 block">
                Finish <span className="text-muted-foreground font-normal">(select all that apply)</span>
              </Label>
              <div className="flex flex-wrap gap-2">
                {WEBSITE_CATEGORY_OPTIONS.finishes?.map(option => (
                  <button
                    key={option.id}
                    type="button"
                    onClick={() => toggleWebsiteCategory('finishes', option.id)}
                    data-testid={`finish-${option.id}`}
                    className={`px-3 py-1.5 rounded-full text-sm font-medium transition-all flex items-center gap-1.5 ${
                      isCategorySelected('finishes', option.id)
                        ? `${option.color} text-white shadow-md ring-2 ring-offset-1 ring-gray-400`
                        : 'bg-white border border-gray-300 text-gray-700 hover:border-gray-400 hover:bg-gray-50'
                    }`}
                  >
                    {isCategorySelected('finishes', option.id) && <Check className="w-3 h-3" />}
                    {option.label}
                    {option.custom && <span className="text-xs opacity-70">(custom)</span>}
                  </button>
                ))}
                <button
                  type="button"
                  onClick={() => openAddOptionModal('finishes')}
                  className="px-3 py-1.5 rounded-full text-sm font-medium border-2 border-dashed border-gray-300 text-gray-500 hover:border-purple-400 hover:text-purple-600 transition-all flex items-center gap-1"
                  data-testid="add-finish-option"
                >
                  <Plus className="w-3 h-3" />
                  Add New
                </button>
              </div>
            </div>

            {/* Features */}
            <div className="mb-4">
              <Label className="text-sm font-semibold text-gray-700 mb-3 block">
                Special Features <span className="text-muted-foreground font-normal">(select all that apply)</span>
              </Label>
              <div className="flex flex-wrap gap-2">
                {WEBSITE_CATEGORY_OPTIONS.features.map(option => (
                  <button
                    key={option.id}
                    type="button"
                    onClick={() => toggleWebsiteCategory('features', option.id)}
                    data-testid={`feature-${option.id}`}
                    className={`px-3 py-1.5 rounded-full text-sm font-medium transition-all flex items-center gap-1.5 ${
                      isCategorySelected('features', option.id)
                        ? `${option.color} text-white shadow-md ring-2 ring-offset-1 ring-gray-400`
                        : 'bg-white border border-gray-300 text-gray-700 hover:border-gray-400 hover:bg-gray-50'
                    }`}
                  >
                    {isCategorySelected('features', option.id) && <Check className="w-3 h-3" />}
                    {option.label}
                    {option.custom && <span className="text-xs opacity-70">(custom)</span>}
                  </button>
                ))}
                <button
                  type="button"
                  onClick={() => openAddOptionModal('features')}
                  className="px-3 py-1.5 rounded-full text-sm font-medium border-2 border-dashed border-gray-300 text-gray-500 hover:border-purple-400 hover:text-purple-600 transition-all flex items-center gap-1"
                  data-testid="add-feature-option"
                >
                  <Plus className="w-3 h-3" />
                  Add New
                </button>
              </div>
            </div>

            {/* Summary of selections */}
            {(formData.website_categories?.rooms?.length > 0 || 
              formData.website_categories?.materials?.length > 0 ||
              formData.website_categories?.styles?.length > 0 || 
              formData.website_categories?.colors?.length > 0 || 
              formData.website_categories?.finishes?.length > 0 ||
              formData.website_categories?.features?.length > 0) && (
              <div className="mt-6 p-4 bg-white rounded-lg border border-purple-200">
                <p className="text-xs font-semibold text-purple-700 mb-2">PRODUCT WILL APPEAR IN:</p>
                <div className="flex flex-wrap gap-1">
                  {formData.website_categories?.rooms?.map(id => {
                    const opt = WEBSITE_CATEGORY_OPTIONS.rooms.find(o => o.id === id);
                    return opt ? <span key={id} className="px-2 py-0.5 bg-purple-100 text-purple-700 rounded text-xs">{opt.label}</span> : null;
                  })}
                  {formData.website_categories?.materials?.map(id => {
                    const opt = WEBSITE_CATEGORY_OPTIONS.materials?.find(o => o.id === id);
                    return opt ? <span key={id} className="px-2 py-0.5 bg-blue-100 text-blue-700 rounded text-xs">{opt.label}</span> : null;
                  })}
                  {formData.website_categories?.styles?.map(id => {
                    const opt = WEBSITE_CATEGORY_OPTIONS.styles.find(o => o.id === id);
                    return opt ? <span key={id} className="px-2 py-0.5 bg-indigo-100 text-indigo-700 rounded text-xs">{opt.label}</span> : null;
                  })}
                  {formData.website_categories?.colors?.map(id => {
                    const opt = WEBSITE_CATEGORY_OPTIONS.colors.find(o => o.id === id);
                    return opt ? <span key={id} className="px-2 py-0.5 bg-gray-100 text-gray-700 rounded text-xs">{opt.label}</span> : null;
                  })}
                  {formData.website_categories?.finishes?.map(id => {
                    const opt = WEBSITE_CATEGORY_OPTIONS.finishes?.find(o => o.id === id);
                    return opt ? <span key={id} className="px-2 py-0.5 bg-amber-100 text-amber-700 rounded text-xs">{opt.label}</span> : null;
                  })}
                  {formData.website_categories?.features?.map(id => {
                    const opt = WEBSITE_CATEGORY_OPTIONS.features.find(o => o.id === id);
                    return opt ? <span key={id} className="px-2 py-0.5 bg-green-100 text-green-700 rounded text-xs">{opt.label}</span> : null;
                  })}
                </div>
              </div>
            )}
          </div>

          {/* Images Section */}
          <div>
            <h2 className="text-lg font-heading font-bold mb-4 flex items-center gap-2">
              <Image className="h-5 w-5" />
              Product Images
            </h2>
            
            {/* Upload from device */}
            <div className="mb-4">
              <input
                type="file"
                ref={fileInputRef}
                onChange={handleFileUpload}
                accept="image/*"
                multiple
                className="hidden"
                id="image-upload"
                data-testid="image-file-input"
              />
              <label
                htmlFor="image-upload"
                className={`flex items-center justify-center gap-2 w-full p-6 border-2 border-dashed rounded-lg cursor-pointer transition-colors ${
                  uploading 
                    ? 'border-gray-300 bg-gray-50 cursor-not-allowed' 
                    : 'border-gray-300 hover:border-primary hover:bg-primary/5'
                }`}
              >
                {uploading ? (
                  <>
                    <div className="animate-spin rounded-full h-5 w-5 border-b-2 border-primary"></div>
                    <span className="text-muted-foreground">Uploading...</span>
                  </>
                ) : (
                  <>
                    <Upload className="h-6 w-6 text-muted-foreground" />
                    <span className="text-muted-foreground">
                      <span className="font-medium text-primary">Click to upload</span> or drag and drop
                    </span>
                  </>
                )}
              </label>
              <p className="text-xs text-muted-foreground mt-1 text-center">
                Supports: JPG, PNG, GIF, WEBP (max 10MB each)
              </p>
            </div>

            {/* Or add by URL */}
            <div className="relative mb-4">
              <div className="absolute inset-0 flex items-center">
                <div className="w-full border-t border-gray-200"></div>
              </div>
              <div className="relative flex justify-center">
                <span className="px-3 bg-white text-xs text-muted-foreground">or add by URL</span>
              </div>
            </div>

            <div className="flex gap-2">
              <Input
                placeholder="Enter image URL"
                value={newImageUrl}
                onChange={(e) => setNewImageUrl(e.target.value)}
                onKeyPress={(e) => e.key === 'Enter' && (e.preventDefault(), addImage())}
                data-testid="image-url-input"
                className="flex-1"
              />
              <Button type="button" onClick={addImage} variant="outline" data-testid="add-image-button">
                <Plus className="h-4 w-4 mr-1" /> Add
              </Button>
            </div>
            
            {formData.images.length > 0 && (
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mt-4">
                {formData.images.map((img, index) => (
                  <div key={index} className="relative group" data-testid={`image-preview-${index}`}>
                    <img 
                      src={img} 
                      alt={`Product ${index + 1}`} 
                      className="w-full h-32 object-cover rounded-md border border-border"
                      onError={(e) => {
                        e.target.src = 'https://via.placeholder.com/150?text=Invalid+URL';
                      }}
                    />
                    <button
                      type="button"
                      onClick={() => removeImage(index)}
                      className="absolute top-1 right-1 bg-red-500 text-white p-1 rounded-full opacity-0 group-hover:opacity-100 transition-opacity"
                      data-testid={`remove-image-${index}`}
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Tile Size Section */}
          <div className="border border-border rounded-lg p-6 bg-blue-50/50">
            <h2 className="text-lg font-heading font-bold mb-4 flex items-center gap-2">
              <Ruler className="h-5 w-5 text-blue-600" />
              Tile Size & Box Configuration
            </h2>
            <p className="text-sm text-muted-foreground mb-4">
              Enter tile dimensions and box quantity to auto-calculate m² on invoices. Example: 30x60cm tile = 0.18m² per piece
            </p>
            
            {/* Warning Banner for Suspicious Dimensions */}
            {tileDimensionWarning && (
              <div className={`mb-4 p-4 rounded-lg border-2 ${
                tileDimensionWarning.type === 'error' 
                  ? 'bg-red-50 border-red-300 text-red-800' 
                  : 'bg-yellow-50 border-yellow-300 text-yellow-800'
              }`}>
                <div className="flex items-start gap-3">
                  <span className="text-2xl">{tileDimensionWarning.type === 'error' ? '🚨' : '⚠️'}</span>
                  <div className="flex-1">
                    <p className="font-medium">{tileDimensionWarning.message}</p>
                    {tileDimensionWarning.suggestedWidth && (
                      <button
                        type="button"
                        onClick={() => setFormData(prev => ({
                          ...prev,
                          tile_width: tileDimensionWarning.suggestedWidth.toString(),
                          tile_height: tileDimensionWarning.suggestedHeight.toString()
                        }))}
                        className="mt-2 px-3 py-1 bg-white border border-current rounded-md text-sm font-medium hover:bg-gray-50"
                      >
                        Click to fix: Use {tileDimensionWarning.suggestedWidth}x{tileDimensionWarning.suggestedHeight}cm instead
                      </button>
                    )}
                  </div>
                </div>
              </div>
            )}
            
            <div className="grid grid-cols-1 md:grid-cols-5 gap-6 items-end">
              <div className="space-y-2">
                <Label htmlFor="tile_width" data-testid="tile-width-label">Tile Width (cm)</Label>
                <Input
                  id="tile_width"
                  data-testid="tile-width-input"
                  type="number"
                  step="0.1"
                  value={formData.tile_width}
                  onChange={(e) => handleTileDimensionChange('tile_width', e.target.value)}
                  placeholder="e.g., 30"
                  min="0"
                  max="200"
                  className={tileDimensionWarning?.type === 'error' ? 'border-red-500 bg-red-50' : ''}
                />
                <p className="text-xs text-gray-500">Common: 30, 60, 75, 120cm</p>
              </div>
              
              <div className="space-y-2">
                <Label htmlFor="tile_height" data-testid="tile-height-label">Tile Height (cm)</Label>
                <Input
                  id="tile_height"
                  data-testid="tile-height-input"
                  type="number"
                  step="0.1"
                  value={formData.tile_height}
                  onChange={(e) => handleTileDimensionChange('tile_height', e.target.value)}
                  placeholder="e.g., 60"
                  min="0"
                  max="200"
                  className={tileDimensionWarning?.type === 'error' ? 'border-red-500 bg-red-50' : ''}
                />
                <p className="text-xs text-gray-500">Common: 30, 60, 90, 120cm</p>
              </div>
              
              <div className="space-y-2">
                <Label htmlFor="tiles_per_box" data-testid="tiles-per-box-label">Tiles per Box</Label>
                <Input
                  id="tiles_per_box"
                  data-testid="tiles-per-box-input"
                  type="number"
                  value={formData.tiles_per_box}
                  onChange={(e) => setFormData({ ...formData, tiles_per_box: e.target.value })}
                  placeholder="e.g., 6"
                  min="1"
                />
              </div>
              
              <div className="space-y-2">
                <Label>m² per Piece</Label>
                <div className="h-11 px-3 flex items-center border rounded-md bg-white font-semibold">
                  {tileM2PerPiece ? (
                    <span className="text-green-600">{tileM2PerPiece} m²</span>
                  ) : (
                    <span className="text-muted-foreground text-xs">Enter dimensions</span>
                  )}
                </div>
              </div>
              
              <div className="space-y-2">
                <Label>Box Coverage</Label>
                <div className="h-11 px-3 flex items-center border rounded-md bg-white font-semibold">
                  {boxM2Coverage ? (
                    <span className="text-blue-600">{boxM2Coverage} m²/box</span>
                  ) : (
                    <span className="text-muted-foreground text-xs">Enter box qty</span>
                  )}
                </div>
              </div>
            </div>
            
            {/* Box Summary */}
            {formData.tiles_per_box && boxM2Coverage && boxPrice && (
              <div className="mt-4 p-4 bg-white rounded-lg border-2 border-blue-200">
                <div className="flex flex-wrap gap-6 text-sm">
                  <div>
                    <span className="text-muted-foreground">Tiles per box:</span>
                    <span className="ml-2 font-bold">{formData.tiles_per_box} pcs</span>
                  </div>
                  <div>
                    <span className="text-muted-foreground">Box coverage:</span>
                    <span className="ml-2 font-bold text-blue-600">{boxM2Coverage} m²</span>
                  </div>
                  <div>
                    <span className="text-muted-foreground">Box price:</span>
                    <span className="ml-2 font-bold text-green-600">£{boxPrice}</span>
                    <span className="text-xs text-gray-400 ml-1">(£{formData.price} × {boxM2Coverage})</span>
                  </div>
                  <div>
                    <span className="text-muted-foreground">Verification:</span>
                    <span className="ml-2 font-bold text-purple-600">
                      £{(parseFloat(boxPrice) / parseFloat(boxM2Coverage)).toFixed(2)}/m²
                    </span>
                    {Math.abs(parseFloat(formData.price) - (parseFloat(boxPrice) / parseFloat(boxM2Coverage))) < 0.01 
                      ? <span className="ml-1 text-green-500">✓</span>
                      : <span className="ml-1 text-red-500">⚠</span>
                    }
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* Stock & Base Pricing Section */}
          <div>
            <h2 className="text-lg font-heading font-bold mb-4">Stock & Base Pricing</h2>
            
            {/* Supplier Stock Indicator */}
            {formData.supplier_stock && (
              <div className="mb-4 p-4 bg-blue-50 border border-blue-200 rounded-lg">
                <div className="flex items-center gap-2 mb-2">
                  <Truck className="w-5 h-5 text-blue-600" />
                  <span className="font-semibold text-blue-800">Supplier Stock Product</span>
                </div>
                <div className="grid grid-cols-2 md:grid-cols-5 gap-4 text-sm">
                  <div>
                    <span className="text-gray-500">Supplier:</span>
                    <span className="ml-2 font-medium">{formData.supplier_name}</span>
                  </div>
                  <div>
                    <span className="text-gray-500">EPOS Code:</span>
                    <span className="ml-2 font-mono font-medium bg-blue-100 px-2 py-0.5 rounded">
                      {formData.supplier_code} Stock
                    </span>
                  </div>
                  <div>
                    <span className="text-gray-500">Spreadsheet SKU:</span>
                    <span className="ml-2 font-mono">{formData.supplier_sku}</span>
                  </div>
                  <div>
                    <span className="text-gray-500">Website Code:</span>
                    <span className="ml-2 font-mono text-purple-600">{formData.original_supplier_code || 'Not set'}</span>
                  </div>
                  <div>
                    <span className="text-gray-500">Website Display:</span>
                    <span className={`ml-2 font-medium ${
                      formData.m2_quantity >= 50 ? 'text-green-600' :
                      formData.m2_quantity > 0 ? 'text-orange-600' : 'text-red-600'
                    }`}>
                      {formData.m2_quantity >= 50 ? 'In Stock' :
                       formData.m2_quantity > 0 ? 'Low Stock' : 'Out of Stock'}
                    </span>
                  </div>
                </div>
                <p className="text-xs text-gray-500 mt-2">
                  This product is sourced from {formData.supplier_name}. Stock shown is supplier availability.
                  {!formData.original_supplier_code && (
                    <span className="text-amber-600 ml-1">Website code will be auto-filled on next sync.</span>
                  )}
                </p>
              </div>
            )}
            
            <div className="grid grid-cols-1 md:grid-cols-4 gap-6">
              {/* For tiles with dimensions, show m² as primary */}
              {formData.tile_width && formData.tile_height ? (
                <>
                  <div className="space-y-2">
                    <Label htmlFor="m2_quantity" data-testid="m2-label">Stock (m²) *</Label>
                    <Input
                      id="m2_quantity"
                      data-testid="m2-input"
                      type="number"
                      step="0.01"
                      value={formData.m2_quantity || 0}
                      onChange={(e) => {
                        const m2 = parseFloat(e.target.value) || 0;
                        const m2PerPiece = (formData.tile_width / 100) * (formData.tile_height / 100);
                        const pieces = m2PerPiece > 0 ? Math.round(m2 / m2PerPiece) : 0;
                        setFormData({ ...formData, m2_quantity: m2, stock: pieces });
                      }}
                      required
                      min="0"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label data-testid="pieces-label">Pieces (calculated)</Label>
                    <div className="h-10 px-3 py-2 rounded-md border bg-muted/50 flex items-center">
                      <span className="font-mono">
                        {formData.tile_width && formData.tile_height && formData.m2_quantity
                          ? Math.round(formData.m2_quantity / ((formData.tile_width / 100) * (formData.tile_height / 100)))
                          : formData.stock || 0} pcs
                      </span>
                    </div>
                    <p className="text-xs text-muted-foreground">
                      Tile: {formData.tile_width}x{formData.tile_height}cm = {((formData.tile_width / 100) * (formData.tile_height / 100)).toFixed(4)} m²/pc
                    </p>
                  </div>
                </>
              ) : (
                <>
                  <div className="space-y-2">
                    <Label htmlFor="stock" data-testid="stock-label">Stock (Pieces) *</Label>
                    <Input
                      id="stock"
                      data-testid="stock-input"
                      type="number"
                      value={formData.stock}
                      onChange={(e) => setFormData({ ...formData, stock: parseInt(e.target.value) || 0 })}
                      required
                      min="0"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="m2_quantity" data-testid="m2-label">m² Quantity (optional)</Label>
                    <Input
                      id="m2_quantity"
                      data-testid="m2-input"
                      type="number"
                      step="0.01"
                      value={formData.m2_quantity || ''}
                      onChange={(e) => setFormData({ ...formData, m2_quantity: parseFloat(e.target.value) || null })}
                      placeholder="For tile products"
                      min="0"
                    />
                  </div>
                </>
              )}

              <div className="space-y-2">
                <Label htmlFor="price" data-testid="price-label">
                  Selling Price (£) * 
                  <span className="text-xs text-muted-foreground ml-1">
                    ({formData.size_unit === 'each' ? 'per piece' : formData.size_unit === 'linear_meter' ? 'per linear meter' : 'per m²'})
                  </span>
                </Label>
                <Input
                  id="price"
                  data-testid="price-input"
                  type="number"
                  step="0.01"
                  value={formData.price}
                  onChange={(e) => setFormData({ ...formData, price: parseFloat(e.target.value) || 0 })}
                  required
                  min="0"
                />
              </div>

              {isSuperAdmin && (
                <div className="space-y-2">
                  <Label htmlFor="cost_unit" data-testid="cost-unit-label">Cost Type</Label>
                  <select
                    id="cost_unit"
                    data-testid="cost-unit-select"
                    value={formData.cost_unit || 'm2'}
                    onChange={(e) => setFormData({ ...formData, cost_unit: e.target.value })}
                    className="flex h-11 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <option value="m2">Cost per m²</option>
                    <option value="each">Cost per Each</option>
                  </select>
                </div>
              )}

              {isSuperAdmin && (
                <div className="space-y-2">
                  <Label htmlFor="cost" data-testid="cost-label">
                    Cost Price (£)
                    <span className="text-xs text-muted-foreground ml-1">
                      ({formData.cost_unit === 'each' ? 'per piece' : 'per m²'})
                    </span>
                  </Label>
                  <Input
                    id="cost"
                    data-testid="cost-input"
                    type="number"
                    step="0.01"
                    placeholder="Enter cost price"
                    value={formData.cost}
                    onChange={(e) => setFormData({ ...formData, cost: e.target.value ? parseFloat(e.target.value) : '' })}
                    min="0"
                  />
                  {formData.cost && formData.price > 0 && (
                    <div className="flex items-center gap-2 text-sm">
                      <span className="text-muted-foreground">Profit:</span>
                      <span className={`font-mono font-medium ${(formData.price - formData.cost) > 0 ? 'text-emerald-600' : 'text-red-600'}`}>
                        £{(formData.price - formData.cost).toFixed(2)}
                      </span>
                      <span className="text-muted-foreground">|</span>
                      <span className="text-muted-foreground">Margin:</span>
                      <span className={`font-mono font-medium ${((formData.price - formData.cost) / formData.price * 100) >= 30 ? 'text-emerald-600' : ((formData.price - formData.cost) / formData.price * 100) >= 15 ? 'text-amber-600' : 'text-red-600'}`}>
                        {((formData.price - formData.cost) / formData.price * 100).toFixed(1)}%
                      </span>
                    </div>
                  )}
                </div>
              )}

              <div className="space-y-2">
                <Label htmlFor="reorder_level" data-testid="reorder-label">Reorder Level</Label>
                <Input
                  id="reorder_level"
                  data-testid="reorder-input"
                  type="number"
                  value={formData.reorder_level}
                  onChange={(e) => setFormData({ ...formData, reorder_level: parseInt(e.target.value) || 0 })}
                  min="0"
                />
              </div>
            </div>
          </div>

          {/* Bulk Pricing Section */}
          <div className="border border-border rounded-lg p-6 bg-secondary/30">
            <h2 className="text-lg font-heading font-bold mb-4 flex items-center gap-2">
              <Layers className="h-5 w-5 text-blue-600" />
              Bulk Pricing Options
            </h2>
            <p className="text-sm text-muted-foreground mb-6">
              Set special prices for customers buying in larger quantities
            </p>

            {/* Room Lot Pricing */}
            <div className="mb-6 p-4 bg-blue-50 border border-blue-200 rounded-lg">
              <div className="flex items-start gap-3">
                <input
                  type="checkbox"
                  id="room_lot_enabled"
                  data-testid="room-lot-checkbox"
                  checked={formData.room_lot_enabled}
                  onChange={(e) => setFormData({ ...formData, room_lot_enabled: e.target.checked })}
                  className="w-5 h-5 mt-0.5 rounded border-gray-300"
                />
                <div className="flex-1">
                  <Label htmlFor="room_lot_enabled" className="cursor-pointer font-semibold text-blue-800">
                    Room Lot Pricing
                  </Label>
                  <p className="text-xs text-blue-600 mt-1">
                    Offer a discounted price for customers buying enough for a room
                  </p>
                  
                  {formData.room_lot_enabled && (
                    <div className="grid grid-cols-2 gap-4 mt-4">
                      <div className="space-y-2">
                        <Label htmlFor="room_lot_quantity" className="text-sm">Min. Quantity (pieces)</Label>
                        <Input
                          id="room_lot_quantity"
                          data-testid="room-lot-quantity-input"
                          type="number"
                          value={formData.room_lot_quantity}
                          onChange={(e) => setFormData({ ...formData, room_lot_quantity: e.target.value })}
                          placeholder="e.g., 10"
                          min="1"
                          className="bg-white"
                        />
                      </div>
                      <div className="space-y-2">
                        <Label htmlFor="room_lot_price" className="text-sm">Price per m² (£)</Label>
                        <Input
                          id="room_lot_price"
                          data-testid="room-lot-price-input"
                          type="number"
                          step="0.01"
                          value={formData.room_lot_price}
                          onChange={(e) => setFormData({ ...formData, room_lot_price: e.target.value })}
                          placeholder="e.g., 35.00"
                          min="0"
                          className="bg-white"
                        />
                      </div>
                    </div>
                  )}
                </div>
              </div>
            </div>

            {/* Pallet Pricing */}
            <div className="p-4 bg-green-50 border border-green-200 rounded-lg">
              <div className="flex items-start gap-3">
                <input
                  type="checkbox"
                  id="pallet_enabled"
                  data-testid="pallet-checkbox"
                  checked={formData.pallet_enabled}
                  onChange={(e) => setFormData({ ...formData, pallet_enabled: e.target.checked })}
                  className="w-5 h-5 mt-0.5 rounded border-gray-300"
                />
                <div className="flex-1">
                  <Label htmlFor="pallet_enabled" className="cursor-pointer font-semibold text-green-800 flex items-center gap-2">
                    <Truck className="h-4 w-4" />
                    Half + Full Pallet Pricing
                  </Label>
                  <p className="text-xs text-green-600 mt-1">
                    Bulk pricing for customers buying in pallet quantities. Half-pallet rate is shown alongside full-pallet on the storefront when set.
                  </p>
                  
                  {formData.pallet_enabled && (
                    <>
                      <div className="grid grid-cols-2 gap-4 mt-4">
                        <div className="space-y-2">
                          <Label htmlFor="pallet_quantity" className="text-sm">Pallet Quantity (pieces)</Label>
                          <Input
                            id="pallet_quantity"
                            data-testid="pallet-quantity-input"
                            type="number"
                            value={formData.pallet_quantity}
                            onChange={(e) => setFormData({ ...formData, pallet_quantity: e.target.value })}
                            placeholder="e.g., 48"
                            min="1"
                            className="bg-white"
                          />
                        </div>
                        <div className="space-y-2">
                          <Label htmlFor="pallet_price" className="text-sm">Full Pallet — Price per m² (£)</Label>
                          <Input
                            id="pallet_price"
                            data-testid="pallet-price-input"
                            type="number"
                            step="0.01"
                            value={formData.pallet_price}
                            onChange={(e) => setFormData({ ...formData, pallet_price: e.target.value })}
                            placeholder="e.g., 28.00"
                            min="0"
                            className="bg-white"
                          />
                        </div>
                      </div>

                      {/* Half + Full pallet — m² thresholds + half rate */}
                      <div className="mt-4 pt-4 border-t border-green-200">
                        <p className="text-xs text-green-700 font-medium mb-3">
                          Half + Full Pallet thresholds (m²) — leave Half blank to default to ½ of Full.
                        </p>
                        <div className="grid grid-cols-3 gap-4">
                          <div className="space-y-2">
                            <Label htmlFor="m2_per_pallet" className="text-sm">Full Pallet (m²)</Label>
                            <Input
                              id="m2_per_pallet"
                              data-testid="m2-per-pallet-input"
                              type="number"
                              step="0.01"
                              value={formData.m2_per_pallet}
                              onChange={(e) => setFormData({ ...formData, m2_per_pallet: e.target.value })}
                              placeholder="e.g., 32.00"
                              min="0"
                              className="bg-white"
                            />
                          </div>
                          <div className="space-y-2">
                            <Label htmlFor="m2_per_half_pallet" className="text-sm">Half Pallet (m²)</Label>
                            <Input
                              id="m2_per_half_pallet"
                              data-testid="m2-per-half-pallet-input"
                              type="number"
                              step="0.01"
                              value={formData.m2_per_half_pallet}
                              onChange={(e) => setFormData({ ...formData, m2_per_half_pallet: e.target.value })}
                              placeholder="auto: ½ of full"
                              min="0"
                              className="bg-white"
                            />
                          </div>
                          <div className="space-y-2">
                            <Label htmlFor="half_pallet_price" className="text-sm">Half Pallet — £/m²</Label>
                            <Input
                              id="half_pallet_price"
                              data-testid="half-pallet-price-input"
                              type="number"
                              step="0.01"
                              value={formData.half_pallet_price}
                              onChange={(e) => setFormData({ ...formData, half_pallet_price: e.target.value })}
                              placeholder="e.g., 30.00"
                              min="0"
                              className="bg-white"
                            />
                          </div>
                        </div>
                        <p className="text-[11px] text-green-600 mt-2">
                          On the storefront, customers see a Half Pallet / Full Pallet chip selector. Selecting one auto-sets the basket m² to the matching threshold and applies the £/m² rate.
                        </p>
                      </div>
                    </>
                  )}
                </div>
              </div>
            </div>
          </div>

          {/* Maximum Discount Section */}
          <div className="border border-amber-200 rounded-lg p-6 bg-amber-50/30">
            <div className="flex items-start gap-3">
              <div className="flex-1">
                <Label className="font-semibold text-amber-800 flex items-center gap-2">
                  <span className="text-lg">🔒</span> Maximum Discount Limit
                </Label>
                <p className="text-xs text-amber-600 mt-1 mb-4">
                  Set the maximum discount percentage allowed on invoices. Staff cannot exceed this limit without manager authorization.
                </p>
                
                <div className="max-w-xs">
                  <Label htmlFor="max_discount" className="text-sm">Max Discount (%)</Label>
                  <Input
                    id="max_discount"
                    data-testid="max-discount-input"
                    type="number"
                    step="1"
                    min="0"
                    max="100"
                    value={formData.max_discount || ''}
                    onChange={(e) => setFormData({ ...formData, max_discount: parseFloat(e.target.value) || null })}
                    placeholder="e.g., 20"
                    className="mt-2 bg-white"
                  />
                  <p className="text-xs text-muted-foreground mt-1">
                    Leave empty for no limit. Enter 20 for maximum 20% discount.
                  </p>
                </div>
              </div>
            </div>
          </div>

          {/* Publish Status Section */}
          <div className="border border-emerald-200 rounded-lg p-6 bg-emerald-50/30">
            <h3 className="font-semibold text-emerald-800 mb-4 flex items-center gap-2">
              🌐 Publish Status
            </h3>
            
            {formData.visibility === 'draft' && (
              <div className="bg-amber-100 border border-amber-300 rounded-lg p-3 mb-4">
                <p className="text-amber-800 text-sm font-medium">
                  ⚠️ This product is currently in DRAFT mode and not visible on the website.
                </p>
              </div>
            )}
            
            <div className="space-y-4">
              {/* Show on Website */}
              <div className="flex items-start gap-3">
                <input
                  type="checkbox"
                  id="show_on_website"
                  data-testid="show-on-website-checkbox"
                  checked={formData.show_on_website}
                  onChange={(e) => setFormData({ 
                    ...formData, 
                    show_on_website: e.target.checked,
                    visibility: e.target.checked ? 'published' : 'draft'
                  })}
                  className="w-5 h-5 mt-0.5 rounded border-gray-300"
                />
                <div className="flex-1">
                  <Label htmlFor="show_on_website" className="cursor-pointer font-medium text-emerald-800">
                    Show on Website
                  </Label>
                  <p className="text-xs text-emerald-600 mt-1">
                    Make this product visible on the public website
                  </p>
                </div>
              </div>
              
              {/* Show in EPOS */}
              <div className="flex items-start gap-3">
                <input
                  type="checkbox"
                  id="show_in_epos"
                  data-testid="show-in-epos-checkbox"
                  checked={formData.show_in_epos}
                  onChange={(e) => setFormData({ ...formData, show_in_epos: e.target.checked })}
                  className="w-5 h-5 mt-0.5 rounded border-gray-300"
                />
                <div className="flex-1">
                  <Label htmlFor="show_in_epos" className="cursor-pointer font-medium text-emerald-800">
                    Show in EPOS
                  </Label>
                  <p className="text-xs text-emerald-600 mt-1">
                    Make this product available in the Point of Sale system
                  </p>
                </div>
              </div>
            </div>
          </div>

          {/* Clearance Section */}
          <div className="border border-red-200 rounded-lg p-6 bg-red-50/30">
            <div className="flex items-start gap-3">
              <input
                type="checkbox"
                id="clearance"
                data-testid="clearance-checkbox"
                checked={formData.clearance}
                onChange={(e) => setFormData({ ...formData, clearance: e.target.checked })}
                className="w-5 h-5 mt-0.5 rounded border-gray-300"
              />
              <div className="flex-1">
                <Label htmlFor="clearance" className="cursor-pointer font-semibold text-red-800">
                  🔥 Mark as Clearance Item
                </Label>
                <p className="text-xs text-red-600 mt-1">
                  Show this product in the clearance section with special pricing
                </p>
                
                {formData.clearance && (
                  <div className="mt-4 max-w-xs">
                    <Label htmlFor="clearance_price" className="text-sm">Clearance Price (£)</Label>
                    <Input
                      id="clearance_price"
                      data-testid="clearance-price-input"
                      type="number"
                      step="0.01"
                      value={formData.clearance_price || ''}
                      onChange={(e) => setFormData({ ...formData, clearance_price: parseFloat(e.target.value) || null })}
                      placeholder="Discounted price"
                      min="0"
                      className="mt-2 bg-white"
                    />
                  </div>
                )}
              </div>

              {/* Hide Order Sample on this product (per-product opt-out) */}
              <div className="border border-amber-200 rounded-md p-4 bg-amber-50/40">
                <Label className="flex items-center gap-2 cursor-pointer text-amber-900 font-semibold">
                  <input
                    type="checkbox"
                    data-testid="samples-hidden-checkbox"
                    checked={formData.samples_hidden || false}
                    onChange={(e) => setFormData({ ...formData, samples_hidden: e.target.checked })}
                    className="w-4 h-4 accent-amber-600"
                  />
                  Hide Order Sample on this product
                </Label>
                <p className="text-xs text-amber-700 mt-1">
                  When ticked, the "Order Sample" button is hidden on the storefront for THIS product
                  only. Use this for clearance/job-lot stock with no sample tiles left, or DTP tiles
                  where samples aren't practical. Leaves the global Sample Service running for other tiles.
                </p>
              </div>
            </div>
          </div>

          {/* Submit Buttons */}
          <div className="flex gap-4 pt-4 border-t border-border">
            <Button type="submit" data-testid="submit-button" disabled={loading} className="bg-accent hover:bg-accent/90">
              {loading ? 'Saving...' : effectiveIsEdit ? 'Update Product' : 'Create Product'}
            </Button>
            <Button type="button" variant="outline" onClick={() => navigate(getReturnUrl())} data-testid="cancel-button">
              Cancel
            </Button>
          </div>
        </form>
      </Card>

      {/* New Category Dialog */}
      <Dialog open={showNewCategoryDialog} onOpenChange={setShowNewCategoryDialog}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <FolderPlus className="h-5 w-5 text-teal-600" />
              Create New Category
            </DialogTitle>
            <DialogDescription>
              Add a new category to organize your products
            </DialogDescription>
          </DialogHeader>
          
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="newCategoryName">Category Name *</Label>
              <Input
                id="newCategoryName"
                value={newCategoryName}
                onChange={(e) => setNewCategoryName(e.target.value)}
                placeholder="e.g., Floor Tiles, Wall Tiles, Mosaics"
                autoFocus
              />
            </div>
            
            <div className="space-y-2">
              <Label htmlFor="newCategoryDescription">Description (optional)</Label>
              <textarea
                id="newCategoryDescription"
                value={newCategoryDescription}
                onChange={(e) => setNewCategoryDescription(e.target.value)}
                placeholder="Brief description of this category..."
                rows={3}
                className="flex w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              />
            </div>
          </div>

          <DialogFooter className="gap-2 sm:gap-0">
            <Button
              variant="outline"
              onClick={() => {
                setShowNewCategoryDialog(false);
                setNewCategoryName('');
                setNewCategoryDescription('');
              }}
            >
              Cancel
            </Button>
            <Button
              onClick={handleCreateCategory}
              disabled={creatingCategory || !newCategoryName.trim()}
              className="bg-teal-600 hover:bg-teal-700"
            >
              {creatingCategory ? 'Creating...' : 'Create Category'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Add Custom Category Option Dialog */}
      <Dialog open={showAddOptionModal} onOpenChange={setShowAddOptionModal}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Plus className="h-5 w-5 text-purple-600" />
              Add New {addOptionType ? addOptionType.charAt(0).toUpperCase() + addOptionType.slice(1, -1) : ''} Option
            </DialogTitle>
            <DialogDescription>
              Create a new option for the {addOptionType} category. This will be available for all products.
            </DialogDescription>
          </DialogHeader>
          
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="newOptionLabel">Option Name *</Label>
              <Input
                id="newOptionLabel"
                value={newOptionLabel}
                onChange={(e) => setNewOptionLabel(e.target.value)}
                placeholder={addOptionType === 'rooms' ? 'e.g., Fireplace, Conservatory' : 
                            addOptionType === 'styles' ? 'e.g., Venetian, Art Deco' :
                            addOptionType === 'colors' ? 'e.g., Turquoise, Coral' :
                            'e.g., Scratch Resistant, Easy Clean'}
                autoFocus
                onKeyPress={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    handleAddCustomOption();
                  }
                }}
              />
              <p className="text-xs text-muted-foreground">
                This option will be available for all products going forward.
              </p>
            </div>
          </div>

          <DialogFooter className="gap-2 sm:gap-0">
            <Button
              variant="outline"
              onClick={() => {
                setShowAddOptionModal(false);
                setNewOptionLabel('');
                setAddOptionType(null);
              }}
            >
              Cancel
            </Button>
            <Button
              onClick={handleAddCustomOption}
              disabled={addingOption || !newOptionLabel.trim()}
              className="bg-purple-600 hover:bg-purple-700"
            >
              {addingOption ? 'Adding...' : 'Add Option'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
};
