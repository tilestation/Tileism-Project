import React, { useState, useEffect } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { Mail, Lock, Eye, EyeOff, ArrowRight, Building2, Percent, Truck, Clock, Shield, Award, Phone } from 'lucide-react';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { Label } from '../../components/ui/label';
import { ShopHeader, ShopFooter } from './TileStationHome';
import { toast } from 'sonner';
import axios from 'axios';

const API_URL = process.env.REACT_APP_BACKEND_URL;

const TradeLoginPage = () => {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const redirect = searchParams.get('redirect') || '/shop/trade/account';
  // Pre-fill email when arriving from the "Already registered? Sign in →"
  // hint on the trade register page.
  const [email, setEmail] = useState(searchParams.get('email') || '');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [tiersEnabled, setTiersEnabled] = useState(false);
  // Mirror of the register-page hint: when login fails AND email isn't
  // registered, show "No account found — Register instead →" rather than
  // making the customer guess "wrong password or no account?".
  const [emailNotFound, setEmailNotFound] = useState(false);
  // Nudges the "Forgot password?" link to amber on a 2nd+ consecutive
  // failed login when the email DOES exist.
  const [wrongPasswordStreak, setWrongPasswordStreak] = useState(0);

  // Pull the public Trade settings so we can hide tier-related copy when
  // the admin has globally disabled tiers.
  useEffect(() => {
    fetch(`${API_URL}/api/website-admin/public/trade-account-settings`)
      .then(r => r.ok ? r.json() : null)
      .then(d => {
        setTiersEnabled(d?.settings?.tiers_enabled === true);
      })
      .catch(() => {});
  }, []);

  // If a still-valid trade token exists, validate server-side and auto-forward.
  // Prevents the redirect loop where stale token + cached customer leave a
  // logged-in user repeatedly bounced back to login.
  useEffect(() => {
    const token = localStorage.getItem('tile_shop_token');
    if (!token) return;
    let cancelled = false;
    (async () => {
      try {
        // 15 May 2026 — axios instead of fetch (Sentry-body-drain).
        const { data: customer } = await axios.get(`${API_URL}/api/shop/auth/me`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (cancelled) return;
        try { localStorage.setItem('tile_shop_customer', JSON.stringify(customer)); } catch {}
        window.dispatchEvent(new Event('trade-auth-change'));
        navigate(customer.is_trade ? redirect : '/shop/account', { replace: true });
      } catch (err) {
        if (err?.response?.status === 401) {
          localStorage.removeItem('tile_shop_token');
          localStorage.removeItem('tile_shop_customer');
          window.dispatchEvent(new Event('trade-auth-change'));
        }
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setLoading(true);

    try {
      // 15 May 2026 — axios instead of fetch (Sentry-body-drain).
      const { data } = await axios.post(`${API_URL}/api/shop/auth/login`, { email, password });
      setWrongPasswordStreak(0);

      localStorage.setItem('tile_shop_token', data.token);
      localStorage.setItem('tile_shop_customer', JSON.stringify(data.customer));

      // Notify trade pricing hooks to refresh
      window.dispatchEvent(new Event('trade-auth-change'));

      toast.success('Welcome back!');
      navigate('/shop/trade/account');
    } catch (error) {
      let msg = error?.response?.data?.detail || 'Invalid email or password';
      try {
        const { data: ex } = await axios.post(`${API_URL}/api/shop/auth/email-exists`, { email });
        if (ex && ex.exists === false) {
          setEmailNotFound(true);
          msg = 'No account found for this email';
        } else {
          setWrongPasswordStreak(s => s + 1);
          msg = 'Invalid email or password';
        }
      } catch (_) { /* network blip on exists check — keep msg */ }
      toast.error(msg);
    } finally {
      setLoading(false);
    }
  };

  const tradeBenefits = [
    { icon: Percent, title: 'Exclusive Trade Pricing', desc: 'Access wholesale prices not available to retail customers' },
    ...(tiersEnabled
      ? [{ icon: Award, title: 'Tiered Rewards', desc: 'Bronze to Platinum — the more you buy, the more you save' }]
      : []),
    { icon: Truck, title: 'Priority Delivery', desc: 'Trade orders get priority scheduling and delivery slots' },
    { icon: Clock, title: 'Dedicated Support', desc: 'Extended hours trade support line with a named contact' },
    { icon: Shield, title: 'Trade Guarantee', desc: 'Extended warranty and hassle-free returns on all purchases' },
  ];

  return (
    <div className="min-h-screen bg-gray-50">
      <ShopHeader />

      {/* Hero Banner */}
      <div className="bg-[#1a1a1a] relative overflow-hidden">
        <div className="absolute inset-0 opacity-10">
          <div className="absolute inset-0" style={{
            backgroundImage: 'repeating-linear-gradient(45deg, transparent, transparent 35px, rgba(247,234,28,0.1) 35px, rgba(247,234,28,0.1) 70px)'
          }} />
        </div>
        <div className="container mx-auto px-4 py-8 relative">
          <div className="flex items-center gap-3">
            <div className="w-12 h-12 rounded-lg bg-[#F7EA1C] flex items-center justify-center">
              <Building2 className="h-6 w-6 text-[#1a1a1a]" />
            </div>
            <div>
              <h1 className="text-2xl font-bold text-white">Trade Account</h1>
              <p className="text-gray-400 text-sm">Exclusive access for trade professionals</p>
            </div>
          </div>
        </div>
      </div>

      {/* Main Content — Split Layout */}
      <div className="container mx-auto px-4 py-10">
        <div className="grid lg:grid-cols-2 gap-10 max-w-5xl mx-auto">

          {/* Left — Benefits Panel */}
          <div className="order-2 lg:order-1">
            <div className="bg-[#1a1a1a] rounded-2xl p-8 text-white h-full">
              <h2 className="text-xl font-bold text-[#F7EA1C] mb-2">Why Trade?</h2>
              <p className="text-gray-400 text-sm mb-8">Join hundreds of tradespeople who trust Tile Station for their projects.</p>

              <div className="space-y-6">
                {tradeBenefits.map((benefit, idx) => {
                  const Icon = benefit.icon;
                  return (
                    <div key={idx} className="flex gap-4 items-start">
                      <div className="w-10 h-10 rounded-lg bg-[#F7EA1C]/10 flex items-center justify-center flex-shrink-0">
                        <Icon className="h-5 w-5 text-[#F7EA1C]" />
                      </div>
                      <div>
                        <h3 className="font-semibold text-sm">{benefit.title}</h3>
                        <p className="text-gray-400 text-xs mt-0.5">{benefit.desc}</p>
                      </div>
                    </div>
                  );
                })}
              </div>

              {/* Trade Contact */}
              <div className="mt-10 pt-6 border-t border-white/10">
                <p className="text-xs text-gray-500 mb-3">Need help with your trade account?</p>
                <div className="flex items-center gap-3">
                  <div className="w-9 h-9 rounded-full bg-[#F7EA1C]/10 flex items-center justify-center">
                    <Phone className="h-4 w-4 text-[#F7EA1C]" />
                  </div>
                  <div>
                    <p className="text-sm font-medium text-white">Trade Team</p>
                    <p className="text-xs text-gray-400">trade@tilestation.co.uk</p>
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* Right — Login Form */}
          <div className="order-1 lg:order-2">
            <div className="bg-white rounded-2xl shadow-sm border border-gray-100 p-8">
              <div className="mb-8">
                <h2 className="text-xl font-bold text-gray-900">Trade Sign In</h2>
                <p className="text-gray-500 text-sm mt-1">Access your trade account dashboard</p>
              </div>

              <form onSubmit={handleSubmit} className="space-y-5" data-testid="trade-login-form">
                <div>
                  <Label htmlFor="trade-email">Email Address</Label>
                  <div className="relative mt-1.5">
                    <Mail className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
                    <Input
                      id="trade-email"
                      type="email"
                      value={email}
                      onChange={(e) => {
                        if (emailNotFound) setEmailNotFound(false);
                        if (wrongPasswordStreak > 0) setWrongPasswordStreak(0);
                        setEmail(e.target.value);
                      }}
                      placeholder="your@business.com"
                      className={`pl-10 ${emailNotFound ? 'border-amber-400 focus-visible:ring-amber-400' : ''}`}
                      required
                      data-testid="trade-login-email"
                    />
                  </div>
                  {emailNotFound && (
                    <div
                      className="mt-1.5 flex items-center justify-between gap-2 text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-md px-2.5 py-1.5"
                      data-testid="trade-email-not-found-hint"
                    >
                      <span>No trade account found for this email.</span>
                      <Link
                        to={`/shop/trade/register${email ? `?email=${encodeURIComponent(email)}` : ''}`}
                        className="font-semibold text-amber-900 hover:text-amber-950 underline whitespace-nowrap"
                        data-testid="trade-email-not-found-register-link"
                      >
                        Register instead →
                      </Link>
                    </div>
                  )}
                </div>

                <div>
                  <div className="flex justify-between items-center">
                    <Label htmlFor="trade-password">Password</Label>
                    <Link
                      to={`/shop/tile-forgot-password?type=trade${email ? `&email=${encodeURIComponent(email)}` : ''}`}
                      className={`text-xs transition-colors ${
                        wrongPasswordStreak >= 2
                          ? 'text-amber-700 hover:text-amber-900 font-semibold underline animate-pulse'
                          : 'text-gray-500 hover:text-[#333]'
                      }`}
                      data-testid="trade-forgot-password-link"
                    >
                      Forgot password?
                    </Link>
                  </div>
                  <div className="relative mt-1.5">
                    <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
                    <Input
                      id="trade-password"
                      type={showPassword ? 'text' : 'password'}
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      placeholder="Enter your password"
                      className="pl-10 pr-10"
                      required
                      data-testid="trade-login-password"
                    />
                    <button
                      type="button"
                      onClick={() => setShowPassword(!showPassword)}
                      className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
                    >
                      {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                    </button>
                  </div>
                </div>

                <Button
                  type="submit"
                  className="w-full bg-[#F7EA1C] hover:bg-[#e5d918] text-[#1a1a1a] font-semibold py-6 rounded-xl"
                  disabled={loading}
                  data-testid="trade-login-submit"
                >
                  {loading ? 'Signing in...' : 'Sign In to Trade Account'}
                  <ArrowRight className="ml-2 h-4 w-4" />
                </Button>
              </form>

              {/* Divider */}
              <div className="relative my-8">
                <div className="absolute inset-0 flex items-center">
                  <div className="w-full border-t border-gray-200" />
                </div>
                <div className="relative flex justify-center text-xs">
                  <span className="px-3 bg-white text-gray-400">Don't have a trade account?</span>
                </div>
              </div>

              {/* Apply CTA */}
              <Link
                to="/shop/trade/register"
                className="flex items-center justify-center gap-2 w-full border-2 border-[#1a1a1a] text-[#1a1a1a] font-semibold py-3 rounded-xl hover:bg-[#1a1a1a] hover:text-[#F7EA1C] transition-colors"
                data-testid="trade-apply-link"
              >
                <Building2 className="h-4 w-4" />
                Apply for a Trade Account
              </Link>

              {/* Regular customer link */}
              <div className="mt-6 text-center">
                <p className="text-xs text-gray-400">
                  Not a trade customer?{' '}
                  <Link to="/shop/tile-login" className="text-[#333] hover:text-[#F7EA1C] font-medium">
                    Sign in here
                  </Link>
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

export default TradeLoginPage;
