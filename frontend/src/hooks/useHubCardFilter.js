/**
 * useHubCardFilter — permission-gated card filter for hub pages.
 *
 * Returns a `keep(card)` predicate that:
 *   1. Always returns true for super_admins
 *   2. Returns true while the perms context is still loading (so
 *      hub pages don't briefly flash an empty grid on first paint)
 *   3. Returns `hasPage(card.permission)` for normal users
 *   4. Cards may opt out of gating by omitting `permission` entirely
 *
 * 17 May 2026 — Dropped the `user.permissions[]` legacy fallback.
 * It was preventing admin-revoked permissions from taking effect (the
 * "I unticked Sync Hub but staff still see it" bug): users still had
 * stale `'products'` in their old permissions array which kept granting
 * the card via the fallback. Role-based defaults are now comprehensive
 * enough that no user needs the fallback.
 */
import { useAuth } from '../contexts/AuthContext';
import { usePermissions } from '../contexts/PermissionsContext';

export const useHubCardFilter = () => {
  const { user } = useAuth();
  const { hasPage, loading: permsLoading } = usePermissions();
  const isSuperAdmin = user?.role === 'super_admin';

  return (card) => {
    if (card.superAdminOnly && !isSuperAdmin) return false;
    if (isSuperAdmin) return true;
    if (!card.permission) return true;       // unguarded card
    if (permsLoading) return true;           // optimistic on first paint
    return hasPage(card.permission);
  };
};

export default useHubCardFilter;
