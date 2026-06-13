import React, { useState, useEffect } from 'react';
import { api } from '../../lib/api';
import { toast } from 'sonner';
import { extractApiError } from '../../utils/extractApiError';
import { Users, Plus, Edit2, Trash2, Shield, ShieldCheck, ShieldAlert, Building2, Key, Star, ArrowDown, Search, X } from 'lucide-react';
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

  // 17 May 2026 — filter bar above the user table. Lets the super-admin
  // drill to "all staff at Gravesend" in one click before deciding who
  // to promote to Showroom Lead. All filtering is client-side because
  // the staff list is small (<50 rows in practice).
  const [filterSearch, setFilterSearch] = useState('');
  const [filterShowroom, setFilterShowroom] = useState('all');
  const [filterRole, setFilterRole] = useState('all');

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

  // Apply filter bar to the user list. Note: the search input matches
  // name OR email OR showroom name so the super-admin can find people
  // however they remember them.
  const term = filterSearch.trim().toLowerCase();
  const filteredUsers = users.filter((u) => {
    if (filterRole !== 'all' && u.role !== filterRole) return false;
    if (filterShowroom !== 'all') {
      if (filterShowroom === '__none__') {
        if (u.showroom_id) return false;
      } else if (u.showroom_id !== filterShowroom) {
        return false;
      }
    }
    if (term) {
      const haystack = `${u.name || ''} ${u.email || ''} ${u.showroom_name || ''}`.toLowerCase();
      if (!haystack.includes(term)) return false;
    }
    return true;
  });
  const filtersActive = !!term || filterShowroom !== 'all' || filterRole !== 'all';

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

      {/* Filter bar */}
      <Card className="p-4">
        <div className="flex flex-col md:flex-row gap-3 items-stretch md:items-center">
          <div className="relative flex-1 min-w-0">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground pointer-events-none" />
            <Input
              type="text"
              value={filterSearch}
              onChange={(e) => setFilterSearch(e.target.value)}
              placeholder="Search by name, email, or store…"
              className="pl-9 pr-9"
              data-testid="user-filter-search"
            />
            {filterSearch && (
              <button
                type="button"
                onClick={() => setFilterSearch('')}
                className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-muted-foreground hover:text-foreground"
                aria-label="Clear search"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
          <select
            value={filterShowroom}
            onChange={(e) => setFilterShowroom(e.target.value)}
            className="h-10 px-3 text-sm border rounded-md bg-white min-w-[180px]"
            data-testid="user-filter-showroom"
          >
            <option value="all">All stores</option>
            <option value="__none__">— No store assigned —</option>
            {showrooms.map((s) => (
              <option key={s.id} value={s.id}>{s.name}</option>
            ))}
          </select>
          <select
            value={filterRole}
            onChange={(e) => setFilterRole(e.target.value)}
            className="h-10 px-3 text-sm border rounded-md bg-white min-w-[160px]"
            data-testid="user-filter-role"
          >
            <option value="all">All roles</option>
            <option value="super_admin">Super Admin</option>
            <option value="admin">Admin</option>
            <option value="manager">Manager</option>
            <option value="showroom_lead">Showroom Lead</option>
            <option value="staff">Staff</option>
          </select>
          {filtersActive && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => { setFilterSearch(''); setFilterShowroom('all'); setFilterRole('all'); }}
              data-testid="user-filter-clear"
            >
              <X className="h-3.5 w-3.5 mr-1" />
              Clear filters
            </Button>
          )}
        </div>
        {filtersActive && (
          <p className="text-xs text-muted-foreground mt-2" data-testid="user-filter-count">
            Showing <strong>{filteredUsers.length}</strong> of {users.length} users
            {filterShowroom !== 'all' && filterShowroom !== '__none__' && (
              <> at <strong>{showrooms.find((s) => s.id === filterShowroom)?.name || 'this store'}</strong></>
            )}
            {filterRole !== 'all' && <> with role <strong>{filterRole.replace('_', ' ')}</strong></>}
          </p>
        )}
      </Card>

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
              {filteredUsers.length === 0 ? (
                <tr>
                  <td colSpan={4} className="px-4 py-8 text-center text-muted-foreground">
                    <Users className="h-12 w-12 mx-auto mb-3 opacity-30" />
                    <p>No users match the current filters</p>
                    {filtersActive && (
                      <Button
                        variant="link"
                        size="sm"
                        onClick={() => { setFilterSearch(''); setFilterShowroom('all'); setFilterRole('all'); }}
                        className="mt-1"
                      >
                        Clear filters
                      </Button>
                    )}
                  </td>
                </tr>
              ) : (
                filteredUsers.map((user) => (
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
            {/* 13 Jun 2026 — Profile photo upload. Only available
                when editing an existing user (we need the user_id).
                Renders as a circular preview with Upload + Remove
                buttons. Image is client-side compressed to 256×256
                before upload to stay well within the 500KB cap. */}
            {editingUser && (
              <StaffPhotoUploader
                userId={editingUser.id}
                initialPhoto={editingUser.photo_url}
                userName={editingUser.name}
                onChange={(newUrl) => setEditingUser({ ...editingUser, photo_url: newUrl })}
              />
            )}
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

/**
 * StaffPhotoUploader — file-input that client-side compresses the
 * selected image to 256x256 PNG before sending to /api/staff/{id}/photo.
 * Image is stored as a base64 data URL on the user doc.
 *
 * Why client-side compress?
 *   - keeps the request body small (under 100KB typically)
 *   - skips the need for a separate image-processing pipeline
 *   - avoids the 500KB backend cap rejecting real-camera uploads
 */
const StaffPhotoUploader = ({ userId, initialPhoto, userName, onChange }) => {
  const [photo, setPhoto] = React.useState(initialPhoto || null);
  const [uploading, setUploading] = React.useState(false);
  const inputRef = React.useRef(null);

  React.useEffect(() => { setPhoto(initialPhoto || null); }, [initialPhoto]);

  const compressToDataUrl = (file) => new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = reject;
    reader.onload = () => {
      const img = new Image();
      img.onerror = reject;
      img.onload = () => {
        const size = 256;
        const canvas = document.createElement('canvas');
        canvas.width = size;
        canvas.height = size;
        const ctx = canvas.getContext('2d');
        // Cover-crop so portraits don't get squashed.
        const ratio = Math.max(size / img.width, size / img.height);
        const w = img.width * ratio;
        const h = img.height * ratio;
        ctx.drawImage(img, (size - w) / 2, (size - h) / 2, w, h);
        resolve(canvas.toDataURL('image/jpeg', 0.85));
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });

  const handleFile = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      toast.error('Please pick an image file (PNG / JPG / WebP).');
      return;
    }
    setUploading(true);
    try {
      const dataUrl = await compressToDataUrl(file);
      const token = localStorage.getItem('token');
      const r = await fetch(
        `${process.env.REACT_APP_BACKEND_URL}/api/staff/${userId}/photo`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
          body: JSON.stringify({ photo_data_url: dataUrl }),
        }
      );
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        toast.error(`Upload failed: ${j?.detail || r.status}`);
        return;
      }
      setPhoto(dataUrl);
      onChange?.(dataUrl);
      toast.success('Photo uploaded.');
    } catch (err) {
      toast.error(`Upload failed: ${err.message}`);
    } finally {
      setUploading(false);
      if (inputRef.current) inputRef.current.value = '';
    }
  };

  const handleRemove = async () => {
    if (!window.confirm(`Remove ${userName}'s profile photo?`)) return;
    setUploading(true);
    try {
      const token = localStorage.getItem('token');
      const r = await fetch(
        `${process.env.REACT_APP_BACKEND_URL}/api/staff/${userId}/photo`,
        {
          method: 'DELETE',
          headers: token ? { Authorization: `Bearer ${token}` } : {},
        }
      );
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        toast.error(`Remove failed: ${j?.detail || r.status}`);
        return;
      }
      setPhoto(null);
      onChange?.(null);
      toast.success('Photo removed.');
    } catch (err) {
      toast.error(`Remove failed: ${err.message}`);
    } finally {
      setUploading(false);
    }
  };

  // Initials fallback when no photo.
  const initials = (userName || '')
    .split(/\s+/).filter(Boolean).slice(0, 2)
    .map((w) => w[0].toUpperCase()).join('') || '?';

  return (
    <div className="flex items-center gap-4 p-3 rounded-lg border border-border bg-muted/20" data-testid="staff-photo-uploader">
      {photo ? (
        <img
          src={photo}
          alt={userName}
          className="w-16 h-16 rounded-full object-cover border-2 border-white/30 shadow"
          data-testid="staff-photo-preview"
        />
      ) : (
        <div className="w-16 h-16 rounded-full bg-emerald-500/70 text-white font-bold flex items-center justify-center text-xl shadow" data-testid="staff-photo-initials">
          {initials}
        </div>
      )}
      <div className="flex-1">
        <div className="text-sm font-semibold mb-1">Profile photo</div>
        <div className="text-xs text-muted-foreground mb-2">
          Auto-compressed to 256×256. Shows on the Sales podium &amp; leaderboards.
        </div>
        <div className="flex gap-2 flex-wrap">
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => inputRef.current?.click()}
            disabled={uploading}
            data-testid="staff-photo-upload-btn"
          >
            {uploading ? 'Uploading…' : (photo ? 'Replace' : 'Upload')}
          </Button>
          {photo && (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={handleRemove}
              disabled={uploading}
              className="text-rose-600"
              data-testid="staff-photo-remove-btn"
            >
              Remove
            </Button>
          )}
          <input
            ref={inputRef}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={handleFile}
            data-testid="staff-photo-file-input"
          />
        </div>
      </div>
    </div>
  );
};

export default UserManagement;
