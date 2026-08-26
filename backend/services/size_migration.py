"""
One-shot size format migration: convert every product size to mm format.

"30x60cm" -> "300x600mm", "60x60x2cm" -> "600x600x20mm", "60x60" -> "600x600mm"
(unit-less values are treated as cm when plausibly cm-scale), "800 x 800mm" ->
"800x800mm". Values that don't look like tile dimensions (e.g. "1L", "5kg")
are left untouched. Flooring thickness fractions ("190x1900x14/3mm") pass
through with spacing normalised.

Runs once at startup (guarded by a migration flag) and is also exposed via
POST /api/website-admin/normalize-sizes-mm for dry-runs / manual re-runs.
Changed docs are backed up to db.size_migration_backup for rollback.
"""

import re
from datetime import datetime, timezone

MIGRATION_KEY = "sizes_mm_v1"

_DIM = r"(\d+(?:\.\d+)?)"
_THICK = r"(\d+(?:\.\d+)?(?:\s*/\s*\d+(?:\.\d+)?)?)"
_SIZE_RE = re.compile(
    rf"^\s*{_DIM}\s*[xX×]\s*{_DIM}(?:\s*[xX×]\s*{_THICK})?\s*(mm|cm)?\s*$",
    re.IGNORECASE,
)


def _fmt(n: float) -> str:
    return str(int(n)) if float(n) == int(n) else str(n)


def normalize_size_to_mm(value):
    """Return the size in compact mm format, or the input unchanged."""
    if not isinstance(value, str) or not value.strip():
        return value
    m = _SIZE_RE.match(value)
    if not m:
        return value
    a, b, thick, unit = m.group(1), m.group(2), m.group(3), (m.group(4) or "").lower()

    def to_mm(num_str):
        return _fmt(float(num_str) * 10)

    if unit == "cm":
        parts = [to_mm(a), to_mm(b)]
        if thick:
            if "/" in thick:
                # fractional thickness like 1.4/0.3 -> 14/3
                top, bottom = [t.strip() for t in thick.split("/", 1)]
                parts.append(f"{to_mm(top)}/{to_mm(bottom)}")
            else:
                parts.append(to_mm(thick))
        return "x".join(parts) + "mm"

    if unit == "mm":
        parts = [_fmt(float(a)), _fmt(float(b))]
        if thick:
            if "/" in thick:
                top, bottom = [t.strip() for t in thick.split("/", 1)]
                parts.append(f"{_fmt(float(top))}/{_fmt(float(bottom))}")
            else:
                parts.append(_fmt(float(thick)))
        return "x".join(parts) + "mm"

    # No unit: tile sizes quoted under 200 are cm (e.g. 60x60); larger are mm
    if max(float(a), float(b)) < 200:
        parts = [to_mm(a), to_mm(b)]
        if thick and "/" not in thick:
            parts.append(to_mm(thick))
        elif thick:
            top, bottom = [t.strip() for t in thick.split("/", 1)]
            parts.append(f"{to_mm(top)}/{to_mm(bottom)}")
        return "x".join(parts) + "mm"
    parts = [_fmt(float(a)), _fmt(float(b))]
    if thick:
        parts.append(thick.replace(" ", ""))
    return "x".join(parts) + "mm"


def _convert_doc(doc):
    """Return ({updates}, {backup}) for a product doc, or (None, None)."""
    updates, backup = {}, {}

    size = doc.get("size")
    new_size = normalize_size_to_mm(size)
    if new_size != size:
        updates["size"] = new_size
        backup["size"] = size

    attrs = doc.get("attributes") or {}
    if isinstance(attrs, dict):
        a_size = attrs.get("size")
        new_a = normalize_size_to_mm(a_size)
        if new_a != a_size:
            updates["attributes.size"] = new_a
            backup["attributes.size"] = a_size

    sizes = doc.get("sizes")
    if isinstance(sizes, list) and sizes:
        new_sizes = [normalize_size_to_mm(s) for s in sizes]
        if new_sizes != sizes:
            updates["sizes"] = new_sizes
            backup["sizes"] = sizes

    return (updates, backup) if updates else (None, None)


def run_size_migration(db, dry_run=False):
    """Normalize sizes to mm across supplier_products, tiles and products."""
    summary = {"dry_run": dry_run, "collections": {}, "examples": []}
    for coll_name in ("supplier_products", "tiles", "products"):
        coll = db[coll_name]
        changed = 0
        scanned = 0
        cursor = coll.find(
            {"$or": [
                {"size": {"$type": "string"}},
                {"attributes.size": {"$type": "string"}},
                {"sizes.0": {"$exists": True}},
            ]},
            {"size": 1, "attributes.size": 1, "sizes": 1},
        )
        for doc in cursor:
            scanned += 1
            updates, backup = _convert_doc(doc)
            if not updates:
                continue
            changed += 1
            if len(summary["examples"]) < 12:
                summary["examples"].append({
                    "collection": coll_name,
                    "before": backup,
                    "after": updates,
                })
            if not dry_run:
                db.size_migration_backup.update_one(
                    {"coll": coll_name, "doc_id": doc["_id"]},
                    {"$setOnInsert": {
                        "coll": coll_name, "doc_id": doc["_id"],
                        "backup": backup,
                        "migrated_at": datetime.now(timezone.utc).isoformat(),
                    }},
                    upsert=True,
                )
                coll.update_one({"_id": doc["_id"]}, {"$set": updates})
        summary["collections"][coll_name] = {"scanned": scanned, "changed": changed}

    if not dry_run:
        db.migration_flags.update_one(
            {"key": MIGRATION_KEY},
            {"$set": {"key": MIGRATION_KEY, "done_at": datetime.now(timezone.utc).isoformat(),
                      "summary": summary["collections"]}},
            upsert=True,
        )
    return summary


def run_size_migration_once(db):
    """Startup guard: run only if the migration flag isn't set yet."""
    if db.migration_flags.find_one({"key": MIGRATION_KEY}):
        return None
    return run_size_migration(db, dry_run=False)
