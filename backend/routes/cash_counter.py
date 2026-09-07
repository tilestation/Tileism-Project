"""
Cash Counter / End of Day Routes
Handles cash float, petty cash, banking, and EOD reports
"""
from fastapi import APIRouter, HTTPException, Depends, UploadFile, File
from pydantic import BaseModel, Field
from typing import Optional, List, Dict
from datetime import datetime, timezone, timedelta
from bson import ObjectId
import uuid
import os
import base64

from services.auth import get_current_user
from config import get_db

router = APIRouter(prefix="/cash", tags=["cash-counter"])

# ============== Models ==============

class CashSessionCreate(BaseModel):
    showroom_id: str
    opening_float: float
    staff_pin: str
    notes: Optional[str] = None

class CashSessionClose(BaseModel):
    actual_cash_counted: float
    staff_pin: str
    notes: Optional[str] = None
    denominations: Optional[Dict[str, int]] = None  # e.g., {"50": 2, "20": 5, "10": 3}

class PettyCashCreate(BaseModel):
    showroom_id: str
    amount: float
    category: str
    description: str
    staff_pin: str
    receipt_image: Optional[str] = None  # Base64 encoded image

class PettyCashCategoryCreate(BaseModel):
    name: str
    description: Optional[str] = None

class BankingCreate(BaseModel):
    showroom_id: str
    amount: float
    staff_pin: str
    notes: Optional[str] = None

class CashAdjustmentCreate(BaseModel):
    showroom_id: str
    amount: float  # Positive for cash in, negative for cash out
    reason: str
    staff_pin: str

# ============== Helper Functions ==============

async def verify_staff_pin(db, pin: str):
    """Verify staff PIN and return staff info"""
    staff = await db.staff_pins.find_one({"pin": pin, "is_active": True})
    if not staff:
        raise HTTPException(status_code=401, detail="Invalid staff PIN")
    return staff

async def get_active_session(db, showroom_id: str):
    """Get the active (open) cash session for a showroom"""
    session = await db.cash_sessions.find_one({
        "showroom_id": showroom_id,
        "status": "open"
    }, {"_id": 0})
    return session

async def calculate_expected_cash(db, showroom_id: str, session_id: str):
    """Calculate expected cash based on transactions during the session"""
    session = await db.cash_sessions.find_one({"id": session_id})
    if not session:
        return 0
    
    opening_float = session.get("opening_float", 0)
    session_date = session.get("opened_at")
    
    # Get cash sales from invoices
    cash_sales = 0
    invoices = await db.invoices.find({
        "showroom_id": showroom_id,
        "created_at": {"$gte": session_date},
        "payments": {"$elemMatch": {"method": {"$in": ["cash", "Cash"]}}}
    }).to_list(None)
    
    for inv in invoices:
        for payment in inv.get("payments", []):
            if payment.get("method", "").lower() == "cash":
                cash_sales += payment.get("amount", 0)
    
    # Get cash deposits
    cash_deposits = 0
    deposits = await db.invoices.find({
        "showroom_id": showroom_id,
        "created_at": {"$gte": session_date},
        "deposit_payments": {"$elemMatch": {"method": {"$in": ["cash", "Cash"]}}}
    }).to_list(None)
    
    for dep in deposits:
        for payment in dep.get("deposit_payments", []):
            if payment.get("method", "").lower() == "cash":
                cash_deposits += payment.get("amount", 0)
    
    # Get petty cash (outgoing)
    petty_cash_total = 0
    petty_cash = await db.petty_cash.find({
        "session_id": session_id
    }).to_list(None)
    for pc in petty_cash:
        petty_cash_total += pc.get("amount", 0)
    
    # Get banking (outgoing)
    banking_total = 0
    banking = await db.banking.find({
        "session_id": session_id
    }).to_list(None)
    for b in banking:
        banking_total += b.get("amount", 0)
    
    # Get adjustments
    adjustments_total = 0
    adjustments = await db.cash_adjustments.find({
        "session_id": session_id
    }).to_list(None)
    for adj in adjustments:
        adjustments_total += adj.get("amount", 0)
    
    expected = opening_float + cash_sales + cash_deposits - petty_cash_total - banking_total + adjustments_total
    
    return {
        "opening_float": opening_float,
        "cash_sales": cash_sales,
        "cash_deposits": cash_deposits,
        "petty_cash_total": petty_cash_total,
        "banking_total": banking_total,
        "adjustments_total": adjustments_total,
        "expected_cash": expected
    }

# ============== Cash Session Routes ==============

@router.post("/sessions/open")
async def open_cash_session(data: CashSessionCreate, current_user: dict = Depends(get_current_user)):
    """Open a new cash session (start of day)"""
    db = get_db()
    
    # Verify staff PIN
    staff = await verify_staff_pin(db, data.staff_pin)
    
    # Check if there's already an open session for this showroom
    existing = await get_active_session(db, data.showroom_id)
    if existing:
        raise HTTPException(status_code=400, detail="There is already an open cash session for this showroom. Please close it first.")
    
    # Get showroom name
    showroom = await db.showrooms.find_one({"id": data.showroom_id})
    showroom_name = showroom.get("name") if showroom else "Unknown"
    
    session_id = str(uuid.uuid4())
    now = datetime.now(timezone.utc)
    
    session = {
        "id": session_id,
        "showroom_id": data.showroom_id,
        "showroom_name": showroom_name,
        "opening_float": data.opening_float,
        "opened_by": staff.get("name"),
        "opened_by_pin": data.staff_pin,
        "opened_at": now,
        "status": "open",
        "notes": data.notes,
        "created_at": now
    }
    
    await db.cash_sessions.insert_one(session)
    
    return {"message": "Cash session opened successfully", "session": {**session, "_id": None}}

@router.post("/sessions/close")
async def close_cash_session(data: CashSessionClose, showroom_id: str, current_user: dict = Depends(get_current_user)):
    """Close the cash session (end of day cash up)"""
    db = get_db()
    
    # Verify staff PIN
    staff = await verify_staff_pin(db, data.staff_pin)
    
    # Get active session
    session = await get_active_session(db, showroom_id)
    if not session:
        raise HTTPException(status_code=404, detail="No open cash session found for this showroom")
    
    # Calculate expected cash
    expected = await calculate_expected_cash(db, showroom_id, session["id"])
    
    variance = data.actual_cash_counted - expected["expected_cash"]
    
    now = datetime.now(timezone.utc)
    
    # Update session
    update_data = {
        "status": "closed",
        "actual_cash_counted": data.actual_cash_counted,
        "expected_cash": expected["expected_cash"],
        "variance": variance,
        "closed_by": staff.get("name"),
        "closed_by_pin": data.staff_pin,
        "closed_at": now,
        "closing_notes": data.notes,
        "denominations": data.denominations,
        "breakdown": expected
    }
    
    await db.cash_sessions.update_one(
        {"id": session["id"]},
        {"$set": update_data}
    )
    
    # Create EOD report
    report = {
        "id": str(uuid.uuid4()),
        "session_id": session["id"],
        "showroom_id": showroom_id,
        "showroom_name": session.get("showroom_name"),
        "date": now.date().isoformat(),
        "opening_float": expected["opening_float"],
        "cash_sales": expected["cash_sales"],
        "cash_deposits": expected["cash_deposits"],
        "petty_cash_total": expected["petty_cash_total"],
        "banking_total": expected["banking_total"],
        "adjustments_total": expected["adjustments_total"],
        "expected_cash": expected["expected_cash"],
        "actual_cash": data.actual_cash_counted,
        "variance": variance,
        "opened_by": session.get("opened_by"),
        "closed_by": staff.get("name"),
        "created_at": now
    }
    
    await db.eod_reports.insert_one(report)
    
    return {
        "message": "Cash session closed successfully",
        "report": {**report, "_id": None}
    }

@router.get("/sessions/current/{showroom_id}")
async def get_current_session(showroom_id: str, current_user: dict = Depends(get_current_user)):
    """Get the current open session for a showroom"""
    db = get_db()
    
    session = await get_active_session(db, showroom_id)
    if not session:
        return {"session": None, "message": "No open session"}
    
    # Calculate current expected cash
    expected = await calculate_expected_cash(db, showroom_id, session["id"])
    
    # Get petty cash transactions
    petty_cash = await db.petty_cash.find({"session_id": session["id"]}).to_list(None)
    
    # Get banking transactions
    banking = await db.banking.find({"session_id": session["id"]}).to_list(None)
    
    # Get adjustments
    adjustments = await db.cash_adjustments.find({"session_id": session["id"]}).to_list(None)
    
    return {
        "session": {**session, "_id": None},
        "expected": expected,
        "petty_cash": [{**pc, "_id": None} for pc in petty_cash],
        "banking": [{**b, "_id": None} for b in banking],
        "adjustments": [{**a, "_id": None} for a in adjustments]
    }

@router.get("/sessions/history/{showroom_id}")
async def get_session_history(showroom_id: str, limit: int = 30, current_user: dict = Depends(get_current_user)):
    """Get historical cash sessions for a showroom"""
    db = get_db()
    
    sessions = await db.cash_sessions.find(
        {"showroom_id": showroom_id, "status": "closed"}
    ).sort("closed_at", -1).limit(limit).to_list(None)
    
    return [{**s, "_id": None} for s in sessions]

# ============== Petty Cash Routes ==============

@router.post("/petty-cash")
async def record_petty_cash(data: PettyCashCreate, current_user: dict = Depends(get_current_user)):
    """Record a petty cash transaction (paid out)"""
    db = get_db()
    
    # Verify staff PIN
    staff = await verify_staff_pin(db, data.staff_pin)
    
    # Get active session
    session = await get_active_session(db, data.showroom_id)
    if not session:
        raise HTTPException(status_code=400, detail="No open cash session. Please open a session first.")
    
    petty_cash_id = str(uuid.uuid4())
    now = datetime.now(timezone.utc)
    
    petty_cash = {
        "id": petty_cash_id,
        "session_id": session["id"],
        "showroom_id": data.showroom_id,
        "amount": data.amount,
        "category": data.category,
        "description": data.description,
        "recorded_by": staff.get("name"),
        "recorded_by_pin": data.staff_pin,
        "receipt_image": data.receipt_image,
        "created_at": now
    }
    
    await db.petty_cash.insert_one(petty_cash)
    
    return {"message": "Petty cash recorded", "petty_cash": {**petty_cash, "_id": None, "receipt_image": None}}

@router.get("/petty-cash/{showroom_id}")
async def get_petty_cash(showroom_id: str, session_id: Optional[str] = None, current_user: dict = Depends(get_current_user)):
    """Get petty cash transactions for a showroom"""
    db = get_db()
    
    query = {"showroom_id": showroom_id}
    if session_id:
        query["session_id"] = session_id
    
    transactions = await db.petty_cash.find(query).sort("created_at", -1).limit(100).to_list(None)
    
    return [{**t, "_id": None, "receipt_image": None} for t in transactions]

@router.get("/petty-cash/receipt/{petty_cash_id}")
async def get_petty_cash_receipt(petty_cash_id: str, current_user: dict = Depends(get_current_user)):
    """Get the receipt image for a petty cash transaction"""
    db = get_db()
    
    transaction = await db.petty_cash.find_one({"id": petty_cash_id})
    if not transaction:
        raise HTTPException(status_code=404, detail="Petty cash transaction not found")
    
    return {"receipt_image": transaction.get("receipt_image")}

# ============== Petty Cash Categories Routes ==============

@router.get("/petty-cash-categories")
async def get_petty_cash_categories(current_user: dict = Depends(get_current_user)):
    """Get all petty cash categories"""
    db = get_db()
    
    categories = await db.petty_cash_categories.find({}).to_list(None)
    
    # If no categories exist, create default ones
    if not categories:
        default_categories = [
            {"id": str(uuid.uuid4()), "name": "Cleaning Supplies", "description": "Cleaning products and materials"},
            {"id": str(uuid.uuid4()), "name": "Office Supplies", "description": "Stationery and office items"},
            {"id": str(uuid.uuid4()), "name": "Staff Meals/Refreshments", "description": "Food and drinks for staff"},
            {"id": str(uuid.uuid4()), "name": "Delivery/Courier Fees", "description": "Delivery and courier charges"},
            {"id": str(uuid.uuid4()), "name": "Parking", "description": "Parking fees"},
            {"id": str(uuid.uuid4()), "name": "Transportation", "description": "Travel and transport costs"},
            {"id": str(uuid.uuid4()), "name": "Repairs/Maintenance", "description": "Minor repairs and maintenance"},
            {"id": str(uuid.uuid4()), "name": "Miscellaneous", "description": "Other expenses"},
        ]
        await db.petty_cash_categories.insert_many(default_categories)
        categories = default_categories
    
    return [{**c, "_id": None} for c in categories]

@router.post("/petty-cash-categories")
async def create_petty_cash_category(data: PettyCashCategoryCreate, current_user: dict = Depends(get_current_user)):
    """Create a new petty cash category"""
    db = get_db()
    
    category = {
        "id": str(uuid.uuid4()),
        "name": data.name,
        "description": data.description,
        "created_at": datetime.now(timezone.utc)
    }
    
    await db.petty_cash_categories.insert_one(category)
    
    return {"message": "Category created", "category": {**category, "_id": None}}

@router.delete("/petty-cash-categories/{category_id}")
async def delete_petty_cash_category(category_id: str, current_user: dict = Depends(get_current_user)):
    """Delete a petty cash category"""
    db = get_db()
    
    result = await db.petty_cash_categories.delete_one({"id": category_id})
    
    if result.deleted_count == 0:
        raise HTTPException(status_code=404, detail="Category not found")
    
    return {"message": "Category deleted"}

# ============== Banking Routes ==============

@router.post("/banking")
async def record_banking(data: BankingCreate, current_user: dict = Depends(get_current_user)):
    """Record cash banked"""
    db = get_db()
    
    # Verify staff PIN
    staff = await verify_staff_pin(db, data.staff_pin)
    
    # Get active session
    session = await get_active_session(db, data.showroom_id)
    if not session:
        raise HTTPException(status_code=400, detail="No open cash session. Please open a session first.")
    
    banking_id = str(uuid.uuid4())
    now = datetime.now(timezone.utc)
    
    banking = {
        "id": banking_id,
        "session_id": session["id"],
        "showroom_id": data.showroom_id,
        "amount": data.amount,
        "recorded_by": staff.get("name"),
        "recorded_by_pin": data.staff_pin,
        "notes": data.notes,
        "created_at": now
    }
    
    await db.banking.insert_one(banking)
    
    return {"message": "Banking recorded", "banking": {**banking, "_id": None}}

@router.get("/banking/{showroom_id}")
async def get_banking(showroom_id: str, session_id: Optional[str] = None, current_user: dict = Depends(get_current_user)):
    """Get banking transactions for a showroom"""
    db = get_db()
    
    query = {"showroom_id": showroom_id}
    if session_id:
        query["session_id"] = session_id
    
    transactions = await db.banking.find(query).sort("created_at", -1).limit(100).to_list(None)
    
    return [{**t, "_id": None} for t in transactions]

# ============== Cash Adjustment Routes ==============

@router.post("/adjustments")
async def record_adjustment(data: CashAdjustmentCreate, current_user: dict = Depends(get_current_user)):
    """Record a cash adjustment (e.g., cash received from other sources)"""
    db = get_db()
    
    # Verify staff PIN
    staff = await verify_staff_pin(db, data.staff_pin)
    
    # Get active session
    session = await get_active_session(db, data.showroom_id)
    if not session:
        raise HTTPException(status_code=400, detail="No open cash session. Please open a session first.")
    
    adjustment_id = str(uuid.uuid4())
    now = datetime.now(timezone.utc)
    
    adjustment = {
        "id": adjustment_id,
        "session_id": session["id"],
        "showroom_id": data.showroom_id,
        "amount": data.amount,
        "reason": data.reason,
        "recorded_by": staff.get("name"),
        "recorded_by_pin": data.staff_pin,
        "created_at": now
    }
    
    await db.cash_adjustments.insert_one(adjustment)
    
    return {"message": "Adjustment recorded", "adjustment": {**adjustment, "_id": None}}

# ============== EOD Reports Routes ==============

@router.get("/eod-reports/{showroom_id}")
async def get_eod_reports(showroom_id: str, limit: int = 30, current_user: dict = Depends(get_current_user)):
    """Get EOD reports for a showroom"""
    db = get_db()
    
    reports = await db.eod_reports.find(
        {"showroom_id": showroom_id}
    ).sort("created_at", -1).limit(limit).to_list(None)
    
    return [{**r, "_id": None} for r in reports]

@router.get("/eod-reports/detail/{report_id}")
async def get_eod_report_detail(report_id: str, current_user: dict = Depends(get_current_user)):
    """Get detailed EOD report"""
    db = get_db()
    
    report = await db.eod_reports.find_one({"id": report_id})
    if not report:
        raise HTTPException(status_code=404, detail="Report not found")
    
    # Get associated petty cash
    petty_cash = await db.petty_cash.find({"session_id": report["session_id"]}).to_list(None)
    
    # Get associated banking
    banking = await db.banking.find({"session_id": report["session_id"]}).to_list(None)
    
    # Get associated adjustments
    adjustments = await db.cash_adjustments.find({"session_id": report["session_id"]}).to_list(None)
    
    return {
        "report": {**report, "_id": None},
        "petty_cash": [{**pc, "_id": None, "receipt_image": None} for pc in petty_cash],
        "banking": [{**b, "_id": None} for b in banking],
        "adjustments": [{**a, "_id": None} for a in adjustments]
    }
