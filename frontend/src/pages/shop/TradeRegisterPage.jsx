import React, { useState, useEffect } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { 
  Building2, User, Mail, Phone, MapPin, Lock, Eye, EyeOff, 
  Percent, Gift, Award, TrendingUp, CheckCircle2, ArrowRight,
  Loader2, BadgeCheck, Truck, Clock, Shield, Headphones
} from 'lucide-react';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { Label } from '../../components/ui/label';
import { ShopHeader, ShopFooter } from './TileStationHome';
import { toast } from 'sonner';
import axios from 'axios';

const API_URL = process.env.REACT_APP_BACKEND_URL;

const ICON_MAP = { Percent, Gift, Award, Truck, Clock, Shield, Headphones, Building2, TrendingUp };
const getIcon = (name) => ICON_MAP[name] || Gift;

const TRADE_TYPES = [
  "Builder", "Tiler", "Plumber", "Contractor", "Interior Designer",
  "Architect", "Property Developer", "Landlord", "Kitchen Fitter",
  "Bathroom Fitter", "Flooring Specialist", "Other"
];

// Business legal structure. Order matters — most-common first.
// VAT/Company-Reg fields show ONLY when "ltd_company" is selected
// (LTDs are required to have a Companies House number).
// "Other (specify)" reveals a free-text field so we don't lock out
// CIC, LLP, charity, sole-trader trading-as scenarios.
const BUSINESS_TYPES = [
  { value: "sole_trader",  label: "Sole Trader / Self Employed" },
  { value: "ltd_company",  label: "LTD Company" },
  { value: "partnership",  label: "Partnership" },
  { value: "plc",          label: "PLC" },
  { value: "other",        label: "Other (specify)" },
];

const DEFAULT_BENEFITS = [
  { icon: 'Percent', title: 'Exclusive Trade Discounts', description: 'Access special pricing not available to retail customers', enabled: true },
  { icon: 'Gift', title: 'Credit Back Rewards', description: 'Earn credit back on every purchase - up to 5% based on your tier', enabled: true },
  { icon: 'Award', title: 'Tier Rewards Program', description: 'Bronze to Silver to Gold to Platinum - the more you spend, the more you save', enabled: true },
  { icon: 'Truck', title: 'Priority Delivery', description: 'Trade customers get priority on deliveries and collections', enabled: true },
  { icon: 'Clock', title: 'Extended Support Hours', description: 'Dedicated trade support line with extended hours', enabled: true },
  { icon: 'Shield', title: 'Trade Guarantee', description: 'Extended warranty and hassle-free returns for trade purchases', enabled: true },
];

const DEFAULT_TIERS = [
  { name: 'Bronze', discount: 1, min_spend: 0, color: '#B45309' },
  { name: 'Silver', discount: 2, min_spend: 5000, color: '#9CA3AF' },
  { name: 'Gold', discount: 3, min_spend: 15000, color: '#FBBF24' },
  { name: 'Platinum', discount: 5, min_spend: 50000, color: '#D1D5DB' },
];

const TradeRegisterPage = () => {
  const navigate = useNavigate();
  const [step, setStep] = useState(1);
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [settings, setSettings] = useState(null);
  const [searchParams] = useSearchParams();

  const [formData, setFormData] = useState({
    business_name: '', trading_name: '',
    business_type: '', business_type_other: '',
    vat_number: '', company_reg_number: '',
    trade_type: '', contact_name: '', email: searchParams.get('email') || '', phone: '', password: '', confirmPassword: '',
    address_line1: '', address_line2: '', city: '', county: '', postcode: '',
    estimated_monthly_spend: '', how_heard: '', notes: ''
  });

  useEffect(() => {
    fetch(`${API_URL}/api/website-admin/public/trade-account-settings`)
      .then(r => r.ok ? r.json() : null)
      .then(d => { if (d?.settings && Object.keys(d.settings).length) setSettings(d.settings); })
      .catch(() => {});
  }, []);

  const benefits = (settings?.benefits || []).filter(b => b.enabled !== false);
  const tiersEnabled = settings?.tiers_enabled === true; // tiers are opt-in — discounts are set manually per trader
  // When tiers are globally disabled, also hide any benefit that talks about
  // tiers / Bronze-Platinum so the registration page doesn't mention them.
  const tierKeywords = /(tier|bronze|silver|gold|platinum)/i;
  const filteredBenefits = tiersEnabled
    ? benefits
    : benefits.filter(b => !tierKeywords.test(`${b.title} ${b.description}`));
  const filteredDefaults = tiersEnabled
    ? DEFAULT_BENEFITS
    : DEFAULT_BENEFITS.filter(b => !tierKeywords.test(`${b.title} ${b.description}`));
  const displayBenefits = filteredBenefits.length > 0 ? filteredBenefits : filteredDefaults;
  const tiers = settings?.tiers?.length > 0 ? settings.tiers : DEFAULT_TIERS;

  // When the backend returns "Email already registered", flip this so the
  // form shows a contextual "Sign in instead →" link near the email field.
  // Clears as soon as the user edits the email.
  const [emailAlreadyRegistered, setEmailAlreadyRegistered] = useState(false);

  const handleChange = (e) => {
    const { name, value } = e.target;
    if (name === 'email' && emailAlreadyRegistered) {
      setEmailAlreadyRegistered(false);
    }
    setFormData(prev => ({ ...prev, [name]: value }));
  };

  const validateStep1 = () => {
    if (!formData.business_name || !formData.trade_type) {
      toast.error('Please fill in business name and trade type');
      return false;
    }
    if (!formData.business_type) {
      toast.error('Please select your type of business');
      return false;
    }
    if (formData.business_type === 'other' && !formData.business_type_other.trim()) {
      toast.error('Please specify your type of business');
      return false;
    }
    return true;
  };

  const validateStep2 = () => {
    if (!formData.contact_name || !formData.email || !formData.phone) {
      toast.error('Please fill in all contact details');
      return false;
    }
    if (!formData.password || formData.password.length < 8) {
      toast.error('Password must be at least 8 characters');
      return false;
    }
    if (formData.password !== formData.confirmPassword) {
      toast.error('Passwords do not match');
      return false;
    }
    return true;
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!formData.address_line1 || !formData.city || !formData.postcode) {
      toast.error('Please fill in your business address');
      return;
    }
    setLoading(true);
    try {
      // confirmPassword is local-only; the backend Pydantic model doesn't
      // accept extra fields cleanly so strip it before sending.
      const { confirmPassword: _ignore, ...body } = formData;
      // 15 May 2026 — axios instead of fetch (Sentry-body-drain).
      // Showroom computers are signed into the admin — pass that session so the
      // account is recorded as "registered in store (assisted by <staff>)".
      const staffToken = localStorage.getItem('token');
      await axios.post(`${API_URL}/api/shop/auth/trade-register`, {
        ...body,
        is_trade: true,
      }, { headers: staffToken ? { 'X-Staff-Token': staffToken } : {} });
      setSubmitted(true);
      toast.success('Trade account application submitted!');
    } catch (error) {
      // Surface the actual backend detail. axios puts the response body
      // on error.response.data — same shape as before but already parsed.
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

  if (submitted) {
    return (
      <div className="min-h-screen bg-gray-50">
        <ShopHeader />
        <div className="container mx-auto px-4 py-16">
          <div className="max-w-lg mx-auto text-center">
            <div className="w-20 h-20 bg-green-100 rounded-full flex items-center justify-center mx-auto mb-6">
              <CheckCircle2 className="w-10 h-10 text-green-500" />
            </div>
            <h1 className="text-3xl font-bold text-gray-900 mb-4">Trade Account Created!</h1>
            <p className="text-gray-600 mb-8">
              Welcome to Tile Station Trade. Your account is now active and ready to use. 
              You can log in straight away with the email and password you just registered with.
            </p>
            <div className="bg-green-50 border border-green-200 rounded-lg p-4 mb-8">
              <p className="text-sm text-green-800">
                <strong>You're all set!</strong> Log in now to see your exclusive trade prices (shown ex. VAT) 
                and start earning credit back on every order.
              </p>
            </div>
            <div className="flex flex-col sm:flex-row gap-3 justify-center">
              <Link to="/shop/trade/login" className="inline-flex items-center justify-center gap-2 bg-[#333333] hover:bg-[#444444] text-[#F7EA1C] font-semibold px-6 py-3 rounded-lg">
                Log In Now <ArrowRight className="w-4 h-4" />
              </Link>
              <Link to="/tiles" className="inline-flex items-center justify-center gap-2 border border-gray-300 hover:bg-gray-100 text-gray-700 font-semibold px-6 py-3 rounded-lg">
                Continue Shopping
              </Link>
            </div>
          </div>
        </div>
        <ShopFooter />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50" data-testid="trade-register-page">
      <ShopHeader />
      <div className="container mx-auto px-4 py-8">
        <nav className="text-sm text-gray-500 mb-6">
          <Link to="/" className="hover:text-[#F7EA1C]">Home</Link>
          <span className="mx-2">/</span>
          <span className="text-gray-900">Trade Account Application</span>
        </nav>

        <div className="grid lg:grid-cols-5 gap-8">
          {/* Benefits Sidebar */}
          <div className="lg:col-span-2 order-2 lg:order-1">
            <div className="bg-[#333333] text-white rounded-2xl p-6 sticky top-24">
              <div className="flex items-center gap-3 mb-6">
                <div className="w-12 h-12 bg-[#F7EA1C] rounded-xl flex items-center justify-center">
                  <Building2 className="w-6 h-6 text-[#333333]" />
                </div>
                <div>
                  <h2 className="text-xl font-bold">Trade Account Benefits</h2>
                  <p className="text-gray-400 text-sm">Why join our trade program?</p>
                </div>
              </div>

              <div className="space-y-4 mb-8">
                {displayBenefits.map((benefit, idx) => {
                  const BIcon = getIcon(benefit.icon);
                  return (
                    <div key={benefit.id || idx} className="flex gap-3">
                      <div className="w-10 h-10 bg-[#F7EA1C]/10 rounded-lg flex items-center justify-center flex-shrink-0">
                        <BIcon className="w-5 h-5 text-[#F7EA1C]" />
                      </div>
                      <div>
                        <h3 className="font-semibold text-white">{benefit.title}</h3>
                        <p className="text-gray-400 text-sm">{benefit.description}</p>
                      </div>
                    </div>
                  );
                })}
              </div>

              {tiersEnabled && (
                <div className="border-t border-gray-700 pt-6">
                  <h3 className="font-bold mb-4 flex items-center gap-2">
                    <TrendingUp className="w-5 h-5 text-[#F7EA1C]" />
                    Discount Tiers
                  </h3>
                  <div className="space-y-2">
                    {tiers.map((tier, idx) => (
                      <div key={tier.id || idx} className="flex items-center justify-between bg-white/5 rounded-lg px-3 py-2">
                        <div className="flex items-center gap-2">
                          <div className="w-3 h-3 rounded-full" style={{ backgroundColor: tier.color }} />
                          <span className="font-medium">{tier.name}</span>
                        </div>
                        <div className="text-right">
                          <span className="text-[#F7EA1C] font-bold">{tier.discount}%</span>
                          <span className="text-gray-400 text-sm ml-2">(£{Number(tier.min_spend).toLocaleString()}+)</span>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* Registration Form */}
          <div className="lg:col-span-3 order-1 lg:order-2">
            <div className="bg-white rounded-2xl shadow-sm p-6 md:p-8">
              <div className="text-center mb-8">
                <h1 className="text-2xl md:text-3xl font-bold text-gray-900">Open a Trade Account</h1>
                <p className="text-gray-500 mt-2">Join thousands of trade professionals who trust Tile Station</p>
              </div>

              {/* Progress Steps */}
              <div className="flex items-center justify-center gap-2 mb-8">
                {[1, 2, 3].map((s) => (
                  <React.Fragment key={s}>
                    <div className={`w-10 h-10 rounded-full flex items-center justify-center font-bold text-sm transition-all ${step >= s ? 'bg-[#333333] text-[#F7EA1C]' : 'bg-gray-100 text-gray-400'}`}>
                      {step > s ? <CheckCircle2 className="w-5 h-5" /> : s}
                    </div>
                    {s < 3 && <div className={`w-16 h-1 rounded ${step > s ? 'bg-[#333333]' : 'bg-gray-200'}`} />}
                  </React.Fragment>
                ))}
              </div>
              <div className="flex justify-center gap-8 text-sm text-gray-500 mb-8">
                <span className={step >= 1 ? 'text-gray-900 font-medium' : ''}>Business Info</span>
                <span className={step >= 2 ? 'text-gray-900 font-medium' : ''}>Contact Details</span>
                <span className={step >= 3 ? 'text-gray-900 font-medium' : ''}>Address</span>
              </div>

              <form onSubmit={handleSubmit}>
                {step === 1 && (
                  <div className="space-y-5" data-testid="step-1-business">
                    <div>
                      <Label htmlFor="business_name">Business Name *</Label>
                      <div className="relative mt-1">
                        <Building2 className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-gray-400" />
                        <Input id="business_name" name="business_name" value={formData.business_name} onChange={handleChange} placeholder="Your registered business name" className="pl-10" required />
                      </div>
                    </div>
                    <div>
                      <Label htmlFor="trading_name">Trading Name (if different)</Label>
                      <Input id="trading_name" name="trading_name" value={formData.trading_name} onChange={handleChange} placeholder="Trading as..." className="mt-1" />
                    </div>
                    <div>
                      <Label htmlFor="business_type">Type of Business *</Label>
                      <select id="business_type" name="business_type" value={formData.business_type} onChange={handleChange} className="w-full mt-1 px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-[#F7EA1C] focus:border-transparent" required data-testid="business-type-select">
                        <option value="">Select type of business...</option>
                        {BUSINESS_TYPES.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
                      </select>
                    </div>
                    {formData.business_type === 'other' && (
                      <div data-testid="business-type-other-wrap">
                        <Label htmlFor="business_type_other">Please specify *</Label>
                        <Input id="business_type_other" name="business_type_other" value={formData.business_type_other} onChange={handleChange} placeholder="e.g. CIC, LLP, Charity..." className="mt-1" required />
                      </div>
                    )}
                    {formData.business_type === 'ltd_company' && (
                      <div className="grid grid-cols-2 gap-4" data-testid="ltd-vat-reg-wrap">
                        <div>
                          <Label htmlFor="vat_number">VAT Number</Label>
                          <Input id="vat_number" name="vat_number" value={formData.vat_number} onChange={handleChange} placeholder="GB123456789" className="mt-1" />
                        </div>
                        <div>
                          <Label htmlFor="company_reg_number">Company Reg Number</Label>
                          <Input id="company_reg_number" name="company_reg_number" value={formData.company_reg_number} onChange={handleChange} placeholder="12345678" className="mt-1" />
                        </div>
                      </div>
                    )}
                    <div>
                      <Label htmlFor="trade_type">Trade Type *</Label>
                      <select id="trade_type" name="trade_type" value={formData.trade_type} onChange={handleChange} className="w-full mt-1 px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-[#F7EA1C] focus:border-transparent" required>
                        <option value="">Select your trade...</option>
                        {TRADE_TYPES.map(type => <option key={type} value={type}>{type}</option>)}
                      </select>
                    </div>
                    <Button type="button" onClick={() => validateStep1() && setStep(2)} className="w-full bg-[#333333] hover:bg-[#444444] text-[#F7EA1C] py-6">
                      Continue to Contact Details <ArrowRight className="w-4 h-4 ml-2" />
                    </Button>
                  </div>
                )}

                {step === 2 && (
                  <div className="space-y-5" data-testid="step-2-contact">
                    <div>
                      <Label htmlFor="contact_name">Contact Name *</Label>
                      <div className="relative mt-1">
                        <User className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-gray-400" />
                        <Input id="contact_name" name="contact_name" value={formData.contact_name} onChange={handleChange} placeholder="Your full name" className="pl-10" required />
                      </div>
                    </div>
                    <div>
                      <Label htmlFor="email">Email Address *</Label>
                      <div className="relative mt-1">
                        <Mail className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-gray-400" />
                        <Input id="email" name="email" type="email" value={formData.email} onChange={handleChange} placeholder="you@company.com" className={`pl-10 ${emailAlreadyRegistered ? 'border-amber-400 focus-visible:ring-amber-400' : ''}`} required />
                      </div>
                      {emailAlreadyRegistered && (
                        <div
                          className="mt-1.5 flex items-center justify-between gap-2 text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-md px-2.5 py-1.5"
                          data-testid="already-registered-hint"
                        >
                          <span>This email is already registered.</span>
                          <Link
                            to={`/shop/trade/login${formData.email ? `?email=${encodeURIComponent(formData.email)}` : ''}`}
                            className="font-semibold text-amber-900 hover:text-amber-950 underline whitespace-nowrap"
                            data-testid="already-registered-signin-link"
                          >
                            Sign in instead →
                          </Link>
                        </div>
                      )}
                    </div>
                    <div>
                      <Label htmlFor="phone">Phone Number *</Label>
                      <div className="relative mt-1">
                        <Phone className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-gray-400" />
                        <Input id="phone" name="phone" value={formData.phone} onChange={handleChange} placeholder="07123 456789" className="pl-10" required />
                      </div>
                    </div>
                    <div>
                      <Label htmlFor="password">Create Password *</Label>
                      <div className="relative mt-1">
                        <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-gray-400" />
                        <Input id="password" name="password" type={showPassword ? 'text' : 'password'} value={formData.password} onChange={handleChange} placeholder="Min. 8 characters" className="pl-10 pr-10" required />
                        <button type="button" onClick={() => setShowPassword(!showPassword)} className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600">
                          {showPassword ? <EyeOff className="w-5 h-5" /> : <Eye className="w-5 h-5" />}
                        </button>
                      </div>
                    </div>
                    <div>
                      <Label htmlFor="confirmPassword">Confirm Password *</Label>
                      <div className="relative mt-1">
                        <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-gray-400" />
                        <Input id="confirmPassword" name="confirmPassword" type={showPassword ? 'text' : 'password'} value={formData.confirmPassword} onChange={handleChange} placeholder="Confirm your password" className="pl-10" required />
                      </div>
                    </div>
                    <div className="flex gap-3">
                      <Button type="button" variant="outline" onClick={() => setStep(1)} className="flex-1 py-6">Back</Button>
                      <Button type="button" onClick={() => validateStep2() && setStep(3)} className="flex-1 bg-[#333333] hover:bg-[#444444] text-[#F7EA1C] py-6">
                        Continue to Address <ArrowRight className="w-4 h-4 ml-2" />
                      </Button>
                    </div>
                  </div>
                )}

                {step === 3 && (
                  <div className="space-y-5" data-testid="step-3-address">
                    <div>
                      <Label htmlFor="address_line1">Address Line 1 *</Label>
                      <div className="relative mt-1">
                        <MapPin className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-gray-400" />
                        <Input id="address_line1" name="address_line1" value={formData.address_line1} onChange={handleChange} placeholder="Street address" className="pl-10" required />
                      </div>
                    </div>
                    <div>
                      <Label htmlFor="address_line2">Address Line 2</Label>
                      <Input id="address_line2" name="address_line2" value={formData.address_line2} onChange={handleChange} placeholder="Unit, suite, etc. (optional)" className="mt-1" />
                    </div>
                    <div className="grid grid-cols-2 gap-4">
                      <div>
                        <Label htmlFor="city">City *</Label>
                        <Input id="city" name="city" value={formData.city} onChange={handleChange} placeholder="City" className="mt-1" required />
                      </div>
                      <div>
                        <Label htmlFor="county">County</Label>
                        <Input id="county" name="county" value={formData.county} onChange={handleChange} placeholder="County" className="mt-1" />
                      </div>
                    </div>
                    <div>
                      <Label htmlFor="postcode">Postcode *</Label>
                      <Input id="postcode" name="postcode" value={formData.postcode} onChange={handleChange} placeholder="SW1A 1AA" className="mt-1 max-w-[200px]" required />
                    </div>
                    <div>
                      <Label htmlFor="notes">Additional Notes</Label>
                      <textarea id="notes" name="notes" value={formData.notes} onChange={handleChange} placeholder="Tell us about your business or any special requirements..." className="w-full mt-1 px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-[#F7EA1C] focus:border-transparent min-h-[100px]" />
                    </div>
                    <div className="bg-amber-50 border border-amber-200 rounded-lg p-4">
                      <p className="text-sm text-amber-800">
                        <strong>Note:</strong> Trade accounts are proforma or cash accounts only. 
                        You'll earn rewards on every purchase based on your tier level!
                      </p>
                    </div>
                    <div className="flex gap-3">
                      <Button type="button" variant="outline" onClick={() => setStep(2)} className="flex-1 py-6">Back</Button>
                      <Button type="submit" disabled={loading} className="flex-1 bg-[#333333] hover:bg-[#444444] text-[#F7EA1C] py-6">
                        {loading ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" />Submitting...</> : <><BadgeCheck className="w-4 h-4 mr-2" />Submit Application</>}
                      </Button>
                    </div>
                  </div>
                )}
              </form>

              <div className="mt-8 text-center border-t pt-6">
                <p className="text-gray-600">
                  Already have a trade account?{' '}
                  <Link to="/shop/trade/login" className="text-[#333333] font-semibold hover:text-[#F7EA1C]">Sign In</Link>
                </p>
                <p className="text-gray-500 text-sm mt-2">
                  Not a trade customer?{' '}
                  <Link to="/shop/register" className="text-[#333333] hover:text-[#F7EA1C]">Create a personal account</Link>
                </p>
              </div>
            </div>
          </div>
        </div>
      </div>
      <ShopFooter />
    </div>
  );
};

export default TradeRegisterPage;
