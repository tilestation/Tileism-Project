/**
 * BulkSaleModal - Modal for bulk applying sale labels and discounts
 * With product-level selection checklist
 */

import React, { useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '../../../../components/ui/dialog';
import { Button } from '../../../../components/ui/button';
import { Input } from '../../../../components/ui/input';
import {
  Tag,
  Plus,
  X,
  RefreshCw,
  Trash2,
  Check,
  AlertTriangle,
  ChevronDown,
  ChevronUp,
} from 'lucide-react';

const PRESET_LABELS = ['Sale', 'Clearance', 'New Arrival', 'Limited Stock', 'Best Seller'];

const BulkSaleModal = ({
  open,
  onOpenChange,
  selectedProducts,
  products,
  getProductKey,
  form,
  setForm,
  loading,
  onApply,
}) => {
  const [showProductList, setShowProductList] = useState(false);
  const [targetProducts, setTargetProducts] = useState(new Set());

  const selectedKeys = Array.from(selectedProducts);
  const selectedProductsList = (products || []).filter(p => getProductKey && selectedKeys.includes(getProductKey(p)));

  const targetCount = targetProducts.size > 0 ? targetProducts.size : selectedProducts.size;

  const handleApply = () => {
    onApply(targetProducts.size > 0 ? targetProducts : null);
  };

  const handleClose = (val) => {
    if (!val) {
      setTargetProducts(new Set());
      setShowProductList(false);
    }
    onOpenChange(val);
  };

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Tag className="w-5 h-5 text-rose-600" />
            Bulk Sale & Labels ({selectedProducts.size} products)
          </DialogTitle>
        </DialogHeader>
        
        <div className="space-y-6">
          {/* Action Type */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">Action</label>
            <div className="flex gap-2">
              {[
                { value: 'add', label: 'Add Labels', icon: Plus },
                { value: 'remove', label: 'Remove Labels', icon: X },
                { value: 'replace', label: 'Replace All', icon: RefreshCw },
                { value: 'clear', label: 'Clear All', icon: Trash2 }
              ].map(({ value, label, icon: Icon }) => (
                <button
                  key={value}
                  onClick={() => setForm(prev => ({ ...prev, action: value }))}
                  className={`flex-1 flex items-center justify-center gap-1 px-3 py-2 rounded-lg text-sm font-medium transition-all ${
                    form.action === value
                      ? 'bg-rose-500 text-white'
                      : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                  }`}
                >
                  <Icon className="w-4 h-4" />
                  {label}
                </button>
              ))}
            </div>
          </div>

          {/* Labels Selection (hidden for 'clear' action) */}
          {form.action !== 'clear' && (
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">Select Labels</label>
              <div className="flex flex-wrap gap-2">
                {PRESET_LABELS.map(label => (
                  <button
                    key={label}
                    onClick={() => {
                      setForm(prev => ({
                        ...prev,
                        labels: prev.labels.includes(label)
                          ? prev.labels.filter(l => l !== label)
                          : [...prev.labels, label]
                      }));
                    }}
                    className={`inline-flex items-center gap-1 px-3 py-1.5 rounded-full text-sm font-medium transition-all ${
                      form.labels.includes(label)
                        ? 'bg-rose-500 text-white ring-2 ring-rose-300'
                        : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Bulk Discount */}
          {form.action !== 'clear' && (
            <div className="border-t pt-4">
              <div className="flex items-center gap-2 mb-4">
                <input
                  type="checkbox"
                  id="bulk-apply-discount"
                  checked={form.applyDiscount}
                  onChange={(e) => setForm(prev => ({ ...prev, applyDiscount: e.target.checked }))}
                  className="w-4 h-4 rounded border-gray-300 text-red-600 focus:ring-red-500"
                />
                <label htmlFor="bulk-apply-discount" className="text-sm font-medium text-gray-700">
                  Apply discount to all selected products
                </label>
              </div>

              {form.applyDiscount && (
                <div className="space-y-3">
                  {/* Sale mode selector */}
                  <div className="flex gap-2">
                    {[
                      { value: 'was', label: 'Set WAS price (£)' },
                      { value: 'percent', label: '% off current price' },
                    ].map(({ value, label }) => (
                      <button
                        key={value}
                        type="button"
                        onClick={() => setForm(prev => ({ ...prev, saleMode: value }))}
                        className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-all ${
                          (form.saleMode || 'was') === value
                            ? 'bg-red-600 text-white'
                            : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                        }`}
                        data-testid={`sale-mode-${value}`}
                      >
                        {label}
                      </button>
                    ))}
                  </div>

                  {(form.saleMode || 'was') === 'was' ? (
                    <div>
                      <div className="flex items-center gap-3">
                        <span className="text-sm font-semibold text-gray-700">WAS £</span>
                        <Input
                          type="number"
                          step="0.01"
                          min="0"
                          value={form.was_price || ''}
                          onChange={(e) => setForm(prev => ({ ...prev, was_price: e.target.value }))}
                          placeholder="e.g. 54.99"
                          className="w-32"
                          data-testid="bulk-was-price-input"
                        />
                        <span className="text-sm text-gray-500">crossed-out anchor price</span>
                      </div>
                      <p className="text-xs text-gray-500 mt-2 bg-red-50 border border-red-100 rounded-lg p-2">
                        Your list price stays exactly as it is. The storefront shows
                        <span className="line-through mx-1">WAS £{form.was_price || '54.99'}</span>
                        with the current price in <b className="text-red-600">bold red as the SALE price</b>, and the
                        total % saved (WAS → final price, including volume tiers and the extra trade
                        discount once a trade customer signs in).
                      </p>
                    </div>
                  ) : (
                    <div>
                      <div className="flex items-center gap-3">
                        <Input
                          type="number"
                          step="0.1"
                          value={form.discount_percentage}
                          onChange={(e) => setForm(prev => ({ ...prev, discount_percentage: e.target.value }))}
                          placeholder="Discount %"
                          className="w-32"
                          data-testid="bulk-discount-percent-input"
                        />
                        <span className="text-sm text-gray-500">% off current price</span>
                      </div>
                      <p className="text-xs text-gray-500 mt-2 bg-red-50 border border-red-100 rounded-lg p-2">
                        Your current price becomes the <b className="text-red-600">SALE price</b>. The WAS anchor is
                        worked out from the % and rounded UP to the nearest .99 — e.g. a £34.99 price at 12% shows
                        <span className="line-through mx-1">WAS £39.99</span>
                        crossed out next to it.
                      </p>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {/* Product Selection Checklist */}
          {selectedProductsList.length > 0 && (
            <div className="border-t pt-4">
              <button
                type="button"
                onClick={() => setShowProductList(!showProductList)}
                className="w-full flex items-center justify-between p-2 rounded-lg bg-gray-50 hover:bg-gray-100 transition"
                data-testid="toggle-product-checklist"
              >
                <span className="text-sm font-medium text-gray-700">
                  Apply to specific products
                  {targetProducts.size > 0 && (
                    <span className="ml-2 text-rose-600">({targetProducts.size} of {selectedProductsList.length} selected)</span>
                  )}
                </span>
                {showProductList ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
              </button>

              {showProductList && (
                <div className="mt-2">
                  <div className="flex gap-1 mb-2">
                    <button
                      type="button"
                      onClick={() => {
                        const allKeys = new Set(selectedProductsList.map(p => getProductKey(p)));
                        setTargetProducts(allKeys);
                      }}
                      className="text-[10px] px-2 py-1 bg-rose-100 text-rose-600 rounded hover:bg-rose-200 font-medium"
                    >
                      Select All
                    </button>
                    <button
                      type="button"
                      onClick={() => setTargetProducts(new Set())}
                      className="text-[10px] px-2 py-1 bg-gray-100 text-gray-600 rounded hover:bg-gray-200 font-medium"
                    >
                      Clear Selection
                    </button>
                  </div>
                  <div className="max-h-48 overflow-y-auto border border-gray-200 rounded-lg bg-white">
                    {selectedProductsList.map(p => {
                      const key = getProductKey(p);
                      const isChecked = targetProducts.size === 0 || targetProducts.has(key);
                      const name = p.product_name || p.name || p.sku;
                      const currentLabels = p.labels || [];
                      return (
                        <label
                          key={key}
                          className={`flex items-center gap-2 px-3 py-2 text-xs border-b border-gray-50 last:border-0 cursor-pointer hover:bg-rose-50 ${isChecked && targetProducts.size > 0 ? 'bg-rose-50' : ''}`}
                        >
                          <input
                            type="checkbox"
                            checked={isChecked}
                            onChange={() => {
                              setTargetProducts(prev => {
                                const next = new Set(prev);
                                if (prev.size === 0) {
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
                          {currentLabels.length > 0 && (
                            <span className="text-[10px] px-1 py-0.5 bg-green-100 text-green-700 rounded whitespace-nowrap">
                              {currentLabels.join(', ')}
                            </span>
                          )}
                        </label>
                      );
                    })}
                  </div>
                  <p className="text-[10px] text-gray-500 mt-1">
                    {targetProducts.size > 0
                      ? `${targetProducts.size} products will be updated`
                      : `All ${selectedProductsList.length} products will be updated (uncheck to pick specific ones)`
                    }
                  </p>
                </div>
              )}
            </div>
          )}

          {/* Warning for clear action */}
          {form.action === 'clear' && (
            <div className="bg-orange-50 border border-orange-200 p-3 rounded-lg">
              <p className="text-sm text-orange-800 flex items-center gap-2">
                <AlertTriangle className="w-4 h-4" />
                This will remove ALL labels and sale pricing from {targetCount} products.
              </p>
            </div>
          )}
        </div>
        
        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={() => handleClose(false)}>
            Cancel
          </Button>
          <Button
            onClick={handleApply}
            disabled={loading}
            className="bg-rose-600 hover:bg-rose-700"
            data-testid="apply-sale-labels-btn"
          >
            {loading ? (
              <><RefreshCw className="w-4 h-4 mr-2 animate-spin" /> Processing...</>
            ) : (
              <><Check className="w-4 h-4 mr-2" /> Apply to {targetCount} Products</>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

export default BulkSaleModal;
