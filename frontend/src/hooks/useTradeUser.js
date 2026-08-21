import { useState, useEffect, useCallback } from 'react';

const DEFAULT_TRADE_DISCOUNT = 0; // % — no blanket trade discount; admin sets per product

export function useTradeUser() {
  const [isTrade, setIsTrade] = useState(false);
  const [tradeDiscount, setTradeDiscount] = useState(DEFAULT_TRADE_DISCOUNT);
  const [tradeCompanyName, setTradeCompanyName] = useState('');

  const checkTradeStatus = useCallback(() => {
    try {
      // MUST verify token exists — tile_shop_customer data persists after logout
      // Without a valid token, the user is NOT logged in as trade
      const token = localStorage.getItem('tile_shop_token');
      if (!token) {
        setIsTrade(false);
        setTradeDiscount(DEFAULT_TRADE_DISCOUNT);
        setTradeCompanyName('');
        return;
      }
      
      const customerData = localStorage.getItem('tile_shop_customer');
      if (customerData) {
        const customer = JSON.parse(customerData);
        if (customer.is_trade) {
          setIsTrade(true);
          setTradeDiscount(customer.trade_discount || DEFAULT_TRADE_DISCOUNT);
          setTradeCompanyName(customer.business_name || customer.name || 'Trade');
          return;
        }
      }
    } catch (e) {}
    setIsTrade(false);
    setTradeDiscount(DEFAULT_TRADE_DISCOUNT);
    setTradeCompanyName('');
  }, []);

  useEffect(() => {
    checkTradeStatus();
    // Listen for storage changes (login/logout in another tab)
    window.addEventListener('storage', checkTradeStatus);
    // Listen for custom event (login/logout in same tab)
    window.addEventListener('trade-auth-change', checkTradeStatus);
    return () => {
      window.removeEventListener('storage', checkTradeStatus);
      window.removeEventListener('trade-auth-change', checkTradeStatus);
    };
  }, [checkTradeStatus]);

  // Calculate trade ex-VAT price: apply trade discount then remove VAT
  const getTradePrice = useCallback((price) => {
    if (!price || !isTrade) return price;
    const discounted = price * (1 - tradeDiscount / 100);
    return Math.round((discounted / 1.20) * 100) / 100;
  }, [isTrade, tradeDiscount]);

  return { isTrade, tradeDiscount, tradeCompanyName, getTradePrice, refreshTradeStatus: checkTradeStatus };
}

// Utility function for formatting - can be used outside React
export function formatTradePrice(price, tradeDiscount = DEFAULT_TRADE_DISCOUNT) {
  if (!price) return 0;
  const discounted = price * (1 - tradeDiscount / 100);
  return Math.round((discounted / 1.20) * 100) / 100;
}
