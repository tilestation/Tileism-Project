import React, { useState, useEffect } from 'react';
import { api } from '../../lib/api';
import { toast } from 'sonner';
import { extractApiError } from '../../utils/extractApiError';
import { Users, Plus, Edit2, Trash2, Shield, ShieldCheck, ShieldAlert, Building2, Key, Star, ArrowDown } from 'lucide-react';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { Card } from '../../components/ui/card';
import { Checkbox } from '../../components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../../components/ui/dialog';

// Permission labels for display
const PERMISSION_LABELS = {
  dashboard: 'Dashboard',
  products: 'Products',
  categories: 'Categories',
  orders: 'Orders',
  epos: 'EPOS (Invoices)',
  customer_pricing: 'Customer Pricing',
  customer_invites: 'Customer Invites',
  bulk_inquiries: 'Bulk Inquiries',
  marketing: 'Marketing',
  showrooms: 'Stores',
  reports: 'Reports',
  user_management: 'User Management'
};

export const UserManagement = () => {
  const [users, setUsers] = useState([]);
  const [showrooms, setStores] = useState([]);
  const [availablePermissions, setAvailablePermissions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showDialog, setShowDialog] = useState(false);
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const [editingUser, setEditingUser] = useState(null);
  const [deletingUser, setDeletingUser] = useState(null);
  const [saving, setSaving] = useState(false);
  
  const [formData, setFormData] = useState({
    email: '',
    password: '',
    name: '',
    role: 'staff',
    showroom_id: '',
    permissions: []
  });

  useEffect(() => {
    fetchData();
  }, []);

  const fetchData = async () => {
    try {
      const [usersRes, showroomsRes, permissionsRes] = await Promise.all([
        api.getAdminUsers(),
        api.getStores(),
        api.getAvailablePermissions()
      ]);
      setUsers(usersRes.data);
      setStores(showroomsRes.data);
      setAvailablePermissions(permissionsRes.data.permissions || []);
    } catch (error) {
      if (error.response?.status === 403) {
        toast.error('Super Admin access required');
      } else {
        toast.error('Failed to load users');
      }
    } finally {
      setLoading(false);
    }
  };

  const handleOpenDialog = (user = null) => {
    if (user) {
      setEditingUser(user);
      setFormData({
        email: user.email,
        password: '',
        name: user.name,
        role: user.role,
        showroom_id: user.showroom_id || '',
        permissions: user.permissions || []
      });
    } else {
      setEditingUser(null);
      setFormData({
        email: '',
        password: '',
        name: '',
        role: 'staff',
        showroom_id: '',
        permissions: []
      });
    }
    setShowDialog(true);
  };

  const handleCloseDialog = () => {
    setShowDialog(false);
    setEditingUser(null);
    setFormData({
      email: '',
      password: '',
      name: '',
      role: 'staff',
      showroom_id: '',
      permissions: []
    });
  };

  const handlePermissionToggle = (permission) => {
    setFormData(prev => ({
      ...prev,
      permissions: prev.permissions.includes(permission)
        ? prev.permissions.filter(p => p !== permission)
        : [...prev.permissions, permission]
    }));
  };

  const handleSelectAllPermissions = () => {
    if (formData.permissions.length === availablePermissions.length) {
      setFormData(prev => ({ ...prev, permissions: [] }));
    } else {
      setFormData(prev => ({ ...prev, permissions: [...availablePermissions] }));
    }
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    
    if (!formData.name.trim()) {
      toast.error('Name is required');
      return;
    }
    
    if (!editingUser && !formData.email.trim()) {
      toast.error('Email is required');
      return;
    }
    
    if (!editingUser && !formData.password) {
      toast.error('Password is required for new users');
      return;
    }

    setSaving(true);
    try {
      if (editingUser) {
        await api.updateUserPermissions(editingUser.email, {
          role: formData.role,
          permissions: formData.permissions,
          showroom_id: formData.showroom_id || null
        });
        toast.success('User updated successfully');
      } else {
        await api.createAdminUser({
          email: formData.email,
          password: formData.password,
          name: formData.name,
          role: formData.role,
          showroom_id: formData.showroom_id || null
        });
        // Set permissions after creation
        await api.updateUserPermissions(formData.email, {
          permissions: formData.permissions
        });
        toast.success('User created successfully');
      }
      handleCloseDialog();
      fetchData();
    } catch (error) {
      toast.error(extractApiError(error, 'Could not save user'));
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!deletingUser) return;
    
    setSaving(true);
    try {
      await api.deleteAdminUser(deletingUser.email);
      toast.success('User deleted successfully');
      setShowDeleteDialog(false);
      setDeletingUser(null);
      fetchData();
    } catch (error) {
      toast.error(extractApiError(error, 'Failed to delete user'));
    } finally {
      setSaving(false);
    }
  };

  const getRoleBadge = (role) => {
    const badges = {
      super_admin: <span className="px-2 py-1 text-xs font-medium rounded-full bg-purple-100 text-purple-800">Super Admin</span>,
      admin: <span className="px-2 py-1 text-xs font-medium rounded-full bg-blue-100 text-blue-800">Admin</span>,
      manager: <span className="px-2 py-1 text-xs font-medium rounded-full bg-green-100 text-green-800">Manager</span>,
      showroom_lead: <span className="px-2 py-1 text-xs font-medium rounded-full bg-amber-100 text-amber-800 inline-flex items-center gap-1"><Star className="h-3 w-3" /> Showroom Lead</span>,
      staff: <span className="px-2 py-1 text-xs font-medium rounded-full bg-gray-100 text-gray-800">Staff</span>
    };
    return badges[role] || <span className="px-2 py-1 text-xs rounded-full bg-gray-100">{role}</span>;
  };

  const getRoleIcon = (role) => {
    switch (role) {
      case 'super_admin': return <ShieldAlert className="h-5 w-5 text-purple-500" />;
      case 'admin': return <ShieldCheck className="h-5 w-5 text-blue-500" />;
      case 'manager': return <Shield className="h-5 w-5 text-green-500" />;
      case 'showroom_lead': return <Star className="h-5 w-5 text-amber-500" />;
      default: return <Users className="h-5 w-5 text-gray-500" />;
    }
  };

  // 17 May 2026 — one-click promote / demote between Staff ↔ Showroom Lead.
  // Pre-condition: only super_admin can call this; only applies to users
  // whose current role is one of those two. Backend uses PUT /admin/users/{email}/permissions
  // which we already use elsewhere — just toggles the `role` field.
  // Permissions stay derived from the role automatically (no copy of an array).
  const promoteToShowroomLead = async (user) => {
    const isCurrentlyLead = user.role === 'showroom_lead';
    const targetRole = isCurrentlyLead ? 'staff' : 'showroom_lead';
    const verb = isCurrentlyLead ? 'demote' : 'promote';
    const confirmMsg = isCurrentlyLead
      ? `Demote ${user.name} back to Staff? They will lose Stock Transfers, Reorder Suggestions, and the inventory reports.`
      : `Promote ${user.name} to Showroom Lead? They will gain Stock Transfers (between showrooms), Reorder Suggestions, To Order Report, Stock Value and Stocktake Report — on top of their current Staff access.`;
    if (!window.confirm(confirmMsg)) return;
    try {
      await api.updateUserPermissions(user.email, { role: targetRole });
      toast.success(`${user.name} ${verb}d successfully — they must log out and back in for it to take effect.`);
      await fetchData();
    } catch (error) {
      toast.error(extractApiError(error, `Failed to ${verb} user`));
    }
  };

  if (loading) {
    return <div className="flex items-center justify-center h-64">Loading users...</div>;
  }

  return (
    <div className="space-y-6" data-testid="user-management-page">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-4xl font-heading font-bold tracking-tightest mb-2">User Management</h1>
          <p className="text-muted-foreground">Manage admin, manager, and staff access</p>
        </div>
        <Button onClick={() => handleOpenDialog()} data-testid="add-user-btn">
          <Plus className="h-4 w-4 mr-2" />
          Add User
        </Button>
      </div>

      {/* Users Table */}
      <Card>
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead className="bg-muted">
              <tr>
                <th className="px-4 py-3 text-left text-sm font-semibold">User</th>
                <th className="px-4 py-3 text-left text-sm font-semibold">Role</th>
                <th className="px-4 py-3 text-left text-sm font-semibold">Store</th>
                <th className="px-4 py-3 text-center text-sm font-semibold">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {users.length === 0 ? (
                <tr>
                  <td colSpan={4} className="px-4 py-8 text-center text-muted-foreground">
                    <Users className="h-12 w-12 mx-auto mb-3 opacity-30" />
                    <p>No users found</p>
                  </td>
                </tr>
              ) : (
                users.map((user) => (
                  <tr key={user.email} data-testid={`user-row-${user.email}`}>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-3">
                        {getRoleIcon(user.role)}
                        <div>
                          <p className="font-medium">{user.name}</p>
                          <p className="text-sm text-muted-foreground">{user.email}</p>
                        </div>
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      {getRoleBadge(user.role)}
                    </td>
                    <td className="px-4 py-3">
                      {user.showroom_name ? (
                        <div className="flex items-center gap-2 text-sm">
                          <Building2 className="h-4 w-4 text-muted-foreground" />
                          <span>{user.showroom_name}</span>
                        </div>
                      ) : (
                        <span className="text-muted-foreground text-sm italic">All Stores</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-center">
                      {user.role !== 'super_admin' && (
                        <div className="flex justify-center gap-1">
                          {/* Promote-to / Demote-from Showroom Lead — only
                            * surfaced for Staff and Showroom Lead roles to
                            * keep the row tidy. Admin/Manager rows skip it.
                            */}
                          {(user.role === 'staff' || user.role === 'showroom_lead') && (
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => promoteToShowroomLead(user)}
                              className={user.role === 'showroom_lead'
                                ? 'text-slate-500 hover:text-slate-700 hover:bg-slate-50'
                                : 'text-amber-600 hover:text-amber-700 hover:bg-amber-50'}
                              title={user.role === 'showroom_lead'
                                ? 'Demote to Staff'
                                : 'Promote to Showroom Lead'}
                              data-testid={`promote-lead-${user.email}`}
                            >
                              {user.role === 'showroom_lead'
                                ? <ArrowDown className="h-4 w-4" />
                                : <Star className="h-4 w-4" />}
                            </Button>
                          )}
                          <Button 
                            variant="ghost" 
                            size="sm" 
                            onClick={() => handleOpenDialog(user)}
                            data-testid={`edit-user-${user.email}`}
                          >
                            <Edit2 className="h-4 w-4" />
                          </Button>
                          <Button 
                            variant="ghost" 
                            size="sm" 
                            className="text-red-500 hover:text-red-600 hover:bg-red-50"
                            onClick={() => {
                              setDeletingUser(user);
                              setShowDeleteDialog(true);
                            }}
                            data-testid={`delete-user-${user.email}`}
                          >
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        </div>
                      )}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </Card>

      {/* Add/Edit Dialog */}
      <Dialog open={showDialog} onOpenChange={setShowDialog}>
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{editingUser ? 'Edit User' : 'Add New User'}</DialogTitle>
            <DialogDescription>
              {editingUser ? 'Update user role and permissions.' : 'Create a new admin, manager, or staff user.'}
            </DialogDescription>
          </DialogHeader>
          
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="text-sm font-medium mb-1 block">
                  Name <span className="text-red-500">*</span>
                </label>
                <Input
                  value={formData.name}
                  onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                  placeholder="Full name"
                  disabled={editingUser?.role === 'super_admin'}
                  data-testid="user-name-input"
                />
              </div>
              
              <div>
                <label className="text-sm font-medium mb-1 block">
                  Email <span className="text-red-500">*</span>
                </label>
                <Input
                  type="email"
                  value={formData.email}
                  onChange={(e) => setFormData({ ...formData, email: e.target.value })}
                  placeholder="user@tilestation.co.uk"
                  disabled={!!editingUser}
                  data-testid="user-email-input"
                />
              </div>
            </div>
            
            {!editingUser && (
              <div>
                <label className="text-sm font-medium mb-1 block">
                  Password <span className="text-red-500">*</span>
                </label>
                <Input
                  type="password"
                  value={formData.password}
                  onChange={(e) => setFormData({ ...formData, password: e.target.value })}
                  placeholder="Create a strong password"
                  data-testid="user-password-input"
                />
              </div>
            )}
            
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="text-sm font-medium mb-1 block">Role</label>
                <select
                  value={formData.role}
                  onChange={(e) => setFormData({ ...formData, role: e.target.value })}
                  className="w-full h-10 px-3 border rounded-md"
                  disabled={editingUser?.role === 'super_admin'}
                  data-testid="user-role-select"
                >
                  <option value="staff">Staff</option>
                  <option value="showroom_lead">Showroom Lead</option>
                  <option value="manager">Manager</option>
                  <option value="admin">Admin</option>
                </select>
              </div>
              
              <div>
                <label className="text-sm font-medium mb-1 block">Store</label>
                <select
                  value={formData.showroom_id}
                  onChange={(e) => setFormData({ ...formData, showroom_id: e.target.value })}
                  className="w-full h-10 px-3 border rounded-md"
                  disabled={editingUser?.role === 'super_admin'}
                  data-testid="user-showroom-select"
                >
                  <option value="">All Stores</option>
                  {showrooms.map(showroom => (
                    <option key={showroom.id} value={showroom.id}>{showroom.name}</option>
                  ))}
                </select>
              </div>
            </div>
            
            {/* Permissions Section — 16 May 2026
              *
              * Per-user permission checkboxes used to live here, but they
              * wrote to a parallel `user.permissions[]` array whose keys
              * didn't match the granular keys the admin sidebar checks
              * for. Result: tons of confusion + the Sydenham incident.
              *
              * Permission management has been unified at /admin/permissions:
              *   - Role defaults  → Roles tab
              *   - Per-user grants → User Overrides tab (with filters)
              *
              * Here we only set role + showroom; the role drives the
              * permissions automatically.
              */}
            {editingUser?.role !== 'super_admin' && (
              <div className="rounded-lg border border-blue-200 bg-blue-50 p-4">
                <div className="flex items-start gap-3">
                  <Shield className="h-5 w-5 text-blue-600 mt-0.5 shrink-0" />
                  <div className="flex-1">
                    <p className="text-sm font-medium text-blue-900">
                      Permissions are managed in one place
                    </p>
                    <p className="text-xs text-blue-700 mt-1 leading-relaxed">
                      This user&apos;s access is determined by their{' '}
                      <span className="font-semibold">{formData.role}</span> role.
                      To change what every {formData.role} can see, or to grant this user
                      extra pages beyond their role, head over to the unified
                      permissions panel.
                    </p>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      className="mt-3 border-blue-300 bg-white text-blue-700 hover:bg-blue-100"
                      onClick={() => {
                        const target = editingUser?.email
                          ? `/admin/permissions?tab=users&user=${encodeURIComponent(editingUser.email)}`
                          : '/admin/permissions';
                        window.location.href = target;
                      }}
                      data-testid="open-permissions-admin-btn"
                    >
                      Open Permissions Admin →
                    </Button>
                  </div>
                </div>
              </div>
            )}
            
            <DialogFooter>
              <Button type="button" variant="outline" onClick={handleCloseDialog}>
                Cancel
              </Button>
              <Button type="submit" disabled={saving} data-testid="save-user-btn">
                {saving ? 'Saving...' : (editingUser ? 'Update' : 'Create')}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation Dialog */}
      <Dialog open={showDeleteDialog} onOpenChange={setShowDeleteDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete User</DialogTitle>
            <DialogDescription>
              Are you sure you want to delete &ldquo;{deletingUser?.name}&rdquo; ({deletingUser?.email})? 
              This action cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowDeleteDialog(false)}>
              Cancel
            </Button>
            <Button 
              variant="destructive" 
              onClick={handleDelete} 
              disabled={saving}
              data-testid="confirm-delete-user"
            >
              {saving ? 'Deleting...' : 'Delete'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
};

export default UserManagement;
