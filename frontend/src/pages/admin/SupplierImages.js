import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { useParams, useNavigate, useSearchParams } from 'react-router-dom';
import { X, Upload, Image, Trash2, RefreshCw, Plus, Check, ZoomIn, Package, CheckSquare, Square, Star, GripVertical, ArrowLeft, Search } from 'lucide-react';
import { toast } from 'sonner';

const API_URL = process.env.REACT_APP_BACKEND_URL;

export default function SupplierImages() {
  const { supplier } = useParams();
  const navigate = useNavigate();
  // Pre-fill filters from the URL query string when arriving from the
  // SupplierProducts "Upload Images" button. Without this the page
  // ignored the user's series + search filter and dumped the entire
  // 250-product catalogue, even when they came in with 20 specific
  // products selected.
  const [searchParams, setSearchParams] = useSearchParams();
  const supplierName = supplier || 'Unknown';
  
  const [products, setProducts] = useState([]);
  const [loading, setLoading] = useState(false);
  const [stats, setStats] = useState({ total: 0, withImages: 0, totalImages: 0 });
  const [productsBySize, setProductsBySize] = useState({});
  const [selectedSize, setSelectedSize] = useState('all');
  const [dragOverProduct, setDragOverProduct] = useState(null);
  const [zoomedImage, setZoomedImage] = useState(null);
  const [uploadingFor, setUploadingFor] = useState(null);
  const [deletingImages, setDeletingImages] = useState(new Set());
  
  // Search and filter state — initialise from URL query (?series=…&search=…)
  // so the page lands on the same view the user had on SupplierProducts.
  const [searchQuery, setSearchQuery] = useState(() => searchParams.get('search') || '');
  const [seriesFilter, setSeriesFilter] = useState(() => searchParams.get('series') || '');

  // Mirror the active filters back into the URL so:
  //  - F5 / hard refresh keeps the same view
  //  - Browser back button returns to the same view
  //  - The page can be deep-linked / bookmarked
  // Using `replace` to avoid cluttering the browser history.
  useEffect(() => {
    const next = new URLSearchParams();
    if (searchQuery) next.set('search', searchQuery);
    if (seriesFilter) next.set('series', seriesFilter);
    const nextStr = next.toString();
    const currentStr = searchParams.toString();
    if (nextStr !== currentStr) setSearchParams(next, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchQuery, seriesFilter]);
  
  // Bulk delete state for images
  const [selectedImages, setSelectedImages] = useState({}); // { productId: [imageUrl, imageUrl] }
  const [bulkDeleteMode, setBulkDeleteMode] = useState(false);
  
  // Image reorder state
  const [draggedImage, setDraggedImage] = useState(null); // { productId, index }
  
  const bulkInputRef = useRef(null);
  const scrollContainerRef = useRef(null);

  const fetchProducts = useCallback(async (preserveScroll = false) => {
    const scrollPosition = scrollContainerRef.current?.scrollTop || 0;
    setLoading(true);
    try {
      const token = localStorage.getItem('token');
      const response = await fetch(`${API_URL}/api/supplier-sync/products?supplier=${encodeURIComponent(supplierName)}&limit=500&_t=${Date.now()}`, {
        headers: { 
          'Authorization': `Bearer ${token}`,
          'Cache-Control': 'no-cache, no-store, must-revalidate',
          'Pragma': 'no-cache'
        }
      });
      if (response.ok) {
        const data = await response.json();
        const productList = data.products || [];
        setProducts(productList);
        
        // Calculate stats
        const withImages = productList.filter(p => p.images && p.images.length > 0).length;
        const totalImages = productList.reduce((sum, p) => sum + (p.images?.length || 0), 0);
        setStats({ total: productList.length, withImages, totalImages });
        
        // Group by size
        const bySize = {};
        productList.forEach(p => {
          const size = extractSize(p.name || p.product_name || '') || 'Other';
          if (!bySize[size]) {
            bySize[size] = { products: [], withImages: 0, totalImages: 0 };
          }
          bySize[size].products.push(p);
          if (p.images && p.images.length > 0) {
            bySize[size].withImages++;
            bySize[size].totalImages += p.images.length;
          }
        });
        setProductsBySize(bySize);
        
        // Restore scroll position
        if (preserveScroll && scrollContainerRef.current) {
          setTimeout(() => {
            scrollContainerRef.current.scrollTop = scrollPosition;
          }, 50);
        }
      }
    } catch (error) {
      console.error('Failed to fetch products:', error);
      toast.error('Failed to fetch products');
    } finally {
      setLoading(false);
    }
  }, [supplierName]);

  useEffect(() => {
    fetchProducts();
  }, [fetchProducts, supplierName]);

  const extractSize = (name) => {
    const sizeMatch = name.match(/(\d+)\s*x\s*(\d+)\s*(cm)?/i);
    if (sizeMatch) {
      return `${sizeMatch[1]}x${sizeMatch[2]}cm`;
    }
    return null;
  };

  // Extract series name from product name (first word)
  const getSeriesName = (product) => {
    const name = (product.product_name || product.name || '').trim();
    const firstWord = (name.split(/\s+/)[0] || '').trim().replace(/[^a-zA-Z0-9]/g, '');
    if (!firstWord) return '';
    return firstWord.charAt(0).toUpperCase() + firstWord.slice(1).toLowerCase();
  };

  // Get unique series with counts, sorted by count descending
  const seriesOptions = useMemo(() => {
    const seriesCounts = {};
    products.forEach(product => {
      const series = getSeriesName(product);
      if (series) {
        seriesCounts[series] = (seriesCounts[series] || 0) + 1;
      }
    });
    return Object.entries(seriesCounts)
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count);
  }, [products]);

  // Filter products by search query and series
  const filteredProducts = useMemo(() => {
    let filtered = products;

    // Apply search filter
    if (searchQuery.trim()) {
      const query = searchQuery.toLowerCase();
      filtered = filtered.filter(p => {
        const name = (p.product_name || p.name || '').toLowerCase();
        const sku = (p.sku || '').toLowerCase();
        const supplierProductName = (p.supplier_product_name || '').toLowerCase();
        return name.includes(query) || sku.includes(query) || supplierProductName.includes(query);
      });
    }

    // Apply series filter
    if (seriesFilter) {
      filtered = filtered.filter(p => getSeriesName(p) === seriesFilter);
    }

    return filtered;
  }, [products, searchQuery, seriesFilter]);

  // Group filtered products by size
  const filteredProductsBySize = useMemo(() => {
    const bySize = {};
    filteredProducts.forEach(p => {
      const size = extractSize(p.name || p.product_name || '') || 'Other';
      if (!bySize[size]) {
        bySize[size] = { products: [], withImages: 0, totalImages: 0 };
      }
      bySize[size].products.push(p);
      if (p.images && p.images.length > 0) {
        bySize[size].withImages++;
        bySize[size].totalImages += p.images.length;
      }
    });
    return bySize;
  }, [filteredProducts]);

  const handleDrop = async (e, productId) => {
    e.preventDefault();
    setDragOverProduct(null);
    
    const files = Array.from(e.dataTransfer.files).filter(f => f.type.startsWith('image/'));
    if (files.length === 0) return;
    
    await uploadImages(productId, files);
  };

  // Backend supports JPG/PNG/WEBP/GIF/TIF. Anything else (HEIC from
  // iPhones, AVIF, SVG, BMP, ICO) is rejected — surface it client-side
  // so the user gets one clear toast instead of one 400 per file.
  const SUPPORTED_TYPES = new Set([
    'image/jpeg', 'image/jpg', 'image/png',
    'image/webp', 'image/gif', 'image/tiff', 'image/tif',
  ]);
  const SUPPORTED_EXTS = new Set(['jpg', 'jpeg', 'png', 'webp', 'gif', 'tif', 'tiff']);

  const partitionImageFiles = (files) => {
    const accepted = [];
    const rejected = [];
    for (const f of Array.from(files)) {
      const type = (f.type || '').toLowerCase();
      const ext = (f.name || '').toLowerCase().split('.').pop();
      const ok = type.startsWith('image/') && (SUPPORTED_TYPES.has(type) || SUPPORTED_EXTS.has(ext));
      if (ok) accepted.push(f);
      else rejected.push(f);
    }
    return { accepted, rejected };
  };

  const warnRejectedFiles = (rejected) => {
    if (rejected.length === 0) return;
    const names = rejected.slice(0, 3).map(f => f.name).join(', ');
    const rest = rejected.length > 3 ? ` (+${rejected.length - 3} more)` : '';
    toast.error(
      `Skipped ${rejected.length} unsupported file${rejected.length > 1 ? 's' : ''}: ${names}${rest}. ` +
      `Supported: JPG, PNG, WEBP, GIF, TIF/TIFF. (HEIC/AVIF not supported — convert first.)`
    );
  };

  const handleFileSelect = async (productId, files) => {
    const { accepted, rejected } = partitionImageFiles(files);
    warnRejectedFiles(rejected);
    if (accepted.length === 0) return;
    await uploadImages(productId, accepted);
  };

  const uploadImages = async (productId, files) => {
    setUploadingFor(productId);
    let uploadedCount = 0;
    
    for (const file of files) {
      const formData = new FormData();
      formData.append('image', file);
      formData.append('product_id', productId);
      formData.append('supplier', supplierName);

      try {
        const token = localStorage.getItem('token');
        const response = await fetch(`${API_URL}/api/supplier-sync/upload-product-image`, {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${token}` },
          body: formData
        });

        // Clone the response BEFORE reading. The Emergent preview's
        // error-capture script (emergent-main.js) consumes the body of
        // failed responses for logging — leaving the original stream
        // empty. Without this clone, .json() throws "body stream already
        // read" instead of giving us the real backend error.
        // On production (Railway) emergent-main.js isn't loaded so this
        // is a no-op — but it makes preview-mode debugging actually work.
        let payload = null;
        try {
          payload = await response.clone().json();
        } catch {
          try {
            payload = { detail: await response.clone().text() };
          } catch {
            payload = null;
          }
        }

        if (!response.ok) {
          const detail = payload?.detail || `Upload failed (HTTP ${response.status})`;
          // Friendlier copy for the most common backend reason —
          // unsupported image type (HEIC, AVIF etc. on iPhone).
          if (response.status === 400 && /file type|invalid|format/i.test(detail)) {
            toast.error(`${file.name}: ${detail}. Please convert to JPG, PNG, WEBP or TIFF.`);
          } else {
            toast.error(`${file.name}: ${detail}`);
          }
        } else {
          uploadedCount++;
          // Optimistically update the local state with the new image
          if (payload?.image_url) {
            setProducts(prev => prev.map(p => {
              if (p._id === productId) {
                return { ...p, images: [...(p.images || []), payload.image_url] };
              }
              return p;
            }));
          }
        }
      } catch (error) {
        console.error('Upload failed:', error);
        toast.error(`${file.name}: upload failed — ${error.message || 'check connection'}`);
      }
    }
    
    setUploadingFor(null);
    if (uploadedCount > 0) {
      toast.success(`${uploadedCount} image(s) uploaded`);
      // Small delay then refresh to ensure DB write is complete
      setTimeout(() => fetchProducts(true), 500);
    }
  };

  const handleBulkUpload = async (files) => {
    const { accepted: imageFiles, rejected } = partitionImageFiles(files);
    warnRejectedFiles(rejected);
    if (imageFiles.length === 0) return;

    toast.info(`Processing ${imageFiles.length} images for auto-matching...`);
    
    // Try to auto-match based on filename
    for (const file of imageFiles) {
      const filename = file.name.toLowerCase().replace(/\.[^/.]+$/, '');
      const matchedProduct = products.find(p => {
        const productName = (p.name || p.product_name || '').toLowerCase();
        const sku = (p.sku || '').toLowerCase();
        return productName.includes(filename) || sku.includes(filename) || filename.includes(sku);
      });

      if (matchedProduct) {
        await uploadImages(matchedProduct._id, [file]);
      } else {
        toast.warning(`No match found for: ${file.name}`);
      }
    }
  };

  // Single image delete - optimistic update, no full refresh
  const handleDeleteImage = async (productId, imageUrl, e) => {
    e?.stopPropagation();
    
    // Mark as deleting
    setDeletingImages(prev => new Set([...prev, imageUrl]));
    
    // Optimistic update - remove from UI immediately
    setProducts(prev => prev.map(p => {
      if (p._id === productId) {
        return { ...p, images: (p.images || []).filter(img => img !== imageUrl) };
      }
      return p;
    }));

    try {
      const token = localStorage.getItem('token');
      const response = await fetch(`${API_URL}/api/supplier-sync/delete-product-image`, {
        method: 'DELETE',
        headers: { 
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ product_id: productId, image_url: imageUrl })
      });

      if (response.ok) {
        toast.success('Image deleted');
        // Update stats
        setStats(prev => ({ ...prev, totalImages: prev.totalImages - 1 }));
      } else {
        // Revert on failure
        toast.error('Failed to delete image');
        fetchProducts(true);
      }
    } catch (error) {
      toast.error('Failed to delete image');
      fetchProducts(true);
    } finally {
      setDeletingImages(prev => {
        const next = new Set(prev);
        next.delete(imageUrl);
        return next;
      });
    }
  };

  // Image reorder handlers
  const handleImageDragStart = (e, productId, index) => {
    setDraggedImage({ productId, index });
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/html', e.target.outerHTML);
  };

  const handleImageDragEnd = () => {
    setDraggedImage(null);
  };

  const handleImageDragOver = (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
  };

  const handleImageDrop = async (e, productId, dropIndex) => {
    e.preventDefault();
    if (!draggedImage || draggedImage.productId !== productId || draggedImage.index === dropIndex) {
      setDraggedImage(null);
      return;
    }

    // Get the product
    const product = products.find(p => p._id === productId);
    if (!product || !product.images) return;

    // Reorder images locally
    const newImages = [...product.images];
    const [draggedImg] = newImages.splice(draggedImage.index, 1);
    newImages.splice(dropIndex, 0, draggedImg);

    // Optimistic update
    setProducts(prev => prev.map(p => {
      if (p._id === productId) {
        return { ...p, images: newImages };
      }
      return p;
    }));

    // Save to backend
    try {
      const token = localStorage.getItem('token');
      const response = await fetch(`${API_URL}/api/supplier-sync/reorder-images`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ product_id: productId, images: newImages })
      });

      if (response.ok) {
        toast.success(dropIndex === 0 ? 'Primary image updated' : 'Image order updated');
      } else {
        toast.error('Failed to save image order');
        fetchProducts(true);
      }
    } catch (error) {
      toast.error('Failed to save image order');
      fetchProducts(true);
    }

    setDraggedImage(null);
  };

  const handleSetPrimaryImage = async (productId, index) => {
    if (index === 0) return;

    const product = products.find(p => p._id === productId);
    if (!product || !product.images) return;

    const newImages = [...product.images];
    const [primaryImg] = newImages.splice(index, 1);
    newImages.unshift(primaryImg);

    // Optimistic update
    setProducts(prev => prev.map(p => {
      if (p._id === productId) {
        return { ...p, images: newImages };
      }
      return p;
    }));

    // Save to backend
    try {
      const token = localStorage.getItem('token');
      const response = await fetch(`${API_URL}/api/supplier-sync/reorder-images`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ product_id: productId, images: newImages })
      });

      if (response.ok) {
        toast.success('Primary image updated');
      } else {
        toast.error('Failed to update primary image');
        fetchProducts(true);
      }
    } catch (error) {
      toast.error('Failed to update primary image');
      fetchProducts(true);
    }
  };

  // Toggle image selection for bulk delete
  const toggleImageSelection = (productId, imageUrl) => {
    setSelectedImages(prev => {
      const productImages = prev[productId] || [];
      if (productImages.includes(imageUrl)) {
        const updated = productImages.filter(img => img !== imageUrl);
        if (updated.length === 0) {
          const { [productId]: _, ...rest } = prev;
          return rest;
        }
        return { ...prev, [productId]: updated };
      } else {
        return { ...prev, [productId]: [...productImages, imageUrl] };
      }
    });
  };

  // Select all images for a product
  const selectAllProductImages = (productId, images) => {
    setSelectedImages(prev => ({
      ...prev,
      [productId]: [...images]
    }));
  };

  // Deselect all images for a product
  const deselectAllProductImages = (productId) => {
    setSelectedImages(prev => {
      const { [productId]: _, ...rest } = prev;
      return rest;
    });
  };

  // Get total selected count
  const getTotalSelectedCount = () => {
    return Object.values(selectedImages).reduce((sum, imgs) => sum + imgs.length, 0);
  };

  // Bulk delete selected images
  const handleBulkDelete = async () => {
    const totalCount = getTotalSelectedCount();
    if (totalCount === 0) return;
    
    if (!window.confirm(`Delete ${totalCount} selected image(s)?`)) return;

    // Get all images to delete
    const deletePromises = [];
    const imagesToDelete = [];
    
    Object.entries(selectedImages).forEach(([productId, images]) => {
      images.forEach(imageUrl => {
        imagesToDelete.push({ productId, imageUrl });
      });
    });

    // Optimistic update - remove all from UI immediately
    setProducts(prev => prev.map(p => {
      const imagesToRemove = selectedImages[p._id] || [];
      if (imagesToRemove.length > 0) {
        return { ...p, images: (p.images || []).filter(img => !imagesToRemove.includes(img)) };
      }
      return p;
    }));

    // Clear selections
    setSelectedImages({});
    setBulkDeleteMode(false);

    // Delete all in parallel
    const token = localStorage.getItem('token');
    let successCount = 0;
    let failCount = 0;

    await Promise.all(imagesToDelete.map(async ({ productId, imageUrl }) => {
      try {
        const response = await fetch(`${API_URL}/api/supplier-sync/delete-product-image`, {
          method: 'DELETE',
          headers: { 
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ product_id: productId, image_url: imageUrl })
        });
        if (response.ok) {
          successCount++;
        } else {
          failCount++;
        }
      } catch (error) {
        failCount++;
      }
    }));

    // Update stats
    setStats(prev => ({ ...prev, totalImages: prev.totalImages - successCount }));

    if (failCount === 0) {
      toast.success(`Deleted ${successCount} image(s)`);
    } else {
      toast.warning(`Deleted ${successCount}, failed ${failCount}`);
      fetchProducts(true); // Refresh to get accurate state
    }
  };

  const handleStockStatusChange = async (productId, status) => {
    try {
      const token = localStorage.getItem('token');
      const response = await fetch(`${API_URL}/api/supplier-sync/update-product-stock-status`, {
        method: 'PUT',
        headers: { 
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ 
          product_id: productId, 
          stock_status: status,
          in_stock: status === 'in_stock' || status === 'always_in_stock'
        })
      });

      if (response.ok) {
        toast.success('Stock status updated');
        setProducts(prev => prev.map(p => 
          p._id === productId ? { ...p, stock_status: status, in_stock: status === 'in_stock' || status === 'always_in_stock' } : p
        ));
      } else {
        toast.error('Failed to update stock status');
      }
    } catch (error) {
      toast.error('Failed to update stock status');
    }
  };

  // Apply size filter on top of search/series filtered products
  const displayProducts = selectedSize === 'all' 
    ? filteredProducts 
    : filteredProducts.filter(p => {
        const size = extractSize(p.name || p.product_name || '') || 'Other';
        return size === selectedSize;
      });

  const goBack = () => {
    window.history.back();
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-xl shadow-2xl w-full max-w-6xl h-[90vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b">
          <div className="flex items-center gap-3">
            <button
              onClick={() => navigate('/admin/supplier-products?supplier=' + encodeURIComponent(supplierName))}
              className="p-2 hover:bg-gray-100 rounded-lg transition-colors"
              title="Back to products"
            >
              <ArrowLeft className="w-5 h-5 text-gray-500" />
            </button>
            <Package className="w-6 h-6 text-emerald-600" />
            <div>
              <h1 className="text-xl font-bold text-gray-900">{supplierName} Images</h1>
              <p className="text-sm text-gray-500">
                {stats.withImages} of {stats.total} products have images ({stats.totalImages} total images)
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {/* Bulk Delete Toggle */}
            <button
              onClick={() => {
                setBulkDeleteMode(!bulkDeleteMode);
                if (bulkDeleteMode) setSelectedImages({});
              }}
              className={`px-3 py-1.5 rounded-lg text-sm font-medium flex items-center gap-2 ${
                bulkDeleteMode 
                  ? 'bg-red-100 text-red-700 border border-red-300' 
                  : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
              }`}
            >
              <Trash2 className="w-4 h-4" />
              {bulkDeleteMode ? 'Cancel Selection' : 'Bulk Delete'}
            </button>
            
            {/* Bulk Delete Action */}
            {bulkDeleteMode && getTotalSelectedCount() > 0 && (
              <button
                onClick={handleBulkDelete}
                className="px-3 py-1.5 rounded-lg text-sm font-medium bg-red-600 text-white hover:bg-red-700 flex items-center gap-2"
              >
                <Trash2 className="w-4 h-4" />
                Delete {getTotalSelectedCount()} Selected
              </button>
            )}
            
            <button onClick={goBack} className="p-2 hover:bg-gray-100 rounded-full">
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        <div className="flex flex-1 overflow-hidden">
          {/* Left Sidebar - Products by Size */}
          <div className="w-64 border-r bg-gray-50 p-4 overflow-y-auto">
            <h3 className="font-semibold text-gray-700 mb-3 flex items-center gap-2">
              <Package className="w-4 h-4" />
              Products by Size
            </h3>
            
            <button
              onClick={() => setSelectedSize('all')}
              className={`w-full text-left p-2 rounded-lg mb-2 ${selectedSize === 'all' ? 'bg-emerald-100 text-emerald-700' : 'hover:bg-gray-100'}`}
            >
              All Sizes ({filteredProducts.length})
            </button>

            {Object.entries(filteredProductsBySize).sort().map(([size, data]) => {
              const progress = data.products.length > 0 ? (data.withImages / data.products.length) * 100 : 0;
              const isComplete = progress === 100;
              const missing = data.products.length - data.withImages;
              
              return (
                <button
                  key={size}
                  onClick={() => setSelectedSize(size)}
                  className={`w-full text-left p-3 rounded-lg mb-2 ${selectedSize === size ? 'bg-emerald-100 border border-emerald-300' : 'hover:bg-gray-100 border border-transparent'}`}
                >
                  <div className="font-medium text-sm">{size}</div>
                  <div className="text-xs text-gray-500 mt-1">
                    {data.products.length} products • {data.totalImages} images
                  </div>
                  <div className="mt-2 h-1.5 bg-gray-200 rounded-full overflow-hidden">
                    <div 
                      className={`h-full ${isComplete ? 'bg-green-500' : 'bg-emerald-500'}`}
                      style={{ width: `${progress}%` }}
                    />
                  </div>
                  {missing > 0 && (
                    <span className="text-xs text-orange-600 mt-1 inline-block">{missing} missing</span>
                  )}
                </button>
              );
            })}
          </div>

          {/* Center - Products List */}
          <div ref={scrollContainerRef} className="flex-1 overflow-y-auto p-4">
            {/* Search and Filter Row */}
            <div className="mb-4 flex items-center gap-3">
              {/* Search Box */}
              <div className="relative flex-1 max-w-md">
                <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 w-4 h-4 text-gray-400" />
                <input
                  type="text"
                  placeholder="Search by name, code, or category..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="w-full pl-10 pr-4 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500 focus:border-transparent"
                />
                {searchQuery && (
                  <button
                    onClick={() => setSearchQuery('')}
                    className="absolute right-3 top-1/2 transform -translate-y-1/2 text-gray-400 hover:text-gray-600"
                  >
                    <X className="w-4 h-4" />
                  </button>
                )}
              </div>

              {/* Series Filter */}
              <select
                value={seriesFilter}
                onChange={(e) => setSeriesFilter(e.target.value)}
                className="px-3 py-2 border border-gray-300 rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:ring-emerald-500 min-w-[160px]"
              >
                <option value="">All Series ({seriesOptions.length})</option>
                {seriesOptions.map(({ name, count }) => (
                  <option key={name} value={name}>
                    {name} ({count})
                  </option>
                ))}
              </select>
            </div>

            <div className="flex items-center justify-between mb-4">
              <h2 className="font-semibold text-gray-700 flex items-center gap-2">
                <Package className="w-4 h-4" />
                Products ({displayProducts.length})
                {(searchQuery || seriesFilter || selectedSize !== 'all') && (
                  <span className="text-xs text-gray-400 font-normal">
                    (filtered from {products.length})
                  </span>
                )}
              </h2>
              <button 
                onClick={() => fetchProducts()}
                disabled={loading}
                className="flex items-center gap-2 px-3 py-1.5 text-sm bg-gray-100 hover:bg-gray-200 rounded-lg"
              >
                <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
                Refresh
              </button>
            </div>

            {bulkDeleteMode && (
              <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">
                Click on images to select them for bulk deletion. Click "Delete Selected" when ready.
              </div>
            )}

            {loading ? (
              <div className="flex justify-center py-12">
                <RefreshCw className="w-8 h-8 animate-spin text-gray-400" />
              </div>
            ) : (
              <div className="space-y-3">
                {displayProducts.map(product => {
                  const productSelectedImages = selectedImages[product._id] || [];
                  const allSelected = product.images?.length > 0 && productSelectedImages.length === product.images.length;
                  
                  return (
                    <div
                      key={product._id || product.sku}
                      className={`border rounded-xl p-4 transition-all ${
                        dragOverProduct === product._id 
                          ? 'border-emerald-500 bg-emerald-50 ring-2 ring-emerald-200' 
                          : 'border-gray-200 hover:border-gray-300 hover:shadow-sm'
                      }`}
                      onDragOver={(e) => { e.preventDefault(); setDragOverProduct(product._id); }}
                      onDragLeave={() => setDragOverProduct(null)}
                      onDrop={(e) => handleDrop(e, product._id)}
                    >
                      {/* Product Header */}
                      <div className="flex items-center justify-between mb-3">
                        <div>
                          <h3 className="font-semibold text-gray-900">
                            {product.product_name || product.name || 'Unnamed Product'}
                          </h3>
                          <p className="text-sm text-gray-500">
                            <span className="inline-flex items-center gap-1">
                              <span className="bg-emerald-100 text-emerald-700 text-xs font-medium px-1.5 py-0.5 rounded">
                                {product.supplier || supplierName}
                              </span>
                              <span className="text-gray-400">:</span>
                              <span className="text-gray-600 truncate max-w-[200px]" title={product.supplier_product_name || product.name || ''}>
                                {product.supplier_product_name || product.name || 'N/A'}
                              </span>
                            </span>
                          </p>
                          <p className="text-xs text-gray-400 mt-0.5">
                            {product.size || extractSize(product.name || product.product_name || '') || 'Size N/A'}
                            {product.finish && ` • ${product.finish}`}
                          </p>
                        </div>
                        <div className="flex items-center gap-2">
                          {/* Select All / Deselect All for bulk delete */}
                          {bulkDeleteMode && product.images?.length > 0 && (
                            <button
                              onClick={() => allSelected ? deselectAllProductImages(product._id) : selectAllProductImages(product._id, product.images)}
                              className="text-xs px-2 py-1 rounded bg-gray-100 hover:bg-gray-200 text-gray-600"
                            >
                              {allSelected ? 'Deselect All' : 'Select All'}
                            </button>
                          )}
                          
                          {/* Stock Status */}
                          <select
                            className="text-xs border rounded px-2 py-1 bg-green-500 text-white font-medium"
                            value={product.stock_status || (product.in_stock ? 'in_stock' : 'out_of_stock')}
                            onChange={(e) => handleStockStatusChange(product._id, e.target.value)}
                          >
                            <option value="in_stock">In Stock</option>
                            <option value="always_in_stock">Always In Stock</option>
                            <option value="out_of_stock">Out of Stock</option>
                          </select>
                          
                          {/* Add Images */}
                          <label className="cursor-pointer">
                            <span className="text-sm text-emerald-600 hover:text-emerald-700 hover:underline flex items-center gap-1 font-medium bg-emerald-50 px-2 py-1 rounded">
                              {uploadingFor === product._id ? (
                                <RefreshCw className="w-3 h-3 animate-spin" />
                              ) : (
                                <Plus className="w-3 h-3" />
                              )}
                              Add Images
                            </span>
                            <input
                              type="file"
                              multiple
                              accept=".jpg,.jpeg,.png,.webp,.gif,.tif,.tiff,image/jpeg,image/png,image/webp,image/gif,image/tiff"
                              className="hidden"
                              onChange={(e) => handleFileSelect(product._id, e.target.files)}
                              disabled={uploadingFor === product._id}
                            />
                          </label>
                        </div>
                      </div>

                      {/* Images Grid */}
                      <div className="flex flex-wrap gap-2">
                        {product.images && product.images.length > 0 ? (
                          product.images.map((img, idx) => {
                            const isSelected = productSelectedImages.includes(img);
                            const isDeleting = deletingImages.has(img);
                            const isDragging = draggedImage?.productId === product._id && draggedImage?.index === idx;
                            const isDropTarget = draggedImage?.productId === product._id && draggedImage?.index !== idx;
                            
                            return (
                              <div
                                key={idx}
                                className={`relative group ${isDeleting ? 'opacity-50' : ''} ${
                                  isDragging ? 'opacity-50 scale-95' : ''
                                } ${isDropTarget ? 'ring-2 ring-blue-400 ring-dashed' : ''}`}
                                draggable={!bulkDeleteMode}
                                onDragStart={(e) => !bulkDeleteMode && handleImageDragStart(e, product._id, idx)}
                                onDragEnd={handleImageDragEnd}
                                onDragOver={handleImageDragOver}
                                onDrop={(e) => handleImageDrop(e, product._id, idx)}
                              >
                                <img
                                  src={img}
                                  alt=""
                                  className={`w-20 h-20 object-cover rounded-lg border-2 cursor-grab active:cursor-grabbing transition-all ${
                                    isSelected 
                                      ? 'border-red-500 ring-2 ring-red-300' 
                                      : idx === 0 
                                        ? 'border-green-500 ring-2 ring-green-200'
                                        : 'border-gray-200 hover:border-emerald-400'
                                  }`}
                                  onError={(e) => { e.target.src = '/placeholder-image.png'; }}
                                  onClick={(e) => {
                                    if (bulkDeleteMode) {
                                      toggleImageSelection(product._id, img);
                                    } else {
                                      setZoomedImage(img);
                                    }
                                  }}
                                />
                                
                                {/* Primary badge */}
                                {idx === 0 && !bulkDeleteMode && (
                                  <span className="absolute -top-1 -left-1 bg-green-500 text-white text-[10px] px-1.5 py-0.5 rounded font-bold">
                                    Primary
                                  </span>
                                )}
                                
                                {/* Position number for non-primary */}
                                {idx > 0 && !bulkDeleteMode && (
                                  <span className="absolute -top-1 -left-1 bg-gray-500 text-white text-[10px] px-1.5 py-0.5 rounded font-bold">
                                    {idx + 1}
                                  </span>
                                )}
                                
                                {/* Selection checkbox in bulk mode */}
                                {bulkDeleteMode && (
                                  <div className={`absolute top-1 left-1 w-5 h-5 rounded flex items-center justify-center ${
                                    isSelected ? 'bg-red-500' : 'bg-white/80'
                                  }`}>
                                    {isSelected ? (
                                      <Check className="w-3 h-3 text-white" />
                                    ) : (
                                      <Square className="w-3 h-3 text-gray-400" />
                                    )}
                                  </div>
                                )}
                                
                                {/* Hover actions (non-bulk mode) */}
                                {!bulkDeleteMode && (
                                  <div className="absolute inset-0 bg-black/0 hover:bg-black/40 transition-opacity flex items-center justify-center gap-1 opacity-0 hover:opacity-100 rounded-lg">
                                    {/* Set as primary button */}
                                    {idx !== 0 && (
                                      <button
                                        onClick={(e) => {
                                          e.stopPropagation();
                                          handleSetPrimaryImage(product._id, idx);
                                        }}
                                        className="p-1.5 bg-green-500 text-white rounded hover:bg-green-600"
                                        title="Set as primary"
                                      >
                                        <Star className="w-3 h-3" />
                                      </button>
                                    )}
                                    {/* Delete button */}
                                    <button
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        handleDeleteImage(product._id, img, e);
                                      }}
                                      disabled={isDeleting}
                                      className="p-1.5 bg-red-500 text-white rounded hover:bg-red-600"
                                      title="Delete image"
                                    >
                                      <Trash2 className="w-3 h-3" />
                                    </button>
                                  </div>
                                )}
                              </div>
                            );
                          })
                        ) : (
                          <div className="w-20 h-20 bg-gray-100 rounded-lg flex items-center justify-center border-2 border-dashed border-gray-300">
                            <span className="text-xs text-gray-400">No images</span>
                          </div>
                        )}
                      </div>
                      
                      {/* Drag hint */}
                      {product.images && product.images.length > 1 && !bulkDeleteMode && (
                        <p className="text-xs text-gray-400 mt-2 flex items-center gap-1">
                          <GripVertical className="w-3 h-3" />
                          Drag to reorder • First image = Primary
                        </p>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* Right Sidebar - Bulk Upload */}
          <div className="w-64 border-l bg-gray-50 p-4">
            <h3 className="font-semibold text-gray-700 flex items-center gap-2 mb-4">
              <Upload className="w-4 h-4" />
              Bulk Upload
            </h3>

            <div
              className="border-2 border-dashed border-gray-300 rounded-xl p-6 text-center hover:border-emerald-400 hover:bg-emerald-50 transition-colors cursor-pointer"
              onClick={() => bulkInputRef.current?.click()}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault();
                handleBulkUpload(e.dataTransfer.files);
              }}
            >
              <Upload className="w-10 h-10 mx-auto text-gray-400 mb-2" />
              <p className="font-medium text-gray-700 text-sm">Drag & drop</p>
              <p className="text-xs text-gray-500">or click to select</p>
              <input
                ref={bulkInputRef}
                type="file"
                multiple
                accept=".jpg,.jpeg,.png,.webp,.gif,.tif,.tiff,image/jpeg,image/png,image/webp,image/gif,image/tiff"
                className="hidden"
                onChange={(e) => handleBulkUpload(e.target.files)}
              />
            </div>

            <div className="mt-4 p-3 bg-emerald-50 border border-emerald-200 rounded-lg">
              <p className="text-xs text-emerald-700">
                <strong>Tip:</strong> Name files like<br/>
                <code className="bg-emerald-100 px-1 rounded">Carrara_White.jpg</code><br/>
                for auto-matching
              </p>
            </div>
          </div>
        </div>
      </div>

      {/* Image Zoom Modal */}
      {zoomedImage && (
        <div 
          className="fixed inset-0 bg-black/90 flex items-center justify-center z-[60]"
          onClick={() => setZoomedImage(null)}
        >
          <button 
            className="absolute top-4 right-4 text-white hover:text-gray-300"
            onClick={() => setZoomedImage(null)}
          >
            <X className="w-8 h-8" />
          </button>
          <img 
            src={zoomedImage} 
            alt="Zoomed" 
            className="max-w-[90vw] max-h-[90vh] object-contain"
            onClick={(e) => e.stopPropagation()}
          />
        </div>
      )}
    </div>
  );
}
