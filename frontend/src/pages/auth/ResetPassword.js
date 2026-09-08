import React, { useState, useEffect } from 'react';
import { Link, useSearchParams, useNavigate } from 'react-router-dom';
import { api } from '../../lib/api';
import { toast } from 'sonner';
import { Lock, ArrowLeft, CheckCircle, XCircle, Loader2, Eye, EyeOff } from 'lucide-react';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '../../components/ui/card';

const ResetPassword = () => {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const token = searchParams.get('token');
  
  const [verifying, setVerifying] = useState(true);
  const [tokenValid, setTokenValid] = useState(false);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [success, setSuccess] = useState(false);
  // Which sign-in this link belongs to (staff vs shop vs trade) and whether
  // it's a first-time "set up your account" link rather than a reset. The
  // `for=` hint in the emailed URL lets us route correctly even when the
  // token itself has expired.
  const forHint = searchParams.get('for');
  const hintPath = forHint === 'trade' ? '/shop/trade/login' : forHint === 'shop' ? '/shop/tile-login' : '/admin/login';
  const [loginPath, setLoginPath] = useState(hintPath);
  const [isTrade, setIsTrade] = useState(forHint === 'trade');
  const [isSetup, setIsSetup] = useState(false);
  const [autoSignedIn, setAutoSignedIn] = useState(false);

  useEffect(() => {
    const verifyToken = async () => {
      if (!token) {
        setVerifying(false);
        return;
      }

      try {
        const response = await api.verifyResetToken(token);
        setTokenValid(true);
        setEmail(response.data.email);
        if (response.data.login_path) setLoginPath(response.data.login_path);
        setIsTrade(!!response.data.is_trade);
        setIsSetup(response.data.purpose === 'setup');
      } catch (error) {
        setTokenValid(false);
      } finally {
        setVerifying(false);
      }
    };

    verifyToken();
  }, [token]);

  const handleSubmit = async (e) => {
    e.preventDefault();
    
    if (password.length < 8) {
      toast.error('Password must be at least 8 characters');
      return;
    }

    if (password !== confirmPassword) {
      toast.error('Passwords do not match');
      return;
    }

    setLoading(true);
    try {
      const { data } = await api.resetPassword(token, password);
      if (data?.login_path) setLoginPath(data.login_path);
      // Storefront/trade customers get a session back — sign them straight in.
      if (data?.account_type === 'shop' && data?.token) {
        localStorage.setItem('tile_shop_token', data.token);
        localStorage.setItem('tile_shop_customer', JSON.stringify(data.customer || {}));
        window.dispatchEvent(new Event('trade-auth-change'));
        setAutoSignedIn(true);
      }
      setSuccess(true);
      toast.success(isSetup ? 'Password set — welcome aboard!' : 'Password reset successfully!');
    } catch (error) {
      toast.error(error.response?.data?.detail || 'Failed to reset password');
    } finally {
      setLoading(false);
    }
  };

  const accountHome = isTrade ? '/shop/trade/account' : '/shop/account';

  // Loading state
  if (verifying) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50 px-4">
        <Card className="w-full max-w-md">
          <CardContent className="py-12 text-center">
            <Loader2 className="h-12 w-12 animate-spin text-blue-600 mx-auto mb-4" />
            <p className="text-gray-600">Verifying reset link...</p>
          </CardContent>
        </Card>
      </div>
    );
  }

  // Invalid or expired token
  if (!token || !tokenValid) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50 px-4">
        <Card className="w-full max-w-md">
          <CardHeader className="text-center">
            <div className="mx-auto w-16 h-16 bg-red-100 rounded-full flex items-center justify-center mb-4">
              <XCircle className="h-8 w-8 text-red-600" />
            </div>
            <CardTitle className="text-2xl">Invalid Reset Link</CardTitle>
            <CardDescription className="text-base mt-2">
              This password reset link is invalid or has expired.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-4 text-sm text-yellow-800">
              <p>Reset links expire after 1 hour (account set-up links after 7 days) for security reasons.</p>
            </div>
            <Link to={forHint === 'staff' || !forHint ? '/forgot-password' : `/shop/tile-forgot-password${forHint === 'trade' ? '?type=trade' : ''}`} className="block">
              <Button className="w-full" data-testid="request-new-reset-link">Request New Reset Link</Button>
            </Link>
            <Link to={loginPath} className="block">
              <Button variant="ghost" className="w-full">
                <ArrowLeft className="h-4 w-4 mr-2" /> Back to Login
              </Button>
            </Link>
          </CardContent>
        </Card>
      </div>
    );
  }

  // Success state
  if (success) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50 px-4">
        <Card className="w-full max-w-md">
          <CardHeader className="text-center">
            <div className="mx-auto w-16 h-16 bg-green-100 rounded-full flex items-center justify-center mb-4">
              <CheckCircle className="h-8 w-8 text-green-600" />
            </div>
            <CardTitle className="text-2xl">{isSetup ? 'You\'re all set!' : 'Password Reset!'}</CardTitle>
            <CardDescription className="text-base mt-2">
              {autoSignedIn
                ? `Your password has been saved and you're signed in${isTrade ? ' — your trade prices are live' : ''}.`
                : 'Your password has been reset successfully. You can now log in with your new password.'}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button 
              className="w-full" 
              onClick={() => navigate(autoSignedIn ? accountHome : loginPath)}
              data-testid="go-to-login"
            >
              {autoSignedIn ? (isTrade ? 'Go to my Trade account' : 'Go to my account') : 'Go to Login'}
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  // Reset form
  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 px-4">
      <Card className="w-full max-w-md">
        <CardHeader className="text-center">
          <div className="mx-auto w-16 h-16 bg-blue-100 rounded-full flex items-center justify-center mb-4">
            <Lock className="h-8 w-8 text-blue-600" />
          </div>
          <CardTitle className="text-2xl">{isSetup ? (isTrade ? 'Set up your Trade account' : 'Set up your account') : 'Reset Your Password'}</CardTitle>
          <CardDescription className="text-base mt-2">
            {isSetup ? 'Choose a password for ' : 'Enter a new password for '}<strong>{email}</strong>
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label className="text-sm font-medium mb-2 block">New Password</label>
              <div className="relative">
                <Input
                  type={showPassword ? "text" : "password"}
                  placeholder="Enter new password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                  minLength={8}
                  autoFocus
                  className="pr-10"
                  data-testid="new-password-input"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-500 hover:text-gray-700"
                  tabIndex={-1}
                >
                  {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
              <p className="text-xs text-gray-500 mt-1">Must be at least 8 characters</p>
            </div>
            <div>
              <label className="text-sm font-medium mb-2 block">Confirm Password</label>
              <div className="relative">
                <Input
                  type={showConfirmPassword ? "text" : "password"}
                  placeholder="Confirm new password"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  required
                  minLength={8}
                  className="pr-10"
                  data-testid="confirm-password-input"
                />
                <button
                  type="button"
                  onClick={() => setShowConfirmPassword(!showConfirmPassword)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-500 hover:text-gray-700"
                  tabIndex={-1}
                >
                  {showConfirmPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
            </div>
            <Button 
              type="submit" 
              className="w-full" 
              disabled={loading}
              data-testid="reset-password-submit"
            >
              {loading ? 'Saving...' : (isSetup ? 'Save password & sign in' : 'Reset Password')}
            </Button>
            <Link to={loginPath} className="block" data-testid="reset-back-to-login">
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

export default ResetPassword;
