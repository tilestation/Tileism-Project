import React, { useState } from 'react';
import { Card } from '../components/ui/card';
import { Button } from '../components/ui/button';
import { Badge } from '../components/ui/badge';
import { Plus, Layers, Truck, Package } from 'lucide-react';
import { normaliseImageUrl, safeToFixed} from '../utils/safeStr';

export const ProductCard = ({ product, onAddToCart, isClearance = false }) => {
  const [selectedTier, setSelectedTier] = useState('piece');
  const [quantity, setQuantity] = useState(1);

  const hasRoomLot = product.room_lot_enabled && product.room_lot_quantity && product.room_lot_price;
  const hasPallet = product.pallet_enabled && product.pallet_quantity && product.pallet_price;
  const hasBulkPricing = hasRoomLot || hasPallet;

  // Get the current price based on selected tier
  const getCurrentPrice = () => {
    if (isClearance && product.clearance_price) {
      return product.clearance_price;
    }
    switch (selectedTier) {
      case 'room_lot':
        return product.room_lot_price;
      case 'pallet':
        return product.pallet_price;
      default:
        return product.price;
    }
  };

  // Get the quantity for selected tier
  const getTierQuantity = () => {
    switch (selectedTier) {
      case 'room_lot':
        return product.room_lot_quantity;
      case 'pallet':
        return product.pallet_quantity;
      default:
        return quantity;
    }
  };

  const handleAddToCart = () => {
    const qty = getTierQuantity();
    const price = getCurrentPrice();
    onAddToCart(product, qty, price, selectedTier);
  };

  // Calculate savings
  const getSavings = (tierPrice, tierQty) => {
    const regularTotal = product.price * tierQty;
    const tierTotal = tierPrice * tierQty;
    return regularTotal - tierTotal;
  };

  return (
    <Card 
      className={`p-4 hover:shadow-md duration-200 ${isClearance ? 'border-2 border-red-200 bg-red-50/30' : ''}`}
      data-testid={`product-card-${product.id}`}
    >
      <div className="space-y-3">
        {/* Product Image */}
        {product.images && product.images.length > 0 && (
          <div className="relative w-full h-48 bg-secondary rounded-md overflow-hidden">
            <img 
              src={normaliseImageUrl(product.images[0])} 
              alt={product.name}
              className="w-full h-full object-cover"
              onError={(e) => {
                e.target.style.display = 'none';
              }}
            />
            {product.images.length > 1 && (
              <div className="absolute bottom-2 right-2 bg-black/60 text-white text-xs px-2 py-1 rounded-full">
                +{product.images.length - 1} more
              </div>
            )}
            {isClearance && (
              <div className="absolute top-2 left-2 bg-red-600 text-white text-xs font-bold px-3 py-1 rounded-full">
                CLEARANCE
              </div>
            )}
            {hasBulkPricing && !isClearance && (
              <div className="absolute top-2 left-2 bg-blue-600 text-white text-xs font-bold px-2 py-1 rounded-full flex items-center gap-1">
                <Layers className="h-3 w-3" /> BULK DEALS
              </div>
            )}
          </div>
        )}

        {/* Product Info */}
        <div>
          <h3 className="font-heading font-bold tracking-tightest">{product.name}</h3>
          <p className="text-xs text-muted-foreground font-mono">{product.sku}</p>
          {product.category_name && (
            <Badge variant="secondary" className="mt-1 text-xs">{product.category_name}</Badge>
          )}
        </div>

        {product.description && (
          <p className="text-sm text-muted-foreground line-clamp-2">{product.description}</p>
        )}

        {/* Pricing Tiers (only show if not clearance) */}
        {hasBulkPricing && !isClearance && (
          <div className="space-y-2 pt-2 border-t border-border">
            <p className="text-xs font-medium text-muted-foreground">Select quantity:</p>
            <div className="grid gap-2">
              {/* Piece Price */}
              <button
                onClick={() => setSelectedTier('piece')}
                className={`flex items-center justify-between p-2 rounded-md border text-left transition-colors ${
                  selectedTier === 'piece' 
                    ? 'border-accent bg-accent/10' 
                    : 'border-border hover:border-accent/50'
                }`}
                data-testid={`tier-piece-${product.id}`}
              >
                <div className="flex items-center gap-2">
                  <Package className="h-4 w-4 text-muted-foreground" />
                  <span className="text-sm font-medium">Single Piece</span>
                </div>
                <span className="font-bold">£{safeToFixed(product.price, 2)}</span>
              </button>

              {/* Room Lot */}
              {hasRoomLot && (
                <button
                  onClick={() => setSelectedTier('room_lot')}
                  className={`flex items-center justify-between p-2 rounded-md border text-left transition-colors ${
                    selectedTier === 'room_lot' 
                      ? 'border-blue-500 bg-blue-50' 
                      : 'border-border hover:border-blue-300'
                  }`}
                  data-testid={`tier-room-lot-${product.id}`}
                >
                  <div className="flex items-center gap-2">
                    <Layers className="h-4 w-4 text-blue-600" />
                    <div>
                      <span className="text-sm font-medium text-blue-800">Room Lot</span>
                      <span className="text-xs text-blue-600 ml-1">({product.room_lot_quantity} pcs)</span>
                    </div>
                  </div>
                  <div className="text-right">
                    <span className="font-bold text-blue-700">£{safeToFixed(product.room_lot_price, 2)}</span>
                    <span className="text-xs text-blue-600">/pc</span>
                    <p className="text-xs text-green-600">
                      Save £{getSavings(product.room_lot_price, product.room_lot_quantity).toFixed(2)}
                    </p>
                  </div>
                </button>
              )}

              {/* Full Pallet */}
              {hasPallet && (
                <button
                  onClick={() => setSelectedTier('pallet')}
                  className={`flex items-center justify-between p-2 rounded-md border text-left transition-colors ${
                    selectedTier === 'pallet' 
                      ? 'border-green-500 bg-green-50' 
                      : 'border-border hover:border-green-300'
                  }`}
                  data-testid={`tier-pallet-${product.id}`}
                >
                  <div className="flex items-center gap-2">
                    <Truck className="h-4 w-4 text-green-600" />
                    <div>
                      <span className="text-sm font-medium text-green-800">Full Pallet</span>
                      <span className="text-xs text-green-600 ml-1">({product.pallet_quantity} pcs)</span>
                    </div>
                  </div>
                  <div className="text-right">
                    <span className="font-bold text-green-700">£{safeToFixed(product.pallet_price, 2)}</span>
                    <span className="text-xs text-green-600">/pc</span>
                    <p className="text-xs text-green-600">
                      Save £{getSavings(product.pallet_price, product.pallet_quantity).toFixed(2)}
                    </p>
                  </div>
                </button>
              )}
            </div>
          </div>
        )}

        {/* Price Display for non-bulk or clearance items */}
        {(!hasBulkPricing || isClearance) && (
          <div className="flex items-center justify-between pt-2">
            <div>
              {isClearance && product.clearance_price ? (
                <div>
                  <p className="text-sm line-through text-muted-foreground">£{safeToFixed(product.price, 2)}</p>
                  <p className={`text-2xl font-heading font-bold tracking-tightest tabular-nums ${isClearance ? 'text-red-600' : ''}`}>
                    £{safeToFixed(product.clearance_price, 2)}
                  </p>
                  <p className="text-xs text-red-600 font-medium">
                    Save £{(product.price - product.clearance_price).toFixed(2)}
                  </p>
                </div>
              ) : (
                <p className="text-2xl font-heading font-bold tracking-tightest tabular-nums">
                  £{safeToFixed(product.price, 2)}
                </p>
              )}
              <p className="text-xs text-muted-foreground">{product.stock} in stock</p>
              {product.m2_quantity && (
                <p className="text-xs text-accent font-medium">{safeToFixed(product.m2_quantity, 2)} m² per piece</p>
              )}
            </div>
            <Button 
              size="sm" 
              onClick={() => onAddToCart(product, 1, getCurrentPrice(), 'piece')}
              data-testid={`add-to-cart-${product.id}`}
              className={isClearance ? "bg-red-600 hover:bg-red-700 text-white" : "bg-accent hover:bg-accent/90"}
            >
              <Plus className="h-4 w-4 mr-1" /> Add
            </Button>
          </div>
        )}

        {/* Add to Cart for bulk pricing items */}
        {hasBulkPricing && !isClearance && (
          <div className="flex items-center justify-between pt-3 border-t border-border">
            <div>
              <p className="text-xs text-muted-foreground">{product.stock} in stock</p>
              {product.m2_quantity && (
                <p className="text-xs text-accent font-medium">{safeToFixed(product.m2_quantity, 2)} m² per piece</p>
              )}
              {selectedTier !== 'piece' && (
                <p className="text-sm font-medium mt-1">
                  Total: £{(getCurrentPrice() * getTierQuantity()).toFixed(2)}
                </p>
              )}
            </div>
            <Button 
              size="sm" 
              onClick={handleAddToCart}
              data-testid={`add-to-cart-${product.id}`}
              className="bg-accent hover:bg-accent/90"
            >
              <Plus className="h-4 w-4 mr-1" /> 
              {selectedTier === 'piece' ? 'Add' : `Add ${getTierQuantity()}`}
            </Button>
          </div>
        )}
      </div>
    </Card>
  );
};
