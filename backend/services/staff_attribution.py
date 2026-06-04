"""
Staff attribution helpers — stamps `created_by_user_id`, `showroom_id`,
and `showroom_name` on docs at creation time so downstream reports
(leaderboards, CSV exports, audit logs) stay correct even after a
staff member is transferred between showrooms. (4 Jun 2026.)

The leaderboard already has a runtime fallback that resolves missing
showroom info via the users + showrooms collections, but stamping at
creation time means:
  • new docs are SELF-CONTAINED — they remember which showroom the
    sale belonged to ON THE DAY, not the staff member's CURRENT one
  • leaderboard / dashboard / export queries no longer need to do
    the extra two-collection lookup, so they're faster
"""
from typing import Optional

from config import get_db


async def resolve_staff_attribution(
    current_user: dict,
    input_showroom_id: Optional[str] = None,
    input_showroom_name: Optional[str] = None,
) -> dict:
    """Return `{created_by_user_id, showroom_id, showroom_name}` to be
    merged into a new quotation / invoice / sale doc.

    Resolution order for showroom:
      1. Explicit input.showroom_name (if provided by the form).
      2. Explicit input.showroom_id → look up showrooms collection.
      3. The user's stored showroom_name on their profile.
      4. The user's stored showroom_id → look up showrooms collection.
      5. Empty string — leaderboard's runtime resolver will still
         fall back if needed, but at this point we genuinely have
         nothing to stamp.

    All fields default to empty strings (never None) so downstream
    code never has to handle the None case on a stamped doc.
    """
    db = get_db()
    showroom_id = (input_showroom_id or "").strip()
    showroom_name = (input_showroom_name or "").strip()

    # Prefer the user's profile when the form didn't carry one.
    if not showroom_id:
        showroom_id = (current_user.get("showroom_id") or "").strip()
    if not showroom_name:
        showroom_name = (current_user.get("showroom_name") or "").strip()

    # Hydrate the name from the showrooms collection if we have an id
    # but no human-readable name yet.
    if showroom_id and not showroom_name:
        try:
            from bson import ObjectId
            try:
                obj_id = ObjectId(showroom_id)
                doc = await db.showrooms.find_one({"_id": obj_id}, {"name": 1})
            except Exception:
                # Not a valid ObjectId — try string-id match instead.
                doc = await db.showrooms.find_one({"id": showroom_id}, {"name": 1})
            if doc and doc.get("name"):
                showroom_name = doc["name"].strip()
        except Exception:
            # bson missing or any DB blip — leave name empty; the
            # leaderboard's runtime resolver will pick it up.
            pass

    return {
        "created_by_user_id": (current_user.get("id") or "").strip(),
        "showroom_id": showroom_id,
        "showroom_name": showroom_name,
    }
