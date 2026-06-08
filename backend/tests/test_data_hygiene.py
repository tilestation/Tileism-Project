"""
Tests for the Data Hygiene admin endpoints (8 Jun 2026).

Born from the Tonbridge duplicate-row bug — we now catch all drift
proactively. These tests verify the four scan categories + the fix
path.
"""
import os
import asyncio
from unittest.mock import patch, AsyncMock, MagicMock

import pytest


@pytest.fixture(autouse=True)
def _env_setup():
    os.environ.setdefault("MONGO_URL", "mongodb://localhost:27017")
    os.environ.setdefault("DB_NAME", "test_data_hygiene")


class _AsyncIter:
    def __init__(self, items): self._items = list(items)
    def __aiter__(self): self._iter = iter(self._items); return self
    async def __anext__(self):
        try: return next(self._iter)
        except StopIteration as e: raise StopAsyncIteration from e


def _db(users=None, quotations=None, invoices=None, showrooms=None):
    db = MagicMock()
    db.users.find = MagicMock(return_value=_AsyncIter(users or []))
    db.quotations.find = MagicMock(return_value=_AsyncIter(quotations or []))
    db.invoices.find = MagicMock(return_value=_AsyncIter(invoices or []))
    db.showrooms.find = MagicMock(return_value=_AsyncIter(showrooms or []))
    db.users.update_many = AsyncMock(return_value=MagicMock(matched_count=1, modified_count=1))
    db.quotations.update_many = AsyncMock(return_value=MagicMock(matched_count=1, modified_count=1))
    db.invoices.update_many = AsyncMock(return_value=MagicMock(matched_count=1, modified_count=1))
    return db


SUPER = {"role": "super_admin", "email": "a@b"}
NON_SUPER = {"role": "admin", "email": "x@y"}


# ---------------------------------------------------------------------
# Auth
# ---------------------------------------------------------------------
def test_scan_requires_super_admin():
    from routes.data_hygiene import scan_data_hygiene
    from fastapi import HTTPException
    with patch("routes.data_hygiene.get_db", return_value=_db()):
        with pytest.raises(HTTPException) as exc:
            asyncio.run(scan_data_hygiene(current_user=NON_SUPER))
        assert exc.value.status_code == 403


# ---------------------------------------------------------------------
# 1. Drifted labels — the canonical use case
# ---------------------------------------------------------------------
def test_scan_detects_drifted_label_on_user():
    """A user with `showroom_name='Tile Station Tonbridge'` while the
    canonical name in db.showrooms is just 'Tonbridge' must show up
    in drifted_labels with the canonical target."""
    from routes.data_hygiene import scan_data_hygiene
    users = [{
        "_id": "u1", "id": "u1", "name": "Bob",
        "showroom_id": "sr_tn",
        "showroom_name": "Tile Station Tonbridge",
    }]
    showrooms = [{"_id": "sr_tn", "name": "Tonbridge"}]
    db = _db(users=users, showrooms=showrooms)
    with patch("routes.data_hygiene.get_db", return_value=db):
        r = asyncio.run(scan_data_hygiene(current_user=SUPER))
    assert r["summary"]["drifted_labels"] == 1
    assert r["drifted_labels"][0]["stamped_name"] == "Tile Station Tonbridge"
    assert r["drifted_labels"][0]["canonical_name"] == "Tonbridge"
    assert r["drifted_labels"][0]["collection"] == "users"
    # Grouped output for the "Fix all" UX
    assert len(r["drifted_groups"]) == 1
    assert r["drifted_groups"][0]["records"][0]["record_id"] == "u1"


def test_scan_groups_drift_across_collections():
    """A drifted name appearing on a user + a quotation + an invoice
    at the same showroom_id collapses into ONE group with three records,
    so the admin can fix all of them in a single click."""
    from routes.data_hygiene import scan_data_hygiene
    showrooms = [{"_id": "sr_tn", "name": "Tonbridge"}]
    users = [{"_id": "u1", "id": "u1", "name": "Bob",
              "showroom_id": "sr_tn", "showroom_name": "Tile Station Tonbridge"}]
    quotations = [{"_id": "q1", "id": "q1", "quotation_number": "Q-100",
                   "showroom_id": "sr_tn", "showroom_name": "Tile Station Tonbridge"}]
    invoices = [{"_id": "i1", "id": "i1", "invoice_number": "INV-200",
                 "showroom_id": "sr_tn", "showroom_name": "Tile Station Tonbridge"}]
    db = _db(users=users, quotations=quotations, invoices=invoices, showrooms=showrooms)
    with patch("routes.data_hygiene.get_db", return_value=db):
        r = asyncio.run(scan_data_hygiene(current_user=SUPER))
    assert r["summary"]["drifted_labels"] == 3
    assert len(r["drifted_groups"]) == 1
    g = r["drifted_groups"][0]
    collections = {rec["collection"] for rec in g["records"]}
    assert collections == {"users", "quotations", "invoices"}


# ---------------------------------------------------------------------
# 2. Orphans
# ---------------------------------------------------------------------
def test_scan_detects_orphan_name_without_id():
    """A record stamped with `showroom_name` but no `showroom_id` is
    flagged — it can't be auto-resolved against the showrooms collection."""
    from routes.data_hygiene import scan_data_hygiene
    invoices = [{
        "_id": "i_orph", "id": "i_orph", "invoice_number": "INV-9",
        "showroom_name": "Old Closed Store",
    }]
    db = _db(invoices=invoices, showrooms=[{"_id": "sr1", "name": "Live"}])
    with patch("routes.data_hygiene.get_db", return_value=db):
        r = asyncio.run(scan_data_hygiene(current_user=SUPER))
    assert r["summary"]["orphan_showroom_name"] == 1
    assert r["orphan_showroom_name"][0]["stamped_name"] == "Old Closed Store"
    assert r["summary"]["drifted_labels"] == 0


# ---------------------------------------------------------------------
# 3. Unmapped showroom_id
# ---------------------------------------------------------------------
def test_scan_detects_unmapped_showroom_id():
    """A user pointing at a `showroom_id` that no longer exists in the
    showrooms collection is flagged — likely a deleted store."""
    from routes.data_hygiene import scan_data_hygiene
    users = [{
        "_id": "u1", "id": "u1", "name": "Ghost",
        "showroom_id": "sr_deleted",
        "showroom_name": "Removed",
    }]
    db = _db(users=users, showrooms=[{"_id": "sr_live", "name": "Live"}])
    with patch("routes.data_hygiene.get_db", return_value=db):
        r = asyncio.run(scan_data_hygiene(current_user=SUPER))
    assert r["summary"]["unmapped_showroom_id"] == 1
    assert r["unmapped_showroom_id"][0]["stamped_showroom_id"] == "sr_deleted"
    assert r["summary"]["drifted_labels"] == 0


# ---------------------------------------------------------------------
# 4. Near-duplicate showrooms
# ---------------------------------------------------------------------
def test_scan_detects_near_duplicate_showrooms():
    """Two showroom docs whose names normalise to the same key must
    show up under near_duplicate_showrooms."""
    from routes.data_hygiene import scan_data_hygiene
    showrooms = [
        {"_id": "sr_a", "name": "Tonbridge"},
        {"_id": "sr_b", "name": "Tile Station Tonbridge"},  # near-dup
        {"_id": "sr_c", "name": "Gravesend"},
    ]
    db = _db(showrooms=showrooms)
    with patch("routes.data_hygiene.get_db", return_value=db):
        r = asyncio.run(scan_data_hygiene(current_user=SUPER))
    assert r["summary"]["near_duplicate_showrooms"] == 1
    pair = r["near_duplicate_showrooms"][0]["showrooms"]
    assert {p["name"] for p in pair} == {"Tonbridge", "Tile Station Tonbridge"}


def test_scan_clean_returns_zero_counts():
    """When everything's consistent, summary shows zeros across the board."""
    from routes.data_hygiene import scan_data_hygiene
    users = [{"_id": "u1", "id": "u1", "name": "Bob",
              "showroom_id": "sr_tn", "showroom_name": "Tonbridge"}]
    showrooms = [{"_id": "sr_tn", "name": "Tonbridge"}]
    db = _db(users=users, showrooms=showrooms)
    with patch("routes.data_hygiene.get_db", return_value=db):
        r = asyncio.run(scan_data_hygiene(current_user=SUPER))
    s = r["summary"]
    assert s["drifted_labels"] == 0
    assert s["orphan_showroom_name"] == 0
    assert s["unmapped_showroom_id"] == 0
    assert s["near_duplicate_showrooms"] == 0


# ---------------------------------------------------------------------
# Fix path
# ---------------------------------------------------------------------
def test_fix_one_renames_records():
    """POST /fix with scope='one' renames just the specified records
    to the canonical store name."""
    from routes.data_hygiene import apply_fix, FixRequest
    showrooms = [{"_id": "sr_tn", "name": "Tonbridge"}]
    db = _db(showrooms=showrooms)
    req = FixRequest(
        issue_type="drifted_labels",
        scope="one",
        collection="users",
        showroom_id="sr_tn",
        record_ids=["u1"],
    )
    with patch("routes.data_hygiene.get_db", return_value=db):
        r = asyncio.run(apply_fix(req, current_user=SUPER))
    assert r["ok"] is True
    assert r["renamed_to"] == "Tonbridge"
    # update was called with $set containing the canonical name
    call = db.users.update_many.call_args
    set_doc = call.args[1]["$set"]
    assert set_doc["showroom_name"] == "Tonbridge"
    assert set_doc["showroom_id"] == "sr_tn"
    assert "data_hygiene_fixed_at" in set_doc


def test_fix_group_renames_by_id_plus_stamped_name():
    """scope='group' renames every record at the given showroom_id that
    currently carries the drifted `stamped_name`."""
    from routes.data_hygiene import apply_fix, FixRequest
    showrooms = [{"_id": "sr_tn", "name": "Tonbridge"}]
    db = _db(showrooms=showrooms)
    db.invoices.update_many = AsyncMock(return_value=MagicMock(matched_count=5, modified_count=5))
    req = FixRequest(
        issue_type="drifted_labels",
        scope="group",
        collection="invoices",
        showroom_id="sr_tn",
        stamped_name="Tile Station Tonbridge",
    )
    with patch("routes.data_hygiene.get_db", return_value=db):
        r = asyncio.run(apply_fix(req, current_user=SUPER))
    assert r["modified"] == 5
    filt = db.invoices.update_many.call_args.args[0]
    assert filt == {"showroom_id": "sr_tn", "showroom_name": "Tile Station Tonbridge"}


def test_fix_rejects_unknown_showroom_id():
    """Trying to fix at a non-existent showroom id is rejected — we'd
    rather fail than write a NULL canonical_name everywhere."""
    from routes.data_hygiene import apply_fix, FixRequest
    from fastapi import HTTPException
    db = _db(showrooms=[{"_id": "sr_live", "name": "Live"}])
    req = FixRequest(
        issue_type="drifted_labels",
        scope="one",
        collection="users",
        showroom_id="sr_missing",
        record_ids=["u1"],
    )
    with patch("routes.data_hygiene.get_db", return_value=db):
        with pytest.raises(HTTPException) as exc:
            asyncio.run(apply_fix(req, current_user=SUPER))
        assert exc.value.status_code == 400


def test_fix_orphan_assigns_to_chosen_store():
    """Admin picks a target_showroom_id and the orphan record is
    re-stamped with both the new id AND the canonical name."""
    from routes.data_hygiene import apply_fix, FixRequest
    db = _db(showrooms=[{"_id": "sr_tn", "name": "Tonbridge"}])
    req = FixRequest(
        issue_type="orphan_showroom_name",
        scope="one",
        collection="invoices",
        record_ids=["inv_orphan"],
        target_showroom_id="sr_tn",
    )
    with patch("routes.data_hygiene.get_db", return_value=db):
        r = asyncio.run(apply_fix(req, current_user=SUPER))
    assert r["ok"] is True
    assert r["renamed_to"] == "Tonbridge"
    set_doc = db.invoices.update_many.call_args.args[1]["$set"]
    assert set_doc["showroom_id"] == "sr_tn"
    assert set_doc["showroom_name"] == "Tonbridge"


def test_fix_unmapped_assigns_to_chosen_store():
    """Same path as orphan but for records carrying a stale id
    pointing at a deleted showroom. Admin picks the live target."""
    from routes.data_hygiene import apply_fix, FixRequest
    db = _db(showrooms=[{"_id": "sr_gv", "name": "Gravesend"}])
    req = FixRequest(
        issue_type="unmapped_showroom_id",
        scope="one",
        collection="users",
        record_ids=["u_ghost"],
        target_showroom_id="sr_gv",
    )
    with patch("routes.data_hygiene.get_db", return_value=db):
        r = asyncio.run(apply_fix(req, current_user=SUPER))
    assert r["ok"] is True
    assert r["renamed_to"] == "Gravesend"
    set_doc = db.users.update_many.call_args.args[1]["$set"]
    assert set_doc["showroom_id"] == "sr_gv"
    assert set_doc["showroom_name"] == "Gravesend"


def test_fix_orphan_requires_target_showroom_id():
    """Orphan + unmapped fixes need an admin-chosen target; without
    one we reject with 400 rather than silently null the field."""
    from routes.data_hygiene import apply_fix, FixRequest
    from fastapi import HTTPException
    db = _db(showrooms=[{"_id": "sr_tn", "name": "Tonbridge"}])
    req = FixRequest(
        issue_type="orphan_showroom_name",
        scope="one",
        collection="invoices",
        record_ids=["i1"],
        # target_showroom_id intentionally missing
    )
    with patch("routes.data_hygiene.get_db", return_value=db):
        with pytest.raises(HTTPException) as exc:
            asyncio.run(apply_fix(req, current_user=SUPER))
        assert exc.value.status_code == 400


def test_fix_requires_super_admin():
    from routes.data_hygiene import apply_fix, FixRequest
    from fastapi import HTTPException
    db = _db(showrooms=[{"_id": "sr_tn", "name": "Tonbridge"}])
    req = FixRequest(
        issue_type="drifted_labels", scope="one", collection="users",
        showroom_id="sr_tn", record_ids=["u1"],
    )
    with patch("routes.data_hygiene.get_db", return_value=db):
        with pytest.raises(HTTPException) as exc:
            asyncio.run(apply_fix(req, current_user=NON_SUPER))
        assert exc.value.status_code == 403
