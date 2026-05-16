import React, { useEffect, useState, useMemo } from 'react';
import axios from 'axios';
import { toast } from 'sonner';
import { useAuth } from '../../contexts/AuthContext';
import { usePermissions } from '../../contexts/PermissionsContext';
import { Card, CardContent, CardHeader, CardTitle } from '../../components/ui/card';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { Label } from '../../components/ui/label';
import { Checkbox } from '../../components/ui/checkbox';
import { Badge } from '../../components/ui/badge';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription,
} from '../../components/ui/dialog';
import { useNavigate, useLocation } from 'react-router-dom';
import { ShieldCheck, Plus, Trash2, Save, Search, Lock, Crown, Bell, UserCog } from 'lucide-react';
import UserOverridesTab from './UserOverridesTab';

const API = `${process.env.REACT_APP_BACKEND_URL}/api`;

export default function PermissionsAdmin() {
  const navigate = useNavigate();
  const location = useLocation();
  const { token, user } = useAuth();
  const { refresh: refreshMyPerms } = usePermissions();

  const [registry, setRegistry] = useState({ pages: [], actions: [] });
  const [roles, setRoles] = useState([]);
  const [activeRoleId, setActiveRoleId] = useState(null);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const [showCreate, setShowCreate] = useState(false);
  const [newRoleId, setNewRoleId] = useState('');
  const [newRoleName, setNewRoleName] = useState('');

  // 16 May 2026 — second tab: per-user overrides.
  // `?tab=users&user=foo@bar.com` deep-link support so the legacy
  // /admin/users edit modal can hand off cleanly.
  const params = new URLSearchParams(location.search);
  const initialTab = params.get('tab') === 'users' ? 'users' : 'roles';
  const initialUser = params.get('user');
  const [activeTab, setActiveTab] = useState(initialTab);

  const isSuperAdmin = user?.role === 'super_admin';

  const headers = { Authorization: `Bearer ${token}` };

  const loadAll = async () => {
    try {
      setLoading(true);
      const [reg, rl] = await Promise.all([
        axios.get(`${API}/permissions/registry`, { headers }),
        axios.get(`${API}/permissions/roles`, { headers }),
      ]);
      setRegistry(reg.data);
      setRoles(rl.data);
      if (!activeRoleId && rl.data.length > 0) {
        const firstNonSuper = rl.data.find(r => !r.is_super_admin) || rl.data[0];
        setActiveRoleId(firstNonSuper.role_id);
      }
    } catch (err) {
      console.error(err);
      toast.error('Failed to load permissions');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { if (token) loadAll(); /* eslint-disable-next-line */ }, [token]);

  const activeRole = roles.find(r => r.role_id === activeRoleId);

  const pagesByGroup = useMemo(() => {
    const term = search.trim().toLowerCase();
    const grouped = {};
    (registry.pages || []).forEach(p => {
      if (term && !p.label.toLowerCase().includes(term) && !p.key.toLowerCase().includes(term)) return;
      const g = p.group || 'Other';
      if (!grouped[g]) grouped[g] = [];
      grouped[g].push(p);
    });
    return grouped;
  }, [registry.pages, search]);

  const actionsByPage = useMemo(() => {
    const term = search.trim().toLowerCase();
    const grouped = {};
    (registry.actions || []).forEach(a => {
      if (term && !a.label.toLowerCase().includes(term) && !a.key.toLowerCase().includes(term)) return;
      const p = a.page || 'misc';
      if (!grouped[p]) grouped[p] = [];
      grouped[p].push(a);
    });
    return grouped;
  }, [registry.actions, search]);

  const togglePage = (key) => {
    if (!activeRole || activeRole.is_super_admin) return;
    const next = activeRole.pages.includes(key)
      ? activeRole.pages.filter(k => k !== key)
      : [...activeRole.pages, key];
    setRoles(roles.map(r => r.role_id === activeRole.role_id ? { ...r, pages: next } : r));
  };

  const toggleAction = (key) => {
    if (!activeRole || activeRole.is_super_admin) return;
    const next = activeRole.actions.includes(key)
      ? activeRole.actions.filter(k => k !== key)
      : [...activeRole.actions, key];
    setRoles(roles.map(r => r.role_id === activeRole.role_id ? { ...r, actions: next } : r));
  };

  const toggleAllInGroup = (groupPages, allOn) => {
    if (!activeRole || activeRole.is_super_admin) return;
    const groupKeys = groupPages.map(p => p.key);
    let next;
    if (allOn) {
      next = activeRole.pages.filter(k => !groupKeys.includes(k));
    } else {
      next = Array.from(new Set([...activeRole.pages, ...groupKeys]));
    }
    setRoles(roles.map(r => r.role_id === activeRole.role_id ? { ...r, pages: next } : r));
  };

  const saveActiveRole = async () => {
    if (!activeRole || activeRole.is_super_admin) return;
    try {
      setSaving(true);
      const payload = { pages: activeRole.pages, actions: activeRole.actions };
      if (!activeRole.is_system) payload.role_name = activeRole.role_name;
      await axios.put(`${API}/permissions/roles/${activeRole.role_id}`, payload, { headers });
      toast.success(`Saved permissions for ${activeRole.role_name}`);
      refreshMyPerms();
    } catch (err) {
      console.error(err);
      toast.error(err?.response?.data?.detail || 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  const createRole = async () => {
    const id = newRoleId.trim().toLowerCase().replace(/\s+/g, '_');
    if (!id || !newRoleName.trim()) {
      toast.error('Both Role ID and Display Name are required');
      return;
    }
    try {
      const res = await axios.post(`${API}/permissions/roles`, {
        role_id: id, role_name: newRoleName.trim(), pages: [], actions: [],
      }, { headers });
      setRoles([...roles, res.data]);
      setActiveRoleId(res.data.role_id);
      setShowCreate(false);
      setNewRoleId(''); setNewRoleName('');
      toast.success(`Role '${res.data.role_name}' created`);
    } catch (err) {
      toast.error(err?.response?.data?.detail || 'Create failed');
    }
  };

  const deleteRole = async (role) => {
    if (role.is_system) return;
    if (!window.confirm(`Delete role "${role.role_name}"? This cannot be undone.`)) return;
    try {
      await axios.delete(`${API}/permissions/roles/${role.role_id}`, { headers });
      setRoles(roles.filter(r => r.role_id !== role.role_id));
      if (activeRoleId === role.role_id) {
        setActiveRoleId(roles.find(r => r.role_id !== role.role_id)?.role_id || null);
      }
      toast.success('Role deleted');
    } catch (err) {
      toast.error(err?.response?.data?.detail || 'Delete failed');
    }
  };

  if (!isSuperAdmin) {
    return (
      <div className="p-8" data-testid="permissions-no-access">
        <Card>
          <CardContent className="p-8 text-center">
            <Lock className="w-12 h-12 mx-auto text-gray-400 mb-3" />
            <h2 className="text-lg font-semibold mb-1">Super Admin only</h2>
            <p className="text-sm text-gray-500">You need Super Admin to manage permissions.</p>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="p-6 space-y-4" data-testid="permissions-admin-page">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-3">
          <ShieldCheck className="w-7 h-7 text-emerald-600" />
          <div>
            <h1 className="text-2xl font-bold">Permissions</h1>
            <p className="text-sm text-gray-500">Control which pages and actions each role can access</p>
          </div>
        </div>
        <Button onClick={() => setShowCreate(true)} data-testid="create-role-btn">
          <Plus className="w-4 h-4 mr-1" /> New Role
        </Button>
      </div>

      {isSuperAdmin && (
        <Card className="border-purple-200 bg-gradient-to-br from-purple-50 to-white">
          <CardContent className="p-4 flex items-start justify-between gap-4">
            <div className="flex items-start gap-3">
              <div className="bg-purple-100 p-2 rounded-lg flex-shrink-0">
                <Bell className="w-5 h-5 text-purple-600" />
              </div>
              <div>
                <p className="font-semibold text-slate-900">Notification authorisations</p>
                <p className="text-xs text-slate-600 mt-0.5">
                  Control which admins receive automated emails — P&amp;L, quarterly board deck, GSC digests, UI health.
                  Default = deny. Super-admin only.
                </p>
              </div>
            </div>
            <Button
              size="sm"
              onClick={() => navigate('/admin/notification-permissions')}
              data-testid="open-notification-permissions-btn"
              className="bg-purple-600 hover:bg-purple-700 text-white flex-shrink-0"
            >
              Manage →
            </Button>
          </CardContent>
        </Card>
      )}

      {/* Tabs: Roles vs Per-user overrides
        *
        * Roles tab — manages the default permission set for each role
        * (super_admin, admin, manager, staff, custom). Affects everyone
        * assigned to that role.
        *
        * User overrides tab — adjusts an INDIVIDUAL user's effective
        * permissions on top of their role baseline (grant extra pages
        * or deny role-granted pages, scoped to just that one user). The
        * sidebar reads the merged result via /api/permissions/me.
        */}
      <div className="flex items-center gap-2 border-b">
        <button
          onClick={() => setActiveTab('roles')}
          className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors ${
            activeTab === 'roles'
              ? 'border-emerald-600 text-emerald-700'
              : 'border-transparent text-gray-500 hover:text-gray-800'
          }`}
          data-testid="permissions-tab-roles"
        >
          <ShieldCheck className="w-4 h-4 inline mr-1.5 -mt-0.5" />
          Roles
        </button>
        <button
          onClick={() => setActiveTab('users')}
          className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors ${
            activeTab === 'users'
              ? 'border-emerald-600 text-emerald-700'
              : 'border-transparent text-gray-500 hover:text-gray-800'
          }`}
          data-testid="permissions-tab-users"
        >
          <UserCog className="w-4 h-4 inline mr-1.5 -mt-0.5" />
          User overrides
        </button>
      </div>

      {activeTab === 'users' ? (
        <UserOverridesTab
          token={token}
          registry={registry}
          roles={roles}
          initialUserEmail={initialUser}
        />
      ) : (
      <div className="grid grid-cols-12 gap-4">
        {/* Roles list */}
        <Card className="col-span-12 lg:col-span-3 h-fit">
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Roles</CardTitle>
          </CardHeader>
          <CardContent className="p-2 space-y-1">
            {loading && <p className="text-sm text-gray-400 p-2">Loading…</p>}
            {!loading && roles.map(r => {
              const isActive = r.role_id === activeRoleId;
              return (
                <button
                  key={r.role_id}
                  onClick={() => setActiveRoleId(r.role_id)}
                  className={`w-full text-left p-2 rounded-md flex items-center justify-between gap-2 transition-colors ${isActive ? 'bg-emerald-50 border border-emerald-200' : 'hover:bg-gray-50 border border-transparent'}`}
                  data-testid={`role-tab-${r.role_id}`}
                >
                  <div className="flex flex-col min-w-0">
                    <span className="font-medium text-sm truncate">{r.role_name}</span>
                    <span className="text-[11px] text-gray-400 truncate">{r.role_id}</span>
                  </div>
                  <div className="flex items-center gap-1">
                    {r.is_super_admin && <Crown className="w-3.5 h-3.5 text-amber-500" />}
                    {r.is_system && <Badge variant="secondary" className="text-[10px] py-0">system</Badge>}
                    {!r.is_system && (
                      <button
                        onClick={(e) => { e.stopPropagation(); deleteRole(r); }}
                        className="text-red-500 hover:text-red-700 p-1"
                        title="Delete role"
                        data-testid={`delete-role-${r.role_id}`}
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    )}
                  </div>
                </button>
              );
            })}
          </CardContent>
        </Card>

        {/* Permission grid */}
        <Card className="col-span-12 lg:col-span-9">
          <CardHeader className="pb-3 border-b">
            <div className="flex items-center justify-between gap-3 flex-wrap">
              <div>
                <CardTitle className="text-lg">{activeRole?.role_name || '—'}</CardTitle>
                {activeRole && (
                  <p className="text-xs text-gray-500 mt-0.5">
                    {activeRole.is_super_admin
                      ? 'Super Admin always has full access. Cannot be edited.'
                      : `${activeRole.pages.length} page(s) • ${activeRole.actions.length} action(s) granted`}
                  </p>
                )}
              </div>
              <div className="flex items-center gap-2">
                <div className="relative">
                  <Search className="w-4 h-4 absolute left-2 top-2.5 text-gray-400" />
                  <Input
                    placeholder="Search pages/actions"
                    value={search}
                    onChange={e => setSearch(e.target.value)}
                    className="pl-8 w-56"
                    data-testid="permissions-search"
                  />
                </div>
                <Button
                  onClick={saveActiveRole}
                  disabled={!activeRole || activeRole.is_super_admin || saving}
                  data-testid="save-permissions-btn"
                >
                  <Save className="w-4 h-4 mr-1" />
                  {saving ? 'Saving…' : 'Save changes'}
                </Button>
              </div>
            </div>
          </CardHeader>
          <CardContent className="p-4 max-h-[70vh] overflow-y-auto space-y-6">
            {!activeRole && <p className="text-sm text-gray-500">Select a role to edit.</p>}
            {activeRole && activeRole.is_super_admin && (
              <div className="rounded-md bg-amber-50 border border-amber-200 p-4 text-sm text-amber-800 flex items-start gap-2">
                <Crown className="w-4 h-4 mt-0.5" />
                Super Admin bypasses all permission checks and always has full access.
              </div>
            )}
            {activeRole && !activeRole.is_super_admin && (
              <>
                <section>
                  <h3 className="font-semibold text-sm uppercase tracking-wide text-gray-500 mb-3">Pages</h3>
                  <div className="space-y-4">
                    {Object.entries(pagesByGroup).map(([group, items]) => {
                      const allKeys = items.map(i => i.key);
                      const allOn = allKeys.every(k => activeRole.pages.includes(k));
                      const someOn = allKeys.some(k => activeRole.pages.includes(k));
                      return (
                        <div key={group} className="border rounded-md p-3">
                          <div className="flex items-center justify-between mb-2">
                            <h4 className="font-medium text-sm">{group}</h4>
                            <button
                              onClick={() => toggleAllInGroup(items, allOn)}
                              className="text-xs text-emerald-600 hover:underline"
                              data-testid={`toggle-group-${group.toLowerCase().replace(/\s+/g, '-')}`}
                            >
                              {allOn ? 'Deselect all' : someOn ? 'Select remaining' : 'Select all'}
                            </button>
                          </div>
                          <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                            {items.map(p => (
                              <label key={p.key} className="flex items-center gap-2 text-sm cursor-pointer hover:bg-gray-50 rounded px-2 py-1">
                                <Checkbox
                                  checked={activeRole.pages.includes(p.key)}
                                  onCheckedChange={() => togglePage(p.key)}
                                  data-testid={`page-checkbox-${p.key}`}
                                />
                                <span>{p.label}</span>
                                <span className="text-[11px] text-gray-400 ml-auto">{p.key}</span>
                              </label>
                            ))}
                          </div>
                        </div>
                      );
                    })}
                    {Object.keys(pagesByGroup).length === 0 && (
                      <p className="text-sm text-gray-400">No pages match your search.</p>
                    )}
                  </div>
                </section>

                <section>
                  <h3 className="font-semibold text-sm uppercase tracking-wide text-gray-500 mb-3">Granular Actions</h3>
                  <div className="space-y-4">
                    {Object.entries(actionsByPage).map(([pageKey, items]) => {
                      const pageLabel = (registry.pages.find(p => p.key === pageKey) || {}).label || pageKey;
                      return (
                        <div key={pageKey} className="border rounded-md p-3">
                          <h4 className="font-medium text-sm mb-2">{pageLabel}</h4>
                          <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                            {items.map(a => (
                              <label key={a.key} className="flex items-center gap-2 text-sm cursor-pointer hover:bg-gray-50 rounded px-2 py-1">
                                <Checkbox
                                  checked={activeRole.actions.includes(a.key)}
                                  onCheckedChange={() => toggleAction(a.key)}
                                  data-testid={`action-checkbox-${a.key}`}
                                />
                                <span>{a.label}</span>
                              </label>
                            ))}
                          </div>
                        </div>
                      );
                    })}
                    {Object.keys(actionsByPage).length === 0 && (
                      <p className="text-sm text-gray-400">No actions match your search.</p>
                    )}
                  </div>
                </section>
              </>
            )}
          </CardContent>
        </Card>
      </div>
      )}

      <Dialog open={showCreate} onOpenChange={setShowCreate}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Create custom role</DialogTitle>
            <DialogDescription>
              All permissions start OFF. Toggle pages and actions on after creating the role.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <div>
              <Label>Display name</Label>
              <Input
                placeholder="e.g. Showroom Lead"
                value={newRoleName}
                onChange={e => setNewRoleName(e.target.value)}
                data-testid="new-role-name"
              />
            </div>
            <div>
              <Label>Role ID</Label>
              <Input
                placeholder="e.g. showroom_lead (lowercase, no spaces)"
                value={newRoleId}
                onChange={e => setNewRoleId(e.target.value)}
                data-testid="new-role-id"
              />
              <p className="text-[11px] text-gray-400 mt-1">Used internally. Cannot be changed later.</p>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowCreate(false)}>Cancel</Button>
            <Button onClick={createRole} data-testid="confirm-create-role">Create role</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
