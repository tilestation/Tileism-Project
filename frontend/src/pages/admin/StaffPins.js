import React, { useEffect, useState } from 'react';
import { api } from '../../lib/api';
import { toast } from 'sonner';
import { Users, Plus, Edit2, Trash2, Key, Shield, ShieldCheck, ShieldAlert, Building2, Warehouse, Minus } from 'lucide-react';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { Card } from '../../components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../../components/ui/dialog';
import { useAuth } from '../../contexts/AuthContext';

export const StaffPins = () => {
  const { user } = useAuth();
  const isSuperAdmin = user?.role === 'super_admin';
  const [staffList, setStaffList] = useState([]);
  const [showrooms, setStores] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showDialog, setShowDialog] = useState(false);
  const [editingStaff, setEditingStaff] = useState(null);
  const [formData, setFormData] = useState({
    name: '',
    pin: '',
    role: 'staff',
    active: true,
    showroom_id: ''
  });
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    fetchData();
  }, []);

  const fetchData = async () => {
    try {
      const [staffRes, showroomsRes] = await Promise.all([
        api.getStaffPins(),
        api.getStores()
      ]);
      setStaffList(staffRes.data);
      setStores(showroomsRes.data);
    } catch (error) {
      toast.error('Failed to load data');
    } finally {
      setLoading(false);
    }
  };

  const fetchStaffPins = async () => {
    try {
      const res = await api.getStaffPins();
      setStaffList(res.data);
    } catch (error) {
      toast.error('Failed to load staff list');
    }
  };

  const handleOpenDialog = (staff = null) => {
    if (staff) {
      setEditingStaff(staff);
      setFormData({
        name: staff.name,
        pin: '', // Don't show existing PIN
        role: staff.role,
        active: staff.active,
        showroom_id: staff.showroom_id || '',
        can_manage_warehouse: !!staff.can_manage_warehouse,
      });
    } else {
      setEditingStaff(null);
      setFormData({
        name: '',
        pin: '',
        role: 'staff',
        active: true,
        showroom_id: '',
        can_manage_warehouse: false,
      });
    }
    setShowDialog(true);
  };

  const handleCloseDialog = () => {
    setShowDialog(false);
    setEditingStaff(null);
    setFormData({ name: '', pin: '', role: 'staff', active: true, showroom_id: '', can_manage_warehouse: false });
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    
    // Validate PIN (only if creating or updating PIN)
    if (!editingStaff && (!formData.pin || !/^\d{4,6}$/.test(formData.pin))) {
      toast.error('PIN must be 4-6 digits');
      return;
    }
    
    if (editingStaff && formData.pin && !/^\d{4,6}$/.test(formData.pin)) {
      toast.error('PIN must be 4-6 digits');
      return;
    }

    if (!formData.name.trim()) {
      toast.error('Name is required');
      return;
    }

    setSaving(true);
    try {
      if (editingStaff) {
        const updateData = {
          name: formData.name,
          role: formData.role,
          active: formData.active,
          showroom_id: formData.showroom_id || null,
          can_manage_warehouse: !!formData.can_manage_warehouse,
        };
        // Only include PIN if it was changed
        if (formData.pin) {
          updateData.pin = formData.pin;
        }
        await api.updateStaffPin(editingStaff.id, updateData);
        toast.success('Staff member updated');
      } else {
        await api.createStaffPin({
          ...formData,
          showroom_id: formData.showroom_id || null,
          can_manage_warehouse: !!formData.can_manage_warehouse,
        });
        toast.success('Staff member created');
      }
      handleCloseDialog();
      fetchStaffPins();
    } catch (error) {
      toast.error(error.response?.data?.detail || 'Operation failed');
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (staff) => {
    if (!window.confirm(`Are you sure you want to delete ${staff.name}?`)) return;
    
    try {
      await api.deleteStaffPin(staff.id);
      toast.success('Staff member deleted');
      fetchStaffPins();
    } catch (error) {
      toast.error('Failed to delete staff member');
    }
  };

  const handleToggleActive = async (staff) => {
    try {
      await api.updateStaffPin(staff.id, { active: !staff.active });
      toast.success(`Staff member ${staff.active ? 'deactivated' : 'activated'}`);
      fetchStaffPins();
    } catch (error) {
      toast.error('Failed to update status');
    }
  };

  const getRoleIcon = (role) => {
    switch (role) {
      case 'admin':
        return <ShieldCheck className="h-4 w-4 text-purple-600" />;
      case 'manager':
        return <ShieldAlert className="h-4 w-4 text-blue-600" />;
      default:
        return <Shield className="h-4 w-4 text-gray-600" />;
    }
  };

  const getRoleBadge = (role) => {
    const colors = {
      admin: 'bg-purple-100 text-purple-800',
      manager: 'bg-blue-100 text-blue-800',
      staff: 'bg-gray-100 text-gray-800'
    };
    return (
      <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${colors[role] || colors.staff}`}>
        {role.charAt(0).toUpperCase() + role.slice(1)}
      </span>
    );
  };

  if (loading) {
    return <div className="flex items-center justify-center h-64">Loading...</div>;
  }

  return (
    <div className="space-y-6" data-testid="staff-pins-page">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-4xl font-heading font-bold tracking-tightest mb-2">Staff PINs</h1>
          <p className="text-muted-foreground">Manage confidential PIN numbers for invoice access</p>
        </div>
        <Button onClick={() => handleOpenDialog()} data-testid="add-staff-btn">
          <Plus className="h-4 w-4 mr-2" />
          Add Staff Member
        </Button>
      </div>

      {/* Info Card */}
      <Card className="p-4 bg-blue-50 border-blue-200">
        <div className="flex items-start gap-3">
          <Key className="h-5 w-5 text-blue-600 mt-0.5" />
          <div>
            <h3 className="font-semibold text-blue-900">How Staff PINs Work</h3>
            <p className="text-sm text-blue-700 mt-1">
              Staff members must enter their PIN when saving an invoice. This ensures accountability 
              and tracks which staff member created each invoice.
              {isSuperAdmin 
                ? ' As Super Admin, you can see full PIN numbers.' 
                : ' PINs are confidential and only visible to Super Admin.'}
            </p>
          </div>
        </div>
      </Card>

      {/* Staff List */}
      <Card className="overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead className="bg-muted">
              <tr>
                <th className="px-4 py-3 text-left text-sm font-semibold">Staff Member</th>
                {isSuperAdmin && (
                  <th className="px-4 py-3 text-left text-sm font-semibold">PIN</th>
                )}
                <th className="px-4 py-3 text-left text-sm font-semibold">Store</th>
                <th className="px-4 py-3 text-left text-sm font-semibold">Role</th>
                {/* At-a-glance warehouse permission audit — green tick if */}
                {/* the PIN can adjust stock, dash otherwise. Hover for tooltip. */}
                <th
                  className="px-4 py-3 text-center text-sm font-semibold"
                  title="Can this PIN adjust warehouse stock?"
                >
                  Warehouse
                </th>
                <th className="px-4 py-3 text-center text-sm font-semibold">Status</th>
                <th className="px-4 py-3 text-center text-sm font-semibold">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {staffList.length === 0 ? (
                <tr>
                  <td colSpan={isSuperAdmin ? 7 : 6} className="px-4 py-8 text-center text-muted-foreground">
                    <Users className="h-12 w-12 mx-auto mb-3 opacity-30" />
                    <p>No staff members yet</p>
                    <p className="text-sm">Add a staff member to get started</p>
                  </td>
                </tr>
              ) : (
                staffList.map((staff) => (
                  <tr key={staff.id} className={!staff.active ? 'opacity-50 bg-gray-50' : ''} data-testid={`staff-row-${staff.id}`}>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-3">
                        {getRoleIcon(staff.role)}
                        <span className="font-medium">{staff.name}</span>
                      </div>
                    </td>
                    {isSuperAdmin && (
                      <td className="px-4 py-3">
                        <code className="bg-gray-100 px-2 py-1 rounded text-sm font-mono">
                          {staff.pin_display || '----'}
                        </code>
                      </td>
                    )}
                    <td className="px-4 py-3">
                      {staff.showroom_name ? (
                        <div className="flex items-center gap-2 text-sm">
                          <Building2 className="h-4 w-4 text-muted-foreground" />
                          <span>{staff.showroom_name}</span>
                        </div>
                      ) : (
                        <span className="text-muted-foreground text-sm italic">All Stores</span>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      {getRoleBadge(staff.role)}
                    </td>
                    <td className="px-4 py-3 text-center">
                      {/* Warehouse permission at-a-glance. Consistent with the */}
                      {/* legacy fallback used in warehouse.py::_pin_can_manage_warehouse — */}
                      {/* explicit True/False wins, else admin/super_admin roles */}
                      {/* stay authorised for pre-toggle PINs. */}
                      {(() => {
                        const explicit = staff.can_manage_warehouse;
                        const legacyAllowed = ['admin', 'super_admin'].includes((staff.role || '').toLowerCase());
                        const canManage = explicit === true || (explicit == null && legacyAllowed);
                        return canManage ? (
                          <span
                            className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold bg-emerald-100 text-emerald-800 border border-emerald-200"
                            title={
                              explicit === true
                                ? 'Explicitly enabled — this PIN can Add / Adjust / Edit / Delete warehouse stock.'
                                : 'Legacy admin role — inherits warehouse edit permission. Explicitly tick to lock in.'
                            }
                            data-testid={`warehouse-perm-yes-${staff.id}`}
                          >
                            <Warehouse className="h-3 w-3" />
                            <span>Yes</span>
                          </span>
                        ) : (
                          <span
                            className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-gray-100 text-gray-500 border border-gray-200"
                            title="This PIN cannot adjust warehouse stock. Edit the PIN to enable."
                            data-testid={`warehouse-perm-no-${staff.id}`}
                          >
                            <Minus className="h-3 w-3" />
                            <span className="sr-only">Not authorised</span>
                          </span>
                        );
                      })()}
                    </td>
                    <td className="px-4 py-3 text-center">
                      <button
                        onClick={() => handleToggleActive(staff)}
                        className={`px-3 py-1 rounded-full text-xs font-medium transition-colors ${
                          staff.active 
                            ? 'bg-green-100 text-green-800 hover:bg-green-200' 
                            : 'bg-red-100 text-red-800 hover:bg-red-200'
                        }`}
                        data-testid={`toggle-status-${staff.id}`}
                      >
                        {staff.active ? 'Active' : 'Inactive'}
                      </button>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center justify-center gap-2">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => handleOpenDialog(staff)}
                          data-testid={`edit-staff-${staff.id}`}
                        >
                          <Edit2 className="h-4 w-4" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="text-red-600 hover:text-red-700 hover:bg-red-50"
                          onClick={() => handleDelete(staff)}
                          data-testid={`delete-staff-${staff.id}`}
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </div>
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
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>
              {editingStaff ? 'Edit Staff Member' : 'Add Staff Member'}
            </DialogTitle>
            <DialogDescription>
              {editingStaff 
                ? 'Update staff details. Leave PIN empty to keep the current PIN.' 
                : 'Create a new staff member with a confidential PIN for invoice access.'}
            </DialogDescription>
          </DialogHeader>
          
          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label className="text-sm font-medium">Name *</label>
              <Input
                value={formData.name}
                onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                placeholder="Staff member name"
                data-testid="staff-name-input"
              />
            </div>
            
            <div>
              <label className="text-sm font-medium">
                PIN {editingStaff ? '(leave empty to keep current)' : '*'}
              </label>
              <Input
                type="password"
                value={formData.pin}
                onChange={(e) => setFormData({ ...formData, pin: e.target.value.replace(/\D/g, '').slice(0, 6) })}
                placeholder={editingStaff ? '••••' : '4-6 digit PIN'}
                maxLength={6}
                data-testid="staff-pin-input"
              />
              <p className="text-xs text-muted-foreground mt-1">Must be 4-6 digits</p>
            </div>
            
            <div>
              <label className="text-sm font-medium">Role</label>
              <select
                value={formData.role}
                onChange={(e) => setFormData({ ...formData, role: e.target.value })}
                className="w-full h-10 px-3 border rounded-md"
                data-testid="staff-role-select"
              >
                <option value="staff">Staff</option>
                <option value="manager">Manager</option>
                <option value="admin">Admin</option>
              </select>
            </div>
            
            <div>
              <label className="text-sm font-medium">Store</label>
              <select
                value={formData.showroom_id}
                onChange={(e) => setFormData({ ...formData, showroom_id: e.target.value })}
                className="w-full h-10 px-3 border rounded-md"
                data-testid="staff-showroom-select"
              >
                <option value="">All Stores</option>
                {showrooms.map(showroom => (
                  <option key={showroom.id} value={showroom.id}>{showroom.name}</option>
                ))}
              </select>
              <p className="text-xs text-muted-foreground mt-1">Assign to a specific showroom or leave empty for all</p>
            </div>
            
            <div className="flex items-center gap-2">
              <input
                type="checkbox"
                id="active"
                checked={formData.active}
                onChange={(e) => setFormData({ ...formData, active: e.target.checked })}
                className="rounded"
                data-testid="staff-active-checkbox"
              />
              <label htmlFor="active" className="text-sm">Active (can use PIN)</label>
            </div>

            {/* Warehouse permission — gates whether the PIN can Add / */}
            {/* Adjust / Edit / Delete stock on the Tonbridge Warehouse */}
            {/* page. When ticked, this staff member's PIN unlocks the */}
            {/* warehouse edit dialogs; when unticked, entering the PIN */}
            {/* on the warehouse page returns a clear 403 that names */}
            {/* this person so the floor knows who to escalate to. */}
            <div className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50/60 px-3 py-2.5">
              <input
                type="checkbox"
                id="can_manage_warehouse"
                checked={!!formData.can_manage_warehouse}
                onChange={(e) => setFormData({ ...formData, can_manage_warehouse: e.target.checked })}
                className="mt-0.5 rounded"
                data-testid="staff-warehouse-manage-checkbox"
              />
              <label htmlFor="can_manage_warehouse" className="text-sm leading-tight cursor-pointer">
                <span className="font-medium text-amber-900">Warehouse: can adjust stock</span>
                <span className="block text-xs text-amber-800/80 mt-0.5">
                  Allows this PIN to Add batches, Adjust quantities, Edit and Delete stock on
                  the Tonbridge Warehouse page. Every action is stamped with this staff
                  member&apos;s name in the audit trail.
                </span>
              </label>
            </div>
            
            <DialogFooter>
              <Button type="button" variant="outline" onClick={handleCloseDialog}>
                Cancel
              </Button>
              <Button type="submit" disabled={saving} data-testid="save-staff-btn">
                {saving ? 'Saving...' : (editingStaff ? 'Update' : 'Create')}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
};
