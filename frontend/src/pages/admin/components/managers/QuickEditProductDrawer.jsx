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
import { ChevronDown, ChevronRight, Sliders, Tag, ExternalLink, Percent, FileText, Eye, Layers, Palette, Ruler, Sparkles, Link2, PenLine, X as XIcon } from 'lucide-react';
import QuickEditModal from '../supplier-products/QuickEditModal';
import { getSeriesName } from '../../lib/series';

const API_URL = process.env.REACT_APP_BACKEND_URL;

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
  sale_price: '',
  // Rich long description that renders on the customer /shop/collection page
  // under "About This Product". Stored as a plain string (markdown-lite).
  description: '',
});

const QuickEditProductDrawer = ({ open, onOpenChange, product, onSaved, previewImages, setPreviewImages, moreSpecsConfig }) => {
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
    const displayName = product.display_name || product.our_product_name || product.product_name || product.name || '';
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
      sale_price: product.sale_price ?? '',
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
        sale_active: form.sale_active,
        was_price: form.was_price === '' ? null : parseFloat(form.was_price),
        sale_price: form.sale_price === '' ? null : parseFloat(form.sale_price),
        description: form.description,
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
    const now = parseFloat(form.sale_price);
    if (!Number.isFinite(was) || !Number.isFinite(now) || was <= 0 || now <= 0 || now >= was) return null;
    const save = was - now;
    const pct = Math.round((save / was) * 100);
    return { save: save.toFixed(2), pct };
  }, [form.was_price, form.sale_price]);

  // Sale + Description panel JSX — rendered in the QuickEditModal below the
  // Featured toggle, above the More Specs collapsible.
  const saleAndDescriptionPanel = (
    <div className="space-y-3">
      {/* Sale ribbon controls */}
      <div className="border border-rose-100 rounded-lg overflow-hidden">
        <div className="px-3 py-2 bg-rose-50 border-b border-rose-100 flex items-center gap-2 text-sm font-medium text-rose-800">
          <Tag className="w-4 h-4" />
          <span>Sale Panel</span>
          <span className="ml-1 text-[10px] uppercase tracking-wider text-rose-500">
            Controls the customer WAS/NOW/SAVE ribbon
          </span>
          {form.sale_active && saleMath && (
            <div className="ml-auto flex items-center gap-1.5 text-[11px] font-semibold">
              <span className="px-1.5 py-0.5 rounded bg-white text-rose-700 border border-rose-200">SAVE £{saleMath.save}</span>
              <span className="px-1.5 py-0.5 rounded bg-rose-600 text-white">{saleMath.pct}% OFF</span>
            </div>
          )}
        </div>
        <div className="p-3 bg-white grid grid-cols-3 gap-3">
          <label className="col-span-3 flex items-center gap-2 text-sm cursor-pointer" data-testid="quick-edit-sale-active-toggle">
            <input
              type="checkbox"
              checked={!!form.sale_active}
              onChange={(e) => setFormField('sale_active', e.target.checked)}
              className="w-4 h-4"
            />
            <span className="font-medium">Sale is active for this product</span>
            <span className="text-[11px] text-gray-500">— shows the red Sale ribbon + WAS/NOW panel on the landing page</span>
          </label>
          <div>
            <label className="block text-[11px] font-medium text-gray-600 mb-1">WAS Price (£)</label>
            <input
              type="number"
              step="0.01"
              value={form.was_price ?? ''}
              onChange={(e) => setFormField('was_price', e.target.value)}
              placeholder="58.99"
              className="w-full h-8 text-xs border border-gray-300 rounded px-2"
              data-testid="quick-edit-was-price"
              disabled={!form.sale_active}
            />
          </div>
          <div>
            <label className="block text-[11px] font-medium text-gray-600 mb-1">NOW Price (£)</label>
            <input
              type="number"
              step="0.01"
              value={form.sale_price ?? ''}
              onChange={(e) => setFormField('sale_price', e.target.value)}
              placeholder="44.99"
              className="w-full h-8 text-xs border border-gray-300 rounded px-2"
              data-testid="quick-edit-sale-price"
              disabled={!form.sale_active}
            />
          </div>
          <div>
            <label className="block text-[11px] font-medium text-gray-600 mb-1">Computed</label>
            <div className="h-8 text-xs border border-gray-200 rounded px-2 bg-gray-50 flex items-center gap-1.5 text-gray-500">
              <Percent className="w-3 h-3" />
              {saleMath ? <span className="text-emerald-700 font-semibold">£{saleMath.save} · {saleMath.pct}%</span> : <span>set both prices</span>}
            </div>
          </div>
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

  // Landing-page preview button — opens the customer /shop/collection/{series}
  // URL in a new tab. Uses tilestation.co.uk (production storefront) by
  // default because the preview environment doesn't host the /shop route.
  // Admins can override via REACT_APP_STOREFRONT_URL.
  const previewPanel = product ? (() => {
    const storefront = process.env.REACT_APP_STOREFRONT_URL || 'https://www.tilestation.co.uk';
    const seriesName = getSeriesName(product);
    const slug = (seriesName || product.product_name || product.name || '').trim().replace(/\s+/g, '-');
    const href = slug ? `${storefront}/shop/collection/${encodeURIComponent(slug)}` : `${storefront}/shop`;
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
      previewSlot={previewPanel}
      variantsSlot={variantsPanel}
    />
  );
};

export default QuickEditProductDrawer;
