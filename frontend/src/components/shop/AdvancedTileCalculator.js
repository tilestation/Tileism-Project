import React, { useState, useMemo } from 'react';
import { Calculator, Info, ShoppingCart, Plus, Minus, Trash2, Bath, Home, Square, Grid3X3, DoorOpen, Move, Triangle, Ruler, HelpCircle, X } from 'lucide-react';
import { Button } from '../ui/button';
import { Card } from '../ui/card';
import { Input } from '../ui/input';
import { Label } from '../ui/label';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../ui/dialog';
import { toast } from 'sonner';
import { safeToFixed } from '../../utils/safeStr';

// Sloped Wall Measurement Guide Component
const SlopedWallGuide = ({ isOpen, onClose }) => {
  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-lg">
            <Triangle className="w-5 h-5 text-purple-600" />
            How to Measure Sloped Walls
          </DialogTitle>
        </DialogHeader>
        
        <div className="space-y-6 py-2">
          {/* Triangle Wall Section */}
          <div className="bg-purple-50 rounded-lg p-4">
            <h4 className="font-semibold text-purple-800 mb-3 flex items-center gap-2">
              <span className="w-6 h-6 bg-purple-600 text-white rounded-full text-xs flex items-center justify-center">1</span>
              Triangle Wall (Gable End)
            </h4>
            
            {/* Triangle Diagram */}
            <div className="flex justify-center mb-4">
              <svg width="200" height="140" viewBox="0 0 200 140" className="bg-white rounded border">
                {/* Triangle shape */}
                <polygon points="100,20 20,120 180,120" fill="#f3e8ff" stroke="#9333ea" strokeWidth="2"/>
                
                {/* Base measurement line */}
                <line x1="20" y1="130" x2="180" y2="130" stroke="#1e293b" strokeWidth="2"/>
                <line x1="20" y1="125" x2="20" y2="135" stroke="#1e293b" strokeWidth="2"/>
                <line x1="180" y1="125" x2="180" y2="135" stroke="#1e293b" strokeWidth="2"/>
                <text x="100" y="138" textAnchor="middle" fontSize="11" fill="#1e293b" fontWeight="bold">BASE WIDTH</text>
                
                {/* Height measurement line */}
                <line x1="190" y1="20" x2="190" y2="120" stroke="#1e293b" strokeWidth="2"/>
                <line x1="185" y1="20" x2="195" y2="20" stroke="#1e293b" strokeWidth="2"/>
                <line x1="185" y1="120" x2="195" y2="120" stroke="#1e293b" strokeWidth="2"/>
                <text x="188" y="75" textAnchor="middle" fontSize="11" fill="#1e293b" fontWeight="bold" transform="rotate(90 188 75)">HEIGHT</text>
                
                {/* Dotted height line inside */}
                <line x1="100" y1="20" x2="100" y2="120" stroke="#9333ea" strokeWidth="1" strokeDasharray="4"/>
              </svg>
            </div>
            
            <div className="text-sm text-slate-700 space-y-2">
              <p><strong>Measure:</strong></p>
              <ul className="list-disc list-inside space-y-1 ml-2">
                <li><strong>Base Width:</strong> The bottom edge of the wall (widest part)</li>
                <li><strong>Height:</strong> From the base to the highest point (apex)</li>
              </ul>
              <p className="text-purple-700 font-medium mt-2">
                Formula: (Base × Height) ÷ 2
              </p>
            </div>
          </div>
          
          {/* Trapezoid Wall Section */}
          <div className="bg-amber-50 rounded-lg p-4">
            <h4 className="font-semibold text-amber-800 mb-3 flex items-center gap-2">
              <span className="w-6 h-6 bg-amber-600 text-white rounded-full text-xs flex items-center justify-center">2</span>
              Trapezoid Wall (Angled Ceiling)
            </h4>
            
            {/* Trapezoid Diagram */}
            <div className="flex justify-center mb-4">
              <svg width="200" height="140" viewBox="0 0 200 140" className="bg-white rounded border">
                {/* Trapezoid shape */}
                <polygon points="50,20 150,20 180,120 20,120" fill="#fef3c7" stroke="#d97706" strokeWidth="2"/>
                
                {/* Top measurement line */}
                <line x1="50" y1="10" x2="150" y2="10" stroke="#1e293b" strokeWidth="2"/>
                <line x1="50" y1="5" x2="50" y2="15" stroke="#1e293b" strokeWidth="2"/>
                <line x1="150" y1="5" x2="150" y2="15" stroke="#1e293b" strokeWidth="2"/>
                <text x="100" y="8" textAnchor="middle" fontSize="10" fill="#1e293b" fontWeight="bold">TOP WIDTH</text>
                
                {/* Base measurement line */}
                <line x1="20" y1="130" x2="180" y2="130" stroke="#1e293b" strokeWidth="2"/>
                <line x1="20" y1="125" x2="20" y2="135" stroke="#1e293b" strokeWidth="2"/>
                <line x1="180" y1="125" x2="180" y2="135" stroke="#1e293b" strokeWidth="2"/>
                <text x="100" y="138" textAnchor="middle" fontSize="10" fill="#1e293b" fontWeight="bold">BASE WIDTH</text>
                
                {/* Height measurement line */}
                <line x1="190" y1="20" x2="190" y2="120" stroke="#1e293b" strokeWidth="2"/>
                <line x1="185" y1="20" x2="195" y2="20" stroke="#1e293b" strokeWidth="2"/>
                <line x1="185" y1="120" x2="195" y2="120" stroke="#1e293b" strokeWidth="2"/>
                <text x="188" y="75" textAnchor="middle" fontSize="10" fill="#1e293b" fontWeight="bold" transform="rotate(90 188 75)">HEIGHT</text>
              </svg>
            </div>
            
            <div className="text-sm text-slate-700 space-y-2">
              <p><strong>Measure:</strong></p>
              <ul className="list-disc list-inside space-y-1 ml-2">
                <li><strong>Top Width:</strong> The shorter edge at the top</li>
                <li><strong>Base Width:</strong> The longer edge at the bottom</li>
                <li><strong>Height:</strong> Vertical distance between top and bottom</li>
              </ul>
              <p className="text-amber-700 font-medium mt-2">
                Formula: ((Top + Base) × Height) ÷ 2
              </p>
            </div>
          </div>
          
          {/* Right Triangle (Lean-to) Wall Section */}
          <div className="bg-teal-50 rounded-lg p-4">
            <h4 className="font-semibold text-teal-800 mb-3 flex items-center gap-2">
              <span className="w-6 h-6 bg-teal-600 text-white rounded-full text-xs flex items-center justify-center">3</span>
              Lean-to Wall (One Side Straight)
            </h4>
            
            {/* Right Triangle Diagram */}
            <div className="flex justify-center mb-4">
              <svg width="200" height="140" viewBox="0 0 200 140" className="bg-white rounded border">
                {/* Right triangle shape - straight on left, sloped on right */}
                <polygon points="40,20 40,120 180,120" fill="#ccfbf1" stroke="#0d9488" strokeWidth="2"/>
                
                {/* Right angle indicator */}
                <path d="M40,110 L50,110 L50,120" fill="none" stroke="#0d9488" strokeWidth="1.5"/>
                
                {/* Straight side (height) label */}
                <line x1="25" y1="20" x2="25" y2="120" stroke="#1e293b" strokeWidth="2"/>
                <line x1="20" y1="20" x2="30" y2="20" stroke="#1e293b" strokeWidth="2"/>
                <line x1="20" y1="120" x2="30" y2="120" stroke="#1e293b" strokeWidth="2"/>
                <text x="15" y="75" textAnchor="middle" fontSize="9" fill="#1e293b" fontWeight="bold" transform="rotate(-90 15 75)">STRAIGHT HEIGHT</text>
                
                {/* Base measurement line */}
                <line x1="40" y1="132" x2="180" y2="132" stroke="#1e293b" strokeWidth="2"/>
                <line x1="40" y1="127" x2="40" y2="137" stroke="#1e293b" strokeWidth="2"/>
                <line x1="180" y1="127" x2="180" y2="137" stroke="#1e293b" strokeWidth="2"/>
                <text x="110" y="140" textAnchor="middle" fontSize="10" fill="#1e293b" fontWeight="bold">BASE WIDTH</text>
                
                {/* Sloped side indicator */}
                <text x="120" y="60" textAnchor="middle" fontSize="9" fill="#0d9488" fontStyle="italic">sloped</text>
              </svg>
            </div>
            
            <div className="text-sm text-slate-700 space-y-2">
              <p><strong>Common in:</strong> Loft conversions, under-stair areas, lean-to extensions</p>
              <p><strong>Measure:</strong></p>
              <ul className="list-disc list-inside space-y-1 ml-2">
                <li><strong>Base Width:</strong> The horizontal floor/bottom edge</li>
                <li><strong>Straight Height:</strong> The vertical wall (full height side)</li>
              </ul>
              <p className="text-teal-700 font-medium mt-2">
                Formula: (Base × Height) ÷ 2
              </p>
              <p className="text-xs text-slate-500 mt-1">
                Tip: Use "Triangle" mode - the formula is the same!
              </p>
            </div>
          </div>
          
          {/* Tips Section */}
          <div className="bg-slate-100 rounded-lg p-4">
            <h4 className="font-semibold text-slate-800 mb-2 flex items-center gap-2">
              <Info className="w-4 h-4" />
              Measurement Tips
            </h4>
            <ul className="text-sm text-slate-600 space-y-1">
              <li>• Always measure in metres (m)</li>
              <li>• Measure at the widest points</li>
              <li>• For complex shapes, break into smaller sections</li>
              <li>• Add 10-15% wastage for cuts on angled edges</li>
            </ul>
          </div>
        </div>
        
        <div className="flex justify-end pt-2">
          <Button onClick={() => onClose(false)} variant="outline">
            Got it!
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
};

// Calculator types/presets
const CALCULATOR_TYPES = {
  bathroom: {
    id: 'bathroom',
    name: 'Bathroom',
    icon: Bath,
    description: 'Floor + Walls with window/door subtraction',
    hasWalls: true,
    hasFloor: true,
    hasSubtractions: true,
    defaultWallHeight: 2.4,
    presetRooms: ['Small Bathroom', 'Medium Bathroom', 'Large Bathroom', 'Wet Room', 'En-Suite']
  },
  floor: {
    id: 'floor',
    name: 'Floor Only',
    icon: Home,
    description: 'Kitchen, Living Room, Garden, etc.',
    hasWalls: false,
    hasFloor: true,
    hasSubtractions: false,
    presetRooms: ['Kitchen', 'Living Room', 'Hallway', 'Garden Patio', 'Conservatory', 'Utility Room']
  },
  singleWall: {
    id: 'singleWall',
    name: 'Single Wall',
    icon: Square,
    description: 'Splash backs, Feature walls, Fireplace',
    hasWalls: true,
    hasFloor: false,
    hasSubtractions: true,
    presetRooms: ['Kitchen Splashback', 'Feature Wall', 'Fireplace Wall', 'Accent Wall', 'Shower Wall']
  },
  slopedWall: {
    id: 'slopedWall',
    name: 'Sloped Wall',
    icon: Triangle,
    description: 'Triangular walls, gable ends, angled ceilings',
    hasWalls: false,
    hasFloor: false,
    hasSubtractions: true,
    isSloped: true,
    presetRooms: ['Gable End', 'Loft Conversion', 'Staircase Wall', 'Angled Ceiling']
  },
  custom: {
    id: 'custom',
    name: 'Custom Areas',
    icon: Grid3X3,
    description: 'Multiple small or complicated sections',
    hasWalls: false,
    hasFloor: false,
    hasSubtractions: false,
    isCustom: true,
    presetRooms: ['Complex Layout', 'Multiple Areas', 'L-Shaped Room', 'Alcoves']
  }
};

export const AdvancedTileCalculator = ({ product, onAddToCart }) => {
  // Active calculator type - default to bathroom
  const [activeType, setActiveType] = useState('bathroom');
  const calcType = CALCULATOR_TYPES[activeType];
  
  // Sloped wall guide popup
  const [showSlopedGuide, setShowSlopedGuide] = useState(false);
  
  // Floor dimensions
  const [floorLength, setFloorLength] = useState('');
  const [floorWidth, setFloorWidth] = useState('');
  
  // Wall dimensions (for bathroom/wall calculations)
  const [wallHeight, setWallHeight] = useState('2.4'); // Default height for all walls
  const [useIndividualHeights, setUseIndividualHeights] = useState(true); // Default ON for flexibility
  const [walls, setWalls] = useState([
    { id: 1, name: 'Wall 1', length: '', height: '2.4', enabled: true, isSloped: false, slopeType: 'triangle', topWidth: '' },
    { id: 2, name: 'Wall 2', length: '', height: '2.4', enabled: true, isSloped: false, slopeType: 'triangle', topWidth: '' },
    { id: 3, name: 'Wall 3', length: '', height: '2.4', enabled: true, isSloped: false, slopeType: 'triangle', topWidth: '' },
    { id: 4, name: 'Wall 4', length: '', height: '2.4', enabled: true, isSloped: false, slopeType: 'triangle', topWidth: '' }
  ]);
  
  // Single wall dimensions
  const [singleWallWidth, setSingleWallWidth] = useState('');
  const [singleWallHeight, setSingleWallHeight] = useState('');
  
  // Sloped wall dimensions (for triangular/gable walls)
  const [slopedWallBase, setSlopedWallBase] = useState('');
  const [slopedWallHeight, setSlopedWallHeight] = useState('');
  const [slopedWallType, setSlopedWallType] = useState('triangle'); // 'triangle' or 'trapezoid'
  const [slopedWallTopWidth, setSlopedWallTopWidth] = useState(''); // For trapezoid
  
  // Subtractions (windows, doors, custom)
  const [subtractions, setSubtractions] = useState([]);
  
  // Custom areas (for complex layouts)
  const [customAreas, setCustomAreas] = useState([
    { id: 1, name: 'Area 1', length: '', width: '', enabled: true }
  ]);
  
  // Wastage
  const [wastage, setWastage] = useState(10);
  
  // Result
  const [result, setResult] = useState(null);

  // Add a subtraction (window/door/custom)
  const addSubtraction = (type) => {
    const typeCount = subtractions.filter(s => s.type === type).length + 1;
    const newSub = {
      id: Date.now(),
      type: type, // 'window', 'door', or 'custom'
      name: type === 'window' ? `Window ${typeCount}` : 
            type === 'door' ? `Door ${typeCount}` : 
            `Other ${typeCount}`,
      width: type === 'window' ? '1.2' : type === 'door' ? '0.9' : '',
      height: type === 'window' ? '1.0' : type === 'door' ? '2.0' : ''
    };
    setSubtractions([...subtractions, newSub]);
  };

  // Remove a subtraction
  const removeSubtraction = (id) => {
    setSubtractions(subtractions.filter(s => s.id !== id));
  };

  // Update subtraction
  const updateSubtraction = (id, field, value) => {
    setSubtractions(subtractions.map(s => 
      s.id === id ? { ...s, [field]: value } : s
    ));
  };

  // Add custom area
  const addCustomArea = () => {
    setCustomAreas([...customAreas, {
      id: Date.now(),
      name: `Area ${customAreas.length + 1}`,
      length: '',
      width: '',
      enabled: true
    }]);
  };

  // Remove custom area
  const removeCustomArea = (id) => {
    if (customAreas.length > 1) {
      setCustomAreas(customAreas.filter(a => a.id !== id));
    }
  };

  // Update custom area
  const updateCustomArea = (id, field, value) => {
    setCustomAreas(customAreas.map(a => 
      a.id === id ? { ...a, [field]: value } : a
    ));
  };

  // Update wall
  const updateWall = (id, field, value) => {
    setWalls(walls.map(w => 
      w.id === id ? { ...w, [field]: value } : w
    ));
  };

  // Add new wall
  const addWall = () => {
    const newWall = {
      id: Date.now(),
      name: `Wall ${walls.length + 1}`,
      length: '',
      height: wallHeight || '2.4',
      enabled: true,
      isSloped: false,
      slopeType: 'triangle',
      topWidth: ''
    };
    setWalls([...walls, newWall]);
  };

  // Remove wall
  const removeWall = (id) => {
    if (walls.length > 1) {
      setWalls(walls.filter(w => w.id !== id));
    }
  };

  // Toggle wall slope mode
  const toggleWallSlope = (id) => {
    setWalls(walls.map(w => 
      w.id === id ? { ...w, isSloped: !w.isSloped } : w
    ));
  };

  // Update all wall heights when global height changes
  const updateGlobalWallHeight = (newHeight) => {
    setWallHeight(newHeight);
    if (!useIndividualHeights) {
      setWalls(walls.map(w => ({ ...w, height: newHeight })));
    }
  };

  // Calculate total area
  const calculateArea = useMemo(() => {
    let totalArea = 0;
    let floorArea = 0;
    let wallArea = 0;
    let subtractionArea = 0;
    let breakdown = [];

    // Floor calculation
    if (calcType.hasFloor && floorLength && floorWidth) {
      floorArea = parseFloat(floorLength) * parseFloat(floorWidth);
      breakdown.push({ label: 'Floor Area', value: floorArea });
    }

    // Wall calculation (bathroom or multiple walls)
    if (calcType.hasWalls && activeType === 'bathroom') {
      const defaultHeight = parseFloat(wallHeight) || 2.4;
      walls.forEach(wall => {
        if (wall.enabled && wall.length) {
          const wallLen = parseFloat(wall.length);
          const wallHt = useIndividualHeights ? (parseFloat(wall.height) || defaultHeight) : defaultHeight;
          
          let area;
          if (wall.isSloped) {
            // Sloped wall calculation
            if (wall.slopeType === 'triangle') {
              // Triangle: (base × height) / 2
              area = (wallLen * wallHt) / 2;
              breakdown.push({ label: `${wall.name} - Triangle (${wallLen}m × ${wallHt}m ÷ 2)`, value: area });
            } else if (wall.slopeType === 'leanto') {
              // Lean-to (right triangle): (base × height) / 2
              area = (wallLen * wallHt) / 2;
              breakdown.push({ label: `${wall.name} - Lean-to (${wallLen}m × ${wallHt}m ÷ 2)`, value: area });
            } else if (wall.slopeType === 'trapezoid' && wall.topWidth) {
              // Trapezoid: ((top + bottom) × height) / 2
              const topW = parseFloat(wall.topWidth);
              area = ((topW + wallLen) * wallHt) / 2;
              breakdown.push({ label: `${wall.name} - Trapezoid ((${topW}m + ${wallLen}m) × ${wallHt}m ÷ 2)`, value: area });
            } else {
              area = (wallLen * wallHt) / 2; // Default to triangle if trapezoid missing top width
              breakdown.push({ label: `${wall.name} - Triangle (${wallLen}m × ${wallHt}m ÷ 2)`, value: area });
            }
          } else {
            // Regular rectangle wall
            area = wallLen * wallHt;
            breakdown.push({ label: `${wall.name} (${wallLen}m × ${wallHt}m)`, value: area });
          }
          wallArea += area;
        }
      });
    }

    // Single wall calculation
    if (activeType === 'singleWall' && singleWallWidth && singleWallHeight) {
      wallArea = parseFloat(singleWallWidth) * parseFloat(singleWallHeight);
      breakdown.push({ label: 'Wall Area', value: wallArea });
    }

    // Sloped wall calculation (triangle, lean-to, or trapezoid)
    if (activeType === 'slopedWall' && slopedWallBase && slopedWallHeight) {
      const base = parseFloat(slopedWallBase);
      const height = parseFloat(slopedWallHeight);
      
      if (slopedWallType === 'triangle') {
        // Triangle area: (base × height) / 2
        wallArea = (base * height) / 2;
        breakdown.push({ label: `Triangle Wall (${base}m base × ${height}m height ÷ 2)`, value: wallArea });
      } else if (slopedWallType === 'leanto') {
        // Lean-to (right triangle) area: (base × height) / 2
        wallArea = (base * height) / 2;
        breakdown.push({ label: `Lean-to Wall (${base}m × ${height}m ÷ 2)`, value: wallArea });
      } else if (slopedWallType === 'trapezoid' && slopedWallTopWidth) {
        // Trapezoid area: ((top + bottom) × height) / 2
        const topWidth = parseFloat(slopedWallTopWidth);
        wallArea = ((topWidth + base) * height) / 2;
        breakdown.push({ label: `Trapezoid Wall ((${topWidth}m + ${base}m) × ${height}m ÷ 2)`, value: wallArea });
      }
    }

    // Custom areas calculation
    if (activeType === 'custom') {
      customAreas.forEach(area => {
        if (area.enabled && area.length && area.width) {
          const areaValue = parseFloat(area.length) * parseFloat(area.width);
          totalArea += areaValue;
          breakdown.push({ label: `${area.name} (${area.length}m × ${area.width}m)`, value: areaValue });
        }
      });
    }

    // Calculate subtractions
    if (calcType.hasSubtractions) {
      subtractions.forEach(sub => {
        if (sub.width && sub.height) {
          const area = parseFloat(sub.width) * parseFloat(sub.height);
          subtractionArea += area;
          const icon = sub.type === 'window' ? '🪟' : sub.type === 'door' ? '🚪' : '📐';
          breakdown.push({ label: `- ${icon} ${sub.name} (${sub.width}m × ${sub.height}m)`, value: -area, isSubtraction: true });
        }
      });
    }

    // Total (not for custom, which is already totaled)
    if (activeType !== 'custom') {
      totalArea = floorArea + wallArea - subtractionArea;
    } else {
      // For custom, subtract from the already calculated total
      totalArea = totalArea - subtractionArea;
    }

    // Add wastage
    const wastageAmount = totalArea * (wastage / 100);
    const totalWithWastage = totalArea + wastageAmount;

    return {
      floorArea: floorArea.toFixed(2),
      wallArea: wallArea.toFixed(2),
      subtractionArea: subtractionArea.toFixed(2),
      totalArea: Math.max(0, totalArea).toFixed(2),
      wastageAmount: wastageAmount.toFixed(2),
      totalWithWastage: Math.max(0, totalWithWastage).toFixed(2),
      breakdown
    };
  }, [activeType, calcType, floorLength, floorWidth, wallHeight, walls, singleWallWidth, singleWallHeight, slopedWallBase, slopedWallHeight, slopedWallType, slopedWallTopWidth, subtractions, customAreas, wastage, useIndividualHeights]);

  // Handle calculate
  const handleCalculate = () => {
    const totalArea = parseFloat(calculateArea.totalWithWastage);
    
    if (totalArea <= 0) {
      toast.error('Please enter valid dimensions');
      return;
    }

    const price = product?.price || 0;
    const sqmPerBox = product?.sqm_per_box;
    const tilesPerBox = product?.tiles_per_box;
    
    // Extract tile size from product name or size field for tile count calculation
    const tileSize = extractTileSize(product);

    let result = {
      room_area_m2: parseFloat(calculateArea.totalArea),
      area_with_wastage_m2: totalArea,
      wastage_percent: wastage,
      product_name: product?.name,
      price_per_unit: price,
      breakdown: calculateArea.breakdown
    };

    // Calculate boxes/units needed
    if (sqmPerBox && sqmPerBox > 0) {
      const boxesNeeded = Math.ceil(totalArea / sqmPerBox);
      result.boxes_needed = boxesNeeded;
      result.total_coverage_m2 = (boxesNeeded * sqmPerBox).toFixed(2);
      result.total_price = (boxesNeeded * sqmPerBox * price).toFixed(2);
      result.tiles_per_box = tilesPerBox;
      result.sqm_per_box = sqmPerBox;
      
      // Calculate total tiles
      if (tilesPerBox) {
        result.total_tiles = boxesNeeded * tilesPerBox;
      }
    } else {
      const unitsNeeded = Math.ceil(totalArea);
      result.units_needed = unitsNeeded;
      result.total_price = (unitsNeeded * price).toFixed(2);
    }

    // Calculate approximate number of tiles based on tile size
    if (tileSize && tileSize.area > 0) {
      const tilesNeeded = Math.ceil((totalArea * 10000) / tileSize.area); // Convert m² to cm² for calculation
      result.tiles_needed_approx = tilesNeeded;
      result.tile_size = tileSize;
    }

    setResult(result);
  };

  // Extract tile size from product info
  const extractTileSize = (product) => {
    if (!product) return null;
    
    const name = product.name || product.product_name || '';
    const sizeField = product.size || '';
    
    // Try to match patterns like "60x60", "600x600", "120x60cm", etc.
    const patterns = [
      /(\d+)\s*[xX×]\s*(\d+)\s*(cm|mm)?/,
      /(\d+)\s*[xX×]\s*(\d+)/
    ];
    
    for (const pattern of patterns) {
      const match = (name + ' ' + sizeField).match(pattern);
      if (match) {
        let width = parseInt(match[1]);
        let height = parseInt(match[2]);
        const unit = match[3]?.toLowerCase();
        
        // Assume mm if values are > 100, otherwise cm
        if (width > 100 || height > 100) {
          // Already in mm, convert to cm
          width = width / 10;
          height = height / 10;
        }
        
        // If unit specified as mm, convert
        if (unit === 'mm') {
          width = width / 10;
          height = height / 10;
        }
        
        return {
          width: width,
          height: height,
          area: width * height, // area in cm²
          display: `${width}×${height}cm`
        };
      }
    }
    
    return null;
  };

  // Handle add to cart
  const handleAddToCart = () => {
    if (!result || !onAddToCart) return;
    
    const quantity = result.boxes_needed 
      ? result.boxes_needed * (result.sqm_per_box || 1)
      : result.units_needed;
    
    onAddToCart(quantity);
    
    if (result.boxes_needed) {
      toast.success(`Added ${result.boxes_needed} box${result.boxes_needed > 1 ? 'es' : ''} (${result.total_coverage_m2}m²) to cart`);
    } else {
      toast.success(`Added ${result.units_needed}m² to cart`);
    }
  };

  // Reset calculator
  const resetCalculator = () => {
    setFloorLength('');
    setFloorWidth('');
    setWallHeight('2.4');
    setUseIndividualHeights(true); // Keep individual heights ON by default
    setWalls([
      { id: 1, name: 'Wall 1', length: '', height: '2.4', enabled: true, isSloped: false, slopeType: 'triangle', topWidth: '' },
      { id: 2, name: 'Wall 2', length: '', height: '2.4', enabled: true, isSloped: false, slopeType: 'triangle', topWidth: '' },
      { id: 3, name: 'Wall 3', length: '', height: '2.4', enabled: true, isSloped: false, slopeType: 'triangle', topWidth: '' },
      { id: 4, name: 'Wall 4', length: '', height: '2.4', enabled: true, isSloped: false, slopeType: 'triangle', topWidth: '' }
    ]);
    setSingleWallWidth('');
    setSingleWallHeight('');
    setSlopedWallBase('');
    setSlopedWallHeight('');
    setSlopedWallType('triangle');
    setSlopedWallTopWidth('');
    setSubtractions([]);
    setCustomAreas([{ id: 1, name: 'Area 1', length: '', width: '', enabled: true }]);
    setWastage(10);
    setResult(null);
  };

  const formatPrice = (price) => `£${parseFloat(price)?.toFixed(2) || '0.00'}`;

  return (
    <Card className="p-4 bg-amber-50 border-amber-200" data-testid="advanced-tile-calculator">
      {/* Header */}
      <div className="flex items-center gap-2 mb-4">
        <Calculator className="w-5 h-5 text-amber-600" />
        <h3 className="font-semibold text-slate-900">Tile Calculator</h3>
      </div>

      {/* Calculator Type Tabs */}
      <div className="flex flex-wrap gap-1 mb-4 p-1 bg-amber-100 rounded-lg">
        {Object.values(CALCULATOR_TYPES).map((type) => {
          const Icon = type.icon;
          return (
            <button
              key={type.id}
              onClick={() => {
                setActiveType(type.id);
                setResult(null);
              }}
              className={`flex-1 min-w-[70px] flex flex-col items-center gap-1 px-2 py-2 rounded-md text-xs transition-colors ${
                activeType === type.id
                  ? 'bg-amber-500 text-white shadow-sm'
                  : 'text-amber-700 hover:bg-amber-200'
              }`}
              data-testid={`calc-tab-${type.id}`}
            >
              <Icon className="w-4 h-4" />
              <span className="font-medium">{type.name}</span>
            </button>
          );
        })}
      </div>

      {/* Description */}
      <p className="text-xs text-amber-700 mb-4 bg-amber-100 px-2 py-1.5 rounded">
        {calcType.description}
      </p>

      {/* Floor Dimensions (for bathroom and floor types) */}
      {calcType.hasFloor && (
        <div className="mb-4">
          <h4 className="text-sm font-medium text-slate-700 mb-2">Floor Dimensions</h4>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label className="text-xs">Length (m)</Label>
              <Input
                type="number"
                step="0.1"
                min="0"
                placeholder="e.g. 3.0"
                value={floorLength}
                onChange={(e) => setFloorLength(e.target.value)}
                className="h-9"
              />
            </div>
            <div>
              <Label className="text-xs">Width (m)</Label>
              <Input
                type="number"
                step="0.1"
                min="0"
                placeholder="e.g. 2.5"
                value={floorWidth}
                onChange={(e) => setFloorWidth(e.target.value)}
                className="h-9"
              />
            </div>
          </div>
        </div>
      )}

      {/* Wall Dimensions (for bathroom - multiple walls) */}
      {calcType.hasWalls && activeType === 'bathroom' && (
        <div className="mb-4">
          <div className="flex items-center justify-between mb-2">
            <h4 className="text-sm font-medium text-slate-700">Wall Dimensions</h4>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={addWall}
              className="h-7 text-xs"
            >
              <Plus className="w-3 h-3 mr-1" /> Add Wall
            </Button>
          </div>
          
          {/* Height Settings */}
          <div className="bg-white p-3 rounded border mb-3">
            <div className="flex items-center justify-between mb-2">
              <Label className="text-xs font-medium">Height Settings</Label>
              <label className="flex items-center gap-2 text-xs cursor-pointer">
                <input
                  type="checkbox"
                  checked={useIndividualHeights}
                  onChange={(e) => setUseIndividualHeights(e.target.checked)}
                  className="w-3.5 h-3.5 text-amber-500"
                />
                <span className="text-slate-600">Individual wall heights</span>
              </label>
            </div>
            {!useIndividualHeights && (
              <div className="flex items-center gap-2">
                <Label className="text-xs text-slate-500">Default Height:</Label>
                <Input
                  type="number"
                  step="0.1"
                  min="0"
                  placeholder="2.4"
                  value={wallHeight}
                  onChange={(e) => updateGlobalWallHeight(e.target.value)}
                  className="h-8 w-20 text-sm"
                />
                <span className="text-xs text-slate-400">m (for all walls)</span>
              </div>
            )}
            {useIndividualHeights && (
              <p className="text-xs text-amber-600">Set height for each wall below (e.g., half-height tiling)</p>
            )}
          </div>
          
          {/* Wall List */}
          <div className="space-y-2">
            {walls.map((wall) => (
              <div key={wall.id} className={`p-2 rounded border ${wall.isSloped ? 'bg-purple-50 border-purple-200' : 'bg-white'}`}>
                {/* Wall Header Row */}
                <div className="flex items-center gap-2 mb-1">
                  <input
                    type="checkbox"
                    checked={wall.enabled}
                    onChange={(e) => updateWall(wall.id, 'enabled', e.target.checked)}
                    className="w-4 h-4 text-amber-500"
                  />
                  <Input
                    type="text"
                    value={wall.name}
                    onChange={(e) => updateWall(wall.id, 'name', e.target.value)}
                    className="h-7 w-20 text-xs"
                    placeholder="Wall name"
                  />
                  <button
                    type="button"
                    onClick={() => toggleWallSlope(wall.id)}
                    className={`px-3 py-1.5 text-xs rounded-md font-medium flex items-center gap-1.5 border-2 transition-all ${
                      wall.isSloped 
                        ? 'bg-purple-500 text-white border-purple-600 shadow-md' 
                        : 'bg-white text-gray-600 border-gray-300 hover:border-purple-400 hover:bg-purple-50'
                    }`}
                    title="Toggle sloped wall"
                  >
                    <Triangle className={`w-3.5 h-3.5 ${wall.isSloped ? '' : 'text-purple-500'}`} />
                    {wall.isSloped ? 'Sloped' : 'Regular'}
                  </button>
                  {wall.isSloped && (
                    <button
                      type="button"
                      onClick={() => setShowSlopedGuide(true)}
                      className="p-1.5 text-purple-600 hover:text-purple-800 hover:bg-purple-100 rounded-full border border-purple-300"
                      title="How to measure sloped walls"
                    >
                      <HelpCircle className="w-4 h-4" />
                    </button>
                  )}
                  {walls.length > 1 && (
                    <button
                      onClick={() => removeWall(wall.id)}
                      className="text-red-400 hover:text-red-600 p-1 ml-auto"
                      title="Remove wall"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  )}
                </div>
                
                {/* Wall Dimensions Row */}
                <div className="flex items-center gap-2 pl-6">
                  {wall.isSloped ? (
                    <>
                      {/* Sloped Wall Options */}
                      <select
                        value={wall.slopeType}
                        onChange={(e) => updateWall(wall.id, 'slopeType', e.target.value)}
                        className="h-7 text-xs border rounded px-1"
                        disabled={!wall.enabled}
                      >
                        <option value="triangle">Triangle</option>
                        <option value="leanto">Lean-to</option>
                        <option value="trapezoid">Trapezoid</option>
                      </select>
                      <Input
                        type="number"
                        step="0.1"
                        min="0"
                        placeholder="Base (m)"
                        value={wall.length}
                        onChange={(e) => updateWall(wall.id, 'length', e.target.value)}
                        disabled={!wall.enabled}
                        className="h-7 w-20 text-xs"
                      />
                      {wall.slopeType === 'trapezoid' && (
                        <Input
                          type="number"
                          step="0.1"
                          min="0"
                          placeholder="Top (m)"
                          value={wall.topWidth}
                          onChange={(e) => updateWall(wall.id, 'topWidth', e.target.value)}
                          disabled={!wall.enabled}
                          className="h-7 w-16 text-xs"
                        />
                      )}
                    </>
                  ) : (
                    <Input
                      type="number"
                      step="0.1"
                      min="0"
                      placeholder="Length (m)"
                      value={wall.length}
                      onChange={(e) => updateWall(wall.id, 'length', e.target.value)}
                      disabled={!wall.enabled}
                      className="h-7 w-24 text-xs"
                    />
                  )}
                  
                  {/* Individual Height (when enabled) */}
                  {useIndividualHeights && (
                    <div className="flex items-center gap-1">
                      <span className="text-xs text-slate-400">H:</span>
                      <Input
                        type="number"
                        step="0.1"
                        min="0"
                        placeholder="2.4"
                        value={wall.height}
                        onChange={(e) => updateWall(wall.id, 'height', e.target.value)}
                        disabled={!wall.enabled}
                        className="h-7 w-16 text-xs"
                      />
                      <span className="text-xs text-slate-400">m</span>
                    </div>
                  )}
                  
                  {/* Area Display */}
                  <span className="text-xs text-slate-500 ml-auto">
                    {wall.enabled && wall.length ? (() => {
                      const len = parseFloat(wall.length);
                      const ht = useIndividualHeights ? parseFloat(wall.height) || parseFloat(wallHeight) || 2.4 : parseFloat(wallHeight) || 2.4;
                      if (wall.isSloped) {
                        if (wall.slopeType === 'trapezoid' && wall.topWidth) {
                          return `${(((parseFloat(wall.topWidth) + len) * ht) / 2).toFixed(1)}m²`;
                        }
                        return `${((len * ht) / 2).toFixed(1)}m²`;
                      }
                      return `${(len * ht).toFixed(1)}m²`;
                    })() : ''}
                  </span>
                </div>
              </div>
            ))}
          </div>
          
          {/* Help text */}
          <p className="text-xs text-slate-400 mt-2">
            Tip: Use "Individual heights" for half-height tiling. Use "Sloped" for angled walls (gables, loft conversions).
          </p>
        </div>
      )}

      {/* Single Wall Dimensions */}
      {activeType === 'singleWall' && (
        <div className="mb-4">
          <h4 className="text-sm font-medium text-slate-700 mb-2">Wall Dimensions</h4>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label className="text-xs">Width (m)</Label>
              <Input
                type="number"
                step="0.1"
                min="0"
                placeholder="e.g. 3.0"
                value={singleWallWidth}
                onChange={(e) => setSingleWallWidth(e.target.value)}
                className="h-9"
              />
            </div>
            <div>
              <Label className="text-xs">Height (m)</Label>
              <Input
                type="number"
                step="0.1"
                min="0"
                placeholder="e.g. 0.6"
                value={singleWallHeight}
                onChange={(e) => setSingleWallHeight(e.target.value)}
                className="h-9"
              />
            </div>
          </div>
        </div>
      )}

      {/* Sloped Wall Dimensions */}
      {activeType === 'slopedWall' && (
        <div className="mb-4">
          <div className="flex items-center justify-between mb-2">
            <h4 className="text-sm font-medium text-slate-700">Sloped Wall Shape</h4>
            <button
              type="button"
              onClick={() => setShowSlopedGuide(true)}
              className="flex items-center gap-1 px-2 py-1 text-xs text-purple-600 hover:text-purple-800 hover:bg-purple-50 rounded border border-purple-200"
            >
              <HelpCircle className="w-3.5 h-3.5" />
              How to Measure
            </button>
          </div>
          
          {/* Shape selector */}
          <div className="flex gap-2 mb-3">
            <button
              type="button"
              onClick={() => setSlopedWallType('triangle')}
              className={`flex-1 flex items-center justify-center gap-2 p-2 rounded border text-xs ${
                slopedWallType === 'triangle' 
                  ? 'bg-amber-100 border-amber-400 text-amber-700' 
                  : 'bg-white border-gray-200 text-gray-600 hover:bg-gray-50'
              }`}
            >
              <Triangle className="w-4 h-4" />
              Triangle (Gable)
            </button>
            <button
              type="button"
              onClick={() => setSlopedWallType('leanto')}
              className={`flex-1 flex items-center justify-center gap-2 p-2 rounded border text-xs ${
                slopedWallType === 'leanto' 
                  ? 'bg-teal-100 border-teal-400 text-teal-700' 
                  : 'bg-white border-gray-200 text-gray-600 hover:bg-gray-50'
              }`}
            >
              <Triangle className="w-4 h-4 rotate-90" />
              Lean-to
            </button>
            <button
              type="button"
              onClick={() => setSlopedWallType('trapezoid')}
              className={`flex-1 flex items-center justify-center gap-2 p-2 rounded border text-xs ${
                slopedWallType === 'trapezoid' 
                  ? 'bg-amber-100 border-amber-400 text-amber-700' 
                  : 'bg-white border-gray-200 text-gray-600 hover:bg-gray-50'
              }`}
            >
              <Ruler className="w-4 h-4" />
              Trapezoid
            </button>
          </div>
          
          {/* Dimensions */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label className="text-xs">Base Width (m)</Label>
              <Input
                type="number"
                step="0.1"
                min="0"
                placeholder="e.g. 4.0"
                value={slopedWallBase}
                onChange={(e) => setSlopedWallBase(e.target.value)}
                className="h-9"
              />
            </div>
            <div>
              <Label className="text-xs">Height (m)</Label>
              <Input
                type="number"
                step="0.1"
                min="0"
                placeholder="e.g. 2.5"
                value={slopedWallHeight}
                onChange={(e) => setSlopedWallHeight(e.target.value)}
                className="h-9"
              />
            </div>
          </div>
          
          {/* Top width for trapezoid */}
          {slopedWallType === 'trapezoid' && (
            <div className="mt-3">
              <Label className="text-xs">Top Width (m) - narrower end</Label>
              <Input
                type="number"
                step="0.1"
                min="0"
                placeholder="e.g. 2.0"
                value={slopedWallTopWidth}
                onChange={(e) => setSlopedWallTopWidth(e.target.value)}
                className="h-9 w-32"
              />
            </div>
          )}
          
          {/* Visual guide */}
          <div className="mt-3 p-2 bg-white rounded border text-xs text-slate-500">
            {slopedWallType === 'triangle' ? (
              <div className="flex items-center gap-2">
                <div className="w-0 h-0 border-l-[20px] border-r-[20px] border-b-[30px] border-l-transparent border-r-transparent border-b-purple-300"></div>
                <span>Formula: (Base × Height) ÷ 2</span>
              </div>
            ) : slopedWallType === 'leanto' ? (
              <div className="flex items-center gap-2">
                <div className="w-8 h-6 bg-teal-300" style={{ clipPath: 'polygon(0% 0%, 0% 100%, 100% 100%)' }}></div>
                <span>Formula: (Base × Height) ÷ 2 — One straight side, one sloped</span>
              </div>
            ) : (
              <div className="flex items-center gap-2">
                <div className="w-10 h-6 bg-amber-300" style={{ clipPath: 'polygon(20% 0%, 80% 0%, 100% 100%, 0% 100%)' }}></div>
                <span>Formula: ((Top + Base) × Height) ÷ 2</span>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Custom Areas */}
      {activeType === 'custom' && (
        <div className="mb-4">
          <div className="flex items-center justify-between mb-2">
            <h4 className="text-sm font-medium text-slate-700">Custom Areas</h4>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={addCustomArea}
              className="h-7 text-xs"
            >
              <Plus className="w-3 h-3 mr-1" /> Add Area
            </Button>
          </div>
          <div className="space-y-2">
            {customAreas.map((area, idx) => (
              <div key={area.id} className="flex items-center gap-2 bg-white p-2 rounded border">
                <Input
                  type="text"
                  value={area.name}
                  onChange={(e) => updateCustomArea(area.id, 'name', e.target.value)}
                  className="h-8 w-24 text-xs"
                  placeholder="Area name"
                />
                <Input
                  type="number"
                  step="0.1"
                  min="0"
                  value={area.length}
                  onChange={(e) => updateCustomArea(area.id, 'length', e.target.value)}
                  className="h-8 flex-1 text-sm"
                  placeholder="L (m)"
                />
                <span className="text-xs text-slate-400">×</span>
                <Input
                  type="number"
                  step="0.1"
                  min="0"
                  value={area.width}
                  onChange={(e) => updateCustomArea(area.id, 'width', e.target.value)}
                  className="h-8 flex-1 text-sm"
                  placeholder="W (m)"
                />
                <span className="text-xs text-slate-500 w-12">
                  {area.length && area.width ? `${(parseFloat(area.length) * parseFloat(area.width)).toFixed(1)}m²` : ''}
                </span>
                {customAreas.length > 1 && (
                  <button
                    onClick={() => removeCustomArea(area.id)}
                    className="text-red-500 hover:text-red-700 p-1"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Subtractions (Windows/Doors/Custom) */}
      {calcType.hasSubtractions && (
        <div className="mb-4">
          <div className="flex items-center justify-between mb-2">
            <h4 className="text-sm font-medium text-slate-700">Subtract (Optional)</h4>
            <div className="flex gap-1">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => addSubtraction('window')}
                className="h-7 text-xs"
              >
                <Move className="w-3 h-3 mr-1" /> Window
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => addSubtraction('door')}
                className="h-7 text-xs"
              >
                <DoorOpen className="w-3 h-3 mr-1" /> Door
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => addSubtraction('custom')}
                className="h-7 text-xs"
              >
                <Minus className="w-3 h-3 mr-1" /> Other
              </Button>
            </div>
          </div>
          {subtractions.length > 0 && (
            <div className="space-y-2">
              {subtractions.map((sub) => (
                <div key={sub.id} className="flex items-center gap-2 bg-red-50 p-2 rounded border border-red-100">
                  {sub.type === 'custom' ? (
                    <Input
                      type="text"
                      value={sub.name}
                      onChange={(e) => updateSubtraction(sub.id, 'name', e.target.value)}
                      className="h-8 w-20 text-xs text-red-600"
                      placeholder="Name"
                    />
                  ) : (
                    <span className="text-xs text-red-600 w-20">{sub.type === 'window' ? '🪟' : '🚪'} {sub.name}</span>
                  )}
                  <Input
                    type="number"
                    step="0.1"
                    min="0"
                    value={sub.width}
                    onChange={(e) => updateSubtraction(sub.id, 'width', e.target.value)}
                    className="h-8 w-16 text-sm"
                    placeholder="W"
                  />
                  <span className="text-xs text-slate-400">×</span>
                  <Input
                    type="number"
                    step="0.1"
                    min="0"
                    value={sub.height}
                    onChange={(e) => updateSubtraction(sub.id, 'height', e.target.value)}
                    className="h-8 w-16 text-sm"
                    placeholder="H"
                  />
                  <span className="text-xs text-red-500 w-14">
                    -{(parseFloat(sub.width || 0) * parseFloat(sub.height || 0)).toFixed(2)}m²
                  </span>
                  <button
                    onClick={() => removeSubtraction(sub.id)}
                    className="text-red-500 hover:text-red-700 p-1"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
              ))}
            </div>
          )}
          {subtractions.length === 0 && (
            <p className="text-xs text-slate-500 italic">No windows or doors added. Click above to subtract areas.</p>
          )}
        </div>
      )}

      {/* Wastage */}
      <div className="mb-4">
        <Label className="text-xs flex items-center gap-1">
          Wastage Allowance
          <span className="text-slate-500">(recommended: 10%)</span>
        </Label>
        <div className="flex items-center gap-2">
          <Input
            type="number"
            min="0"
            max="30"
            value={wastage}
            onChange={(e) => setWastage(parseInt(e.target.value) || 0)}
            className="w-20 h-9"
          />
          <span className="text-sm text-slate-500">%</span>
        </div>
      </div>

      {/* Live Calculation Summary */}
      {parseFloat(calculateArea.totalArea) > 0 && (
        <div className="bg-white rounded-lg p-3 mb-4 text-sm">
          <div className="flex justify-between mb-1">
            <span className="text-slate-500">Total Area:</span>
            <span className="font-medium">{calculateArea.totalArea}m²</span>
          </div>
          {parseFloat(calculateArea.subtractionArea) > 0 && (
            <div className="flex justify-between mb-1 text-red-600">
              <span>Subtractions:</span>
              <span>-{calculateArea.subtractionArea}m²</span>
            </div>
          )}
          <div className="flex justify-between mb-1">
            <span className="text-slate-500">+ {wastage}% Wastage:</span>
            <span className="font-medium">+{calculateArea.wastageAmount}m²</span>
          </div>
          <hr className="my-2" />
          <div className="flex justify-between font-bold text-amber-600">
            <span>Total Required:</span>
            <span>{calculateArea.totalWithWastage}m²</span>
          </div>
        </div>
      )}

      {/* Buttons */}
      <div className="flex gap-2 mb-4">
        <Button 
          onClick={handleCalculate}
          className="flex-1 bg-amber-500 hover:bg-amber-600 text-slate-900"
        >
          Calculate
        </Button>
        <Button
          variant="outline"
          onClick={resetCalculator}
          className="px-3"
        >
          Reset
        </Button>
      </div>

      {/* Results */}
      {result && (
        <div className="bg-white rounded-lg p-4 border-2 border-amber-300">
          <h4 className="font-semibold text-slate-900 mb-3">Calculation Results</h4>
          
          {/* Breakdown */}
          {result.breakdown && result.breakdown.length > 0 && (
            <div className="mb-3 text-xs space-y-1">
              {result.breakdown.map((item, idx) => (
                <div key={idx} className={`flex justify-between ${item.isSubtraction ? 'text-red-600' : 'text-slate-600'}`}>
                  <span>{item.label}</span>
                  <span>{safeToFixed(item.value, 2)}m²</span>
                </div>
              ))}
            </div>
          )}
          
          <hr className="my-3" />
          
          <div className="space-y-2">
            <div className="flex justify-between text-sm">
              <span className="text-slate-500">Net Area:</span>
              <span className="font-medium">{result.room_area_m2}m²</span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-slate-500">With {wastage}% Wastage:</span>
              <span className="font-medium">{result.area_with_wastage_m2}m²</span>
            </div>
            
            <hr className="my-2" />
            
            {result.boxes_needed && (
              <>
                <div className="flex justify-between text-sm">
                  <span className="text-slate-500">Boxes Needed:</span>
                  <span className="font-bold text-lg text-amber-600">{result.boxes_needed} boxes</span>
                </div>
                <div className="flex justify-between text-xs text-slate-500">
                  <span>({result.sqm_per_box}m² per box × {result.boxes_needed})</span>
                  <span>= {result.total_coverage_m2}m² coverage</span>
                </div>
                {result.total_tiles && (
                  <div className="flex justify-between text-sm bg-amber-50 p-2 rounded mt-2">
                    <span className="text-slate-600">Total Tiles:</span>
                    <span className="font-bold text-amber-700">{result.total_tiles} tiles</span>
                  </div>
                )}
              </>
            )}
            
            {result.units_needed && !result.boxes_needed && (
              <div className="flex justify-between text-sm">
                <span className="text-slate-500">m² Needed:</span>
                <span className="font-bold text-lg text-amber-600">{result.units_needed}m²</span>
              </div>
            )}

            {/* Approximate tiles based on tile size */}
            {result.tiles_needed_approx && !result.total_tiles && (
              <div className="flex justify-between text-sm bg-amber-50 p-2 rounded mt-2">
                <span className="text-slate-600">Approx. Tiles ({result.tile_size?.display}):</span>
                <span className="font-bold text-amber-700">~{result.tiles_needed_approx} tiles</span>
              </div>
            )}
            
            <hr className="my-2" />
            
            <div className="flex justify-between text-lg">
              <span className="text-slate-700 font-medium">Estimated Total:</span>
              <span className="font-bold text-amber-600">{formatPrice(result.total_price)}</span>
            </div>
            <p className="text-xs text-slate-500">
              at {formatPrice(product?.price || 0)}/m²
            </p>
          </div>

          {onAddToCart && (
            <Button 
              onClick={handleAddToCart}
              className="w-full mt-4 bg-amber-500 hover:bg-amber-600 text-slate-900"
              data-testid="add-calculated-to-cart"
            >
              <ShoppingCart className="w-4 h-4 mr-2" />
              Add {result.boxes_needed ? `${result.boxes_needed} Boxes` : `${result.units_needed}m²`} to Cart
            </Button>
          )}
        </div>
      )}

      {/* Info */}
      <p className="text-xs text-slate-500 mt-3 flex items-start gap-1">
        <Info className="w-3 h-3 mt-0.5 flex-shrink-0" />
        We recommend ordering 10% extra for cuts and wastage. Always order from the same batch.
      </p>
      
      {/* Sloped Wall Measurement Guide Popup */}
      <SlopedWallGuide isOpen={showSlopedGuide} onClose={setShowSlopedGuide} />
    </Card>
  );
};

export default AdvancedTileCalculator;
