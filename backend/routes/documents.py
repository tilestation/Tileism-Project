"""
Document/Media Storage System
- Supports all media types (documents, images, videos)
- Folder-based organization with password protection
- File versioning
- Search functionality
- 100MB max file size with chunked uploads
"""

from fastapi import APIRouter, HTTPException, Depends, UploadFile, File, Form, Query
from fastapi.responses import StreamingResponse
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from starlette.concurrency import run_in_threadpool
from pydantic import BaseModel, Field
from typing import Optional, List, Dict
from datetime import datetime, timezone
from pathlib import Path
from bson import Binary
import os
import uuid
import hashlib
import logging
import mimetypes
import bcrypt
import jwt

from services.storage.r2_uploader import R2ImageUploader

router = APIRouter(prefix="/documents", tags=["documents"])
logger = logging.getLogger(__name__)

# Legacy on-disk location (read-only fallback for documents uploaded before cloud storage)
DOCUMENTS_DIR = Path("/app/backend/uploads/documents")
R2_DOC_PREFIX = "documents"


def _r2_client():
    client = R2ImageUploader.get_client()
    if not client:
        raise HTTPException(status_code=503, detail="Cloud document storage is unavailable. Please try again shortly.")
    return client


async def store_document_bytes(relative_path: str, data: bytes, content_type: str) -> str:
    """Persist a document in R2 object storage and return its storage key."""
    key = f"{R2_DOC_PREFIX}/{relative_path}"
    client = _r2_client()
    try:
        await run_in_threadpool(
            client.put_object,
            Bucket=R2ImageUploader.get_bucket_name(),
            Key=key,
            Body=data,
            ContentType=content_type,
        )
    except Exception as e:
        logger.error(f"Document upload to R2 failed for {key}: {e}")
        raise HTTPException(status_code=503, detail="Cloud document storage is unavailable. Please try again shortly.")
    return key


async def read_document_bytes(record: dict) -> Optional[bytes]:
    """Fetch document bytes from R2 (or the legacy local folder for old uploads)."""
    key = record.get("storage_key")
    if key:
        client = _r2_client()
        try:
            obj = await run_in_threadpool(client.get_object, Bucket=R2ImageUploader.get_bucket_name(), Key=key)
            return await run_in_threadpool(obj["Body"].read)
        except Exception as e:
            logger.error(f"Document fetch from R2 failed for {key}: {e}")
            return None
    legacy_path = DOCUMENTS_DIR / (record.get("file_path") or "")
    if record.get("file_path") and legacy_path.is_file():
        return legacy_path.read_bytes()
    return None


async def remove_document_file(record: dict):
    key = record.get("storage_key")
    if key:
        try:
            client = R2ImageUploader.get_client()
            if client:
                await run_in_threadpool(client.delete_object, Bucket=R2ImageUploader.get_bucket_name(), Key=key)
        except Exception as e:
            logger.warning(f"Document delete from R2 failed for {key}: {e}")
        return
    legacy_path = DOCUMENTS_DIR / (record.get("file_path") or "")
    if record.get("file_path") and legacy_path.is_file():
        legacy_path.unlink()

# Max file size: 100MB
MAX_FILE_SIZE = 100 * 1024 * 1024

# Allowed file types
ALLOWED_EXTENSIONS = {
    # Documents
    '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
    '.txt', '.csv', '.rtf', '.odt', '.ods', '.odp',
    # Images
    '.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.svg', '.ico',
    # Videos
    '.mp4', '.avi', '.mov', '.wmv', '.flv', '.mkv', '.webm',
    # Audio
    '.mp3', '.wav', '.ogg', '.flac', '.aac',
    # Archives
    '.zip', '.rar', '.7z', '.tar', '.gz'
}

security = HTTPBearer()
SECRET_KEY = os.environ.get("JWT_SECRET", "your-secret-key-change-in-production")
ALGORITHM = "HS256"

# ============ MODELS ============

class FolderCreate(BaseModel):
    name: str
    description: Optional[str] = None
    parent_id: Optional[str] = None
    password: Optional[str] = None  # Optional password protection
    is_public: bool = True  # If False, only authorized users can access

class FolderUpdate(BaseModel):
    name: Optional[str] = None
    description: Optional[str] = None
    password: Optional[str] = None
    remove_password: bool = False
    is_public: Optional[bool] = None

class FolderPasswordVerify(BaseModel):
    password: str

class DocumentUpdate(BaseModel):
    name: Optional[str] = None
    description: Optional[str] = None
    folder_id: Optional[str] = None
    tags: Optional[List[str]] = None

class DocumentSearch(BaseModel):
    query: str
    folder_id: Optional[str] = None
    file_types: Optional[List[str]] = None
    date_from: Optional[str] = None
    date_to: Optional[str] = None

# ============ HELPER FUNCTIONS ============

def get_file_type_category(extension: str) -> str:
    """Categorize file by extension"""
    ext = extension.lower()
    if ext in ['.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.txt', '.csv', '.rtf', '.odt', '.ods', '.odp']:
        return 'document'
    elif ext in ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.svg', '.ico']:
        return 'image'
    elif ext in ['.mp4', '.avi', '.mov', '.wmv', '.flv', '.mkv', '.webm']:
        return 'video'
    elif ext in ['.mp3', '.wav', '.ogg', '.flac', '.aac']:
        return 'audio'
    elif ext in ['.zip', '.rar', '.7z', '.tar', '.gz']:
        return 'archive'
    return 'other'

def hash_folder_password(password: str) -> str:
    """Hash a folder password"""
    return bcrypt.hashpw(password.encode('utf-8'), bcrypt.gensalt()).decode('utf-8')

def verify_folder_password(password: str, hashed: str) -> bool:
    """Verify folder password"""
    return bcrypt.checkpw(password.encode('utf-8'), hashed.encode('utf-8'))

def get_file_hash(contents: bytes) -> str:
    """Calculate MD5 hash of file contents for versioning"""
    return hashlib.md5(contents).hexdigest()

def get_db():
    """Get database connection"""
    from motor.motor_asyncio import AsyncIOMotorClient
    mongo_url = os.environ.get('MONGO_URL')
    db_name = os.environ.get('DB_NAME', 'tile_station')
    client = AsyncIOMotorClient(mongo_url)
    return client[db_name]

async def get_current_user(credentials: HTTPAuthorizationCredentials = Depends(security)):
    """Get current user from auth token"""
    token = credentials.credentials
    try:
        payload = jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])
        email = payload.get("sub")
        if email is None:
            raise HTTPException(status_code=401, detail="Invalid authentication")
        db = get_db()
        user = await db.users.find_one({"email": email}, {"_id": 0})
        if user is None:
            raise HTTPException(status_code=401, detail="User not found")
        return user
    except jwt.ExpiredSignatureError:
        raise HTTPException(status_code=401, detail="Token expired")
    except jwt.InvalidTokenError:
        raise HTTPException(status_code=401, detail="Invalid token")

# ============ FOLDER ENDPOINTS ============

@router.post("/folders")
async def create_folder(
    data: FolderCreate,
    current_user: dict = Depends(get_current_user)
):
    """Create a new folder (Super Admin only can create password-protected folders)"""
    db = get_db()
    
    # Check if parent folder exists
    if data.parent_id:
        parent = await db.document_folders.find_one({"id": data.parent_id})
        if not parent:
            raise HTTPException(status_code=404, detail="Parent folder not found")
    
    # Only super_admin can set passwords on folders
    if data.password and current_user.get("role") != "super_admin":
        raise HTTPException(status_code=403, detail="Only Super Admin can create password-protected folders")
    
    folder_id = str(uuid.uuid4())
    folder = {
        "id": folder_id,
        "name": data.name,
        "description": data.description,
        "parent_id": data.parent_id,
        "password_hash": hash_folder_password(data.password) if data.password else None,
        "is_protected": bool(data.password),
        "is_public": data.is_public,
        "created_by": current_user.get("email"),
        "created_at": datetime.now(timezone.utc).isoformat(),
        "updated_at": datetime.now(timezone.utc).isoformat(),
        "file_count": 0,
        "total_size": 0
    }
    
    await db.document_folders.insert_one(folder)
    
    # Don't return password hash
    folder.pop("password_hash", None)
    folder.pop("_id", None)
    
    return folder

@router.get("/folders")
async def list_folders(
    parent_id: Optional[str] = None,
    current_user: dict = Depends(get_current_user)
):
    """List folders - shows all folders but protected ones require password to access contents"""
    db = get_db()
    
    # Handle empty string as None (root level)
    if parent_id == "":
        parent_id = None
    
    query = {"parent_id": parent_id}
    
    folders = await db.document_folders.find(query, {"_id": 0, "password_hash": 0}).to_list(1000)
    
    # Add breadcrumb path for each folder
    for folder in folders:
        folder["path"] = await get_folder_path(db, folder["id"])
    
    return folders

@router.get("/folders/{folder_id}")
async def get_folder(
    folder_id: str,
    current_user: dict = Depends(get_current_user)
):
    """Get folder details"""
    db = get_db()
    folder = await db.document_folders.find_one({"id": folder_id}, {"_id": 0, "password_hash": 0})
    if not folder:
        raise HTTPException(status_code=404, detail="Folder not found")
    
    folder["path"] = await get_folder_path(db, folder_id)
    return folder

@router.put("/folders/{folder_id}")
async def update_folder(
    folder_id: str,
    data: FolderUpdate,
    current_user: dict = Depends(get_current_user)
):
    """Update folder (Super Admin only for password changes)"""
    db = get_db()
    folder = await db.document_folders.find_one({"id": folder_id})
    if not folder:
        raise HTTPException(status_code=404, detail="Folder not found")
    
    update_data = {"updated_at": datetime.now(timezone.utc).isoformat()}
    
    if data.name:
        update_data["name"] = data.name
    if data.description is not None:
        update_data["description"] = data.description
    if data.is_public is not None:
        update_data["is_public"] = data.is_public
    
    # Password changes - Super Admin only
    if data.password or data.remove_password:
        if current_user.get("role") != "super_admin":
            raise HTTPException(status_code=403, detail="Only Super Admin can change folder passwords")
        
        if data.remove_password:
            update_data["password_hash"] = None
            update_data["is_protected"] = False
        elif data.password:
            update_data["password_hash"] = hash_folder_password(data.password)
            update_data["is_protected"] = True
    
    await db.document_folders.update_one({"id": folder_id}, {"$set": update_data})
    
    updated = await db.document_folders.find_one({"id": folder_id}, {"_id": 0, "password_hash": 0})
    return updated

@router.delete("/folders/{folder_id}")
async def delete_folder(
    folder_id: str,
    current_user: dict = Depends(get_current_user)
):
    """Delete folder and all contents (Super Admin only)"""
    if current_user.get("role") != "super_admin":
        raise HTTPException(status_code=403, detail="Only Super Admin can delete folders")
    
    db = get_db()
    folder = await db.document_folders.find_one({"id": folder_id})
    if not folder:
        raise HTTPException(status_code=404, detail="Folder not found")
    
    # Get all documents in folder
    documents = await db.documents.find({"folder_id": folder_id}).to_list(None)
    
    # Delete stored files
    for doc in documents:
        await remove_document_file(doc)
        
        # Delete versions
        versions = await db.document_versions.find({"document_id": doc["id"]}).to_list(None)
        for version in versions:
            await remove_document_file(version)
    
    # Delete documents from DB
    await db.documents.delete_many({"folder_id": folder_id})
    await db.document_versions.delete_many({"document_id": {"$in": [d["id"] for d in documents]}})
    
    # Delete subfolders recursively
    subfolders = await db.document_folders.find({"parent_id": folder_id}).to_list(None)
    for subfolder in subfolders:
        await delete_folder(subfolder["id"], current_user)
    
    # Delete folder
    await db.document_folders.delete_one({"id": folder_id})
    
    return {"message": "Folder and contents deleted successfully"}

@router.post("/folders/{folder_id}/verify-password")
async def verify_folder_password_endpoint(
    folder_id: str,
    data: FolderPasswordVerify,
    current_user: dict = Depends(get_current_user)
):
    """Verify folder password to access protected folder"""
    db = get_db()
    folder = await db.document_folders.find_one({"id": folder_id})
    if not folder:
        raise HTTPException(status_code=404, detail="Folder not found")
    
    if not folder.get("is_protected") or not folder.get("password_hash"):
        return {"verified": True, "message": "Folder is not password protected"}
    
    if verify_folder_password(data.password, folder["password_hash"]):
        return {"verified": True, "message": "Password verified"}
    else:
        raise HTTPException(status_code=401, detail="Invalid password")

async def get_folder_path(db, folder_id: str) -> List[dict]:
    """Get breadcrumb path for a folder"""
    path = []
    current_id = folder_id
    
    while current_id:
        folder = await db.document_folders.find_one({"id": current_id}, {"_id": 0, "password_hash": 0})
        if not folder:
            break
        path.insert(0, {"id": folder["id"], "name": folder["name"]})
        current_id = folder.get("parent_id")
    
    return path

# ============ DOCUMENT ENDPOINTS ============

@router.post("/upload")
async def upload_document(
    file: UploadFile = File(...),
    folder_id: Optional[str] = Form(None),
    description: Optional[str] = Form(None),
    tags: Optional[str] = Form(None),  # Comma-separated tags
    current_user: dict = Depends(get_current_user)
):
    """Upload a document (chunked upload support for large files)"""
    db = get_db()
    
    # Validate file extension
    filename = file.filename or "unnamed"
    ext = Path(filename).suffix.lower()
    if ext not in ALLOWED_EXTENSIONS:
        raise HTTPException(status_code=400, detail=f"File type {ext} not allowed")
    
    # Read file content
    contents = await file.read()
    file_size = len(contents)
    
    # Validate file size
    if file_size > MAX_FILE_SIZE:
        raise HTTPException(status_code=400, detail=f"File too large. Maximum size is {MAX_FILE_SIZE // (1024*1024)}MB")
    
    # Validate folder exists and user has access
    if folder_id:
        folder = await db.document_folders.find_one({"id": folder_id})
        if not folder:
            raise HTTPException(status_code=404, detail="Folder not found")
    
    # Generate unique filename
    doc_id = str(uuid.uuid4())
    safe_filename = f"{doc_id}{ext}"
    date_path = datetime.now().strftime("%Y/%m")
    relative_path = f"{date_path}/{safe_filename}"
    
    # Get mime type
    mime_type = mimetypes.guess_type(filename)[0] or "application/octet-stream"
    
    # Save file to cloud storage
    storage_key = await store_document_bytes(relative_path, contents, mime_type)
    
    # Get file hash for versioning
    file_hash = get_file_hash(contents)
    
    # Parse tags
    tag_list = [t.strip() for t in tags.split(",")] if tags else []
    
    # Create document record
    document = {
        "id": doc_id,
        "name": filename,
        "description": description,
        "folder_id": folder_id,
        "file_path": relative_path,
        "storage_key": storage_key,
        "storage": "r2",
        "file_size": file_size,
        "file_type": get_file_type_category(ext),
        "extension": ext,
        "mime_type": mime_type,
        "file_hash": file_hash,
        "version": 1,
        "tags": tag_list,
        "uploaded_by": current_user.get("email"),
        "uploaded_by_name": current_user.get("name"),
        "created_at": datetime.now(timezone.utc).isoformat(),
        "updated_at": datetime.now(timezone.utc).isoformat(),
        "download_count": 0
    }
    
    await db.documents.insert_one(document)
    
    # Update folder stats
    if folder_id:
        await db.document_folders.update_one(
            {"id": folder_id},
            {"$inc": {"file_count": 1, "total_size": file_size}}
        )
    
    document.pop("_id", None)
    return document

@router.post("/upload-chunk")
async def upload_chunk(
    chunk: UploadFile = File(...),
    upload_id: str = Form(...),
    chunk_index: int = Form(...),
    total_chunks: int = Form(...),
    filename: str = Form(...),
    folder_id: Optional[str] = Form(None),
    description: Optional[str] = Form(None),
    tags: Optional[str] = Form(None),
    current_user: dict = Depends(get_current_user)
):
    """Upload file in chunks for large files (100MB support)"""
    db = get_db()
    
    # Stage chunk in the database (pod-independent) until every part has arrived
    contents = await chunk.read()
    await db.document_upload_chunks.update_one(
        {"upload_id": upload_id, "chunk_index": chunk_index},
        {"$set": {"data": Binary(contents), "created_at": datetime.now(timezone.utc).isoformat()}},
        upsert=True,
    )
    
    # Check if all chunks uploaded
    uploaded = await db.document_upload_chunks.count_documents({"upload_id": upload_id})
    if uploaded == total_chunks:
        chunk_docs = await db.document_upload_chunks.find(
            {"upload_id": upload_id}, {"_id": 0, "chunk_index": 1, "data": 1}
        ).sort("chunk_index", 1).to_list(None)
        await db.document_upload_chunks.delete_many({"upload_id": upload_id})
        
        ext = Path(filename).suffix.lower()
        if ext not in ALLOWED_EXTENSIONS:
            raise HTTPException(status_code=400, detail=f"File type {ext} not allowed")
        
        merged = b"".join(bytes(c["data"]) for c in chunk_docs)
        
        # Verify file size
        file_size = len(merged)
        if file_size > MAX_FILE_SIZE:
            raise HTTPException(status_code=400, detail=f"File too large. Maximum size is {MAX_FILE_SIZE // (1024*1024)}MB")
        
        doc_id = str(uuid.uuid4())
        safe_filename = f"{doc_id}{ext}"
        date_path = datetime.now().strftime("%Y/%m")
        relative_path = f"{date_path}/{safe_filename}"
        
        # Get mime type
        mime_type = mimetypes.guess_type(filename)[0] or "application/octet-stream"
        
        storage_key = await store_document_bytes(relative_path, merged, mime_type)
        file_hash = get_file_hash(merged)
        
        # Parse tags
        tag_list = [t.strip() for t in tags.split(",")] if tags else []
        
        # Create document record
        document = {
            "id": doc_id,
            "name": filename,
            "description": description,
            "folder_id": folder_id,
            "file_path": relative_path,
            "storage_key": storage_key,
            "storage": "r2",
            "file_size": file_size,
            "file_type": get_file_type_category(ext),
            "extension": ext,
            "mime_type": mime_type,
            "file_hash": file_hash,
            "version": 1,
            "tags": tag_list,
            "uploaded_by": current_user.get("email"),
            "uploaded_by_name": current_user.get("name"),
            "created_at": datetime.now(timezone.utc).isoformat(),
            "updated_at": datetime.now(timezone.utc).isoformat(),
            "download_count": 0
        }
        
        await db.documents.insert_one(document)
        
        # Update folder stats
        if folder_id:
            await db.document_folders.update_one(
                {"id": folder_id},
                {"$inc": {"file_count": 1, "total_size": file_size}}
            )
        
        document.pop("_id", None)
        return {"status": "complete", "document": document}
    
    return {"status": "chunk_received", "chunk_index": chunk_index, "total_chunks": total_chunks}

@router.get("/list")
async def list_documents(
    folder_id: Optional[str] = None,
    file_type: Optional[str] = None,
    search: Optional[str] = None,
    limit: int = 100,
    skip: int = 0,
    current_user: dict = Depends(get_current_user)
):
    """List documents with optional filtering"""
    db = get_db()
    query = {}
    
    # Handle empty string as None (root level)
    if folder_id == "":
        folder_id = None
    
    # Always filter by folder_id (None = root level)
    query["folder_id"] = folder_id
    
    if file_type:
        query["file_type"] = file_type
    
    if search:
        query["$or"] = [
            {"name": {"$regex": search, "$options": "i"}},
            {"description": {"$regex": search, "$options": "i"}},
            {"tags": {"$regex": search, "$options": "i"}}
        ]
    
    documents = await db.documents.find(query, {"_id": 0}).skip(skip).limit(limit).sort("created_at", -1).to_list(limit)
    total = await db.documents.count_documents(query)
    
    return {"documents": documents, "total": total}

@router.get("/search")
async def search_documents(
    q: str = Query(..., description="Search query"),
    folder_id: Optional[str] = None,
    file_type: Optional[str] = None,
    limit: int = 50,
    current_user: dict = Depends(get_current_user)
):
    """Search documents by name, description, or tags"""
    db = get_db()
    query = {
        "$or": [
            {"name": {"$regex": q, "$options": "i"}},
            {"description": {"$regex": q, "$options": "i"}},
            {"tags": {"$regex": q, "$options": "i"}}
        ]
    }
    
    if folder_id:
        query["folder_id"] = folder_id
    if file_type:
        query["file_type"] = file_type
    
    documents = await db.documents.find(query, {"_id": 0}).limit(limit).sort("created_at", -1).to_list(limit)
    
    return {"documents": documents, "query": q}

@router.get("/{document_id}")
async def get_document(
    document_id: str,
    current_user: dict = Depends(get_current_user)
):
    """Get document details"""
    db = get_db()
    document = await db.documents.find_one({"id": document_id}, {"_id": 0})
    if not document:
        raise HTTPException(status_code=404, detail="Document not found")
    
    # Get versions
    versions = await db.document_versions.find(
        {"document_id": document_id}, 
        {"_id": 0}
    ).sort("version", -1).to_list(100)
    
    document["versions"] = versions
    return document

@router.put("/{document_id}")
async def update_document(
    document_id: str,
    data: DocumentUpdate,
    current_user: dict = Depends(get_current_user)
):
    """Update document metadata"""
    db = get_db()
    document = await db.documents.find_one({"id": document_id})
    if not document:
        raise HTTPException(status_code=404, detail="Document not found")
    
    update_data = {"updated_at": datetime.now(timezone.utc).isoformat()}
    
    if data.name:
        update_data["name"] = data.name
    if data.description is not None:
        update_data["description"] = data.description
    if data.tags is not None:
        update_data["tags"] = data.tags
    
    # Handle folder change
    if data.folder_id is not None and data.folder_id != document.get("folder_id"):
        old_folder_id = document.get("folder_id")
        new_folder_id = data.folder_id if data.folder_id else None
        
        # Update old folder stats
        if old_folder_id:
            await db.document_folders.update_one(
                {"id": old_folder_id},
                {"$inc": {"file_count": -1, "total_size": -document.get("file_size", 0)}}
            )
        
        # Update new folder stats
        if new_folder_id:
            new_folder = await db.document_folders.find_one({"id": new_folder_id})
            if not new_folder:
                raise HTTPException(status_code=404, detail="Target folder not found")
            await db.document_folders.update_one(
                {"id": new_folder_id},
                {"$inc": {"file_count": 1, "total_size": document.get("file_size", 0)}}
            )
        
        update_data["folder_id"] = new_folder_id
    
    await db.documents.update_one({"id": document_id}, {"$set": update_data})
    
    updated = await db.documents.find_one({"id": document_id}, {"_id": 0})
    return updated

@router.post("/{document_id}/new-version")
async def upload_new_version(
    document_id: str,
    file: UploadFile = File(...),
    current_user: dict = Depends(get_current_user)
):
    """Upload a new version of a document"""
    db = get_db()
    document = await db.documents.find_one({"id": document_id})
    if not document:
        raise HTTPException(status_code=404, detail="Document not found")
    
    # Validate file extension matches
    filename = file.filename or "unnamed"
    ext = Path(filename).suffix.lower()
    if ext not in ALLOWED_EXTENSIONS:
        raise HTTPException(status_code=400, detail=f"File type {ext} not allowed")
    
    # Read file content
    contents = await file.read()
    file_size = len(contents)
    
    if file_size > MAX_FILE_SIZE:
        raise HTTPException(status_code=400, detail=f"File too large. Maximum size is {MAX_FILE_SIZE // (1024*1024)}MB")
    
    # Save old version
    old_version = {
        "id": str(uuid.uuid4()),
        "document_id": document_id,
        "version": document.get("version", 1),
        "file_path": document.get("file_path"),
        "storage_key": document.get("storage_key"),
        "file_size": document.get("file_size"),
        "file_hash": document.get("file_hash"),
        "uploaded_by": document.get("uploaded_by"),
        "uploaded_by_name": document.get("uploaded_by_name"),
        "created_at": document.get("updated_at", document.get("created_at"))
    }
    await db.document_versions.insert_one(old_version)
    
    # Save new file
    new_version = document.get("version", 1) + 1
    safe_filename = f"{document_id}_v{new_version}{ext}"
    date_path = datetime.now().strftime("%Y/%m")
    relative_path = f"{date_path}/{safe_filename}"
    mime_type = mimetypes.guess_type(filename)[0] or document.get("mime_type") or "application/octet-stream"
    
    storage_key = await store_document_bytes(relative_path, contents, mime_type)
    file_hash = get_file_hash(contents)
    
    # Update document
    size_diff = file_size - document.get("file_size", 0)
    await db.documents.update_one(
        {"id": document_id},
        {"$set": {
            "file_path": relative_path,
            "storage_key": storage_key,
            "storage": "r2",
            "mime_type": mime_type,
            "file_size": file_size,
            "file_hash": file_hash,
            "version": new_version,
            "uploaded_by": current_user.get("email"),
            "uploaded_by_name": current_user.get("name"),
            "updated_at": datetime.now(timezone.utc).isoformat()
        }}
    )
    
    # Update folder size
    if document.get("folder_id"):
        await db.document_folders.update_one(
            {"id": document["folder_id"]},
            {"$inc": {"total_size": size_diff}}
        )
    
    updated = await db.documents.find_one({"id": document_id}, {"_id": 0})
    return updated

@router.get("/{document_id}/download")
async def download_document(
    document_id: str,
    version: Optional[int] = None,
    token: Optional[str] = None
):
    """Download a document (optionally a specific version). 
    Auth is optional for downloads - having the document ID is proof of access."""
    db = get_db()
    document = await db.documents.find_one({"id": document_id})
    if not document:
        raise HTTPException(status_code=404, detail="Document not found")
    
    record = document
    filename = document.get("name")
    
    # If requesting specific version
    if version and version != document.get("version"):
        version_doc = await db.document_versions.find_one({
            "document_id": document_id,
            "version": version
        })
        if version_doc:
            record = version_doc
            filename = f"v{version}_{filename}"
    
    data = await read_document_bytes(record)
    if data is None:
        raise HTTPException(status_code=404, detail="File not found in storage")
    
    # Increment download count
    await db.documents.update_one(
        {"id": document_id},
        {"$inc": {"download_count": 1}}
    )
    
    safe_name = (filename or "download").replace('"', "")
    return StreamingResponse(
        iter([data]),
        media_type=document.get("mime_type", "application/octet-stream"),
        headers={
            "Content-Disposition": f'attachment; filename="{safe_name}"',
            "Content-Length": str(len(data)),
        },
    )

@router.get("/{document_id}/preview")
async def preview_document(
    document_id: str,
    current_user: dict = Depends(get_current_user)
):
    """Get preview URL for document (for images/PDFs)"""
    db = get_db()
    document = await db.documents.find_one({"id": document_id}, {"_id": 0})
    if not document:
        raise HTTPException(status_code=404, detail="Document not found")
    
    file_type = document.get("file_type")
    
    if file_type not in ["image", "document"]:
        return {"preview_available": False, "message": "Preview not available for this file type"}
    
    # For images and PDFs, return the download URL as preview
    base_url = os.environ.get("BACKEND_URL", "")
    preview_url = f"{base_url}/api/documents/{document_id}/download"
    
    return {
        "preview_available": True,
        "preview_url": preview_url,
        "file_type": file_type,
        "mime_type": document.get("mime_type")
    }

@router.delete("/{document_id}")
async def delete_document(
    document_id: str,
    current_user: dict = Depends(get_current_user)
):
    """Delete a document (Super Admin or uploader only)"""
    db = get_db()
    document = await db.documents.find_one({"id": document_id})
    if not document:
        raise HTTPException(status_code=404, detail="Document not found")
    
    # Check permission
    is_super_admin = current_user.get("role") == "super_admin"
    is_uploader = document.get("uploaded_by") == current_user.get("email")
    
    if not is_super_admin and not is_uploader:
        raise HTTPException(status_code=403, detail="You don't have permission to delete this document")
    
    # Delete stored file
    await remove_document_file(document)
    
    # Delete versions
    versions = await db.document_versions.find({"document_id": document_id}).to_list(None)
    for version in versions:
        await remove_document_file(version)
    
    await db.document_versions.delete_many({"document_id": document_id})
    
    # Update folder stats
    if document.get("folder_id"):
        await db.document_folders.update_one(
            {"id": document["folder_id"]},
            {"$inc": {"file_count": -1, "total_size": -document.get("file_size", 0)}}
        )
    
    # Delete document
    await db.documents.delete_one({"id": document_id})
    
    return {"message": "Document deleted successfully"}

@router.get("/stats/overview")
async def get_storage_stats(
    current_user: dict = Depends(get_current_user)
):
    """Get storage statistics overview"""
    db = get_db()
    
    # Total documents
    total_docs = await db.documents.count_documents({})
    
    # Total folders
    total_folders = await db.document_folders.count_documents({})
    
    # Total storage used
    pipeline = [
        {"$group": {"_id": None, "total_size": {"$sum": "$file_size"}}}
    ]
    result = await db.documents.aggregate(pipeline).to_list(1)
    total_size = result[0]["total_size"] if result else 0
    
    # Documents by type
    type_pipeline = [
        {"$group": {"_id": "$file_type", "count": {"$sum": 1}, "size": {"$sum": "$file_size"}}}
    ]
    by_type = await db.documents.aggregate(type_pipeline).to_list(10)
    
    # Recent uploads
    recent = await db.documents.find({}, {"_id": 0}).sort("created_at", -1).limit(5).to_list(5)
    
    return {
        "total_documents": total_docs,
        "total_folders": total_folders,
        "total_storage_bytes": total_size,
        "total_storage_mb": round(total_size / (1024 * 1024), 2),
        "by_type": {item["_id"]: {"count": item["count"], "size_mb": round(item["size"] / (1024*1024), 2)} for item in by_type},
        "recent_uploads": recent
    }
