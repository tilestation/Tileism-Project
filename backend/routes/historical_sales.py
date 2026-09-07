"""
Historical Sales Data Routes
Manages daily/weekly/monthly/yearly sales records per showroom
"""
from fastapi import APIRouter, HTTPException, Depends
from pydantic import BaseModel
from typing import Optional, List
from datetime import datetime, timedelta, timezone
from bson import ObjectId
import os
import uuid

router = APIRouter(prefix="/historical-sales", tags=["Historical Sales"])

# Database connection
from motor.motor_asyncio import AsyncIOMotorClient

MONGO_URL = os.environ.get("MONGO_URL")
if not MONGO_URL:
    raise ValueError("MONGO_URL environment variable is required")
DB_NAME = os.environ.get("DB_NAME", "tile_station")

client = AsyncIOMotorClient(MONGO_URL)
db = client[DB_NAME]

# Auth dependency
from .auth import get_current_user

# ============================================
# MANUAL MONTHLY REVENUE ENTRY (NEW FEATURE)
# ============================================

class ManualMonthlyRevenueCreate(BaseModel):
    showroom_id: str
    month: int  # 1-12
    year: int
    revenue: float
    visible_to_showroom: bool = True
    notes: Optional[str] = None

class ManualMonthlyRevenueUpdate(BaseModel):
    revenue: Optional[float] = None
    visible_to_showroom: Optional[bool] = None
    notes: Optional[str] = None


@router.post("/manual-entry")
async def create_manual_revenue_entry(
    data: ManualMonthlyRevenueCreate,
    current_user: dict = Depends(get_current_user)
):
    """Create or update a manual monthly revenue entry for a showroom (Super Admin only)"""
    if current_user.get("role") != "super_admin":
        raise HTTPException(status_code=403, detail="Only Super Admin can add manual revenue entries")
    
    # Check if entry already exists for this showroom/month/year
    existing = await db.manual_monthly_revenue.find_one({
        "showroom_id": data.showroom_id,
        "month": data.month,
        "year": data.year
    })
    
    if existing:
        # Update existing entry
        await db.manual_monthly_revenue.update_one(
            {"_id": existing["_id"]},
            {"$set": {
                "revenue": data.revenue,
                "visible_to_showroom": data.visible_to_showroom,
                "notes": data.notes,
                "updated_at": datetime.now(timezone.utc),
                "updated_by": current_user.get("email")
            }}
        )
        return {"message": "Revenue entry updated", "id": existing.get("id")}
    
    # Create new entry
    entry = {
        "id": str(uuid.uuid4()),
        "showroom_id": data.showroom_id,
        "month": data.month,
        "year": data.year,
        "revenue": data.revenue,
        "visible_to_showroom": data.visible_to_showroom,
        "notes": data.notes,
        "created_at": datetime.now(timezone.utc),
        "created_by": current_user.get("email"),
        "updated_at": datetime.now(timezone.utc),
        "updated_by": current_user.get("email")
    }
    
    await db.manual_monthly_revenue.insert_one(entry)
    entry.pop("_id", None)
    
    return {"message": "Revenue entry created", "id": entry["id"], "entry": entry}


@router.get("/manual-entries")
async def get_manual_revenue_entries(
    showroom_id: Optional[str] = None,
    month: Optional[int] = None,
    year: Optional[int] = None,
    current_user: dict = Depends(get_current_user)
):
    """Get manual revenue entries (filtered by showroom/month/year)"""
    is_super_admin = current_user.get("role") == "super_admin"
    user_showroom_id = current_user.get("showroom_id")
    
    query = {}
    
    # If not super admin, only show visible entries for their showroom
    if not is_super_admin:
        query["visible_to_showroom"] = True
        if user_showroom_id:
            query["showroom_id"] = user_showroom_id
    else:
        if showroom_id:
            query["showroom_id"] = showroom_id
    
    if month:
        query["month"] = month
    if year:
        query["year"] = year
    
    entries = await db.manual_monthly_revenue.find(query, {"_id": 0}).sort([("year", -1), ("month", -1)]).to_list(500)
    
    # Add showroom names — guard against legacy showroom docs that lack an `id`
    # field (2 "coming soon" records in production don't have it), which used to
    # crash this endpoint with KeyError: 'id' and return a 500 to the admin UI.
    showrooms = await db.showrooms.find({}, {"_id": 0, "id": 1, "name": 1}).to_list(100)
    showroom_map = {s["id"]: s.get("name", "Unknown") for s in showrooms if s.get("id")}
    
    for entry in entries:
        entry["showroom_name"] = showroom_map.get(entry.get("showroom_id"), "Unknown")
    
    return entries


@router.put("/manual-entry/{entry_id}")
async def update_manual_revenue_entry(
    entry_id: str,
    data: ManualMonthlyRevenueUpdate,
    current_user: dict = Depends(get_current_user)
):
    """Update a manual revenue entry (Super Admin only)"""
    if current_user.get("role") != "super_admin":
        raise HTTPException(status_code=403, detail="Only Super Admin can update revenue entries")
    
    existing = await db.manual_monthly_revenue.find_one({"id": entry_id})
    if not existing:
        raise HTTPException(status_code=404, detail="Entry not found")
    
    update_data = {"updated_at": datetime.now(timezone.utc), "updated_by": current_user.get("email")}
    if data.revenue is not None:
        update_data["revenue"] = data.revenue
    if data.visible_to_showroom is not None:
        update_data["visible_to_showroom"] = data.visible_to_showroom
    if data.notes is not None:
        update_data["notes"] = data.notes
    
    await db.manual_monthly_revenue.update_one({"id": entry_id}, {"$set": update_data})
    
    return {"message": "Entry updated"}


@router.patch("/manual-entry/{entry_id}/visibility")
async def toggle_visibility(
    entry_id: str,
    current_user: dict = Depends(get_current_user)
):
    """Toggle visibility of a manual revenue entry (Super Admin only)"""
    if current_user.get("role") != "super_admin":
        raise HTTPException(status_code=403, detail="Only Super Admin can toggle visibility")
    
    existing = await db.manual_monthly_revenue.find_one({"id": entry_id})
    if not existing:
        raise HTTPException(status_code=404, detail="Entry not found")
    
    new_visibility = not existing.get("visible_to_showroom", True)
    
    await db.manual_monthly_revenue.update_one(
        {"id": entry_id},
        {"$set": {
            "visible_to_showroom": new_visibility,
            "updated_at": datetime.now(timezone.utc),
            "updated_by": current_user.get("email")
        }}
    )
    
    return {"message": f"Visibility set to {new_visibility}", "visible_to_showroom": new_visibility}


@router.delete("/manual-entry/{entry_id}")
async def delete_manual_revenue_entry(
    entry_id: str,
    current_user: dict = Depends(get_current_user)
):
    """Delete a manual revenue entry (Super Admin only)"""
    if current_user.get("role") != "super_admin":
        raise HTTPException(status_code=403, detail="Only Super Admin can delete revenue entries")
    
    result = await db.manual_monthly_revenue.delete_one({"id": entry_id})
    if result.deleted_count == 0:
        raise HTTPException(status_code=404, detail="Entry not found")
    
    return {"message": "Entry deleted"}


# ============================================
# ORIGINAL BULK IMPORT ENDPOINTS (UNCHANGED)
# ============================================

# Pydantic Models
class DailySaleRecord(BaseModel):
    date: str  # DD/MM/YYYY format
    day_of_week: str
    cash_sale: float = 0
    card_sale: float = 0
    bank_transfer: float = 0
    cash_refund: float = 0
    card_refund: float = 0
    bank_refund: float = 0
    total_daily_sale: float = 0
    showroom_id: str
    showroom_name: Optional[str] = None

class MonthlySummary(BaseModel):
    month: int
    year: int
    total_cash: float = 0
    total_card: float = 0
    total_bank: float = 0
    total_refunds: float = 0
    total_sales: float = 0
    showroom_id: str
    showroom_name: Optional[str] = None

class BulkImportRequest(BaseModel):
    showroom_id: str
    showroom_name: str
    records: List[dict]

# Helper to convert ObjectId
def serialize_doc(doc):
    if doc:
        doc["id"] = str(doc.pop("_id"))
    return doc


@router.post("/import")
async def import_sales_data(request: BulkImportRequest):
    """Bulk import historical sales data for a showroom"""
    try:
        # Prepare records
        records_to_insert = []
        for record in request.records:
            doc = {
                "date": record.get("date"),
                "day_of_week": record.get("day_of_week"),
                "cash_sale": float(record.get("cash_sale", 0) or 0),
                "card_sale": float(record.get("card_sale", 0) or 0),
                "bank_transfer": float(record.get("bank_transfer", 0) or 0),
                "cash_refund": float(record.get("cash_refund", 0) or 0),
                "card_refund": float(record.get("card_refund", 0) or 0),
                "bank_refund": float(record.get("bank_refund", 0) or 0),
                "total_daily_sale": float(record.get("total_daily_sale", 0) or 0),
                "showroom_id": request.showroom_id,
                "showroom_name": request.showroom_name,
                "created_at": datetime.utcnow()
            }
            records_to_insert.append(doc)
        
        if records_to_insert:
            # Delete existing records for this showroom first
            await db.historical_sales.delete_many({"showroom_id": request.showroom_id})
            # Insert new records
            result = await db.historical_sales.insert_many(records_to_insert)
            return {
                "message": f"Successfully imported {len(result.inserted_ids)} records",
                "count": len(result.inserted_ids)
            }
        
        return {"message": "No records to import", "count": 0}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/summary/{showroom_id}")
async def get_sales_summary(showroom_id: str):
    """Get sales summary for a showroom (daily, weekly, monthly, yearly)"""
    try:
        # Get all records for this showroom
        records = await db.historical_sales.find({"showroom_id": showroom_id}).to_list(1000)
        
        if not records:
            return {
                "showroom_id": showroom_id,
                "today": 0,
                "yesterday": 0,
                "this_week": 0,
                "last_week": 0,
                "this_month": 0,
                "last_month": 0,
                "this_year": 0,
                "last_year": 0,
                "monthly_data": [],
                "has_data": False
            }
        
        # Parse dates and organize data
        today = datetime.now()
        
        # Calculate totals
        monthly_totals = {}
        yearly_totals = {}
        
        for record in records:
            try:
                # Parse date (DD/MM/YYYY format)
                date_str = record.get("date", "")
                if not date_str:
                    continue
                    
                parts = date_str.split("/")
                if len(parts) == 3:
                    day, month, year = int(parts[0]), int(parts[1]), int(parts[2])
                    record_date = datetime(year, month, day)
                else:
                    continue
                
                total = float(record.get("total_daily_sale", 0) or 0)
                
                # Monthly aggregation
                month_key = f"{year}-{month:02d}"
                if month_key not in monthly_totals:
                    monthly_totals[month_key] = {
                        "year": year,
                        "month": month,
                        "total": 0,
                        "cash": 0,
                        "card": 0,
                        "bank": 0,
                        "refunds": 0,
                        "days": 0
                    }
                monthly_totals[month_key]["total"] += total
                monthly_totals[month_key]["cash"] += float(record.get("cash_sale", 0) or 0)
                monthly_totals[month_key]["card"] += float(record.get("card_sale", 0) or 0)
                monthly_totals[month_key]["bank"] += float(record.get("bank_transfer", 0) or 0)
                monthly_totals[month_key]["refunds"] += (
                    float(record.get("cash_refund", 0) or 0) +
                    float(record.get("card_refund", 0) or 0) +
                    float(record.get("bank_refund", 0) or 0)
                )
                monthly_totals[month_key]["days"] += 1
                
                # Yearly aggregation
                if year not in yearly_totals:
                    yearly_totals[year] = 0
                yearly_totals[year] += total
                
            except Exception as e:
                continue
        
        # Sort monthly data
        sorted_months = sorted(monthly_totals.items(), key=lambda x: x[0], reverse=True)
        monthly_data = [
            {
                "month": v["month"],
                "year": v["year"],
                "month_name": datetime(v["year"], v["month"], 1).strftime("%B"),
                "total": round(v["total"], 2),
                "cash": round(v["cash"], 2),
                "card": round(v["card"], 2),
                "bank": round(v["bank"], 2),
                "refunds": round(v["refunds"], 2),
                "days": v["days"],
                "daily_avg": round(v["total"] / v["days"], 2) if v["days"] > 0 else 0
            }
            for k, v in sorted_months
        ]
        
        # Calculate period totals
        current_month = today.month
        current_year = today.year
        last_month = current_month - 1 if current_month > 1 else 12
        last_month_year = current_year if current_month > 1 else current_year - 1
        
        this_month_key = f"{current_year}-{current_month:02d}"
        last_month_key = f"{last_month_year}-{last_month:02d}"
        
        this_month_total = monthly_totals.get(this_month_key, {}).get("total", 0)
        last_month_total = monthly_totals.get(last_month_key, {}).get("total", 0)
        
        this_year_total = yearly_totals.get(current_year, 0)
        last_year_total = yearly_totals.get(current_year - 1, 0)
        
        return {
            "showroom_id": showroom_id,
            "this_month": round(this_month_total, 2),
            "last_month": round(last_month_total, 2),
            "this_year": round(this_year_total, 2),
            "last_year": round(last_year_total, 2),
            "monthly_data": monthly_data[:12],  # Last 12 months
            "yearly_data": [
                {"year": year, "total": round(total, 2)}
                for year, total in sorted(yearly_totals.items(), reverse=True)
            ],
            "has_data": True
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/comparison")
async def get_all_showrooms_comparison():
    """Get sales comparison across all showrooms"""
    try:
        # Get all showrooms - use 'id' field, not '_id'
        showrooms = await db.showrooms.find({}, {"_id": 0}).to_list(100)
        
        comparisons = []
        for showroom in showrooms:
            showroom_id = showroom.get("id")  # Use 'id' not '_id'
            showroom_name = showroom.get("name", "Unknown")
            
            if not showroom_id:
                continue
            
            # Get summary for this showroom
            summary = await get_sales_summary(showroom_id)
            
            comparisons.append({
                "showroom_id": showroom_id,
                "showroom_name": showroom_name,
                "this_month": summary.get("this_month", 0),
                "last_month": summary.get("last_month", 0),
                "this_year": summary.get("this_year", 0),
                "last_year": summary.get("last_year", 0),
                "monthly_data": summary.get("monthly_data", [])[:6],  # Last 6 months
                "has_data": summary.get("has_data", False)
            })
        
        return comparisons
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/daily/{showroom_id}")
async def get_daily_records(showroom_id: str, month: Optional[int] = None, year: Optional[int] = None):
    """Get daily sales records for a showroom"""
    try:
        query = {"showroom_id": showroom_id}
        
        records = await db.historical_sales.find(query, {"_id": 0}).sort("date", -1).to_list(400)
        
        # Filter by month/year if provided
        if month and year:
            filtered = []
            for r in records:
                try:
                    date_str = r.get("date", "")
                    parts = date_str.split("/")
                    if len(parts) == 3:
                        d, m, y = int(parts[0]), int(parts[1]), int(parts[2])
                        if m == month and y == year:
                            filtered.append(r)
                except Exception:
                    continue
            return filtered
        
        return records
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.delete("/{showroom_id}")
async def delete_showroom_sales_data(showroom_id: str):
    """Delete all historical sales data for a showroom"""
    try:
        result = await db.historical_sales.delete_many({"showroom_id": showroom_id})
        return {"message": f"Deleted {result.deleted_count} records"}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
