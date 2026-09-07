"""
Tiles Info API - Spreadsheet-like tile product information management
"""
from fastapi import APIRouter, HTTPException, Depends
from pydantic import BaseModel, Field
from typing import List, Optional, Dict
from datetime import datetime, timezone
from uuid import uuid4

router = APIRouter(prefix="/tiles-info", tags=["tiles-info"])

# Models
class TileInfoEntry(BaseModel):
    id: str = Field(default_factory=lambda: str(uuid4()))
    original_name: str
    our_name: str
    online_name: Optional[str] = None
    price_on_ticket: Optional[str] = None
    finish: Optional[str] = None
    # Dynamic display columns - keyed by showroom_id
    display_locations: Dict[str, bool] = {}  # {"showroom_id": True/False}
    # Additional fields
    notes: Optional[str] = None
    supplier: Optional[str] = None
    category: Optional[str] = None
    created_at: str = Field(default_factory=lambda: datetime.now(timezone.utc).isoformat())
    updated_at: str = Field(default_factory=lambda: datetime.now(timezone.utc).isoformat())

class TileInfoCreate(BaseModel):
    original_name: str
    our_name: str
    online_name: Optional[str] = None
    price_on_ticket: Optional[str] = None
    finish: Optional[str] = None
    display_locations: Dict[str, bool] = {}
    notes: Optional[str] = None
    supplier: Optional[str] = None
    category: Optional[str] = None

class TileInfoUpdate(BaseModel):
    original_name: Optional[str] = None
    our_name: Optional[str] = None
    online_name: Optional[str] = None
    price_on_ticket: Optional[str] = None
    finish: Optional[str] = None
    display_locations: Optional[Dict[str, bool]] = None
    notes: Optional[str] = None
    supplier: Optional[str] = None
    category: Optional[str] = None

class TileInfoBulkUpdate(BaseModel):
    updates: List[Dict]  # List of {id, field, value}

class TileInfoBulkCreate(BaseModel):
    entries: List[TileInfoCreate]

# Dependency injection for db and user
async def get_db():
    from server import db
    return db

async def get_current_user():
    from server import get_current_user as _get_current_user
    return _get_current_user

# Helper to check admin access
def is_admin_user(user: dict) -> bool:
    return user.get("role") in ["admin", "super_admin", "manager", "staff"]


@router.get("")
async def get_tiles_info(
    search: Optional[str] = None,
    supplier: Optional[str] = None,
    category: Optional[str] = None,
    showroom_id: Optional[str] = None
):
    """Get all tiles info entries with optional filters"""
    from server import db, get_current_user, security
    
    query = {}
    
    if search:
        query["$or"] = [
            {"original_name": {"$regex": search, "$options": "i"}},
            {"our_name": {"$regex": search, "$options": "i"}},
            {"online_name": {"$regex": search, "$options": "i"}}
        ]
    
    if supplier:
        query["supplier"] = supplier
    
    if category:
        query["category"] = category
    
    if showroom_id:
        query[f"display_locations.{showroom_id}"] = True
    
    entries = await db.tiles_info.find(query, {"_id": 0}).to_list(10000)
    return entries


@router.post("")
async def create_tile_info(data: TileInfoCreate):
    """Create a new tile info entry"""
    from server import db
    
    entry = {
        "id": str(uuid4()),
        "original_name": data.original_name,
        "our_name": data.our_name,
        "online_name": data.online_name or "Same",
        "price_on_ticket": data.price_on_ticket,
        "finish": data.finish,
        "display_locations": data.display_locations,
        "notes": data.notes,
        "supplier": data.supplier,
        "category": data.category,
        "created_at": datetime.now(timezone.utc).isoformat(),
        "updated_at": datetime.now(timezone.utc).isoformat()
    }
    
    await db.tiles_info.insert_one(entry)
    # Return without _id
    entry.pop('_id', None)
    return entry


@router.post("/bulk")
async def bulk_create_tiles_info(data: TileInfoBulkCreate):
    """Bulk create tile info entries"""
    from server import db
    
    entries = []
    for item in data.entries:
        entry = {
            "id": str(uuid4()),
            "original_name": item.original_name,
            "our_name": item.our_name,
            "online_name": item.online_name or "Same",
            "price_on_ticket": item.price_on_ticket,
            "finish": item.finish,
            "display_locations": item.display_locations,
            "notes": item.notes,
            "supplier": item.supplier,
            "category": item.category,
            "created_at": datetime.now(timezone.utc).isoformat(),
            "updated_at": datetime.now(timezone.utc).isoformat()
        }
        entries.append(entry)
    
    if entries:
        await db.tiles_info.insert_many(entries)
        # Remove _id from all entries
        for entry in entries:
            entry.pop('_id', None)
    
    return {"created": len(entries), "entries": entries}


@router.put("/{entry_id}")
async def update_tile_info(entry_id: str, data: TileInfoUpdate):
    """Update a tile info entry"""
    from server import db
    
    existing = await db.tiles_info.find_one({"id": entry_id})
    if not existing:
        raise HTTPException(status_code=404, detail="Entry not found")
    
    update_data = {k: v for k, v in data.model_dump().items() if v is not None}
    update_data["updated_at"] = datetime.now(timezone.utc).isoformat()
    
    await db.tiles_info.update_one({"id": entry_id}, {"$set": update_data})
    
    updated = await db.tiles_info.find_one({"id": entry_id}, {"_id": 0})
    return updated


@router.patch("/bulk")
async def bulk_update_tiles_info(data: TileInfoBulkUpdate):
    """Bulk update tile info entries - for inline cell editing"""
    from server import db
    
    updated_count = 0
    for update in data.updates:
        entry_id = update.get("id")
        field = update.get("field")
        value = update.get("value")
        
        if not entry_id or not field:
            continue
        
        # Handle nested display_locations updates
        if field.startswith("display_"):
            showroom_id = field.replace("display_", "")
            await db.tiles_info.update_one(
                {"id": entry_id},
                {"$set": {
                    f"display_locations.{showroom_id}": value == "Yes" or value == True,
                    "updated_at": datetime.now(timezone.utc).isoformat()
                }}
            )
        else:
            await db.tiles_info.update_one(
                {"id": entry_id},
                {"$set": {
                    field: value,
                    "updated_at": datetime.now(timezone.utc).isoformat()
                }}
            )
        updated_count += 1
    
    return {"updated": updated_count}


@router.delete("/bulk")
async def bulk_delete_tiles_info(ids: List[str]):
    """Bulk delete tile info entries"""
    from server import db
    
    result = await db.tiles_info.delete_many({"id": {"$in": ids}})
    return {"deleted": result.deleted_count}


@router.delete("/{entry_id}")
async def delete_tile_info(entry_id: str):
    """Delete a tile info entry"""
    from server import db
    
    result = await db.tiles_info.delete_one({"id": entry_id})
    if result.deleted_count == 0:
        raise HTTPException(status_code=404, detail="Entry not found")
    
    return {"message": "Entry deleted"}


@router.get("/suppliers")
async def get_suppliers():
    """Get unique supplier names for filtering"""
    from server import db
    
    suppliers = await db.tiles_info.distinct("supplier")
    return [s for s in suppliers if s]


@router.get("/categories")
async def get_tile_categories():
    """Get unique category names for filtering"""
    from server import db
    
    categories = await db.tiles_info.distinct("category")
    return [c for c in categories if c]


@router.post("/import-csv")
async def import_csv(entries: List[dict]):
    """Import tiles info from CSV data"""
    from server import db
    
    imported = []
    for row in entries:
        entry = {
            "id": str(uuid4()),
            "original_name": row.get("original_name", row.get("Original Name", "")),
            "our_name": row.get("our_name", row.get("Our Name", "")),
            "online_name": row.get("online_name", row.get("Online Name", "Same")),
            "price_on_ticket": row.get("price_on_ticket", row.get("Price on Ticket", "")),
            "finish": row.get("finish", row.get("Finish", "")),
            "display_locations": {},
            "notes": row.get("notes", row.get("Notes", "")),
            "supplier": row.get("supplier", row.get("Supplier", "")),
            "category": row.get("category", row.get("Category", "")),
            "created_at": datetime.now(timezone.utc).isoformat(),
            "updated_at": datetime.now(timezone.utc).isoformat()
        }
        
        # Process display location columns (any column starting with "On Display")
        for key, value in row.items():
            if key.startswith("On Display") or key.startswith("display_"):
                # Extract showroom name from column header
                showroom_name = key.replace("On Display in ", "").replace("?", "").replace("display_", "")
                if value and str(value).lower() in ["yes", "true", "1"]:
                    entry["display_locations"][showroom_name] = True
        
        imported.append(entry)
    
    if imported:
        await db.tiles_info.insert_many(imported)
        # Remove _id from all entries
        for entry in imported:
            entry.pop('_id', None)
    
    return {"imported": len(imported)}
