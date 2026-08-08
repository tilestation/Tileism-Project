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
import React, { useState, useEffect, useRef, useMemo } from 'react';
import { toast } from 'sonner';
import { ChevronDown, ChevronRight, Sliders } from 'lucide-react';
import QuickEditModal from '../supplier-products/QuickEditModal';

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
    });
    setDisplayCodePreview(displayCode);
    setShowCategorySuggestions(false);
    // Seed the moreSpecs form from the product so admin can edit existing values.
    const seed = {};
    (moreSpecsConfig?.spec_fields || []).concat(moreSpecsConfig?.filter_facets || []).forEach(f => {
      seed[f.key] = product[f.key] ?? '';
    });
    setMoreSpecsValues(seed);
    setMoreSpecsOpen(false); // collapsed by default; admins expand if they need it
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

  // Extract only the moreSpecs fields the admin actually changed. Compared
  // against the seed values from the product so we don't send unchanged fields.
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
        <div className="p-3 grid grid-cols-2 gap-3 bg-white">
          {moreSpecsFields.map(f => (
            <div key={f.key} className={f.type === 'textarea' ? 'col-span-2' : ''}>
              <label className="block text-[11px] font-medium text-gray-600 mb-1">
                {f.label || f.key}
                <span className="ml-1 text-[9px] uppercase tracking-wider text-gray-400">{f.key}</span>
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
          ))}
        </div>
      )}
    </div>
  ) : null;

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
    />
  );
};

export default QuickEditProductDrawer;
