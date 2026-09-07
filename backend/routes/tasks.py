"""
Tasks and Notes management routes
"""
import uuid
from datetime import datetime, timezone
from typing import Optional, List
from fastapi import APIRouter, HTTPException, Depends
from pydantic import BaseModel

from config import get_db
from services import get_current_user, is_admin_user, log_audit

router = APIRouter(prefix="/tasks", tags=["Tasks"])


# ============ MODELS ============

class TaskCreate(BaseModel):
    title: str
    description: Optional[str] = None
    priority: str = "medium"  # low, medium, high, urgent
    due_date: Optional[str] = None
    assigned_to: Optional[str] = None  # user email
    assigned_to_name: Optional[str] = None
    showroom_id: Optional[str] = None
    showroom_name: Optional[str] = None
    category: Optional[str] = None  # general, follow-up, delivery, payment, etc.
    related_invoice: Optional[str] = None
    related_customer: Optional[str] = None

class TaskUpdate(BaseModel):
    title: Optional[str] = None
    description: Optional[str] = None
    priority: Optional[str] = None
    status: Optional[str] = None  # pending, in_progress, completed, cancelled
    due_date: Optional[str] = None
    assigned_to: Optional[str] = None
    assigned_to_name: Optional[str] = None
    category: Optional[str] = None
    completed_at: Optional[str] = None

class NoteCreate(BaseModel):
    task_id: str
    content: str

class NoteUpdate(BaseModel):
    content: str


# ============ ROUTES ============

@router.get("")
async def get_tasks(
    status: Optional[str] = None,
    priority: Optional[str] = None,
    assigned_to: Optional[str] = None,
    showroom_id: Optional[str] = None,
    category: Optional[str] = None,
    search: Optional[str] = None,
    current_user: dict = Depends(get_current_user)
):
    """Get all tasks with optional filters"""
    db = get_db()
    query = {}
    
    # Filter by showroom for non-super-admin users
    user_showroom_id = current_user.get("showroom_id")
    is_super_admin = current_user.get("role") == "super_admin"
    
    if not is_super_admin and user_showroom_id:
        query["$or"] = [
            {"showroom_id": user_showroom_id},
            {"assigned_to": current_user.get("email")},
            {"created_by": current_user.get("email")}
        ]
    
    if status:
        query["status"] = status
    if priority:
        query["priority"] = priority
    if assigned_to:
        query["assigned_to"] = assigned_to
    if showroom_id and is_super_admin:
        query["showroom_id"] = showroom_id
    if category:
        query["category"] = category
    if search:
        query["$or"] = [
            {"title": {"$regex": search, "$options": "i"}},
            {"description": {"$regex": search, "$options": "i"}},
            {"related_customer": {"$regex": search, "$options": "i"}}
        ]
    
    tasks = await db.tasks.find(query, {"_id": 0}).sort("created_at", -1).to_list(1000)
    
    # Auto-fix tasks that don't have IDs (legacy data migration)
    for task in tasks:
        if not task.get("id"):
            # Generate a new ID based on title hash for consistency
            new_id = str(uuid.uuid4())
            # Update in database
            await db.tasks.update_one(
                {"title": task.get("title"), "created_at": task.get("created_at")},
                {"$set": {"id": new_id}}
            )
            task["id"] = new_id
    
    return tasks


@router.get("/stats")
async def get_task_stats(
    showroom_id: Optional[str] = None,
    current_user: dict = Depends(get_current_user)
):
    """Get task statistics"""
    db = get_db()
    query = {}
    
    user_showroom_id = current_user.get("showroom_id")
    is_super_admin = current_user.get("role") == "super_admin"
    
    if not is_super_admin and user_showroom_id:
        query["showroom_id"] = user_showroom_id
    elif showroom_id and is_super_admin:
        query["showroom_id"] = showroom_id
    
    tasks = await db.tasks.find(query, {"_id": 0}).to_list(10000)
    
    now = datetime.now(timezone.utc).isoformat()
    
    stats = {
        "total": len(tasks),
        "pending": len([t for t in tasks if t.get("status") == "pending"]),
        "in_progress": len([t for t in tasks if t.get("status") == "in_progress"]),
        "completed": len([t for t in tasks if t.get("status") == "completed"]),
        "overdue": len([t for t in tasks if t.get("due_date") and t.get("due_date") < now and t.get("status") not in ["completed", "cancelled"]]),
        "high_priority": len([t for t in tasks if t.get("priority") in ["high", "urgent"] and t.get("status") not in ["completed", "cancelled"]])
    }
    
    return stats


@router.get("/{task_id}")
async def get_task(task_id: str, current_user: dict = Depends(get_current_user)):
    """Get a single task with its notes"""
    db = get_db()
    
    task = await db.tasks.find_one({"id": task_id}, {"_id": 0})
    if not task:
        raise HTTPException(status_code=404, detail="Task not found")
    
    # Get notes for this task
    notes = await db.task_notes.find({"task_id": task_id}, {"_id": 0}).sort("created_at", -1).to_list(100)
    task["notes"] = notes
    
    return task


@router.post("")
async def create_task(input: TaskCreate, current_user: dict = Depends(get_current_user)):
    """Create a new task"""
    db = get_db()
    
    task_dict = {
        "id": str(uuid.uuid4()),
        "title": input.title,
        "description": input.description,
        "priority": input.priority,
        "status": "pending",
        "due_date": input.due_date,
        "assigned_to": input.assigned_to,
        "assigned_to_name": input.assigned_to_name,
        "showroom_id": input.showroom_id or current_user.get("showroom_id"),
        "showroom_name": input.showroom_name,
        "category": input.category or "general",
        "related_invoice": input.related_invoice,
        "related_customer": input.related_customer,
        "created_by": current_user.get("email"),
        "created_by_name": current_user.get("name"),
        "created_at": datetime.now(timezone.utc).isoformat(),
        "updated_at": datetime.now(timezone.utc).isoformat()
    }
    
    await db.tasks.insert_one(task_dict)
    
    # Remove MongoDB's _id before returning (it's not JSON serializable)
    task_dict.pop("_id", None)
    
    # Log audit trail
    await log_audit(
        action="CREATE",
        entity_type="task",
        user=current_user,
        entity_id=task_dict["id"],
        entity_name=task_dict["title"],
        after_data={"title": task_dict["title"], "priority": task_dict["priority"]},
        details=f"Task '{task_dict['title']}' created"
    )
    
    return {"message": "Task created successfully", "task_id": task_dict["id"], "task": task_dict}


@router.put("/{task_id}")
async def update_task(task_id: str, input: TaskUpdate, current_user: dict = Depends(get_current_user)):
    """Update a task"""
    db = get_db()
    
    # Handle case where task_id might be 'undefined' or empty
    if not task_id or task_id == 'undefined' or task_id == 'null':
        raise HTTPException(status_code=400, detail="Invalid task ID")
    
    task = await db.tasks.find_one({"id": task_id})
    if not task:
        raise HTTPException(status_code=404, detail="Task not found")
    
    update_data = {"updated_at": datetime.now(timezone.utc).isoformat()}
    
    if input.title is not None:
        update_data["title"] = input.title
    if input.description is not None:
        update_data["description"] = input.description
    if input.priority is not None:
        update_data["priority"] = input.priority
    if input.status is not None:
        update_data["status"] = input.status
        if input.status == "completed":
            update_data["completed_at"] = datetime.now(timezone.utc).isoformat()
            update_data["completed_by"] = current_user.get("email")
    if input.due_date is not None:
        update_data["due_date"] = input.due_date
    if input.assigned_to is not None:
        update_data["assigned_to"] = input.assigned_to
    if input.assigned_to_name is not None:
        update_data["assigned_to_name"] = input.assigned_to_name
    if input.category is not None:
        update_data["category"] = input.category
    
    await db.tasks.update_one({"id": task_id}, {"$set": update_data})
    
    return {"message": "Task updated successfully", "task_id": task_id}


@router.delete("/{task_id}")
async def delete_task(task_id: str, current_user: dict = Depends(get_current_user)):
    """Delete a task"""
    db = get_db()
    
    task = await db.tasks.find_one({"id": task_id})
    if not task:
        raise HTTPException(status_code=404, detail="Task not found")
    
    # Delete task and its notes
    await db.tasks.delete_one({"id": task_id})
    await db.task_notes.delete_many({"task_id": task_id})
    
    # Log audit trail
    await log_audit(
        action="DELETE",
        entity_type="task",
        user=current_user,
        entity_id=task_id,
        entity_name=task.get("title"),
        details=f"Task '{task.get('title')}' deleted"
    )
    
    return {"message": "Task deleted successfully"}


# ============ NOTES ROUTES ============

@router.post("/{task_id}/notes")
async def add_note(task_id: str, input: NoteCreate, current_user: dict = Depends(get_current_user)):
    """Add a note to a task"""
    db = get_db()
    
    task = await db.tasks.find_one({"id": task_id})
    if not task:
        raise HTTPException(status_code=404, detail="Task not found")
    
    note_dict = {
        "id": str(uuid.uuid4()),
        "task_id": task_id,
        "content": input.content,
        "created_by": current_user.get("email"),
        "created_by_name": current_user.get("name"),
        "created_at": datetime.now(timezone.utc).isoformat()
    }
    
    await db.task_notes.insert_one({**note_dict})
    
    # Update task's updated_at
    await db.tasks.update_one(
        {"id": task_id}, 
        {"$set": {"updated_at": datetime.now(timezone.utc).isoformat()}}
    )
    
    return {"message": "Note added successfully", "note_id": note_dict["id"], "note": note_dict}


@router.put("/notes/{note_id}")
async def update_note(note_id: str, input: NoteUpdate, current_user: dict = Depends(get_current_user)):
    """Update a note"""
    db = get_db()
    
    note = await db.task_notes.find_one({"id": note_id})
    if not note:
        raise HTTPException(status_code=404, detail="Note not found")
    
    # Only allow the creator or admin to edit
    if note.get("created_by") != current_user.get("email") and not is_admin_user(current_user):
        raise HTTPException(status_code=403, detail="Not authorized to edit this note")
    
    await db.task_notes.update_one(
        {"id": note_id},
        {"$set": {
            "content": input.content,
            "updated_at": datetime.now(timezone.utc).isoformat(),
            "updated_by": current_user.get("email")
        }}
    )
    
    return {"message": "Note updated successfully"}


@router.delete("/notes/{note_id}")
async def delete_note(note_id: str, current_user: dict = Depends(get_current_user)):
    """Delete a note"""
    db = get_db()
    
    note = await db.task_notes.find_one({"id": note_id})
    if not note:
        raise HTTPException(status_code=404, detail="Note not found")
    
    # Only allow the creator or admin to delete
    if note.get("created_by") != current_user.get("email") and not is_admin_user(current_user):
        raise HTTPException(status_code=403, detail="Not authorized to delete this note")
    
    await db.task_notes.delete_one({"id": note_id})
    
    return {"message": "Note deleted successfully"}
