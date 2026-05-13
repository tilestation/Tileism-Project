import React, { useState, useEffect, useRef } from 'react';
import JsBarcode from 'jsbarcode';
import { api } from '../../lib/api';
import { toast } from 'sonner';
import { 
  Printer, Search, Trash2, RefreshCw, 
  Tag, Package, Check, Settings, Grid, Save
} from 'lucide-react';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { Card } from '../../components/ui/card';

// 13 May 2026 — barcode helper. Generates a Code128 SVG string from an
// SKU / product code so the printed ticket can be scanned straight into
// the EPOS at the till. Returns '' for empty values so callers can
// `{svg && <div>...</div>}` without extra checks. Uses an off-screen
// SVG node so it works in both React render and the popup print window.
const generateBarcodeSVG = (value, opts = {}) => {
  const text = String(value || '').trim();
  if (!text) return '';
  try {
    const svgNode = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    JsBarcode(svgNode, text, {
      format: 'CODE128',
      displayValue: true,
      fontSize: 14,
      height: 40,
      margin: 0,
      background: '#ffffff',
      lineColor: '#000000',
      ...opts,
    });
    return new XMLSerializer().serializeToString(svgNode);
  } catch (e) {
    // Silently no-op on bad values — barcode is decorative, not critical
    return '';
  }
};

// Paper size templates — admin can adjust + save custom sizes (13 May 2026)
// Each template defines the printed ticket dimensions (mm) and how many
// fit on a single A4 sheet. The `handlePrint` function reads these so
// the @page rules + per-ticket dimensions match.
const PAPER_PRESETS = {
  'A6 Tickets': { width_mm: 105, height_mm: 148, per_a4_cols: 2, per_a4_rows: 2 },  // 4 / A4
  'A5 Tickets': { width_mm: 148, height_mm: 210, per_a4_cols: 2, per_a4_rows: 1 },  // 2 / A4 portrait — wider format
  'A4 Full Page': { width_mm: 210, height_mm: 297, per_a4_cols: 1, per_a4_rows: 1 }, // 1 / A4
  'Small Shelf (74×105mm)': { width_mm: 74, height_mm: 105, per_a4_cols: 2, per_a4_rows: 2 }, // A7 shelf-edge
  'Mini (52×74mm)': { width_mm: 52, height_mm: 74, per_a4_cols: 4, per_a4_rows: 4 }, // 16 / A4
};
const DEFAULT_TEMPLATE_NAME = 'A6 Tickets';

// Country flags with SVG data
const COUNTRY_FLAGS = {
  italy: {
    name: 'Italy',
    label: 'Made in Italy',
    svg: `<svg viewBox="0 0 60 40" width="30" height="20"><rect width="20" height="40" fill="#009246"/><rect x="20" width="20" height="40" fill="#fff"/><rect x="40" width="20" height="40" fill="#ce2b37"/></svg>`
  },
  spain: {
    name: 'Spain', 
    label: 'Made in Spain',
    svg: `<svg viewBox="0 0 60 40" width="30" height="20"><rect width="60" height="10" fill="#c60b1e"/><rect y="10" width="60" height="20" fill="#ffc400"/><rect y="30" width="60" height="10" fill="#c60b1e"/></svg>`
  },
  india: {
    name: 'India',
    label: 'Made in India', 
    svg: `<svg viewBox="0 0 60 40" width="30" height="20"><rect width="60" height="13.3" fill="#ff9933"/><rect y="13.3" width="60" height="13.4" fill="#fff"/><rect y="26.7" width="60" height="13.3" fill="#138808"/><circle cx="30" cy="20" r="4" fill="#000080"/></svg>`
  },
  turkey: {
    name: 'Turkey',
    label: 'Made in Turkey',
    svg: `<svg viewBox="0 0 60 40" width="30" height="20"><rect width="60" height="40" fill="#e30a17"/><circle cx="22" cy="20" r="10" fill="#fff"/><circle cx="25" cy="20" r="8" fill="#e30a17"/><polygon points="32,20 36,22 34,18 38,16 34,16 32,12 30,16 26,16 30,18 28,22" fill="#fff"/></svg>`
  }
};

const PriceTicket = ({ product, showOriginalPrice, showClearanceBadge, showThisWeekBadge, showBarcode, index, paperSize }) => {
  const hasDiscount = product.clearance_price && product.clearance_price < product.price;
  const displayPrice = hasDiscount ? product.clearance_price : product.price;
  const originalPrice = product.price;
  const isClearance = hasDiscount && showClearanceBadge;
  
  // Calculate savings
  const savingsAmount = hasDiscount ? (originalPrice - displayPrice) : 0;
  const savingsPercent = hasDiscount ? Math.round((savingsAmount / originalPrice) * 100) : 0;

  // Paper size is configurable per-template (13 May 2026 — was hardcoded A6).
  // `paperSize` falls back to A6 so older calling code keeps working.
  const widthMm = paperSize?.width_mm || 105;
  const heightMm = paperSize?.height_mm || 148;
  // 13 May 2026 (v2) — content was overflowing on small papers and
  // looked tiny on large ones because every font/padding was hardcoded
  // at A6 dimensions. Solution: lay out the interior at A6 reference
  // (105×148mm) and uniformly scale via CSS transform to fit the
  // chosen paper. Uses min(w_ratio, h_ratio) so content always fits
  // and aspect-ratio is preserved.
  const REF_W = 105;
  const REF_H = 148;
  const scale = Math.min(widthMm / REF_W, heightMm / REF_H);

  return (
    <div 
      className="price-ticket"
      data-testid={`price-ticket-${index}`}
      style={{ 
        width: `${widthMm}mm`, 
        height: `${heightMm}mm`,
        border: '2px solid #1a1a1a',
        backgroundColor: '#ffffff',
        overflow: 'hidden',
        boxSizing: 'border-box',
        pageBreakInside: 'avoid',
        breakInside: 'avoid',
        position: 'relative'
      }}
    >
      <div style={{
        width: `${REF_W}mm`,
        height: `${REF_H}mm`,
        transform: `scale(${scale})`,
        transformOrigin: 'top left',
        display: 'flex',
        flexDirection: 'column',
        padding: '8mm',
        boxSizing: 'border-box',
        fontFamily: '"Bahnschrift SemiBold", "Bahnschrift", "Segoe UI", Arial, sans-serif',
        position: 'relative'
      }}>
      {/* Clearance Badge */}
      {isClearance && (
        <div style={{
          position: 'absolute',
          top: '5mm',
          right: '5mm',
          backgroundColor: '#dc2626',
          color: '#fff',
          padding: '3mm 6mm',
          fontSize: '12pt',
          fontWeight: '700',
          textTransform: 'uppercase',
          letterSpacing: '1px',
          boxShadow: '0 2px 4px rgba(0,0,0,0.2)'
        }}>
          CLEARANCE
        </div>
      )}
      
      {/* This Week Only Badge */}
      {showThisWeekBadge && !isClearance && (
        <div style={{
          position: 'absolute',
          top: '5mm',
          right: '5mm',
          backgroundColor: '#f59e0b',
          color: '#fff',
          padding: '3mm 5mm',
          fontSize: '11pt',
          fontWeight: '700',
          textTransform: 'uppercase',
          letterSpacing: '0.5px',
          boxShadow: '0 2px 4px rgba(0,0,0,0.2)'
        }}>
          THIS WEEK ONLY
        </div>
      )}

      {/* Product Name - LARGER */}
      <div style={{ 
        textAlign: 'center',
        marginBottom: '4mm',
        marginTop: (isClearance || showThisWeekBadge) ? '8mm' : '0'
      }}>
        <h2 style={{ 
          fontSize: '18pt',
          fontWeight: '600',
          color: '#1a1a1a',
          margin: 0,
          lineHeight: '1.2',
          fontFamily: '"Bahnschrift SemiBold", "Bahnschrift", "Segoe UI", sans-serif',
          textTransform: 'uppercase',
          letterSpacing: '0.5px'
        }}>
          {product.name}
        </h2>
        {product.product_code && (
          <div style={{ 
            fontSize: '9pt', 
            color: '#666',
            marginTop: '2mm'
          }}>
            Code: {product.product_code}
          </div>
        )}
      </div>

      {/* Price Section - LARGER */}
      <div style={{ 
        textAlign: 'center',
        backgroundColor: '#fff8f8',
        border: '2px solid #dc2626',
        borderRadius: '4px',
        padding: '5mm',
        marginBottom: '4mm'
      }}>
        {/* RRP Original Price */}
        <div style={{ 
          fontSize: '12pt', 
          color: '#666',
          marginBottom: '2mm'
        }}>
          <span style={{ textDecoration: hasDiscount ? 'line-through' : 'none' }}>
            RRP £{originalPrice.toFixed(2)}
          </span>
        </div>
        <div style={{
          fontSize: '42pt',
          fontWeight: '600',
          color: '#dc2626',
          fontFamily: '"Bahnschrift SemiBold", "Bahnschrift", "Segoe UI", sans-serif',
          lineHeight: '1'
        }}>
          £{displayPrice.toFixed(2)}
        </div>
        <div style={{
          fontSize: '12pt',
          color: '#dc2626',
          fontWeight: '600',
          marginTop: '1mm'
        }}>
          {product.priceUnit === 'qty' ? 'per piece' : product.priceUnit === 'box' ? 'per box' : 'per m²'}
        </div>
        
        {/* Savings Display */}
        {hasDiscount && (
          <div style={{
            marginTop: '3mm',
            padding: '3mm 6mm',
            backgroundColor: '#374151',
            color: '#fbbf24',
            borderRadius: '3px',
            display: 'inline-block'
          }}>
            <span style={{ fontSize: '13pt', fontWeight: '700' }}>
              SAVE £{savingsAmount.toFixed(2)} ({savingsPercent}% OFF)
            </span>
          </div>
        )}
      </div>

      {/* Product Details */}
      <div style={{ 
        flex: 1,
        fontSize: '9pt',
        lineHeight: '1.6',
        color: '#333'
      }}>
        {product.suitability && (
          <div style={{ marginBottom: '1mm' }}>
            <strong>Suitability:</strong> {product.suitability}
          </div>
        )}
        {product.finish && (
          <div style={{ marginBottom: '1mm' }}>
            <strong>Finish:</strong> {product.finish}
          </div>
        )}
        {product.material && (
          <div style={{ marginBottom: '1mm' }}>
            <strong>Material:</strong> {product.material}
          </div>
        )}
      </div>

      {/* Sizes Section */}
      {product.sizes && product.sizes.length > 0 && (
        <div style={{ 
          borderTop: '1px solid #ddd',
          paddingTop: '3mm',
          marginTop: 'auto'
        }}>
          <div style={{ 
            fontSize: '8pt', 
            color: '#666',
            marginBottom: '2mm',
            fontWeight: '600'
          }}>
            SIZES AVAILABLE (cm):
          </div>
          <div style={{ 
            display: 'flex', 
            flexWrap: 'wrap', 
            gap: '2mm' 
          }}>
            {product.sizes.map((size, idx) => (
              <div 
                key={idx}
                style={{
                  border: '1px solid #333',
                  backgroundColor: '#f5f5f5',
                  padding: '1mm 3mm',
                  fontSize: '8pt',
                  fontWeight: '700',
                  textAlign: 'center'
                }}
              >
                {size}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Barcode (13 May 2026) — Code128 of SKU / product_code for till
          scanning. Manual products use the `barcode` field they typed in. */}
      {showBarcode && (() => {
        const code = (product.sku || product.product_code || product.barcode || '').toString().trim();
        if (!code) return null;
        const svg = generateBarcodeSVG(code, { height: 30, fontSize: 11 });
        if (!svg) return null;
        return (
          <div
            style={{
              borderTop: '1px solid #ddd',
              paddingTop: '3mm',
              marginTop: '3mm',
              display: 'flex',
              justifyContent: 'center',
            }}
            data-testid={`price-ticket-barcode-${index}`}
            dangerouslySetInnerHTML={{ __html: svg }}
          />
        );
      })()}

      {/* Country of Origin with Flag */}
      {product.countryOfOrigin && COUNTRY_FLAGS[product.countryOfOrigin] && (
        <div style={{
          borderTop: '1px solid #ddd',
          paddingTop: '3mm',
          marginTop: '3mm',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: '2mm'
        }}>
          <span 
            dangerouslySetInnerHTML={{ __html: COUNTRY_FLAGS[product.countryOfOrigin].svg }}
            style={{ display: 'inline-block', verticalAlign: 'middle' }}
          />
          <span style={{
            fontSize: '9pt',
            fontWeight: '600',
            color: '#333'
          }}>
            {COUNTRY_FLAGS[product.countryOfOrigin].label}
          </span>
        </div>
      )}
      </div>
    </div>
  );
};

export const PriceTickets = () => {
  const [products, setProducts] = useState([]);
  const [selectedProducts, setSelectedProducts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState('');
  const [showOriginalPrice, setShowOriginalPrice] = useState(true);
  const [showClearanceBadge, setShowClearanceBadge] = useState(true);
  const [showThisWeekBadge, setShowThisWeekBadge] = useState(false);
  // 13 May 2026 — Code128 barcode of SKU / product_code at bottom of each
  // ticket so it scans straight into EPOS. Defaults ON for catalogue
  // items; manual products need the user to type a barcode value.
  const [showBarcode, setShowBarcode] = useState(true);
  const [copies, setCopies] = useState(1);
  const [savedTemplates, setSavedTemplates] = useState([]);
  const [currentTemplateName, setCurrentTemplateName] = useState(DEFAULT_TEMPLATE_NAME);
  // Custom paper-size dimensions (mm). Inputs in the UI write here; saving
  // a template stores them in localStorage so future prints get the same size.
  const [customWidthMm, setCustomWidthMm] = useState(PAPER_PRESETS[DEFAULT_TEMPLATE_NAME].width_mm);
  const [customHeightMm, setCustomHeightMm] = useState(PAPER_PRESETS[DEFAULT_TEMPLATE_NAME].height_mm);
  const [customColsPerA4, setCustomColsPerA4] = useState(PAPER_PRESETS[DEFAULT_TEMPLATE_NAME].per_a4_cols);
  const [customRowsPerA4, setCustomRowsPerA4] = useState(PAPER_PRESETS[DEFAULT_TEMPLATE_NAME].per_a4_rows);
  // Manual product form — for tickets when the product isn't in the catalogue
  // (one-off price tickets, in-store-only items, samples, etc.). Adds a
  // virtual product (no `id`) to selectedProducts. Save Settings is hidden
  // for manual products because there's nothing to persist server-side.
  const [showManualForm, setShowManualForm] = useState(false);
  const [manualName, setManualName] = useState('');
  const [manualPrice, setManualPrice] = useState('');
  const [manualClearance, setManualClearance] = useState('');
  // Optional SKU/barcode for manual products (printed as Code128)
  const [manualBarcode, setManualBarcode] = useState('');
  const printRef = useRef();

  // Current paper-size object used by PriceTicket + handlePrint
  const currentPaperSize = {
    width_mm: customWidthMm,
    height_mm: customHeightMm,
    per_a4_cols: customColsPerA4,
    per_a4_rows: customRowsPerA4,
  };

  // Load saved templates from localStorage on mount
  useEffect(() => {
    const stored = localStorage.getItem('priceTicketTemplates');
    if (stored) {
      const parsed = JSON.parse(stored);
      setSavedTemplates(parsed);
      // 13 May 2026 — backfill missing paper-size fields on existing
      // templates so users who saved before this upgrade don't lose
      // their settings. Default to A6 dimensions when absent.
      const needsMigration = parsed.some(t => !t.settings?.paperSize);
      if (needsMigration) {
        const migrated = parsed.map(t => {
          const presetMatch = PAPER_PRESETS[t.name] || PAPER_PRESETS[DEFAULT_TEMPLATE_NAME];
          return {
            ...t,
            settings: {
              ...t.settings,
              paperSize: t.settings?.paperSize || presetMatch,
            },
          };
        });
        setSavedTemplates(migrated);
        localStorage.setItem('priceTicketTemplates', JSON.stringify(migrated));
      }
    } else {
      // Create default A6 template (now including paper-size dimensions)
      const defaultTemplate = {
        id: 'a6-tickets',
        name: DEFAULT_TEMPLATE_NAME,
        settings: {
          showOriginalPrice: true,
          showClearanceBadge: true,
          showThisWeekBadge: false,
          copies: 1,
          paperSize: PAPER_PRESETS[DEFAULT_TEMPLATE_NAME],
        },
      };
      setSavedTemplates([defaultTemplate]);
      localStorage.setItem('priceTicketTemplates', JSON.stringify([defaultTemplate]));
    }
  }, []);

  // Save current settings as template (incl. paper-size dimensions)
  const saveTemplate = (name) => {
    const newTemplate = {
      id: name.toLowerCase().replace(/\s+/g, '-'),
      name: name,
      settings: {
        showOriginalPrice,
        showClearanceBadge,
        showThisWeekBadge,
        copies,
        paperSize: {
          width_mm: customWidthMm,
          height_mm: customHeightMm,
          per_a4_cols: customColsPerA4,
          per_a4_rows: customRowsPerA4,
        },
      },
    };
    
    const existingIndex = savedTemplates.findIndex(t => t.name === name);
    let updatedTemplates;
    
    if (existingIndex >= 0) {
      updatedTemplates = [...savedTemplates];
      updatedTemplates[existingIndex] = newTemplate;
    } else {
      updatedTemplates = [...savedTemplates, newTemplate];
    }
    
    setSavedTemplates(updatedTemplates);
    localStorage.setItem('priceTicketTemplates', JSON.stringify(updatedTemplates));
    setCurrentTemplateName(name);
    toast.success(`Template "${name}" saved!`);
  };

  // Apply a preset (built-in or saved). Updates paper-size state.
  const applyPaperPreset = (presetName) => {
    const preset = PAPER_PRESETS[presetName];
    if (!preset) return;
    setCustomWidthMm(preset.width_mm);
    setCustomHeightMm(preset.height_mm);
    setCustomColsPerA4(preset.per_a4_cols);
    setCustomRowsPerA4(preset.per_a4_rows);
    setCurrentTemplateName(presetName);
  };

  // Load template settings (incl. paper-size)
  const loadTemplate = (template) => {
    setShowOriginalPrice(template.settings.showOriginalPrice);
    setShowClearanceBadge(template.settings.showClearanceBadge);
    setShowThisWeekBadge(template.settings.showThisWeekBadge);
    setCopies(template.settings.copies);
    setCurrentTemplateName(template.name);
    // Backfill from PAPER_PRESETS if missing (older saved templates)
    const ps = template.settings.paperSize
      || PAPER_PRESETS[template.name]
      || PAPER_PRESETS[DEFAULT_TEMPLATE_NAME];
    setCustomWidthMm(ps.width_mm);
    setCustomHeightMm(ps.height_mm);
    setCustomColsPerA4(ps.per_a4_cols);
    setCustomRowsPerA4(ps.per_a4_rows);
    toast.success(`Template "${template.name}" loaded!`);
  };

  // Delete template
  const deleteTemplate = (templateId) => {
    const updatedTemplates = savedTemplates.filter(t => t.id !== templateId);
    setSavedTemplates(updatedTemplates);
    localStorage.setItem('priceTicketTemplates', JSON.stringify(updatedTemplates));
    toast.success('Template deleted');
  };

  useEffect(() => {
    fetchProducts();
  }, []);

  const fetchProducts = async () => {
    try {
      const res = await api.getProducts();
      setProducts(res.data || []);
    } catch (error) {
      console.error('Failed to load products:', error);
      toast.error('Failed to load products');
    } finally {
      setLoading(false);
    }
  };

  const addProduct = async (product) => {
    if (!selectedProducts.find(p => p.id === product.id)) {
      // Try to load saved ticket settings from database
      let savedSettings = {};
      try {
        const res = await api.getProductTicketSettings(product.id);
        if (res.data) {
          savedSettings = {
            suitability: res.data.suitability,
            finish: res.data.finish,
            material: res.data.material,
            sizes: res.data.sizes,
            countryOfOrigin: res.data.country_of_origin,
            priceUnit: res.data.price_unit,
            templateName: res.data.template_name,
          };
        }
      } catch (err) {
        // No saved settings, use defaults
      }
      
      const productWithDefaults = {
        ...product,
        sizes: savedSettings.sizes || product.ticket_sizes || ['60x60', '60x120'],
        suitability: savedSettings.suitability || product.ticket_suitability || 'Wall/Floor',
        finish: savedSettings.finish || product.ticket_finish || 'Matt',
        material: savedSettings.material || product.ticket_material || 'Porcelain',
        countryOfOrigin: savedSettings.countryOfOrigin || product.ticket_country_of_origin || '',
        priceUnit: savedSettings.priceUnit || product.ticket_price_unit || 'm2'
      };
      setSelectedProducts([...selectedProducts, productWithDefaults]);
      // 13 May 2026 — if this product was last printed on a specific
      // paper template, auto-switch the previewer to that template so
      // the admin doesn't have to re-pick. Manual override always wins
      // because state changes downstream.
      if (savedSettings.templateName) {
        const savedTpl = savedTemplates.find(t => t.name === savedSettings.templateName);
        if (savedTpl) {
          loadTemplate(savedTpl);
        } else if (PAPER_PRESETS[savedSettings.templateName]) {
          applyPaperPreset(savedSettings.templateName);
        }
      }
      toast.success(`Added ${product.name}`);
    }
  };

  // 13 May 2026 — manual product entry. Creates a virtual product without
  // an `id` so it can be added to the ticket batch without polluting the
  // products collection. Save Settings is hidden for manual products
  // (nothing to persist).
  const addManualProduct = () => {
    const name = manualName.trim();
    if (!name) {
      toast.error('Product name is required');
      return;
    }
    const price = parseFloat(manualPrice);
    if (Number.isNaN(price) || price <= 0) {
      toast.error('Enter a valid price');
      return;
    }
    const clearance = manualClearance.trim() ? parseFloat(manualClearance) : null;
    const barcode = manualBarcode.trim();
    const manualProduct = {
      // Virtual id so the React key + remove() still works. Marked with
      // `_manual: true` so save-settings + DB calls are skipped.
      id: `manual-${Date.now()}`,
      _manual: true,
      name,
      price,
      clearance_price: clearance && !Number.isNaN(clearance) ? clearance : null,
      // Code128 barcode value — admin-typed SKU for manual/one-off items
      barcode: barcode || null,
      sizes: ['60x60', '60x120'],
      suitability: 'Wall/Floor',
      finish: 'Matt',
      material: 'Porcelain',
      countryOfOrigin: '',
      priceUnit: 'm2',
    };
    setSelectedProducts([...selectedProducts, manualProduct]);
    setManualName('');
    setManualPrice('');
    setManualClearance('');
    setManualBarcode('');
    setShowManualForm(false);
    toast.success(`Added manual product: ${name}`);
  };

  const removeProduct = (productId) => {
    setSelectedProducts(selectedProducts.filter(p => p.id !== productId));
  };

  const updateProductField = (productId, field, value) => {
    setSelectedProducts(selectedProducts.map(p => 
      p.id === productId ? { ...p, [field]: value } : p
    ));
  };

  // Save product ticket settings to database
  const saveProductSettings = async (product) => {
    // Manual products have no DB id — there's nothing to save server-side.
    if (product._manual) {
      toast.info('Manual product — settings live only in this print session');
      return;
    }
    try {
      await api.saveProductTicketSettings(product.id, {
        suitability: product.suitability,
        finish: product.finish,
        material: product.material,
        sizes: product.sizes,
        country_of_origin: product.countryOfOrigin,
        price_unit: product.priceUnit,
        // 13 May 2026 — remember the paper template alongside the
        // product so the next print auto-loads the same size.
        template_name: currentTemplateName,
      });
      toast.success(`Settings saved for ${product.name}`);
    } catch (err) {
      console.error('Failed to save settings:', err);
      toast.error('Failed to save settings');
    }
  };

  const handlePrint = () => {
    const printWindow = window.open('', '_blank');
    // 13 May 2026 (v2) — same scaling trick as the on-screen <PriceTicket>:
    // lay content out at A6 reference (105×148mm) and uniformly scale it
    // to fit the chosen paper. Stops content overflowing on Small Shelf /
    // Mini tickets and stops it looking lost on A4 / A5 tickets.
    const PRINT_REF_W = 105;
    const PRINT_REF_H = 148;
    const printScale = Math.min(customWidthMm / PRINT_REF_W, customHeightMm / PRINT_REF_H);
    
    // Generate ticket HTML for each product (with copies)
    const ticketHTML = ticketsToRender.map((product, idx) => {
      const hasDiscount = product.clearance_price && product.clearance_price < product.price;
      const isClearance = hasDiscount && showClearanceBadge;
      const showWeekBadge = showThisWeekBadge && !isClearance;
      const hasBadge = isClearance || showWeekBadge;
      const savingsAmount = hasDiscount ? (product.price - product.clearance_price) : 0;
      const savingsPercent = hasDiscount ? Math.round((savingsAmount / product.price) * 100) : 0;
      // Barcode (Code128) of SKU / product_code / manual barcode entry
      const barcodeValue = showBarcode
        ? (product.sku || product.product_code || product.barcode || '').toString().trim()
        : '';
      const barcodeSVG = barcodeValue ? generateBarcodeSVG(barcodeValue, { height: 30, fontSize: 11 }) : '';
      
      return `
      <div class="price-ticket">
        <div class="price-ticket-inner">
        <!-- Clearance Badge -->
        ${isClearance ? `
          <div class="clearance-badge">CLEARANCE</div>
        ` : ''}
        
        <!-- This Week Only Badge -->
        ${showWeekBadge ? `
          <div class="thisweek-badge">THIS WEEK ONLY</div>
        ` : ''}

        <!-- Product Name -->
        <div class="product-name-section ${hasBadge ? 'with-badge' : ''}">
          <h2 class="product-name">${product.name}</h2>
          ${product.product_code ? `<div class="product-code">Code: ${product.product_code}</div>` : ''}
        </div>

        <!-- Price Box -->
        <div class="price-box">
          <div class="rrp-price ${hasDiscount ? 'has-discount' : ''}">
            RRP £${product.price.toFixed(2)}
          </div>
          <div class="main-price">£${(product.clearance_price || product.price || 0).toFixed(2)}</div>
          <div class="price-unit">${product.priceUnit === 'qty' ? 'per piece' : product.priceUnit === 'box' ? 'per box' : 'per m²'}</div>
          ${hasDiscount ? `
            <div class="savings-badge">
              SAVE £${savingsAmount.toFixed(2)} (${savingsPercent}% OFF)
            </div>
          ` : ''}
        </div>

        <!-- Details -->
        <div class="details">
          ${product.suitability ? `<div><strong>Suitability:</strong> ${product.suitability}</div>` : ''}
          ${product.finish ? `<div><strong>Finish:</strong> ${product.finish}</div>` : ''}
          ${product.material ? `<div><strong>Material:</strong> ${product.material}</div>` : ''}
        </div>

        <!-- Sizes -->
        ${product.sizes && product.sizes.length > 0 ? `
          <div class="sizes-section">
            <div class="sizes-label">SIZES AVAILABLE (cm):</div>
            <div class="sizes-container">
              ${product.sizes.map(size => `<div class="size-box">${size}</div>`).join('')}
            </div>
          </div>
        ` : ''}

        <!-- Barcode (Code128 — scans at the till) -->
        ${barcodeSVG ? `
          <div class="barcode-section">${barcodeSVG}</div>
        ` : ''}

        <!-- Country of Origin -->
        ${product.countryOfOrigin && COUNTRY_FLAGS[product.countryOfOrigin] ? `
          <div class="country-section">
            ${COUNTRY_FLAGS[product.countryOfOrigin].svg}
            <span class="country-label">${COUNTRY_FLAGS[product.countryOfOrigin].label}</span>
          </div>
        ` : ''}
        </div>
      </div>
    `}).join('');
    
    printWindow.document.write(`
      <!DOCTYPE html>
      <html>
        <head>
          <title>Price Tickets - Tile Station</title>
          <style>
            @page {
              size: A4 portrait;
              margin: 0;
            }
            
            * {
              box-sizing: border-box;
              margin: 0;
              padding: 0;
            }
            
            html, body {
              width: 210mm;
              margin: 0;
              padding: 0;
              font-family: "Bahnschrift SemiBold", "Bahnschrift", "Segoe UI", Arial, sans-serif;
            }
            
            body {
              display: flex;
              flex-wrap: wrap;
              align-content: flex-start;
              /* No gap - tickets fill the page exactly */
            }
            
            .price-ticket {
              width: ${customWidthMm}mm;
              height: ${customHeightMm}mm;
              border: 1px solid #333;
              background: #ffffff;
              overflow: hidden;
              box-sizing: border-box;
              page-break-inside: avoid;
              break-inside: avoid;
              position: relative;
            }

            /* Inner content laid out at A6 reference, scaled uniformly */
            .price-ticket-inner {
              width: ${PRINT_REF_W}mm;
              height: ${PRINT_REF_H}mm;
              transform: scale(${printScale});
              transform-origin: top left;
              display: flex;
              flex-direction: column;
              padding: 8mm;
              box-sizing: border-box;
              position: relative;
            }
            
            .clearance-badge {
              position: absolute;
              top: 5mm;
              right: 5mm;
              background-color: #dc2626;
              color: #fff;
              padding: 3mm 6mm;
              font-size: 12pt;
              font-weight: 700;
              text-transform: uppercase;
              letter-spacing: 1px;
              box-shadow: 0 2px 4px rgba(0,0,0,0.2);
            }
            
            .thisweek-badge {
              position: absolute;
              top: 5mm;
              right: 5mm;
              background-color: #f59e0b;
              color: #fff;
              padding: 3mm 5mm;
              font-size: 11pt;
              font-weight: 700;
              text-transform: uppercase;
              letter-spacing: 0.5px;
              box-shadow: 0 2px 4px rgba(0,0,0,0.2);
            }
            
            .product-name-section {
              text-align: center;
              margin-bottom: 4mm;
            }
            
            .product-name-section.with-badge {
              margin-top: 8mm;
            }
            
            .product-name {
              font-size: 16pt;
              font-weight: 600;
              color: #1a1a1a;
              line-height: 1.2;
              font-family: "Bahnschrift SemiBold", "Bahnschrift", "Segoe UI", sans-serif;
              text-transform: uppercase;
              letter-spacing: 0.5px;
              margin: 0;
            }
            
            .product-code {
              font-size: 9pt;
              color: #666;
              margin-top: 2mm;
            }
            
            .price-box {
              text-align: center;
              background-color: #fff8f8;
              border: 2px solid #dc2626;
              border-radius: 3px;
              padding: 5mm;
              margin-bottom: 4mm;
            }
            
            .rrp-price {
              font-size: 12pt;
              color: #666;
              margin-bottom: 2mm;
            }
            
            .rrp-price.has-discount {
              text-decoration: line-through;
            }
            
            .main-price {
              font-size: 38pt;
              font-weight: 600;
              color: #dc2626;
              font-family: "Bahnschrift SemiBold", "Bahnschrift", "Segoe UI", sans-serif;
              line-height: 1;
            }
            
            .price-unit {
              font-size: 12pt;
              color: #dc2626;
              font-weight: 600;
              margin-top: 1mm;
            }
            
            .savings-badge {
              margin-top: 3mm;
              padding: 3mm 6mm;
              background-color: #374151;
              color: #fbbf24;
              border-radius: 3px;
              display: inline-block;
              font-size: 13pt;
              font-weight: 700;
            }
            
            .details {
              flex: 1;
              font-size: 9pt;
              line-height: 1.5;
              color: #333;
            }
            
            .details div {
              margin-bottom: 1mm;
            }
            
            .details strong {
              font-weight: 600;
            }
            
            .sizes-section {
              border-top: 1px solid #ddd;
              padding-top: 3mm;
              margin-top: auto;
            }
            
            .sizes-label {
              font-size: 7pt;
              color: #666;
              font-weight: 600;
              margin-bottom: 2mm;
            }
            
            .sizes-container {
              display: flex;
              flex-wrap: wrap;
              gap: 2mm;
            }
            
            .size-box {
              border: 1px solid #333;
              background: #f5f5f5;
              padding: 1mm 3mm;
              font-size: 8pt;
              font-weight: 700;
              text-align: center;
            }
            
            .country-section {
              border-top: 1px solid #ddd;
              padding-top: 3mm;
              margin-top: 3mm;
              display: flex;
              align-items: center;
              justify-content: center;
              gap: 2mm;
            }

            .barcode-section {
              border-top: 1px solid #ddd;
              padding-top: 3mm;
              margin-top: 3mm;
              display: flex;
              justify-content: center;
            }

            .barcode-section svg {
              max-width: 100%;
              height: auto;
            }
            
            .country-section svg {
              width: 30px;
              height: 20px;
              border: 1px solid #ccc;
            }
            
            .country-label {
              font-size: 9pt;
              font-weight: 600;
              color: #333;
            }
            
            @media print {
              body {
                -webkit-print-color-adjust: exact !important;
                print-color-adjust: exact !important;
              }
            }
          </style>
        </head>
        <body>
          ${ticketHTML}
        </body>
      </html>
    `);
    
    printWindow.document.close();
    printWindow.focus();
    setTimeout(() => {
      printWindow.print();
      printWindow.close();
    }, 300);
  };

  const filteredProducts = products.filter(p => 
    p.name?.toLowerCase().includes(searchTerm.toLowerCase()) ||
    p.product_code?.toLowerCase().includes(searchTerm.toLowerCase())
  );

  // Generate tickets with copies
  const ticketsToRender = [];
  selectedProducts.forEach(product => {
    for (let i = 0; i < copies; i++) {
      ticketsToRender.push({ ...product, copyIndex: i });
    }
  });

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <RefreshCw className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="space-y-6" data-testid="price-tickets-page">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-4xl font-heading font-bold tracking-tightest mb-2">Price Tickets</h1>
          <p className="text-muted-foreground" data-testid="page-subtitle">
            Generate and print price tickets ({customWidthMm}×{customHeightMm}mm · {customColsPerA4 * customRowsPerA4} per A4 — {currentTemplateName})
          </p>
        </div>
        <Button 
          onClick={handlePrint} 
          disabled={selectedProducts.length === 0}
          className="bg-blue-600 hover:bg-blue-700"
          data-testid="print-tickets-btn"
        >
          <Printer className="h-4 w-4 mr-2" />
          Print Tickets ({ticketsToRender.length})
        </Button>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Product Selection */}
        <div className="lg:col-span-1 space-y-4">
          <Card className="p-4">
            <h3 className="font-semibold mb-3 flex items-center gap-2">
              <Package className="h-4 w-4" />
              Select Products
            </h3>
            
            <div className="relative mb-3">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                type="text"
                placeholder="Search products..."
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                className="pl-9"
                data-testid="product-search-input"
              />
            </div>

            {/* 13 May 2026 — manual product entry. For one-off tickets where
                the product isn't in the catalogue (sample, in-store-only item,
                custom order). Adds a virtual product to selectedProducts. */}
            <div className="mb-3 border-2 border-dashed border-gray-300 rounded-lg p-2" data-testid="manual-product-section">
              {!showManualForm ? (
                <button
                  onClick={() => setShowManualForm(true)}
                  className="w-full text-sm text-amber-700 hover:bg-amber-50 py-2 rounded font-medium"
                  data-testid="show-manual-form-btn"
                >
                  + Add manual product (not in catalogue)
                </button>
              ) : (
                <div className="space-y-2 p-2">
                  <p className="text-xs font-semibold text-gray-700">Manual product</p>
                  <Input
                    type="text"
                    placeholder="Product name *"
                    value={manualName}
                    onChange={(e) => setManualName(e.target.value)}
                    className="h-8 text-sm"
                    data-testid="manual-name-input"
                  />
                  <div className="grid grid-cols-2 gap-2">
                    <Input
                      type="number"
                      step="0.01"
                      placeholder="Price * (£)"
                      value={manualPrice}
                      onChange={(e) => setManualPrice(e.target.value)}
                      className="h-8 text-sm"
                      data-testid="manual-price-input"
                    />
                    <Input
                      type="number"
                      step="0.01"
                      placeholder="Clearance £ (opt)"
                      value={manualClearance}
                      onChange={(e) => setManualClearance(e.target.value)}
                      className="h-8 text-sm"
                      data-testid="manual-clearance-input"
                    />
                  </div>
                  <Input
                    type="text"
                    placeholder="Barcode / SKU (opt) — printed as Code128"
                    value={manualBarcode}
                    onChange={(e) => setManualBarcode(e.target.value)}
                    className="h-8 text-sm"
                    data-testid="manual-barcode-input"
                  />
                  <div className="flex gap-2">
                    <button
                      onClick={addManualProduct}
                      className="flex-1 px-3 py-1 bg-amber-600 text-white text-sm rounded hover:bg-amber-700"
                      data-testid="manual-add-btn"
                    >
                      Add to tickets
                    </button>
                    <button
                      onClick={() => {
                        setShowManualForm(false);
                        setManualName('');
                        setManualPrice('');
                        setManualClearance('');
                        setManualBarcode('');
                      }}
                      className="px-3 py-1 bg-gray-200 text-gray-700 text-sm rounded hover:bg-gray-300"
                      data-testid="manual-cancel-btn"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              )}
            </div>
            
            <div className="max-h-96 overflow-y-auto space-y-2">
              {filteredProducts.slice(0, 50).map(product => (
                <div 
                  key={product.id}
                  className={`p-2 border rounded-lg cursor-pointer transition-colors ${
                    selectedProducts.find(p => p.id === product.id)
                      ? 'bg-green-50 border-green-300'
                      : 'hover:bg-gray-50'
                  }`}
                  onClick={() => addProduct(product)}
                  data-testid={`product-option-${product.id}`}
                >
                  <div className="flex justify-between items-start">
                    <div className="flex-1 min-w-0">
                      <p className="font-medium text-sm truncate">{product.name}</p>
                      <p className="text-xs text-muted-foreground">{product.product_code}</p>
                    </div>
                    <div className="text-right">
                      <p className="font-bold text-sm text-red-600">
                        £{(product.clearance_price || product.price || 0).toFixed(2)}
                      </p>
                      {product.clearance_price && product.clearance_price < product.price && (
                        <p className="text-xs line-through text-gray-400">
                          £{product.price.toFixed(2)}
                        </p>
                      )}
                    </div>
                  </div>
                  {selectedProducts.find(p => p.id === product.id) && (
                    <div className="mt-1 flex items-center text-green-600 text-xs">
                      <Check className="h-3 w-3 mr-1" />
                      Selected
                    </div>
                  )}
                </div>
              ))}
              {filteredProducts.length === 0 && (
                <p className="text-center text-muted-foreground py-4">No products found</p>
              )}
            </div>
          </Card>

          {/* Settings */}
          <Card className="p-4">
            <h3 className="font-semibold mb-3 flex items-center gap-2">
              <Settings className="h-4 w-4" />
              Ticket Settings
            </h3>
            
            <div className="space-y-3">
              {/* Template Selector + paper-size editor (13 May 2026 — was just text). */}
              <div className="p-3 bg-amber-50 border border-amber-200 rounded-lg space-y-3" data-testid="paper-template-card">
                <p className="text-sm text-amber-800 font-medium">Current Template: {currentTemplateName}</p>
                <div className="flex gap-2">
                  <select
                    className="flex-1 h-8 px-2 border rounded-md text-sm"
                    value={currentTemplateName}
                    onChange={(e) => {
                      const val = e.target.value;
                      // Saved templates win; then fall back to built-in presets
                      const tpl = savedTemplates.find(t => t.name === val);
                      if (tpl) {
                        loadTemplate(tpl);
                      } else if (PAPER_PRESETS[val]) {
                        applyPaperPreset(val);
                      }
                    }}
                    data-testid="paper-template-select"
                  >
                    {/* Built-in presets group */}
                    <optgroup label="Built-in presets">
                      {Object.keys(PAPER_PRESETS).map(name => (
                        <option key={`preset-${name}`} value={name}>{name}</option>
                      ))}
                    </optgroup>
                    {/* User-saved templates */}
                    {savedTemplates.length > 0 && (
                      <optgroup label="Your saved templates">
                        {savedTemplates
                          .filter(t => !PAPER_PRESETS[t.name])
                          .map(t => (
                            <option key={t.id} value={t.name}>{t.name}</option>
                          ))}
                      </optgroup>
                    )}
                  </select>
                  <button
                    onClick={() => {
                      const name = prompt('Save template as:', currentTemplateName);
                      if (name) saveTemplate(name);
                    }}
                    className="px-3 py-1 bg-amber-600 text-white text-sm rounded hover:bg-amber-700"
                    data-testid="save-template-btn"
                  >
                    Save
                  </button>
                </div>
                {/* Editable paper dimensions */}
                <div className="grid grid-cols-2 gap-2 pt-2 border-t border-amber-200">
                  <div>
                    <label className="text-xs text-amber-800 block mb-0.5">Width (mm)</label>
                    <Input
                      type="number"
                      min="20"
                      max="500"
                      value={customWidthMm}
                      onChange={(e) => setCustomWidthMm(Math.max(20, parseFloat(e.target.value) || 0))}
                      className="h-8"
                      data-testid="paper-width-input"
                    />
                  </div>
                  <div>
                    <label className="text-xs text-amber-800 block mb-0.5">Height (mm)</label>
                    <Input
                      type="number"
                      min="20"
                      max="500"
                      value={customHeightMm}
                      onChange={(e) => setCustomHeightMm(Math.max(20, parseFloat(e.target.value) || 0))}
                      className="h-8"
                      data-testid="paper-height-input"
                    />
                  </div>
                  <div>
                    <label className="text-xs text-amber-800 block mb-0.5">Cols / A4</label>
                    <Input
                      type="number"
                      min="1"
                      max="8"
                      value={customColsPerA4}
                      onChange={(e) => setCustomColsPerA4(Math.max(1, parseInt(e.target.value) || 1))}
                      className="h-8"
                      data-testid="paper-cols-input"
                    />
                  </div>
                  <div>
                    <label className="text-xs text-amber-800 block mb-0.5">Rows / A4</label>
                    <Input
                      type="number"
                      min="1"
                      max="8"
                      value={customRowsPerA4}
                      onChange={(e) => setCustomRowsPerA4(Math.max(1, parseInt(e.target.value) || 1))}
                      className="h-8"
                      data-testid="paper-rows-input"
                    />
                  </div>
                </div>
                <p className="text-xs text-amber-700">
                  {customWidthMm}×{customHeightMm}mm — {customColsPerA4 * customRowsPerA4} tickets per A4
                  {' · '}
                  <span className="italic">Tip: Save Settings on a product to remember this size for its next print.</span>
                </p>
              </div>
              
              <div>
                <label className="text-sm font-medium mb-1 block">Copies per Product</label>
                <Input
                  type="number"
                  min="1"
                  max="20"
                  value={copies}
                  onChange={(e) => setCopies(Math.max(1, parseInt(e.target.value) || 1))}
                  data-testid="copies-input"
                />
              </div>
              
              <div className="flex items-center gap-2">
                <input
                  type="checkbox"
                  id="showOriginal"
                  checked={showOriginalPrice}
                  onChange={(e) => setShowOriginalPrice(e.target.checked)}
                  className="rounded"
                  data-testid="show-original-checkbox"
                />
                <label htmlFor="showOriginal" className="text-sm">
                  Show RRP price (crossed out)
                </label>
              </div>
              
              <div className="flex items-center gap-2">
                <input
                  type="checkbox"
                  id="showClearance"
                  checked={showClearanceBadge}
                  onChange={(e) => setShowClearanceBadge(e.target.checked)}
                  className="rounded"
                  data-testid="show-clearance-checkbox"
                />
                <label htmlFor="showClearance" className="text-sm">
                  Show clearance badge (for discounted items)
                </label>
              </div>
              
              <div className="flex items-center gap-2">
                <input
                  type="checkbox"
                  id="showThisWeek"
                  checked={showThisWeekBadge}
                  onChange={(e) => setShowThisWeekBadge(e.target.checked)}
                  className="rounded"
                  data-testid="show-thisweek-checkbox"
                />
                <label htmlFor="showThisWeek" className="text-sm">
                  Show &ldquo;This Week Only&rdquo; badge
                </label>
              </div>

              <div className="flex items-center gap-2">
                <input
                  type="checkbox"
                  id="showBarcode"
                  checked={showBarcode}
                  onChange={(e) => setShowBarcode(e.target.checked)}
                  className="rounded"
                  data-testid="show-barcode-checkbox"
                />
                <label htmlFor="showBarcode" className="text-sm">
                  Show scannable barcode (Code128 — scans at the till)
                </label>
              </div>
            </div>
          </Card>
        </div>

        {/* Selected Products & Preview */}
        <div className="lg:col-span-2 space-y-4">
          {/* Selected Products Editor */}
          {selectedProducts.length > 0 && (
            <Card className="p-4">
              <h3 className="font-semibold mb-3 flex items-center gap-2">
                <Tag className="h-4 w-4" />
                Edit Ticket Details ({selectedProducts.length})
              </h3>
              
              <div className="space-y-3 max-h-80 overflow-y-auto">
                {selectedProducts.map(product => (
                  <div key={product.id} className="p-3 border rounded-lg bg-gray-50">
                    <div className="flex justify-between items-start mb-2">
                      <div>
                        <p className="font-medium">{product.name}</p>
                        <p className="text-sm text-red-600 font-bold">
                          £{(product.clearance_price || product.price || 0).toFixed(2)} /{product.priceUnit === 'qty' ? 'pc' : product.priceUnit === 'box' ? 'box' : 'm²'}
                        </p>
                      </div>
                      <div className="flex gap-1">
                        {!product._manual && (
                          <Button
                            variant="outline"
                            size="sm"
                            className="text-green-600 hover:text-green-700 hover:bg-green-50"
                            onClick={() => saveProductSettings(product)}
                            title="Save settings (including current paper size) to database"
                            data-testid={`save-settings-${product.id}`}
                          >
                            <Save className="h-4 w-4" />
                          </Button>
                        )}
                        {product._manual && (
                          <span
                            className="px-2 py-1 text-xs bg-amber-100 text-amber-700 rounded"
                            title="Manual product — not saved to product database"
                            data-testid={`manual-badge-${product.id}`}
                          >
                            Manual
                          </span>
                        )}
                        <Button
                          variant="ghost"
                          size="sm"
                          className="text-red-500 hover:text-red-700"
                          onClick={() => removeProduct(product.id)}
                          data-testid={`remove-product-${product.id}`}
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </div>
                    </div>
                    
                    <div className="grid grid-cols-2 gap-2 text-sm">
                      <div>
                        <label className="text-xs text-muted-foreground">Suitability</label>
                        <Input
                          value={product.suitability || ''}
                          onChange={(e) => updateProductField(product.id, 'suitability', e.target.value)}
                          placeholder="Wall/Floor"
                          className="h-8 text-sm"
                        />
                      </div>
                      <div>
                        <label className="text-xs text-muted-foreground">Finish</label>
                        <select
                          value={product.finish || ''}
                          onChange={(e) => updateProductField(product.id, 'finish', e.target.value)}
                          className="w-full h-8 px-2 border rounded-md text-sm"
                        >
                          <option value="">-- Select Finish --</option>
                          <option value="Polish">Polish</option>
                          <option value="Matt">Matt</option>
                          <option value="High Polish">High Polish</option>
                          <option value="Semi Polish (Sugar)">Semi Polish (Sugar)</option>
                          <option value="Carved Matt">Carved Matt</option>
                        </select>
                      </div>
                      <div>
                        <label className="text-xs text-muted-foreground">Material</label>
                        <Input
                          value={product.material || ''}
                          onChange={(e) => updateProductField(product.id, 'material', e.target.value)}
                          placeholder="Porcelain"
                          className="h-8 text-sm"
                        />
                      </div>
                      <div>
                        <label className="text-xs text-muted-foreground">Price Unit</label>
                        <select
                          value={product.priceUnit || 'm2'}
                          onChange={(e) => updateProductField(product.id, 'priceUnit', e.target.value)}
                          className="w-full h-8 px-2 border rounded-md text-sm"
                        >
                          <option value="m2">per m²</option>
                          <option value="qty">per piece/qty</option>
                          <option value="box">per box</option>
                        </select>
                      </div>
                      <div className="col-span-2">
                        <label className="text-xs text-muted-foreground">Sizes Available</label>
                        <div className="flex flex-wrap gap-2 mt-1 p-2 border rounded-md bg-white min-h-[40px]">
                          {(product.sizes || []).map((size, sizeIdx) => (
                            <div 
                              key={sizeIdx} 
                              className="flex items-center gap-1 bg-gray-100 border rounded px-2 py-1"
                            >
                              <input
                                type="text"
                                value={size}
                                onChange={(e) => {
                                  const newSizes = [...(product.sizes || [])];
                                  newSizes[sizeIdx] = e.target.value;
                                  updateProductField(product.id, 'sizes', newSizes);
                                }}
                                className="w-16 text-sm bg-transparent border-none outline-none text-center"
                                placeholder="60x60"
                              />
                              <button
                                type="button"
                                onClick={() => {
                                  const newSizes = (product.sizes || []).filter((_, i) => i !== sizeIdx);
                                  updateProductField(product.id, 'sizes', newSizes);
                                }}
                                className="text-red-500 hover:text-red-700 text-xs font-bold"
                              >
                                ×
                              </button>
                            </div>
                          ))}
                          <button
                            type="button"
                            onClick={() => {
                              const newSizes = [...(product.sizes || []), ''];
                              updateProductField(product.id, 'sizes', newSizes);
                            }}
                            className="px-2 py-1 text-sm text-blue-600 hover:text-blue-800 border border-dashed border-blue-300 rounded hover:bg-blue-50"
                          >
                            + Add Size
                          </button>
                        </div>
                      </div>
                      <div className="col-span-2">
                        <label className="text-xs text-muted-foreground">Country of Origin</label>
                        <select
                          value={product.countryOfOrigin || ''}
                          onChange={(e) => updateProductField(product.id, 'countryOfOrigin', e.target.value)}
                          className="w-full h-8 px-2 border rounded-md text-sm"
                        >
                          <option value="">-- No Flag --</option>
                          <option value="italy">🇮🇹 Made in Italy</option>
                          <option value="spain">🇪🇸 Made in Spain</option>
                          <option value="india">🇮🇳 Made in India</option>
                          <option value="turkey">🇹🇷 Made in Turkey</option>
                        </select>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </Card>
          )}

          {/* Print Preview */}
          <Card className="p-4">
            <h3 className="font-semibold mb-3 flex items-center gap-2">
              <Grid className="h-4 w-4" />
              Print Preview ({currentTemplateName} — {customColsPerA4 * customRowsPerA4} per A4 page)
            </h3>
            
            {selectedProducts.length === 0 ? (
              <div className="text-center py-12 text-muted-foreground">
                <Tag className="h-12 w-12 mx-auto mb-3 opacity-30" />
                <p>Select products from the left to generate price tickets</p>
              </div>
            ) : (
              <div 
                ref={printRef}
                className="bg-gray-100 rounded-lg p-4 overflow-auto"
                style={{ maxHeight: '600px' }}
              >
                {/* A4 Page Preview (scaled down) */}
                <div 
                  className="bg-white mx-auto shadow-lg"
                  style={{
                    width: '210mm',
                    minHeight: '297mm',
                    transform: 'scale(0.45)',
                    transformOrigin: 'top left',
                    display: 'flex',
                    flexWrap: 'wrap'
                  }}
                >
                  {ticketsToRender.map((product, idx) => (
                    <PriceTicket 
                      key={`${product.id}-${product.copyIndex}`}
                      product={product}
                      showOriginalPrice={showOriginalPrice}
                      showClearanceBadge={showClearanceBadge}
                      showThisWeekBadge={showThisWeekBadge}
                      showBarcode={showBarcode}
                      index={idx}
                      paperSize={currentPaperSize}
                    />
                  ))}
                </div>
              </div>
            )}
            
            {ticketsToRender.length > 0 && (
              <div className="mt-3 text-sm text-muted-foreground text-center">
                {ticketsToRender.length} ticket(s) = {Math.ceil(ticketsToRender.length / (currentPaperSize.per_a4_cols * currentPaperSize.per_a4_rows))} A4 page(s) · {customWidthMm}×{customHeightMm}mm
              </div>
            )}
          </Card>
        </div>
      </div>
    </div>
  );
};

export default PriceTickets;
