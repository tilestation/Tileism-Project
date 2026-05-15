import React, { useState, useEffect } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { Mail, Lock, Eye, EyeOff, ArrowRight } from 'lucide-react';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { Label } from '../../components/ui/label';
import { ShopHeader, ShopFooter } from './TileStationHome';
import { toast } from 'sonner';
import axios from 'axios';

const API_URL = process.env.REACT_APP_BACKEND_URL;

const TileLoginPage = () => {
  const [searchParams] = useSearchParams();
  const redirect = searchParams.get('redirect') || '/tiles';
  const navigate = useNavigate();
  
  // Pre-fill email when arriving from the "Already registered? Sign in →"
  // hint on the register page (passes email via ?email=).
  const [email, setEmail] = useState(searchParams.get('email') || '');
  const [password, setPassword] = useState('');
  // Mirror of the register-page hint: when login fails AND the email isn't
  // registered, show "No account found — Register instead →" rather than
  // making the customer guess "wrong password or no account?". Cleared on
  // edit. The exists check is rate-limited server-side.
  const [emailNotFound, setEmailNotFound] = useState(false);
  // Nudges the "Forgot password?" link to amber on a 2nd+ consecutive
  // failed login when the email DOES exist — lowers support load for
  // the classic "I know my email but keep typing the wrong password"
  // scenario. Resets on successful login or when the email is edited.
  const [wrongPasswordStreak, setWrongPasswordStreak] = useState(0);
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);

  // If a still-valid token exists, validate it server-side and skip the form.
  // Prevents the redirect loop where a logged-in user repeatedly sees the
  // login page when their cached customer + valid token combine with a
  // 401 from a stale endpoint.
  // If a still-valid token exists, validate it server-side and skip the form.
  // Prevents the redirect loop where a logged-in user repeatedly sees the
  // login page when their cached customer + valid token combine with a
  // 401 from a stale endpoint.
  useEffect(() => {
    const token = localStorage.getItem('tile_shop_token');
    if (!token) return;
    let cancelled = false;
    (async () => {
      try {
        // 15 May 2026 — moved from fetch() to axios. Sentry's
        // browserTracingIntegration consumes fetch response bodies for
        // tracing, leaving our code unable to read the JSON. Axios
        // isn't instrumented by Sentry's fetch wrap.
        const { data: customer } = await axios.get(`${API_URL}/api/shop/auth/me`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (cancelled) return;
        try { localStorage.setItem('tile_shop_customer', JSON.stringify(customer)); } catch {}
        window.dispatchEvent(new Event('trade-auth-change'));
        const target = redirect && redirect !== '/tiles'
          ? redirect
          : (customer.is_trade ? '/shop/trade/account' : '/shop/account');
        navigate(target, { replace: true });
      } catch (err) {
        // 401 → token rejected; anything else (network) → leave state alone.
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
      // Success — reset the streak so any future failures start clean.
      setWrongPasswordStreak(0);
      
      // Store token and customer data
      localStorage.setItem('tile_shop_token', data.token);
      localStorage.setItem('tile_shop_customer', JSON.stringify(data.customer));
      
      // Notify trade pricing hooks to refresh
      window.dispatchEvent(new Event('trade-auth-change'));
      
      toast.success('Welcome back!');
      navigate(redirect);
    } catch (error) {
      // Login failed — distinguish "no account" vs "wrong password" so
      // the UI can show targeted hints. Quietly fall back to generic
      // text on any error.
      let msg = error?.response?.data?.detail || error?.message || 'Invalid email or password';
      try {
        const { data: ex } = await axios.post(`${API_URL}/api/shop/auth/email-exists`, { email });
        if (ex && ex.exists === false) {
          setEmailNotFound(true);
          msg = 'No account found for this email';
        } else {
          setWrongPasswordStreak(s => s + 1);
          msg = 'Invalid email or password';
        }
      } catch (_) { /* network blip on the exists check — keep generic */ }
      toast.error(msg);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-gray-50">
      <ShopHeader />
      
      <div className="container mx-auto px-4 py-12">
        <div className="max-w-md mx-auto">
          {/* Breadcrumb */}
          <nav className="text-sm text-gray-500 mb-6">
            <Link to="/tiles" className="hover:text-[#F7EA1C]">Home</Link>
            <span className="mx-2">/</span>
            <span className="text-gray-900">Sign In</span>
          </nav>

          <div className="bg-white rounded-lg shadow-sm p-8">
            <div className="text-center mb-8">
              <h1 className="text-2xl font-bold text-gray-900">Welcome Back</h1>
              <p className="text-gray-500 mt-1">Sign in to your account</p>
            </div>

            <form onSubmit={handleSubmit} className="space-y-5">
              <div>
                <Label htmlFor="email">Email Address</Label>
                <div className="relative mt-1">
                  <Mail className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-gray-400" />
                  <Input
                    id="email"
                    type="email"
                    value={email}
                    onChange={(e) => {
                      if (emailNotFound) setEmailNotFound(false);
                      if (wrongPasswordStreak > 0) setWrongPasswordStreak(0);
                      setEmail(e.target.value);
                    }}
                    placeholder="you@example.com"
                    className={`pl-10 ${emailNotFound ? 'border-amber-400 focus-visible:ring-amber-400' : ''}`}
                    required
                    data-testid="login-email-input"
                  />
                </div>
                {emailNotFound && (
                  <div
                    className="mt-1.5 flex items-center justify-between gap-2 text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-md px-2.5 py-1.5"
                    data-testid="email-not-found-hint"
                  >
                    <span>No account found for this email.</span>
                    <Link
                      to={`/shop/register${email ? `?email=${encodeURIComponent(email)}` : ''}`}
                      className="font-semibold text-amber-900 hover:text-amber-950 underline whitespace-nowrap"
                      data-testid="email-not-found-register-link"
                    >
                      Register instead →
                    </Link>
                  </div>
                )}
              </div>

              <div>
                <div className="flex justify-between items-center">
                  <Label htmlFor="password">Password</Label>
                  <Link
                    to={`/shop/tile-forgot-password${email ? `?email=${encodeURIComponent(email)}` : ''}`}
                    className={`text-sm font-medium transition-colors ${
                      wrongPasswordStreak >= 2
                        ? 'text-amber-700 hover:text-amber-900 underline animate-pulse'
                        : 'text-[#333333] hover:text-[#F7EA1C]'
                    }`}
                    data-testid="forgot-password-link"
                  >
                    Forgot password?
                  </Link>
                </div>
                <div className="relative mt-1">
                  <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-gray-400" />
                  <Input
                    id="password"
                    type={showPassword ? 'text' : 'password'}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="••••••••"
                    className="pl-10 pr-10"
                    required
                    data-testid="login-password-input"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword(!showPassword)}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
                  >
                    {showPassword ? <EyeOff className="w-5 h-5" /> : <Eye className="w-5 h-5" />}
                  </button>
                </div>
              </div>

              <Button
                type="submit"
                className="w-full bg-[#333333] hover:bg-[#444444] text-[#F7EA1C] font-semibold py-6"
                disabled={loading}
                data-testid="login-submit-btn"
              >
                {loading ? 'Signing in...' : 'Sign In'}
                <ArrowRight className="ml-2 h-4 w-4" />
              </Button>
            </form>

            {/* Social Login Divider */}
            <div className="relative mt-6">
              <div className="absolute inset-0 flex items-center">
                <div className="w-full border-t border-gray-200"></div>
              </div>
              <div className="relative flex justify-center text-sm">
                <span className="px-3 bg-white text-gray-500">Or continue with</span>
              </div>
            </div>

            {/* Social Login Buttons */}
            <div className="grid grid-cols-3 gap-3 mt-6">
              <button
                type="button"
                className="flex items-center justify-center px-4 py-3 border border-gray-300 rounded-lg hover:bg-gray-50 transition group"
                onClick={() => toast.info('Google sign-in coming soon!')}
                data-testid="google-login-btn"
              >
                <svg className="w-5 h-5" viewBox="0 0 24 24">
                  <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
                  <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
                  <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/>
                  <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/>
                </svg>
              </button>
              <button
                type="button"
                className="flex items-center justify-center px-4 py-3 border border-gray-300 rounded-lg hover:bg-gray-50 transition group"
                onClick={() => toast.info('Facebook sign-in coming soon!')}
                data-testid="facebook-login-btn"
              >
                <svg className="w-5 h-5" fill="#1877F2" viewBox="0 0 24 24">
                  <path d="M24 12.073c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.99 4.388 10.954 10.125 11.854v-8.385H7.078v-3.47h3.047V9.43c0-3.007 1.792-4.669 4.533-4.669 1.312 0 2.686.235 2.686.235v2.953H15.83c-1.491 0-1.956.925-1.956 1.874v2.25h3.328l-.532 3.47h-2.796v8.385C19.612 23.027 24 18.062 24 12.073z"/>
                </svg>
              </button>
              <button
                type="button"
                className="flex items-center justify-center px-4 py-3 border border-gray-300 rounded-lg hover:bg-gray-50 transition group"
                onClick={() => toast.info('Instagram sign-in coming soon!')}
                data-testid="instagram-login-btn"
              >
                <svg className="w-5 h-5" viewBox="0 0 24 24">
                  <defs>
                    <linearGradient id="instagram-gradient" x1="0%" y1="100%" x2="100%" y2="0%">
                      <stop offset="0%" stopColor="#FFDC80"/>
                      <stop offset="25%" stopColor="#F77737"/>
                      <stop offset="50%" stopColor="#E1306C"/>
                      <stop offset="75%" stopColor="#C13584"/>
                      <stop offset="100%" stopColor="#833AB4"/>
                    </linearGradient>
                  </defs>
                  <path fill="url(#instagram-gradient)" d="M12 2.163c3.204 0 3.584.012 4.85.07 3.252.148 4.771 1.691 4.919 4.919.058 1.265.069 1.645.069 4.849 0 3.205-.012 3.584-.069 4.849-.149 3.225-1.664 4.771-4.919 4.919-1.266.058-1.644.07-4.85.07-3.204 0-3.584-.012-4.849-.07-3.26-.149-4.771-1.699-4.919-4.92-.058-1.265-.07-1.644-.07-4.849 0-3.204.013-3.583.07-4.849.149-3.227 1.664-4.771 4.919-4.919 1.266-.057 1.645-.069 4.849-.069zm0-2.163c-3.259 0-3.667.014-4.947.072-4.358.2-6.78 2.618-6.98 6.98-.059 1.281-.073 1.689-.073 4.948 0 3.259.014 3.668.072 4.948.2 4.358 2.618 6.78 6.98 6.98 1.281.058 1.689.072 4.948.072 3.259 0 3.668-.014 4.948-.072 4.354-.2 6.782-2.618 6.979-6.98.059-1.28.073-1.689.073-4.948 0-3.259-.014-3.667-.072-4.947-.196-4.354-2.617-6.78-6.979-6.98-1.281-.059-1.69-.073-4.949-.073zm0 5.838c-3.403 0-6.162 2.759-6.162 6.162s2.759 6.163 6.162 6.163 6.162-2.759 6.162-6.163c0-3.403-2.759-6.162-6.162-6.162zm0 10.162c-2.209 0-4-1.79-4-4 0-2.209 1.791-4 4-4s4 1.791 4 4c0 2.21-1.791 4-4 4zm6.406-11.845c-.796 0-1.441.645-1.441 1.44s.645 1.44 1.441 1.44c.795 0 1.439-.645 1.439-1.44s-.644-1.44-1.439-1.44z"/>
                </svg>
              </button>
            </div>

            <div className="mt-6 text-center">
              <p className="text-gray-500">
                Don't have an account?{' '}
                <Link
                  to={`/shop/tile-register${redirect !== '/tiles' ? `?redirect=${encodeURIComponent(redirect)}` : ''}`}
                  className="text-[#333333] hover:text-[#F7EA1C] font-medium"
                  data-testid="create-account-link"
                >
                  Create one
                </Link>
              </p>
            </div>

            <div className="mt-6 pt-6 border-t text-center">
              <Link to="/tiles" className="text-sm text-gray-500 hover:text-gray-700">
                ← Continue as Guest
              </Link>
            </div>
          </div>

          {/* Benefits */}
          <div className="mt-8 bg-[#333333] rounded-lg p-6 text-white">
            <h3 className="font-semibold text-[#F7EA1C] mb-4">Why create an account?</h3>
            <ul className="space-y-2 text-sm text-gray-300">
              <li className="flex items-start gap-2">
                <span className="text-[#F7EA1C]">✓</span>
                Track your orders easily
              </li>
              <li className="flex items-start gap-2">
                <span className="text-[#F7EA1C]">✓</span>
                Save your delivery addresses
              </li>
              <li className="flex items-start gap-2">
                <span className="text-[#F7EA1C]">✓</span>
                Faster checkout experience
              </li>
              <li className="flex items-start gap-2">
                <span className="text-[#F7EA1C]">✓</span>
                Access to exclusive trade pricing
              </li>
            </ul>
          </div>
        </div>
      </div>

      <ShopFooter />
    </div>
  );
};

export default TileLoginPage;
