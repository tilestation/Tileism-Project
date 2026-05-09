import React, { useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '../../components/ui/card';
import { Button } from '../../components/ui/button';
import { Check, Tag, Layers, Filter, Grid3X3, ChevronRight, X } from 'lucide-react';
import { normaliseImageUrl } from '../../utils/safeStr';

// Demo component to show different category system options
export default function CategorySystemDemo() {
  const [selectedOption, setSelectedOption] = useState(null);
  
  // Sample product for demo
  const sampleProduct = {
    name: "Etna Gold 60x120 Porcelain Tile",
    image: "https://images.unsplash.com/photo-1615971677499-5467cbab01c0?w=300&h=300&fit=crop",
    price: 45.99,
    finish: "Polished",
    material: "Porcelain",
    suitability: "Wall & Floor"
  };

  // Option A: Tags/Labels System
  const TagsDemo = () => {
    const [selectedTags, setSelectedTags] = useState(['Floor Tiles', 'Wall Tiles', 'Polished']);
    const availableTags = [
      { name: 'Floor Tiles', color: 'bg-blue-500' },
      { name: 'Wall Tiles', color: 'bg-green-500' },
      { name: 'Outdoor Tiles', color: 'bg-orange-500' },
      { name: 'Bathroom Tiles', color: 'bg-cyan-500' },
      { name: 'Kitchen Tiles', color: 'bg-yellow-500' },
      { name: 'Polished', color: 'bg-purple-500' },
      { name: 'Matt', color: 'bg-gray-500' },
      { name: 'Lappato', color: 'bg-pink-500' },
      { name: 'Anti-Slip', color: 'bg-red-500' },
      { name: 'Large Format', color: 'bg-indigo-500' },
      { name: 'Marble Effect', color: 'bg-rose-500' },
      { name: 'Wood Effect', color: 'bg-amber-600' },
    ];

    const toggleTag = (tagName) => {
      setSelectedTags(prev => 
        prev.includes(tagName) 
          ? prev.filter(t => t !== tagName)
          : [...prev, tagName]
      );
    };

    return (
      <div className="space-y-6">
        {/* Admin View - Tag Selection */}
        <div className="border-2 border-blue-200 rounded-lg p-6 bg-blue-50">
          <h3 className="font-bold text-lg mb-2 flex items-center gap-2">
            <Tag className="w-5 h-5 text-blue-600" />
            Admin View: Tag Selection
          </h3>
          <p className="text-sm text-gray-600 mb-4">
            Select multiple tags to categorize this product. It will appear in ALL selected categories on the website.
          </p>
          
          <div className="flex flex-wrap gap-2">
            {availableTags.map(tag => (
              <button
                key={tag.name}
                onClick={() => toggleTag(tag.name)}
                className={`px-3 py-1.5 rounded-full text-sm font-medium transition-all ${
                  selectedTags.includes(tag.name)
                    ? `${tag.color} text-white shadow-md`
                    : 'bg-white border border-gray-300 text-gray-700 hover:border-gray-400'
                }`}
              >
                {selectedTags.includes(tag.name) && <Check className="w-3 h-3 inline mr-1" />}
                {tag.name}
              </button>
            ))}
          </div>
          
          <div className="mt-4 p-3 bg-white rounded-lg">
            <p className="text-sm text-gray-500">Selected tags for "{sampleProduct.name}":</p>
            <div className="flex flex-wrap gap-1 mt-2">
              {selectedTags.map(tag => (
                <span key={tag} className="px-2 py-1 bg-gray-100 rounded text-xs font-medium">
                  {tag}
                </span>
              ))}
            </div>
          </div>
        </div>

        {/* Customer View - Website Navigation */}
        <div className="border-2 border-green-200 rounded-lg p-6 bg-green-50">
          <h3 className="font-bold text-lg mb-2">Customer View: Website Navigation</h3>
          
          {/* Navigation Bar Example */}
          <div className="bg-gray-900 text-white p-4 rounded-lg mb-4">
            <div className="flex gap-6 text-sm">
              <span className="hover:text-yellow-400 cursor-pointer">Floor Tiles</span>
              <span className="hover:text-yellow-400 cursor-pointer">Wall Tiles</span>
              <span className="hover:text-yellow-400 cursor-pointer">Outdoor</span>
              <span className="hover:text-yellow-400 cursor-pointer">Bathroom</span>
              <span className="hover:text-yellow-400 cursor-pointer">By Finish ▾</span>
              <span className="hover:text-yellow-400 cursor-pointer">By Style ▾</span>
            </div>
          </div>
          
          {/* Product appears in multiple categories */}
          <div className="grid grid-cols-3 gap-4">
            {['Floor Tiles', 'Wall Tiles', 'Polished'].map(category => (
              <div key={category} className="bg-white rounded-lg p-3 shadow">
                <p className="text-xs text-gray-500 mb-2">Found in: {category}</p>
                <img src={normaliseImageUrl(sampleProduct.image)} alt="" className="w-full h-24 object-cover rounded mb-2" />
                <p className="text-sm font-medium truncate">{sampleProduct.name}</p>
                <p className="text-green-600 font-bold">£{sampleProduct.price}/m²</p>
              </div>
            ))}
          </div>
        </div>
      </div>
    );
  };

  // Option B: Collections System
  const CollectionsDemo = () => {
    const collections = [
      { 
        name: 'Living Room Collection', 
        description: 'Elegant tiles for your living spaces',
        products: 45,
        image: 'https://images.unsplash.com/photo-1616486338812-3dadae4b4ace?w=400&h=200&fit=crop'
      },
      { 
        name: 'Bathroom Essentials', 
        description: 'Water-resistant tiles with anti-slip options',
        products: 32,
        image: 'https://images.unsplash.com/photo-1552321554-5fefe8c9ef14?w=400&h=200&fit=crop'
      },
      { 
        name: 'Outdoor & Patio', 
        description: 'Durable tiles for external use',
        products: 28,
        image: 'https://images.unsplash.com/photo-1600585154340-be6161a56a0c?w=400&h=200&fit=crop'
      },
      { 
        name: 'Luxury Marble Effect', 
        description: 'Premium marble-look porcelain tiles',
        products: 24,
        image: 'https://images.unsplash.com/photo-1615971677499-5467cbab01c0?w=400&h=200&fit=crop'
      },
    ];

    return (
      <div className="space-y-6">
        {/* Admin View */}
        <div className="border-2 border-purple-200 rounded-lg p-6 bg-purple-50">
          <h3 className="font-bold text-lg mb-2 flex items-center gap-2">
            <Layers className="w-5 h-5 text-purple-600" />
            Admin View: Add to Collections
          </h3>
          <p className="text-sm text-gray-600 mb-4">
            Collections are curated groups you create. Add products to multiple collections for website display.
          </p>
          
          <div className="grid grid-cols-2 gap-3">
            {collections.map((col, idx) => (
              <label key={col.name} className="flex items-center gap-3 p-3 bg-white rounded-lg border cursor-pointer hover:border-purple-400">
                <input type="checkbox" defaultChecked={idx < 2} className="w-4 h-4 rounded" />
                <div>
                  <p className="font-medium text-sm">{col.name}</p>
                  <p className="text-xs text-gray-500">{col.products} products</p>
                </div>
              </label>
            ))}
          </div>
        </div>

        {/* Customer View */}
        <div className="border-2 border-green-200 rounded-lg p-6 bg-green-50">
          <h3 className="font-bold text-lg mb-4">Customer View: Shop by Collection</h3>
          
          <div className="grid grid-cols-2 gap-4">
            {collections.map(col => (
              <div key={col.name} className="bg-white rounded-lg overflow-hidden shadow hover:shadow-lg transition-shadow cursor-pointer">
                <img src={normaliseImageUrl(col.image)} alt={col.name} className="w-full h-32 object-cover" />
                <div className="p-4">
                  <h4 className="font-bold">{col.name}</h4>
                  <p className="text-sm text-gray-600">{col.description}</p>
                  <p className="text-xs text-gray-400 mt-2">{col.products} products</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    );
  };

  // Option C: Hierarchical Categories
  const HierarchicalDemo = () => {
    const hierarchy = [
      {
        name: 'By Room',
        icon: '🏠',
        children: ['Floor Tiles', 'Wall Tiles', 'Bathroom', 'Kitchen', 'Outdoor']
      },
      {
        name: 'By Finish',
        icon: '✨',
        children: ['Polished', 'Matt', 'Lappato', 'Satin', 'Anti-Slip', 'Textured']
      },
      {
        name: 'By Material',
        icon: '🪨',
        children: ['Porcelain', 'Ceramic', 'Natural Stone', 'Marble', 'Slate']
      },
      {
        name: 'By Style',
        icon: '🎨',
        children: ['Marble Effect', 'Wood Effect', 'Concrete Look', 'Pattern', 'Plain']
      }
    ];

    const [selectedCategories, setSelectedCategories] = useState({
      'By Room': ['Floor Tiles', 'Wall Tiles'],
      'By Finish': ['Polished'],
      'By Material': ['Porcelain'],
      'By Style': ['Marble Effect']
    });

    return (
      <div className="space-y-6">
        {/* Admin View */}
        <div className="border-2 border-orange-200 rounded-lg p-6 bg-orange-50">
          <h3 className="font-bold text-lg mb-2 flex items-center gap-2">
            <Grid3X3 className="w-5 h-5 text-orange-600" />
            Admin View: Multi-Level Categories
          </h3>
          <p className="text-sm text-gray-600 mb-4">
            Select categories from each level. Product appears in all selected categories.
          </p>
          
          <div className="grid grid-cols-2 gap-4">
            {hierarchy.map(group => (
              <div key={group.name} className="bg-white rounded-lg p-4 border">
                <h4 className="font-bold text-sm mb-3 flex items-center gap-2">
                  <span>{group.icon}</span> {group.name}
                </h4>
                <div className="flex flex-wrap gap-2">
                  {group.children.map(child => {
                    const isSelected = selectedCategories[group.name]?.includes(child);
                    return (
                      <button
                        key={child}
                        onClick={() => {
                          setSelectedCategories(prev => ({
                            ...prev,
                            [group.name]: isSelected
                              ? prev[group.name].filter(c => c !== child)
                              : [...(prev[group.name] || []), child]
                          }));
                        }}
                        className={`px-2 py-1 rounded text-xs font-medium transition-all ${
                          isSelected
                            ? 'bg-orange-500 text-white'
                            : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
                        }`}
                      >
                        {isSelected && <Check className="w-3 h-3 inline mr-1" />}
                        {child}
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Customer View - Mega Menu */}
        <div className="border-2 border-green-200 rounded-lg p-6 bg-green-50">
          <h3 className="font-bold text-lg mb-4">Customer View: Mega Menu Navigation</h3>
          
          {/* Mega Menu Demo */}
          <div className="bg-white rounded-lg shadow-lg overflow-hidden">
            <div className="bg-gray-900 text-white p-3 flex gap-6 text-sm">
              <span className="text-yellow-400 font-medium">Shop Tiles ▾</span>
              <span>Accessories</span>
              <span>Clearance</span>
              <span>Contact</span>
            </div>
            
            {/* Mega Menu Dropdown */}
            <div className="grid grid-cols-4 gap-6 p-6 border-t">
              {hierarchy.map(group => (
                <div key={group.name}>
                  <h5 className="font-bold text-sm text-gray-900 mb-3 flex items-center gap-2">
                    <span>{group.icon}</span> {group.name}
                  </h5>
                  <ul className="space-y-2">
                    {group.children.slice(0, 5).map(child => (
                      <li key={child} className="text-sm text-gray-600 hover:text-gray-900 cursor-pointer flex items-center gap-1">
                        <ChevronRight className="w-3 h-3" /> {child}
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          </div>

          {/* Sidebar Filter Demo */}
          <div className="mt-6">
            <h4 className="font-bold mb-3">Alternative: Sidebar Filters</h4>
            <div className="flex gap-4">
              <div className="w-48 bg-white rounded-lg p-4 shadow">
                <h5 className="font-bold text-sm mb-3">Filter by Finish</h5>
                {['Polished', 'Matt', 'Lappato', 'Anti-Slip'].map(f => (
                  <label key={f} className="flex items-center gap-2 text-sm py-1 cursor-pointer">
                    <input type="checkbox" defaultChecked={f === 'Polished'} className="rounded" />
                    {f}
                  </label>
                ))}
                
                <h5 className="font-bold text-sm mb-3 mt-4">Filter by Room</h5>
                {['Floor', 'Wall', 'Bathroom', 'Kitchen'].map(r => (
                  <label key={r} className="flex items-center gap-2 text-sm py-1 cursor-pointer">
                    <input type="checkbox" defaultChecked={r === 'Floor' || r === 'Wall'} className="rounded" />
                    {r}
                  </label>
                ))}
              </div>
              
              <div className="flex-1 bg-white rounded-lg p-4 shadow">
                <div className="flex items-center gap-2 mb-4">
                  <span className="text-sm text-gray-500">Active filters:</span>
                  {['Polished', 'Floor', 'Wall'].map(f => (
                    <span key={f} className="px-2 py-1 bg-orange-100 text-orange-700 rounded text-xs flex items-center gap-1">
                      {f} <X className="w-3 h-3 cursor-pointer" />
                    </span>
                  ))}
                </div>
                <div className="grid grid-cols-3 gap-3">
                  {[1, 2, 3].map(i => (
                    <div key={i} className="border rounded-lg p-2">
                      <div className="w-full h-20 bg-gray-200 rounded mb-2"></div>
                      <p className="text-xs font-medium truncate">Product {i}</p>
                      <p className="text-xs text-green-600">£45.99/m²</p>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  };

  return (
    <div className="p-6 max-w-6xl mx-auto space-y-8" data-testid="category-demo-page">
      <div className="text-center mb-8">
        <h1 className="text-3xl font-bold mb-2">Category System Options</h1>
        <p className="text-gray-600">Choose the best approach for your e-commerce website</p>
      </div>

      {/* Option Selection */}
      <div className="grid grid-cols-3 gap-4 mb-8">
        <button
          onClick={() => setSelectedOption('tags')}
          className={`p-6 rounded-xl border-2 transition-all text-left ${
            selectedOption === 'tags' 
              ? 'border-blue-500 bg-blue-50 shadow-lg' 
              : 'border-gray-200 hover:border-gray-300'
          }`}
        >
          <Tag className={`w-8 h-8 mb-3 ${selectedOption === 'tags' ? 'text-blue-500' : 'text-gray-400'}`} />
          <h3 className="font-bold text-lg">Option A: Tags System</h3>
          <p className="text-sm text-gray-600 mt-2">
            Flexible tags like "Floor Tiles", "Polished", "Marble Effect". 
            Product can have unlimited tags.
          </p>
          <div className="mt-3 flex flex-wrap gap-1">
            <span className="px-2 py-0.5 bg-blue-100 text-blue-700 rounded text-xs">Floor</span>
            <span className="px-2 py-0.5 bg-green-100 text-green-700 rounded text-xs">Wall</span>
            <span className="px-2 py-0.5 bg-purple-100 text-purple-700 rounded text-xs">Polished</span>
          </div>
        </button>

        <button
          onClick={() => setSelectedOption('collections')}
          className={`p-6 rounded-xl border-2 transition-all text-left ${
            selectedOption === 'collections' 
              ? 'border-purple-500 bg-purple-50 shadow-lg' 
              : 'border-gray-200 hover:border-gray-300'
          }`}
        >
          <Layers className={`w-8 h-8 mb-3 ${selectedOption === 'collections' ? 'text-purple-500' : 'text-gray-400'}`} />
          <h3 className="font-bold text-lg">Option B: Collections</h3>
          <p className="text-sm text-gray-600 mt-2">
            Curated collections like "Bathroom Essentials", "Luxury Marble". 
            Visual and marketing-focused.
          </p>
          <div className="mt-3 flex flex-wrap gap-1">
            <span className="px-2 py-0.5 bg-purple-100 text-purple-700 rounded text-xs">Living Room</span>
            <span className="px-2 py-0.5 bg-pink-100 text-pink-700 rounded text-xs">Bathroom</span>
          </div>
        </button>

        <button
          onClick={() => setSelectedOption('hierarchical')}
          className={`p-6 rounded-xl border-2 transition-all text-left ${
            selectedOption === 'hierarchical' 
              ? 'border-orange-500 bg-orange-50 shadow-lg' 
              : 'border-gray-200 hover:border-gray-300'
          }`}
        >
          <Grid3X3 className={`w-8 h-8 mb-3 ${selectedOption === 'hierarchical' ? 'text-orange-500' : 'text-gray-400'}`} />
          <h3 className="font-bold text-lg">Option C: Multi-Level</h3>
          <p className="text-sm text-gray-600 mt-2">
            Organized by type: Room, Finish, Material, Style. 
            Best for detailed filtering.
          </p>
          <div className="mt-3 flex flex-wrap gap-1">
            <span className="px-2 py-0.5 bg-orange-100 text-orange-700 rounded text-xs">By Room</span>
            <span className="px-2 py-0.5 bg-amber-100 text-amber-700 rounded text-xs">By Finish</span>
          </div>
        </button>
      </div>

      {/* Recommendation Banner */}
      <div className="bg-gradient-to-r from-green-500 to-teal-500 text-white rounded-xl p-6">
        <h3 className="font-bold text-lg mb-2">💡 My Recommendation</h3>
        <p className="text-green-100">
          <strong>Combine Option A (Tags) + Option C (Multi-Level Filters)</strong> - 
          Use tags for flexible categorization in the admin, and multi-level filters on the website. 
          This gives you the best of both worlds: easy product management AND powerful customer filtering.
        </p>
      </div>

      {/* Demo Content */}
      {selectedOption === 'tags' && <TagsDemo />}
      {selectedOption === 'collections' && <CollectionsDemo />}
      {selectedOption === 'hierarchical' && <HierarchicalDemo />}

      {!selectedOption && (
        <div className="text-center py-12 bg-gray-50 rounded-xl">
          <p className="text-gray-500">👆 Click an option above to see a detailed demo</p>
        </div>
      )}

      {/* Comparison Table */}
      <Card className="mt-8">
        <CardHeader>
          <CardTitle>Comparison Table</CardTitle>
        </CardHeader>
        <CardContent>
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b">
                <th className="text-left py-3">Feature</th>
                <th className="text-center py-3">Tags</th>
                <th className="text-center py-3">Collections</th>
                <th className="text-center py-3">Multi-Level</th>
              </tr>
            </thead>
            <tbody>
              <tr className="border-b">
                <td className="py-3">Multiple categories per product</td>
                <td className="text-center text-green-600">✓ Unlimited</td>
                <td className="text-center text-green-600">✓ Unlimited</td>
                <td className="text-center text-green-600">✓ Per level</td>
              </tr>
              <tr className="border-b">
                <td className="py-3">Easy for admin to manage</td>
                <td className="text-center text-green-600">✓ Very easy</td>
                <td className="text-center text-yellow-600">~ Moderate</td>
                <td className="text-center text-green-600">✓ Organized</td>
              </tr>
              <tr className="border-b">
                <td className="py-3">Customer navigation</td>
                <td className="text-center text-yellow-600">~ Good</td>
                <td className="text-center text-green-600">✓ Visual</td>
                <td className="text-center text-green-600">✓ Excellent</td>
              </tr>
              <tr className="border-b">
                <td className="py-3">Advanced filtering</td>
                <td className="text-center text-yellow-600">~ Basic</td>
                <td className="text-center text-red-600">✗ Limited</td>
                <td className="text-center text-green-600">✓ Powerful</td>
              </tr>
              <tr className="border-b">
                <td className="py-3">SEO friendly URLs</td>
                <td className="text-center text-green-600">✓ /tiles/floor</td>
                <td className="text-center text-green-600">✓ /collection/bathroom</td>
                <td className="text-center text-green-600">✓ /tiles/floor/polished</td>
              </tr>
              <tr>
                <td className="py-3 font-bold">Best for</td>
                <td className="text-center text-sm text-gray-600">Simple sites</td>
                <td className="text-center text-sm text-gray-600">Marketing focus</td>
                <td className="text-center text-sm text-gray-600">E-commerce</td>
              </tr>
            </tbody>
          </table>
        </CardContent>
      </Card>
    </div>
  );
}
