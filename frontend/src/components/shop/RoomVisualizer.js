import React, { useState, useRef, useEffect, useCallback } from 'react';
import { Upload, RotateCcw, Layers, Download, X, ZoomIn, ZoomOut, Move, Eye } from 'lucide-react';
import { Button } from '../ui/button';
import { toast } from 'sonner';
import { firstImageUrl, imageUrl } from '../../utils/imageUrl';

const RoomVisualizer = ({ tile, onClose }) => {
  const canvasRef = useRef(null);
  const fileInputRef = useRef(null);
  
  const [roomImage, setRoomImage] = useState(null);
  const [isLoading, setIsLoading] = useState(false);
  const [overlayOpacity, setOverlayOpacity] = useState(0.6);
  const [tileScale, setTileScale] = useState(1);
  const [tileRotation, setTileRotation] = useState(0);
  const [overlayOffset, setOverlayOffset] = useState({ x: 0, y: 0 });
  const [isDragging, setIsDragging] = useState(false);
  const [dragStart, setDragStart] = useState({ x: 0, y: 0 });
  const [showOverlay, setShowOverlay] = useState(true);
  const [tilePattern, setTilePattern] = useState(null);

  // Load tile pattern from the tile image
  useEffect(() => {
    if (tile?.images?.[0]) {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => {
        setTilePattern(img);
      };
      img.onerror = () => {
        console.log('Could not load tile image for pattern');
      };
      img.src = firstImageUrl(tile.images);
    }
  }, [tile]);

  // Handle file upload
  const handleFileChange = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;

    if (!file.type.startsWith('image/')) {
      toast.error('Please upload an image file');
      return;
    }

    setIsLoading(true);
    const reader = new FileReader();
    reader.onload = (event) => {
      const img = new Image();
      img.onload = () => {
        setRoomImage(img);
        setIsLoading(false);
        toast.success('Room image loaded! Drag on the canvas to position the tile overlay.');
      };
      img.src = event.target.result;
    };
    reader.readAsDataURL(file);
  };

  // Draw on canvas
  const drawCanvas = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    const containerWidth = canvas.parentElement?.clientWidth || 800;
    const containerHeight = 500;

    // Set canvas size
    canvas.width = containerWidth;
    canvas.height = containerHeight;

    // Clear canvas
    ctx.fillStyle = '#f3f4f6';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    if (roomImage) {
      // Calculate aspect ratio to fit image in canvas
      const imgAspect = roomImage.width / roomImage.height;
      const canvasAspect = canvas.width / canvas.height;
      
      let drawWidth, drawHeight, drawX, drawY;
      
      if (imgAspect > canvasAspect) {
        drawWidth = canvas.width;
        drawHeight = canvas.width / imgAspect;
        drawX = 0;
        drawY = (canvas.height - drawHeight) / 2;
      } else {
        drawHeight = canvas.height;
        drawWidth = canvas.height * imgAspect;
        drawX = (canvas.width - drawWidth) / 2;
        drawY = 0;
      }

      // Draw room image
      ctx.drawImage(roomImage, drawX, drawY, drawWidth, drawHeight);

      // Draw tile overlay if enabled and pattern exists
      if (showOverlay && tilePattern) {
        ctx.save();
        ctx.globalAlpha = overlayOpacity;
        
        // Create tiled pattern
        const patternCanvas = document.createElement('canvas');
        const patternCtx = patternCanvas.getContext('2d');
        const tileSize = 100 * tileScale; // Base tile size
        
        patternCanvas.width = tileSize;
        patternCanvas.height = tileSize;
        
        // Apply rotation to pattern
        patternCtx.translate(tileSize / 2, tileSize / 2);
        patternCtx.rotate((tileRotation * Math.PI) / 180);
        patternCtx.translate(-tileSize / 2, -tileSize / 2);
        patternCtx.drawImage(tilePattern, 0, 0, tileSize, tileSize);
        
        const pattern = ctx.createPattern(patternCanvas, 'repeat');
        
        // Define overlay area (lower portion of room - typically floor area)
        const overlayY = drawY + drawHeight * 0.5 + overlayOffset.y;
        const overlayHeight = drawHeight * 0.5;
        
        // Draw overlay region
        ctx.beginPath();
        ctx.rect(
          drawX + overlayOffset.x,
          overlayY,
          drawWidth,
          overlayHeight
        );
        ctx.clip();
        
        ctx.fillStyle = pattern;
        ctx.translate(overlayOffset.x % tileSize, overlayOffset.y % tileSize);
        ctx.fillRect(drawX, drawY, drawWidth * 2, drawHeight * 2);
        
        ctx.restore();
      }
    } else {
      // Show placeholder
      ctx.fillStyle = '#9ca3af';
      ctx.font = '16px system-ui';
      ctx.textAlign = 'center';
      ctx.fillText('Upload a room photo to visualize tiles', canvas.width / 2, canvas.height / 2 - 10);
      ctx.fillText('Click "Upload Room Photo" above', canvas.width / 2, canvas.height / 2 + 20);
    }
  }, [roomImage, tilePattern, showOverlay, overlayOpacity, tileScale, tileRotation, overlayOffset]);

  // Redraw canvas when dependencies change
  useEffect(() => {
    drawCanvas();
  }, [drawCanvas]);

  // Handle mouse events for dragging
  const handleMouseDown = (e) => {
    if (!roomImage) return;
    setIsDragging(true);
    setDragStart({ x: e.clientX - overlayOffset.x, y: e.clientY - overlayOffset.y });
  };

  const handleMouseMove = (e) => {
    if (!isDragging) return;
    setOverlayOffset({
      x: e.clientX - dragStart.x,
      y: e.clientY - dragStart.y
    });
  };

  const handleMouseUp = () => {
    setIsDragging(false);
  };

  // Download the visualization
  const handleDownload = () => {
    const canvas = canvasRef.current;
    if (!canvas || !roomImage) {
      toast.error('Please upload a room image first');
      return;
    }

    const link = document.createElement('a');
    link.download = `room-visualization-${tile?.name || 'tile'}.png`;
    link.href = canvas.toDataURL('image/png');
    link.click();
    toast.success('Image downloaded!');
  };

  // Reset to defaults
  const handleReset = () => {
    setOverlayOpacity(0.6);
    setTileScale(1);
    setTileRotation(0);
    setOverlayOffset({ x: 0, y: 0 });
    setShowOverlay(true);
  };

  return (
    <div className="fixed inset-0 bg-black/80 z-50 flex items-center justify-center p-4" data-testid="room-visualizer">
      <div className="bg-white rounded-xl max-w-5xl w-full max-h-[90vh] overflow-hidden shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b bg-gray-50">
          <div className="flex items-center gap-3">
            <div className="p-2 bg-amber-100 rounded-lg">
              <Layers className="h-5 w-5 text-amber-600" />
            </div>
            <div>
              <h2 className="font-bold text-gray-900">Room Visualizer</h2>
              <p className="text-sm text-gray-500">See how {tile?.name || 'this tile'} looks in your space</p>
            </div>
          </div>
          <Button variant="ghost" size="icon" onClick={onClose}>
            <X className="h-5 w-5" />
          </Button>
        </div>

        {/* Main Content */}
        <div className="p-4">
          {/* Controls Bar */}
          <div className="flex flex-wrap items-center gap-3 mb-4">
            <input
              type="file"
              ref={fileInputRef}
              accept="image/*"
              onChange={handleFileChange}
              className="hidden"
            />
            <Button 
              onClick={() => fileInputRef.current?.click()}
              className="bg-amber-500 hover:bg-amber-600"
            >
              <Upload className="h-4 w-4 mr-2" />
              Upload Room Photo
            </Button>
            
            {roomImage && (
              <>
                <Button variant="outline" size="sm" onClick={() => setShowOverlay(!showOverlay)}>
                  <Eye className={`h-4 w-4 mr-1 ${showOverlay ? 'text-green-600' : 'text-gray-400'}`} />
                  {showOverlay ? 'Hide' : 'Show'} Tiles
                </Button>
                
                <Button variant="outline" size="sm" onClick={handleReset}>
                  <RotateCcw className="h-4 w-4 mr-1" />
                  Reset
                </Button>
                
                <Button variant="outline" size="sm" onClick={handleDownload}>
                  <Download className="h-4 w-4 mr-1" />
                  Download
                </Button>
              </>
            )}
          </div>

          {/* Canvas Area */}
          <div className="relative border rounded-lg overflow-hidden bg-gray-100">
            {isLoading && (
              <div className="absolute inset-0 flex items-center justify-center bg-white/80 z-10">
                <div className="animate-spin rounded-full h-10 w-10 border-4 border-amber-500 border-t-transparent"></div>
              </div>
            )}
            <canvas
              ref={canvasRef}
              className={`w-full ${roomImage ? 'cursor-move' : 'cursor-pointer'}`}
              style={{ height: '500px' }}
              onMouseDown={handleMouseDown}
              onMouseMove={handleMouseMove}
              onMouseUp={handleMouseUp}
              onMouseLeave={handleMouseUp}
              onClick={() => !roomImage && fileInputRef.current?.click()}
            />
          </div>

          {/* Adjustment Controls */}
          {roomImage && (
            <div className="mt-4 grid grid-cols-1 md:grid-cols-3 gap-4">
              {/* Opacity */}
              <div className="bg-gray-50 rounded-lg p-3">
                <label className="text-sm font-medium text-gray-700 flex items-center justify-between mb-2">
                  <span>Overlay Opacity</span>
                  <span className="text-amber-600">{Math.round(overlayOpacity * 100)}%</span>
                </label>
                <input
                  type="range"
                  min="0.1"
                  max="1"
                  step="0.05"
                  value={overlayOpacity}
                  onChange={(e) => setOverlayOpacity(parseFloat(e.target.value))}
                  className="w-full accent-amber-500"
                />
              </div>

              {/* Scale */}
              <div className="bg-gray-50 rounded-lg p-3">
                <label className="text-sm font-medium text-gray-700 flex items-center justify-between mb-2">
                  <span>Tile Size</span>
                  <span className="text-amber-600">{Math.round(tileScale * 100)}%</span>
                </label>
                <div className="flex items-center gap-2">
                  <Button 
                    variant="outline" 
                    size="icon" 
                    className="h-8 w-8"
                    onClick={() => setTileScale(Math.max(0.3, tileScale - 0.1))}
                  >
                    <ZoomOut className="h-4 w-4" />
                  </Button>
                  <input
                    type="range"
                    min="0.3"
                    max="2"
                    step="0.1"
                    value={tileScale}
                    onChange={(e) => setTileScale(parseFloat(e.target.value))}
                    className="flex-1 accent-amber-500"
                  />
                  <Button 
                    variant="outline" 
                    size="icon" 
                    className="h-8 w-8"
                    onClick={() => setTileScale(Math.min(2, tileScale + 0.1))}
                  >
                    <ZoomIn className="h-4 w-4" />
                  </Button>
                </div>
              </div>

              {/* Rotation */}
              <div className="bg-gray-50 rounded-lg p-3">
                <label className="text-sm font-medium text-gray-700 flex items-center justify-between mb-2">
                  <span>Rotation</span>
                  <span className="text-amber-600">{tileRotation}°</span>
                </label>
                <div className="flex gap-2">
                  {[0, 45, 90, 135, 180].map((angle) => (
                    <Button
                      key={angle}
                      variant={tileRotation === angle ? 'default' : 'outline'}
                      size="sm"
                      className={tileRotation === angle ? 'bg-amber-500' : ''}
                      onClick={() => setTileRotation(angle)}
                    >
                      {angle}°
                    </Button>
                  ))}
                </div>
              </div>
            </div>
          )}

          {/* Tips */}
          <div className="mt-4 bg-blue-50 rounded-lg p-3">
            <p className="text-sm text-blue-700">
              <strong>Tips:</strong> Upload a photo of your room, then drag on the canvas to position the tile overlay.
              Adjust opacity, size, and rotation to see how the tiles will look in your space.
            </p>
          </div>
        </div>

        {/* Tile Preview */}
        {tile && (
          <div className="border-t p-4 bg-gray-50 flex items-center gap-4">
            {firstImageUrl(tile.images) && (
              <img 
                src={firstImageUrl(tile.images)} 
                alt={tile.name}
                className="w-16 h-16 object-cover rounded-lg border"
              />
            )}
            <div className="flex-1">
              <p className="font-medium text-gray-900">{tile.name}</p>
              <p className="text-sm text-gray-500">
                {tile.size || 'Size not specified'} | {tile.finish || 'Standard finish'}
              </p>
            </div>
            <div className="text-right">
              <p className="font-bold text-lg text-amber-600">
                £{tile.price?.toFixed(2) || '0.00'}/m²
              </p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export default RoomVisualizer;
