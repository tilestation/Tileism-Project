import React, { useState, useEffect } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { 
  Mail, Lock, Eye, EyeOff, User, Phone, MapPin, ArrowRight,
  Loader2, CheckCircle2, Building2, ShoppingBag, Heart, Truck
} from 'lucide-react';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { Label } from '../../components/ui/label';
import { ShopHeader, ShopFooter } from './TileStationHome';
import { toast } from 'sonner';
import axios from 'axios';

const API_URL = process.env.REACT_APP_BACKEND_URL;

const ICON_MAP = { ShoppingBag, Heart, Truck, CheckCircle2, User, Building2, MapPin };
const getIcon = (name) => ICON_MAP[name] || ShoppingBag;

const DEFAULT_BENEFITS = [
  { icon: 'ShoppingBag', text: 'Track your orders easily' },
  { icon: 'Heart', text: 'Save items to your wishlist' },
  { icon: 'Truck', text: 'Faster checkout experience' },
  { icon: 'CheckCircle2', text: 'Exclusive member offers' },
];

const CustomerRegisterPage = () => {
  const [searchParams] = useSearchParams();
  const redirect = searchParams.get('redirect') || '/';
  const navigate = useNavigate();
  const [settings, setSettings] = useState(null);

  const [formData, setFormData] = useState({
    name: '', email: searchParams.get('email') || '', phone: '', password: '', confirmPassword: '',
    address_line1: '', address_line2: '', city: '', postcode: ''
  });
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [showAddress, setShowAddress] = useState(false);
  // Set when the backend says this email is taken — drives the inline
  // "Sign in instead →" hint and clears as soon as the user edits the email.
  const [emailAlreadyRegistered, setEmailAlreadyRegistered] = useState(false);

  useEffect(() => {
    fetch(`${API_URL}/api/website-admin/public/customer-account-settings`)
      .then(r => r.ok ? r.json() : null)
      .then(d => { if (d?.settings && Object.keys(d.settings).length) setSettings(d.settings); })
      .catch(() => {});
  }, []);

  // Dynamic content
  const reg = settings?.registration || {};
  const headline = reg.headline || 'Create Your Account';
  const subheadline = reg.subheadline || 'Join Tile Station for a better shopping experience';
  const showTradeCta = reg.show_trade_cta !== false;
  const tradeCtaTitle = reg.trade_cta_title || 'Are you a Trade Professional?';
  const tradeCtaDesc = reg.trade_cta_description || 'Get exclusive discounts & credit back rewards';
  const tradeCtaBtn = reg.trade_cta_button || 'Open Trade Account';

  const regBenefits = (settings?.registration_benefits || []).filter(b => b.enabled !== false);
  const benefits = regBenefits.length > 0 ? regBenefits : DEFAULT_BENEFITS;

  const handleChange = (e) => {
    const { name, value } = e.target;
    if (name === 'email' && emailAlreadyRegistered) {
      setEmailAlreadyRegistered(false);
    }
    setFormData(prev => ({ ...prev, [name]: value }));
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (formData.password !== formData.confirmPassword) { toast.error('Passwords do not match'); return; }
    if (formData.password.length < 8) { toast.error('Password must be at least 8 characters'); return; }
    setLoading(true);
    try {
      // 15 May 2026 — axios instead of fetch (Sentry-body-drain).
      const { data } = await axios.post(`${API_URL}/api/shop/auth/register`, {
        email: formData.email,
        password: formData.password,
        name: formData.name,
        phone: formData.phone,
        address_line1: formData.address_line1,
        address_line2: formData.address_line2,
        city: formData.city,
        postcode: formData.postcode,
        is_trade: false,
      });
      localStorage.setItem('tile_shop_token', data.token);
      localStorage.setItem('tile_shop_customer', JSON.stringify(data.customer));
      toast.success('Account created successfully!');
      navigate(redirect);
    } catch (error) {
      // Surface the real reason from axios `error.response.data`.
      let msg = 'Registration failed — please try again';
      const detail = error?.response?.data?.detail;
      if (typeof detail === 'string') {
        msg = detail;
      } else if (Array.isArray(detail) && detail.length > 0) {
        const firstErr = detail[0];
        const fieldName = Array.isArray(firstErr?.loc)
          ? firstErr.loc.filter(p => p !== 'body').join(' → ')
          : 'field';
        msg = `${fieldName}: ${firstErr?.msg || 'invalid value'}`;
      } else if (error?.message) {
        msg = error.message;
      }
      if (/email\s+already\s+registered/i.test(msg)) {
        setEmailAlreadyRegistered(true);
      }
      toast.error(msg);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-gray-50" data-testid="register-page">
      <ShopHeader />
      <div className="container mx-auto px-4 py-8">
        <nav className="text-sm text-gray-500 mb-6">
          <Link to="/" className="hover:text-[#F7EA1C]">Home</Link>
          <span className="mx-2">/</span>
          <span className="text-gray-900">Create Account</span>
        </nav>

        <div className="max-w-5xl mx-auto">
          <div className="grid md:grid-cols-5 gap-8">
            {/* Form Section */}
            <div className="md:col-span-3">
              <div className="bg-white rounded-2xl shadow-sm p-6 md:p-8">
                <div className="text-center mb-8">
                  <h1 className="text-2xl md:text-3xl font-bold text-gray-900">{headline}</h1>
                  <p className="text-gray-500 mt-2">{subheadline}</p>
                </div>

                <form onSubmit={handleSubmit} className="space-y-5">
                  <div>
                    <Label htmlFor="name">Full Name *</Label>
                    <div className="relative mt-1">
                      <User className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-gray-400" />
                      <Input id="name" name="name" value={formData.name} onChange={handleChange} placeholder="John Smith" className="pl-10" required data-testid="register-name-input" />
                    </div>
                  </div>
                  <div>
                    <Label htmlFor="email">Email Address *</Label>
                    <div className="relative mt-1">
                      <Mail className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-gray-400" />
                      <Input id="email" name="email" type="email" value={formData.email} onChange={handleChange} placeholder="you@example.com" className={`pl-10 ${emailAlreadyRegistered ? 'border-amber-400 focus-visible:ring-amber-400' : ''}`} required data-testid="register-email-input" />
                    </div>
                    {emailAlreadyRegistered && (
                      <div
                        className="mt-1.5 flex items-center justify-between gap-2 text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-md px-2.5 py-1.5"
                        data-testid="already-registered-hint"
                      >
                        <span>This email is already registered.</span>
                        <Link
                          to={`/shop/tile-login${formData.email ? `?email=${encodeURIComponent(formData.email)}` : ''}`}
                          className="font-semibold text-amber-900 hover:text-amber-950 underline whitespace-nowrap"
                          data-testid="already-registered-signin-link"
                        >
                          Sign in instead →
                        </Link>
                      </div>
                    )}
                  </div>
                  <div>
                    <Label htmlFor="phone">Phone Number</Label>
                    <div className="relative mt-1">
                      <Phone className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-gray-400" />
                      <Input id="phone" name="phone" value={formData.phone} onChange={handleChange} placeholder="07123 456789" className="pl-10" data-testid="register-phone-input" />
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <Label htmlFor="password">Password *</Label>
                      <div className="relative mt-1">
                        <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-gray-400" />
                        <Input id="password" name="password" type={showPassword ? 'text' : 'password'} value={formData.password} onChange={handleChange} placeholder="Min. 8 characters" className="pl-10 pr-10" required data-testid="register-password-input" />
                        <button type="button" onClick={() => setShowPassword(!showPassword)} className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600">
                          {showPassword ? <EyeOff className="w-5 h-5" /> : <Eye className="w-5 h-5" />}
                        </button>
                      </div>
                    </div>
                    <div>
                      <Label htmlFor="confirmPassword">Confirm Password *</Label>
                      <div className="relative mt-1">
                        <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-gray-400" />
                        <Input id="confirmPassword" name="confirmPassword" type={showPassword ? 'text' : 'password'} value={formData.confirmPassword} onChange={handleChange} placeholder="Confirm" className="pl-10" required data-testid="register-confirm-password-input" />
                      </div>
                    </div>
                  </div>

                  <div className="border-t pt-5">
                    <button type="button" onClick={() => setShowAddress(!showAddress)} className="flex items-center gap-2 text-gray-600 hover:text-gray-900 text-sm font-medium">
                      <MapPin className="w-4 h-4" />
                      {showAddress ? 'Hide address fields' : 'Add delivery address (optional)'}
                    </button>
                    {showAddress && (
                      <div className="mt-4 space-y-4">
                        <div>
                          <Label htmlFor="address_line1">Address Line 1</Label>
                          <Input id="address_line1" name="address_line1" value={formData.address_line1} onChange={handleChange} placeholder="123 High Street" className="mt-1" />
                        </div>
                        <div>
                          <Label htmlFor="address_line2">Address Line 2</Label>
                          <Input id="address_line2" name="address_line2" value={formData.address_line2} onChange={handleChange} placeholder="Flat 2 (optional)" className="mt-1" />
                        </div>
                        <div className="grid grid-cols-2 gap-4">
                          <div>
                            <Label htmlFor="city">City</Label>
                            <Input id="city" name="city" value={formData.city} onChange={handleChange} placeholder="London" className="mt-1" />
                          </div>
                          <div>
                            <Label htmlFor="postcode">Postcode</Label>
                            <Input id="postcode" name="postcode" value={formData.postcode} onChange={handleChange} placeholder="SW1A 1AA" className="mt-1" />
                          </div>
                        </div>
                      </div>
                    )}
                  </div>

                  <Button type="submit" disabled={loading} className="w-full bg-[#333333] hover:bg-[#444444] text-[#F7EA1C] py-6 text-lg" data-testid="register-submit-btn">
                    {loading ? <><Loader2 className="w-5 h-5 mr-2 animate-spin" />Creating Account...</> : <>Create Account <ArrowRight className="w-5 h-5 ml-2" /></>}
                  </Button>
                </form>

                <div className="mt-6 text-center">
                  <p className="text-gray-600">
                    Already have an account?{' '}
                    <Link to="/shop/tile-login" className="text-[#333333] font-semibold hover:text-[#F7EA1C]">Sign In</Link>
                  </p>
                </div>
              </div>
            </div>

            {/* Benefits Sidebar */}
            <div className="md:col-span-2">
              <div className="bg-[#333333] text-white rounded-2xl p-6 sticky top-24">
                <h2 className="text-xl font-bold mb-6">Why Create an Account?</h2>
                <div className="space-y-4 mb-8">
                  {benefits.map((benefit, idx) => {
                    const BIcon = getIcon(benefit.icon);
                    return (
                      <div key={benefit.id || idx} className="flex items-center gap-3">
                        <div className="w-10 h-10 bg-[#F7EA1C]/10 rounded-lg flex items-center justify-center">
                          <BIcon className="w-5 h-5 text-[#F7EA1C]" />
                        </div>
                        <span className="text-gray-200">{benefit.text}</span>
                      </div>
                    );
                  })}
                </div>

                {showTradeCta && (
                  <div className="border-t border-gray-700 pt-6">
                    <div className="flex items-center gap-3 mb-4">
                      <Building2 className="w-6 h-6 text-[#F7EA1C]" />
                      <h3 className="font-bold">{tradeCtaTitle}</h3>
                    </div>
                    <p className="text-gray-400 text-sm mb-4">{tradeCtaDesc}</p>
                    <Link to="/shop/trade/register" className="block w-full text-center bg-[#F7EA1C] text-[#333333] font-semibold py-3 rounded-lg hover:bg-[#e5d91a] transition-colors">
                      {tradeCtaBtn}
                    </Link>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
      <ShopFooter />
    </div>
  );
};

export default CustomerRegisterPage;
