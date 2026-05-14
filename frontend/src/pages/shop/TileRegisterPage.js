import React, { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { Mail, Lock, Eye, EyeOff, User, Phone, MapPin, ArrowRight } from 'lucide-react';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { Label } from '../../components/ui/label';
import { ShopHeader, ShopFooter } from './TileStationHome';
import { toast } from 'sonner';
import axios from 'axios';

const API_URL = process.env.REACT_APP_BACKEND_URL;

const TileRegisterPage = () => {
  const [searchParams] = useSearchParams();
  const redirect = searchParams.get('redirect') || '/tiles';
  const navigate = useNavigate();
  
  const [formData, setFormData] = useState({
    email: '',
    password: '',
    confirmPassword: '',
    name: '',
    phone: '',
    address_line1: '',
    address_line2: '',
    city: '',
    postcode: ''
  });
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);

  const handleChange = (e) => {
    const { name, value } = e.target;
    setFormData(prev => ({ ...prev, [name]: value }));
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    
    if (formData.password !== formData.confirmPassword) {
      toast.error('Passwords do not match');
      return;
    }
    
    if (formData.password.length < 8) {
      toast.error('Password must be at least 8 characters');
      return;
    }
    
    setLoading(true);
    
    try {
      // 14 May 2026 — use axios instead of fetch. Sentry's
      // browserTracingIntegration drains the fetch response body for
      // tracing, leaving our code unable to read error details (we got
      // "Response body is already used" on .clone().text()). axios
      // isn't instrumented by the fetch wrap, so the response body is
      // always readable. Backend returns `{detail: "Email already
      // registered"}` on 400 — we surface that as a friendly toast.
      const response = await axios.post(`${API_URL}/api/shop/auth/register`, {
        email: formData.email,
        password: formData.password,
        name: formData.name,
        phone: formData.phone,
        address_line1: formData.address_line1,
        address_line2: formData.address_line2,
        city: formData.city,
        postcode: formData.postcode,
      });
      const data = response.data;
      
      // Store token and customer data
      localStorage.setItem('tile_shop_token', data.token);
      localStorage.setItem('tile_shop_customer', JSON.stringify(data.customer));
      
      toast.success('Account created successfully!');
      navigate(redirect);
    } catch (error) {
      // 14 May 2026 — surface the actual backend error. Axios puts
      // the response body on error.response.data.
      let errMsg = error?.message || 'Registration failed';
      const detail = error?.response?.data?.detail;
      if (typeof detail === 'string') {
        errMsg = detail;
      } else if (Array.isArray(detail) && detail.length) {
        // FastAPI 422 validation error array
        errMsg = detail
          .map(d => d?.msg || (Array.isArray(d?.loc) ? d.loc.join('.') : ''))
          .filter(Boolean)
          .join('; ') || errMsg;
      } else if (error?.response?.data?.message) {
        errMsg = error.response.data.message;
      }
      // Friendlier copy for the most-common case
      if (/email.*(already|exist)/i.test(errMsg)) {
        errMsg = 'This email is already registered. Try signing in or reset your password.';
      }
      toast.error(errMsg);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-gray-50">
      <ShopHeader />
      
      <div className="container mx-auto px-4 py-12">
        <div className="max-w-lg mx-auto">
          {/* Breadcrumb */}
          <nav className="text-sm text-gray-500 mb-6">
            <Link to="/tiles" className="hover:text-[#F7EA1C]">Home</Link>
            <span className="mx-2">/</span>
            <span className="text-gray-900">Create Account</span>
          </nav>

          <div className="bg-white rounded-lg shadow-sm p-8">
            <div className="text-center mb-8">
              <h1 className="text-2xl font-bold text-gray-900">Create Account</h1>
              <p className="text-gray-500 mt-1">Join Tile Station today</p>
            </div>

            <form onSubmit={handleSubmit} className="space-y-5">
              {/* Basic Info */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <Label htmlFor="name">Full Name *</Label>
                  <div className="relative mt-1">
                    <User className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-gray-400" />
                    <Input
                      id="name"
                      name="name"
                      value={formData.name}
                      onChange={handleChange}
                      placeholder="John Doe"
                      className="pl-10"
                      required
                      data-testid="register-name-input"
                    />
                  </div>
                </div>
                <div>
                  <Label htmlFor="phone">Phone Number</Label>
                  <div className="relative mt-1">
                    <Phone className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-gray-400" />
                    <Input
                      id="phone"
                      name="phone"
                      type="tel"
                      value={formData.phone}
                      onChange={handleChange}
                      placeholder="07123 456789"
                      className="pl-10"
                      data-testid="register-phone-input"
                    />
                  </div>
                </div>
              </div>

              <div>
                <Label htmlFor="email">Email Address *</Label>
                <div className="relative mt-1">
                  <Mail className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-gray-400" />
                  <Input
                    id="email"
                    name="email"
                    type="email"
                    value={formData.email}
                    onChange={handleChange}
                    placeholder="you@example.com"
                    className="pl-10"
                    required
                    data-testid="register-email-input"
                  />
                </div>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <Label htmlFor="password">Password *</Label>
                  <div className="relative mt-1">
                    <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-gray-400" />
                    <Input
                      id="password"
                      name="password"
                      type={showPassword ? 'text' : 'password'}
                      value={formData.password}
                      onChange={handleChange}
                      placeholder="Min. 8 characters"
                      className="pl-10"
                      required
                      minLength={8}
                      data-testid="register-password-input"
                    />
                  </div>
                </div>
                <div>
                  <Label htmlFor="confirmPassword">Confirm Password *</Label>
                  <div className="relative mt-1">
                    <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-gray-400" />
                    <Input
                      id="confirmPassword"
                      name="confirmPassword"
                      type={showPassword ? 'text' : 'password'}
                      value={formData.confirmPassword}
                      onChange={handleChange}
                      placeholder="Confirm password"
                      className="pl-10 pr-10"
                      required
                      data-testid="register-confirm-password-input"
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
              </div>

              {/* Address (Optional) */}
              <div className="pt-4 border-t">
                <h3 className="text-sm font-medium text-gray-700 mb-3 flex items-center gap-2">
                  <MapPin className="w-4 h-4" />
                  Delivery Address (Optional)
                </h3>
                <p className="text-xs text-gray-500 mb-4">You can add this later during checkout</p>
                
                <div className="space-y-4">
                  <div>
                    <Label htmlFor="address_line1">Address Line 1</Label>
                    <Input
                      id="address_line1"
                      name="address_line1"
                      value={formData.address_line1}
                      onChange={handleChange}
                      placeholder="123 High Street"
                      className="mt-1"
                    />
                  </div>
                  <div>
                    <Label htmlFor="address_line2">Address Line 2</Label>
                    <Input
                      id="address_line2"
                      name="address_line2"
                      value={formData.address_line2}
                      onChange={handleChange}
                      placeholder="Apartment, unit, etc."
                      className="mt-1"
                    />
                  </div>
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <Label htmlFor="city">City</Label>
                      <Input
                        id="city"
                        name="city"
                        value={formData.city}
                        onChange={handleChange}
                        placeholder="London"
                        className="mt-1"
                      />
                    </div>
                    <div>
                      <Label htmlFor="postcode">Postcode</Label>
                      <Input
                        id="postcode"
                        name="postcode"
                        value={formData.postcode}
                        onChange={handleChange}
                        placeholder="SW1A 1AA"
                        className="mt-1"
                      />
                    </div>
                  </div>
                </div>
              </div>

              <Button
                type="submit"
                className="w-full bg-[#333333] hover:bg-[#444444] text-[#F7EA1C] font-semibold py-6"
                disabled={loading}
                data-testid="register-submit-btn"
              >
                {loading ? 'Creating Account...' : 'Create Account'}
                <ArrowRight className="ml-2 h-4 w-4" />
              </Button>
            </form>

            {/* Social Register Divider */}
            <div className="relative mt-6">
              <div className="absolute inset-0 flex items-center">
                <div className="w-full border-t border-gray-200"></div>
              </div>
              <div className="relative flex justify-center text-sm">
                <span className="px-3 bg-white text-gray-500">Or sign up with</span>
              </div>
            </div>

            {/* Social Register Buttons */}
            <div className="grid grid-cols-3 gap-3 mt-6">
              <button
                type="button"
                className="flex items-center justify-center px-4 py-3 border border-gray-300 rounded-lg hover:bg-gray-50 transition"
                onClick={() => toast.info('Google sign-up coming soon!')}
                data-testid="google-register-btn"
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
                className="flex items-center justify-center px-4 py-3 border border-gray-300 rounded-lg hover:bg-gray-50 transition"
                onClick={() => toast.info('Facebook sign-up coming soon!')}
                data-testid="facebook-register-btn"
              >
                <svg className="w-5 h-5" fill="#1877F2" viewBox="0 0 24 24">
                  <path d="M24 12.073c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.99 4.388 10.954 10.125 11.854v-8.385H7.078v-3.47h3.047V9.43c0-3.007 1.792-4.669 4.533-4.669 1.312 0 2.686.235 2.686.235v2.953H15.83c-1.491 0-1.956.925-1.956 1.874v2.25h3.328l-.532 3.47h-2.796v8.385C19.612 23.027 24 18.062 24 12.073z"/>
                </svg>
              </button>
              <button
                type="button"
                className="flex items-center justify-center px-4 py-3 border border-gray-300 rounded-lg hover:bg-gray-50 transition"
                onClick={() => toast.info('Instagram sign-up coming soon!')}
                data-testid="instagram-register-btn"
              >
                <svg className="w-5 h-5" viewBox="0 0 24 24">
                  <defs>
                    <linearGradient id="ig-gradient" x1="0%" y1="100%" x2="100%" y2="0%">
                      <stop offset="0%" stopColor="#FFDC80"/>
                      <stop offset="25%" stopColor="#F77737"/>
                      <stop offset="50%" stopColor="#E1306C"/>
                      <stop offset="75%" stopColor="#C13584"/>
                      <stop offset="100%" stopColor="#833AB4"/>
                    </linearGradient>
                  </defs>
                  <path fill="url(#ig-gradient)" d="M12 2.163c3.204 0 3.584.012 4.85.07 3.252.148 4.771 1.691 4.919 4.919.058 1.265.069 1.645.069 4.849 0 3.205-.012 3.584-.069 4.849-.149 3.225-1.664 4.771-4.919 4.919-1.266.058-1.644.07-4.85.07-3.204 0-3.584-.012-4.849-.07-3.26-.149-4.771-1.699-4.919-4.92-.058-1.265-.07-1.644-.07-4.849 0-3.204.013-3.583.07-4.849.149-3.227 1.664-4.771 4.919-4.919 1.266-.057 1.645-.069 4.849-.069zm0-2.163c-3.259 0-3.667.014-4.947.072-4.358.2-6.78 2.618-6.98 6.98-.059 1.281-.073 1.689-.073 4.948 0 3.259.014 3.668.072 4.948.2 4.358 2.618 6.78 6.98 6.98 1.281.058 1.689.072 4.948.072 3.259 0 3.668-.014 4.948-.072 4.354-.2 6.782-2.618 6.979-6.98.059-1.28.073-1.689.073-4.948 0-3.259-.014-3.667-.072-4.947-.196-4.354-2.617-6.78-6.979-6.98-1.281-.059-1.69-.073-4.949-.073zm0 5.838c-3.403 0-6.162 2.759-6.162 6.162s2.759 6.163 6.162 6.163 6.162-2.759 6.162-6.163c0-3.403-2.759-6.162-6.162-6.162zm0 10.162c-2.209 0-4-1.79-4-4 0-2.209 1.791-4 4-4s4 1.791 4 4c0 2.21-1.791 4-4 4zm6.406-11.845c-.796 0-1.441.645-1.441 1.44s.645 1.44 1.441 1.44c.795 0 1.439-.645 1.439-1.44s-.644-1.44-1.439-1.44z"/>
                </svg>
              </button>
            </div>

            <div className="mt-6 text-center">
              <p className="text-gray-500">
                Already have an account?{' '}
                <Link
                  to={`/shop/tile-login${redirect !== '/tiles' ? `?redirect=${encodeURIComponent(redirect)}` : ''}`}
                  className="text-[#333333] hover:text-[#F7EA1C] font-medium"
                  data-testid="sign-in-link"
                >
                  Sign in
                </Link>
              </p>
            </div>

            <p className="mt-4 text-xs text-gray-400 text-center">
              By creating an account, you agree to our{' '}
              <Link to="/shop/terms" className="underline hover:text-gray-600">Terms of Service</Link>
              {' '}and{' '}
              <Link to="/shop/privacy" className="underline hover:text-gray-600">Privacy Policy</Link>.
            </p>
          </div>
        </div>
      </div>

      <ShopFooter />
    </div>
  );
};

export default TileRegisterPage;
