/**
 * QuickEditModal - Quick edit modal for supplier products
 * Extracted from SupplierProducts.js for better maintainability
 */

import React from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '../../../../components/ui/dialog';
import { Button } from '../../../../components/ui/button';
import { Input } from '../../../../components/ui/input';
import {
  PenLine,
  Globe,
  Building2,
  Eye,
  Star,
  Trash2,
  Plus,
  Loader2,
  ExternalLink,
  RefreshCw,
  Save,
  Cloud,
  Upload,
} from 'lucide-react';

const QuickEditModal = ({
  open,
  onOpenChange,
  product,
  form,
  setForm,
  loading,
  imageUploading,
  draggedImageIndex,
  displayCodePreview,
  showCategorySuggestions,
  setShowCategorySuggestions,
  categorySuggestions,
  onSave,
  onEditFullPage,
  onImageUpload,
  onDeleteImage,
  onSetPrimaryImage,
  onImageDragStart,
  onImageDragEnd,
  onImageDragOver,
  onImageDrop,
  onDisplayNameChange,
  setPreviewImages,
}) => {
  if (!product) return null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <PenLine className="w-5 h-5 text-amber-600" />
            Quick Edit Product
          </DialogTitle>
          <DialogDescription className="sr-only">
            Edit customer-facing details, internal supplier fields, pricing, stock and product images for this product.
          </DialogDescription>
        </DialogHeader>
        
        <div className="space-y-4 py-4">
          {/* Product Info Header */}
          <div className="bg-gray-50 p-3 rounded-lg border">
            <div className="flex items-center gap-3">
              {product.image && (
                <img 
                  src={product.image} 
                  alt={product.product_name || product.name}
                  className="w-16 h-16 object-cover cursor-pointer"
                  onClick={() => {
                    const allImages = form.images.length > 0 ? form.images : [product.image];
                    setPreviewImages({
                      images: allImages,
                      currentIndex: 0,
                      name: product.product_name || product.name,
                      sku: product.sku,
                      supplier: product.supplier
                    });
                  }}
                />
              )}
              <div>
                <p className="font-medium text-gray-900">{product.product_name || product.name}</p>
                <p className="text-sm text-gray-500">SKU: {product.sku}</p>
                <p className="text-xs text-gray-400">Supplier: {product.supplier}</p>
              </div>
            </div>
          </div>

          {/* Image Management Section */}
          <div className="border rounded-lg p-4 bg-blue-50">
            <label className="block text-sm font-medium text-blue-800 mb-3 flex items-center gap-2">
              Product Images ({form.images.length})
              <span className="text-xs font-normal text-green-600 flex items-center gap-1">
                <Cloud className="w-3 h-3" />
                Uploads to R2 Cloud
              </span>
            </label>
            
            {/* Image Grid */}
            <div className="flex flex-wrap gap-3 mb-3">
              {form.images.map((img, idx) => {
                const isR2Image = img?.includes('images.tilestation.co.uk') || img?.includes('r2.dev');
                return (
                  <div 
                    key={idx} 
                    className={`relative group cursor-grab active:cursor-grabbing ${
                      draggedImageIndex === idx ? 'opacity-50' : ''
                    } ${draggedImageIndex !== null && draggedImageIndex !== idx ? 'border-2 border-dashed border-blue-400' : ''}`}
                    draggable
                    onDragStart={(e) => onImageDragStart(e, idx)}
                    onDragEnd={onImageDragEnd}
                    onDragOver={onImageDragOver}
                    onDrop={(e) => onImageDrop(e, idx)}
                  >
                    <img 
                      src={img} 
                      alt={`Product image ${idx + 1}`}
                      className={`w-20 h-20 object-cover border-2 shadow-md hover:scale-105 transition-transform pointer-events-none ${
                        isR2Image ? 'border-green-400' : 'border-white'
                      }`}
                    />
                    {/* R2 Cloud indicator */}
                    {isR2Image && (
                      <span className="absolute -top-1 -right-1 bg-green-500 text-white text-[8px] px-1 rounded-full flex items-center gap-0.5">
                        <Cloud className="w-2 h-2" />
                        R2
                      </span>
                    )}
                    {/* Position badge */}
                    <span className={`absolute -top-1 -left-1 text-white text-xs px-1.5 font-bold ${
                      idx === 0 ? 'bg-green-500' : 'bg-gray-500'
                    }`}>
                      {idx === 0 ? 'Primary' : idx + 1}
                    </span>
                    {/* Click to preview overlay */}
                    <div 
                      className="absolute inset-0 bg-black/0 hover:bg-black/50 transition-opacity flex items-center justify-center gap-1 opacity-0 hover:opacity-100"
                      onClick={() => setPreviewImages({
                        images: form.images,
                        currentIndex: idx,
                        name: product.product_name || product.name,
                        sku: product.sku,
                        supplier: product.supplier
                      })}
                    >
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          setPreviewImages({
                            images: form.images,
                            currentIndex: idx,
                            name: product.product_name || product.name,
                            sku: product.sku,
                            supplier: product.supplier
                          });
                        }}
                        className="p-1 bg-blue-500 text-white rounded hover:bg-blue-600"
                        title="View image"
                      >
                        <Eye className="w-4 h-4" />
                      </button>
                      {idx !== 0 && (
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            onSetPrimaryImage(idx);
                          }}
                          className="p-1 bg-green-500 text-white rounded hover:bg-green-600"
                          title="Set as primary"
                        >
                          <Star className="w-4 h-4" />
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          onDeleteImage(img, idx);
                        }}
                        className="p-1 bg-red-500 text-white rounded hover:bg-red-600"
                        title="Remove image"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                  </div>
                );
              })}
              
              {/* Add Image Button - Enhanced with drag & drop hint */}
              <label className="w-20 h-20 border-2 border-dashed border-blue-300 flex flex-col items-center justify-center cursor-pointer hover:bg-blue-100 hover:border-blue-400 transition-colors rounded-lg">
                <input
                  type="file"
                  accept="image/*"
                  multiple
                  onChange={onImageUpload}
                  className="hidden"
                  disabled={imageUploading}
                />
                {imageUploading ? (
                  <div className="flex flex-col items-center">
                    <Loader2 className="w-5 h-5 text-blue-500 animate-spin" />
                    <span className="text-[10px] text-blue-500 mt-1">Uploading...</span>
                  </div>
                ) : (
                  <div className="flex flex-col items-center">
                    <Upload className="w-5 h-5 text-blue-400" />
                    <span className="text-[10px] text-blue-500 mt-1">Add</span>
                  </div>
                )}
              </label>
            </div>
            
            <p className="text-xs text-blue-600">
              <strong>Drag images</strong> to reorder • First image = Primary/Thumbnail • Hover for actions
            </p>
          </div>

          {/* Edit Form */}
          <div className="grid grid-cols-2 gap-4">
            {/* CUSTOMER-FACING SECTION */}
            <div className="col-span-2 bg-green-50 p-4 rounded-lg border border-green-200">
              <h4 className="text-sm font-semibold text-green-800 mb-3 flex items-center gap-2">
                <Globe className="w-4 h-4" />
                Customer-Facing (Shown on invoices & website)
              </h4>
              
              {/* Display Name */}
              <div className="mb-3">
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Display Name
                </label>
                <Input
                  value={form.display_name}
                  onChange={(e) => onDisplayNameChange(e.target.value)}
                  placeholder="e.g., Dolomite Blue 60x60cm Polished"
                  data-testid="quick-edit-display-name"
                  className="bg-white"
                />
              </div>
              
              {/* Display Code - Auto-generated with preview */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Display Code <span className="text-green-600 text-xs">(auto-generated)</span>
                </label>
                <div className="flex gap-2 items-center">
                  <Input
                    value={displayCodePreview || form.display_code || 'TS----'}
                    readOnly
                    className="bg-gray-100 font-mono text-lg tracking-wider"
                    data-testid="quick-edit-display-code"
                  />
                  {displayCodePreview && (
                    <span className="text-xs text-green-600 whitespace-nowrap">
                      TS + {form.display_name?.split(' ')[0]?.[0] || '?'} + {form.display_name?.split(' ').find(w => ['white','black','grey','gray','beige','cream','blue','green','red','brown'].includes(w.toLowerCase()))?.[0] || '?'} + size + finish
                    </span>
                  )}
                </div>
              </div>
            </div>

            {/* INTERNAL SECTION */}
            <div className="col-span-2 bg-gray-50 p-4 rounded-lg border border-gray-200">
              <h4 className="text-sm font-semibold text-gray-600 mb-3 flex items-center gap-2">
                <Building2 className="w-4 h-4" />
                Internal (Staff reference only - hidden from customers)
              </h4>
              
              <div className="grid grid-cols-2 gap-4">
                {/* Supplier Product Name */}
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Supplier Product Name
                  </label>
                  <Input
                    value={form.supplier_product_name || ''}
                    onChange={(e) => setForm(prev => ({ ...prev, supplier_product_name: e.target.value }))}
                    placeholder="Original supplier name"
                    data-testid="quick-edit-supplier-name"
                    className="bg-white"
                  />
                </div>
                
                {/* Supplier Product Code (editable) */}
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Supplier Product Code
                  </label>
                  <Input
                    value={form.supplier_product_code || ''}
                    onChange={(e) => setForm(prev => ({ ...prev, supplier_product_code: e.target.value }))}
                    className="bg-white font-mono"
                    placeholder="e.g., LP-3676"
                    data-testid="quick-edit-supplier-code"
                  />
                </div>
              </div>
            </div>

            {/* List Price */}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                List Price (£)
              </label>
              <Input
                type="number"
                step="0.01"
                value={form.price}
                onChange={(e) => setForm(prev => ({ ...prev, price: e.target.value }))}
                placeholder="0.00"
                data-testid="quick-edit-price"
              />
            </div>

            {/* Cost Price */}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Cost Price (£)
              </label>
              <Input
                type="number"
                step="0.01"
                value={form.cost_price}
                onChange={(e) => setForm(prev => ({ ...prev, cost_price: e.target.value }))}
                placeholder="0.00"
                data-testid="quick-edit-cost-price"
              />
            </div>

            {/* Stock Quantity */}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Stock (units)
              </label>
              <Input
                type="number"
                step="1"
                value={form.stock_quantity}
                onChange={(e) => setForm(prev => ({ ...prev, stock_quantity: e.target.value }))}
                placeholder="0"
                data-testid="quick-edit-stock-quantity"
              />
            </div>

            {/* Stock m² */}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Stock (m²)
              </label>
              <Input
                type="number"
                step="0.01"
                value={form.stock_m2}
                onChange={(e) => setForm(prev => ({ ...prev, stock_m2: e.target.value }))}
                placeholder="0.00"
                data-testid="quick-edit-stock-m2"
              />
            </div>

            {/* Category with Autocomplete */}
            <div className="relative">
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Category
              </label>
              <Input
                value={form.category}
                onChange={(e) => {
                  setForm(prev => ({ ...prev, category: e.target.value }));
                  setShowCategorySuggestions(true);
                }}
                onFocus={() => setShowCategorySuggestions(true)}
                onBlur={() => setTimeout(() => setShowCategorySuggestions(false), 200)}
                placeholder="Type or select category..."
                data-testid="quick-edit-category"
              />
              {showCategorySuggestions && categorySuggestions.length > 0 && (
                <div className="absolute z-50 w-full mt-1 bg-white border border-gray-200 rounded-md shadow-lg max-h-48 overflow-auto">
                  {categorySuggestions
                    .filter(cat => 
                      !form.category || 
                      cat.toLowerCase().includes(form.category.toLowerCase())
                    )
                    .slice(0, 10)
                    .map((cat, idx) => (
                      <button
                        key={idx}
                        type="button"
                        className="w-full px-3 py-2 text-left text-sm hover:bg-amber-50 focus:bg-amber-50 focus:outline-none"
                        onMouseDown={(e) => {
                          e.preventDefault();
                          setForm(prev => ({ ...prev, category: cat }));
                          setShowCategorySuggestions(false);
                        }}
                      >
                        {cat}
                      </button>
                    ))
                  }
                  {form.category && !categorySuggestions.includes(form.category) && (
                    <div className="px-3 py-2 text-sm text-green-600 border-t bg-green-50">
                      <Plus className="w-3 h-3 inline mr-1" />
                      Add new: "{form.category}"
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* Finish */}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Finish
              </label>
              <Input
                value={form.finish}
                onChange={(e) => setForm(prev => ({ ...prev, finish: e.target.value }))}
                placeholder="e.g., Matt, Polished"
                data-testid="quick-edit-finish"
              />
            </div>

            {/* Stock Status & Featured */}
            <div className="col-span-2 flex items-center gap-6 pt-2">
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={form.in_stock}
                  onChange={(e) => setForm(prev => ({ ...prev, in_stock: e.target.checked }))}
                  className="w-4 h-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                  data-testid="quick-edit-in-stock"
                />
                <span className="text-sm text-gray-700">In Stock</span>
              </label>
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={form.always_in_stock}
                  onChange={(e) => setForm(prev => ({ ...prev, always_in_stock: e.target.checked }))}
                  className="w-4 h-4 rounded border-gray-300 text-green-600 focus:ring-green-500"
                  data-testid="quick-edit-always-in-stock"
                />
                <span className="text-sm text-gray-700">Always In Stock</span>
              </label>
              <label className="flex items-center gap-2 cursor-pointer bg-yellow-50 px-3 py-1.5 rounded-lg border border-yellow-200">
                <input
                  type="checkbox"
                  checked={form.is_featured || false}
                  onChange={(e) => setForm(prev => ({ ...prev, is_featured: e.target.checked }))}
                  className="w-4 h-4 rounded border-yellow-400 text-yellow-500 focus:ring-yellow-500"
                  data-testid="quick-edit-is-featured"
                />
                <Star className="w-4 h-4 text-yellow-500" />
                <span className="text-sm font-medium text-yellow-700">Featured on Homepage</span>
              </label>
            </div>
          </div>

          {/* Open Full Editor Link — hidden when no handler is supplied
              (e.g. when opened from a Manager page via QuickEditProductDrawer). */}
          {typeof onEditFullPage === 'function' && (
            <div className="pt-2 border-t">
              <button
                type="button"
                onClick={() => {
                  onOpenChange(false);
                  onEditFullPage(product);
                }}
                className="text-sm text-blue-600 hover:text-blue-800 flex items-center gap-1"
              >
                <ExternalLink className="w-4 h-4" />
                Need more options? Open full editor
              </button>
            </div>
          )}
        </div>
        
        <DialogFooter className="gap-2">
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button
            onClick={onSave}
            disabled={loading}
            className="bg-amber-600 hover:bg-amber-700"
            data-testid="save-quick-edit-btn"
          >
            {loading ? (
              <>
                <RefreshCw className="w-4 h-4 mr-2 animate-spin" />
                Saving...
              </>
            ) : (
              <>
                <Save className="w-4 h-4 mr-2" />
                Save Changes
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

export default QuickEditModal;
