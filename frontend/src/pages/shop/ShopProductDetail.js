import React, { useState, useEffect } from 'react';
import { useParams, Link } from 'react-router-dom';
import { api } from '../../lib/api';
import { ShoppingCart, Heart, Minus, Plus, ChevronLeft, Truck, Store, Shield, FileText, Download } from 'lucide-react';
import { Button } from '../../components/ui/button';
import { Card } from '../../components/ui/card';
import { Badge } from '../../components/ui/badge';
import { Input } from '../../components/ui/input';
import { useShopAuth } from '../../contexts/ShopAuthContext';
import { useTradeUser } from '../../hooks/useTradeUser';
import RenderProductDescription from '../../components/shop/RenderProductDescription';
import { TradeLoginBox } from '../../components/shop/TradeLoginPrompt';
import { toast } from 'sonner';
import { TileCalculator } from '../../components/shop/TileCalculator';
import { safeToFixed } from '../../utils/safeStr';

const API_URL = process.env.REACT_APP_BACKEND_URL;

export const ShopProductDetail = () => {
  const { isTrade, getTradePrice } = useTradeUser();
  const { productId } = useParams();
  const [product, setProduct] = useState(null);
  const [loading, setLoading] = useState(true);
  const [quantity, setQuantity] = useState(1);
  const [selectedImage, setSelectedImage] = useState(0);
  const [productDocuments, setProductDocuments] = useState([]);
  const { addToCart, isAuthenticated } = useShopAuth();

  useEffect(() => {
    fetchProduct();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [productId]);

  const fetchProduct = async () => {
    try {
      const response = await api.shopGetProduct(productId);
      setProduct(response.data);
      // Fetch attached documents
      const p = response.data;
      const docIdentifier = p?.sku || p?.supplier_code;
      if (p?.supplier_name && docIdentifier) {
        try {
          const docsRes = await api.getProductDocuments(p.supplier_name, docIdentifier);
          setProductDocuments(docsRes.data || []);
        } catch (e) {
          // Silently fail — documents are optional
        }
      }
    } catch (error) {
      console.error('Failed to load product:', error);
      toast.error('Product not found');
    } finally {
      setLoading(false);
    }
  };

  const handleAddToCart = async () => {
    if (!product.in_stock) {
      toast.error('This product is out of stock');
      return;
    }

    try {
      await addToCart({
        product_id: product.id,
        name: product.name,
        sku: product.sku,
        price: product.clearance && product.clearance_price ? product.clearance_price : product.price,
        quantity: quantity,
        image: product.images?.[0] || ''
      });
      toast.success(`${quantity}x ${product.name} added to cart`);
    } catch (error) {
      toast.error('Failed to add to cart');
    }
  };

  const formatPrice = (price) => `£${(isTrade ? getTradePrice(price) : price)?.toFixed(2) || '0.00'}`;

  const currentPrice = product?.clearance && product?.clearance_price ? product.clearance_price : product?.price;

  if (loading) {
    return (
      <div className="container mx-auto px-4 py-8">
        <div className="animate-pulse">
          <div className="h-6 bg-gray-200 rounded w-32 mb-8"></div>
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
            <div className="aspect-square bg-gray-200 rounded-lg"></div>
            <div className="space-y-4">
              <div className="h-8 bg-gray-200 rounded w-3/4"></div>
              <div className="h-6 bg-gray-200 rounded w-1/2"></div>
              <div className="h-20 bg-gray-200 rounded"></div>
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (!product) {
    return (
      <div className="container mx-auto px-4 py-16 text-center">
        <h1 className="text-2xl font-bold text-slate-900 mb-4">Product Not Found</h1>
        <Link to="/shop/products">
          <Button>Back to Products</Button>
        </Link>
      </div>
    );
  }

  return (
    <div className="container mx-auto px-4 py-8">
      {/* Breadcrumb */}
      <nav className="flex items-center gap-2 text-sm text-slate-500 mb-8">
        <Link to="/shop" className="hover:text-amber-600">Home</Link>
        <span>/</span>
        <Link to="/shop/products" className="hover:text-amber-600">Products</Link>
        <span>/</span>
        <span className="text-slate-900">{product.name}</span>
      </nav>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-8 lg:gap-12">
        {/* Product Images */}
        <div className="space-y-4">
          <div className="aspect-square bg-gray-100 rounded-lg overflow-hidden relative">
            {product.images?.[selectedImage] ? (
              <img
                src={product.images[selectedImage]}
                alt={product.name}
                className="w-full h-full object-cover"
              />
            ) : (
              <div className="w-full h-full flex items-center justify-center text-gray-400">
                <span className="text-8xl">🪨</span>
              </div>
            )}
            {product.clearance && (
              <Badge className="absolute top-4 left-4 bg-red-500 text-white text-lg px-3 py-1">
                Sale
              </Badge>
            )}
          </div>
          
          {/* Thumbnail Images */}
          {product.images?.length > 1 && (
            <div className="flex gap-2 overflow-x-auto pb-2">
              {product.images.map((img, idx) => (
                <button
                  key={idx}
                  onClick={() => setSelectedImage(idx)}
                  className={`w-20 h-20 flex-shrink-0 rounded-lg overflow-hidden border-2 transition-colors ${
                    selectedImage === idx ? 'border-amber-500' : 'border-transparent'
                  }`}
                >
                  <img src={img} alt="" className="w-full h-full object-cover" />
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Product Info */}
        <div>
          <div className="mb-4">
            <p className="text-sm text-slate-500 mb-1">SKU: {product.sku}</p>
            <h1 className="text-2xl md:text-3xl font-bold text-slate-900">{product.name}</h1>
            {product.category_name && (
              <Link
                to={`/shop/products?category_id=${product.category_id}`}
                className="text-amber-600 hover:text-amber-700 text-sm mt-1 inline-block"
              >
                {product.category_name}
              </Link>
            )}
          </div>

          {/* Price */}
          <div className="mb-6">
            {product.clearance && product.clearance_price ? (() => {
              const wasPrice = isTrade ? product.price / 1.20 : product.price;
              const nowPrice = isTrade ? product.clearance_price / 1.20 : product.clearance_price;
              const totalSavings = Math.max(0, wasPrice - nowPrice);
              const totalOffPercent = wasPrice > 0 ? Math.round((totalSavings / wasPrice) * 100) : 0;

              return (
                <div data-testid="sale-price-ribbon">
                  <div className="rounded-2xl overflow-hidden" style={{ background: 'linear-gradient(135deg, #ef4444 0%, #dc2626 50%, #b91c1c 100%)' }}>
                    <div className="px-6 py-5 flex items-center justify-between">
                      <div>
                        <div className="text-red-200 text-xs font-bold uppercase tracking-widest mb-1">Sale Price</div>
                        <div className="flex items-baseline gap-3">
                          <span className="text-white/60 text-base line-through">WAS £{safeToFixed(wasPrice, 2)}</span>
                          <span className="text-white text-3xl font-black tracking-tight">NOW £{safeToFixed(nowPrice, 2)}</span>
                          <span className="text-white/70 text-sm font-medium">/{product.unit}</span>
                          {isTrade && <span className="text-white/50 text-xs">ex. VAT</span>}
                        </div>
                      </div>
                      {totalSavings > 0 && (
                        <div className="bg-white rounded-xl px-4 py-3 text-center shadow-lg min-w-[90px]">
                          <div className="text-red-600 text-lg font-black leading-tight">SAVE £{totalSavings.toFixed(2)}</div>
                          {totalOffPercent > 0 && <div className="text-gray-500 text-xs font-bold mt-0.5">{totalOffPercent}% OFF</div>}
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              );
            })() : (
              <span className="text-3xl font-bold text-slate-900">{formatPrice(product.price)}</span>
            )}
            <p className="text-slate-500 mt-2">per {product.unit}</p>
          </div>

          {/* Trade Customer Box - PROTECTED COMPONENT */}
          <div className="mb-6">
            <TradeLoginBox isLoggedIn={isTrade} />
          </div>

          {/* Stock Status */}
          <div className="mb-6">
            {product.in_stock ? (
              <div className="flex items-center gap-2 text-green-600">
                <span className="w-2 h-2 bg-green-500 rounded-full"></span>
                <span>In Stock ({product.stock} available)</span>
              </div>
            ) : (
              <div className="flex items-center gap-2 text-red-600">
                <span className="w-2 h-2 bg-red-500 rounded-full"></span>
                <span>Out of Stock</span>
              </div>
            )}
          </div>

          {/* Tile Info */}
          {(product.tile_width || product.tile_height || product.tiles_per_box) && (
            <Card className="p-4 mb-6 bg-slate-50">
              <h3 className="font-semibold mb-3">Tile Specifications</h3>
              <div className="grid grid-cols-2 gap-3 text-sm">
                {product.tile_width && product.tile_height && (
                  <div>
                    <span className="text-slate-500">Size:</span>
                    <span className="ml-2 font-medium">{product.tile_width} x {product.tile_height}mm</span>
                  </div>
                )}
                {product.tile_m2_per_piece && (
                  <div>
                    <span className="text-slate-500">m² per tile:</span>
                    <span className="ml-2 font-medium">{product.tile_m2_per_piece}m²</span>
                  </div>
                )}
                {product.tiles_per_box && (
                  <div>
                    <span className="text-slate-500">Tiles per box:</span>
                    <span className="ml-2 font-medium">{product.tiles_per_box}</span>
                  </div>
                )}
                {product.box_m2_coverage && (
                  <div>
                    <span className="text-slate-500">Box coverage:</span>
                    <span className="ml-2 font-medium">{product.box_m2_coverage}m²</span>
                  </div>
                )}
              </div>
            </Card>
          )}

          {/* Tile Calculator */}
          <div className="mb-6">
            <TileCalculator 
              product={product} 
              onAddToCart={(qty) => {
                setQuantity(qty);
                toast.success(`Quantity set to ${qty}`);
              }} 
            />
          </div>

          {/* Quantity & Add to Cart */}
          {product.in_stock && (
            <div className="flex flex-col sm:flex-row gap-4 mb-6">
              <div className="flex items-center border rounded-lg">
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => setQuantity(Math.max(1, quantity - 1))}
                  disabled={quantity <= 1}
                >
                  <Minus className="w-4 h-4" />
                </Button>
                <Input
                  type="number"
                  value={quantity}
                  onChange={(e) => setQuantity(Math.max(1, Math.min(product.stock, parseInt(e.target.value) || 1)))}
                  className="w-16 text-center border-0"
                  min="1"
                  max={product.stock}
                />
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => setQuantity(Math.min(product.stock, quantity + 1))}
                  disabled={quantity >= product.stock}
                >
                  <Plus className="w-4 h-4" />
                </Button>
              </div>
              
              <Button
                size="lg"
                className="flex-1 bg-amber-500 hover:bg-amber-600 text-slate-900 font-semibold"
                onClick={handleAddToCart}
              >
                <ShoppingCart className="w-5 h-5 mr-2" />
                Add to Cart - {formatPrice(currentPrice * quantity)}
              </Button>
            </div>
          )}

          {/* Description */}
          {product.description && (
            <div className="mb-6">
              <h3 className="font-semibold mb-2">Description</h3>
              <RenderProductDescription
                text={product.description}
                className="text-slate-600"
              />
            </div>
          )}

          {/* Features */}
          <div className="border-t pt-6 space-y-3">
            <div className="flex items-center gap-3 text-sm">
              <Truck className="w-5 h-5 text-amber-600" />
              <span>Free delivery on orders over £499</span>
            </div>
            <div className="flex items-center gap-3 text-sm">
              <Store className="w-5 h-5 text-amber-600" />
              <span>Click & collect from our showrooms</span>
            </div>
            <div className="flex items-center gap-3 text-sm">
              <Shield className="w-5 h-5 text-amber-600" />
              <span>Quality guaranteed</span>
            </div>
          </div>
        </div>
      </div>

      {/* Related Downloads - only show when documents exist */}
      {productDocuments.length > 0 && (
        <div className="mt-8 bg-gray-100 rounded-lg p-6" data-testid="related-downloads">
          <h3 className="text-lg font-bold text-gray-800 uppercase tracking-wide mb-4">
            Related Downloads
          </h3>
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-4">
            {productDocuments.map(doc => (
              <a
                key={doc.id}
                href={`${API_URL}/api/product-documents/${doc.id}/download`}
                target="_blank"
                rel="noopener noreferrer"
                className="group flex flex-col items-center p-4 bg-white border border-gray-200 rounded-lg hover:border-gray-400 hover:shadow-sm transition cursor-pointer"
                data-testid={`download-doc-${doc.id}`}
              >
                {/* PDF Icon */}
                <div className="w-16 h-20 mb-3 relative flex items-center justify-center">
                  <svg viewBox="0 0 60 72" className="w-full h-full">
                    <path d="M0 4C0 1.8 1.8 0 4 0H38L56 18V68C56 70.2 54.2 72 52 72H4C1.8 72 0 70.2 0 68V4Z" fill="#E5E7EB" />
                    <path d="M38 0L56 18H42C39.8 18 38 16.2 38 14V0Z" fill="#D1D5DB" />
                    <rect x="8" y="38" width="40" height="14" rx="2" fill="#DC2626" />
                    <text x="28" y="49" textAnchor="middle" fill="white" fontSize="10" fontWeight="bold" fontFamily="Arial, sans-serif">PDF</text>
                  </svg>
                </div>
                {/* Document name */}
                <p className="text-xs text-center text-gray-700 font-medium leading-tight group-hover:text-gray-900 line-clamp-2">
                  {(doc.display_name || doc.original_filename || '').replace(/^[a-f0-9]{20,}_/i, '')}
                </p>
              </a>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};

export default ShopProductDetail;
