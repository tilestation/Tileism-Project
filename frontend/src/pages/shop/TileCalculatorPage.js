import React, { useState, useEffect } from 'react';
import { Calculator, Info, ArrowRight, Ruler, Square, Home, Bath, ChefHat, Bed } from 'lucide-react';
import { Link } from 'react-router-dom';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { Label } from '../../components/ui/label';
import { toast } from 'sonner';
import { firstImageUrl, imageUrl } from '../../utils/imageUrl';

const API_URL = process.env.REACT_APP_BACKEND_URL;

// Room presets for quick selection
const ROOM_PRESETS = [
  { name: 'Small Bathroom', length: 2.5, width: 2, icon: Bath, wastage: 15 },
  { name: 'Large Bathroom', length: 3.5, width: 3, icon: Bath, wastage: 12 },
  { name: 'Kitchen', length: 4, width: 3.5, icon: ChefHat, wastage: 10 },
  { name: 'Living Room', length: 5, width: 4, icon: Home, wastage: 10 },
  { name: 'Bedroom', length: 4, width: 3.5, icon: Bed, wastage: 10 },
  { name: 'Hallway', length: 6, width: 1.2, icon: Square, wastage: 15 },
];

const TileCalculatorPage = () => {
  const [roomLength, setRoomLength] = useState('');
  const [roomWidth, setRoomWidth] = useState('');
  const [wastage, setWastage] = useState(10);
  const [result, setResult] = useState(null);
  const [selectedProduct, setSelectedProduct] = useState(null);
  const [products, setProducts] = useState([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [loading, setLoading] = useState(false);
  const [selectedPreset, setSelectedPreset] = useState(null);

  useEffect(() => {
    // Fetch some products to show
    const fetchProducts = async () => {
      try {
        const res = await fetch(`${API_URL}/api/tiles/?limit=20`);
        const data = await res.json();
        setProducts(data.products || data || []);
      } catch (e) {
        console.error('Failed to fetch products:', e);
      }
    };
    fetchProducts();
  }, []);

  const searchProducts = async (query) => {
    if (query.length < 2) return;
    try {
      const res = await fetch(`${API_URL}/api/tiles/search?q=${encodeURIComponent(query)}&limit=10`);
      const data = await res.json();
      setProducts(data);
    } catch (e) {
      console.error('Search error:', e);
    }
  };

  const applyPreset = (preset) => {
    setRoomLength(preset.length.toString());
    setRoomWidth(preset.width.toString());
    setWastage(preset.wastage);
    setSelectedPreset(preset.name);
    toast.success(`Applied ${preset.name} dimensions`);
  };

  const handleCalculate = () => {
    if (!roomLength || !roomWidth) {
      toast.error('Please enter room dimensions');
      return;
    }

    const length = parseFloat(roomLength);
    const width = parseFloat(roomWidth);
    const area = length * width;
    const wastageMultiplier = 1 + (wastage / 100);
    const totalArea = area * wastageMultiplier;
    const wastageArea = totalArea - area;

    // Calculate boxes needed if we have a product selected
    let boxesNeeded = null;
    let totalCost = null;
    let pricePerM2 = null;
    
    if (selectedProduct) {
      const m2PerBox = selectedProduct.box_m2_coverage || selectedProduct.m2_per_box || 1;
      boxesNeeded = Math.ceil(totalArea / m2PerBox);
      pricePerM2 = selectedProduct.room_lot_price || selectedProduct.price || 0;
      totalCost = totalArea * pricePerM2;
    }

    setResult({
      roomArea: area.toFixed(2),
      totalWithWastage: totalArea.toFixed(2),
      wastageArea: wastageArea.toFixed(2),
      wastagePercent: wastage,
      boxesNeeded,
      totalCost: totalCost?.toFixed(2),
      pricePerM2: pricePerM2?.toFixed(2),
      product: selectedProduct
    });
  };

  return (
    <div className="min-h-screen bg-gray-50" data-testid="tile-calculator-page">
      {/* Header */}
      <div className="bg-[#333333] text-white py-8">
        <div className="container mx-auto px-4">
          <div className="flex items-center gap-3 mb-2">
            <Calculator className="w-8 h-8 text-[#F7EA1C]" />
            <h1 className="text-2xl md:text-3xl font-bold">Tile Calculator</h1>
          </div>
          <p className="text-gray-300">Calculate how many tiles you need for your project</p>
        </div>
      </div>

      <div className="container mx-auto px-4 py-8">
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
          {/* Calculator Form */}
          <div className="lg:col-span-2">
            <div className="bg-white rounded-xl shadow-sm p-6">
              <h2 className="text-lg font-semibold mb-6 flex items-center gap-2">
                <Ruler className="w-5 h-5" />
                Room Dimensions
              </h2>

              {/* Room Presets */}
              <div className="mb-6">
                <Label className="mb-3 block">Quick Select Room Type</Label>
                <div className="grid grid-cols-3 md:grid-cols-6 gap-2">
                  {ROOM_PRESETS.map((preset) => (
                    <button
                      key={preset.name}
                      onClick={() => applyPreset(preset)}
                      className={`p-3 rounded-lg border text-center transition-all ${
                        selectedPreset === preset.name
                          ? 'border-amber-500 bg-amber-50 text-amber-700'
                          : 'border-gray-200 hover:border-amber-300 hover:bg-amber-50/50'
                      }`}
                    >
                      <preset.icon className="h-5 w-5 mx-auto mb-1" />
                      <span className="text-xs font-medium block">{preset.name}</span>
                      <span className="text-[10px] text-gray-500">{preset.length}m × {preset.width}m</span>
                    </button>
                  ))}
                </div>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mb-6">
                <div>
                  <Label htmlFor="length">Room Length (meters)</Label>
                  <Input
                    id="length"
                    type="number"
                    step="0.01"
                    value={roomLength}
                    onChange={(e) => setRoomLength(e.target.value)}
                    placeholder="e.g., 4.5"
                    className="mt-1"
                  />
                </div>
                <div>
                  <Label htmlFor="width">Room Width (meters)</Label>
                  <Input
                    id="width"
                    type="number"
                    step="0.01"
                    value={roomWidth}
                    onChange={(e) => setRoomWidth(e.target.value)}
                    placeholder="e.g., 3.2"
                    className="mt-1"
                  />
                </div>
              </div>

              <div className="mb-6">
                <Label htmlFor="wastage">Wastage Allowance: {wastage}%</Label>
                <input
                  id="wastage"
                  type="range"
                  min="5"
                  max="20"
                  value={wastage}
                  onChange={(e) => setWastage(parseInt(e.target.value))}
                  className="w-full mt-2"
                />
                <div className="flex justify-between text-xs text-gray-500 mt-1">
                  <span>5% (Simple rooms)</span>
                  <span>20% (Complex patterns)</span>
                </div>
              </div>

              {/* Product Selection */}
              <div className="mb-6">
                <Label>Select a Tile (Optional)</Label>
                <Input
                  type="text"
                  placeholder="Search for a tile..."
                  value={searchQuery}
                  onChange={(e) => {
                    setSearchQuery(e.target.value);
                    searchProducts(e.target.value);
                  }}
                  className="mt-1 mb-3"
                />
                
                <div className="grid grid-cols-2 md:grid-cols-4 gap-3 max-h-48 overflow-y-auto">
                  {products.slice(0, 8).map((product) => (
                    <button
                      key={product.id}
                      onClick={() => setSelectedProduct(product)}
                      className={`p-2 rounded-lg border text-left transition-all ${
                        selectedProduct?.id === product.id 
                          ? 'border-amber-500 bg-amber-50' 
                          : 'border-gray-200 hover:border-gray-300'
                      }`}
                    >
                      <img 
                        src={firstImageUrl(product.images) || 'https://via.placeholder.com/100'} 
                        alt={product.name}
                        className="w-full h-16 object-cover rounded mb-1"
                      />
                      <p className="text-xs font-medium truncate">{product.website_name || product.name}</p>
                      <p className="text-xs text-gray-500">£{(product.room_lot_price || product.price || 0).toFixed(2)}/m²</p>
                    </button>
                  ))}
                </div>
              </div>

              <Button 
                onClick={handleCalculate}
                className="w-full bg-[#333333] hover:bg-[#444444] text-[#F7EA1C]"
              >
                <Calculator className="w-4 h-4 mr-2" />
                Calculate
              </Button>
            </div>
          </div>

          {/* Results Panel */}
          <div className="lg:col-span-1">
            <div className="bg-white rounded-xl shadow-sm p-6 sticky top-24">
              <h2 className="text-lg font-semibold mb-4">Results</h2>
              
              {result ? (
                <div className="space-y-4">
                  <div className="p-4 bg-gray-50 rounded-lg">
                    <p className="text-sm text-gray-500">Room Area</p>
                    <p className="text-2xl font-bold">{result.roomArea} m²</p>
                  </div>
                  
                  <div className="p-4 bg-amber-50 rounded-lg border border-amber-200">
                    <p className="text-sm text-amber-700">Total with {result.wastagePercent}% Wastage</p>
                    <p className="text-2xl font-bold text-amber-700">{result.totalWithWastage} m²</p>
                  </div>

                  {result.boxesNeeded && (
                    <div className="p-4 bg-green-50 rounded-lg border border-green-200">
                      <p className="text-sm text-green-700">Boxes Needed</p>
                      <p className="text-2xl font-bold text-green-700">{result.boxesNeeded} boxes</p>
                    </div>
                  )}

                  {result.totalCost && (
                    <div className="p-4 bg-slate-900 rounded-lg text-white">
                      <p className="text-sm text-gray-300">Estimated Cost</p>
                      <p className="text-2xl font-bold">£{result.totalCost}</p>
                      <p className="text-xs text-gray-400 mt-1">Based on {result.product?.website_name || result.product?.name}</p>
                    </div>
                  )}

                  {result.product && (
                    <Link 
                      to={`/tiles/${result.product.slug || result.product.id}`}
                      className="block w-full text-center bg-[#333333] hover:bg-[#444444] text-[#F7EA1C] font-semibold py-3 rounded-lg transition-colors"
                    >
                      View Product <ArrowRight className="inline w-4 h-4 ml-1" />
                    </Link>
                  )}
                </div>
              ) : (
                <div className="text-center py-8 text-gray-500">
                  <Calculator className="w-12 h-12 mx-auto mb-3 opacity-30" />
                  <p>Enter your room dimensions to calculate how much tile you need.</p>
                </div>
              )}

              {/* Tips */}
              <div className="mt-6 pt-6 border-t">
                <h3 className="font-medium text-sm mb-3 flex items-center gap-2">
                  <Info className="w-4 h-4" />
                  Tips
                </h3>
                <ul className="text-xs text-gray-500 space-y-2">
                  <li>• Add 10% wastage for rectangular rooms</li>
                  <li>• Add 15-20% for diagonal patterns or complex layouts</li>
                  <li>• Always round up to the nearest full box</li>
                  <li>• Keep spare tiles for future repairs</li>
                </ul>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default TileCalculatorPage;
