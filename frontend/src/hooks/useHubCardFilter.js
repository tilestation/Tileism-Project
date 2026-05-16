/**
 * useHubCardFilter — permission-gated card filter for hub pages.
 *
 * Returns a `keep(card)` predicate that:
 *   1. Always returns true for super_admins
 *   2. Falls through to true while the perms context is still loading
 *      (so hub pages don't briefly show an empty grid on first paint)
 *   3. Returns `hasPage(card.permission)` for normal users
 *   4. Also honours `legacyPermission` against the old user.permissions[]
 *      array as a belt-and-braces fallback for users whose tokens
 *      predate the May 2026 unification.
 *
 * Card shape contract:
 *   {
 *     title, description, icon, link, color,
 *     permission: 'sync_hub',           // canonical PAGE_REGISTRY key
 *     legacyPermission?: 'products',    // optional old grouped key
 *     superAdminOnly?: true,
 *   }
 *
 * Usage:
 *   const keepCard = useHubCardFilter();
 *   const visible = cards.filter(keepCard);
 */
import { useAuth } from '../contexts/AuthContext';
import { usePermissions } from '../contexts/PermissionsContext';

export const useHubCardFilter = () => {
  const { user } = useAuth();
  const { hasPage, loading: permsLoading } = usePermissions();
  const isSuperAdmin = user?.role === 'super_admin';
  const legacy = user?.permissions || [];

  return (card) => {
    if (card.superAdminOnly && !isSuperAdmin) return false;
    if (isSuperAdmin) return true;
    if (!card.permission) return true; // unguarded card — always show
    // Don't render an empty grid on initial load — show cards optimistically
    // then re-render when /me responds. The sidebar already gates the page
    // entry-point so unauthorised users can't reach the hub anyway.
    if (permsLoading) return true;
    if (hasPage(card.permission)) return true;
    if (card.legacyPermission && legacy.includes(card.legacyPermission)) return true;
    return false;
  };
};

export default useHubCardFilter;
