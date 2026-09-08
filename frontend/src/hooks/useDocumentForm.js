import { useState, useEffect, useCallback } from 'react';
import { api } from '../lib/api';
import { toast } from 'sonner';

/**
 * Shared hook for document form state management (Invoice/Quotation)
 * Handles products, showrooms, customers loading and store selection
 */
export const useDocumentFormData = (user) => {
  const [products, setProducts] = useState([]);
  const [customers, setCustomers] = useState([]);
  const [showrooms, setShowrooms] = useState([]);
  const [selectedStore, setSelectedStore] = useState(null);
  const [loading, setLoading] = useState(true);

  // Filter showrooms based on user role
  const canFreelySwitchStores = user?.role === 'super_admin' || user?.role === 'admin' || user?.role === 'manager';
  
  const availableStores = showrooms.filter(showroom => {
    if (user?.role === 'super_admin' || user?.role === 'admin' || user?.role === 'manager') {
      return true;
    }
    if (user?.showroom_id) {
      return showroom.id === user.showroom_id;
    }
    return false;
  });

  // Fetch initial data
  const fetchData = useCallback(async () => {
    try {
      const [productsRes, customersRes, showroomsRes] = await Promise.all([
        api.getProducts(),
        api.getCustomers().catch(() => ({ data: [] })),
        api.getStores().catch(() => ({ data: [] }))
      ]);
      setProducts(productsRes.data);
      setCustomers(customersRes.data || []);
      setShowrooms(showroomsRes.data || []);
      
      // Set default store based on user assignment
      if (showroomsRes.data?.length > 0) {
        let defaultStore;
        if (user?.showroom_id) {
          defaultStore = showroomsRes.data.find(s => s.id === user.showroom_id);
        }
        if (!defaultStore) {
          defaultStore = showroomsRes.data[0];
        }
        setSelectedStore(defaultStore);
      }
    } catch (error) {
      toast.error('Failed to load data');
    } finally {
      setLoading(false);
    }
  }, [user?.showroom_id]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  return {
    products,
    customers,
    showrooms,
    selectedStore,
    setSelectedStore,
    loading,
    canFreelySwitchStores,
    availableStores,
    refetchData: fetchData
  };
};

/**
 * Shared hook for PIN verification
 */
export const usePinVerification = () => {
  const [showPinDialog, setShowPinDialog] = useState(false);
  const [staffPin, setStaffPin] = useState('');
  const [verifiedStaff, setVerifiedStaff] = useState(null);
  const [verifyingPin, setVerifyingPin] = useState(false);

  const verifyPin = useCallback(async (onSuccess) => {
    if (!staffPin || staffPin.length < 4) {
      toast.error('Please enter a valid PIN');
      return false;
    }
    
    setVerifyingPin(true);
    try {
      const res = await api.verifyStaffPin(staffPin);
      if (res.data?.valid || res.data?.verified) {
        setVerifiedStaff(res.data);
        setShowPinDialog(false);
        setStaffPin('');
        toast.success(`PIN verified for ${res.data.staff_name || res.data.name}`);
        if (onSuccess) {
          await onSuccess(res.data);
        }
        return true;
      } else {
        toast.error('Invalid PIN');
        return false;
      }
    } catch (error) {
      toast.error('PIN verification failed');
      return false;
    } finally {
      setVerifyingPin(false);
    }
  }, [staffPin]);

  const resetPin = useCallback(() => {
    setStaffPin('');
    setVerifiedStaff(null);
  }, []);

  return {
    showPinDialog,
    setShowPinDialog,
    staffPin,
    setStaffPin,
    verifiedStaff,
    setVerifiedStaff,
    verifyingPin,
    verifyPin,
    resetPin
  };
};

/**
 * Shared hook for line items management
 */
export const useLineItems = (initialItems = []) => {
  const [lineItems, setLineItems] = useState(initialItems);
  const [searchTerm, setSearchTerm] = useState('');
  const [activeLineIndex, setActiveLineIndex] = useState(null);

  const updateLineItem = useCallback((index, field, value) => {
    setLineItems(prev => {
      const newItems = [...prev];
      newItems[index] = { ...newItems[index], [field]: value };
      return newItems;
    });
  }, []);

  const addLineItem = useCallback((emptyItem) => {
    setLineItems(prev => [...prev, { ...emptyItem }]);
  }, []);

  const removeLineItem = useCallback((index) => {
    setLineItems(prev => {
      if (prev.length <= 1) return prev;
      return prev.filter((_, i) => i !== index);
    });
  }, []);

  const selectProduct = useCallback((index, product) => {
    setLineItems(prev => {
      const newItems = [...prev];
      newItems[index] = {
        ...newItems[index],
        productId: product.id,
        product: product.name,
        sku: product.sku || '',
        price: product.price?.toString() || '',
        duePrice: product.price?.toString() || '',
        stock: product.stock || 0,
        tile_m2_per_piece: product.tile_m2_per_piece || null,
        tiles_per_box: product.tiles_per_box || null,
        box_m2_coverage: product.box_m2_coverage || null,
        max_discount: product.max_discount || null
      };
      // Auto-calculate m² if qty exists
      if (product.tile_m2_per_piece && newItems[index].qty) {
        const qty = parseFloat(newItems[index].qty) || 0;
        newItems[index].m2 = (qty * product.tile_m2_per_piece).toFixed(2);
      }
      return newItems;
    });
    setActiveLineIndex(null);
    setSearchTerm('');
  }, []);

  const resetLineItems = useCallback((emptyItem) => {
    setLineItems([{ ...emptyItem }]);
  }, []);

  return {
    lineItems,
    setLineItems,
    searchTerm,
    setSearchTerm,
    activeLineIndex,
    setActiveLineIndex,
    updateLineItem,
    addLineItem,
    removeLineItem,
    selectProduct,
    resetLineItems
  };
};

/**
 * Calculate line item total
 */
export const calculateLineTotal = (item) => {
  const qty = parseFloat(item.qty) || 0;
  const price = parseFloat(item.price) || 0;
  const duePrice = parseFloat(item.duePrice) || price;
  const listTotal = qty * price;
  const due = qty * duePrice;
  const savings = listTotal - due;
  const discountPercent = price > 0 ? ((price - duePrice) / price) * 100 : 0;
  
  return { listTotal, due, savings, discountPercent, duePrice };
};

/**
 * Calculate totals for document
 */
export const calculateTotals = (lineItems) => {
  let totalDue = 0;
  let totalList = 0;
  
  lineItems.forEach(item => {
    const calc = calculateLineTotal(item);
    totalDue += calc.due;
    totalList += calc.listTotal;
  });
  
  const totalSavings = totalList - totalDue;
  const vat = totalDue * 0.2;
  const grossTotal = totalDue + vat;
  
  return { totalDue, totalList, totalSavings, vat, grossTotal, subtotal: totalDue };
};

/**
 * Get box info for a product
 */
export const getBoxInfo = (item) => {
  if (!item.tiles_per_box || !item.tile_m2_per_piece) return null;
  
  const qty = parseFloat(item.qty) || 0;
  const tilesPerBox = item.tiles_per_box;
  const m2PerTile = item.tile_m2_per_piece;
  const boxM2 = tilesPerBox * m2PerTile;
  
  const fullBoxes = Math.floor(qty / tilesPerBox);
  const remainder = qty % tilesPerBox;
  
  return {
    tilesPerBox,
    boxM2: boxM2.toFixed(2),
    fullBoxes,
    remainder,
    totalBoxesNeeded: Math.ceil(qty / tilesPerBox)
  };
};

/**
 * Default company info
 */
export const defaultCompanyInfo = {
  name: 'Tile Station',
  address: 'Unit 3 Trade City Coldharbour Road',
  city: 'Northfleet Gravesend DA11 8AB',
  telephone: '01474 878 989',
  email: 'gravesend@tilestation.co.uk',
  companyNo: '11982550',
  vatNo: '324 251 828'
};

/**
 * Empty line item template
 */
export const emptyLineItem = {
  qty: '',
  m2: '',
  product: '',
  price: '',
  duePrice: '',
  discount: 0,
  productId: '',
  sku: '',
  stock: 0,
  tile_m2_per_piece: null,
  tiles_per_box: null,
  box_m2_coverage: null,
  max_discount: null
};

/**
 * Update company info based on selected store
 */
export const getCompanyInfoFromStore = (store, defaultInfo = defaultCompanyInfo) => {
  if (!store) return defaultInfo;
  
  return {
    ...defaultInfo,
    address: store.address?.split(',')[0] || defaultInfo.address,
    city: store.address?.split(',').slice(1).join(',').trim() || defaultInfo.city,
    telephone: store.phone || defaultInfo.telephone,
    email: store.email || defaultInfo.email
  };
};
