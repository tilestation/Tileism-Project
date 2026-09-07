/**
 * QuickEditProductDrawer — self-contained wrapper around the same
 * `<QuickEditModal>` used by /admin/supplier-products, so every Manager
 * page (Materials / Tiles / Flooring / Bathroom / UFH / Tools / Custom)
 * opens the SAME "Quick Edit Product" experience with:
 *   - Product image gallery (upload / drag-reorder / set primary / delete)
 *   - Customer-Facing block (Display Name + auto-generated Display Code)
 *   - Internal block (Supplier Product Name + Supplier Product Code)
 *   - List Price / Cost Price / Stock / Featured toggle
 *   - Category suggestions autocomplete
 *   - OPTIONAL collapsible "More Specs" panel (below Featured) — pulled from
 *     the Manager's config (spec_fields + filter_facets) so admins can edit
 *     category-specific fields (Bag Colour, Coverage m²/bag, VOC Rating…)
 *     without leaving the Quick Edit modal.
 *
 * All state + handlers live here so the parent only passes `product` +
 * `open` + `onOpenChange` + `onSaved` and doesn't need to reproduce the
 * 20+ props the raw modal takes.
 */
import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { toast } from 'sonner';
import { ChevronDown, ChevronRight, Sliders, Tag, ExternalLink, Percent, FileText, Eye, Layers, Palette, Ruler, Sparkles, Link2, PenLine, X as XIcon, Pin, Search, Heart, PackagePlus, LayoutGrid, Check, Truck, Flame } from 'lucide-react';
import QuickEditModal from '../supplier-products/QuickEditModal';
import SellingRulesCard from './SellingRulesCard';
import { rowFromProduct, rulesChanged, validateRules, palletPayload, deliveryPayload, saveSellingRules } from './sellingRules';
import { getSeriesName } from '../../lib/series';
import { fetchShopTabDestinations, filterShopTabPagesForManager } from '../../lib/shopTabDestinations';

const API_URL = process.env.REACT_APP_BACKEND_URL;
const isClearanceLabel = (l) => String(l || '').trim().toLowerCase() === 'clearance';

const emptyForm = () => ({
  name: '',
  display_name: '',
  display_code: '',
  supplier_product_name: '',
  supplier_product_code: '',
  product_name: '',
  original_series: '',
  price: '',
  cost_price: '',
  stock_quantity: '',
  stock_m2: '',
  category: '',
  finish: '',
  in_stock: true,
  always_in_stock: false,
  is_featured: false,
  images: [],
  // Sale panel fields — surface the customer-facing "SALE PRICE, WAS X, NOW Y,
  // SAVE Z, N% OFF" ribbon controls directly in Quick Edit.
  sale_active: false,
  was_price: '',
  clearance: false,
  // Rich long description that renders on the customer /shop/collection page
  // under "About This Product". Stored as a plain string (markdown-lite).
  description: '',
});

const QuickEditProductDrawer = ({ open, onOpenChange, product, onSaved, previewImages, setPreviewImages, moreSpecsConfig, managerSlug = null }) => {
  const [form, setForm] = useState(emptyForm());
  const [loading, setLoading] = useState(false);
  const [imageUploading, setImageUploading] = useState(false);
  const [draggedImageIndex, setDraggedImageIndex] = useState(null);
  const [displayCodePreview, setDisplayCodePreview] = useState('');
  const [showCategorySuggestions, setShowCategorySuggestions] = useState(false);
  const [categorySuggestions, setCategorySuggestions] = useState([]);
  const [moreSpecsOpen, setMoreSpecsOpen] = useState(false);
  const [moreSpecsValues, setMoreSpecsValues] = useState({});
  // Per-product label overrides — lets admins rename e.g. "Bag Colour" to
  // "Bottle Colour" on a 1L cleaner without changing the Manager's default
  // config. Stored on the product doc as `field_label_overrides: {key:label}`.
  const [labelOverrides, setLabelOverrides] = useState({});
  const [editingLabelKey, setEditingLabelKey] = useState(null);
  // Ad-hoc per-product spec rows (label + value pairs). Stored on the product
  // doc as `custom_specs: [{key,label,value}]` so admins can attach fields
  // that don't exist in the Manager config (Dilution Ratio, Bottle Volume…).
  const [customSpecs, setCustomSpecs] = useState([]);
  // Variants panel state — groups sibling SKUs (colour / finish / size swatches)
  // for the customer landing page. Backend: /api/supplier-sync/variants/*
  const [variantsOpen, setVariantsOpen] = useState(false);
  const [variantMembers, setVariantMembers] = useState([]);  // current group members
  const [variantCandidates, setVariantCandidates] = useState([]);  // siblings not yet grouped
  const [variantSelected, setVariantSelected] = useState({});  // {sku: true} for candidates
  const [variantsLoading, setVariantsLoading] = useState(false);
  const [variantsBusy, setVariantsBusy] = useState(false);
  // Related Products panel — admin-pinned "Customers Also Liked" and
  // "You May Also Need" entries. Stored on the doc as `related_products`.
  const [relatedOpen, setRelatedOpen] = useState(false);
  const [relatedPins, setRelatedPins] = useState([]);
  const [relatedQuery, setRelatedQuery] = useState('');
  const [relatedResults, setRelatedResults] = useState([]);
  const [relatedSearching, setRelatedSearching] = useState(false);
  const relatedDebounceRef = useRef(null);
  // Shop Tabs panel — stage which storefront tabs this product appears under.
  const [shopTabsOpen, setShopTabsOpen] = useState(false);
  const [shopTabPages, setShopTabPages] = useState(null);
  const [tabsChecked, setTabsChecked] = useState({}); // category_name -> bool (staged)
  const [tabsBaseline, setTabsBaseline] = useState(new Set());
  // Pallets & Delivery rules for THIS product (pallet rates, pallet-only,
  // mandatory delivery £, parcel). Seeded from the doc; saved only when changed.
  const [rules, setRules] = useState(null);
  const rulesSeedRef = useRef(null);
  const debounceRef = useRef(null);

  // Preview images fallback if the caller didn't supply one
  const [localPreviewImages, setLocalPreviewImages] = useState(null);
  const effectivePreviewImages = previewImages ?? localPreviewImages;
  const effectiveSetPreviewImages = setPreviewImages ?? setLocalPreviewImages;

  // Seed the form the moment the modal opens for a new product
  useEffect(() => {
    if (!open || !product) return;
    const productImages = product.images && product.images.length > 0
      ? product.images
      : (product.image ? [product.image] : []);
    const displayName = product.product_name || product.display_name || product.our_product_name || product.name || '';
    const displayCode = product.display_code || '';
    setForm({
      name: product.name || '',
      display_name: displayName,
      display_code: displayCode,
      supplier_product_name: product.supplier_product_name || product.original_series || product.name || '',
      supplier_product_code: product.sku || product.supplier_code || '',
      product_name: displayName,
      original_series: product.original_series || product.supplier_product_name || '',
      price: product.price ?? product.list_price ?? '',
      pricing_unit: product.pricing_unit || '',
      cost_price: product.cost_price ?? product.wholesale_price ?? '',
      stock_quantity: product.stock_quantity ?? '',
      stock_m2: product.stock_m2 ?? '',
      category: product.category || '',
      finish: product.finish || '',
      in_stock: product.in_stock !== false,
      always_in_stock: !!product.always_in_stock,
      is_featured: !!product.is_featured,
      images: productImages,
      // Sale + Description fields — surface for per-product editing so admins
      // don't have to open a separate bulk modal for a single product.
      sale_active: !!product.sale_active,
      was_price: product.was_price ?? '',
      clearance: [...(product.labels || []), ...(product.custom_labels || [])].some(isClearanceLabel),
      description: product.description || product.short_description || '',
    });
    setDisplayCodePreview(displayCode);
    setShowCategorySuggestions(false);
    // Seed the moreSpecs form from the product so admin can edit existing values.
    const seed = {};
    (moreSpecsConfig?.spec_fields || []).concat(moreSpecsConfig?.filter_facets || []).forEach(f => {
      seed[f.key] = product[f.key] ?? '';
    });
    setMoreSpecsValues(seed);
    // Seed per-product label overrides + custom specs so admins can pick up
    // where they left off editing.
    setLabelOverrides({ ...(product.field_label_overrides || {}) });
    setCustomSpecs(Array.isArray(product.custom_specs) ? product.custom_specs.map(cs => ({ ...cs })) : []);
    setEditingLabelKey(null);
    setMoreSpecsOpen(false); // collapsed by default; admins expand if they need it
    // Reset variants panel state whenever a new product is loaded.
    setVariantsOpen(false);
    setVariantMembers([]);
    setVariantCandidates([]);
    setVariantSelected({});
    // Reset the Related Products panel + seed pins from the product doc.
    setRelatedOpen(false);
    setRelatedPins(Array.isArray(product.related_products) ? product.related_products.map(p => ({ ...p })) : []);
    setRelatedQuery('');
    setRelatedResults([]);
    // Seed the Shop Tabs panel from the product's current sub_categories.
    setShopTabsOpen(false);
    setTabsChecked({});
    setTabsBaseline(new Set((Array.isArray(product.sub_categories) ? product.sub_categories : []).map(c => String(c).toLowerCase())));
    const seededRules = rowFromProduct(product, (product.pricing_unit === 'unit' || product.product_group === 'materials') ? 'unit' : 'm2');
    rulesSeedRef.current = seededRules;
    setRules(seededRules);
    fetchCategorySuggestions();
  }, [open, product]);

  const fetchCategorySuggestions = async () => {
    try {
      const res = await fetch(`${API_URL}/api/supplier-sync/category-suggestions`);
      if (res.ok) {
        const data = await res.json();
        setCategorySuggestions(data.categories || data || []);
      }
    } catch {
      // silent — autocomplete is nice-to-have
    }
  };

  const generateDisplayCodePreview = async (displayName) => {
    if (!displayName || !displayName.trim()) { setDisplayCodePreview(''); return; }
    try {
      const res = await fetch(`${API_URL}/api/supplier-sync/generate-display-code?display_name=${encodeURIComponent(displayName)}`);
      if (res.ok) {
        const data = await res.json();
        if (data.success) {
          setDisplayCodePreview(data.display_code);
          setForm(prev => ({ ...prev, display_code: data.display_code }));
        }
      }
    } catch {
      // silent — server may be unavailable
    }
  };

  const onDisplayNameChange = (newName) => {
    setForm(prev => ({ ...prev, display_name: newName, product_name: newName }));
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => generateDisplayCodePreview(newName), 300);
  };

  const onSave = async () => {
    if (!product) return;
    const rulesNeedSave = rules && rulesSeedRef.current && rulesChanged(rules, rulesSeedRef.current);
    if (rulesNeedSave) {
      const err = validateRules(rules, 'Pallets & Delivery');
      if (err) { toast.error(err); return; }
    }
    if (form.sale_active) {
      const was = parseFloat(form.was_price); const now = parseFloat(form.price);
      if (!(was > 0)) { toast.error('SALE is ticked — enter the Was £ (crossed-out price)'); return; }
      if (!(now > 0) || was <= now) { toast.error(`Was £${was.toFixed(2)} must be higher than the List (Now) price £${(now || 0).toFixed(2)}`); return; }
    }
    setLoading(true);
    try {
      const updateData = {
        product_id: product._id,
        sku: product.sku || product.supplier_code || product._id,
        supplier_code: product.supplier_code,
        supplier: product.supplier,
        display_name: form.display_name,
        display_code: form.display_code || displayCodePreview,
        supplier_product_name: form.supplier_product_name,
        supplier_product_code: form.supplier_product_code,
        new_sku: form.supplier_product_code !== product.sku ? form.supplier_product_code : null,
        product_name: form.display_name,
        original_series: form.original_series,
        price: form.price === '' ? null : parseFloat(form.price),
        pricing_unit: form.pricing_unit || null,
        cost_price: form.cost_price === '' ? null : parseFloat(form.cost_price),
        stock_quantity: form.stock_quantity === '' ? null : parseFloat(form.stock_quantity),
        stock_m2: form.stock_m2 === '' ? null : parseFloat(form.stock_m2),
        category: form.category,
        finish: form.finish,
        in_stock: form.in_stock,
        always_in_stock: form.always_in_stock,
        is_featured: form.is_featured,
        images: form.images,
        image: form.images.length > 0 ? form.images[0] : null,
        // Sale + description — persist directly via quick-update so admins
        // don't need the bulk modal for a single product.
        sale_active: !!form.sale_active,
        was_price: (!form.sale_active || form.was_price === '') ? null : parseFloat(form.was_price),
        // CLEARANCE is a label — send the full list only when the tick changed
        ...(form.clearance !== [...(product.labels || []), ...(product.custom_labels || [])].some(isClearanceLabel)
          ? { labels: form.clearance
              ? [...(product.labels || []).filter(l => !isClearanceLabel(l)), 'Clearance']
              : (product.labels || []).filter(l => !isClearanceLabel(l)),
            ...(form.clearance ? {} : { custom_labels: (product.custom_labels || []).filter(l => !isClearanceLabel(l)) }) }
          : {}),
        description: form.description,
        related_products: relatedPins.map(p => ({
          sku: p.sku,
          kind: p.kind,
          series_name: p.series_name || '',
          display_name: p.display_name || '',
          image: p.image || null,
        })),
      };
      const res = await fetch(`${API_URL}/api/supplier-sync/products/quick-update`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updateData),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        toast.error(err.detail || 'Failed to update product');
        return;
      }
      // Also write any More Specs edits in the SAME await window so the
      // success toast reflects the full save AND the modal doesn't close
      // before the second write finishes.
      const moreSpecsUpdates = collectMoreSpecsUpdates();
      if (Object.keys(moreSpecsUpdates).length > 0) {
        try {
          const sku2 = product.sku || product.supplier_code;
          const token = localStorage.getItem('token');
          const res2 = await fetch(`${API_URL}/api/supplier-sync/products/bulk-update-unified`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              ...(token ? { Authorization: `Bearer ${token}` } : {}),
            },
            body: JSON.stringify({
              product_ids: [sku2],
              id_field: product.sku ? 'sku' : 'supplier_code',
              updates: moreSpecsUpdates,
              mode: 'replace',
              update_mode: 'replace',
            }),
          });
          if (!res2.ok) throw new Error(`HTTP ${res2.status}`);
        } catch (err) {
          toast.error(`Extra specs save failed: ${err.message}`);
          // Don't rethrow — the primary save still succeeded.
        }
      }
      const extraCount = Object.keys(moreSpecsUpdates).length;
      // Pallets & Delivery rules — per-item pallet rates / pallet-only and
      // mandatory delivery / parcel. Mirrored to the live tile by the endpoints.
      if (rulesNeedSave) {
        try {
          await saveSellingRules({
            palletProducts: [palletPayload(product, rules)],
            deliveryProducts: [deliveryPayload(product, rules)],
          });
        } catch (err) {
          toast.error(`Pallets & delivery save failed: ${err.message}`);
        }
      }
      // Apply staged Shop Tabs changes (idempotent add/remove on sub_categories).
      const tabAdds = Object.entries(tabsChecked).filter(([, v]) => v).map(([k]) => k);
      const tabRemoves = Object.entries(tabsChecked).filter(([, v]) => !v).map(([k]) => k);
      if (tabAdds.length > 0 || tabRemoves.length > 0) {
        try {
          const res3 = await fetch(`${API_URL}/api/supplier-sync/products/assign-shop-tabs`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              skus: product.sku ? [product.sku] : [],
              supplier_codes: !product.sku && product.supplier_code ? [product.supplier_code] : [],
              add_categories: tabAdds,
              remove_categories: tabRemoves,
            }),
          });
          if (!res3.ok) throw new Error(`HTTP ${res3.status}`);
        } catch (err) {
          toast.error(`Shop tabs save failed: ${err.message}`);
        }
      }
      toast.success(
        extraCount > 0
          ? `Product updated (+ ${extraCount} extra spec${extraCount !== 1 ? 's' : ''})`
          : 'Product updated successfully'
      );
      onOpenChange(false);
      onSaved && onSaved();
    } catch (err) {
      toast.error(`Save failed: ${err.message}`);
    } finally {
      setLoading(false);
    }
  };

  const onImageUpload = async (e) => {
    const files = Array.from(e.target.files || []);
    if (files.length === 0) return;
    setImageUploading(true);
    const uploads = files.map(async (file) => {
      const fd = new FormData();
      fd.append('image', file);
      fd.append('product_id', product._id);
      fd.append('supplier', product.supplier || 'unknown');
      try {
        const res = await fetch(`${API_URL}/api/supplier-sync/upload-product-image`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${localStorage.getItem('token')}` },
          body: fd,
        });
        if (!res.ok) { toast.error(`Failed to upload ${file.name}`); return null; }
        const result = await res.json();
        const imageUrl = result.image_url || result.url;
        if (imageUrl) {
          setForm(prev => ({ ...prev, images: [...prev.images, imageUrl] }));
          toast.success('Image uploaded');
        }
        return imageUrl;
      } catch (err) {
        toast.error(`Error uploading ${file.name}`);
        return null;
      }
    });
    await Promise.all(uploads);
    setImageUploading(false);
  };

  const onDeleteImage = (imageUrl, index) => {
    setForm(prev => ({ ...prev, images: prev.images.filter((_, i) => i !== index) }));
    toast.success('Image removed');
  };

  const onSetPrimaryImage = (index) => {
    if (index === 0) return;
    setForm(prev => {
      const arr = [...prev.images];
      const [removed] = arr.splice(index, 1);
      arr.unshift(removed);
      return { ...prev, images: arr };
    });
    toast.success('Primary image updated');
  };

  const onImageDragStart = (e, index) => {
    setDraggedImageIndex(index);
    e.dataTransfer.effectAllowed = 'move';
    if (e.target && e.target.outerHTML) e.dataTransfer.setData('text/html', e.target.outerHTML);
    if (e.target && e.target.style) e.target.style.opacity = '0.5';
  };
  const onImageDragEnd = (e) => {
    if (e.target && e.target.style) e.target.style.opacity = '1';
    setDraggedImageIndex(null);
  };
  const onImageDragOver = (e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; };
  const onImageDrop = (e, dropIndex) => {
    e.preventDefault();
    if (draggedImageIndex === null || draggedImageIndex === dropIndex) return;
    setForm(prev => {
      const arr = [...prev.images];
      const [dragged] = arr.splice(draggedImageIndex, 1);
      arr.splice(dropIndex, 0, dragged);
      return { ...prev, images: arr };
    });
    setDraggedImageIndex(null);
    toast.success('Image order updated');
  };

  // Build the flat field list the More Specs collapsible will render. We
  // drop any field the main modal already covers (color/finish/price/stock…)
  // so admins don't see duplicate inputs.
  const RESERVED_KEYS = new Set([
    'color', 'finish', 'price', 'cost_price', 'stock_quantity', 'stock_m2',
    'display_name', 'display_code', 'supplier_product_name', 'supplier_product_code',
    'is_featured', 'always_in_stock', 'in_stock', 'category', 'images', 'image',
  ]);
  const moreSpecsFields = useMemo(() => {
    if (!moreSpecsConfig) return [];
    const specs = (moreSpecsConfig.spec_fields || []).map(f => ({ ...f, _kind: 'spec' }));
    const filters = (moreSpecsConfig.filter_facets || []).map(f => ({ ...f, _kind: 'filter' }));
    const seen = new Set();
    return [...specs, ...filters].filter(f => {
      if (!f.key || RESERVED_KEYS.has(f.key)) return false;
      if (seen.has(f.key)) return false;
      seen.add(f.key);
      return true;
    });
  }, [moreSpecsConfig]);

  const setMoreSpecVal = (key, v) => setMoreSpecsValues(prev => ({ ...prev, [key]: v }));

  const setFormField = (key, v) => setForm(prev => ({ ...prev, [key]: v }));

  // Sale panel — derive live "Save £X · N% OFF" from the two prices so admins
  // see the customer-facing chip preview as they type.
  const saleMath = useMemo(() => {
    const was = parseFloat(form.was_price);
    const now = parseFloat(form.price);
    if (!Number.isFinite(was) || !Number.isFinite(now) || was <= 0 || now <= 0 || now >= was) return null;
    const save = was - now;
    const pct = Math.round((save / was) * 100);
    return { save: save.toFixed(2), pct };
  }, [form.was_price, form.price]);

  // Sale + Description panel JSX — rendered in the QuickEditModal below the
  // Featured toggle, above the More Specs collapsible.
  const saleAndDescriptionPanel = (
    <div className="space-y-3">
      {/* Sale + Clearance — the two customer-facing badges */}
      <div className="border border-rose-100 rounded-lg overflow-hidden" data-testid="quick-edit-sale-panel">
        <div className="px-3 py-2 bg-rose-50 border-b border-rose-100 flex items-center gap-2 text-sm font-medium text-rose-800">
          <Tag className="w-4 h-4" />
          <span>Sale &amp; Clearance</span>
          <span className="ml-1 text-[10px] uppercase tracking-wider text-rose-500">
            WAS / NOW ribbon · flashing CLEARANCE badge
          </span>
          <div className="ml-auto flex items-center gap-1.5 text-[11px] font-semibold">
            {form.sale_active && saleMath && (
              <>
                <span className="px-1.5 py-0.5 rounded bg-white text-rose-700 border border-rose-200">SAVE £{saleMath.save}</span>
                <span className="px-1.5 py-0.5 rounded bg-rose-600 text-white">{saleMath.pct}% OFF</span>
              </>
            )}
            {form.clearance && <span className="px-1.5 py-0.5 rounded bg-[#e5d918] text-red-700 uppercase font-black" data-testid="quick-edit-tag-clearance">Clearance</span>}
          </div>
        </div>
        <div className="p-3 bg-white grid grid-cols-3 gap-3">
          <label className="col-span-3 flex items-center gap-2 text-sm cursor-pointer" data-testid="quick-edit-sale-active-toggle">
            <input
              type="checkbox"
              checked={!!form.sale_active}
              onChange={(e) => setFormField('sale_active', e.target.checked)}
              className="w-4 h-4 accent-rose-600"
              data-testid="quick-edit-sale-active"
            />
            <span className="font-medium">SALE</span>
            <span className="text-[11px] text-gray-500">— red SALE badge + crossed-out Was £; the List price above is the Now £ customers pay</span>
          </label>
          <div>
            <label className="block text-[11px] font-medium text-gray-600 mb-1">Was £ (crossed out)</label>
            <input
              type="number"
              step="0.01"
              min="0"
              value={form.was_price ?? ''}
              onChange={(e) => setFormField('was_price', e.target.value)}
              placeholder="58.99"
              className="w-full h-8 text-xs border border-rose-200 rounded px-2"
              data-testid="quick-edit-was-price"
              disabled={!form.sale_active}
            />
          </div>
          <div>
            <label className="block text-[11px] font-medium text-gray-600 mb-1">Now £ (= List price)</label>
            <div className="h-8 text-xs border border-gray-200 rounded px-2 bg-gray-50 flex items-center font-mono" data-testid="quick-edit-now-price">
              £{Number(form.price || 0).toFixed(2)}
            </div>
          </div>
          <div>
            <label className="block text-[11px] font-medium text-gray-600 mb-1">Customer saves</label>
            <div className="h-8 text-xs border border-gray-200 rounded px-2 bg-gray-50 flex items-center gap-1.5 text-gray-500">
              <Percent className="w-3 h-3" />
              {saleMath ? <span className="text-emerald-700 font-semibold">£{saleMath.save} · {saleMath.pct}%</span> : <span>{form.sale_active ? 'Was must be above Now' : 'not on sale'}</span>}
            </div>
          </div>
          <label className={`col-span-3 flex items-center gap-2 text-sm cursor-pointer rounded-md border p-2 ${form.clearance ? 'bg-amber-50 border-amber-300' : 'border-gray-200'}`} data-testid="quick-edit-clearance-toggle">
            <input
              type="checkbox"
              checked={!!form.clearance}
              onChange={(e) => setFormField('clearance', e.target.checked)}
              className="w-4 h-4 accent-amber-600"
              data-testid="quick-edit-clearance"
            />
            <Flame className="w-4 h-4 text-amber-600" />
            <span className="font-medium">CLEARANCE</span>
            <span className="text-[11px] text-gray-500">— flashing badge on the website, listed on the Clearance page &amp; leaflet. Combine with SALE for a Was / Now price.</span>
          </label>
        </div>
      </div>

      {/* About This Product — long description editor. */}
      <div className="border border-slate-200 rounded-lg overflow-hidden" data-testid="quick-edit-description-panel">
        <div className="px-3 py-2 bg-slate-50 border-b border-slate-200 flex items-center gap-2 text-sm font-medium text-slate-700">
          <FileText className="w-4 h-4" />
          <span>About This Product</span>
          <span className="ml-1 text-[10px] uppercase tracking-wider text-slate-400">
            Long description shown on the customer landing page
          </span>
          <span className="ml-auto text-[10px] text-gray-400">
            {String(form.description || '').length} chars
          </span>
        </div>
        <textarea
          value={form.description || ''}
          onChange={(e) => setFormField('description', e.target.value)}
          rows={5}
          placeholder={"Describe the product for shoppers — origin, aesthetic, key selling points. Line breaks become paragraphs on the landing page.\n\nExample:\nMoonstone is our finest porcelain range, hand-picked from Italian kilns. Its matte finish and gentle veining bring warmth to any space.\n\nSuits kitchens, bathrooms, and modern living areas. Slip-rated R10 — safe for shoe traffic even when wet."}
          className="w-full p-3 text-sm border-0 focus:outline-none focus:ring-0 resize-y"
          data-testid="quick-edit-description-textarea"
        />
      </div>
    </div>
  );

  // Pallets & Delivery card — this product only. Header shows the live status
  // pills; body is the shared SellingRulesCard (same controls as the bulk hub).
  const rulesDirty = !!(rules && rulesSeedRef.current && rulesChanged(rules, rulesSeedRef.current));
  const sellingRulesPanel = rules ? (
    <div className="border border-emerald-100 rounded-lg overflow-hidden" data-testid="quick-edit-selling-rules-panel">
      <div className="px-3 py-2 bg-emerald-50 border-b border-emerald-100 flex items-center gap-2 text-sm font-medium text-emerald-900">
        <Truck className="w-4 h-4" />
        <span>Pallets &amp; Delivery</span>
        <span className="ml-1 text-[10px] uppercase tracking-wider text-emerald-600">This product only</span>
        <div className="ml-auto flex items-center gap-1.5 text-[10px] font-bold">
          {rules.pallet_enabled && rules.pallet_only && <span className="px-1.5 py-0.5 rounded bg-amber-100 text-amber-800 border border-amber-300 uppercase" data-testid="quick-edit-tag-pallet-only">Pallet only</span>}
          {rules.pallet_enabled && !rules.pallet_only && <span className="px-1.5 py-0.5 rounded bg-green-100 text-green-800 border border-green-300" data-testid="quick-edit-tag-pallet">Pallets on</span>}
          {rules.delivery_charge_required && Number(rules.delivery_charge) > 0 && <span className="px-1.5 py-0.5 rounded bg-rose-50 text-rose-700 border border-rose-200" data-testid="quick-edit-tag-delivery">£{Number(rules.delivery_charge).toFixed(2)} delivery</span>}
          {rules.parcel_delivery && <span className="px-1.5 py-0.5 rounded bg-sky-50 text-sky-700 border border-sky-200" data-testid="quick-edit-tag-parcel">Parcel</span>}
          {rulesDirty && <span className="text-amber-700 font-semibold">· unsaved</span>}
        </div>
      </div>
      <div className="p-3 bg-white">
        <SellingRulesCard value={rules} onChange={setRules} testPrefix="quick-edit-rules" />
        <p className="text-[10px] text-gray-400 mt-2">Saved with the product when you hit Save Changes. Bulk-editing many items? Select them in the list and use Pricing → Pallets &amp; Delivery.</p>
      </div>
    </div>
  ) : null;

  // Landing-page preview button — opens the customer landing page in a new
  // tab on THIS environment's storefront (admin + shop share the same
  // origin). Products with a series get the collection page; series-less
  // live products get their own /tiles/{slug} page.
  const previewPanel = product ? (() => {
    const storefront = process.env.REACT_APP_STOREFRONT_URL || window.location.origin;
    // getSeriesName = the SAME helper the managers use for group headers, so
    // the preview lands on the collection the admin sees in the manager.
    const seriesName = (getSeriesName(product) || '').trim();
    // ?preview=1 lets the landing page include unpublished drafts.
    const href = seriesName
      ? `${storefront}/shop/collection/${encodeURIComponent(seriesName)}?preview=1`
      : product.live_slug
        ? `${storefront}/tiles/${product.live_slug}?preview=1`
        : `${storefront}/shop`;
    return (
      <div className="flex items-center justify-between text-xs">
        <div className="flex items-center gap-2 text-slate-500">
          <Eye className="w-3.5 h-3.5" />
          <span>Preview how customers will see this product</span>
        </div>
        <a
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md border border-blue-200 text-blue-700 bg-blue-50 hover:bg-blue-100 font-medium"
          data-testid="quick-edit-preview-on-site"
        >
          <ExternalLink className="w-3.5 h-3.5" />
          Preview on site — {seriesName || 'landing page'}
        </a>
      </div>
    );
  })() : null;

  // Extract only the moreSpecs fields the admin actually changed. Compared
  // against the seed values from the product so we don't send unchanged fields.
  // Also includes per-product label overrides + custom specs so both save in
  // the same bulk-update-unified call.
  const collectMoreSpecsUpdates = () => {
    const changes = {};
    if (!product) return changes;
    for (const f of moreSpecsFields) {
      const current = moreSpecsValues[f.key];
      const original = product[f.key] ?? '';
      if (current === undefined) continue;
      if (String(current) === String(original)) continue;
      if (current === '' && (original === '' || original === null || original === undefined)) continue;
      changes[f.key] = (f.type === 'number' && current !== '') ? Number(current) : current;
    }
    // Persist label overrides only if the admin actually changed something.
    const origOverrides = product.field_label_overrides || {};
    if (JSON.stringify(labelOverrides) !== JSON.stringify(origOverrides)) {
      changes.field_label_overrides = labelOverrides;
    }
    // Persist custom specs (drop rows with no label).
    const cleanedCustom = (customSpecs || [])
      .map(cs => ({
        key: (cs.key || cs.label || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, ''),
        label: (cs.label || '').trim(),
        value: cs.value ?? '',
      }))
      .filter(cs => cs.label);
    const origCustom = Array.isArray(product.custom_specs) ? product.custom_specs : [];
    if (JSON.stringify(cleanedCustom) !== JSON.stringify(origCustom)) {
      changes.custom_specs = cleanedCustom;
    }
    return changes;
  };

  // The collapsible JSX rendered inside the QuickEditModal via the
  // `moreSpecsSlot` render prop. Kept as a local variable so the parent
  // modal remains a pure presentational component.
  const moreSpecsPanel = moreSpecsFields.length > 0 ? (
    <div className="border border-slate-200 rounded-lg overflow-hidden" data-testid="quick-edit-more-specs">
      <button
        type="button"
        onClick={() => setMoreSpecsOpen(v => !v)}
        className="w-full flex items-center gap-2 px-3 py-2 bg-slate-50 hover:bg-slate-100 text-left text-sm font-medium text-slate-700"
        data-testid="more-specs-toggle"
      >
        {moreSpecsOpen ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
        <Sliders className="w-4 h-4 text-slate-500" />
        <span>More Specs</span>
        <span className="ml-1 text-[10px] uppercase tracking-wider text-slate-400">
          {moreSpecsFields.length} field{moreSpecsFields.length !== 1 ? 's' : ''} from this category
        </span>
      </button>
      {moreSpecsOpen && (
        <div className="p-3 bg-white space-y-3">
          <div className="grid grid-cols-2 gap-3">
          {moreSpecsFields.map(f => {
            const displayLabel = labelOverrides[f.key] ?? (f.label || f.key);
            const isEditingLabel = editingLabelKey === f.key;
            return (
            <div key={f.key} className={f.type === 'textarea' ? 'col-span-2' : ''}>
              <label className="flex items-center gap-1 text-[11px] font-medium text-gray-600 mb-1">
                {isEditingLabel ? (
                  <input
                    autoFocus
                    type="text"
                    value={labelOverrides[f.key] ?? (f.label || f.key)}
                    onChange={(e) => setLabelOverrides(prev => ({ ...prev, [f.key]: e.target.value }))}
                    onBlur={() => setEditingLabelKey(null)}
                    onKeyDown={(e) => { if (e.key === 'Enter' || e.key === 'Escape') setEditingLabelKey(null); }}
                    className="text-[11px] font-medium border border-blue-300 rounded px-1 py-0.5 flex-1"
                    data-testid={`more-specs-label-input-${f.key}`}
                  />
                ) : (
                  <button
                    type="button"
                    onClick={() => setEditingLabelKey(f.key)}
                    className="text-left hover:text-blue-700 hover:underline flex items-center gap-1"
                    title="Click to rename this field for this product"
                    data-testid={`more-specs-label-${f.key}`}
                  >
                    <span>{displayLabel}</span>
                    <PenLine className="w-2.5 h-2.5 text-gray-400" />
                  </button>
                )}
                <span className="ml-auto text-[9px] uppercase tracking-wider text-gray-400">{f.key}</span>
                {labelOverrides[f.key] && labelOverrides[f.key] !== (f.label || f.key) && (
                  <button
                    type="button"
                    onClick={() => setLabelOverrides(prev => { const n = { ...prev }; delete n[f.key]; return n; })}
                    className="text-[9px] text-blue-500 hover:text-blue-700 hover:underline"
                    title="Reset to default label"
                    data-testid={`more-specs-label-reset-${f.key}`}
                  >
                    reset
                  </button>
                )}
              </label>
              {f.type === 'select' && Array.isArray(f.options) ? (
                <select
                  value={moreSpecsValues[f.key] ?? ''}
                  onChange={(e) => setMoreSpecVal(f.key, e.target.value)}
                  className="w-full h-8 text-xs border border-gray-300 rounded px-2 bg-white"
                  data-testid={`more-specs-input-${f.key}`}
                >
                  <option value="">— select —</option>
                  {f.options.map(o => <option key={o} value={o}>{o}</option>)}
                </select>
              ) : f.type === 'textarea' ? (
                <textarea
                  value={moreSpecsValues[f.key] ?? ''}
                  onChange={(e) => setMoreSpecVal(f.key, e.target.value)}
                  rows={2}
                  className="w-full px-2 py-1.5 border border-gray-300 rounded text-xs"
                  data-testid={`more-specs-input-${f.key}`}
                />
              ) : (
                <input
                  type={f.type === 'number' ? 'number' : 'text'}
                  value={moreSpecsValues[f.key] ?? ''}
                  onChange={(e) => setMoreSpecVal(f.key, e.target.value)}
                  placeholder={f.hint || (f.type === 'number' ? '0' : '')}
                  className="w-full h-8 text-xs border border-gray-300 rounded px-2"
                  data-testid={`more-specs-input-${f.key}`}
                />
              )}
              {f.hint && <p className="text-[10px] text-gray-400 mt-0.5">{f.hint}</p>}
            </div>
            );
          })}
          </div>

          {/* Ad-hoc custom fields — per-product only. */}
          {customSpecs.length > 0 && (
            <div className="border-t border-dashed border-slate-200 pt-3">
              <div className="text-[10px] uppercase tracking-wider text-slate-500 mb-2 font-semibold">
                Custom Fields (this product only)
              </div>
              <div className="grid grid-cols-2 gap-3">
                {customSpecs.map((cs, idx) => (
                  <div key={idx} className="flex flex-col" data-testid={`custom-spec-row-${idx}`}>
                    <div className="flex items-center gap-1 mb-1">
                      <input
                        type="text"
                        value={cs.label || ''}
                        onChange={(e) => setCustomSpecs(prev => prev.map((r, i) => i === idx ? { ...r, label: e.target.value } : r))}
                        placeholder="Field name (e.g. Bottle Volume)"
                        className="flex-1 h-6 text-[11px] font-medium border border-blue-200 rounded px-1.5"
                        data-testid={`custom-spec-label-${idx}`}
                      />
                      <button
                        type="button"
                        onClick={() => setCustomSpecs(prev => prev.filter((_, i) => i !== idx))}
                        className="p-0.5 text-rose-500 hover:bg-rose-50 rounded"
                        title="Remove this field"
                        data-testid={`custom-spec-remove-${idx}`}
                      >
                        <XIcon className="w-3 h-3" />
                      </button>
                    </div>
                    <input
                      type="text"
                      value={cs.value ?? ''}
                      onChange={(e) => setCustomSpecs(prev => prev.map((r, i) => i === idx ? { ...r, value: e.target.value } : r))}
                      placeholder="Value (e.g. 1L)"
                      className="w-full h-8 text-xs border border-gray-300 rounded px-2"
                      data-testid={`custom-spec-value-${idx}`}
                    />
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="flex items-center gap-2 pt-1">
            <button
              type="button"
              onClick={() => setCustomSpecs(prev => [...prev, { label: '', value: '', key: '' }])}
              className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded border border-blue-200 bg-blue-50 hover:bg-blue-100 text-blue-700 text-[11px] font-semibold"
              data-testid="add-custom-spec-btn"
            >
              + Add custom field
            </button>
            <span className="text-[10px] text-slate-400">
              Rename any label above by clicking it, or add ad-hoc fields for this product (e.g. Bottle Volume, Dilution Ratio).
            </span>
          </div>
        </div>
      )}
    </div>
  ) : null;

  // === Variants panel ===================================================
  // Load current group members + sibling candidates whenever the panel is
  // opened (or a different product is loaded).
  const fetchVariantData = useCallback(async () => {
    if (!product) return;
    const sku = product.sku || product.supplier_code;
    if (!sku) return;
    setVariantsLoading(true);
    try {
      // Existing group members (if this product is part of one).
      const groupId = product.variant_group_id;
      if (groupId) {
        const gRes = await fetch(`${API_URL}/api/supplier-sync/variants/group/${encodeURIComponent(groupId)}`);
        if (gRes.ok) {
          const gData = await gRes.json();
          setVariantMembers(gData.members || []);
        } else {
          setVariantMembers([]);
        }
      } else {
        setVariantMembers([]);
      }
      // Sibling candidates in the same series that share the same base name.
      const cRes = await fetch(`${API_URL}/api/supplier-sync/variants/candidates?sku=${encodeURIComponent(sku)}`);
      if (cRes.ok) {
        const cData = await cRes.json();
        // Filter out any candidate already in the current group.
        const groupSkus = new Set((variantMembers || []).map(m => m.sku));
        setVariantCandidates((cData.candidates || []).filter(c => !groupSkus.has(c.sku)));
      } else {
        setVariantCandidates([]);
      }
    } catch (err) {
      // Silent — panel just shows empty state on failure.
      setVariantMembers([]);
      setVariantCandidates([]);
    } finally {
      setVariantsLoading(false);
    }
  }, [product]);

  useEffect(() => {
    if (variantsOpen) fetchVariantData();
  }, [variantsOpen, product, fetchVariantData]);

  const toggleCandidate = (sku) => {
    setVariantSelected(prev => ({ ...prev, [sku]: !prev[sku] }));
  };

  const buildItemFromProduct = (p) => ({
    sku: p.sku,
    color: (p.variant_axes && p.variant_axes.color) || p.color || null,
    finish: (p.variant_axes && p.variant_axes.finish) || p.finish || null,
    size: (p.variant_axes && p.variant_axes.size) || p.size || null,
  });

  const onCreateOrExtendGroup = async () => {
    const selected = Object.entries(variantSelected).filter(([, v]) => v).map(([k]) => k);
    if (selected.length === 0) {
      toast.error('Select at least one candidate first');
      return;
    }
    setVariantsBusy(true);
    try {
      // Include the current product plus any existing group members so we
      // (re)create a single group with everyone in it. Backend generates a
      // fresh group_id when none is supplied.
      const currentSku = product.sku || product.supplier_code;
      const items = [];
      items.push({ sku: currentSku, color: product.color || null, finish: product.finish || null, size: product.size || null });
      variantMembers.forEach(m => {
        if (m.sku && m.sku !== currentSku) items.push(buildItemFromProduct(m));
      });
      variantCandidates.forEach(c => {
        if (selected.includes(c.sku)) items.push({ sku: c.sku, color: c.color || null, finish: c.finish || null, size: c.size || null });
      });
      const res = await fetch(`${API_URL}/api/supplier-sync/variants/create-group`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items, group_id: product.variant_group_id || null }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        toast.error(err.detail || 'Failed to create variant group');
        return;
      }
      const data = await res.json();
      toast.success(`Grouped ${data.updated} product${data.updated !== 1 ? 's' : ''} as variants`);
      setVariantSelected({});
      // Reload group + candidates so the UI reflects the new state.
      // Also patch product.variant_group_id so the panel treats subsequent
      // adds as an "extend" rather than a "create".
      if (product && data.group_id) product.variant_group_id = data.group_id;
      await fetchVariantData();
      onSaved && onSaved();
    } catch (err) {
      toast.error(`Group failed: ${err.message}`);
    } finally {
      setVariantsBusy(false);
    }
  };

  const onAutoGroupFromSeries = async () => {
    if (!product) return;
    const seriesName = getSeriesName(product);
    if (!seriesName) {
      toast.error('This product has no detectable series — set the series first');
      return;
    }
    setVariantsBusy(true);
    try {
      const res = await fetch(`${API_URL}/api/supplier-sync/variants/auto-group-from-series`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ series: seriesName, supplier: product.supplier || null, dry_run: false }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        toast.error(err.detail || 'Auto-group failed');
        return;
      }
      const data = await res.json();
      toast.success(`Auto-grouped ${data.products_grouped} product${data.products_grouped !== 1 ? 's' : ''} into ${data.clusters_found} variant group${data.clusters_found !== 1 ? 's' : ''}`);
      // Refresh; the current product may now have a variant_group_id.
      // We can't easily update the parent product record from here, so
      // trigger onSaved so the parent list can reload.
      await fetchVariantData();
      onSaved && onSaved();
    } catch (err) {
      toast.error(`Auto-group failed: ${err.message}`);
    } finally {
      setVariantsBusy(false);
    }
  };

  const onRemoveMember = async (sku) => {
    if (!sku) return;
    setVariantsBusy(true);
    try {
      const res = await fetch(`${API_URL}/api/supplier-sync/variants/ungroup`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ skus: [sku], clear_axes: false }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        toast.error(err.detail || 'Failed to remove variant');
        return;
      }
      toast.success('Variant removed from group');
      await fetchVariantData();
      onSaved && onSaved();
    } catch (err) {
      toast.error(`Remove failed: ${err.message}`);
    } finally {
      setVariantsBusy(false);
    }
  };

  const onUngroupAll = async () => {
    if (!variantMembers.length) return;
    setVariantsBusy(true);
    try {
      const res = await fetch(`${API_URL}/api/supplier-sync/variants/ungroup`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ skus: variantMembers.map(m => m.sku).filter(Boolean), clear_axes: false }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        toast.error(err.detail || 'Failed to ungroup');
        return;
      }
      toast.success('Variant group dissolved');
      if (product) product.variant_group_id = null;
      await fetchVariantData();
      onSaved && onSaved();
    } catch (err) {
      toast.error(`Ungroup failed: ${err.message}`);
    } finally {
      setVariantsBusy(false);
    }
  };

  const onEditMemberAxis = async (sku, axis, value) => {
    // Optimistic update so the input feels responsive.
    setVariantMembers(prev => prev.map(m => m.sku === sku ? {
      ...m,
      variant_axes: { ...(m.variant_axes || {}), [axis]: value || null },
    } : m));
    try {
      await fetch(`${API_URL}/api/supplier-sync/variants/set-axes`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sku, [axis]: value }),
      });
    } catch {
      // silent — optimistic update stays; a full reload will correct any drift
    }
  };

  const currentSku = product ? (product.sku || product.supplier_code) : null;
  const seriesForVariants = product ? getSeriesName(product) : '';

  const variantsPanel = (
    <div className="border border-purple-100 rounded-lg overflow-hidden" data-testid="quick-edit-variants-panel">
      <button
        type="button"
        onClick={() => setVariantsOpen(v => !v)}
        className="w-full flex items-center gap-2 px-3 py-2 bg-purple-50 hover:bg-purple-100 text-left text-sm font-medium text-purple-800"
        data-testid="variants-toggle"
      >
        {variantsOpen ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
        <Layers className="w-4 h-4 text-purple-600" />
        <span>Variants (Colour / Finish / Size)</span>
        <span className="ml-1 text-[10px] uppercase tracking-wider text-purple-500">
          {variantMembers.length > 0
            ? `${variantMembers.length} sibling${variantMembers.length !== 1 ? 's' : ''} grouped`
            : product && product.variant_group_id
              ? 'group loaded'
              : 'not grouped'}
        </span>
        {product && product.variant_group_id && (
          <span className="ml-auto text-[10px] font-mono text-purple-500 truncate max-w-[140px]">
            {product.variant_group_id}
          </span>
        )}
      </button>
      {variantsOpen && (
        <div className="p-3 bg-white space-y-3 text-xs">
          <div className="text-[11px] text-purple-700 bg-purple-50 border border-purple-100 rounded px-2 py-1.5 flex items-start gap-2">
            <Sparkles className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
            <span>
              Sibling SKUs grouped here become swatches on the customer landing page for series
              <b className="mx-1">{seriesForVariants || '(no series)'}</b>.
              Use <b>Auto-Group from Series</b> to bootstrap the whole series in one click.
            </span>
          </div>

          {/* Toolbar */}
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={onAutoGroupFromSeries}
              disabled={variantsBusy || !seriesForVariants}
              className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded border border-purple-300 bg-purple-600 text-white text-[11px] font-semibold hover:bg-purple-700 disabled:opacity-40"
              data-testid="variants-auto-group-btn"
            >
              <Sparkles className="w-3.5 h-3.5" />
              Auto-Group from Series
            </button>
            <button
              type="button"
              onClick={fetchVariantData}
              disabled={variantsLoading}
              className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded border border-gray-300 text-gray-700 text-[11px] font-medium hover:bg-gray-50 disabled:opacity-40"
              data-testid="variants-refresh-btn"
            >
              {variantsLoading ? 'Loading…' : 'Refresh'}
            </button>
            {variantMembers.length > 0 && (
              <button
                type="button"
                onClick={onUngroupAll}
                disabled={variantsBusy}
                className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded border border-rose-200 text-rose-700 text-[11px] font-medium hover:bg-rose-50 disabled:opacity-40 ml-auto"
                data-testid="variants-ungroup-all-btn"
              >
                <XIcon className="w-3.5 h-3.5" />
                Dissolve Group
              </button>
            )}
          </div>

          {/* Existing group members */}
          {variantMembers.length > 0 && (
            <div className="border border-purple-100 rounded overflow-hidden" data-testid="variants-members-list">
              <div className="px-2 py-1 bg-purple-50 border-b border-purple-100 text-[10px] uppercase tracking-wider font-semibold text-purple-700 flex items-center gap-1">
                <Link2 className="w-3 h-3" />
                Current Variant Group ({variantMembers.length})
              </div>
              <div className="divide-y">
                {variantMembers.map(m => (
                  <div key={m.sku} className="px-2 py-1.5 grid grid-cols-12 gap-1 items-center" data-testid={`variant-member-${m.sku}`}>
                    <div className="col-span-4 min-w-0">
                      <div className="text-[11px] font-medium text-gray-800 truncate" title={m.name}>{m.name || m.sku}</div>
                      <div className="text-[9px] text-gray-400 font-mono">{m.sku}</div>
                    </div>
                    <input
                      type="text"
                      value={(m.variant_axes && m.variant_axes.color) || ''}
                      onChange={(e) => onEditMemberAxis(m.sku, 'color', e.target.value)}
                      placeholder="colour"
                      className="col-span-2 h-6 text-[10px] border border-gray-200 rounded px-1"
                      data-testid={`variant-member-color-${m.sku}`}
                    />
                    <input
                      type="text"
                      value={(m.variant_axes && m.variant_axes.finish) || ''}
                      onChange={(e) => onEditMemberAxis(m.sku, 'finish', e.target.value)}
                      placeholder="finish"
                      className="col-span-2 h-6 text-[10px] border border-gray-200 rounded px-1"
                      data-testid={`variant-member-finish-${m.sku}`}
                    />
                    <input
                      type="text"
                      value={(m.variant_axes && m.variant_axes.size) || ''}
                      onChange={(e) => onEditMemberAxis(m.sku, 'size', e.target.value)}
                      placeholder="size"
                      className="col-span-2 h-6 text-[10px] border border-gray-200 rounded px-1"
                      data-testid={`variant-member-size-${m.sku}`}
                    />
                    <div className="col-span-2 flex justify-end">
                      {m.sku !== currentSku && (
                        <button
                          type="button"
                          onClick={() => onRemoveMember(m.sku)}
                          disabled={variantsBusy}
                          className="p-1 text-rose-600 hover:bg-rose-50 rounded disabled:opacity-40"
                          title="Remove from group"
                          data-testid={`variant-member-remove-${m.sku}`}
                        >
                          <XIcon className="w-3 h-3" />
                        </button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Candidate siblings not yet grouped */}
          <div className="border border-gray-200 rounded overflow-hidden" data-testid="variants-candidates-list">
            <div className="px-2 py-1 bg-gray-50 border-b border-gray-200 text-[10px] uppercase tracking-wider font-semibold text-gray-600 flex items-center gap-1">
              <Palette className="w-3 h-3" />
              Sibling Candidates
              <span className="ml-1 normal-case tracking-normal font-normal text-gray-400">— same series, not yet grouped</span>
              {variantCandidates.length > 0 && (
                <button
                  type="button"
                  onClick={onCreateOrExtendGroup}
                  disabled={variantsBusy || Object.values(variantSelected).filter(Boolean).length === 0}
                  className="ml-auto inline-flex items-center gap-1 px-2 py-0.5 rounded border border-purple-300 bg-purple-600 text-white text-[10px] font-semibold hover:bg-purple-700 disabled:opacity-40"
                  data-testid="variants-add-selected-btn"
                >
                  <Link2 className="w-3 h-3" />
                  {product && product.variant_group_id ? 'Add to Group' : 'Create Group with Selected'}
                </button>
              )}
            </div>
            {variantsLoading ? (
              <div className="px-2 py-3 text-[11px] text-gray-400">Loading candidates…</div>
            ) : variantCandidates.length === 0 ? (
              <div className="px-2 py-3 text-[11px] text-gray-400">
                No sibling candidates found — try &quot;Auto-Group from Series&quot; or check the series is set correctly.
              </div>
            ) : (
              <div className="divide-y max-h-52 overflow-y-auto">
                {variantCandidates.map(c => (
                  <label
                    key={c.sku}
                    className="px-2 py-1.5 flex items-center gap-2 hover:bg-purple-50 cursor-pointer text-[11px]"
                    data-testid={`variant-candidate-${c.sku}`}
                  >
                    <input
                      type="checkbox"
                      checked={!!variantSelected[c.sku]}
                      onChange={() => toggleCandidate(c.sku)}
                      className="w-3 h-3"
                      data-testid={`variant-candidate-checkbox-${c.sku}`}
                    />
                    <div className="min-w-0 flex-1">
                      <div className="font-medium text-gray-800 truncate" title={c.name}>{c.name || c.sku}</div>
                      <div className="text-[9px] text-gray-400 font-mono flex items-center gap-2">
                        <span>{c.sku}</span>
                        {c.color && <span className="inline-flex items-center gap-1"><Palette className="w-2.5 h-2.5" />{c.color}</span>}
                        {c.finish && <span className="inline-flex items-center gap-1"><Sparkles className="w-2.5 h-2.5" />{c.finish}</span>}
                        {c.size && <span className="inline-flex items-center gap-1"><Ruler className="w-2.5 h-2.5" />{c.size}</span>}
                        {c.variant_group_id && (
                          <span className="text-amber-600" title="Already in another group">
                            (in another group)
                          </span>
                        )}
                      </div>
                    </div>
                  </label>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );

  // === Related Products panel ===========================================
  const onRelatedQueryChange = (q) => {
    setRelatedQuery(q);
    if (relatedDebounceRef.current) clearTimeout(relatedDebounceRef.current);
    if (!q || q.trim().length < 2) { setRelatedResults([]); return; }
    relatedDebounceRef.current = setTimeout(async () => {
      setRelatedSearching(true);
      try {
        const sku = product ? (product.sku || product.supplier_code || '') : '';
        const res = await fetch(`${API_URL}/api/supplier-sync/products/related-picker-search?q=${encodeURIComponent(q.trim())}&limit=12&exclude_sku=${encodeURIComponent(sku)}`);
        if (res.ok) {
          const data = await res.json();
          setRelatedResults(data.results || []);
        } else {
          setRelatedResults([]);
        }
      } catch {
        setRelatedResults([]);
      } finally {
        setRelatedSearching(false);
      }
    }, 300);
  };

  const addRelatedPin = (r, kind) => {
    const series = getSeriesName(r) || r.series_name || '';
    if (!series) { toast.error('Could not detect a series for this product'); return; }
    const currentSeries = product ? getSeriesName(product) : '';
    if (currentSeries && series.toLowerCase() === currentSeries.toLowerCase()) {
      toast.error("That's this product's own series — pick a different one");
      return;
    }
    const exists = relatedPins.some(p => p.kind === kind && (p.sku === r.sku || (p.series_name || '').toLowerCase() === series.toLowerCase()));
    if (exists) { toast.info('Already pinned in that section'); return; }
    setRelatedPins(prev => [...prev, {
      sku: r.sku,
      kind,
      series_name: series,
      display_name: r.display_name || r.name || '',
      image: r.image || null,
    }]);
    toast.success(`Pinned to ${kind === 'also_liked' ? 'Customers Also Liked' : 'You May Also Need'}`);
  };

  const removeRelatedPin = (sku, kind) => {
    setRelatedPins(prev => prev.filter(p => !(p.sku === sku && p.kind === kind)));
  };

  const PIN_KINDS = [
    { kind: 'also_liked', label: 'Customers Also Liked', Icon: Heart, hint: 'similar-products carousel' },
    { kind: 'you_may_need', label: 'You May Also Need', Icon: PackagePlus, hint: 'adhesives / tools cross-sells' },
  ];

  const relatedPanel = (
    <div className="border border-amber-100 rounded-lg overflow-hidden" data-testid="quick-edit-related-panel">
      <button
        type="button"
        onClick={() => setRelatedOpen(v => !v)}
        className="w-full flex items-center gap-2 px-3 py-2 bg-amber-50 hover:bg-amber-100 text-left text-sm font-medium text-amber-800"
        data-testid="related-toggle"
      >
        {relatedOpen ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
        <Pin className="w-4 h-4 text-amber-600" />
        <span>Related Products</span>
        <span className="ml-1 text-[10px] uppercase tracking-wider text-amber-500">
          {relatedPins.filter(p => p.kind === 'also_liked').length} liked · {relatedPins.filter(p => p.kind === 'you_may_need').length} need
        </span>
      </button>
      {relatedOpen && (
        <div className="p-3 bg-white space-y-3 text-xs">
          <div className="text-[11px] text-amber-700 bg-amber-50 border border-amber-100 rounded px-2 py-1.5">
            Hand-pick what appears in <b>Customers Also Liked</b> and <b>You May Also Need</b> on the landing page.
            Pins always show first; auto-suggestions fill the remaining slots.
          </div>

          {/* Search picker */}
          <div className="relative">
            <Search className="w-3.5 h-3.5 absolute left-2 top-1/2 -translate-y-1/2 text-gray-400" />
            <input
              type="text"
              value={relatedQuery}
              onChange={(e) => onRelatedQueryChange(e.target.value)}
              placeholder="Search products to pin (name, series or SKU)…"
              className="w-full h-8 text-xs border border-gray-300 rounded pl-7 pr-2"
              data-testid="related-search-input"
            />
          </div>
          {relatedSearching && <div className="text-[11px] text-gray-400">Searching…</div>}
          {!relatedSearching && relatedQuery.trim().length >= 2 && relatedResults.length === 0 && (
            <div className="text-[11px] text-gray-400" data-testid="related-search-empty">No products found for &quot;{relatedQuery}&quot;.</div>
          )}
          {relatedResults.length > 0 && (
            <div className="border border-gray-200 rounded divide-y max-h-52 overflow-y-auto" data-testid="related-search-results">
              {relatedResults.map(r => {
                const rSeries = getSeriesName(r) || r.series_name || '';
                return (
                  <div key={r.sku} className="px-2 py-1.5 flex items-center gap-2" data-testid={`related-result-${r.sku}`}>
                    {r.image ? (
                      <img src={r.image} alt="" className="w-8 h-8 rounded object-cover border flex-shrink-0" />
                    ) : (
                      <div className="w-8 h-8 rounded bg-gray-100 border flex-shrink-0" />
                    )}
                    <div className="min-w-0 flex-1">
                      <div className="text-[11px] font-medium text-gray-800 truncate" title={r.display_name}>{r.display_name || r.sku}</div>
                      <div className="text-[9px] text-gray-400 font-mono flex items-center gap-2">
                        <span>{r.sku}</span>
                        {rSeries && <span className="text-amber-600">→ {rSeries}</span>}
                        {r.price > 0 && <span>£{Number(r.price).toFixed(2)}</span>}
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => addRelatedPin(r, 'also_liked')}
                      className="px-1.5 py-1 rounded border border-rose-200 text-rose-600 hover:bg-rose-50 text-[10px] font-semibold flex items-center gap-1 flex-shrink-0"
                      title="Pin to Customers Also Liked"
                      data-testid={`related-add-liked-${r.sku}`}
                    >
                      <Heart className="w-3 h-3" /> Liked
                    </button>
                    <button
                      type="button"
                      onClick={() => addRelatedPin(r, 'you_may_need')}
                      className="px-1.5 py-1 rounded border border-amber-300 text-amber-700 hover:bg-amber-50 text-[10px] font-semibold flex items-center gap-1 flex-shrink-0"
                      title="Pin to You May Also Need"
                      data-testid={`related-add-need-${r.sku}`}
                    >
                      <PackagePlus className="w-3 h-3" /> Need
                    </button>
                  </div>
                );
              })}
            </div>
          )}

          {/* Pinned lists */}
          {PIN_KINDS.map(({ kind, label, Icon, hint }) => {
            const pins = relatedPins.filter(p => p.kind === kind);
            return (
              <div key={kind} className="border border-gray-200 rounded overflow-hidden" data-testid={`related-pins-${kind}`}>
                <div className="px-2 py-1 bg-gray-50 border-b border-gray-200 text-[10px] uppercase tracking-wider font-semibold text-gray-600 flex items-center gap-1">
                  <Icon className="w-3 h-3" />
                  {label} ({pins.length})
                  <span className="ml-1 normal-case tracking-normal font-normal text-gray-400">— {hint}</span>
                </div>
                {pins.length === 0 ? (
                  <div className="px-2 py-2 text-[11px] text-gray-400">Nothing pinned — customers see auto-suggestions.</div>
                ) : (
                  <div className="divide-y">
                    {pins.map(p => (
                      <div key={`${p.kind}-${p.sku}`} className="px-2 py-1.5 flex items-center gap-2" data-testid={`related-pin-${p.kind}-${p.sku}`}>
                        {p.image ? (
                          <img src={p.image} alt="" className="w-7 h-7 rounded object-cover border flex-shrink-0" />
                        ) : (
                          <div className="w-7 h-7 rounded bg-gray-100 border flex-shrink-0" />
                        )}
                        <div className="min-w-0 flex-1">
                          <div className="text-[11px] font-medium text-gray-800 truncate">{p.series_name || p.display_name}</div>
                          <div className="text-[9px] text-gray-400 font-mono truncate">{p.display_name} · {p.sku}</div>
                        </div>
                        <button
                          type="button"
                          onClick={() => removeRelatedPin(p.sku, p.kind)}
                          className="p-1 text-rose-600 hover:bg-rose-50 rounded flex-shrink-0"
                          title="Unpin"
                          data-testid={`related-pin-remove-${p.kind}-${p.sku}`}
                        >
                          <XIcon className="w-3 h-3" />
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
          <div className="text-[10px] text-gray-400">Pins save with the product when you hit Save Changes below.</div>
        </div>
      )}
    </div>
  );

  // === Shop Tabs panel (single-product destinations) =====================
  const toggleShopTabsPanel = () => {
    setShopTabsOpen(v => !v);
    if (!shopTabPages) {
      fetchShopTabDestinations().then(pages => setShopTabPages(filterShopTabPagesForManager(pages, managerSlug)));
    }
  };

  const tabIsChecked = (catName) => {
    if (catName in tabsChecked) return tabsChecked[catName];
    return tabsBaseline.has(catName.toLowerCase());
  };

  const toggleShopTab = (catName) => {
    setTabsChecked(prev => ({ ...prev, [catName]: !tabIsChecked(catName) }));
  };

  const shopTabsOnCount = (shopTabPages || []).reduce((sum, page) =>
    sum + page.tabs.filter(t => t.assignable && t.category_name && tabIsChecked(t.category_name)).length, 0);
  const shopTabsStagedCount = Object.keys(tabsChecked).length;

  const shopTabsPanel = (
    <div className="border border-sky-100 rounded-lg overflow-hidden" data-testid="quick-edit-shop-tabs-panel">
      <button
        type="button"
        onClick={toggleShopTabsPanel}
        className="w-full flex items-center gap-2 px-3 py-2 bg-sky-50 hover:bg-sky-100 text-left text-sm font-medium text-sky-800"
        data-testid="shop-tabs-panel-toggle"
      >
        {shopTabsOpen ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
        <LayoutGrid className="w-4 h-4 text-sky-600" />
        <span>Shop Tabs</span>
        <span className="ml-1 text-[10px] uppercase tracking-wider text-sky-500">
          {shopTabPages ? `${shopTabsOnCount} destination${shopTabsOnCount !== 1 ? 's' : ''}` : 'where it appears'}
          {shopTabsStagedCount > 0 && <span className="text-amber-500"> · unsaved changes</span>}
        </span>
      </button>
      {shopTabsOpen && (
        <div className="p-3 bg-white space-y-3 text-xs">
          <div className="text-[11px] text-sky-700 bg-sky-50 border border-sky-100 rounded px-2 py-1.5">
            Tick every shop tab this product should appear under — multiple tabs are fine.
            Changes apply when you hit <b>Save Changes</b> below.
          </div>
          {shopTabPages && shopTabPages.length > 0 && (
            <div className="text-[10px] text-sky-700 bg-white border border-sky-100 rounded px-2 py-1.5" data-testid="qe-shop-tabs-scope-note">
              Showing storefront destinations for the <b>{shopTabPages[0]?.group_name}</b> page only, so this stays focused on where the product appears on the website.
            </div>
          )}
          {!shopTabPages ? (
            <div className="text-[11px] text-gray-400 py-2 text-center">Loading shop pages…</div>
          ) : shopTabPages.length === 0 ? (
            <div className="text-[11px] text-gray-400 py-2 text-center">No storefront tabs are configured for this manager yet — add them via the Storefront button.</div>
          ) : (
            shopTabPages.map(page => {
              const assignable = page.tabs.filter(t => t.assignable && t.category_name);
              if (assignable.length === 0) return null;
              return (
                <div key={page.group_slug} className="border border-gray-200 rounded overflow-hidden" data-testid={`qe-shop-tabs-page-${page.group_slug}`}>
                  <div className="px-2 py-1 bg-gray-50 border-b border-gray-200 text-[10px] uppercase tracking-wider font-semibold text-gray-600">
                    {page.group_name} page
                  </div>
                  <div className="divide-y">
                    {assignable.map(tab => {
                      const checked = tabIsChecked(tab.category_name);
                      return (
                        <button
                          key={tab.category_slug}
                          type="button"
                          onClick={() => toggleShopTab(tab.category_name)}
                          className="w-full flex items-center gap-2 px-2 py-1.5 text-left hover:bg-sky-50/60 transition-colors"
                          data-testid={`qe-shop-tab-option-${page.group_slug}-${tab.category_slug}`}
                        >
                          <span className={`w-4 h-4 rounded border flex items-center justify-center flex-shrink-0 transition-colors ${checked ? 'bg-sky-600 border-sky-600 text-white' : 'bg-white border-gray-300'}`}>
                            {checked && <Check className="w-2.5 h-2.5" />}
                          </span>
                          <span className="text-[11px] font-medium text-gray-800">{tab.label}</span>
                          <span className="text-[9px] text-gray-400 ml-auto font-mono">{tab.url}</span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              );
            })
          )}
          <div className="text-[10px] text-gray-400">Need a brand-new tab? Use the bulk bar's Shop Tabs button — it has a "+ New tab" shortcut.</div>
        </div>
      )}
    </div>
  );

  return (
    <QuickEditModal
      open={open}
      onOpenChange={onOpenChange}
      product={product}
      form={form}
      setForm={setForm}
      loading={loading}
      imageUploading={imageUploading}
      draggedImageIndex={draggedImageIndex}
      displayCodePreview={displayCodePreview}
      showCategorySuggestions={showCategorySuggestions}
      setShowCategorySuggestions={setShowCategorySuggestions}
      categorySuggestions={categorySuggestions}
      onSave={onSave}
      onImageUpload={onImageUpload}
      onDeleteImage={onDeleteImage}
      onSetPrimaryImage={onSetPrimaryImage}
      onImageDragStart={onImageDragStart}
      onImageDragEnd={onImageDragEnd}
      onImageDragOver={onImageDragOver}
      onImageDrop={onImageDrop}
      onDisplayNameChange={onDisplayNameChange}
      setPreviewImages={effectiveSetPreviewImages}
      moreSpecsSlot={moreSpecsPanel}
      saleAndDescriptionSlot={saleAndDescriptionPanel}
      sellingRulesSlot={sellingRulesPanel}
      previewSlot={previewPanel}
      variantsSlot={variantsPanel}
      relatedSlot={relatedPanel}
      shopTabsSlot={shopTabsPanel}
    />
  );
};

export default QuickEditProductDrawer;
