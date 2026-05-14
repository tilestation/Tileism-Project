import React, { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../lib/api';
import { ArrowRight, Truck, Shield, CreditCard, Store } from 'lucide-react';
import { Button } from '../../components/ui/button';
import { Card } from '../../components/ui/card';
import { Badge } from '../../components/ui/badge';
import { useTrustBadges } from '../../hooks/useTrustBadges';
import { firstImageUrl, imageUrl } from '../../utils/imageUrl';

export const ShopHome = () => {
  const [featuredProducts, setFeaturedProducts] = useState([]);
  const [categories, setCategories] = useState([]);
  const [loading, setLoading] = useState(true);
  const { badges: trustBadgeData } = useTrustBadges();

  useEffect(() => {
    fetchData();
  }, []);

  const fetchData = async () => {
    try {
      const [featuredRes, categoriesRes] = await Promise.all([
        api.shopGetFeatured(8),
        api.shopGetCategories()
      ]);
      setFeaturedProducts(featuredRes.data);
      setCategories(categoriesRes.data.filter(c => c.product_count > 0));
    } catch (error) {
      console.error('Failed to load shop data:', error);
    } finally {
      setLoading(false);
    }
  };

  const formatPrice = (price) => `£${price?.toFixed(2) || '0.00'}`;

  return (
    <div>
      {/* Hero Section */}
      <section className="relative bg-gradient-to-br from-slate-900 via-slate-800 to-slate-900 text-white overflow-hidden">
        <div className="absolute inset-0 bg-slate-800/30 opacity-30"></div>
        <div className="container mx-auto px-4 py-16 md:py-24 relative z-10">
          <div className="max-w-2xl">
            <Badge className="bg-amber-500 text-slate-900 mb-4">New Collection</Badge>
            <h1 className="text-4xl md:text-5xl lg:text-6xl font-bold mb-6 leading-tight">
              Transform Your Space with Premium Tiles
            </h1>
            <p className="text-lg md:text-xl text-slate-300 mb-8">
              Discover our curated collection of luxury tiles and bathroom products. 
              Quality craftsmanship at competitive prices.
            </p>
            <div className="flex flex-wrap gap-4">
              <Link to="/shop/products">
                <Button size="lg" className="bg-amber-500 hover:bg-amber-600 text-slate-900 font-semibold">
                  Shop Now
                  <ArrowRight className="ml-2 w-5 h-5" />
                </Button>
              </Link>
              <Link to="/shop/products?clearance_only=true">
                <Button size="lg" variant="outline" className="border-white text-white hover:bg-white hover:text-slate-900">
                  View Clearance
                </Button>
              </Link>
            </div>
          </div>
        </div>
      </section>

      {/* Features */}
      <section className="bg-white py-8 border-b">
        <div className="container mx-auto px-4">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 md:gap-8">
            <div className="flex items-center gap-3 p-4">
              <div className="w-12 h-12 bg-amber-100 rounded-full flex items-center justify-center flex-shrink-0">
                <Truck className="w-6 h-6 text-amber-600" />
              </div>
              <div>
                <p className="font-semibold text-slate-900">{trustBadgeData.delivery.title}</p>
                <p className="text-sm text-slate-500">{trustBadgeData.delivery.subtitle}</p>
              </div>
            </div>
            <div className="flex items-center gap-3 p-4">
              <div className="w-12 h-12 bg-amber-100 rounded-full flex items-center justify-center flex-shrink-0">
                <Store className="w-6 h-6 text-amber-600" />
              </div>
              <div>
                <p className="font-semibold text-slate-900">Click & Collect</p>
                <p className="text-sm text-slate-500">4 UK showrooms</p>
              </div>
            </div>
            <div className="flex items-center gap-3 p-4">
              <div className="w-12 h-12 bg-amber-100 rounded-full flex items-center justify-center flex-shrink-0">
                <Shield className="w-6 h-6 text-amber-600" />
              </div>
              <div>
                <p className="font-semibold text-slate-900">{trustBadgeData.quality.title}</p>
                <p className="text-sm text-slate-500">{trustBadgeData.quality.subtitle}</p>
              </div>
            </div>
            <div className="flex items-center gap-3 p-4">
              <div className="w-12 h-12 bg-amber-100 rounded-full flex items-center justify-center flex-shrink-0">
                <CreditCard className="w-6 h-6 text-amber-600" />
              </div>
              <div>
                <p className="font-semibold text-slate-900">{trustBadgeData.secure.title}</p>
                <p className="text-sm text-slate-500">{trustBadgeData.secure.subtitle}</p>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Categories */}
      {categories.length > 0 && (
        <section className="py-12 md:py-16 bg-gray-50">
          <div className="container mx-auto px-4">
            <div className="flex items-center justify-between mb-8">
              <h2 className="text-2xl md:text-3xl font-bold text-slate-900">Shop by Category</h2>
              <Link to="/shop/products" className="text-amber-600 hover:text-amber-700 font-medium flex items-center gap-1">
                View All <ArrowRight className="w-4 h-4" />
              </Link>
            </div>
            <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
              {categories.slice(0, 8).map((category) => (
                <Link
                  key={category.id}
                  to={`/shop/products?category_id=${category.id}`}
                  className="group"
                >
                  <Card className="p-6 text-center hover:shadow-lg transition-shadow bg-white">
                    <div className="w-16 h-16 bg-slate-100 rounded-full mx-auto mb-4 flex items-center justify-center group-hover:bg-amber-100 transition-colors">
                      <span className="text-2xl">🪨</span>
                    </div>
                    <h3 className="font-semibold text-slate-900 group-hover:text-amber-600 transition-colors">
                      {category.name}
                    </h3>
                    <p className="text-sm text-slate-500 mt-1">{category.product_count} products</p>
                  </Card>
                </Link>
              ))}
            </div>
          </div>
        </section>
      )}

      {/* Featured Products */}
      <section className="py-12 md:py-16">
        <div className="container mx-auto px-4">
          <div className="flex items-center justify-between mb-8">
            <h2 className="text-2xl md:text-3xl font-bold text-slate-900">Featured Products</h2>
            <Link to="/shop/products" className="text-amber-600 hover:text-amber-700 font-medium flex items-center gap-1">
              View All <ArrowRight className="w-4 h-4" />
            </Link>
          </div>
          
          {loading ? (
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              {[...Array(4)].map((_, i) => (
                <Card key={i} className="animate-pulse">
                  <div className="aspect-square bg-gray-200"></div>
                  <div className="p-4 space-y-2">
                    <div className="h-4 bg-gray-200 rounded w-3/4"></div>
                    <div className="h-4 bg-gray-200 rounded w-1/2"></div>
                  </div>
                </Card>
              ))}
            </div>
          ) : (
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              {featuredProducts.map((product) => (
                <Link key={product.id} to={`/shop/products/${product.id}`}>
                  <Card className="group overflow-hidden hover:shadow-lg transition-shadow">
                    <div className="aspect-square bg-gray-100 relative overflow-hidden">
                      {firstImageUrl(product.images) ? (
                        <img
                          src={firstImageUrl(product.images)}
                          alt={product.name}
                          className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
                        />
                      ) : (
                        <div className="w-full h-full flex items-center justify-center text-gray-400">
                          <span className="text-4xl">🪨</span>
                        </div>
                      )}
                      {product.clearance && (
                        <Badge className="absolute top-2 left-2 bg-red-500 text-white">Sale</Badge>
                      )}
                      {!product.in_stock && (
                        <div className="absolute inset-0 bg-black/50 flex items-center justify-center">
                          <Badge variant="secondary">Out of Stock</Badge>
                        </div>
                      )}
                    </div>
                    <div className="p-4">
                      <h3 className="font-medium text-slate-900 group-hover:text-amber-600 transition-colors line-clamp-2">
                        {product.name}
                      </h3>
                      <p className="text-sm text-slate-500 mt-1">{product.category_name}</p>
                      <div className="mt-2 flex items-center gap-2">
                        {product.clearance && product.clearance_price ? (
                          <>
                            <span className="font-bold text-red-600">{formatPrice(product.clearance_price)}</span>
                            <span className="text-sm text-slate-400 line-through">{formatPrice(product.price)}</span>
                          </>
                        ) : (
                          <span className="font-bold text-slate-900">{formatPrice(product.price)}</span>
                        )}
                        <span className="text-sm text-slate-500">/ {product.unit}</span>
                      </div>
                    </div>
                  </Card>
                </Link>
              ))}
            </div>
          )}
        </div>
      </section>

      {/* CTA Section */}
      <section className="bg-amber-500 py-12 md:py-16">
        <div className="container mx-auto px-4 text-center">
          <h2 className="text-2xl md:text-3xl font-bold text-slate-900 mb-4">
            Visit Our Showrooms
          </h2>
          <p className="text-slate-800 mb-8 max-w-2xl mx-auto">
            Experience our products in person at one of our 4 UK showrooms. 
            Our expert team is ready to help you find the perfect tiles for your project.
          </p>
          <Link to="/shop/contact">
            <Button size="lg" className="bg-slate-900 hover:bg-slate-800 text-white">
              Find a Store
              <ArrowRight className="ml-2 w-5 h-5" />
            </Button>
          </Link>
        </div>
      </section>
    </div>
  );
};

export default ShopHome;
