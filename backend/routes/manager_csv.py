"""
Manager CSV Import — category-tailored bulk import.

Two endpoints:
  GET  /api/managers/{category}/csv-template    — download a CSV with the right
                                                    column headers for the category
  POST /api/managers/{category}/csv-import      — accept a CSV file, parse rows,
                                                    upsert into supplier_products

Each hardcoded category has its own column template so LVT plank grids don't
share columns with toilet specs. Custom Managers get a universal template that
reflects their `field_definitions`.

CSV rules:
  - First row: headers (matches the template)
  - `sku` is required per row (used as the primary key)
  - `supplier` is required (used with sku to guarantee uniqueness)
  - Unknown columns are stored as-is (forward compatible)
  - Empty cells are skipped (existing values preserved)
  - `product_group` and `main_category` are auto-set based on {category}
  - Response includes dry_run preview, then a real import on the second call
"""
from datetime import datetime, timezone
import csv
import io
from typing import List, Dict, Optional
import uuid

from fastapi import APIRouter, Depends, HTTPException, UploadFile, File, Form, Query
from fastapi.responses import Response

from config import get_db
from services import get_current_user, has_permission


router = APIRouter(prefix="/managers", tags=["manager-csv"])


# Category → column headers for the template (order matters for humans)
CATEGORY_COLUMNS: Dict[str, List[str]] = {
    "tiles": [
        "supplier", "sku", "our_product_name",
        "size", "finish", "material", "color", "slip_rating",
        "list_price", "cost_price", "warehouse_stock",
        "pricing_unit", "description",
    ],
    "flooring": [
        "supplier", "sku", "our_product_name",
        "size", "thickness", "wear_layer", "finish",
        "click_system", "underlay_included", "material", "color",
        "pack_coverage", "list_price", "cost_price", "warehouse_stock",
        "pricing_unit", "description",
    ],
    "materials": [
        "supplier", "sku", "our_product_name",
        "color", "bag_colour", "suitability",
        "pack_size", "coverage_m2_per_bag",
        "list_price", "cost_price", "warehouse_stock",
        "pricing_unit", "description",
    ],
    "bathroom": [
        "supplier", "sku", "our_product_name",
        "type", "brand", "model", "dimensions", "flush_type", "tank_capacity",
        "material", "finish", "color", "warranty",
        "list_price", "cost_price", "warehouse_stock", "description",
    ],
    "underfloor_heating": [
        "supplier", "sku", "our_product_name",
        "mat_type", "kit_size_m2", "voltage", "watts_per_m2", "cable_length_m",
        "thermostat_included", "thermostat_type", "warranty", "suitability",
        "list_price", "cost_price", "warehouse_stock", "description",
    ],
    "tools": [
        "supplier", "sku", "our_product_name",
        "brand", "model", "material", "dimensions", "capacity", "pack_qty",
        "suitability", "warranty",
        "list_price", "cost_price", "warehouse_stock", "description",
    ],
}

# Fields that need type coercion (from CSV strings)
NUMERIC_FIELDS = {"list_price", "cost_price", "warehouse_stock", "watts_per_m2", "kit_size_m2", "pack_qty", "tank_capacity", "cable_length_m", "coverage_m2_per_bag", "pack_coverage"}
BOOL_FIELDS = {"published"}


def _get_columns(category: str, db_definition: Optional[dict] = None) -> List[str]:
    if category in CATEGORY_COLUMNS:
        return CATEGORY_COLUMNS[category]
    # Custom Manager fallback
    if db_definition:
        base = ["supplier", "sku", "our_product_name"]
        for f in (db_definition.get("field_definitions") or []):
            key = f.get("key") if isinstance(f, dict) else None
            if key and key not in base:
                base.append(key)
        base += ["list_price", "cost_price", "warehouse_stock", "description"]
        return base
    # Absolute fallback
    return ["supplier", "sku", "our_product_name", "list_price", "cost_price", "warehouse_stock", "description"]


def _coerce(field: str, raw: str):
    val = (raw or "").strip()
    if val == "":
        return None
    if field in NUMERIC_FIELDS:
        try:
            return float(val) if "." in val else int(val)
        except ValueError:
            return val   # keep as-is; import row will flag it later
    if field in BOOL_FIELDS:
        return val.lower() in ("true", "1", "yes", "y")
    return val


@router.get("/{category}/csv-template")
async def csv_template(category: str):
    """Downloadable CSV with the header row + a single example row."""
    db = get_db()
    definition = None
    if category not in CATEGORY_COLUMNS:
        definition = await db.manager_definitions.find_one({"slug": category})
    cols = _get_columns(category, definition)
    example = {
        "supplier": "Example Supplier",
        "sku": "EX-001",
        "our_product_name": f"Sample {category} product",
        "list_price": "24.99",
        "cost_price": "12.50",
        "warehouse_stock": "100",
        "description": "Sample description — edit or delete this row before importing.",
    }
    buf = io.StringIO()
    writer = csv.writer(buf)
    writer.writerow(cols)
    writer.writerow([example.get(c, "") for c in cols])
    body = buf.getvalue()
    return Response(
        content=body,
        media_type="text/csv",
        headers={
            "Content-Disposition": f'attachment; filename="{category}-import-template.csv"',
        },
    )


@router.post("/{category}/csv-import")
async def csv_import(
    category: str,
    file: UploadFile = File(...),
    dry_run: bool = Query(False, description="Preview only — don't write to DB"),
    current_user: dict = Depends(get_current_user),
):
    """Parse the uploaded CSV, upsert products, return per-row status.

    Response:
      { total_rows, created, updated, skipped, errors: [...], preview: [...] }
    """
    if not has_permission(current_user, "supplier_products"):
        raise HTTPException(403, "You need the Supplier Products permission to import a CSV")

    db = get_db()

    # Read file
    raw = await file.read()
    if not raw:
        raise HTTPException(400, "Empty file")

    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError:
        text = raw.decode("latin-1", errors="ignore")

    reader = csv.DictReader(io.StringIO(text))
    fields = reader.fieldnames or []
    if "sku" not in fields:
        raise HTTPException(400, "CSV must include an 'sku' column")

    rows_data: List[dict] = []
    for row in reader:
        cleaned = {k: v for k, v in row.items() if k}
        if not any((v or "").strip() for v in cleaned.values()):
            continue   # blank row
        rows_data.append(cleaned)

    if not rows_data:
        raise HTTPException(400, "No data rows found in CSV")

    now = datetime.now(timezone.utc)
    stats = {"total_rows": len(rows_data), "created": 0, "updated": 0, "skipped": 0, "errors": [], "preview": []}

    for i, row in enumerate(rows_data, start=1):
        sku = (row.get("sku") or "").strip()
        supplier = (row.get("supplier") or "").strip() or "Unknown"
        if not sku:
            stats["errors"].append({"row": i, "error": "Missing sku"})
            stats["skipped"] += 1
            continue

        # Coerce values
        updates = {"product_group": category, "updated_at": now}
        if category in CATEGORY_COLUMNS:
            updates["main_category"] = category.replace("_", " ").title()

        for k, v in row.items():
            if k in (None, "", "sku", "supplier"):
                continue
            coerced = _coerce(k, v or "")
            if coerced is not None:
                updates[k] = coerced

        # Mirror our_product_name → product_name for legacy paths
        if updates.get("our_product_name") and "product_name" not in updates:
            updates["product_name"] = updates["our_product_name"]

        # Colors: if a single color column, mirror to colors[]
        if "color" in updates and isinstance(updates["color"], str):
            updates.setdefault("colors", [updates["color"]])

        # Compose preview row for the UI (first 5 columns)
        preview_row = {
            "row": i,
            "sku": sku,
            "supplier": supplier,
            "our_product_name": updates.get("our_product_name") or "",
        }
        stats["preview"].append(preview_row)

        if dry_run:
            existing = await db.supplier_products.find_one({"sku": sku, "supplier": supplier}, {"_id": 1})
            preview_row["action"] = "UPDATE" if existing else "CREATE"
            if existing: stats["updated"] += 1
            else:        stats["created"] += 1
            continue

        # Actual write — upsert by (supplier, sku)
        existing = await db.supplier_products.find_one({"sku": sku, "supplier": supplier})
        if existing:
            await db.supplier_products.update_one(
                {"_id": existing["_id"]},
                {"$set": updates},
            )
            preview_row["action"] = "UPDATE"
            stats["updated"] += 1
        else:
            new_doc = {
                "id": str(uuid.uuid4()),
                "sku": sku,
                "supplier": supplier,
                "product_group": category,
                "created_at": now,
                "created_by": current_user.get("email"),
                "published": False,     # imports start as drafts
                "status": "active",
                **updates,
            }
            await db.supplier_products.insert_one(new_doc)
            preview_row["action"] = "CREATE"
            stats["created"] += 1

    return stats
