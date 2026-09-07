"""
Trade List API - Manage builders trade accounts per showroom
"""
from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel, Field
from typing import List, Optional, Dict
from datetime import datetime, timezone
from uuid import uuid4

router = APIRouter(prefix="/trade-list", tags=["trade-list"])

# Models
class TradeAccountCreate(BaseModel):
    showroom_id: str
    date_registered: Optional[str] = None
    name: str
    company_name: Optional[str] = None
    address: Optional[str] = None
    contact_no: Optional[str] = None
    email: Optional[str] = None
    extra_info: Optional[str] = None
    extra_info_2: Optional[str] = None
    input_by: Optional[str] = None
    status: Optional[str] = "active"  # active, inactive, stopped_trading

class TradeAccountUpdate(BaseModel):
    date_registered: Optional[str] = None
    name: Optional[str] = None
    company_name: Optional[str] = None
    address: Optional[str] = None
    contact_no: Optional[str] = None
    email: Optional[str] = None
    extra_info: Optional[str] = None
    extra_info_2: Optional[str] = None
    input_by: Optional[str] = None
    status: Optional[str] = None

class TradeAccountBulkUpdate(BaseModel):
    updates: List[Dict]  # List of {id, field, value}


@router.get("")
async def get_trade_accounts(
    showroom_id: Optional[str] = None,
    search: Optional[str] = None,
    status: Optional[str] = None
):
    """Get all trade accounts, optionally filtered by showroom"""
    from server import db
    
    query = {}
    
    if showroom_id:
        query["showroom_id"] = showroom_id
    
    if status:
        query["status"] = status
    
    if search:
        query["$or"] = [
            {"name": {"$regex": search, "$options": "i"}},
            {"company_name": {"$regex": search, "$options": "i"}},
            {"email": {"$regex": search, "$options": "i"}},
            {"contact_no": {"$regex": search, "$options": "i"}}
        ]
    
    accounts = await db.trade_accounts.find(query, {"_id": 0}).sort("name", 1).to_list(10000)

    # Enrich with last WhatsApp sent timestamp
    account_ids = [a.get("id") for a in accounts if a.get("id")]
    if account_ids:
        pipeline = [
            {"$match": {"customer_id": {"$in": account_ids}, "status": "sent"}},
            {"$sort": {"sent_at": -1}},
            {"$group": {"_id": "$customer_id", "last_sent": {"$first": "$sent_at"}, "total_sent": {"$sum": 1}}},
        ]
        wa_stats = await db.whatsapp_queue.aggregate(pipeline).to_list(len(account_ids))
        wa_map = {s["_id"]: {"last_whatsapp_sent": s["last_sent"], "whatsapp_count": s["total_sent"]} for s in wa_stats}
        for account in accounts:
            wa_info = wa_map.get(account.get("id"), {})
            account["last_whatsapp_sent"] = wa_info.get("last_whatsapp_sent")
            account["whatsapp_count"] = wa_info.get("whatsapp_count", 0)

    return accounts


@router.get("/by-showroom/{showroom_id}")
async def get_trade_accounts_by_showroom(showroom_id: str, search: Optional[str] = None):
    """Get trade accounts for a specific showroom"""
    from server import db
    
    query = {"showroom_id": showroom_id}
    
    if search:
        query["$or"] = [
            {"name": {"$regex": search, "$options": "i"}},
            {"company_name": {"$regex": search, "$options": "i"}},
            {"email": {"$regex": search, "$options": "i"}},
            {"contact_no": {"$regex": search, "$options": "i"}}
        ]
    
    accounts = await db.trade_accounts.find(query, {"_id": 0}).sort("name", 1).to_list(10000)
    return accounts


@router.post("")
async def create_trade_account(data: TradeAccountCreate):
    """Create a new trade account"""
    from server import db
    
    entry = {
        "id": str(uuid4()),
        "showroom_id": data.showroom_id,
        "date_registered": data.date_registered or datetime.now(timezone.utc).strftime("%Y-%m-%d"),
        "name": data.name,
        "company_name": data.company_name or "",
        "address": data.address or "",
        "contact_no": data.contact_no or "",
        "email": data.email or "",
        "extra_info": data.extra_info or "",
        "extra_info_2": data.extra_info_2 or "",
        "input_by": data.input_by or "",
        "status": data.status or "active",
        "created_at": datetime.now(timezone.utc).isoformat(),
        "updated_at": datetime.now(timezone.utc).isoformat()
    }
    
    await db.trade_accounts.insert_one(entry)
    entry.pop('_id', None)
    return entry


@router.post("/bulk")
async def bulk_create_trade_accounts(accounts: List[TradeAccountCreate]):
    """Bulk create trade accounts"""
    from server import db
    
    entries = []
    for data in accounts:
        entry = {
            "id": str(uuid4()),
            "showroom_id": data.showroom_id,
            "date_registered": data.date_registered or datetime.now(timezone.utc).strftime("%Y-%m-%d"),
            "name": data.name,
            "company_name": data.company_name or "",
            "address": data.address or "",
            "contact_no": data.contact_no or "",
            "email": data.email or "",
            "extra_info": data.extra_info or "",
            "extra_info_2": data.extra_info_2 or "",
            "input_by": data.input_by or "",
            "status": data.status or "active",
            "created_at": datetime.now(timezone.utc).isoformat(),
            "updated_at": datetime.now(timezone.utc).isoformat()
        }
        entries.append(entry)
    
    if entries:
        await db.trade_accounts.insert_many(entries)
        for entry in entries:
            entry.pop('_id', None)
    
    return {"created": len(entries), "entries": entries}


@router.put("/{account_id}")
async def update_trade_account(account_id: str, data: TradeAccountUpdate):
    """Update a trade account"""
    from server import db
    
    existing = await db.trade_accounts.find_one({"id": account_id})
    if not existing:
        raise HTTPException(status_code=404, detail="Trade account not found")
    
    update_data = {k: v for k, v in data.model_dump().items() if v is not None}
    update_data["updated_at"] = datetime.now(timezone.utc).isoformat()
    
    await db.trade_accounts.update_one({"id": account_id}, {"$set": update_data})
    
    updated = await db.trade_accounts.find_one({"id": account_id}, {"_id": 0})
    return updated


@router.patch("/bulk")
async def bulk_update_trade_accounts(data: TradeAccountBulkUpdate):
    """Bulk update trade accounts - for inline cell editing"""
    from server import db
    
    updated_count = 0
    for update in data.updates:
        entry_id = update.get("id")
        field = update.get("field")
        value = update.get("value")
        
        if not entry_id or not field:
            continue
        
        await db.trade_accounts.update_one(
            {"id": entry_id},
            {"$set": {
                field: value,
                "updated_at": datetime.now(timezone.utc).isoformat()
            }}
        )
        updated_count += 1
    
    return {"updated": updated_count}


@router.delete("/bulk")
async def bulk_delete_trade_accounts(ids: List[str]):
    """Bulk delete trade accounts"""
    from server import db
    
    result = await db.trade_accounts.delete_many({"id": {"$in": ids}})
    return {"deleted": result.deleted_count}


@router.delete("/{account_id}")
async def delete_trade_account(account_id: str):
    """Delete a trade account"""
    from server import db
    
    result = await db.trade_accounts.delete_one({"id": account_id})
    if result.deleted_count == 0:
        raise HTTPException(status_code=404, detail="Trade account not found")
    
    return {"message": "Trade account deleted"}


@router.post("/import")
async def import_trade_accounts(showroom_id: str, accounts: List[dict]):
    """Import trade accounts from spreadsheet data"""
    from server import db
    
    imported = []
    for row in accounts:
        entry = {
            "id": str(uuid4()),
            "showroom_id": showroom_id,
            "date_registered": row.get("date_registered", row.get("Date Registered", "")),
            "name": row.get("name", row.get("NAME", row.get("Name", ""))),
            "company_name": row.get("company_name", row.get("COMPANY NAME", row.get("Company Name", ""))),
            "address": row.get("address", row.get("ADDRESS", row.get("Address", ""))),
            "contact_no": row.get("contact_no", row.get("CONTACT NO", row.get("Contact No", ""))),
            "email": row.get("email", row.get("EMAIL", row.get("Email", ""))),
            "extra_info": row.get("extra_info", row.get("ETXRA INFO", row.get("Extra Info", ""))),
            "extra_info_2": row.get("extra_info_2", row.get("ETXRA INFO 2", row.get("Extra Info 2", ""))),
            "input_by": row.get("input_by", row.get("Input By", "")),
            "status": row.get("status", "active"),
            "created_at": datetime.now(timezone.utc).isoformat(),
            "updated_at": datetime.now(timezone.utc).isoformat()
        }
        
        # Only import if name is not empty
        if entry["name"]:
            imported.append(entry)
    
    if imported:
        await db.trade_accounts.insert_many(imported)
        for entry in imported:
            entry.pop('_id', None)
    
    return {"imported": len(imported)}


@router.get("/stats")
async def get_trade_accounts_stats():
    """Get statistics for trade accounts by showroom"""
    from server import db
    
    pipeline = [
        {
            "$group": {
                "_id": "$showroom_id",
                "total": {"$sum": 1},
                "active": {
                    "$sum": {"$cond": [{"$eq": ["$status", "active"]}, 1, 0]}
                }
            }
        }
    ]
    
    stats = await db.trade_accounts.aggregate(pipeline).to_list(100)
    return stats
