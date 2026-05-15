import React, { useState, useEffect } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { User, Mail, Phone, MapPin, Package, LogOut, ChevronRight, Clock, Coins, TrendingUp, Crown, Gift } from 'lucide-react';
import { Button } from '../../components/ui/button';
import { ShopHeader, ShopFooter } from './TileStationHome';
import { toast } from 'sonner';
import axios from 'axios';

const API_URL = process.env.REACT_APP_BACKEND_URL;

const TileAccountPage = () => {
  const navigate = useNavigate();
  const [customer, setCustomer] = useState(null);
  const [orders, setOrders] = useState([]);
  const [creditData, setCreditData] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const token = localStorage.getItem('tile_shop_token');
    if (!token) {
      navigate('/shop/tile-login?redirect=/shop/tile-account');
      return;
    }
    
    fetchAccountData(token);
  }, [navigate]);

  const fetchAccountData = async (token) => {
    // 16 May 2026 — moved from fetch() to axios. Sentry's BrowserTracing
    // integration patches window.fetch and consumes the response body
    // before our code reads it, so JSON parsing silently returns null on
    // prod and the customer is sent back to login even when their token
    // is valid. axios isn't intercepted, so we get the real body every time.
    const authHeaders = { Authorization: `Bearer ${token}` };
    try {
      // Fetch customer profile
      let profileData;
      try {
        const profileRes = await axios.get(`${API_URL}/api/shop/auth/me`, { headers: authHeaders });
        profileData = profileRes.data;
      } catch (err) {
        if (err?.response?.status === 401 || err?.response?.status === 403) {
          // Token invalid, redirect to login
          localStorage.removeItem('tile_shop_token');
          localStorage.removeItem('tile_shop_customer');
          navigate('/shop/tile-login');
          return;
        }
        throw err;
      }
      setCustomer(profileData);

      // Fetch orders — best-effort, don't block account page on order failures
      try {
        const ordersRes = await axios.get(`${API_URL}/api/shop/orders`, { headers: authHeaders });
        setOrders((ordersRes.data || []).slice(0, 5)); // Show last 5 orders
      } catch (err) {
        console.warn('[account] orders fetch failed:', err?.message);
      }

      // Fetch credit data if trade customer
      if (profileData.is_trade) {
        try {
          const creditRes = await axios.get(`${API_URL}/api/shop/trade/credits/summary`, { headers: authHeaders });
          setCreditData(creditRes.data);
        } catch (err) {
          console.warn('[account] credit summary fetch failed:', err?.message);
        }
      }
    } catch (error) {
      console.error('Error fetching account data:', error);
      toast.error('Failed to load account data');
    } finally {
      setLoading(false);
    }
  };

  const handleLogout = () => {
    localStorage.removeItem('tile_shop_token');
    localStorage.removeItem('tile_shop_customer');
    toast.success('Logged out successfully');
    navigate('/tiles');
  };

  const getStatusColor = (status) => {
    const colors = {
      pending: 'bg-yellow-100 text-yellow-800',
      confirmed: 'bg-blue-100 text-blue-800',
      processing: 'bg-purple-100 text-purple-800',
      shipped: 'bg-indigo-100 text-indigo-800',
      delivered: 'bg-green-100 text-green-800',
      ready_for_collection: 'bg-teal-100 text-teal-800',
      collected: 'bg-green-100 text-green-800',
      cancelled: 'bg-red-100 text-red-800'
    };
    return colors[status] || 'bg-gray-100 text-gray-800';
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-gray-50">
        <ShopHeader />
        <div className="container mx-auto px-4 py-16">
          <div className="text-center">
            <div className="animate-spin w-8 h-8 border-4 border-[#333333] border-t-transparent rounded-full mx-auto"></div>
            <p className="mt-4 text-gray-500">Loading your account...</p>
          </div>
        </div>
        <ShopFooter />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50">
      <ShopHeader />
      
      <div className="container mx-auto px-4 py-8">
        {/* Breadcrumb */}
        <nav className="text-sm text-gray-500 mb-6">
          <Link to="/tiles" className="hover:text-[#F7EA1C]">Home</Link>
          <span className="mx-2">/</span>
          <span className="text-gray-900">My Account</span>
        </nav>

        <div className="grid lg:grid-cols-3 gap-8">
          {/* Sidebar */}
          <div className="lg:col-span-1">
            <div className="bg-white rounded-lg shadow-sm p-6">
              <div className="text-center mb-6">
                <div className="w-20 h-20 bg-[#333333] rounded-full flex items-center justify-center mx-auto mb-4">
                  <User className="w-10 h-10 text-[#F7EA1C]" />
                </div>
                <h2 className="text-xl font-bold text-gray-900">{customer?.name}</h2>
                <p className="text-gray-500 text-sm">{customer?.email}</p>
              </div>

              <nav className="space-y-2">
                <Link 
                  to="/shop/tile-account"
                  className="flex items-center justify-between p-3 rounded-lg bg-[#333333] text-[#F7EA1C]"
                >
                  <span className="flex items-center gap-3">
                    <User className="w-5 h-5" />
                    Account Details
                  </span>
                  <ChevronRight className="w-4 h-4" />
                </Link>
                <Link 
                  to="/shop/tile-orders"
                  className="flex items-center justify-between p-3 rounded-lg hover:bg-gray-100 text-gray-700"
                >
                  <span className="flex items-center gap-3">
                    <Package className="w-5 h-5" />
                    My Orders
                  </span>
                  <ChevronRight className="w-4 h-4" />
                </Link>
                <button 
                  onClick={handleLogout}
                  className="w-full flex items-center justify-between p-3 rounded-lg hover:bg-red-50 text-red-600"
                >
                  <span className="flex items-center gap-3">
                    <LogOut className="w-5 h-5" />
                    Log Out
                  </span>
                </button>
              </nav>
            </div>
          </div>

          {/* Main Content */}
          <div className="lg:col-span-2 space-y-6">
            {/* Discount / Credit Balance — only renders for non-trade with positive balance.
                Trade customers see their own dedicated emerald card on /shop/trade/account. */}
            {!customer?.is_trade && Number(customer?.credit_balance || 0) > 0 && (
              <div
                className="bg-gradient-to-br from-emerald-500 to-emerald-700 rounded-2xl p-6 text-white shadow-sm"
                data-testid="shop-discount-balance-card"
              >
                <div className="flex items-start justify-between gap-4 flex-wrap">
                  <div>
                    <p className="text-emerald-100 text-sm font-medium">Discount Balance</p>
                    <p className="text-4xl font-bold mt-1 tabular-nums">£{Number(customer.credit_balance).toFixed(2)}</p>
                    <p className="text-emerald-100 text-sm mt-2">
                      Loyalty &amp; refund credit ready to spend on your next order
                    </p>
                  </div>
                  <div className="w-14 h-14 bg-white/15 rounded-2xl flex items-center justify-center shrink-0">
                    <Coins className="w-7 h-7" />
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => {
                    try { sessionStorage.setItem('tile_use_trade_credit', '1'); } catch (e) { /* ignore */ }
                    navigate('/shop/tile-cart');
                  }}
                  className="mt-4 w-full sm:w-auto bg-white text-emerald-700 font-semibold py-2.5 px-5 rounded-lg hover:bg-emerald-50 transition-colors inline-flex items-center justify-center gap-2 shadow-sm"
                  data-testid="shop-spend-credit-cta"
                >
                  Spend at checkout →
                </button>
              </div>
            )}

            {/* Account Details */}
            <div className="bg-white rounded-lg shadow-sm p-6">
              <h3 className="text-lg font-semibold text-gray-900 mb-4">Account Details</h3>
              
              <div className="grid md:grid-cols-2 gap-4">
                <div className="flex items-start gap-3 p-4 bg-gray-50 rounded-lg">
                  <User className="w-5 h-5 text-[#333333] mt-0.5" />
                  <div>
                    <p className="text-sm text-gray-500">Full Name</p>
                    <p className="font-medium text-gray-900">{customer?.name || '-'}</p>
                  </div>
                </div>
                
                <div className="flex items-start gap-3 p-4 bg-gray-50 rounded-lg">
                  <Mail className="w-5 h-5 text-[#333333] mt-0.5" />
                  <div>
                    <p className="text-sm text-gray-500">Email Address</p>
                    <p className="font-medium text-gray-900">{customer?.email || '-'}</p>
                  </div>
                </div>
                
                <div className="flex items-start gap-3 p-4 bg-gray-50 rounded-lg">
                  <Phone className="w-5 h-5 text-[#333333] mt-0.5" />
                  <div>
                    <p className="text-sm text-gray-500">Phone Number</p>
                    <p className="font-medium text-gray-900">{customer?.phone || 'Not provided'}</p>
                  </div>
                </div>
                
                <div className="flex items-start gap-3 p-4 bg-gray-50 rounded-lg">
                  <MapPin className="w-5 h-5 text-[#333333] mt-0.5" />
                  <div>
                    <p className="text-sm text-gray-500">Default Address</p>
                    <p className="font-medium text-gray-900">
                      {customer?.address_line1 ? (
                        <>
                          {customer.address_line1}
                          {customer.address_line2 && <>, {customer.address_line2}</>}
                          {customer.city && <>, {customer.city}</>}
                          {customer.postcode && <> {customer.postcode}</>}
                        </>
                      ) : (
                        'Not provided'
                      )}
                    </p>
                  </div>
                </div>
              </div>
            </div>

            {/* Trade Credits Section - Only show for trade customers */}
            {customer?.is_trade && (
              <div className="bg-gradient-to-r from-amber-500 to-amber-600 rounded-lg shadow-sm p-6 text-white">
                <div className="flex items-center justify-between mb-4">
                  <h3 className="text-lg font-semibold flex items-center gap-2">
                    <Crown className="w-5 h-5" />
                    Trade Credit Balance
                  </h3>
                  <span className="bg-white/20 text-white text-xs px-2 py-1 rounded-full">
                    {creditData?.credit_rate || 2}% Credit Back
                  </span>
                </div>
                
                <div className="grid md:grid-cols-3 gap-4 mb-4">
                  <div className="bg-white/10 rounded-lg p-4">
                    <div className="flex items-center gap-2 mb-1">
                      <Coins className="w-4 h-4 text-white/80" />
                      <span className="text-sm text-white/80">Available Balance</span>
                    </div>
                    <p className="text-3xl font-bold">£{(creditData?.credit_balance || 0).toFixed(2)}</p>
                  </div>
                  
                  <div className="bg-white/10 rounded-lg p-4">
                    <div className="flex items-center gap-2 mb-1">
                      <TrendingUp className="w-4 h-4 text-white/80" />
                      <span className="text-sm text-white/80">Total Earned</span>
                    </div>
                    <p className="text-2xl font-bold">£{(creditData?.total_earned || 0).toFixed(2)}</p>
                  </div>
                  
                  <div className="bg-white/10 rounded-lg p-4">
                    <div className="flex items-center gap-2 mb-1">
                      <Gift className="w-4 h-4 text-white/80" />
                      <span className="text-sm text-white/80">Total Redeemed</span>
                    </div>
                    <p className="text-2xl font-bold">£{(creditData?.total_redeemed || 0).toFixed(2)}</p>
                  </div>
                </div>

                {/* Recent Credit Transactions */}
                {creditData?.recent_transactions?.length > 0 && (
                  <div className="bg-white/10 rounded-lg p-4">
                    <h4 className="text-sm font-medium mb-3 text-white/90">Recent Transactions</h4>
                    <div className="space-y-2">
                      {creditData.recent_transactions.slice(0, 3).map((tx, idx) => (
                        <div key={idx} className="flex justify-between items-center text-sm">
                          <div className="flex items-center gap-2">
                            <span className={`w-2 h-2 rounded-full ${tx.type === 'earn' ? 'bg-green-400' : 'bg-red-400'}`}></span>
                            <span className="text-white/80 truncate max-w-[200px]">{tx.description}</span>
                          </div>
                          <span className={`font-medium ${tx.type === 'earn' ? 'text-green-300' : 'text-red-300'}`}>
                            {tx.type === 'earn' ? '+' : ''}£{Math.abs(tx.amount).toFixed(2)}
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                <p className="text-xs text-white/70 mt-4">
                  Earn {creditData?.credit_rate || 2}% credit back on every purchase. Use your credits at checkout!
                </p>
              </div>
            )}

            {/* Non-Trade Customer - Upgrade Prompt */}
            {!customer?.is_trade && (
              <div className="bg-gradient-to-r from-gray-100 to-amber-50 rounded-lg shadow-sm p-6 border border-amber-200">
                <div className="flex items-center gap-4">
                  <div className="bg-amber-500 text-white p-3 rounded-full">
                    <Crown className="w-6 h-6" />
                  </div>
                  <div className="flex-1">
                    <h3 className="text-lg font-semibold text-gray-900">Upgrade to Trade Account</h3>
                    <p className="text-gray-600 text-sm">Get exclusive trade pricing and earn 2% credit back on every purchase!</p>
                  </div>
                  <Button 
                    onClick={() => navigate('/trade/register')}
                    className="bg-amber-500 hover:bg-amber-600 text-white"
                  >
                    Apply Now
                  </Button>
                </div>
              </div>
            )}

            {/* Recent Orders */}
            <div className="bg-white rounded-lg shadow-sm p-6">
              <div className="flex justify-between items-center mb-4">
                <h3 className="text-lg font-semibold text-gray-900">Recent Orders</h3>
                <Link 
                  to="/shop/tile-orders" 
                  className="text-sm text-[#333333] hover:text-[#F7EA1C] font-medium"
                >
                  View All
                </Link>
              </div>
              
              {orders.length === 0 ? (
                <div className="text-center py-8">
                  <Package className="w-12 h-12 mx-auto text-gray-300 mb-3" />
                  <p className="text-gray-500">You haven't placed any orders yet</p>
                  <Button 
                    onClick={() => navigate('/tiles')}
                    className="mt-4 bg-[#333333] hover:bg-[#444444] text-[#F7EA1C]"
                  >
                    Start Shopping
                  </Button>
                </div>
              ) : (
                <div className="space-y-4">
                  {orders.map((order) => (
                    <div 
                      key={order.id || order._id}
                      className="border rounded-lg p-4 hover:border-[#333333] transition cursor-pointer"
                      onClick={() => navigate(`/shop/track?order=${order.order_number}`)}
                    >
                      <div className="flex justify-between items-start mb-2">
                        <div>
                          <p className="font-medium text-gray-900">Order #{order.order_number}</p>
                          <p className="text-sm text-gray-500 flex items-center gap-1">
                            <Clock className="w-4 h-4" />
                            {new Date(order.created_at).toLocaleDateString('en-GB', {
                              day: 'numeric',
                              month: 'short',
                              year: 'numeric'
                            })}
                          </p>
                        </div>
                        <span className={`px-2 py-1 text-xs rounded-full ${getStatusColor(order.status)}`}>
                          {order.status?.replace(/_/g, ' ').toUpperCase()}
                        </span>
                      </div>
                      <div className="flex justify-between items-center text-sm">
                        <span className="text-gray-500">{order.items?.length || 0} item(s)</span>
                        <span className="font-semibold text-[#333333]">£{order.total?.toFixed(2)}</span>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      <ShopFooter />
    </div>
  );
};

export default TileAccountPage;
