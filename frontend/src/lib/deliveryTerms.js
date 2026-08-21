// Cached fetch of the free-delivery exclusion small-print (editable in admin).
let cached = null;

export const fetchDeliveryTerms = async () => {
  if (cached !== null) return cached;
  try {
    const res = await fetch(`${process.env.REACT_APP_BACKEND_URL}/api/shop/delivery-terms`);
    const d = await res.json();
    cached = d.text || '';
  } catch {
    cached = '';
  }
  return cached;
};

export const clearDeliveryTermsCache = () => { cached = null; };
