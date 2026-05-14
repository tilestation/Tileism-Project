import React, { useState, useRef, useCallback } from 'react';
import { Upload, RotateCcw, ZoomIn, ZoomOut, Move, Grid, Download, Image as ImageIcon, Layers } from 'lucide-react';
import { Button } from '../../components/ui/button';
import { toast } from 'sonner';
import { firstImageUrl, imageUrl } from '../../utils/imageUrl';

const API_URL = process.env.REACT_APP_BACKEND_URL;

// Sample tile patterns (can be extended with real product images)
const TILE_PATTERNS = [
  { id: 'marble-white', name: 'White Marble', color: '#f5f5f5', pattern: 'marble' },
  { id: 'grey-stone', name: 'Grey Stone', color: '#9ca3af', pattern: 'stone' },
  { id: 'terracotta', name: 'Terracotta', color: '#c2410c', pattern: 'solid' },
  { id: 'wood-oak', name: 'Oak Wood', color: '#92400e', pattern: 'wood' },
  { id: 'slate-dark', name: 'Dark Slate', color: '#374151', pattern: 'slate' },
  { id: 'beige-travertine', name: 'Beige Travertine', color: '#d4c4a8', pattern: 'travertine' },
];

const RoomVisualizer = () => {
  const [roomImage, setRoomImage] = useState(null);
  const [selectedTile, setSelectedTile] = useState(null);
  const [tileSize, setTileSize] = useState(50); // pixels
  const [tileOpacity, setTileOpacity] = useState(0.7);
  const [tileRotation, setTileRotation] = useState(0);
  const [groutColor, setGroutColor] = useState('#ffffff');
  const [groutWidth, setGroutWidth] = useState(2);
  const [floorRegion, setFloorRegion] = useState(null);
  const [isDrawing, setIsDrawing] = useState(false);
  const [products, setProducts] = useState([]);
  const [selectedProduct, setSelectedProduct] = useState(null);
  
  const canvasRef = useRef(null);
  const imageRef = useRef(null);
  const fileInputRef = useRef(null);

  // Fetch products with images for tile selection
  const fetchProducts = async () => {
    try {
      const res = await fetch(`${API_URL}/api/tiles/products?limit=20`);
      if (res.ok) {
        const data = await res.json();
        setProducts(data.products || []);
      }
    } catch (e) {
      console.log('Could not fetch products');
    }
  };

  React.useEffect(() => {
    fetchProducts();
  }, []);

  const handleImageUpload = (e) => {
    const file = e.target.files[0];
    if (!file) return;

    if (!file.type.startsWith('image/')) {
      toast.error('Please upload an image file');
      return;
    }

    const reader = new FileReader();
    reader.onload = (event) => {
      setRoomImage(event.target.result);
      setFloorRegion(null);
      toast.success('Room image uploaded! Now select a floor area.');
    };
    reader.readAsDataURL(file);
  };

  const drawTilePattern = useCallback(() => {
    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d');
    const img = imageRef.current;

    if (!img || !roomImage) return;

    // Set canvas size to match image
    canvas.width = img.naturalWidth || img.width;
    canvas.height = img.naturalHeight || img.height;

    // Draw the room image
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

    // If no tile selected or no floor region, just show the image
    if (!selectedTile && !selectedProduct) return;

    // Draw tile pattern on the entire floor area (simplified - full image for demo)
    const tileColor = selectedTile?.color || '#d4c4a8';
    const tileImage = selectedProduct?.images?.[0];

    ctx.globalAlpha = tileOpacity;
    ctx.save();

    // Create tile pattern
    const patternCanvas = document.createElement('canvas');
    const patternCtx = patternCanvas.getContext('2d');
    patternCanvas.width = tileSize + groutWidth;
    patternCanvas.height = tileSize + groutWidth;

    // Draw grout
    patternCtx.fillStyle = groutColor;
    patternCtx.fillRect(0, 0, patternCanvas.width, patternCanvas.height);

    // Draw tile
    if (tileImage) {
      const tileImg = new Image();
      tileImg.crossOrigin = 'anonymous';
      tileImg.src = tileImage;
      tileImg.onload = () => {
        patternCtx.drawImage(tileImg, 0, 0, tileSize, tileSize);
        const pattern = ctx.createPattern(patternCanvas, 'repeat');
        ctx.fillStyle = pattern;
        
        // Apply to lower half of image (floor area approximation)
        ctx.fillRect(0, canvas.height * 0.5, canvas.width, canvas.height * 0.5);
        ctx.restore();
        ctx.globalAlpha = 1;
      };
    } else {
      patternCtx.fillStyle = tileColor;
      patternCtx.fillRect(0, 0, tileSize, tileSize);

      // Add texture based on pattern type
      if (selectedTile?.pattern === 'marble') {
        patternCtx.strokeStyle = '#e5e5e5';
        patternCtx.lineWidth = 0.5;
        for (let i = 0; i < 3; i++) {
          patternCtx.beginPath();
          patternCtx.moveTo(Math.random() * tileSize, 0);
          patternCtx.lineTo(Math.random() * tileSize, tileSize);
          patternCtx.stroke();
        }
      } else if (selectedTile?.pattern === 'wood') {
        patternCtx.strokeStyle = '#78350f';
        patternCtx.lineWidth = 1;
        for (let i = 0; i < 5; i++) {
          patternCtx.beginPath();
          patternCtx.moveTo(0, i * (tileSize / 5));
          patternCtx.lineTo(tileSize, i * (tileSize / 5));
          patternCtx.stroke();
        }
      }

      const pattern = ctx.createPattern(patternCanvas, 'repeat');
      ctx.fillStyle = pattern;

      // Apply rotation
      if (tileRotation !== 0) {
        ctx.translate(canvas.width / 2, canvas.height * 0.75);
        ctx.rotate((tileRotation * Math.PI) / 180);
        ctx.translate(-canvas.width / 2, -canvas.height * 0.75);
      }

      // Apply to lower portion of image (floor area)
      ctx.fillRect(0, canvas.height * 0.4, canvas.width, canvas.height * 0.6);
    }

    ctx.restore();
    ctx.globalAlpha = 1;
  }, [roomImage, selectedTile, selectedProduct, tileSize, tileOpacity, tileRotation, groutColor, groutWidth]);

  // Redraw when settings change
  React.useEffect(() => {
    if (roomImage) {
      // Wait for image to load
      const img = imageRef.current;
      if (img && img.complete) {
        drawTilePattern();
      } else if (img) {
        img.onload = drawTilePattern;
      }
    }
  }, [roomImage, drawTilePattern]);

  const handleDownload = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const link = document.createElement('a');
    link.download = 'room-visualizer.png';
    link.href = canvas.toDataURL('image/png');
    link.click();
    toast.success('Image downloaded!');
  };

  const resetAll = () => {
    setRoomImage(null);
    setSelectedTile(null);
    setSelectedProduct(null);
    setTileSize(50);
    setTileOpacity(0.7);
    setTileRotation(0);
    setFloorRegion(null);
  };

  return (
    <div className="min-h-screen bg-gray-100" data-testid="room-visualizer">
      {/* Header */}
      <div className="bg-[#333333] text-white py-6">
        <div className="container mx-auto px-4">
          <h1 className="text-2xl md:text-3xl font-bold flex items-center gap-3">
            <Layers className="h-8 w-8 text-[#F7EA1C]" />
            Room Visualizer
          </h1>
          <p className="text-gray-300 mt-1">See how our tiles look in your space</p>
        </div>
      </div>

      <div className="container mx-auto px-4 py-8">
        <div className="grid grid-cols-1 lg:grid-cols-4 gap-6">
          {/* Controls Panel */}
          <div className="lg:col-span-1 space-y-6">
            {/* Upload */}
            <div className="bg-white rounded-xl shadow-sm p-4">
              <h3 className="font-semibold mb-3 flex items-center gap-2">
                <Upload className="h-5 w-5 text-amber-500" />
                Upload Room Photo
              </h3>
              <input
                type="file"
                ref={fileInputRef}
                onChange={handleImageUpload}
                accept="image/*"
                className="hidden"
              />
              <Button
                onClick={() => fileInputRef.current?.click()}
                className="w-full bg-amber-500 hover:bg-amber-600"
              >
                <ImageIcon className="h-4 w-4 mr-2" />
                Choose Photo
              </Button>
              {roomImage && (
                <Button
                  variant="outline"
                  onClick={resetAll}
                  className="w-full mt-2"
                >
                  <RotateCcw className="h-4 w-4 mr-2" />
                  Reset
                </Button>
              )}
            </div>

            {/* Tile Selection */}
            <div className="bg-white rounded-xl shadow-sm p-4">
              <h3 className="font-semibold mb-3 flex items-center gap-2">
                <Grid className="h-5 w-5 text-amber-500" />
                Select Tile
              </h3>
              
              {/* Pattern Tiles */}
              <p className="text-sm text-gray-500 mb-2">Pattern Tiles</p>
              <div className="grid grid-cols-3 gap-2 mb-4">
                {TILE_PATTERNS.map((tile) => (
                  <button
                    key={tile.id}
                    onClick={() => { setSelectedTile(tile); setSelectedProduct(null); }}
                    className={`aspect-square rounded-lg border-2 transition ${
                      selectedTile?.id === tile.id
                        ? 'border-amber-500 ring-2 ring-amber-200'
                        : 'border-gray-200 hover:border-gray-300'
                    }`}
                    style={{ backgroundColor: tile.color }}
                    title={tile.name}
                  />
                ))}
              </div>

              {/* Product Tiles */}
              {products.length > 0 && (
                <>
                  <p className="text-sm text-gray-500 mb-2">Our Products</p>
                  <div className="grid grid-cols-3 gap-2 max-h-40 overflow-y-auto">
                    {products.filter(p => firstImageUrl(p.images)).slice(0, 9).map((product) => (
                      <button
                        key={product.id}
                        onClick={() => { setSelectedProduct(product); setSelectedTile(null); }}
                        className={`aspect-square rounded-lg border-2 overflow-hidden transition ${
                          selectedProduct?.id === product.id
                            ? 'border-amber-500 ring-2 ring-amber-200'
                            : 'border-gray-200 hover:border-gray-300'
                        }`}
                        title={product.display_name || product.name}
                      >
                        <img
                          src={firstImageUrl(product.images)}
                          alt={product.name}
                          className="w-full h-full object-cover"
                        />
                      </button>
                    ))}
                  </div>
                </>
              )}
            </div>

            {/* Adjustments */}
            <div className="bg-white rounded-xl shadow-sm p-4">
              <h3 className="font-semibold mb-3">Adjustments</h3>
              
              <div className="space-y-4">
                <div>
                  <label className="text-sm text-gray-600">Tile Size: {tileSize}px</label>
                  <input
                    type="range"
                    min="20"
                    max="100"
                    value={tileSize}
                    onChange={(e) => setTileSize(parseInt(e.target.value))}
                    className="w-full"
                  />
                </div>

                <div>
                  <label className="text-sm text-gray-600">Opacity: {Math.round(tileOpacity * 100)}%</label>
                  <input
                    type="range"
                    min="0.3"
                    max="1"
                    step="0.1"
                    value={tileOpacity}
                    onChange={(e) => setTileOpacity(parseFloat(e.target.value))}
                    className="w-full"
                  />
                </div>

                <div>
                  <label className="text-sm text-gray-600">Rotation: {tileRotation}°</label>
                  <input
                    type="range"
                    min="0"
                    max="45"
                    step="15"
                    value={tileRotation}
                    onChange={(e) => setTileRotation(parseInt(e.target.value))}
                    className="w-full"
                  />
                </div>

                <div>
                  <label className="text-sm text-gray-600">Grout Width: {groutWidth}px</label>
                  <input
                    type="range"
                    min="0"
                    max="5"
                    value={groutWidth}
                    onChange={(e) => setGroutWidth(parseInt(e.target.value))}
                    className="w-full"
                  />
                </div>

                <div>
                  <label className="text-sm text-gray-600 block mb-1">Grout Color</label>
                  <div className="flex gap-2">
                    {['#ffffff', '#f5f5f5', '#d4d4d4', '#737373', '#262626'].map((color) => (
                      <button
                        key={color}
                        onClick={() => setGroutColor(color)}
                        className={`w-8 h-8 rounded border-2 ${
                          groutColor === color ? 'border-amber-500' : 'border-gray-300'
                        }`}
                        style={{ backgroundColor: color }}
                      />
                    ))}
                  </div>
                </div>
              </div>
            </div>

            {/* Download */}
            {roomImage && (
              <Button
                onClick={handleDownload}
                className="w-full bg-[#333333] hover:bg-[#444444] text-[#F7EA1C]"
              >
                <Download className="h-4 w-4 mr-2" />
                Download Image
              </Button>
            )}
          </div>

          {/* Preview Area */}
          <div className="lg:col-span-3">
            <div className="bg-white rounded-xl shadow-sm p-4 min-h-[500px]">
              {!roomImage ? (
                <div className="h-full flex flex-col items-center justify-center text-gray-400 py-20">
                  <ImageIcon className="h-16 w-16 mb-4 opacity-50" />
                  <p className="text-lg font-medium">Upload a room photo to get started</p>
                  <p className="text-sm mt-2">Take a photo of your room and see how our tiles would look</p>
                </div>
              ) : (
                <div className="relative">
                  {/* Hidden image for reference */}
                  <img
                    ref={imageRef}
                    src={roomImage}
                    alt="Room"
                    className="hidden"
                    crossOrigin="anonymous"
                  />
                  
                  {/* Canvas for visualization */}
                  <canvas
                    ref={canvasRef}
                    className="max-w-full h-auto rounded-lg shadow-lg mx-auto"
                  />

                  {/* Selected tile info */}
                  {(selectedTile || selectedProduct) && (
                    <div className="absolute bottom-4 left-4 bg-black/70 text-white px-4 py-2 rounded-lg">
                      <p className="text-sm font-medium">
                        {selectedProduct?.display_name || selectedProduct?.name || selectedTile?.name}
                      </p>
                      {selectedProduct?.price && (
                        <p className="text-xs text-amber-400">£{selectedProduct.price}/m²</p>
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* Tips */}
            <div className="mt-4 bg-amber-50 border border-amber-200 rounded-lg p-4">
              <h4 className="font-medium text-amber-800 mb-2">Tips for best results:</h4>
              <ul className="text-sm text-amber-700 space-y-1">
                <li>• Take photos with the floor clearly visible</li>
                <li>• Use good lighting for accurate color representation</li>
                <li>• Adjust opacity to blend tiles naturally with your photo</li>
                <li>• Try different tile sizes to match your room scale</li>
              </ul>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default RoomVisualizer;
