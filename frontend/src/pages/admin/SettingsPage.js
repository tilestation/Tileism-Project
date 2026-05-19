import React, { useState, useEffect, useCallback } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';
import { api } from '../../lib/api';
import { toast } from 'sonner';
import { 
  Settings, User, Shield, Building2, Key, Bell, 
  Lock, Eye, EyeOff, Save, RefreshCw, Check, X,
  Users, ShoppingCart, Package, FileText, TrendingUp,
  Megaphone, MessageSquare, ClipboardList, Mail,
  Monitor, Smartphone
} from 'lucide-react';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { Card } from '../../components/ui/card';
import { Switch } from '../../components/ui/switch';

// Permission definitions with icons and descriptions
const PERMISSION_DEFINITIONS = {
  dashboard: {
    label: 'Dashboard',
    description: 'View dashboard statistics and analytics',
    icon: TrendingUp,
    color: 'blue'
  },
  products: {
    label: 'Products',
    description: 'Manage products, stock levels, and pricing',
    icon: Package,
    color: 'green'
  },
  orders: {
    label: 'Orders',
    description: 'View and manage customer orders',
    icon: ShoppingCart,
    color: 'purple'
  },
  customers: {
    label: 'Customers',
    description: 'View and manage customer accounts',
    icon: Users,
    color: 'amber'
  },
  epos: {
    label: 'EPOS',
    description: 'Access invoicing and point of sale',
    icon: FileText,
    color: 'indigo'
  },
  reports: {
    label: 'Reports',
    description: 'View sales reports and analytics',
    icon: ClipboardList,
    color: 'cyan'
  },
  marketing: {
    label: 'Marketing',
    description: 'Manage campaigns, emails, and promotions',
    icon: Megaphone,
    color: 'pink'
  },
  users: {
    label: 'User Management',
    description: 'Manage staff accounts and permissions',
    icon: Users,
    color: 'red'
  },
  settings: {
    label: 'Settings',
    description: 'Access system settings and configuration',
    icon: Settings,
    color: 'gray'
  },
  pricing: {
    label: 'Customer Pricing',
    description: 'Set custom pricing for customers',
    icon: Key,
    color: 'emerald'
  },
  bulk_inquiries: {
    label: 'Bulk Inquiries',
    description: 'Manage bulk order inquiries',
    icon: MessageSquare,
    color: 'orange'
  },
  audit: {
    label: 'Audit Trail',
    description: 'View system audit logs',
    icon: Eye,
    color: 'slate'
  }
};

const PermissionBadge = ({ permission, granted }) => {
  const def = PERMISSION_DEFINITIONS[permission] || {
    label: permission,
    description: '',
    icon: Shield,
    color: 'gray'
  };
  const Icon = def.icon;
  
  return (
    <div className={`flex items-center gap-3 p-3 rounded-lg border ${
      granted 
        ? 'bg-green-50 border-green-200' 
        : 'bg-gray-50 border-gray-200 opacity-50'
    }`}>
      <div className={`p-2 rounded-lg ${granted ? 'bg-green-100' : 'bg-gray-100'}`}>
        <Icon className={`h-5 w-5 ${granted ? 'text-green-600' : 'text-gray-400'}`} />
      </div>
      <div className="flex-1">
        <div className="flex items-center gap-2">
          <span className="font-medium">{def.label}</span>
          {granted ? (
            <Check className="h-4 w-4 text-green-600" />
          ) : (
            <X className="h-4 w-4 text-gray-400" />
          )}
        </div>
        <p className="text-xs text-muted-foreground">{def.description}</p>
      </div>
    </div>
  );
};

// Valid tabs for Settings page
const VALID_SETTINGS_TABS = ['profile', 'permissions', 'security'];

export const SettingsPage = () => {
  const { user, logout } = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();
  
  // Get initial tab from URL
  const getInitialTab = useCallback(() => {
    const urlTab = searchParams.get('tab');
    if (urlTab && VALID_SETTINGS_TABS.includes(urlTab)) {
      return urlTab;
    }
    return 'profile';
  }, [searchParams]);

  const [loading, setLoading] = useState(false);
  const [showrooms, setStores] = useState([]);
  const [passwordData, setPasswordData] = useState({
    current_password: '',
    new_password: '',
    confirm_password: ''
  });
  const [showPasswords, setShowPasswords] = useState(false);
  const [changingPassword, setChangingPassword] = useState(false);
  const [activeTab, setActiveTab] = useState(getInitialTab);

  // Handle tab change with URL update
  const handleTabChange = useCallback((newTab) => {
    setActiveTab(newTab);
    setSearchParams({ tab: newTab }, { replace: true });
  }, [setSearchParams]);

  // Sync tab with URL on mount
  useEffect(() => {
    const urlTab = searchParams.get('tab');
    if (!urlTab) {
      setSearchParams({ tab: activeTab }, { replace: true });
    }
  }, [searchParams, activeTab, setSearchParams]);

  useEffect(() => {
    fetchStores();
  }, []);

  // Honour `#device-approvals` (and similar) anchors from email deep
  // links. React Router doesn't auto-scroll on hash, so we do it
  // manually after the page paints. Retries for a few hundred ms to
  // catch the case where the target card mounts after a lazy import.
  useEffect(() => {
    const hash = window.location.hash;
    if (!hash) return;
    let attempts = 0;
    const id = hash.slice(1);
    const tryScroll = () => {
      const el = document.getElementById(id);
      if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'start' });
        // Brief highlight so the admin's eye lands on the right card
        el.style.transition = 'box-shadow 0.4s ease-out';
        el.style.boxShadow = '0 0 0 3px rgba(217,119,6,0.45)';
        setTimeout(() => { el.style.boxShadow = ''; }, 2200);
        return;
      }
      if (attempts++ < 20) setTimeout(tryScroll, 100);
    };
    tryScroll();
  }, []);

  const fetchStores = async () => {
    try {
      const res = await api.getStores();
      setStores(res.data || []);
    } catch (error) {
      console.error('Failed to load showrooms:', error);
    }
  };

  const handleChangePassword = async (e) => {
    e.preventDefault();
    
    if (passwordData.new_password !== passwordData.confirm_password) {
      toast.error('New passwords do not match');
      return;
    }
    
    if (passwordData.new_password.length < 8) {
      toast.error('Password must be at least 8 characters');
      return;
    }
    
    setChangingPassword(true);
    try {
      await api.changePassword({
        current_password: passwordData.current_password,
        new_password: passwordData.new_password
      });
      toast.success('Password changed successfully');
      setPasswordData({ current_password: '', new_password: '', confirm_password: '' });
    } catch (error) {
      toast.error(error.response?.data?.detail || 'Failed to change password');
    } finally {
      setChangingPassword(false);
    }
  };

  const getUserStore = () => {
    if (user?.showroom_id) {
      const showroom = showrooms.find(s => s.id === user.showroom_id);
      return showroom?.name || 'Unknown Store';
    }
    return null;
  };

  const getAllPermissions = () => {
    return Object.keys(PERMISSION_DEFINITIONS);
  };

  const hasPermission = (permission) => {
    if (user?.role === 'super_admin') return true;
    return user?.permissions?.includes(permission) || false;
  };

  const getRoleBadge = (role) => {
    const badges = {
      super_admin: { label: 'Super Admin', color: 'bg-purple-100 text-purple-800 border-purple-200' },
      admin: { label: 'Admin', color: 'bg-blue-100 text-blue-800 border-blue-200' },
      manager: { label: 'Manager', color: 'bg-green-100 text-green-800 border-green-200' },
      staff: { label: 'Staff', color: 'bg-gray-100 text-gray-800 border-gray-200' },
      customer: { label: 'Customer', color: 'bg-amber-100 text-amber-800 border-amber-200' }
    };
    const badge = badges[role] || badges.staff;
    return (
      <span className={`px-3 py-1 text-sm font-medium rounded-full border ${badge.color}`}>
        {badge.label}
      </span>
    );
  };

  return (
    <div className="space-y-6" data-testid="settings-page">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-4xl font-heading font-bold tracking-tightest mb-2">Settings</h1>
          <p className="text-muted-foreground">Manage your account and view permissions</p>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex gap-2 border-b pb-4">
        <button
          onClick={() => handleTabChange('profile')}
          className={`px-4 py-2 rounded-lg font-medium transition-all flex items-center gap-2 ${
            activeTab === 'profile'
              ? 'bg-primary text-primary-foreground shadow-md'
              : 'bg-muted hover:bg-muted/80 text-muted-foreground'
          }`}
        >
          <User className="h-4 w-4" />
          Profile
        </button>
        <button
          onClick={() => handleTabChange('permissions')}
          className={`px-4 py-2 rounded-lg font-medium transition-all flex items-center gap-2 ${
            activeTab === 'permissions'
              ? 'bg-primary text-primary-foreground shadow-md'
              : 'bg-muted hover:bg-muted/80 text-muted-foreground'
          }`}
        >
          <Shield className="h-4 w-4" />
          Permissions
        </button>
        <button
          onClick={() => handleTabChange('security')}
          className={`px-4 py-2 rounded-lg font-medium transition-all flex items-center gap-2 ${
            activeTab === 'security'
              ? 'bg-primary text-primary-foreground shadow-md'
              : 'bg-muted hover:bg-muted/80 text-muted-foreground'
          }`}
        >
          <Lock className="h-4 w-4" />
          Security
        </button>
      </div>

      {/* Profile Tab */}
      {activeTab === 'profile' && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* User Info Card */}
          <Card className="p-6">
            <h3 className="font-semibold text-lg mb-4 flex items-center gap-2">
              <User className="h-5 w-5" />
              Account Information
            </h3>
            
            <div className="space-y-4">
              <div className="flex items-center justify-between p-3 bg-gray-50 rounded-lg">
                <span className="text-muted-foreground">Name</span>
                <span className="font-medium">{user?.name || 'Not set'}</span>
              </div>
              
              <div className="flex items-center justify-between p-3 bg-gray-50 rounded-lg">
                <span className="text-muted-foreground">Email</span>
                <span className="font-medium">{user?.email}</span>
              </div>
              
              <div className="flex items-center justify-between p-3 bg-gray-50 rounded-lg">
                <span className="text-muted-foreground">Role</span>
                {getRoleBadge(user?.role)}
              </div>
              
              {getUserStore() && (
                <div className="flex items-center justify-between p-3 bg-blue-50 rounded-lg border border-blue-200">
                  <span className="text-blue-700 flex items-center gap-2">
                    <Building2 className="h-4 w-4" />
                    Assigned Store
                  </span>
                  <span className="font-medium text-blue-800">{getUserStore()}</span>
                </div>
              )}
              
              {!getUserStore() && user?.role !== 'customer' && (
                <div className="flex items-center justify-between p-3 bg-amber-50 rounded-lg border border-amber-200">
                  <span className="text-amber-700 flex items-center gap-2">
                    <Building2 className="h-4 w-4" />
                    Store Access
                  </span>
                  <span className="font-medium text-amber-800">All Stores</span>
                </div>
              )}
            </div>
          </Card>

          {/* Quick Stats */}
          <Card className="p-6">
            <h3 className="font-semibold text-lg mb-4 flex items-center gap-2">
              <Shield className="h-5 w-5" />
              Access Summary
            </h3>
            
            <div className="space-y-4">
              <div className="p-4 bg-green-50 border border-green-200 rounded-lg">
                <div className="flex items-center justify-between">
                  <span className="text-green-700 font-medium">Active Permissions</span>
                  <span className="text-2xl font-bold text-green-800">
                    {user?.role === 'super_admin' 
                      ? getAllPermissions().length 
                      : (user?.permissions?.length || 0)}
                  </span>
                </div>
                <p className="text-sm text-green-600 mt-1">
                  {user?.role === 'super_admin' 
                    ? 'Full access to all features' 
                    : 'Based on your assigned role'}
                </p>
              </div>
              
              {user?.role === 'super_admin' && (
                <div className="p-4 bg-purple-50 border border-purple-200 rounded-lg">
                  <div className="flex items-center gap-2 text-purple-700">
                    <Shield className="h-5 w-5" />
                    <span className="font-medium">Super Admin Access</span>
                  </div>
                  <p className="text-sm text-purple-600 mt-1">
                    You have unrestricted access to all features including audit logs, 
                    user management, and system settings.
                  </p>
                </div>
              )}
              
              {user?.role !== 'super_admin' && user?.role !== 'customer' && (
                <div className="p-4 bg-blue-50 border border-blue-200 rounded-lg">
                  <p className="text-sm text-blue-700">
                    Your permissions are managed by your administrator. 
                    Contact them if you need access to additional features.
                  </p>
                </div>
              )}
            </div>
          </Card>
        </div>
      )}

      {/* Permissions Tab */}
      {activeTab === 'permissions' && (
        <div className="space-y-6">
          {/* Role Info */}
          <Card className="p-6">
            <div className="flex items-center justify-between mb-4">
              <h3 className="font-semibold text-lg flex items-center gap-2">
                <Shield className="h-5 w-5" />
                Your Role & Permissions
              </h3>
              {getRoleBadge(user?.role)}
            </div>
            
            {user?.role === 'super_admin' && (
              <div className="p-4 bg-purple-50 border border-purple-200 rounded-lg mb-4">
                <p className="text-purple-700">
                  <strong>Super Admin:</strong> You have full access to all permissions and features. 
                  All items below are automatically enabled.
                </p>
              </div>
            )}
            
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
              {getAllPermissions().map(permission => (
                <PermissionBadge 
                  key={permission}
                  permission={permission}
                  granted={hasPermission(permission)}
                />
              ))}
            </div>
          </Card>

          {/* Permission Legend */}
          <Card className="p-6">
            <h3 className="font-semibold text-lg mb-4">Permission Descriptions</h3>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {Object.entries(PERMISSION_DEFINITIONS).map(([key, def]) => {
                const Icon = def.icon;
                return (
                  <div key={key} className="flex items-start gap-3 p-3 bg-gray-50 rounded-lg">
                    <Icon className="h-5 w-5 text-muted-foreground mt-0.5" />
                    <div>
                      <p className="font-medium">{def.label}</p>
                      <p className="text-sm text-muted-foreground">{def.description}</p>
                    </div>
                  </div>
                );
              })}
            </div>
          </Card>
        </div>
      )}

      {/* Security Tab */}
      {activeTab === 'security' && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* Change Password - Super Admin Only */}
          {user?.role === 'super_admin' ? (
            <Card className="p-6">
              <h3 className="font-semibold text-lg mb-4 flex items-center gap-2">
                <Lock className="h-5 w-5" />
                Change Password
              </h3>
              
              <form onSubmit={handleChangePassword} className="space-y-4">
                <div>
                  <label className="text-sm font-medium mb-1 block">Current Password</label>
                  <div className="relative">
                    <Input
                      type={showPasswords ? 'text' : 'password'}
                      value={passwordData.current_password}
                      onChange={(e) => setPasswordData({ ...passwordData, current_password: e.target.value })}
                      placeholder="Enter current password"
                      required
                    />
                  </div>
                </div>
                
                <div>
                  <label className="text-sm font-medium mb-1 block">New Password</label>
                  <Input
                    type={showPasswords ? 'text' : 'password'}
                    value={passwordData.new_password}
                    onChange={(e) => setPasswordData({ ...passwordData, new_password: e.target.value })}
                    placeholder="Enter new password"
                    required
                  />
                </div>
                
                <div>
                  <label className="text-sm font-medium mb-1 block">Confirm New Password</label>
                  <Input
                    type={showPasswords ? 'text' : 'password'}
                    value={passwordData.confirm_password}
                    onChange={(e) => setPasswordData({ ...passwordData, confirm_password: e.target.value })}
                    placeholder="Confirm new password"
                    required
                  />
                </div>
                
                <div className="flex items-center gap-2">
                  <Switch
                    checked={showPasswords}
                    onCheckedChange={setShowPasswords}
                  />
                  <label className="text-sm text-muted-foreground">Show passwords</label>
                </div>
                
                <Button 
                  type="submit" 
                  disabled={changingPassword}
                  className="w-full"
                >
                  {changingPassword ? (
                    <>
                      <RefreshCw className="h-4 w-4 mr-2 animate-spin" />
                      Changing...
                    </>
                  ) : (
                    <>
                      <Save className="h-4 w-4 mr-2" />
                      Change Password
                    </>
                  )}
                </Button>
              </form>
            </Card>
          ) : (
            <Card className="p-6">
              <h3 className="font-semibold text-lg mb-4 flex items-center gap-2">
                <Lock className="h-5 w-5 text-gray-400" />
                Change Password
              </h3>
              <div className="p-4 bg-amber-50 border border-amber-200 rounded-lg">
                <p className="text-sm text-amber-800">
                  <Shield className="h-4 w-4 inline mr-2" />
                  Password changes are restricted to Super Admin only. Please contact your administrator if you need to reset your password.
                </p>
              </div>
            </Card>
          )}

          {/* Session Info */}
          <Card className="p-6">
            <h3 className="font-semibold text-lg mb-4 flex items-center gap-2">
              <Key className="h-5 w-5" />
              Session Information
            </h3>
            
            <div className="space-y-4">
              <div className="p-3 bg-gray-50 rounded-lg">
                <span className="text-sm text-muted-foreground">Logged in as</span>
                <p className="font-medium">{user?.email}</p>
              </div>
              
              <div className="p-3 bg-green-50 border border-green-200 rounded-lg">
                <div className="flex items-center gap-2 text-green-700">
                  <Check className="h-4 w-4" />
                  <span className="font-medium">Session Active</span>
                </div>
                <p className="text-sm text-green-600 mt-1">
                  Your session is currently active and secure.
                </p>
              </div>
              
              <Button 
                variant="outline" 
                className="w-full text-red-600 hover:text-red-700 hover:bg-red-50"
                onClick={logout}
              >
                Sign Out
              </Button>
            </div>
          </Card>

          {/* Device Approvals - Super Admin Only.
              `id` anchor is referenced from the device-approval email
              link (#device-approvals) so the admin lands directly on
              this card and scrolls to it. See backend/server.py
              `_email_device_approval_request`. */}
          {user?.role === 'super_admin' && (
            <Card id="device-approvals" className="p-6 lg:col-span-2 scroll-mt-24">
              <h3 className="font-semibold text-lg mb-4 flex items-center gap-2">
                <Shield className="h-5 w-5 text-amber-600" />
                Device Approval Requests
              </h3>
              <DeviceApprovals />
            </Card>
          )}

          {/* Approved Devices - Super Admin Only */}
          {user?.role === 'super_admin' && (
            <Card className="p-6 lg:col-span-2">
              <h3 className="font-semibold text-lg mb-4 flex items-center gap-2">
                <Monitor className="h-5 w-5 text-blue-600" />
                Approved Devices
              </h3>
              <ApprovedDevicesList />
            </Card>
          )}
        </div>
      )}
    </div>
  );
};

// Device Approvals Component
const DeviceApprovals = () => {
  const [approvals, setApprovals] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchApprovals();
  }, []);

  const fetchApprovals = async () => {
    try {
      const res = await api.getDeviceApprovals();
      setApprovals(res.data || []);
    } catch (error) {
      console.error('Failed to fetch device approvals:', error);
    } finally {
      setLoading(false);
    }
  };

  const handleApprove = async (approvalId) => {
    try {
      await api.approveDevice(approvalId);
      toast.success('Device approved successfully');
      fetchApprovals();
    } catch (error) {
      toast.error(error.response?.data?.detail || 'Failed to approve device');
    }
  };

  const handleReject = async (approvalId) => {
    try {
      await api.rejectDevice(approvalId);
      toast.success('Device rejected');
      fetchApprovals();
    } catch (error) {
      toast.error(error.response?.data?.detail || 'Failed to reject device');
    }
  };

  if (loading) {
    return <div className="text-center py-4 text-muted-foreground">Loading...</div>;
  }

  if (approvals.length === 0) {
    return (
      <div className="text-center py-6 text-muted-foreground">
        <Shield className="h-12 w-12 mx-auto mb-2 opacity-30" />
        <p>No pending device approval requests</p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {approvals.map((approval) => (
        <div key={approval.id} className="p-4 border rounded-lg bg-amber-50 border-amber-200">
          <div className="flex items-start justify-between gap-4">
            <div className="flex-1">
              <div className="flex items-center gap-2 mb-1">
                <Smartphone className="h-4 w-4 text-amber-600" />
                <span className="font-medium">{approval.device_name}</span>
                <span className="text-xs px-2 py-0.5 bg-amber-200 rounded-full">
                  {approval.device_type}
                </span>
              </div>
              <p className="text-sm text-gray-600">
                <span className="font-medium">{approval.user_name}</span> ({approval.user_email})
              </p>
              <p className="text-xs text-muted-foreground mt-1">
                Requested: {new Date(approval.requested_at).toLocaleString('en-GB')}
              </p>
            </div>
            <div className="flex gap-2">
              <Button 
                size="sm" 
                variant="outline" 
                className="text-red-600 hover:bg-red-50"
                onClick={() => handleReject(approval.id)}
              >
                <X className="h-4 w-4" />
              </Button>
              <Button 
                size="sm" 
                className="bg-green-600 hover:bg-green-700"
                onClick={() => handleApprove(approval.id)}
              >
                <Check className="h-4 w-4" />
              </Button>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
};

// Approved Devices List Component
const ApprovedDevicesList = () => {
  const [devices, setDevices] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchDevices();
  }, []);

  const fetchDevices = async () => {
    try {
      const res = await api.getApprovedDevices();
      setDevices(res.data || []);
    } catch (error) {
      console.error('Failed to fetch approved devices:', error);
    } finally {
      setLoading(false);
    }
  };

  const handleRevoke = async (deviceId) => {
    if (!window.confirm('Are you sure you want to revoke access for this device?')) return;
    try {
      await api.revokeDevice(deviceId);
      toast.success('Device access revoked');
      fetchDevices();
    } catch (error) {
      toast.error(error.response?.data?.detail || 'Failed to revoke device');
    }
  };

  if (loading) {
    return <div className="text-center py-4 text-muted-foreground">Loading...</div>;
  }

  if (devices.length === 0) {
    return (
      <div className="text-center py-6 text-muted-foreground">
        <Monitor className="h-12 w-12 mx-auto mb-2 opacity-30" />
        <p>No approved devices</p>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {devices.map((device) => (
        <div key={device.id} className="p-3 border rounded-lg bg-gray-50 flex items-center justify-between">
          <div>
            <div className="flex items-center gap-2">
              <Monitor className="h-4 w-4 text-gray-500" />
              <span className="font-medium">{device.device_name}</span>
              <span className="text-xs px-2 py-0.5 bg-gray-200 rounded-full">
                {device.device_type}
              </span>
            </div>
            <p className="text-sm text-muted-foreground">{device.user_email}</p>
            <p className="text-xs text-muted-foreground">
              Approved: {new Date(device.approved_at).toLocaleString('en-GB')}
            </p>
          </div>
          <Button 
            size="sm" 
            variant="outline" 
            className="text-red-600 hover:bg-red-50"
            onClick={() => handleRevoke(device.id)}
          >
            Revoke
          </Button>
        </div>
      ))}
    </div>
  );
};

export default SettingsPage;
