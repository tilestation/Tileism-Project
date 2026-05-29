import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { Portal } from '@radix-ui/react-portal';
import { 
  Tag, Filter, Sliders, Check, ChevronDown, ChevronRight, 
  RefreshCw, FolderOpen, Flag, Thermometer, Users, Search,
  CheckSquare, Square, Package, X, Save, Loader2
} from 'lucide-react';
import { Badge } from '../../../../components/ui/badge';
import { Input } from '../../../../components/ui/input';
import ScopeSummaryPanel from './ScopeSummaryPanel';
import { normaliseImageUrl } from '../../../../utils/safeStr';

const API_URL = process.env.REACT_APP_BACKEND_URL;

// Must match getProductKey in SupplierProducts.js exactly
const getProductKey = (p) => `${p.supplier || 'unknown'}|||${p.sku || p.supplier_code || p._id}`;

/**
 * AttributeScopePopover - Compact product checklist for per-attribute scoping.
 * Rendered via Portal to escape Dialog's transform-based containing block.
 * Uses pointer-events:auto to override Radix modal body lock.
 */
const AttributeScopePopover = ({ 
  attributeKey, 
  attributeLabel,
  scope, 
  onScopeChange, 
  onClose,
  selectedProducts, 
  products,
  triggerRect,
  allScopes,
  onApplyToAllChecked,
  fieldBreakdowns,
  getProductKey
}) => {
  const [searchTerm, setSearchTerm] = useState('');
  const [showCopyMenu, setShowCopyMenu] = useState(false);
  const [position, setPosition] = useState({ top: 0, left: 0 });
  const ref = useRef(null);
  const inputRef = useRef(null);

  // Auto-focus the search input after mount (delayed to beat any residual focus management)
  useEffect(() => {
    const timer = setTimeout(() => {
      inputRef.current?.focus();
    }, 80);
    return () => clearTimeout(timer);
  }, []);

  // Intercept focusin AND focusout events in CAPTURE phase on the document.
  // Radix Dialog's FocusScope uses BUBBLE-phase listeners to trap focus.
  // focusout fires first when focus leaves the dialog → FocusScope steals focus back.
  // focusin fires next when the popover input gets focus.
  // By stopping both in capture phase, FocusScope never sees focus leaving.
  // NOTE: ref.current is checked at event time (not setup time) to handle Portal async render.
  useEffect(() => {
    const handleFocusIn = (e) => {
      const popoverEl = ref.current;
      if (popoverEl && popoverEl.contains(e.target)) {
        e.stopImmediatePropagation();
      }
    };
    const handleFocusOut = (e) => {
      const popoverEl = ref.current;
      if (popoverEl && e.relatedTarget && popoverEl.contains(e.relatedTarget)) {
        e.stopImmediatePropagation();
      }
    };
    document.addEventListener('focusin', handleFocusIn, true);
    document.addEventListener('focusout', handleFocusOut, true);
    return () => {
      document.removeEventListener('focusin', handleFocusIn, true);
      document.removeEventListener('focusout', handleFocusOut, true);
    };
  }, []);

  // Position relative to the trigger button's viewport rect
  useEffect(() => {
    if (!triggerRect) return;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const isMobile = vw < 640;
    const popoverW = isMobile ? Math.min(320, vw - 16) : 320;
    const popoverH = isMobile ? Math.min(vh * 0.65, 500) : 380;
    const pad = 8;
    
    let left = isMobile ? (vw - popoverW) / 2 : triggerRect.left;
    if (left + popoverW > vw - pad) left = vw - popoverW - pad;
    if (left < pad) left = pad;
    
    let top = triggerRect.bottom + 4;
    if (top + popoverH > vh - pad) top = isMobile ? pad : triggerRect.top - popoverH - 4;
    if (top < pad) top = pad;
    
    setPosition({ top, left });
  }, [triggerRect]);

  // Close on outside click (delayed to prevent immediate close from triggering click)
  useEffect(() => {
    const handler = (e) => {
      if (ref.current && !ref.current.contains(e.target)) onClose();
    };
    const timer = setTimeout(() => {
      document.addEventListener('mousedown', handler);
    }, 150);
    return () => {
      clearTimeout(timer);
      document.removeEventListener('mousedown', handler);
    };
  }, [onClose]);

  // Close on Escape key
  useEffect(() => {
    const handler = (e) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [onClose]);

  const productsList = useMemo(() => {
    const keys = Array.from(selectedProducts);
    const all = products.filter(p => keys.includes(getProductKey(p)));
    if (!searchTerm.trim()) return all;
    const term = searchTerm.toLowerCase();
    return all.filter(p => {
      const name = (p.our_product_name || p.product_name || p.name || '').toLowerCase();
      return name.includes(term) || (p.sku || '').toLowerCase().includes(term)
        || (p.supplier_code || '').toLowerCase().includes(term);
    });
  }, [selectedProducts, products, searchTerm]);

  const currentScope = scope || new Set();

  // Build list of other scopes available to copy from
  const copyableSources = useMemo(() => {
    const sources = [];
    
    // 1. Other attribute scopes from the current editing session
    if (allScopes) {
      Object.entries(allScopes)
        .filter(([key, s]) => key !== attributeKey && s && s.size > 0)
        .forEach(([key, s]) => {
          const cleanKey = key.replace(/^(cat_|filter_|spec_|pv_)/, '');
          const label = cleanKey.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
          sources.push({ key, label, size: s.size, type: 'scope' });
        });
    }
    
    // 2. Previously saved value breakdowns — e.g. "Products with 20mm (6)"
    if (fieldBreakdowns && getProductKey) {
      // Find the breakdown for the current attribute's DB field
      const attrSlug = attributeKey.replace(/^(filter_|spec_|pv_)/, '');
      const possibleKeys = [attrSlug, attrSlug.replace(/-/g, '_'), `filter_${attrSlug}`];
      
      for (const bKey of Object.keys(fieldBreakdowns)) {
        const breakdown = fieldBreakdowns[bKey];
        if (!breakdown || typeof breakdown !== 'object') continue;
        
        const entries = Object.entries(breakdown).filter(([, count]) => count > 0);
        if (entries.length > 0) {
          entries.forEach(([value, count]) => {
            const displayValue = value.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
            // Build scope set from products that have this saved value
            const matchingProducts = new Set();
            products.forEach(p => {
              const pk = getProductKey(p);
              if (!selectedProducts.has(pk)) return;
              // Check if this product has the saved value
              const pVal = p[bKey] || p[bKey.replace(/_/g, '-')] || '';
              const pVals = Array.isArray(pVal) ? pVal : [pVal];
              const pValStrs = pVals.map(v => (v || '').toString().toLowerCase());
              if (pValStrs.includes(value.toLowerCase())) {
                matchingProducts.add(pk);
              }
            });
            if (matchingProducts.size > 0) {
              sources.push({
                key: `saved_${bKey}_${value}`,
                label: `Saved: ${displayValue} (${bKey.replace(/_/g, ' ')})`,
                size: matchingProducts.size,
                type: 'saved',
                scopeSet: matchingProducts
              });
            }
          });
        }
      }
    }
    
    return sources;
  }, [allScopes, attributeKey, fieldBreakdowns, products, selectedProducts, getProductKey]);

  const handleCopyScope = (src) => {
    if (src.type === 'saved' && src.scopeSet) {
      onScopeChange(attributeKey, new Set(src.scopeSet));
    } else {
      const sourceScope = allScopes[src.key];
      if (sourceScope) {
        onScopeChange(attributeKey, new Set(sourceScope));
      }
    }
    setShowCopyMenu(false);
  };

  // Extract the attribute value for mismatch warnings (e.g., "Color: Black" → "black")
  const attrValueForWarning = useMemo(() => {
    if (!attributeLabel) return null;
    // Only warn for Color-type attributes
    const colorMatch = attributeLabel.match(/^Color:\s*(.+)$/i);
    if (colorMatch) return colorMatch[1].trim().toLowerCase();
    return null;
  }, [attributeLabel]);

  const toggle = (pk) => {
    const next = new Set(currentScope);
    if (next.has(pk)) {
      next.delete(pk);
    } else {
      // Check for color mismatch before adding
      if (attrValueForWarning) {
        const product = productsList.find(p => getProductKey(p) === pk);
        const productName = (product?.product_name || product?.name || '').toLowerCase();
        if (productName && !productName.includes(attrValueForWarning)) {
          if (!window.confirm(`This product doesn't appear to be "${attributeLabel.split(': ')[1]}".\n\n"${product?.product_name || product?.name}"\n\nAre you sure you want to include it?`)) {
            return;
          }
        }
      }
      next.add(pk);
    }
    onScopeChange(attributeKey, next);
  };

  const selectAll = () => {
    const next = new Set(currentScope);
    productsList.forEach(p => next.add(getProductKey(p)));
    onScopeChange(attributeKey, next);
  };

  const deselectAll = () => {
    const next = new Set(currentScope);
    productsList.forEach(p => next.delete(getProductKey(p)));
    onScopeChange(attributeKey, next);
  };

  const clearScope = () => {
    onScopeChange(attributeKey, new Set());
    onClose();
  };

  return (
    <Portal>
      <div 
        ref={ref}
        className="fixed z-[99999] w-[min(20rem,90vw)] max-h-[70vh] flex flex-col bg-white border border-amber-300 rounded-xl shadow-2xl overflow-hidden"
        style={{ top: `${position.top}px`, left: `${position.left}px`, touchAction: 'auto' }}
        data-testid={`attr-scope-popover-${attributeKey}`}
        onMouseDown={(e) => e.stopPropagation()}
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.stopPropagation()}
        onTouchStart={(e) => e.stopPropagation()}
        onTouchMove={(e) => e.stopPropagation()}
      onWheel={(e) => {
        // Forward wheel events to the dialog's scrollable container when the
        // popover's own scroll list is at its boundary
        const scrollList = ref.current?.querySelector('.max-h-52');
        if (scrollList) {
          const { scrollTop, scrollHeight, clientHeight } = scrollList;
          const atTop = scrollTop <= 0 && e.deltaY < 0;
          const atBottom = scrollTop + clientHeight >= scrollHeight - 1 && e.deltaY > 0;
          if (atTop || atBottom) {
            // Forward to dialog scrollable area
            const dialogScroll = document.querySelector('.overflow-y-auto');
            if (dialogScroll) {
              dialogScroll.scrollTop += e.deltaY;
            }
          }
        }
      }}
    >
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 bg-amber-50 border-b border-amber-200">
        <div className="flex items-center gap-1.5 min-w-0">
          <Users className="w-3.5 h-3.5 text-amber-600 shrink-0" />
          <span className="text-xs font-semibold text-amber-800 truncate">
            Scope: {attributeLabel}
          </span>
        </div>
        <div className="flex items-center gap-1">
          {copyableSources.length > 0 && (
            <div className="relative">
              <button 
                onClick={() => setShowCopyMenu(!showCopyMenu)} 
                className="text-xs text-blue-600 hover:text-blue-800 px-1 font-medium"
                title="Copy scope from another attribute"
                data-testid={`copy-scope-btn-${attributeKey}`}
              >
                Copy from...
              </button>
              {showCopyMenu && (
                <div className="absolute right-0 top-full mt-1 w-64 bg-white border border-gray-200 rounded-lg shadow-lg z-50 py-1 max-h-64 overflow-y-auto">
                  {copyableSources.filter(s => s.type === 'saved').length > 0 && (
                    <div className="px-3 py-1 text-[10px] font-semibold text-gray-400 uppercase">Saved Values</div>
                  )}
                  {copyableSources.filter(s => s.type === 'saved').map(src => (
                    <button
                      key={src.key}
                      onClick={() => handleCopyScope(src)}
                      className="w-full text-left px-3 py-1.5 text-xs hover:bg-green-50 flex items-center justify-between gap-2"
                      data-testid={`copy-scope-option-${src.key}`}
                    >
                      <span className="truncate text-gray-700">{src.label}</span>
                      <span className="shrink-0 text-green-600 font-medium">{src.size}/{selectedProducts.size}</span>
                    </button>
                  ))}
                  {copyableSources.filter(s => s.type === 'scope').length > 0 && (
                    <div className="px-3 py-1 text-[10px] font-semibold text-gray-400 uppercase border-t mt-1 pt-1">Other Scopes</div>
                  )}
                  {copyableSources.filter(s => s.type === 'scope').map(src => (
                    <button
                      key={src.key}
                      onClick={() => handleCopyScope(src)}
                      className="w-full text-left px-3 py-1.5 text-xs hover:bg-blue-50 flex items-center justify-between gap-2"
                      data-testid={`copy-scope-option-${src.key}`}
                    >
                      <span className="truncate text-gray-700">{src.label}</span>
                      <span className="shrink-0 text-blue-600 font-medium">{src.size}/{selectedProducts.size}</span>
                    </button>
                  ))}
                  {copyableSources.length === 0 && (
                    <div className="px-3 py-2 text-xs text-gray-400">No scopes to copy from</div>
                  )}
                </div>
              )}
            </div>
          )}
          {currentScope.size > 0 && (
            <button onClick={clearScope} className="text-xs text-red-500 hover:text-red-700 px-1" title="Remove scope (apply to all)">
              Clear
            </button>
          )}
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600">
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* Search + Actions */}
      <div className="flex items-center gap-1.5 p-2 border-b">
        <div className="relative flex-1">
          <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3 h-3 text-gray-400" />
          <input
            ref={inputRef}
            type="text"
            placeholder="Search..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            onKeyDown={(e) => e.stopPropagation()}
            onMouseDown={(e) => {
              e.stopPropagation();
              // Force focus after FocusScope's synchronous focus steal
              const target = e.currentTarget;
              setTimeout(() => target.focus(), 0);
              setTimeout(() => target.focus(), 50);
            }}
            className="w-full pl-7 h-7 text-xs rounded-md border border-input bg-background px-3 py-2 ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
            data-testid={`attr-scope-search-${attributeKey}`}
          />
        </div>
        <button onClick={selectAll} className="px-1.5 py-1 text-xs bg-amber-100 text-amber-700 rounded hover:bg-amber-200" title="Select all">
          <CheckSquare className="w-3 h-3" />
        </button>
        <button onClick={deselectAll} className="px-1.5 py-1 text-xs bg-gray-100 text-gray-500 rounded hover:bg-gray-200" title="Deselect all">
          <Square className="w-3 h-3" />
        </button>
      </div>

      {/* Product list */}
      <div 
        className="max-h-[40vh] sm:max-h-52 overflow-y-auto divide-y divide-gray-100 overscroll-contain flex-1"
        style={{ WebkitOverflowScrolling: 'touch', touchAction: 'pan-y' }}
        onWheel={(e) => {
          // Manually handle wheel scrolling since react-remove-scroll from Radix Dialog blocks it
          e.stopPropagation();
          e.currentTarget.scrollTop += e.deltaY;
        }}
        onTouchStart={(e) => {
          // Allow touch scrolling inside the list by stopping propagation
          // to prevent Radix Dialog's scroll lock from intercepting
          e.stopPropagation();
        }}
        onTouchMove={(e) => {
          e.stopPropagation();
        }}
      >
        {productsList.map(product => {
          const pk = getProductKey(product);
          const checked = currentScope.has(pk);
          const name = product.product_name || product.name || product.sku;
          return (
            <div
              key={pk}
              onClick={() => toggle(pk)}
              className={`flex items-center gap-2 px-3 py-1.5 cursor-pointer hover:bg-gray-50 transition-colors ${checked ? 'bg-amber-50/60' : ''}`}
              data-testid={`attr-scope-product-${attributeKey}-${product.sku}`}
            >
              <div className={`w-4 h-4 rounded border-2 flex items-center justify-center shrink-0 transition-colors ${
                checked ? 'bg-amber-500 border-amber-500 text-white' : 'border-gray-300 bg-white'
              }`}>
                {checked && <Check className="w-2.5 h-2.5" />}
              </div>
              {(product.image || product.images?.[0]) ? (
                <img src={normaliseImageUrl(product.image || product.images?.[0])} alt="" className="w-6 h-6 object-cover rounded border shrink-0" />
              ) : (
                <div className="w-6 h-6 bg-gray-100 rounded border flex items-center justify-center shrink-0">
                  <Package className="w-3 h-3 text-gray-400" />
                </div>
              )}
              <div className="flex-1 min-w-0">
                <p title={name} className="text-xs text-gray-800 truncate">{name}</p>
              </div>
            </div>
          );
        })}
      </div>

      {/* Footer */}
      <div className="px-3 py-1.5 bg-gray-50 border-t text-xs text-gray-500 space-y-1">
        <div>
          {currentScope.size > 0 
            ? <span className="text-amber-700 font-medium">{currentScope.size}/{selectedProducts.size} products will get "{attributeLabel}"</span>
            : <span>No scope set — applies to all {selectedProducts.size}/{selectedProducts.size} products</span>
          }
        </div>
        {currentScope.size > 0 && onApplyToAllChecked && (
          <button
            type="button"
            onClick={() => { onApplyToAllChecked(attributeKey); onClose(); }}
            className="w-full text-center py-1 bg-purple-100 text-purple-700 hover:bg-purple-200 rounded font-medium transition-colors"
            data-testid={`apply-scope-to-all-${attributeKey}`}
          >
            Apply this scope to all checked in this section
          </button>
        )}
      </div>
    </div>
    </Portal>
  );
};

/**
 * ScopeableBadge - A small clickable badge that appears on selected attribute buttons
 * showing the scope count and opening the per-attribute scope popover.
 */
const ScopeableBadge = ({ 
  attributeKey, 
  attributeLabel, 
  scope, 
  isEditing, 
  onEdit, 
  onScopeChange, 
  onClose,
  selectedProducts, 
  products,
  allScopes,
  onApplyToAllChecked
}) => {
  const scopeSize = scope?.size || 0;
  const btnRef = useRef(null);
  const [triggerRect, setTriggerRect] = useState(null);

  const handleClick = (e) => {
    e.stopPropagation();
    // Capture button's viewport rect before opening popover
    if (btnRef.current) {
      setTriggerRect(btnRef.current.getBoundingClientRect());
    }
    onEdit();
  };

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        onClick={handleClick}
        className={`inline-flex items-center gap-0.5 px-1.5 py-1.5 rounded-r-lg text-xs transition-all border-l ${
          scopeSize > 0 
            ? 'bg-amber-500 text-white hover:bg-amber-600 border-amber-600' 
            : 'bg-gray-200 text-gray-500 hover:bg-amber-100 hover:text-amber-700 border-gray-300'
        }`}
        title={scopeSize > 0 ? `Scoped to ${scopeSize} products` : 'Scope to specific products'}
        data-testid={`attr-scope-btn-${attributeKey}`}
      >
        <Users className="w-3 h-3" />
        {scopeSize > 0 && <span className="font-bold text-xs">{scopeSize}/{selectedProducts.size}</span>}
      </button>
      
      {isEditing && (
        <AttributeScopePopover
          attributeKey={attributeKey}
          attributeLabel={attributeLabel}
          scope={scope}
          onScopeChange={onScopeChange}
          onClose={onClose}
          selectedProducts={selectedProducts}
          products={products}
          triggerRect={triggerRect}
          allScopes={allScopes}
          fieldBreakdowns={{}}
          getProductKey={getProductKey}
          onApplyToAllChecked={onApplyToAllChecked}
        />
      )}
    </>
  );
};

/**
 * SectionProductScope - Inline collapsible product checklist for scoping attributes
 */
const SectionProductScope = ({ 
  sectionKey, 
  scope, 
  onScopeChange, 
  selectedProducts, 
  products 
}) => {
  const [expanded, setExpanded] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');

  const selectedProductsList = useMemo(() => {
    const keys = Array.from(selectedProducts);
    const all = products.filter(p => keys.includes(getProductKey(p)));
    if (!searchTerm.trim()) return all;
    const term = searchTerm.toLowerCase();
    return all.filter(p => {
      const name = (p.our_product_name || p.product_name || p.name || '').toLowerCase();
      return name.includes(term) || (p.sku || '').toLowerCase().includes(term)
        || (p.supplier_code || '').toLowerCase().includes(term);
    });
  }, [selectedProducts, products, searchTerm]);

  const toggleProduct = (pk) => {
    const next = new Set(scope);
    if (next.has(pk)) next.delete(pk); else next.add(pk);
    onScopeChange(sectionKey, next);
  };

  const selectAll = () => {
    const next = new Set(scope);
    selectedProductsList.forEach(p => next.add(getProductKey(p)));
    onScopeChange(sectionKey, next);
  };

  const deselectAll = () => {
    const next = new Set(scope);
    selectedProductsList.forEach(p => next.delete(getProductKey(p)));
    onScopeChange(sectionKey, next);
  };

  const isActive = scope.size > 0;

  return (
    <div className={`border rounded-lg overflow-hidden transition-all ${isActive ? 'border-amber-300 bg-amber-50/50' : 'border-gray-200'}`}>
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className={`w-full flex items-center justify-between px-3 py-1.5 text-xs transition-colors ${
          isActive ? 'bg-amber-100 hover:bg-amber-150' : 'bg-gray-50 hover:bg-gray-100'
        }`}
        data-testid={`section-scope-toggle-${sectionKey}`}
      >
        <div className="flex items-center gap-1.5">
          {expanded ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
          <Users className="w-3 h-3" />
          <span className="font-medium">
            {isActive 
              ? `Section scoped to ${scope.size} of ${selectedProducts.size} products` 
              : `Apply section to all ${selectedProducts.size} products`}
          </span>
        </div>
        {isActive ? (
          <Badge className="bg-amber-600 text-white text-xs" data-testid={`section-scope-badge-${sectionKey}`}>
            {scope.size} scoped
          </Badge>
        ) : (
          <span className="text-gray-400 text-xs">Section-level scope</span>
        )}
      </button>

      {expanded && (
        <div className="p-2 space-y-2 border-t border-gray-200">
          <div className="flex items-center gap-2">
            <div className="relative flex-1">
              <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3 h-3 text-gray-400" />
              <Input type="text" placeholder="Search products..." value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)} onKeyDown={(e) => e.stopPropagation()} className="pl-7 h-7 text-xs"
                data-testid={`section-scope-search-${sectionKey}`} />
            </div>
            <button type="button" onClick={selectAll} className="px-2 py-1 text-xs bg-amber-100 text-amber-700 rounded hover:bg-amber-200 flex items-center gap-1">
              <CheckSquare className="w-3 h-3" /> All
            </button>
            <button type="button" onClick={deselectAll} className="px-2 py-1 text-xs bg-gray-100 text-gray-600 rounded hover:bg-gray-200 flex items-center gap-1">
              <Square className="w-3 h-3" /> None
            </button>
          </div>

          <div className="max-h-48 overflow-y-auto border rounded divide-y">
            {selectedProductsList.length === 0 ? (
              <div className="p-3 text-center text-gray-400 text-xs">{searchTerm ? 'No match' : 'No products'}</div>
            ) : (
              selectedProductsList.map(product => {
                const pk = getProductKey(product);
                const isScoped = scope.has(pk);
                const name = product.product_name || product.name || product.sku;
                return (
                  <div key={pk} onClick={() => toggleProduct(pk)}
                    className={`flex items-center gap-2 px-2 py-1.5 cursor-pointer hover:bg-gray-50 ${isScoped ? 'bg-amber-50' : ''}`}
                    data-testid={`section-scope-product-${sectionKey}-${product.sku}`}>
                    <div className={`w-4 h-4 rounded border-2 flex items-center justify-center shrink-0 ${
                      isScoped ? 'bg-amber-500 border-amber-500 text-white' : 'border-gray-300 bg-white'
                    }`}>{isScoped && <Check className="w-2.5 h-2.5" />}</div>
                    <div className="flex-1 min-w-0">
                      <p title={name} className="text-xs font-medium text-gray-800 truncate">{name}</p>
                      <p className="text-xs text-gray-400 truncate">{product.sku}</p>
                    </div>
                  </div>
                );
              })
            )}
          </div>

          {isActive && (
            <p className="text-xs text-amber-700 pt-1 border-t">
              <strong>{scope.size}</strong> product{scope.size !== 1 ? 's' : ''} receive ALL attributes from this section.
            </p>
          )}
        </div>
      )}
    </div>
  );
};

/**
 * BulkCategoryEditorSections - Unified sections matching Navigation & Structure
 * Now supports per-attribute product scoping via inline scope badges.
 */
const BulkCategoryEditorSections = ({
  categoryGroups = [],
  selectedProductGroup = 'tiles',
  bulkCategorySelections = {},
  setBulkCategorySelections,
  productOptions = {},
  selectedProducts = new Set(),
  products = [],
  pricingSizeFilter = 'all',
  productSubSelection = new Set(),
  setProductSubSelection = () => {},
  defaultMaterial = 'Porcelain',
  fieldBreakdowns = {},
  fieldsToClear = {},
  setFieldsToClear = () => {},
  perProductAssignments = {},
  setPerProductAssignments = () => {},
  sectionProductScopes = { categories: new Set(), filters: new Set(), specifications: new Set() },
  setSectionProductScopes = () => {},
  perAttributeScopes = {},
  setPerAttributeScopes = () => {},
  onScopePopoverChange = () => {},
  onQuickSave = null
}) => {
  const [loading, setLoading] = useState(true);
  const [categoriesByGroup, setCategoriesByGroup] = useState({});
  const [filters, setFilters] = useState([]);
  const [specifications, setSpecifications] = useState({});
  
  const [activeAttribute, setActiveAttribute] = useState(null);
  // Track which attribute's scope popover is open
  const [editingScopeForRaw, setEditingScopeForRaw] = useState(null);
  
  // Wrap setter to notify parent about popover open/close
  const editingScopeFor = editingScopeForRaw;
  const setEditingScopeFor = useCallback((val) => {
    setEditingScopeForRaw(val);
    onScopePopoverChange(val !== null);
  }, [onScopePopoverChange]);
  
  const [collapsedSections, setCollapsedSections] = useState({
    productSelection: true,
    categories: false,
    filters: false,
    specifications: false
  });
  
  // Per-filter search term for quickly finding values
  const [filterValueSearch, setFilterValueSearch] = useState({});
  
  const [collapsedFilters, setCollapsedFilters] = useState({});
  const [savingAttr, setSavingAttr] = useState(null); // tracks which attr is currently quick-saving

  // Toggle a saved value for removal
  const toggleValueRemoval = useCallback((field, value) => {
    setFieldsToClear(prev => {
      const current = prev[field] || [];
      const isMarked = current.includes(value);
      if (isMarked) {
        const updated = current.filter(v => v !== value);
        if (updated.length === 0) {
          const { [field]: _, ...rest } = prev;
          return rest;
        }
        return { ...prev, [field]: updated };
      } else {
        return { ...prev, [field]: [...current, value] };
      }
    });
  }, [setFieldsToClear]);
  const [productSearchTerm, setProductSearchTerm] = useState('');

  // Quick Save handler — wraps parent callback with loading state
  const handleQuickSaveClick = useCallback(async (attrKey, attrType) => {
    if (!onQuickSave || savingAttr) return;
    setSavingAttr(attrKey);
    try {
      await onQuickSave(attrKey, attrType);
    } finally {
      setSavingAttr(null);
    }
  }, [onQuickSave, savingAttr]);

  // Build scope preview data: which values go to how many products
  const getScopePreviewData = useCallback((attrKey, values) => {
    if (!values || values.length === 0) return null;
    const hasScopes = values.some(v => {
      const pvKey = `${attrKey}__${v}`;
      return perAttributeScopes[pvKey] && perAttributeScopes[pvKey].size > 0;
    });
    if (!hasScopes) return null;
    
    const totalProducts = selectedProducts.size;
    const preview = [];
    const unscopedValues = [];
    for (const v of values) {
      const pvKey = `${attrKey}__${v}`;
      const scope = perAttributeScopes[pvKey];
      if (scope && scope.size > 0) {
        preview.push({ value: v, count: scope.size });
      } else {
        unscopedValues.push(v);
      }
    }
    // Count products NOT in any scope (they'll get the unscoped default)
    const scopedProductKeys = new Set();
    for (const v of values) {
      const pvKey = `${attrKey}__${v}`;
      const scope = perAttributeScopes[pvKey];
      if (scope) scope.forEach(pk => scopedProductKeys.add(pk));
    }
    const unscopedCount = totalProducts - scopedProductKeys.size;
    if (unscopedValues.length > 0 && unscopedCount > 0) {
      preview.push({ value: unscopedValues[0], count: unscopedCount, isDefault: true });
    }
    return preview.length > 0 ? preview : null;
  }, [perAttributeScopes, selectedProducts]);


  const handleSectionScopeChange = useCallback((sectionKey, newScope) => {
    setSectionProductScopes(prev => ({ ...prev, [sectionKey]: newScope }));
  }, [setSectionProductScopes]);

  const handleAttributeScopeChange = useCallback((attrKey, newScope) => {
    const updated = { ...perAttributeScopes, [attrKey]: newScope };
    
    // Sync scope from spec to filter (Specs → Filters direction)
    // attrKey format: "spec_{slug}__{value}" or "spec_{slug}"
    if (attrKey.startsWith('spec_')) {
      const withoutPrefix = attrKey.slice(5); // remove "spec_"
      // Check if this is a per-value scope (contains "__")
      const doubleUnderIdx = withoutPrefix.indexOf('__');
      const specSlug = doubleUnderIdx >= 0 ? withoutPrefix.slice(0, doubleUnderIdx) : withoutPrefix;
      const filterSlug = SPEC_TO_FILTER_SYNC[specSlug];
      if (filterSlug) {
        const filterKey = attrKey.replace(`spec_${specSlug}`, `filter_${filterSlug}`);
        updated[filterKey] = newScope ? new Set(newScope) : newScope;
      }
    }
    
    setPerAttributeScopes(updated);
  }, [perAttributeScopes, setPerAttributeScopes]);

  // Apply one attribute's scope to all other checked attributes in the same section
  const handleApplyToAllCheckedCategories = useCallback((sourceKey) => {
    const sourceScope = perAttributeScopes[sourceKey];
    if (!sourceScope || sourceScope.size === 0) return;
    const newScopes = { ...perAttributeScopes };
    // Find all selected category keys
    Object.keys(bulkCategorySelections).forEach(k => {
      if (k.startsWith('cat_') && bulkCategorySelections[k] && k !== sourceKey) {
        newScopes[k] = new Set(sourceScope);
      }
    });
    setPerAttributeScopes(newScopes);
  }, [perAttributeScopes, bulkCategorySelections, setPerAttributeScopes]);

  const handleApplyToAllCheckedFilters = useCallback((sourceKey) => {
    const sourceScope = perAttributeScopes[sourceKey];
    if (!sourceScope || sourceScope.size === 0) return;
    const newScopes = { ...perAttributeScopes };
    // Apply to all selected filter values and filter-level keys
    Object.keys(bulkCategorySelections).forEach(k => {
      if (k.startsWith('filter_') && k !== sourceKey) {
        const vals = bulkCategorySelections[k];
        if (Array.isArray(vals) && vals.length > 0) {
          // Filter-level scope
          newScopes[k] = new Set(sourceScope);
        } else if (vals === true) {
          newScopes[k] = new Set(sourceScope);
        }
      }
    });
    setPerAttributeScopes(newScopes);
  }, [perAttributeScopes, bulkCategorySelections, setPerAttributeScopes]);

  const handleApplyToAllCheckedSpecs = useCallback((sourceKey) => {
    const sourceScope = perAttributeScopes[sourceKey];
    if (!sourceScope || sourceScope.size === 0) return;
    const newScopes = { ...perAttributeScopes };
    Object.keys(bulkCategorySelections).forEach(k => {
      if (k.startsWith('spec_') && bulkCategorySelections[k] && k !== sourceKey) {
        newScopes[k] = new Set(sourceScope);
        // Sync to corresponding filter scope
        const withoutPrefix = k.slice(5);
        const doubleUnderIdx = withoutPrefix.indexOf('__');
        const specSlug = doubleUnderIdx >= 0 ? withoutPrefix.slice(0, doubleUnderIdx) : withoutPrefix;
        const filterSlug = SPEC_TO_FILTER_SYNC[specSlug];
        if (filterSlug) {
          const filterKey = k.replace(`spec_${specSlug}`, `filter_${filterSlug}`);
          newScopes[filterKey] = new Set(sourceScope);
        }
      }
    });
    setPerAttributeScopes(newScopes);
  }, [perAttributeScopes, bulkCategorySelections, setPerAttributeScopes]);

  const getSelectedProductsList = useCallback(() => {
    const keys = Array.from(selectedProducts);
    return products.filter(p => keys.includes(getProductKey(p)));
  }, [selectedProducts, products]);

  const selectedProductsList = useMemo(() => {
    const keys = Array.from(selectedProducts);
    const allSelected = products.filter(p => keys.includes(getProductKey(p)));
    if (!productSearchTerm.trim()) return allSelected;
    const term = productSearchTerm.toLowerCase();
    return allSelected.filter(p => {
      const name = (p.product_name || p.name || '').toLowerCase();
      return name.includes(term) || (p.sku || '').toLowerCase().includes(term);
    });
  }, [selectedProducts, products, productSearchTerm]);

  const toggleProductSubSelection = (productKey) => {
    setProductSubSelection(prev => {
      const newSet = new Set(prev);
      if (newSet.has(productKey)) newSet.delete(productKey);
      else newSet.add(productKey);
      return newSet;
    });
  };

  const selectAllFiltered = () => {
    const newSet = new Set(productSubSelection);
    selectedProductsList.forEach(p => newSet.add(getProductKey(p)));
    setProductSubSelection(newSet);
  };

  const deselectAllFiltered = () => {
    const newSet = new Set(productSubSelection);
    selectedProductsList.forEach(p => newSet.delete(getProductKey(p)));
    setProductSubSelection(newSet);
  };

  const multiValueAttributes = useMemo(() => {
    const attrs = [];
    Object.entries(bulkCategorySelections).forEach(([key, values]) => {
      if (key.startsWith('filter_') && Array.isArray(values) && values.length >= 2) {
        const filterSlug = key.replace('filter_', '');
        const filter = filters.find(f => f.slug === filterSlug);
        if (filter) {
          const groupFilteredValues = (filter.values || []).filter(v => {
            if (selectedProductGroup === 'all') return true;
            const g = v.product_groups || [];
            return g.length === 0 || g.includes(selectedProductGroup);
          });
          attrs.push({
            key,
            type: 'filter',
            name: filter.name,
            slug: filterSlug,
            selectedValues: values,
            allValues: groupFilteredValues.map(v => ({ id: v.value || v.slug, label: v.label || v.name || v.value }))
          });
        }
      }
    });
    return attrs;
  }, [bulkCategorySelections, filters, selectedProductGroup]);

  const setProductAttributeValue = useCallback((attributeKey, productKey, value) => {
    setPerProductAssignments(prev => ({
      ...prev,
      [attributeKey]: { ...(prev[attributeKey] || {}), [productKey]: value }
    }));
  }, [setPerProductAssignments]);

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const token = localStorage.getItem('token');
      const headers = { Authorization: `Bearer ${token}` };
      const [catsByGroupRes, filtersRes, specsRes] = await Promise.all([
        fetch(`${API_URL}/api/website-admin/categories/by-group`, { headers }),
        fetch(`${API_URL}/api/filters/types`),
        fetch(`${API_URL}/api/specifications/types/by-group`)
      ]);
      if (catsByGroupRes.ok) {
        const groupsWithCats = await catsByGroupRes.json();
        const grouped = {};
        for (const group of groupsWithCats) {
          if (group.slug && group.categories) grouped[group.slug] = group.categories;
        }
        setCategoriesByGroup(grouped);
      }
      if (filtersRes.ok) setFilters((await filtersRes.json()) || []);
      if (specsRes.ok) {
        const specsList = await specsRes.json();
        const grouped = {};
        if (Array.isArray(specsList)) {
          for (const group of specsList) {
            const groupName = group.name || 'Other';
            const specs = group.specifications || [];
            if (specs.length > 0) {
              if (!grouped[groupName]) grouped[groupName] = [];
              for (const spec of specs) grouped[groupName].push(spec);
            }
          }
        }
        setSpecifications(grouped);
      }
    } catch (error) {
      console.error('Error fetching data:', error);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchData(); }, [fetchData]);

  const getFilteredCategories = () => {
    if (selectedProductGroup === 'all') return categoriesByGroup;
    return { [selectedProductGroup]: categoriesByGroup[selectedProductGroup] || [] };
  };

  const getFilteredFilters = () => {
    if (selectedProductGroup === 'all') return filters;
    return filters.filter(f => {
      const hiddenGroups = f.hidden_groups || [];
      if (hiddenGroups.includes(selectedProductGroup)) return false;
      const filterGroups = f.auto_populate_groups || [];
      return filterGroups.length === 0 || filterGroups.includes(selectedProductGroup);
    });
  };

  const getFilteredSpecifications = () => {
    if (selectedProductGroup === 'all') return specifications;
    const result = {};
    Object.entries(specifications).forEach(([groupName, specs]) => {
      const filteredSpecs = specs.filter(s => {
        const hiddenGroups = s.hidden_groups || [];
        return !hiddenGroups.includes(selectedProductGroup);
      });
      if (filteredSpecs.length > 0) result[groupName] = filteredSpecs;
    });
    return result;
  };

  // Sync mapping: Spec slug → Filter slug (Specs → Filters direction only)
  const SPEC_TO_FILTER_SYNC = { color: 'color', finish: 'finish', size: 'size', thickness: 'thickness' };

  const toggleFilterValue = (filterSlug, valueSlug) => {
    const key = `filter_${filterSlug}`;
    setBulkCategorySelections(prev => {
      const current = prev[key] || [];
      const isSelected = current.includes(valueSlug);
      return { ...prev, [key]: isSelected ? current.filter(v => v !== valueSlug) : [...current, valueSlug] };
    });
  };

  const toggleSpecValue = (specSlug, valueSlug) => {
    const key = `spec_${specSlug}`;
    setBulkCategorySelections(prev => {
      const current = prev[key];
      const currentArr = Array.isArray(current) ? current : (current ? [current] : []);
      const isAdding = !currentArr.includes(valueSlug);
      const newArr = isAdding
        ? [...currentArr, valueSlug]
        : currentArr.filter(v => v !== valueSlug);
      
      const updated = { ...prev, [key]: newArr };
      
      // Sync to corresponding filter (Specs → Filters)
      const filterSlug = SPEC_TO_FILTER_SYNC[specSlug];
      if (filterSlug) {
        const filterKey = `filter_${filterSlug}`;
        const filterCurrent = updated[filterKey] || [];
        if (isAdding && !filterCurrent.includes(valueSlug)) {
          updated[filterKey] = [...filterCurrent, valueSlug];
        } else if (!isAdding && filterCurrent.includes(valueSlug)) {
          updated[filterKey] = filterCurrent.filter(v => v !== valueSlug);
        }
      }
      
      return updated;
    });
  };

  const toggleSection = (section) => {
    setCollapsedSections(prev => ({ ...prev, [section]: !prev[section] }));
  };

  const toggleFilter = (filterSlug) => {
    setCollapsedFilters(prev => ({ ...prev, [filterSlug]: !prev[filterSlug] }));
  };

  const getAlreadySetCounts = () => {
    const list = getSelectedProductsList();
    const total = selectedProducts.size;
    const specFields = ['material', 'finish', 'edge', 'made_in', 'slip_rating',
                        'thickness', 'suitability', 'type', 'color', 'size', 
                        'pot_life', 'adhesive', 'origin'];
    const counts = { total };
    specFields.forEach(f => {
      counts[f] = list.filter(p => {
        const val = p[f] || (p.attributes && p.attributes[f]);
        return val && typeof val === 'string' ? val.trim() : val;
      }).length;
    });
    counts.underfloor_heating = list.filter(p => p.underfloor_heating).length;
    return counts;
  };

  const filteredCategories = getFilteredCategories();
  const filteredFilters = getFilteredFilters();
  const filteredSpecifications = getFilteredSpecifications();
  const alreadySetCounts = getAlreadySetCounts();

  const getSelectedCount = (filterSlug) => {
    return (bulkCategorySelections[`filter_${filterSlug}`] || []).length;
  };

  // Count how many attributes have active per-attribute scopes
  const activeScopeCount = useMemo(() => {
    return Object.values(perAttributeScopes).filter(s => s?.size > 0).length;
  }, [perAttributeScopes]);

  // Helper: find the best breakdown key for a given slug in fieldBreakdowns
  // Handles slug variations AND semantic field name mappings
  const findBreakdownKey = useCallback((slug) => {
    // Known semantic mappings where slug differs significantly from DB field
    const semanticMap = {
      'country-of-origin': 'made_in',
      'color': '_array_colors',
      'room': '_array_rooms',
      'style': '_array_styles',
      'features': '_array_features',
      'material': '_array_materials',
      'slip-rating': 'slip_rating'
    };
    
    // Try semantic mapping first
    const mapped = semanticMap[slug];
    if (mapped && fieldBreakdowns[mapped]) return mapped;
    
    // Try slug as-is and variations
    const slugUnder = slug.replace(/-/g, '_');
    const slugPlural = slugUnder.endsWith('s') ? slugUnder : slugUnder + 's';
    return fieldBreakdowns[slug] ? slug
      : fieldBreakdowns[slugUnder] ? slugUnder
      : fieldBreakdowns[`_array_${slug}`] ? `_array_${slug}`
      : fieldBreakdowns[`_array_${slugUnder}`] ? `_array_${slugUnder}`
      : fieldBreakdowns[`_array_${slugPlural}`] ? `_array_${slugPlural}`
      : fieldBreakdowns[slugPlural] ? slugPlural
      : null;
  }, [fieldBreakdowns]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-8">
        <RefreshCw className="w-6 h-6 animate-spin text-gray-400" />
        <span className="ml-2 text-gray-500">Loading from Navigation & Structure...</span>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Scoping Summary Banner */}
      {activeScopeCount > 0 && (
        <div className="flex items-center gap-2 p-2 bg-amber-50 border border-amber-300 rounded-lg" data-testid="scope-summary-banner">
          <Users className="w-4 h-4 text-amber-600" />
          <span className="text-xs font-medium text-amber-800">
            {activeScopeCount} attribute{activeScopeCount !== 1 ? 's' : ''} scoped to specific products
          </span>
          <button
            type="button"
            onClick={() => setPerAttributeScopes({})}
            className="ml-auto text-xs text-red-500 hover:text-red-700 font-medium"
            data-testid="clear-all-scopes-btn"
          >
            Clear all scopes
          </button>
        </div>
      )}

      {/* ===== PRODUCT SELECTION PANEL ===== */}
      <div className="border border-amber-200 rounded-lg overflow-hidden">
        <button
          type="button"
          onClick={() => toggleSection('productSelection')}
          className="w-full flex items-center justify-between p-3 bg-amber-50 hover:bg-amber-100 transition-colors"
        >
          <div className="flex items-center gap-2">
            {collapsedSections.productSelection ? <ChevronRight className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
            <Package className="w-4 h-4 text-amber-600" />
            <span className="font-semibold text-gray-800">Product Selection</span>
            <Badge variant="secondary" className="text-xs">{selectedProducts.size} products</Badge>
            {multiValueAttributes.length > 0 && (
              <Badge className="bg-amber-600 text-white text-xs">{multiValueAttributes.length} to assign</Badge>
            )}
          </div>
          <span className="text-xs text-gray-500">Select products for different attribute values</span>
        </button>
        
        {!collapsedSections.productSelection && (
          <div className="p-3 space-y-3">
            {multiValueAttributes.length > 0 ? (
              <>
                <div className="bg-amber-50 border border-amber-200 rounded-lg p-3">
                  <p className="text-xs font-semibold text-amber-800 mb-2">Assign values per product for:</p>
                  <div className="flex flex-wrap gap-2">
                    {multiValueAttributes.map(attr => (
                      <button
                        key={attr.key} type="button"
                        onClick={() => {
                          setActiveAttribute(attr.key === activeAttribute ? null : attr.key);
                        }}
                        className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${
                          activeAttribute === attr.key
                            ? 'bg-amber-600 text-white shadow-md'
                            : 'bg-white text-gray-700 hover:bg-amber-100 border border-gray-200'
                        }`}
                      >
                        {attr.name} ({attr.selectedValues.length} values)
                      </button>
                    ))}
                  </div>
                </div>

                {activeAttribute && (() => {
                  const attr = multiValueAttributes.find(a => a.key === activeAttribute);
                  if (!attr) return null;
                  return (
                    <div className="space-y-2">
                      <div className="flex items-center justify-between">
                        <p className="text-xs font-medium text-gray-600">
                          Assigning <span className="text-amber-700 font-bold">{attr.name}</span> values:
                        </p>
                      </div>
                      <div className="relative">
                        <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-400" />
                        <Input type="text" placeholder="Search products..." value={productSearchTerm}
                          onChange={(e) => setProductSearchTerm(e.target.value)} onKeyDown={(e) => e.stopPropagation()} className="pl-8 h-8 text-xs" />
                      </div>
                      <div className="max-h-64 overflow-y-auto border rounded-lg divide-y">
                        {selectedProductsList.map(product => {
                          const productKey = getProductKey(product);
                          const productName = product.product_name || product.name || product.sku;
                          const currentValue = perProductAssignments[attr.key]?.[productKey] || attr.selectedValues[0] || null;
                          return (
                            <div key={productKey} className="flex items-center gap-2 p-2 hover:bg-gray-50">
                              {product.image || product.images?.[0] ? (
                                <img src={normaliseImageUrl(product.image || product.images?.[0])} alt="" className="w-8 h-8 object-cover rounded border" />
                              ) : (
                                <div className="w-8 h-8 bg-gray-100 rounded border flex items-center justify-center">
                                  <Package className="w-3 h-3 text-gray-400" />
                                </div>
                              )}
                              <div className="flex-1 min-w-0">
                                <p title={productName} className="text-xs font-medium text-gray-800 truncate">{productName}</p>
                                <p title={product.sku} className="text-xs text-gray-400 truncate">{product.sku}</p>
                              </div>
                              {/* Multi-select: checkboxes for each value */}
                              <div className="flex flex-wrap gap-1 max-w-[200px]">
                                {attr.selectedValues.map(val => {
                                  const label = attr.allValues.find(v => v.id === val)?.label || val;
                                  const currentValues = (perProductAssignments[attr.key]?.[productKey] || currentValue || '').toString();
                                  const valuesArray = currentValues ? currentValues.split(',').map(v => v.trim()).filter(Boolean) : [];
                                  const isChecked = valuesArray.includes(val);
                                  return (
                                    <label key={val} className={`flex items-center gap-1 px-1.5 py-0.5 text-[10px] rounded border cursor-pointer transition-all ${
                                      isChecked ? 'bg-amber-100 border-amber-300 text-amber-800 font-medium' : 'bg-white border-gray-200 text-gray-500 hover:bg-gray-50'
                                    }`}>
                                      <input
                                        type="checkbox"
                                        className="w-3 h-3 accent-amber-500"
                                        checked={isChecked}
                                        onChange={(e) => {
                                          let newValues;
                                          if (e.target.checked) {
                                            newValues = [...valuesArray, val];
                                          } else {
                                            newValues = valuesArray.filter(v => v !== val);
                                          }
                                          setProductAttributeValue(attr.key, productKey, newValues.join(','));
                                        }}
                                      />
                                      {label}
                                    </label>
                                  );
                                })}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  );
                })()}
              </>
            ) : (
              <>
                <div className="bg-blue-50 border border-blue-100 rounded-lg p-3 text-xs text-blue-700">
                  <p className="font-medium mb-1">How to use:</p>
                  <ul className="list-disc list-inside space-y-0.5 text-blue-600">
                    <li><strong>Ticked products</strong> get the selected attribute value (e.g., Ceramic)</li>
                    <li><strong>Unticked products</strong> get the default ({defaultMaterial} for Material)</li>
                    <li>Select 2+ values for any filter to enable per-product assignment</li>
                  </ul>
                </div>

                <div className="flex items-center gap-2">
                  <div className="relative flex-1">
                    <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-400" />
                    <Input type="text" placeholder="Search products by name or SKU..."
                      value={productSearchTerm} onChange={(e) => setProductSearchTerm(e.target.value)} onKeyDown={(e) => e.stopPropagation()} className="pl-8 h-8 text-xs" />
                  </div>
                  <button type="button" onClick={selectAllFiltered}
                    className="px-2 py-1.5 text-xs bg-amber-100 text-amber-700 rounded hover:bg-amber-200 flex items-center gap-1">
                    <CheckSquare className="w-3 h-3" /> All
                  </button>
                  <button type="button" onClick={deselectAllFiltered}
                    className="px-2 py-1.5 text-xs bg-gray-100 text-gray-600 rounded hover:bg-gray-200 flex items-center gap-1">
                    <Square className="w-3 h-3" /> None
                  </button>
                </div>

                <div className="max-h-64 overflow-y-auto border rounded-lg divide-y">
                  {selectedProductsList.length === 0 ? (
                    <div className="p-4 text-center text-gray-400 text-xs">
                      {productSearchTerm ? 'No products match your search' : 'No products selected'}
                    </div>
                  ) : (
                    selectedProductsList.map(product => {
                      const productKey = getProductKey(product);
                      const isSubSelected = productSubSelection.has(productKey);
                      const productName = product.product_name || product.name || product.sku;
                      return (
                        <div key={productKey} onClick={() => toggleProductSubSelection(productKey)}
                          className={`flex items-center gap-3 p-2 cursor-pointer hover:bg-gray-50 ${isSubSelected ? 'bg-amber-50' : ''}`}>
                          <div className={`w-5 h-5 rounded border-2 flex items-center justify-center ${
                            isSubSelected ? 'bg-amber-500 border-amber-500 text-white' : 'border-gray-300 bg-white'
                          }`}>{isSubSelected && <Check className="w-3 h-3" />}</div>
                          {product.image || product.images?.[0] ? (
                            <img src={normaliseImageUrl(product.image || product.images?.[0])} alt="" className="w-10 h-10 object-cover rounded border" />
                          ) : (
                            <div className="w-10 h-10 bg-gray-100 rounded border flex items-center justify-center">
                              <Package className="w-4 h-4 text-gray-400" />
                            </div>
                          )}
                          <div className="flex-1 min-w-0">
                            <p title={productName} className="text-xs font-medium text-gray-800 truncate">{productName}</p>
                            <p className="text-xs text-gray-400 truncate">{product.sku}
                              {product.material && <span className="ml-2 text-purple-600">- {product.material}</span>}
                            </p>
                          </div>
                          {isSubSelected ? (
                            <Badge className="bg-amber-100 text-amber-700 text-xs shrink-0">Selected</Badge>
                          ) : (
                            <Badge variant="outline" className="text-gray-400 text-xs shrink-0">Default</Badge>
                          )}
                        </div>
                      );
                    })
                  )}
                </div>
              </>
            )}
          </div>
        )}
      </div>

      {/* ===== CATEGORIES SECTION ===== */}
      <div className="border border-green-200 rounded-lg overflow-hidden" id="editor-section-categories">
        <button
          type="button"
          onClick={() => toggleSection('categories')}
          className="w-full flex items-center justify-between p-3 bg-green-50 hover:bg-green-100 transition-colors"
          data-testid="section-categories-toggle"
        >
          <div className="flex items-center gap-2">
            {collapsedSections.categories ? <ChevronRight className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
            <Tag className="w-4 h-4 text-green-600" />
            <span className="font-semibold text-gray-800">Categories</span>
            <Badge variant="secondary" className="text-xs">
              {Object.values(filteredCategories).flat().length} available
            </Badge>
            <Badge className="bg-green-100 text-green-700 text-xs">Synced with Nav & Structure</Badge>
          </div>
          <span className="text-xs text-gray-500">Click attribute scope icon to assign per-product</span>
        </button>
        
        {!collapsedSections.categories && (
          <div className="p-3 space-y-3">
            {/* Section-level scope */}
            <SectionProductScope sectionKey="categories" scope={sectionProductScopes.categories}
              onScopeChange={handleSectionScopeChange} selectedProducts={selectedProducts} products={products} />

            {Object.keys(filteredCategories).length === 0 ? (
              <p className="text-sm text-gray-400 italic py-4 text-center">
                No categories available. Add categories in Navigation & Structure.
              </p>
            ) : (
              <>
                {/* Search box for categories */}
                <div className="mb-1">
                  <input
                    type="text"
                    placeholder="Search categories..."
                    value={filterValueSearch['_categories'] || ''}
                    onChange={e => setFilterValueSearch(prev => ({ ...prev, '_categories': e.target.value }))}
                    className="w-full px-2.5 py-1.5 text-xs border border-gray-200 rounded-md focus:outline-none focus:ring-1 focus:ring-green-400 focus:border-green-400 bg-gray-50"
                    data-testid="category-search-input"
                  />
                </div>
                {/* Currently saved categories breakdown */}
                {fieldBreakdowns['_array_sub_categories'] && Object.keys(fieldBreakdowns['_array_sub_categories']).length > 0 && (
                  <div className="p-2 bg-blue-50 border border-blue-100 rounded">
                    <div className="flex items-center gap-2 mb-1">
                      <p className="text-xs font-medium text-blue-700">Currently saved:</p>
                      {Object.keys(fieldBreakdowns['_array_sub_categories']).length > 1 && (
                        <Badge className="bg-amber-100 text-amber-700 text-[10px]">Mixed</Badge>
                      )}
                      <button
                        type="button"
                        onClick={() => {
                          const allValues = Object.keys(fieldBreakdowns['_array_sub_categories']);
                          setFieldsToClear(prev => ({ ...prev, sub_categories: allValues }));
                        }}
                        className="ml-auto text-[10px] text-red-500 hover:text-red-700 font-medium"
                        data-testid="delete-all-saved-categories"
                      >
                        Delete All
                      </button>
                    </div>
                    <div className="flex flex-wrap gap-1">
                      {Object.entries(fieldBreakdowns['_array_sub_categories'])
                        .sort(([,a], [,b]) => b - a)
                        .map(([value, count]) => {
                        const isMarkedForRemoval = (fieldsToClear['sub_categories'] || []).includes(value);
                        return (
                          <span key={value} className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs transition-all ${
                            isMarkedForRemoval 
                              ? 'bg-red-100 text-red-400 line-through border border-red-300' 
                              : 'bg-blue-100 text-blue-800'
                          }`}>
                            {value.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase())} <span className={isMarkedForRemoval ? 'text-red-300' : 'text-blue-500'}>({count})</span>
                            <button
                              type="button"
                              onClick={(e) => { e.stopPropagation(); toggleValueRemoval('sub_categories', value); }}
                              className={`ml-0.5 rounded-full p-0.5 transition-colors ${
                                isMarkedForRemoval 
                                  ? 'hover:bg-green-200 text-green-600' 
                                  : 'hover:bg-red-200 text-red-400'
                              }`}
                              title={isMarkedForRemoval ? 'Undo removal' : 'Remove this value'}
                              data-testid={`remove-saved-cat-${value.toLowerCase().replace(/\s+/g, '-')}`}
                            >
                              <X className="w-3 h-3" />
                            </button>
                          </span>
                        );
                      })}
                    </div>
                    {(fieldsToClear['sub_categories'] || []).length > 0 && (
                      <p className="text-[10px] text-red-500 mt-1 flex items-center gap-1">
                        <span className="font-medium">{fieldsToClear['sub_categories'].length} value(s) will be removed on save.</span>
                        <button type="button" onClick={() => setFieldsToClear(prev => { const {sub_categories: _, ...rest} = prev; return rest; })} className="underline text-red-600 hover:text-red-800">Undo all</button>
                      </p>
                    )}
                  </div>
                )}

              {Object.entries(filteredCategories).map(([groupSlug, groupCats]) => {
                const group = categoryGroups.find(g => g.slug === groupSlug);
                if (!groupCats || groupCats.length === 0) return null;
                const catSearch = (filterValueSearch['_categories'] || '').toLowerCase();
                const filteredGroupCats = catSearch 
                  ? groupCats.filter(cat => (cat.name || '').toLowerCase().includes(catSearch))
                  : groupCats;
                if (filteredGroupCats.length === 0) return null;
                const selectedCount = filteredGroupCats.filter(cat => bulkCategorySelections[`cat_${cat.slug}`]).length;
                
                return (
                  <div key={groupSlug}>
                    <div className="text-xs font-semibold text-gray-600 mb-2 flex flex-wrap items-center gap-1">
                      <FolderOpen className="w-3 h-3 text-green-600 flex-shrink-0" />
                      {group?.name || groupSlug}
                      <span className="text-gray-400">({groupCats.length} categories)</span>
                      {selectedCount > 0 && <Badge className="bg-green-600 text-white text-xs ml-1">{selectedCount} selected</Badge>}
                      {onQuickSave && selectedCount > 0 && (
                        <button
                          type="button"
                          className="ml-auto flex-shrink-0 text-xs bg-green-600 hover:bg-green-700 text-white px-2 py-0.5 rounded flex items-center gap-1"
                          disabled={savingAttr === `cat_group_${groupSlug}`}
                          onClick={async () => {
                            const catKeysToSave = groupCats
                              .filter(cat => bulkCategorySelections[`cat_${cat.slug}`])
                              .map(cat => `cat_${cat.slug}`);
                            if (catKeysToSave.length === 0) return;
                            
                            const catNames = catKeysToSave.map(k => k.replace('cat_', '').replace(/-/g, ' ')).join(', ');
                            if (!window.confirm(`Save ${selectedCount} categories (${catNames}) to all selected products?`)) return;
                            
                            setSavingAttr(`cat_group_${groupSlug}`);
                            try {
                              for (const catKey of catKeysToSave) {
                                await onQuickSave(catKey, 'cat');
                              }
                            } finally {
                              setSavingAttr(null);
                            }
                          }}
                          data-testid={`save-now-cat-group-${groupSlug}`}
                        >
                          <Save className="w-3 h-3" />
                          {savingAttr === `cat_group_${groupSlug}` ? 'Saving...' : 'Save Now'}
                        </button>
                      )}
                    </div>
                    <div className="flex flex-wrap gap-1.5">
                      {filteredGroupCats.map(cat => {
                        const key = `cat_${cat.slug}`;
                        const isSelected = bulkCategorySelections[key];
                        const scopeSize = perAttributeScopes[key]?.size || 0;
                        return (
                          <span key={cat._id || cat.slug} className="relative inline-flex items-center">
                            <button
                              type="button"
                              data-testid={`cat-btn-${cat.slug}`}
                              onClick={() => {
                                setBulkCategorySelections(prev => ({ ...prev, [key]: !prev[key] }));
                                // Clear scope when deselecting
                                if (isSelected && perAttributeScopes[key]) {
                                  setPerAttributeScopes(prev => { const n = {...prev}; delete n[key]; return n; });
                                }
                              }}
                              className={`px-2.5 py-1.5 rounded-l-lg text-xs font-medium transition-all ${
                                isSelected
                                  ? 'bg-green-600 text-white shadow-sm ring-2 ring-green-300'
                                  : 'bg-gray-100 text-gray-700 hover:bg-green-50 hover:text-green-700 border border-gray-200'
                              } ${isSelected ? 'rounded-r-none' : 'rounded-r-lg'}`}
                            >
                              {isSelected && <Check className="w-3 h-3 inline mr-1" />}
                              {cat.name}
                            </button>
                            {isSelected && (
                              <ScopeableBadge
                                attributeKey={key}
                                attributeLabel={cat.name}
                                scope={perAttributeScopes[key]}
                                isEditing={editingScopeFor === key}
                                onEdit={() => setEditingScopeFor(editingScopeFor === key ? null : key)}
                                onScopeChange={handleAttributeScopeChange}
                                onClose={() => setEditingScopeFor(null)}
                                selectedProducts={selectedProducts}
                                products={products}
                                allScopes={perAttributeScopes}
                                fieldBreakdowns={fieldBreakdowns}
                                getProductKey={getProductKey}
                                onApplyToAllChecked={handleApplyToAllCheckedCategories}
                              />
                            )}
                          </span>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
              </>
            )}
          </div>
        )}
      </div>

      {/* ===== FILTERS SECTION ===== */}
      <div className="border border-blue-200 rounded-lg overflow-hidden" id="editor-section-filters">
        <button
          type="button"
          onClick={() => toggleSection('filters')}
          className="w-full flex items-center justify-between p-3 bg-blue-50 hover:bg-blue-100 transition-colors"
          data-testid="section-filters-toggle"
        >
          <div className="flex items-center gap-2">
            {collapsedSections.filters ? <ChevronRight className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
            <Filter className="w-4 h-4 text-blue-600" />
            <span className="font-semibold text-gray-800">Filters</span>
            <Badge variant="secondary" className="text-xs">{filteredFilters.length} types</Badge>
            <Badge className="bg-green-100 text-green-700 text-xs">Synced with Nav & Structure</Badge>
          </div>
          <span className="text-xs text-gray-500">Click attribute scope icon to assign per-product</span>
        </button>
        
        {!collapsedSections.filters && (
          <div className="p-3 space-y-2">
            <SectionProductScope sectionKey="filters" scope={sectionProductScopes.filters}
              onScopeChange={handleSectionScopeChange} selectedProducts={selectedProducts} products={products} />

            {filteredFilters.length === 0 ? (
              <p className="text-sm text-gray-400 italic py-4 text-center">No filters available.</p>
            ) : (
              filteredFilters.map(filter => {
                const isCollapsed = collapsedFilters[filter.slug] !== false;
                const selectedCount = getSelectedCount(filter.slug);
                const filterKey = `filter_${filter.slug}`;
                const filterScopeSize = perAttributeScopes[filterKey]?.size || 0;
                // Count per-value scopes for this filter
                const selectedValues = bulkCategorySelections[filterKey] || [];
                const perValueScopeCount = selectedValues.filter(v => {
                  const pvKey = `filter_${filter.slug}__${v}`;
                  return perAttributeScopes[pvKey]?.size > 0;
                }).length;
                const values = (filter.values || []).filter(v => {
                  if (selectedProductGroup === 'all') return true;
                  const g = v.product_groups || [];
                  return g.length === 0 || g.includes(selectedProductGroup);
                });
                
                
                return (
                  <div key={filter._id || filter.slug} className="border rounded-lg overflow-hidden">
                    <div className="flex items-stretch bg-gray-50 gap-1">
                      <button
                        type="button"
                        onClick={() => toggleFilter(filter.slug)}
                        className="flex-1 min-w-0 flex items-center justify-between p-2 hover:bg-gray-100 transition-colors"
                      >
                        <div className="flex flex-wrap items-center gap-2 min-w-0">
                          {isCollapsed ? <ChevronRight className="w-3 h-3 flex-shrink-0" /> : <ChevronDown className="w-3 h-3 flex-shrink-0" />}
                          <span className="text-sm font-medium text-gray-700 truncate">{filter.name}</span>
                          <span className="text-xs text-gray-400">({values.length} values)</span>
                          {selectedCount > 0 && <Badge className="bg-blue-600 text-white text-xs">{selectedCount} selected</Badge>}
                          {filterScopeSize > 0 && <Badge className="bg-amber-500 text-white text-xs">{filterScopeSize} scoped</Badge>}
                          {perValueScopeCount > 0 && <Badge className="bg-amber-500 text-white text-xs">{perValueScopeCount} scoped</Badge>}
                          {(() => {
                            const bKey = findBreakdownKey(filter.slug);
                            const bd = bKey ? fieldBreakdowns[bKey] : null;
                            if (bd && Object.keys(bd).length > 1) {
                              return <Badge className="bg-amber-100 text-amber-700 text-xs">Mixed</Badge>;
                            }
                            return null;
                          })()}
                        </div>
                      </button>
                      {/* Quick Push Save button for filter — flex-shrink-0
                          + self-center pins it inside the row even when
                          the badge stack wraps to 2+ lines on mobile.
                          (24 May 2026 bug fix — user reported Save Now
                          flowed off-screen on phones.) */}
                      {onQuickSave && selectedCount > 0 && (
                        <button
                          type="button"
                          data-testid={`quick-save-filter-${filter.slug}`}
                          disabled={savingAttr === filterKey}
                          onClick={(e) => { e.stopPropagation(); handleQuickSaveClick(filterKey, 'filter'); }}
                          className="flex-shrink-0 self-center mr-2 flex items-center gap-1 px-2 py-0.5 text-[10px] font-medium rounded bg-green-600 text-white hover:bg-green-700 disabled:opacity-50 disabled:cursor-wait transition-colors"
                          title={`Save ${filter.name} now`}
                        >
                          {savingAttr === filterKey ? <Loader2 className="w-3 h-3 animate-spin" /> : <Save className="w-3 h-3" />}
                          {savingAttr === filterKey ? 'Saving...' : 'Save Now'}
                        </button>
                      )}
                    </div>
                    
                    {!isCollapsed && (
                      <div className="p-2 space-y-2">
                        {/* Scope Preview for filter */}
                        {(() => {
                          const preview = getScopePreviewData(filterKey, selectedValues);
                          if (!preview) return null;
                          return (
                            <div className="flex flex-wrap items-center gap-1 text-[10px] mb-1" data-testid={`scope-preview-filter-${filter.slug}`}>
                              <span className="text-gray-400 font-medium">Preview:</span>
                              {preview.map(({ value, count, isDefault }) => (
                                <span key={value} className={`inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded ${isDefault ? 'bg-gray-100 text-gray-500' : 'bg-blue-50 text-blue-700 border border-blue-200'}`}>
                                  {value.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase())}
                                  <span className="font-bold">{count}</span>
                                  {isDefault && <span className="text-gray-400">(default)</span>}
                                </span>
                              ))}
                            </div>
                          );
                        })()}
                        
                        {/* Filter-level scope badge */}
                        {selectedCount > 0 && (
                          <div className="relative inline-block">
                            <ScopeableBadge
                              attributeKey={filterKey}
                              attributeLabel={`${filter.name} filter`}
                              scope={perAttributeScopes[filterKey]}
                              isEditing={editingScopeFor === filterKey}
                              onEdit={() => setEditingScopeFor(editingScopeFor === filterKey ? null : filterKey)}
                              onScopeChange={handleAttributeScopeChange}
                              onClose={() => setEditingScopeFor(null)}
                              selectedProducts={selectedProducts}
                              products={products}
                              allScopes={perAttributeScopes}
                                fieldBreakdowns={fieldBreakdowns}
                                getProductKey={getProductKey}
                              onApplyToAllChecked={handleApplyToAllCheckedFilters}
                            />
                          </div>
                        )}

                        {values.length === 0 ? (
                          <p className="text-xs text-gray-400 italic">No values. Add in Navigation & Structure.</p>
                        ) : (
                          <div className="space-y-1">
                            {/* Currently saved breakdown for this filter */}
                            {(() => {
                              // DB field mapping for removal operations
                              const filterToDbField = {
                                'color': 'colors', 'room': 'rooms', 'style': 'styles',
                                'features': 'features', 'material': 'materials',
                                'slip-rating': 'slip_rating', 'country-of-origin': 'made_in'
                              };
                              
                              const slug = filter.slug;
                              const slugUnder = slug.replace(/-/g, '_');
                              
                              const bKey = findBreakdownKey(slug);
                              const dbField = filterToDbField[slug] || slugUnder || slug;
                              const breakdown = bKey ? fieldBreakdowns[bKey] : null;
                              if (breakdown && Object.keys(breakdown).length > 0) {
                                const entries = Object.entries(breakdown).sort(([,a],[,b]) => b - a);
                                const removals = fieldsToClear[dbField] || [];
                                return (
                                  <div className="p-2 bg-blue-50 border border-blue-100 rounded mb-1">
                                    <div className="flex items-center gap-2 mb-1">
                                      <p className="text-xs font-medium text-blue-700">Currently saved:</p>
                                      {entries.length > 1 && (
                                        <Badge className="bg-amber-100 text-amber-700 text-[10px]">Mixed</Badge>
                                      )}
                                      <button
                                        type="button"
                                        onClick={() => {
                                          const allValues = entries.map(([value]) => value);
                                          setFieldsToClear(prev => ({ ...prev, [dbField]: allValues }));
                                        }}
                                        className="ml-auto text-[10px] text-red-500 hover:text-red-700 font-medium"
                                        data-testid={`delete-all-saved-filter-${slug}`}
                                      >
                                        Delete All
                                      </button>
                                    </div>
                                    <div className="flex flex-wrap gap-1">
                                      {entries.map(([value, count]) => {
                                        const isMarkedForRemoval = removals.includes(value);
                                        const displayValue = value.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase()).replace(/\bR(\d+)\b/gi, (_, n) => `R${n}`);
                                        return (
                                          <span key={value} className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs transition-all ${
                                            isMarkedForRemoval
                                              ? 'bg-red-100 text-red-400 line-through border border-red-300'
                                              : 'bg-blue-100 text-blue-800'
                                          }`}>
                                            {displayValue} <span className={isMarkedForRemoval ? 'text-red-300' : 'text-blue-500'}>({count})</span>
                                            <button
                                              type="button"
                                              onClick={(e) => { e.stopPropagation(); toggleValueRemoval(dbField, value); }}
                                              className={`ml-0.5 rounded-full p-0.5 transition-colors ${
                                                isMarkedForRemoval ? 'hover:bg-green-200 text-green-600' : 'hover:bg-red-200 text-red-400'
                                              }`}
                                              title={isMarkedForRemoval ? 'Undo removal' : 'Remove this value'}
                                            >
                                              <X className="w-3 h-3" />
                                            </button>
                                          </span>
                                        );
                                      })}
                                    </div>
                                    {removals.length > 0 && (
                                      <p className="text-[10px] text-red-500 mt-1 flex items-center gap-1">
                                        <span className="font-medium">{removals.length} value(s) will be removed on save.</span>
                                        <button type="button" onClick={() => setFieldsToClear(prev => { const {[dbField]: _, ...rest} = prev; return rest; })} className="underline text-red-600 hover:text-red-800">Undo all</button>
                                      </p>
                                    )}
                                  </div>
                                );
                              }
                              return null;
                            })()}

                            {/* Quick search box for filter values */}
                            {values.length > 10 && (
                              <div className="mb-1.5">
                                <input
                                  type="text"
                                  placeholder={`Search ${filter.name}...`}
                                  value={filterValueSearch[filter.slug] || ''}
                                  onChange={e => setFilterValueSearch(prev => ({ ...prev, [filter.slug]: e.target.value }))}
                                  className="w-full px-2.5 py-1.5 text-xs border border-gray-200 rounded-md focus:outline-none focus:ring-1 focus:ring-blue-400 focus:border-blue-400 bg-gray-50"
                                  data-testid={`filter-search-${filter.slug}`}
                                />
                              </div>
                            )}

                            {/* Select All / Deselect All toolbar */}
                            <div className="flex items-center gap-2 pb-1">
                              <button
                                type="button"
                                data-testid={`filter-select-all-${filter.slug}`}
                                onClick={() => {
                                  const allValueIds = values
                                    .filter(v => {
                                      const search = (filterValueSearch[filter.slug] || '').toLowerCase();
                                      if (!search) return true;
                                      const label = (v.label || v.name || v.value || v.slug || '').toLowerCase();
                                      return label.includes(search);
                                    })
                                    .map(v => v.value || v.slug || v.id);
                                  setBulkCategorySelections(prev => {
                                    const existing = prev[`filter_${filter.slug}`] || [];
                                    const merged = [...new Set([...existing, ...allValueIds])];
                                    return { ...prev, [`filter_${filter.slug}`]: merged };
                                  });
                                }}
                                className="text-xs text-blue-600 hover:text-blue-800 font-medium"
                              >
                                {filterValueSearch[filter.slug] ? `Select Filtered` : `Select All (${values.length})`}
                              </button>
                              <span className="text-gray-300">|</span>
                              <button
                                type="button"
                                data-testid={`filter-deselect-all-${filter.slug}`}
                                onClick={() => {
                                  setBulkCategorySelections(prev => ({
                                    ...prev,
                                    [`filter_${filter.slug}`]: []
                                  }));
                                }}
                                className="text-xs text-gray-500 hover:text-red-600 font-medium"
                              >
                                Deselect All
                              </button>
                            </div>
                            <div className="flex flex-wrap gap-1">
                            {values
                            .filter(val => {
                              const search = (filterValueSearch[filter.slug] || '').toLowerCase();
                              if (!search) return true;
                              const label = (val.label || val.name || val.value || val.slug || '').toLowerCase();
                              return label.includes(search);
                            })
                            .map(val => {
                              const valueId = val.value || val.slug || val.id;
                              const valueLabel = val.label || val.name || valueId;
                              const isSelected = (bulkCategorySelections[`filter_${filter.slug}`] || []).includes(valueId);
                              const perValueKey = `filter_${filter.slug}__${valueId}`;
                              return (
                                <span key={valueId} className="relative inline-flex items-center">
                                  <button type="button"
                                    onClick={() => toggleFilterValue(filter.slug, valueId)}
                                    className={`px-2 py-1 text-xs font-medium transition-all ${
                                      isSelected
                                        ? 'bg-blue-600 text-white shadow-sm rounded-l'
                                        : 'bg-gray-100 text-gray-700 hover:bg-blue-50 hover:text-blue-700 rounded'
                                    } ${isSelected ? 'rounded-r-none' : ''}`}>
                                    {isSelected && <Check className="w-3 h-3 inline mr-0.5" />}
                                    {valueLabel}
                                  </button>
                                  {isSelected && (
                                    <ScopeableBadge
                                      attributeKey={perValueKey}
                                      attributeLabel={`${filter.name}: ${valueLabel}`}
                                      scope={perAttributeScopes[perValueKey]}
                                      isEditing={editingScopeFor === perValueKey}
                                      onEdit={() => setEditingScopeFor(editingScopeFor === perValueKey ? null : perValueKey)}
                                      onScopeChange={handleAttributeScopeChange}
                                      onClose={() => setEditingScopeFor(null)}
                                      selectedProducts={selectedProducts}
                                      products={products}
                                      allScopes={perAttributeScopes}
                                fieldBreakdowns={fieldBreakdowns}
                                getProductKey={getProductKey}
                                      onApplyToAllChecked={handleApplyToAllCheckedFilters}
                                    />
                                  )}
                                </span>
                              );
                            })}
                          </div>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                );
              })
            )}
          </div>
        )}
      </div>

      {/* ===== SPECIFICATIONS SECTION ===== */}
      <div className="border border-purple-200 rounded-lg overflow-hidden" id="editor-section-specifications">
        <button
          type="button"
          onClick={() => toggleSection('specifications')}
          className="w-full flex items-center justify-between p-3 bg-purple-50 hover:bg-purple-100 transition-colors"
          data-testid="section-specifications-toggle"
        >
          <div className="flex items-center gap-2">
            {collapsedSections.specifications ? <ChevronRight className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
            <Sliders className="w-4 h-4 text-purple-600" />
            <span className="font-semibold text-gray-800">Specifications</span>
            <Badge variant="secondary" className="text-xs">{Object.values(filteredSpecifications).flat().length} specs</Badge>
            <Badge className="bg-green-100 text-green-700 text-xs">Synced with Nav & Structure</Badge>
          </div>
          <span className="text-xs text-gray-500">Click attribute scope icon to assign per-product</span>
        </button>
        
        {!collapsedSections.specifications && (
          <div className="p-3 space-y-4">
            <SectionProductScope sectionKey="specifications" scope={sectionProductScopes.specifications}
              onScopeChange={handleSectionScopeChange} selectedProducts={selectedProducts} products={products} />

            {/* Already Set Indicator */}
            {selectedProducts.size > 0 && (() => {
              const specDisplayNames = {
                material: 'Material', finish: 'Finish', edge: 'Edge', made_in: 'Origin',
                slip_rating: 'Slip Rating', thickness: 'Thickness', suitability: 'Suitability',
                color: 'Color', size: 'Size', type: 'Type', pot_life: 'Pot Life',
                adhesive: 'Adhesive', origin: 'Origin'
              };
              const setSpecs = Object.entries(specDisplayNames).filter(([key]) => alreadySetCounts[key] > 0);
              if (setSpecs.length === 0) return null;
              return (
                <div className="bg-blue-50 border border-blue-100 rounded-lg p-2 mb-3">
                  <div className="flex flex-wrap items-center gap-2 text-xs">
                    <span className="font-medium text-gray-600">Already set:</span>
                    {setSpecs.map(([key, label]) => (
                      <span key={key} className="bg-green-100 text-green-700 px-2 py-0.5 rounded">
                        {label}: {alreadySetCounts[key]}/{alreadySetCounts.total}
                      </span>
                    ))}
                  </div>
                </div>
              );
            })()}

            {Object.keys(filteredSpecifications).length === 0 ? (
              <p className="text-sm text-gray-400 italic py-4 text-center">No specifications available.</p>
            ) : (
              Object.entries(filteredSpecifications).map(([groupName, specs]) => (
                <div key={groupName} className="border-b border-gray-100 pb-3 last:border-0">
                  <p className="text-xs font-semibold text-purple-600 mb-2">{groupName}</p>
                  <div className="space-y-3">
                    {specs.map(spec => {
                      const specKey = `spec_${spec.slug}`;
                      const rawValue = bulkCategorySelections[specKey];
                      // Support both legacy string and new array format
                      const selectedValues = Array.isArray(rawValue) ? rawValue : (rawValue ? [rawValue] : []);
                      const selectedCount = selectedValues.length;
                      // Count per-value scopes
                      const perValueScopeCount = selectedValues.filter(v => {
                        const pvKey = `spec_${spec.slug}__${v}`;
                        return perAttributeScopes[pvKey]?.size > 0;
                      }).length;
                      const values = (spec.values || []).filter(v => {
                        if (selectedProductGroup === 'all') return true;
                        const g = v.product_groups || [];
                        return g.length === 0 || g.includes(selectedProductGroup);
                      });
                      
                      return (
                        <div key={spec._id || spec.slug}>
                          <div className="flex flex-wrap items-center gap-2 mb-1">
                            <span className="text-xs font-medium text-gray-600">{spec.name}</span>
                            <span className="text-xs text-gray-400">({values.length} values)</span>
                            {selectedCount > 0 && (
                              <Badge className="bg-purple-100 text-purple-700 text-xs">{selectedCount} selected</Badge>
                            )}
                            {perValueScopeCount > 0 && (
                              <Badge className="bg-amber-500 text-white text-xs">{perValueScopeCount} scoped</Badge>
                            )}
                            {(() => {
                              const bKey = findBreakdownKey(spec.slug);
                              const breakdown = bKey ? fieldBreakdowns[bKey] : null;
                              const hasMultiple = breakdown && Object.keys(breakdown).length > 1;
                              return hasMultiple ? <Badge className="bg-amber-100 text-amber-700 text-xs">Mixed</Badge> : null;
                            })()}
                            {/* Quick Push Save button — flex-shrink-0
                                pins it inline; ml-auto keeps it right-
                                aligned even when the badges wrap to a
                                second line on mobile. (24 May 2026 fix.) */}
                            {onQuickSave && selectedCount > 0 && (
                              <button
                                type="button"
                                data-testid={`quick-save-spec-${spec.slug}`}
                                disabled={savingAttr === specKey}
                                onClick={(e) => { e.stopPropagation(); handleQuickSaveClick(specKey, 'spec'); }}
                                className="ml-auto flex-shrink-0 flex items-center gap-1 px-2 py-0.5 text-[10px] font-medium rounded bg-green-600 text-white hover:bg-green-700 disabled:opacity-50 disabled:cursor-wait transition-colors"
                                title={`Save ${spec.name} now`}
                              >
                                {savingAttr === specKey ? <Loader2 className="w-3 h-3 animate-spin" /> : <Save className="w-3 h-3" />}
                                {savingAttr === specKey ? 'Saving...' : 'Save Now'}
                              </button>
                            )}
                          </div>
                          
                          {/* Scope Preview — shows which value → how many products */}
                          {(() => {
                            const preview = getScopePreviewData(specKey, selectedValues);
                            if (!preview) return null;
                            return (
                              <div className="mb-1.5 flex flex-wrap items-center gap-1 text-[10px]" data-testid={`scope-preview-spec-${spec.slug}`}>
                                <span className="text-gray-400 font-medium">Preview:</span>
                                {preview.map(({ value, count, isDefault }) => (
                                  <span key={value} className={`inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded ${isDefault ? 'bg-gray-100 text-gray-500' : 'bg-purple-50 text-purple-700 border border-purple-200'}`}>
                                    {value.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase())}
                                    <span className="font-bold">{count}</span>
                                    {isDefault && <span className="text-gray-400">(default)</span>}
                                  </span>
                                ))}
                              </div>
                            );
                          })()}
                          
                          {(() => {
                            const bKey = findBreakdownKey(spec.slug);
                            const breakdown = bKey ? fieldBreakdowns[bKey] : null;
                            if (!breakdown || Object.keys(breakdown).length === 0) return null;
                            const entries = Object.entries(breakdown).sort(([,a],[,b]) => b - a);
                            const dbField = spec.slug.replace(/-/g, '_');
                            const removals = fieldsToClear[dbField] || [];
                            return (
                            <div className="mb-2 p-2 bg-blue-50 border border-blue-100 rounded">
                              <div className="flex items-center gap-2 mb-1">
                                <p className="text-xs font-medium text-blue-700">Currently saved:</p>
                                {Object.keys(breakdown).length > 1 && (
                                  <Badge className="bg-amber-100 text-amber-700 text-[10px]">Mixed</Badge>
                                )}
                                <button
                                  type="button"
                                  onClick={() => {
                                    const allValues = entries.map(([value]) => value);
                                    setFieldsToClear(prev => ({ ...prev, [dbField]: allValues }));
                                  }}
                                  className="ml-auto text-[10px] text-red-500 hover:text-red-700 font-medium"
                                  data-testid={`delete-all-saved-spec-${spec.slug}`}
                                >
                                  Delete All
                                </button>
                              </div>
                              <div className="flex flex-wrap gap-1">
                                {entries
                                  .map(([value, count]) => {
                                  const isMarkedForRemoval = removals.includes(value);
                                  return (
                                    <span key={value} className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs transition-all ${
                                      isMarkedForRemoval
                                        ? 'bg-red-100 text-red-400 line-through border border-red-300'
                                        : 'bg-blue-100 text-blue-800'
                                    }`}>
                                      {value.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase()).replace(/\bR(\d+)\b/gi, (_, n) => `R${n}`)} <span className={isMarkedForRemoval ? 'text-red-300' : 'text-blue-500'}>({count})</span>
                                      <button
                                        type="button"
                                        onClick={(e) => { e.stopPropagation(); toggleValueRemoval(dbField, value); }}
                                        className={`ml-0.5 rounded-full p-0.5 transition-colors ${
                                          isMarkedForRemoval ? 'hover:bg-green-200 text-green-600' : 'hover:bg-red-200 text-red-400'
                                        }`}
                                        title={isMarkedForRemoval ? 'Undo removal' : 'Remove this value'}
                                      >
                                        <X className="w-3 h-3" />
                                      </button>
                                    </span>
                                  );
                                })}
                              </div>
                              {removals.length > 0 && (
                                <p className="text-[10px] text-red-500 mt-1 flex items-center gap-1">
                                  <span className="font-medium">{removals.length} value(s) will be removed on save.</span>
                                  <button type="button" onClick={() => setFieldsToClear(prev => { const {[dbField]: _, ...rest} = prev; return rest; })} className="underline text-red-600 hover:text-red-800">Undo all</button>
                                </p>
                              )}
                            </div>
                            );
                          })()}
                          
                          {values.length === 0 ? (
                            <p className="text-xs text-gray-400 italic">No values. Add in Navigation & Structure.</p>
                          ) : (
                            <div className="flex flex-wrap gap-1">
                              {values.map(val => {
                                const valueId = val.value || val.slug || val.id;
                                const valueLabel = val.label || val.name || valueId;
                                const isSelected = selectedValues.includes(valueId);
                                const perValueKey = `spec_${spec.slug}__${valueId}`;
                                return (
                                  <span key={valueId} className="relative inline-flex items-center">
                                    <button type="button"
                                      onClick={() => toggleSpecValue(spec.slug, valueId)}
                                      className={`px-2 py-0.5 text-xs font-medium transition-all ${
                                        isSelected
                                          ? 'bg-purple-600 text-white shadow-sm rounded-l'
                                          : 'bg-gray-100 text-gray-700 hover:bg-purple-50 hover:text-purple-700 rounded'
                                      } ${isSelected ? 'rounded-r-none' : ''}`}>
                                      {isSelected && <Check className="w-3 h-3 inline mr-0.5" />}
                                      {valueLabel}
                                    </button>
                                    {isSelected && (
                                      <ScopeableBadge
                                        attributeKey={perValueKey}
                                        attributeLabel={`${spec.name}: ${valueLabel}`}
                                        scope={perAttributeScopes[perValueKey]}
                                        isEditing={editingScopeFor === perValueKey}
                                        onEdit={() => setEditingScopeFor(editingScopeFor === perValueKey ? null : perValueKey)}
                                        onScopeChange={handleAttributeScopeChange}
                                        onClose={() => setEditingScopeFor(null)}
                                        selectedProducts={selectedProducts}
                                        products={products}
                                        allScopes={perAttributeScopes}
                                fieldBreakdowns={fieldBreakdowns}
                                getProductKey={getProductKey}
                                        onApplyToAllChecked={handleApplyToAllCheckedSpecs}
                                      />
                                    )}
                                  </span>
                                );
                              })}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              ))
            )}

            {/* Underfloor Heating */}
            <div className="pt-3 border-t border-gray-100">
              <label className="text-xs font-semibold text-gray-600 mb-1.5 block flex items-center gap-1">
                <Thermometer className="w-3 h-3" /> Underfloor Heating Suitable
              </label>
              <div className="flex gap-2">
                {['Yes', 'No'].map(option => {
                  const isSelected = bulkCategorySelections.underfloor_heating === option;
                  return (
                    <button key={option} type="button"
                      onClick={() => setBulkCategorySelections(prev => ({ ...prev, underfloor_heating: prev.underfloor_heating === option ? '' : option }))}
                      className={`px-4 py-1.5 rounded text-xs font-medium transition-all ${
                        isSelected
                          ? option === 'Yes' ? 'bg-green-600 text-white shadow-sm' : 'bg-red-500 text-white shadow-sm'
                          : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
                      }`}>
                      {isSelected && <Check className="w-3 h-3 inline mr-1" />}{option}
                    </button>
                  );
                })}
              </div>
            </div>
            
            {/* Country of Origin */}
            <div className="pt-3 border-t border-gray-100">
              <label className="text-xs font-semibold text-gray-600 mb-2 flex flex-wrap items-center gap-1">
                <Flag className="w-3 h-3 flex-shrink-0" /> Country of Origin
                {onQuickSave && bulkCategorySelections.made_in && bulkCategorySelections.made_in !== '' && (
                  <button
                    type="button"
                    className="ml-auto flex-shrink-0 text-xs bg-green-600 hover:bg-green-700 text-white px-2 py-0.5 rounded flex items-center gap-1"
                    disabled={savingAttr === 'made_in'}
                    onClick={async () => {
                      const val = bulkCategorySelections.made_in === '__CLEAR__' ? 'CLEAR' : bulkCategorySelections.made_in;
                      if (!window.confirm(`Save Country of Origin "${val}" to all selected products?`)) return;
                      setSavingAttr('made_in');
                      try {
                        await onQuickSave('made_in', 'direct');
                      } finally {
                        setSavingAttr(null);
                      }
                    }}
                    data-testid="save-now-made-in"
                  >
                    <Save className="w-3 h-3" />
                    {savingAttr === 'made_in' ? 'Saving...' : 'Save Now'}
                  </button>
                )}
              </label>
              {/* Currently saved origin breakdown */}
              {(() => {
                const bKey = findBreakdownKey('made_in') || findBreakdownKey('made-in') || findBreakdownKey('origin');
                const breakdown = bKey ? fieldBreakdowns[bKey] : null;
                if (!breakdown || Object.keys(breakdown).length === 0) return null;
                const entries = Object.entries(breakdown).sort(([,a],[,b]) => b - a);
                const removals = fieldsToClear['made_in'] || [];
                return (
                  <div className="mb-2 p-2 bg-blue-50 border border-blue-100 rounded">
                    <div className="flex items-center gap-2 mb-1">
                      <p className="text-xs font-medium text-blue-700">Currently saved:</p>
                      <button
                        type="button"
                        onClick={() => {
                          const allValues = entries.map(([value]) => value);
                          setFieldsToClear(prev => ({ ...prev, made_in: allValues }));
                        }}
                        className="ml-auto text-[10px] text-red-500 hover:text-red-700 font-medium"
                        data-testid="delete-all-saved-origin"
                      >
                        Delete All
                      </button>
                    </div>
                    <div className="flex flex-wrap gap-1">
                      {entries.map(([value, count]) => {
                        const isMarkedForRemoval = removals.includes(value);
                        return (
                          <span key={value} className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs transition-all ${
                            isMarkedForRemoval
                              ? 'bg-red-100 text-red-400 line-through border border-red-300'
                              : 'bg-blue-100 text-blue-800'
                          }`}>
                            {value} <span className={isMarkedForRemoval ? 'text-red-300' : 'text-blue-500'}>({count})</span>
                            <button
                              type="button"
                              onClick={(e) => { e.stopPropagation(); toggleValueRemoval('made_in', value); }}
                              className={`ml-0.5 rounded-full p-0.5 transition-colors ${
                                isMarkedForRemoval ? 'hover:bg-green-200 text-green-600' : 'hover:bg-red-200 text-red-400'
                              }`}
                              title={isMarkedForRemoval ? 'Undo removal' : 'Remove this value'}
                            >
                              <X className="w-3 h-3" />
                            </button>
                          </span>
                        );
                      })}
                    </div>
                    {removals.length > 0 && (
                      <p className="text-[10px] text-red-500 mt-1 flex items-center gap-1">
                        <span className="font-medium">{removals.length} value(s) will be removed on save.</span>
                        <button type="button" onClick={() => setFieldsToClear(prev => { const {made_in: _, ...rest} = prev; return rest; })} className="underline text-red-600 hover:text-red-800">Undo all</button>
                      </p>
                    )}
                  </div>
                );
              })()}
              <div className="flex flex-wrap gap-1.5">
                {/* Clear / None option */}
                <button type="button"
                  onClick={() => setBulkCategorySelections(prev => ({ ...prev, made_in: prev.made_in === '__CLEAR__' ? '' : '__CLEAR__' }))}
                  className={`px-2.5 py-1.5 rounded text-xs font-medium transition-all ${
                    bulkCategorySelections.made_in === '__CLEAR__' ? 'bg-red-600 text-white shadow-sm' : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
                  }`}>
                  {bulkCategorySelections.made_in === '__CLEAR__' && <X className="w-3 h-3 inline mr-1" />}None (Clear)
                </button>
                {[
                  { id: 'Italy', label: 'Italy' }, { id: 'Spain', label: 'Spain' },
                  { id: 'Europe', label: 'Europe' }, { id: 'Poland', label: 'Poland' },
                  { id: 'India', label: 'India' }, { id: 'Turkey', label: 'Turkey' },
                  { id: 'Portugal', label: 'Portugal' }, { id: 'Vietnam', label: 'Vietnam' },
                  { id: 'China', label: 'China' }, { id: 'UK', label: 'UK' }
                ].map(country => {
                  const isSelected = bulkCategorySelections.made_in === country.id;
                  return (
                    <button key={country.id} type="button"
                      onClick={() => setBulkCategorySelections(prev => ({ ...prev, made_in: prev.made_in === country.id ? '' : country.id }))}
                      className={`px-2.5 py-1.5 rounded text-xs font-medium transition-all ${
                        isSelected ? 'bg-green-600 text-white shadow-sm' : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
                      }`}>
                      {isSelected && <Check className="w-3 h-3 inline mr-1" />}{country.label}
                    </button>
                  );
                })}
              </div>
            </div>
          </div>
        )}
      </div>

      {/* ===== SCOPE SUMMARY PANEL ===== */}
      <ScopeSummaryPanel
        perAttributeScopes={perAttributeScopes}
        bulkCategorySelections={bulkCategorySelections}
        selectedProducts={selectedProducts}
        products={products}
      />
    </div>
  );
};

export default BulkCategoryEditorSections;
