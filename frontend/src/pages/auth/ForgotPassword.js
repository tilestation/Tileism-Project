import React, { useEffect, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { api } from '../../lib/api';
import { toast } from 'sonner';
import { Mail, ArrowLeft, CheckCircle } from 'lucide-react';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '../../components/ui/card';

const ForgotPassword = () => {
  const [email, setEmail] = useState('');
  const [loading, setLoading] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const location = useLocation();

  // Storefront customers arrive via /shop/tile-forgot-password (trade adds
  // ?type=trade) — send them back to the right sign-in, not the staff one.
  const isShop = location.pathname.startsWith('/shop/');
  const isTrade = new URLSearchParams(location.search).get('type') === 'trade';
  const loginPath = isShop ? (isTrade ? '/shop/trade/login' : '/shop/tile-login') : '/admin/login';

  // Pre-fill email from `?email=` query param (set by the login pages when
  // the user clicks "Forgot password?" — saves them retyping their address
  // and shaves a step off the recovery flow).
  useEffect(() => {
    const params = new URLSearchParams(location.search);
    const fromQuery = params.get('email');
    if (fromQuery) setEmail(fromQuery.trim());
  }, [location.search]);

  const handleSubmit = async (e) => {
    e.preventDefault();
    
    if (!email.trim()) {
      toast.error('Please enter your email address');
      return;
    }

    setLoading(true);
    try {
      // Tell the server which account this page belongs to — the same email can
      // be both a staff login and a trade account.
      await api.forgotPassword(email.trim(), isShop ? 'shop' : 'staff');
      setSubmitted(true);
      toast.success('Password reset instructions sent!');
    } catch (error) {
      // Always show success to prevent email enumeration
      setSubmitted(true);
    } finally {
      setLoading(false);
    }
  };

  if (submitted) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50 px-4">
        <Card className="w-full max-w-md">
          <CardHeader className="text-center">
            <div className="mx-auto w-16 h-16 bg-green-100 rounded-full flex items-center justify-center mb-4">
              <CheckCircle className="h-8 w-8 text-green-600" />
            </div>
            <CardTitle className="text-2xl">Check Your Email</CardTitle>
            <CardDescription className="text-base mt-2">
              If an account exists for <strong>{email}</strong>, you will receive a password reset link shortly.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="bg-blue-50 border border-blue-200 rounded-lg p-4 text-sm text-blue-800">
              <p className="font-medium mb-1">Didn&apos;t receive the email?</p>
              <ul className="list-disc list-inside space-y-1 text-blue-700">
                <li>Check your spam/junk folder</li>
                <li>Make sure you entered the correct email</li>
                <li>Wait a few minutes and try again</li>
                {isTrade && <li>Set up in-store? Ring your showroom and they can send you a login link straight away</li>}
              </ul>
            </div>
            <div className="flex flex-col gap-2">
              <Button 
                variant="outline" 
                onClick={() => setSubmitted(false)}
                className="w-full"
              >
                Try a different email
              </Button>
              <Link to={loginPath} className="w-full" data-testid="forgot-back-to-login">
                <Button variant="ghost" className="w-full">
                  <ArrowLeft className="h-4 w-4 mr-2" /> Back to Login
                </Button>
              </Link>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 px-4">
      <Card className="w-full max-w-md">
        <CardHeader className="text-center">
          <div className="mx-auto w-16 h-16 bg-blue-100 rounded-full flex items-center justify-center mb-4">
            <Mail className="h-8 w-8 text-blue-600" />
          </div>
          <CardTitle className="text-2xl">Forgot Password?</CardTitle>
          <CardDescription className="text-base mt-2">
            {isTrade
              ? "Enter your trade account email and we'll send you a link to set a new password."
              : "No worries! Enter your email and we'll send you a link to reset your password."}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label className="text-sm font-medium mb-2 block">Email Address</label>
              <Input
                type="email"
                placeholder="you@example.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                autoFocus
                data-testid="forgot-password-email"
              />
            </div>
            <Button 
              type="submit" 
              className="w-full" 
              disabled={loading}
              data-testid="forgot-password-submit"
            >
              {loading ? 'Sending...' : 'Send Reset Link'}
            </Button>
            <Link to={loginPath} className="block" data-testid="forgot-back-to-login-form">
              <Button variant="ghost" className="w-full">
                <ArrowLeft className="h-4 w-4 mr-2" /> Back to Login
              </Button>
            </Link>
          </form>
        </CardContent>
      </Card>
    </div>
  );
};

export default ForgotPassword;
