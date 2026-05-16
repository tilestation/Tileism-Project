import React, { useEffect, useMemo, useState } from 'react';
import axios from 'axios';
import { toast } from 'sonner';
import { Card, CardContent, CardHeader, CardTitle } from '../../components/ui/card';
import { Input } from '../../components/ui/input';
import { Button } from '../../components/ui/button';
import { Badge } from '../../components/ui/badge';
import { Checkbox } from '../../components/ui/checkbox';
import { Search, Save, UserCog, ShieldCheck, AlertCircle, Building2, Crown } from 'lucide-react';

/**
 * Per-user permission overrides — second tab on /admin/permissions.
 *
 * Lets a super-admin grant extra pages/actions to ONE user beyond their
 * role's defaults, or deny specific pages just for that user, without
 * having to spin up a whole custom role.
 *
 * Effective access = role.pages + extra_pages − denied_pages
 *
 * Layout:
 *   ┌──── User picker (filters) ────┬──── Effective permissions ─────┐
 *   │  [search box]                  │  Role baseline (read-only)      │
 *   │  [showroom filter]             │  Extra grants (toggle-able)     │
 *   │  [role filter]                 │  Denied pages (toggle-able)     │
 *   │  ─ user list (scrollable) ─    │  [Save]                         │
 *   └────────────────────────────────┴─────────────────────────────────┘
 *
 * `initialUserEmail` (optional) — if set, auto-selects that user. Wired
 * up so the legacy /admin/users edit modal can deep-link straight here.
 */
const API = `${process.env.REACT_APP_BACKEND_URL}/api`;

export default function UserOverridesTab({ token, registry, roles, initialUserEmail = null }) {
  const headers = useMemo(() => ({ Authorization: `Bearer ${token}` }), [token]);

  // ── User picker state ─────────────────────────────────────────────
  const [users, setUsers] = useState([]);
  const [search, setSearch] = useState('');
  const [showroomFilter, setShowroomFilter] = useState('');
  const [roleFilter, setRoleFilter] = useState('');
  const [showrooms, setShowrooms] = useState([]);
  const [loadingUsers, setLoadingUsers] = useState(true);

  // ── Selected user + their permission detail ────────────────────────
  const [selectedEmail, setSelectedEmail] = useState(initialUserEmail);
  const [detail, setDetail] = useState(null);     // full breakdown from /users/{email}
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [saving, setSaving] = useState(false);

  // Local editing state — synced from `detail` whenever a new user loads.
  const [extraPages, setExtraPages] = useState(new Set());
  const [deniedPages, setDeniedPages] = useState(new Set());

  // ── Load user list (one-shot) ─────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        setLoadingUsers(true);
        const [usersRes, showroomsRes] = await Promise.all([
          axios.get(`${API}/permissions/users`, { headers }),
          // Re-use the existing showrooms endpoint so we get the same
          // names as everywhere else in admin.
          axios.get(`${API}/showrooms`, { headers }).catch(() => ({ data: [] })),
        ]);
        if (cancelled) return;
        setUsers(usersRes.data || []);
        setShowrooms(showroomsRes.data || []);
      } catch (err) {
        if (!cancelled) toast.error('Failed to load users');
      } finally {
        if (!cancelled) setLoadingUsers(false);
      }
    })();
    return () => { cancelled = true; };
  }, [headers]);

  // ── Load full detail when a user is selected ───────────────────────
  useEffect(() => {
    if (!selectedEmail) {
      setDetail(null);
      setExtraPages(new Set());
      setDeniedPages(new Set());
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        setLoadingDetail(true);
        const res = await axios.get(
          `${API}/permissions/users/${encodeURIComponent(selectedEmail)}`,
          { headers },
        );
        if (cancelled) return;
        setDetail(res.data);
        setExtraPages(new Set(res.data.extra_pages || []));
        setDeniedPages(new Set(res.data.denied_pages || []));
      } catch (err) {
        if (!cancelled) toast.error('Failed to load user permissions');
      } finally {
        if (!cancelled) setLoadingDetail(false);
      }
    })();
    return () => { cancelled = true; };
  }, [selectedEmail, headers]);

  // ── Client-side filtering of the user list ─────────────────────────
  const filteredUsers = useMemo(() => {
    const term = search.trim().toLowerCase();
    return users.filter(u => {
      if (showroomFilter && u.showroom_id !== showroomFilter) return false;
      if (roleFilter && u.role !== roleFilter) return false;
      if (term && !(u.email || '').toLowerCase().includes(term) && !(u.name || '').toLowerCase().includes(term)) return false;
      return true;
    });
  }, [users, search, showroomFilter, roleFilter]);

  // ── Group registry pages by their `group` for display ──────────────
  const pagesByGroup = useMemo(() => {
    const grouped = {};
    (registry?.pages || []).forEach(p => {
      const g = p.group || 'Other';
      if (!grouped[g]) grouped[g] = [];
      grouped[g].push(p);
    });
    return grouped;
  }, [registry]);

  const rolePages = new Set(detail?.role_pages || []);

  // ── Toggle helpers ────────────────────────────────────────────────
  const togglePageGrant = (pageKey) => {
    // A "page grant" toggle has 3 conceptual states:
    //   - granted by role → can only DENY (adds to denied_pages)
    //   - not in role + not extra → can GRANT (adds to extra_pages)
    //   - not in role + extra → REMOVE the extra grant
    if (rolePages.has(pageKey)) {
      // Role grants it; we're toggling DENIED.
      const next = new Set(deniedPages);
      if (next.has(pageKey)) next.delete(pageKey); else next.add(pageKey);
      setDeniedPages(next);
    } else {
      // Role doesn't grant it; we're toggling EXTRA.
      const next = new Set(extraPages);
      if (next.has(pageKey)) next.delete(pageKey); else next.add(pageKey);
      setExtraPages(next);
    }
  };

  const isPageEffective = (pageKey) => {
    if (rolePages.has(pageKey) && !deniedPages.has(pageKey)) return true;
    if (extraPages.has(pageKey)) return true;
    return false;
  };

  // ── Save ──────────────────────────────────────────────────────────
  const save = async () => {
    if (!selectedEmail) return;
    try {
      setSaving(true);
      const res = await axios.put(
        `${API}/permissions/users/${encodeURIComponent(selectedEmail)}/overrides`,
        {
          extra_pages: Array.from(extraPages),
          denied_pages: Array.from(deniedPages),
        },
        { headers },
      );
      setDetail(res.data);
      toast.success('Overrides saved — user must log out and back in to apply');
      // Refresh the list so override_count badge updates.
      const refreshed = await axios.get(`${API}/permissions/users`, { headers });
      setUsers(refreshed.data || []);
    } catch (err) {
      toast.error(err?.response?.data?.detail || 'Failed to save overrides');
    } finally {
      setSaving(false);
    }
  };

  const dirty =
    detail &&
    (
      // Compare set contents — sizes equal AND all members match.
      extraPages.size !== (detail.extra_pages?.length || 0) ||
      deniedPages.size !== (detail.denied_pages?.length || 0) ||
      Array.from(extraPages).some(p => !(detail.extra_pages || []).includes(p)) ||
      Array.from(deniedPages).some(p => !(detail.denied_pages || []).includes(p))
    );

  const getRoleBadgeClasses = (role) => {
    switch (role) {
      case 'super_admin': return 'bg-purple-100 text-purple-800';
      case 'admin': return 'bg-blue-100 text-blue-800';
      case 'manager': return 'bg-emerald-100 text-emerald-800';
      case 'staff': default: return 'bg-slate-100 text-slate-700';
    }
  };

  return (
    <div className="grid grid-cols-12 gap-4" data-testid="user-overrides-tab">
      {/* ───── Left: user picker ───── */}
      <Card className="col-span-12 lg:col-span-4 h-fit">
        <CardHeader className="pb-2">
          <CardTitle className="text-base flex items-center gap-2">
            <UserCog className="w-4 h-4" /> Pick a user
          </CardTitle>
        </CardHeader>
        <CardContent className="p-3 space-y-3">
          <div className="relative">
            <Search className="absolute left-2.5 top-2.5 w-4 h-4 text-gray-400 pointer-events-none" />
            <Input
              placeholder="Search by name or email…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="pl-8 h-9"
              data-testid="user-overrides-search"
            />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <select
              value={showroomFilter}
              onChange={(e) => setShowroomFilter(e.target.value)}
              className="h-9 px-2 text-sm border rounded-md bg-white"
              data-testid="user-overrides-showroom-filter"
            >
              <option value="">All stores</option>
              {showrooms.map(s => (
                <option key={s.id} value={s.id}>{s.name}</option>
              ))}
            </select>
            <select
              value={roleFilter}
              onChange={(e) => setRoleFilter(e.target.value)}
              className="h-9 px-2 text-sm border rounded-md bg-white"
              data-testid="user-overrides-role-filter"
            >
              <option value="">All roles</option>
              {roles.filter(r => !r.is_super_admin).map(r => (
                <option key={r.role_id} value={r.role_id}>{r.role_name}</option>
              ))}
            </select>
          </div>

          <div className="max-h-[60vh] overflow-y-auto -mx-1 px-1 space-y-1">
            {loadingUsers && <p className="text-xs text-gray-400 p-2">Loading users…</p>}
            {!loadingUsers && filteredUsers.length === 0 && (
              <p className="text-xs text-gray-400 p-2">No matching users.</p>
            )}
            {!loadingUsers && filteredUsers.map(u => {
              const isActive = u.email === selectedEmail;
              const isSuper = u.role === 'super_admin';
              return (
                <button
                  key={u.email}
                  onClick={() => setSelectedEmail(u.email)}
                  disabled={isSuper}
                  className={`w-full text-left p-2 rounded-md transition-colors border ${
                    isActive
                      ? 'bg-emerald-50 border-emerald-300'
                      : isSuper
                        ? 'opacity-50 cursor-not-allowed border-transparent'
                        : 'hover:bg-gray-50 border-transparent'
                  }`}
                  data-testid={`user-overrides-pick-${u.email}`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium truncate">{u.name || u.email}</p>
                      <p className="text-[11px] text-gray-500 truncate">{u.email}</p>
                    </div>
                    {isSuper && <Crown className="w-3.5 h-3.5 text-amber-500 flex-shrink-0" title="Super Admin — overrides not applicable" />}
                  </div>
                  <div className="flex items-center gap-1 mt-1 flex-wrap">
                    <span className={`text-[10px] px-1.5 py-0 rounded ${getRoleBadgeClasses(u.role)}`}>
                      {u.role}
                    </span>
                    {u.showroom_name && (
                      <span className="text-[10px] px-1.5 py-0 rounded bg-slate-100 text-slate-600 flex items-center gap-0.5">
                        <Building2 className="w-2.5 h-2.5" /> {u.showroom_name}
                      </span>
                    )}
                    {u.override_count > 0 && (
                      <Badge variant="secondary" className="text-[10px] py-0">
                        {u.override_count} override{u.override_count === 1 ? '' : 's'}
                      </Badge>
                    )}
                  </div>
                </button>
              );
            })}
          </div>
        </CardContent>
      </Card>

      {/* ───── Right: effective permissions for the selected user ───── */}
      <Card className="col-span-12 lg:col-span-8">
        <CardHeader className="pb-3 border-b">
          {!selectedEmail ? (
            <CardTitle className="text-base text-gray-500">Select a user to view & edit their permissions</CardTitle>
          ) : loadingDetail || !detail ? (
            <CardTitle className="text-base text-gray-500">Loading…</CardTitle>
          ) : (
            <div className="flex items-start justify-between gap-3 flex-wrap">
              <div>
                <CardTitle className="text-base flex items-center gap-2">
                  <ShieldCheck className="w-4 h-4 text-emerald-600" />
                  {detail.name || detail.email}
                </CardTitle>
                <p className="text-xs text-gray-500 mt-0.5">
                  <span className={`inline-block px-1.5 py-0 rounded text-[10px] mr-1 ${getRoleBadgeClasses(detail.role)}`}>
                    {detail.role}
                  </span>
                  Role grants <strong>{detail.role_pages.length}</strong> pages by default
                  {detail.showroom_name && <> · Store: <strong>{detail.showroom_name}</strong></>}
                </p>
              </div>
              <Button
                size="sm"
                onClick={save}
                disabled={saving || !dirty}
                data-testid="user-overrides-save-btn"
              >
                <Save className="w-3.5 h-3.5 mr-1" />
                {saving ? 'Saving…' : dirty ? 'Save overrides' : 'No changes'}
              </Button>
            </div>
          )}
        </CardHeader>

        {selectedEmail && detail && !loadingDetail && (
          <CardContent className="p-4 space-y-4">
            <div className="rounded-md bg-amber-50 border border-amber-200 p-3 flex items-start gap-2">
              <AlertCircle className="w-4 h-4 text-amber-600 mt-0.5 flex-shrink-0" />
              <p className="text-xs text-amber-800">
                Ticking a page that&apos;s already part of the role just keeps it. Un-ticking
                a role-granted page DENIES it for this user only. Ticking a page outside the
                role GRANTS extra access just to this user. The user must log out & back in
                to see changes.
              </p>
            </div>

            {Object.entries(pagesByGroup).map(([groupName, pages]) => (
              <div key={groupName} className="border rounded-lg p-3">
                <p className="text-xs font-semibold uppercase tracking-wide text-gray-500 mb-2">
                  {groupName}
                </p>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                  {pages.map(p => {
                    const fromRole = rolePages.has(p.key);
                    const denied = deniedPages.has(p.key);
                    const extra = extraPages.has(p.key);
                    const effective = isPageEffective(p.key);
                    return (
                      <label
                        key={p.key}
                        className={`flex items-center justify-between gap-2 p-2 rounded-md cursor-pointer transition-colors ${
                          effective ? 'bg-emerald-50' : 'hover:bg-gray-50'
                        }`}
                        data-testid={`user-override-page-${p.key}`}
                      >
                        <div className="flex items-center gap-2 min-w-0">
                          <Checkbox
                            checked={effective}
                            onCheckedChange={() => togglePageGrant(p.key)}
                          />
                          <span className="text-sm truncate">{p.label}</span>
                        </div>
                        <div className="flex items-center gap-1 flex-shrink-0">
                          {fromRole && !denied && (
                            <Badge variant="secondary" className="text-[9px] py-0">role</Badge>
                          )}
                          {fromRole && denied && (
                            <Badge variant="destructive" className="text-[9px] py-0">denied</Badge>
                          )}
                          {extra && !fromRole && (
                            <Badge className="text-[9px] py-0 bg-blue-100 text-blue-800 hover:bg-blue-100">extra</Badge>
                          )}
                        </div>
                      </label>
                    );
                  })}
                </div>
              </div>
            ))}
          </CardContent>
        )}
      </Card>
    </div>
  );
}
