import React, { useState, useEffect } from 'react';
import { api } from '../../lib/api';
import { toast } from 'sonner';
import { Building2, Plus, Edit2, Trash2, Phone, Mail, MapPin, Eye, EyeOff } from 'lucide-react';
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

export const Showrooms = () => {
  const [showrooms, setStores] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showDialog, setShowDialog] = useState(false);
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const [editingStore, setEditingStore] = useState(null);
  const [deletingStore, setDeletingStore] = useState(null);
  const [saving, setSaving] = useState(false);
  
  const [formData, setFormData] = useState({
    name: '',
    address: '',
    phone: '',
    email: ''
  });

  useEffect(() => {
    fetchStores();
  }, []);

  const fetchStores = async () => {
    try {
      const res = await api.getStores(true); // include inactive so admins can manage/reactivate closed stores
      setStores(res.data);
    } catch (error) {
      toast.error('Failed to fetch showrooms');
    } finally {
      setLoading(false);
    }
  };

  const toggleActive = async (showroom) => {
    try {
      await api.setStoreStatus(showroom.id, !(showroom.is_active !== false));
      toast.success(showroom.is_active !== false ? `${showroom.name} deactivated` : `${showroom.name} reactivated`);
      fetchStores();
    } catch (error) {
      toast.error('Failed to update store status');
    }
  };

  const handleOpenDialog = (showroom = null) => {
    if (showroom) {
      setEditingStore(showroom);
      setFormData({
        name: showroom.name || '',
        address: showroom.address || '',
        phone: showroom.phone || '',
        email: showroom.email || ''
      });
    } else {
      setEditingStore(null);
      setFormData({
        name: '',
        address: '',
        phone: '',
        email: ''
      });
    }
    setShowDialog(true);
  };

  const handleCloseDialog = () => {
    setShowDialog(false);
    setEditingStore(null);
    setFormData({
      name: '',
      address: '',
      phone: '',
      email: ''
    });
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    
    if (!formData.name.trim()) {
      toast.error('Store name is required');
      return;
    }
    
    setSaving(true);
    try {
      if (editingStore) {
        await api.updateStore(editingStore.id, formData);
        toast.success('Store updated successfully');
      } else {
        await api.createStore(formData);
        toast.success('Store created successfully');
      }
      handleCloseDialog();
      fetchStores();
    } catch (error) {
      toast.error(editingStore ? 'Failed to update showroom' : 'Failed to create showroom');
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!deletingStore) return;
    
    setSaving(true);
    try {
      await api.deleteStore(deletingStore.id);
      toast.success('Store deleted successfully');
      setShowDeleteDialog(false);
      setDeletingStore(null);
      fetchStores();
    } catch (error) {
      toast.error('Failed to delete showroom');
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return <div className="flex items-center justify-center h-64">Loading showrooms...</div>;
  }

  return (
    <div className="space-y-6" data-testid="showrooms-page">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-4xl font-heading font-bold tracking-tightest mb-2">Stores</h1>
          <p className="text-muted-foreground">Manage your store locations</p>
        </div>
        <Button onClick={() => handleOpenDialog()} data-testid="add-showroom-btn">
          <Plus className="h-4 w-4 mr-2" />
          Add Store
        </Button>
      </div>

      {/* Stores Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-2 gap-6">
        {showrooms.map((showroom) => (
          <Card key={showroom.id} className={`p-6 ${showroom.is_active === false ? 'opacity-60 bg-gray-50' : ''}`} data-testid={`showroom-card-${showroom.id}`}>
            <div className="flex items-start justify-between mb-4">
              <div className="flex items-center gap-3">
                <div className="p-3 bg-primary/10 rounded-lg">
                  <Building2 className="h-6 w-6 text-primary" />
                </div>
                <div>
                  <div className="flex items-center gap-2">
                    <h3 className="text-xl font-bold">{showroom.name}</h3>
                    {showroom.is_active === false && (
                      <span className="text-xs font-medium px-2 py-0.5 rounded-full bg-gray-200 text-gray-600" data-testid={`inactive-badge-${showroom.id}`}>
                        Closed
                      </span>
                    )}
                  </div>
                  <p className="text-sm text-muted-foreground">Tile Station</p>
                </div>
              </div>
              <div className="flex gap-1">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => toggleActive(showroom)}
                  title={showroom.is_active === false ? 'Reactivate store' : 'Deactivate store (hides from EPOS & website, keeps history)'}
                  className={showroom.is_active === false ? 'text-gray-400 hover:text-gray-600' : 'text-green-600 hover:text-green-700 hover:bg-green-50'}
                  data-testid={`toggle-active-showroom-${showroom.id}`}
                >
                  {showroom.is_active === false ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </Button>
                <Button 
                  variant="ghost" 
                  size="sm" 
                  onClick={() => handleOpenDialog(showroom)}
                  data-testid={`edit-showroom-${showroom.id}`}
                >
                  <Edit2 className="h-4 w-4" />
                </Button>
                <Button 
                  variant="ghost" 
                  size="sm" 
                  className="text-red-500 hover:text-red-600 hover:bg-red-50"
                  onClick={() => {
                    setDeletingStore(showroom);
                    setShowDeleteDialog(true);
                  }}
                  data-testid={`delete-showroom-${showroom.id}`}
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
            </div>
            
            <div className="space-y-3 text-sm">
              {showroom.address && (
                <div className="flex items-start gap-2 text-muted-foreground">
                  <MapPin className="h-4 w-4 mt-0.5 flex-shrink-0" />
                  <span>{showroom.address}</span>
                </div>
              )}
              {showroom.phone && (
                <div className="flex items-center gap-2 text-muted-foreground">
                  <Phone className="h-4 w-4" />
                  <a href={`tel:${showroom.phone}`} className="hover:text-primary">{showroom.phone}</a>
                </div>
              )}
              {showroom.email && (
                <div className="flex items-center gap-2 text-muted-foreground">
                  <Mail className="h-4 w-4" />
                  <a href={`mailto:${showroom.email}`} className="hover:text-primary">{showroom.email}</a>
                </div>
              )}
            </div>
          </Card>
        ))}
      </div>

      {showrooms.length === 0 && (
        <Card className="p-12 text-center">
          <Building2 className="h-12 w-12 mx-auto mb-4 text-muted-foreground opacity-50" />
          <h3 className="text-lg font-semibold mb-2">No showrooms yet</h3>
          <p className="text-muted-foreground mb-4">Add your first showroom to get started</p>
          <Button onClick={() => handleOpenDialog()}>
            <Plus className="h-4 w-4 mr-2" />
            Add Store
          </Button>
        </Card>
      )}

      {/* Add/Edit Dialog */}
      <Dialog open={showDialog} onOpenChange={setShowDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{editingStore ? 'Edit Store' : 'Add New Store'}</DialogTitle>
            <DialogDescription>
              {editingStore ? 'Update the showroom details below.' : 'Enter the details for the new showroom.'}
            </DialogDescription>
          </DialogHeader>
          
          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label className="text-sm font-medium mb-1 block">
                Store Name <span className="text-red-500">*</span>
              </label>
              <Input
                value={formData.name}
                onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                placeholder="e.g., Gravesend"
                data-testid="showroom-name-input"
              />
            </div>
            
            <div>
              <label className="text-sm font-medium mb-1 block">Address</label>
              <Input
                value={formData.address}
                onChange={(e) => setFormData({ ...formData, address: e.target.value })}
                placeholder="Full address"
                data-testid="showroom-address-input"
              />
            </div>
            
            <div>
              <label className="text-sm font-medium mb-1 block">Phone</label>
              <Input
                value={formData.phone}
                onChange={(e) => setFormData({ ...formData, phone: e.target.value })}
                placeholder="Phone number"
                data-testid="showroom-phone-input"
              />
            </div>
            
            <div>
              <label className="text-sm font-medium mb-1 block">Email</label>
              <Input
                type="email"
                value={formData.email}
                onChange={(e) => setFormData({ ...formData, email: e.target.value })}
                placeholder="showroom@tilestation.co.uk"
                data-testid="showroom-email-input"
              />
            </div>
            
            <DialogFooter>
              <Button type="button" variant="outline" onClick={handleCloseDialog}>
                Cancel
              </Button>
              <Button type="submit" disabled={saving} data-testid="save-showroom-btn">
                {saving ? 'Saving...' : (editingStore ? 'Update' : 'Create')}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation Dialog */}
      <Dialog open={showDeleteDialog} onOpenChange={setShowDeleteDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete Store</DialogTitle>
            <DialogDescription>
              Are you sure you want to delete &ldquo;{deletingStore?.name}&rdquo;? This action cannot be undone.
              Staff members and customers associated with this showroom will be unassigned.
              <br /><br />
              <strong>Tip:</strong> If this store has past invoices/orders, use the &ldquo;eye&rdquo; icon to deactivate it instead — this hides it from EPOS and the website while keeping all historical financial data intact.
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
              data-testid="confirm-delete-showroom"
            >
              {saving ? 'Deleting...' : 'Delete'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
};

export default Showrooms;
