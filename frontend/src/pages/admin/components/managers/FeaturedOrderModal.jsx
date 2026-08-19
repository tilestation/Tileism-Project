/**
 * FeaturedOrderModal — drag-to-reorder the homepage "Featured Tiles" section.
 * Fetches the currently featured products, lets the admin drag them into the
 * preferred order (or unfeature individual ones), then persists via
 * POST /api/supplier-sync/products/featured-order.
 */
import React, { useState, useEffect, useCallback } from 'react';
import { DragDropContext, Droppable, Draggable } from '@hello-pangea/dnd';
import { toast } from 'sonner';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '../../../../components/ui/dialog';
import { Button } from '../../../../components/ui/button';
import { GripVertical, Star, X, Loader2 } from 'lucide-react';

const API_URL = process.env.REACT_APP_BACKEND_URL;

const FeaturedOrderModal = ({ open, onOpenChange }) => {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);

  const fetchFeatured = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`${API_URL}/api/tiles/featured?limit=100&_=${Date.now()}`);
      const data = await res.json();
      setItems(data.mode === 'products' ? (data.items || []) : []);
    } catch {
      toast.error('Failed to load featured products');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { if (open) fetchFeatured(); }, [open, fetchFeatured]);

  const onDragEnd = (result) => {
    if (!result.destination) return;
    const next = [...items];
    const [moved] = next.splice(result.source.index, 1);
    next.splice(result.destination.index, 0, moved);
    setItems(next);
  };

  const unfeature = async (item) => {
    try {
      const res = await fetch(`${API_URL}/api/supplier-sync/products/bulk-feature`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ skus: [item.sku], featured: false }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setItems(prev => prev.filter(i => i.sku !== item.sku));
      toast.success(`${item.display_name || item.sku} removed from the homepage`);
    } catch (err) {
      toast.error(`Failed to remove: ${err.message}`);
    }
  };

  const saveOrder = async () => {
    setSaving(true);
    try {
      const res = await fetch(`${API_URL}/api/supplier-sync/products/featured-order`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ skus: items.map(i => i.sku) }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      toast.success('Homepage featured order saved');
      onOpenChange(false);
    } catch (err) {
      toast.error(`Failed to save order: ${err.message}`);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg" data-testid="featured-order-modal">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Star className="w-4 h-4 text-amber-500 fill-amber-400" />
            Homepage Featured Order
          </DialogTitle>
          <DialogDescription>
            Drag products into the order they should appear on the website front page. Top = first.
          </DialogDescription>
        </DialogHeader>

        {loading ? (
          <div className="py-8 flex justify-center"><Loader2 className="w-5 h-5 animate-spin text-gray-400" /></div>
        ) : items.length === 0 ? (
          <div className="py-8 text-center text-sm text-gray-500" data-testid="featured-order-empty">
            No products featured yet — tick products in a Manager and use the ⭐ Feature button.
          </div>
        ) : (
          <DragDropContext onDragEnd={onDragEnd}>
            <Droppable droppableId="featured-order">
              {(provided) => (
                <div ref={provided.innerRef} {...provided.droppableProps} className="max-h-[50vh] overflow-y-auto space-y-1.5" data-testid="featured-order-list">
                  {items.map((item, idx) => (
                    <Draggable key={item.sku} draggableId={item.sku} index={idx}>
                      {(prov, snapshot) => (
                        <div
                          ref={prov.innerRef}
                          {...prov.draggableProps}
                          className={`flex items-center gap-2.5 px-2.5 py-1.5 rounded-lg border bg-white ${snapshot.isDragging ? 'shadow-lg border-amber-300' : 'border-gray-200'}`}
                          data-testid={`featured-order-item-${item.sku}`}
                        >
                          <span {...prov.dragHandleProps} className="text-gray-300 hover:text-gray-500 cursor-grab" data-testid={`featured-order-handle-${item.sku}`}>
                            <GripVertical className="w-4 h-4" />
                          </span>
                          <span className="text-[11px] font-bold text-amber-600 w-5 text-center">{idx + 1}</span>
                          <div className="w-9 h-9 rounded bg-gray-100 overflow-hidden flex-shrink-0">
                            {(item.images || [])[0] ? <img src={item.images[0]} alt="" className="w-full h-full object-cover" /> : null}
                          </div>
                          <div className="min-w-0 flex-1">
                            <div className="text-[13px] font-medium text-gray-900 truncate">{item.display_name || item.sku}</div>
                            <div className="text-[11px] text-gray-500 truncate">{item.sku}{item.size ? ` · ${item.size}` : ''}</div>
                          </div>
                          <button
                            type="button"
                            onClick={() => unfeature(item)}
                            className="text-gray-300 hover:text-red-500 transition flex-shrink-0"
                            title="Remove from homepage"
                            data-testid={`featured-order-remove-${item.sku}`}
                          >
                            <X className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      )}
                    </Draggable>
                  ))}
                  {provided.placeholder}
                </div>
              )}
            </Droppable>
          </DragDropContext>
        )}

        <div className="flex justify-end gap-2 pt-1">
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)} data-testid="featured-order-cancel">Cancel</Button>
          <Button size="sm" onClick={saveOrder} disabled={saving || items.length === 0} className="bg-amber-500 hover:bg-amber-600 text-white" data-testid="featured-order-save">
            {saving ? 'Saving…' : 'Save Order'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
};

export default FeaturedOrderModal;
