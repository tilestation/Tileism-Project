import React from 'react';
import { Trash2, Plus, RotateCcw, Store, ChevronDown, ChevronUp } from 'lucide-react';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { Checkbox } from '../ui/checkbox';

// Capitalize first letter of every word (Title Case)
const toTitleCase = (str) => {
  if (!str) return '';
  return str.replace(/\b\w/g, char => char.toUpperCase());
};

// Component to display stock at other stores
const OtherStoresStock = ({ product, showrooms, userShowroomId }) => {
  const [expanded, setExpanded] = React.useState(false);
  const showroomStock = product.showroom_stock || {};
  
  // Get list of showrooms with stock
  const storesWithStock = showrooms
    .filter(s => showroomStock[s.id] > 0)
    .map(s => ({
      id: s.id,
      name: s.id === userShowroomId ? 'Your Stock' : s.name,
      stock: showroomStock[s.id],
      isUserStore: s.id === userShowroomId
    }))
    .sort((a, b) => {
      // Put user's store first
      if (a.isUserStore) return -1;
      if (b.isUserStore) return 1;
      return a.name.localeCompare(b.name);
    });
  
  if (storesWithStock.length === 0) {
    return <div className="text-xs text-gray-400">No store stock</div>;
  }
  
  const userStore = storesWithStock.find(s => s.isUserStore);
  const otherStores = storesWithStock.filter(s => !s.isUserStore);
  
  return (
    <div className="mt-1">
      {/* User's store stock - always visible */}
      {userStore && (
        <div className="text-xs font-medium text-blue-700 flex items-center gap-1">
          <Store className="h-3 w-3" />
          {userStore.name}: {userStore.stock}
        </div>
      )}
      
      {/* Other stores toggle */}
      {otherStores.length > 0 && (
        <>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              setExpanded(!expanded);
            }}
            className="text-xs text-purple-600 hover:text-purple-800 flex items-center gap-0.5 mt-0.5"
          >
            {expanded ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
            {otherStores.length} other store{otherStores.length > 1 ? 's' : ''}
          </button>
          
          {expanded && (
            <div className="mt-1 pl-2 border-l-2 border-purple-200 space-y-0.5">
              {otherStores.map(store => (
                <div key={store.id} className="text-xs text-gray-600">
                  {store.name}: <span className="font-medium">{store.stock}</span>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
};

// Inline component for showing other stores stock in the stock column
const OtherStoresStockInline = ({ showroomStock, currentStock, totalStock, showrooms, userShowroomId }) => {
  const [expanded, setExpanded] = React.useState(false);
  
  // Get other stores with stock (excluding current store)
  const otherStores = showrooms
    .filter(s => s.id !== userShowroomId && showroomStock[s.id] > 0)
    .map(s => ({
      id: s.id,
      name: s.name,
      stock: showroomStock[s.id]
    }));
  
  // Calculate total stock from other stores
  const otherStoresTotal = otherStores.reduce((sum, s) => sum + s.stock, 0);
  
  if (otherStores.length === 0) {
    return null;
  }
  
  return (
    <div className="mt-1 pt-1 border-t border-gray-200">
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          setExpanded(!expanded);
        }}
        className="text-xs text-purple-600 hover:text-purple-800 flex items-center gap-1 w-full justify-center"
      >
        <Store className="h-3 w-3" />
        {expanded ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
        <span>{otherStores.length} other store{otherStores.length > 1 ? 's' : ''}: {otherStoresTotal}</span>
      </button>
      
      {expanded && (
        <div className="mt-1 space-y-0.5 text-left">
          {otherStores.map(store => (
            <div key={store.id} className="text-xs text-gray-600 flex justify-between px-1">
              <span>{store.name}:</span>
              <span className="font-medium">{store.stock}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

// Component to display supplier stock levels
const SupplierStockDisplay = ({ product, suppliers }) => {
  const [expanded, setExpanded] = React.useState(false);
  const supplierStock = product.supplier_stock || {};
  
  // Get list of suppliers with stock
  const suppliersWithStock = suppliers
    .filter(s => supplierStock[s.id] > 0)
    .map(s => ({
      id: s.id,
      name: s.code || s.name,  // Use short code if available
      fullName: s.name,
      stock: supplierStock[s.id]
    }))
    .sort((a, b) => b.stock - a.stock);  // Sort by stock descending
  
  if (suppliersWithStock.length === 0) {
    return null;  // Don't show anything if no supplier stock
  }
  
  const totalSupplierStock = suppliersWithStock.reduce((sum, s) => sum + s.stock, 0);
  
  return (
    <div className="mt-1 pt-1 border-t border-gray-100">
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          setExpanded(!expanded);
        }}
        className="text-xs text-emerald-600 hover:text-emerald-800 flex items-center gap-0.5"
      >
        {expanded ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
        <span className="font-medium">Supplier Stock: {totalSupplierStock.toLocaleString()}</span>
        <span className="text-gray-400 ml-1">({suppliersWithStock.length} supplier{suppliersWithStock.length > 1 ? 's' : ''})</span>
      </button>
      
      {expanded && (
        <div className="mt-1 pl-2 border-l-2 border-emerald-200 space-y-0.5">
          {suppliersWithStock.map(supplier => (
            <div key={supplier.id} className="text-xs text-gray-600" title={supplier.fullName}>
              {supplier.name}: <span className="font-medium text-emerald-700">{supplier.stock.toLocaleString()}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

export const InvoiceLineItemsTable = ({
  lineItems,
  products,
  searchTerm,
  activeLineIndex,
  authorizedDiscounts,
  user,
  showrooms = [],  // Add showrooms prop for "Check Other Stores" feature
  userShowroomId,  // Add user's showroom ID prop
  suppliers = [],  // Add suppliers prop for supplier stock display
  onSearchTermChange,
  onActiveLineIndexChange,
  onSelectProduct,
  onUpdateLineItem,
  onAddLineItem,
  onRemoveLineItem,
  onRoundUpToBox,
  calculateLineTotal,
  getMinAllowedPrice,
  isDiscountExceeded,
  getBoxInfo,
  totals,
  showVat = true,  // Default to true for backwards compatibility
  // Trade-credit redemption — rendered as a payment line, not a discount.
  creditRedeemedAmount = 0,
  creditRedeemedAccount = null,
  // Per-line return-link callbacks — when ticking the Return checkbox we
  // ask the parent to open a dialog (and only flip the row to RETURNED
  // once the original invoice number is confirmed). Unticking clears
  // the link in one shot.
  onRequestReturnLink = null,
  onClearReturnLink = null,
}) => {
  // Filter products based on search - supports word-by-word matching in any order
  // e.g., "chrome tin" matches "Tin Chrome Edge Finish"
  // Also searches by original supplier product name for flexible search
  // e.g., "Tenby White" (supplier name) finds "Sparta White" (internal name)
  const filteredProducts = products.filter(p => {
    if (!searchTerm) return true;
    
    const searchLower = searchTerm.toLowerCase().trim();
    const nameLower = (p.name || '').toLowerCase();
    const skuLower = (p.sku || '').toLowerCase();
    const descLower = (p.description || '').toLowerCase();
    const supplierLower = (p.supplier_name || '').toLowerCase();
    // Support searching by original supplier product name
    const supplierProductNameLower = (p.supplier_product_name || '').toLowerCase();
    
    // First check if exact substring match (original behavior)
    if (nameLower.includes(searchLower) || skuLower.includes(searchLower)) {
      return true;
    }
    
    // Check if search matches original supplier product name (flexible search)
    if (supplierProductNameLower && supplierProductNameLower.includes(searchLower)) {
      return true;
    }
    
    // Split search into words and check if ALL words are found in product (any order)
    const searchWords = searchLower.split(/\s+/).filter(w => w.length > 0);
    
    // If single word, check if it's in name, sku, description, supplier, or supplier product name
    if (searchWords.length === 1) {
      return nameLower.includes(searchWords[0]) || 
             skuLower.includes(searchWords[0]) ||
             descLower.includes(searchWords[0]) ||
             supplierLower.includes(searchWords[0]) ||
             supplierProductNameLower.includes(searchWords[0]);
    }
    
    // For multiple words, ALL words must be found somewhere in the product info (including supplier product name)
    const combinedText = `${nameLower} ${skuLower} ${descLower} ${supplierLower} ${supplierProductNameLower}`;
    return searchWords.every(word => combinedText.includes(word));
  });

  // Handle price change - updates price and optionally syncs duePrice in a single update
  // to prevent focus loss from multiple re-renders
  const handlePriceChange = (index, item, newPrice) => {
    // Pass syncDuePrice=true to batch update both price and duePrice
    onUpdateLineItem(index, 'price', newPrice, true);
  };

  return (
    <div className="mb-6">
      <div className="flex justify-between items-center mb-4">
        <h3 className="font-semibold text-lg">Line Items</h3>
        <Button size="sm" onClick={onAddLineItem} className="bg-accent hover:bg-accent/90" data-testid="add-line-item-btn">
          <Plus className="h-4 w-4 mr-1" /> Add Item
        </Button>
      </div>
      
      <div className="overflow-x-auto">
        <table className="w-full border-collapse">
          <thead>
            <tr className="bg-muted">
              <th className="border px-3 py-2 text-left text-sm w-28">SKU</th>
              <th className="border px-3 py-2 text-left text-sm">Product</th>
              <th className="border px-3 py-2 text-center text-sm w-20">Stock</th>
              <th className="border px-3 py-2 text-center text-sm w-20">Qty</th>
              <th className="border px-3 py-2 text-center text-sm w-20">m²</th>
              <th className="border px-3 py-2 text-right text-sm w-24">Price (£)</th>
              <th className="border px-3 py-2 text-right text-sm w-28">Due Price (£)</th>
              <th className="border px-3 py-2 text-center text-sm w-20">Return</th>
              <th className="border px-3 py-2 text-right text-sm w-24">Total Due</th>
              <th className="border px-3 py-2 text-right text-sm w-24">Savings</th>
              <th className="border px-3 py-2 text-center text-sm w-16">Action</th>
            </tr>
          </thead>
          <tbody>
            {lineItems.map((item, index) => {
              const calc = calculateLineTotal(item);
              const qtyExceedsStock = item.stock && parseFloat(item.qty) > item.stock;
              const isReturn = item.isReturn === true;
              
              return (
                <tr key={index} className={`${qtyExceedsStock ? 'bg-red-50' : ''} ${isReturn ? 'bg-red-50 border-l-4 border-l-red-500' : ''}`}>
                  {/* SKU Column */}
                  <td className="border px-1 py-1 relative">
                    <Input
                      className="h-8 text-sm"
                      value={item.sku}
                      onChange={(e) => {
                        onUpdateLineItem(index, 'sku', e.target.value);
                        onSearchTermChange(e.target.value);
                        onActiveLineIndexChange(index);
                      }}
                      onFocus={() => {
                        onActiveLineIndexChange(index);
                        onSearchTermChange(item.sku || '');
                      }}
                      placeholder="Search SKU..."
                    />
                    {/* Product Search Dropdown */}
                    {activeLineIndex === index && searchTerm && (
                      <div className="absolute z-50 top-full left-0 bg-white border rounded-md shadow-lg max-h-72 overflow-y-auto min-w-[500px] w-[500px]">
                        {filteredProducts.length === 0 ? (
                          <div className="px-3 py-2 text-sm text-gray-500">No products found</div>
                        ) : (
                          filteredProducts.slice(0, 10).map(product => {
                            // Get showroom-specific stock
                            const showroomStock = userShowroomId && product.showroom_stock 
                              ? (product.showroom_stock[userShowroomId] || 0)
                              : product.stock;
                            const otherStoresStock = product.showroom_stock 
                              ? Object.entries(product.showroom_stock)
                                  .filter(([id]) => id !== userShowroomId)
                                  .reduce((sum, [_, qty]) => sum + qty, 0)
                              : 0;
                            
                            return (
                            <div
                              key={product.id}
                              className="px-3 py-2 hover:bg-gray-100 cursor-pointer text-sm border-b"
                              onClick={() => onSelectProduct(index, product)}
                            >
                              <div className="flex justify-between">
                                <span className="font-medium">{product.sku || 'N/A'}</span>
                                <span className="text-green-600">£{(product.price || 0).toFixed(2)}</span>
                              </div>
                              <div className="text-xs text-gray-500">{product.name}</div>
                              {product.description && (
                                <div className="text-xs text-purple-600 font-medium">{product.description}</div>
                              )}
                              <div className="flex justify-between items-center mt-1">
                                <span className={`text-xs font-medium ${showroomStock > 0 ? 'text-green-600' : 'text-red-500'}`}>
                                  This Store: {showroomStock}
                                </span>
                                {otherStoresStock > 0 && (
                                  <span className="text-xs text-purple-600">
                                    Other Stores: {otherStoresStock}
                                  </span>
                                )}
                              </div>
                            </div>
                          )})
                        )}
                      </div>
                    )}
                  </td>
                  
                  {/* Product Column */}
                  <td className="border px-1 py-1">
                    {isReturn && (
                      <div className="flex items-center gap-1 mb-1">
                        <span
                          className="inline-block px-1.5 py-0.5 rounded text-[10px] font-bold uppercase bg-red-600 text-white tracking-wide"
                          data-testid={`returned-badge-${index}`}
                        >
                          RETURNED
                        </span>
                      </div>
                    )}
                    <Input
                      className={`h-8 text-sm ${isReturn ? 'line-through text-red-700' : ''}`}
                      value={item.product}
                      onChange={(e) => {
                        onUpdateLineItem(index, 'product', e.target.value);
                        onSearchTermChange(e.target.value);
                        onActiveLineIndexChange(index);
                      }}
                      onFocus={() => {
                        onActiveLineIndexChange(index);
                        onSearchTermChange(item.product || '');
                      }}
                      onBlur={(e) => {
                        onUpdateLineItem(index, 'product', toTitleCase(e.target.value));
                      }}
                      placeholder="Search product..."
                    />
                  </td>
                  
                  {/* Stock Column */}
                  <td className="border px-2 py-1 text-center text-sm">
                    {item.stock !== undefined && item.stock !== null ? (
                      <div className="flex flex-col">
                        <span className={item.stock < 10 ? 'text-red-600 font-medium' : 'text-green-600'}>
                          {item.stock} pcs
                        </span>
                        {item.tile_m2_per_piece && item.stock > 0 && (
                          <span className="text-xs text-blue-600">
                            {(item.stock * item.tile_m2_per_piece).toFixed(2)} m²
                          </span>
                        )}
                        {item.tiles_per_box && item.stock > 0 && (
                          <span className="text-xs text-muted-foreground">
                            {(item.stock / item.tiles_per_box).toFixed(1)} boxes
                          </span>
                        )}
                        {/* Show other stores stock */}
                        {item.showroom_stock && showrooms.length > 0 && (
                          <OtherStoresStockInline 
                            showroomStock={item.showroom_stock}
                            currentStock={item.stock}
                            totalStock={item.totalStock}
                            showrooms={showrooms}
                            userShowroomId={userShowroomId}
                          />
                        )}
                      </div>
                    ) : (
                      <span className="text-gray-400">-</span>
                    )}
                  </td>
                  
                  {/* Qty Column */}
                  <td className="border px-1 py-1">
                    <div className="flex flex-col gap-1">
                      <Input
                        type="number"
                        min="0"
                        step="1"
                        className={`h-8 text-sm text-center w-full min-w-[60px] ${qtyExceedsStock ? 'border-red-500 bg-red-50' : ''}`}
                        value={item.qty}
                        onChange={(e) => {
                          const value = e.target.value.replace(/[^0-9.]/g, '');
                          onUpdateLineItem(index, 'qty', value);
                        }}
                        placeholder="0"
                      />
                      {/* Box info and round-up button */}
                      {item.tiles_per_box && item.qty && (() => {
                        const boxInfo = getBoxInfo(item);
                        if (!boxInfo) return null;
                        return (
                          <div className="text-xs">
                            <span className={boxInfo.isFullBoxes ? 'text-green-600' : 'text-amber-600'}>
                              {boxInfo.boxes} boxes
                            </span>
                            {!boxInfo.isFullBoxes && (
                              <button
                                type="button"
                                onClick={() => onRoundUpToBox(index)}
                                className="ml-1 text-blue-600 hover:text-blue-800 underline"
                              >
                                ↑ round
                              </button>
                            )}
                          </div>
                        );
                      })()}
                    </div>
                  </td>
                  
                  {/* m² Column */}
                  <td className="border px-1 py-1">
                    <Input
                      type="number"
                      step="0.01"
                      min="0"
                      className="h-8 text-sm text-center w-full min-w-[60px]"
                      value={item.m2}
                      onChange={(e) => {
                        const value = e.target.value.replace(/[^0-9.]/g, '');
                        onUpdateLineItem(index, 'm2', value);
                      }}
                      placeholder="0"
                    />
                  </td>
                  
                  {/* Price Column */}
                  <td className="border px-1 py-1">
                    <Input
                      type="number"
                      step="0.01"
                      min="0"
                      className="h-8 text-sm text-right"
                      value={item.price}
                      onChange={(e) => {
                        const newPrice = e.target.value.replace(/[^0-9.]/g, '');
                        handlePriceChange(index, item, newPrice);
                      }}
                      placeholder="0.00"
                      data-testid={`price-input-${index}`}
                    />
                    {/* Box price display */}
                    {item.tiles_per_box && item.price && (
                      <div className="text-xs text-muted-foreground text-right">
                        £{(item.tiles_per_box * parseFloat(item.price)).toFixed(2)}/box
                      </div>
                    )}
                  </td>
                  
                  {/* Due Price Column */}
                  <td className="border px-1 py-1">
                    <Input
                      type="number"
                      step="0.01"
                      className={`h-8 text-sm text-right ${calc.savings > 0 ? 'border-green-500 bg-green-50' : ''} ${isDiscountExceeded(item, index) ? 'border-red-500 bg-red-50' : ''}`}
                      value={item.duePrice !== '' && item.duePrice !== null && item.duePrice !== undefined ? item.duePrice : item.price}
                      onChange={(e) => {
                        const value = e.target.value.replace(/[^0-9.]/g, '');
                        onUpdateLineItem(index, 'duePrice', value);
                      }}
                      placeholder="0.00"
                      data-testid={`due-price-input-${index}`}
                      min={user?.role !== 'super_admin' && !authorizedDiscounts[index] && item.max_discount ? getMinAllowedPrice(item).toFixed(2) : "0"}
                    />
                    {calc.discountPercent > 0 && (
                      <div className={`text-xs text-right mt-1 ${authorizedDiscounts[index] ? 'text-amber-600' : 'text-green-600'}`}>
                        -{calc.discountPercent.toFixed(1)}% off
                        {authorizedDiscounts[index] && <span className="ml-1">✓</span>}
                      </div>
                    )}
                    {item.max_discount && user?.role !== 'super_admin' && !authorizedDiscounts[index] && (
                      <div className="text-xs text-amber-600 text-right">
                        Max: {item.max_discount}% off
                      </div>
                    )}
                  </td>
                  
                  {/* Return/Refund Toggle Column */}
                  <td className="border px-2 py-2 text-center">
                    <div className="flex flex-col items-center gap-1" onClick={(e) => e.stopPropagation()}>
                      <Checkbox
                        checked={isReturn}
                        onCheckedChange={(checked) => {
                          if (checked) {
                            // Ticking → must capture original invoice no.
                            // Keep the row UNTICKED until parent confirms.
                            if (onRequestReturnLink) {
                              onRequestReturnLink(index, item.originalInvoiceNo || '', item.originalInvoiceId || '');
                            } else {
                              // Defensive fallback if parent didn't wire the
                              // handler — preserves the old flip-on-tick
                              // behaviour so the box still works.
                              onUpdateLineItem(index, 'isReturn', true);
                            }
                          } else {
                            // Unticking → clear all 3 return fields in one go.
                            if (onClearReturnLink) {
                              onClearReturnLink(index);
                            } else {
                              onUpdateLineItem(index, 'isReturn', false);
                            }
                          }
                        }}
                        className={isReturn ? 'border-red-500 data-[state=checked]:bg-red-600' : ''}
                        data-testid={`return-checkbox-${index}`}
                      />
                      {isReturn && (
                        <>
                          <span className="text-xs text-red-600 font-bold flex items-center gap-1">
                            <RotateCcw className="h-3 w-3" />
                            RETURNED
                          </span>
                          {/* Linked invoice — clicking re-opens the dialog
                              so staff can change which sale this return is
                              tied to. Falls back to a "Link…" affordance
                              when somehow the link is missing (e.g. an
                              older invoice loaded for edit). */}
                          {item.originalInvoiceNo ? (
                            <button
                              type="button"
                              onClick={() => onRequestReturnLink && onRequestReturnLink(
                                index,
                                item.originalInvoiceNo || '',
                                item.originalInvoiceId || ''
                              )}
                              className="text-[10px] text-red-700 underline decoration-dotted underline-offset-2 font-mono hover:text-red-900"
                              title="Click to change the linked invoice"
                              data-testid={`return-linked-invoice-${index}`}
                            >
                              {item.originalInvoiceNo}
                            </button>
                          ) : onRequestReturnLink && (
                            <button
                              type="button"
                              onClick={() => onRequestReturnLink(index, '', '')}
                              className="text-[10px] text-amber-700 underline font-medium hover:text-amber-900"
                              data-testid={`return-link-missing-${index}`}
                            >
                              Link invoice…
                            </button>
                          )}
                        </>
                      )}
                    </div>
                  </td>
                  
                  {/* Total Due Column */}
                  <td className="border px-3 py-2 text-right text-sm font-medium">
                    {isReturn ? (
                      <span className="text-red-600 font-bold">−£{calc.due.toFixed(2)}</span>
                    ) : (
                      <span>£{calc.due.toFixed(2)}</span>
                    )}
                  </td>
                  
                  {/* Savings Column */}
                  <td className="border px-3 py-2 text-right text-sm">
                    {calc.savings > 0 ? (
                      <span className="text-green-600 font-medium">£{calc.savings.toFixed(2)}</span>
                    ) : (
                      <span className="text-muted-foreground">-</span>
                    )}
                  </td>
                  
                  {/* Action Column */}
                  <td className="border px-2 py-1 text-center">
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-8 w-8 p-0 text-red-600"
                      onClick={() => onRemoveLineItem(index)}
                      disabled={lineItems.length === 1}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </td>
                </tr>
              );
            })}
          </tbody>
          <tfoot>
            <tr className="bg-muted font-semibold">
              <td colSpan={8} className="border px-3 py-2 text-right">Subtotal:</td>
              <td className="border px-3 py-2 text-right">£{totals.totalDue.toFixed(2)}</td>
              <td className="border px-3 py-2 text-right text-green-600">£{totals.totalSavings.toFixed(2)}</td>
              <td className="border"></td>
            </tr>
            {totals.totalReturns > 0 && (
              <tr className="font-semibold text-red-600" data-testid="returns-summary-row">
                <td colSpan={8} className="border px-3 py-2 text-right">Returns/Credits:</td>
                <td className="border px-3 py-2 text-right">−£{totals.totalReturns.toFixed(2)}</td>
                <td className="border"></td>
                <td className="border"></td>
              </tr>
            )}
            {showVat && (
              <tr className="font-semibold">
                <td colSpan={8} className="border px-3 py-2 text-right">VAT (20%):</td>
                <td className="border px-3 py-2 text-right">£{totals.vat.toFixed(2)}</td>
                <td className="border"></td>
                <td className="border"></td>
              </tr>
            )}
            <tr className="bg-accent/10 font-bold text-lg">
              <td colSpan={8} className="border px-3 py-2 text-right">Gross Total:</td>
              <td className="border px-3 py-2 text-right">£{totals.grossTotal.toFixed(2)}</td>
              <td className="border"></td>
              <td className="border"></td>
            </tr>
            {/* Trade credit redemption — payment line, not a discount */}
            {Number(creditRedeemedAmount) > 0 && (
              <>
                <tr className="text-emerald-700">
                  <td colSpan={8} className="border px-3 py-2 text-right">
                    Trade credit redeemed
                    {creditRedeemedAccount ? (
                      <span className="font-mono text-xs ml-1">({creditRedeemedAccount})</span>
                    ) : null}:
                  </td>
                  <td className="border px-3 py-2 text-right tabular-nums">−£{Number(creditRedeemedAmount).toFixed(2)}</td>
                  <td className="border"></td>
                  <td className="border"></td>
                </tr>
                <tr className="bg-emerald-50 font-bold">
                  <td colSpan={8} className="border px-3 py-2 text-right">Cash / card due:</td>
                  <td className="border px-3 py-2 text-right tabular-nums">
                    £{Math.max(0, totals.grossTotal - Number(creditRedeemedAmount)).toFixed(2)}
                  </td>
                  <td className="border"></td>
                  <td className="border"></td>
                </tr>
              </>
            )}
          </tfoot>
        </table>
      </div>
    </div>
  );
};
