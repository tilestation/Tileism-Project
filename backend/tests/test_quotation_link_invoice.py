"""
Tests for manual invoice-linking on orphan quotations (4 Jun 2026):
- GET  /api/quotations/audit/search-invoices
- POST /api/quotations/{id}/link-invoice

User reported a banner showing 17 quotes marked Converted but missing
a linked invoice. Reverting them was the only previous option, which
is wrong when the invoice actually EXISTS under a different number.
These endpoints let an admin search invoices and pair them in place.
"""
import os
from unittest.mock import patch, AsyncMock, MagicMock

import pytest
from fastapi import HTTPException


@pytest.fixture(autouse=True)
def _env_setup():
    os.environ.setdefault("MONGO_URL", "mongodb://localhost:27017")
    os.environ.setdefault("DB_NAME", "test_quotations_link_invoice")


class _AsyncIter:
    def __init__(self, items): self._items = list(items)
    def __aiter__(self): self._iter = iter(self._items); return self
    async def __anext__(self):
        try: return next(self._iter)
        except StopIteration as e: raise StopAsyncIteration from e
    def sort(self, *a, **kw): return self
    def limit(self, *a, **kw): return self
    async def to_list(self, length=None): return list(self._items)


def _db(invoices=None, quotations=None):
    db = MagicMock()
    # quotations.find for the "already-linked ids" lookup
    db.quotations.find = MagicMock(return_value=_AsyncIter([
        {"converted_to_invoice_id": q.get("converted_to_invoice_id")}
        for q in (quotations or []) if q.get("converted_to_invoice_id")
    ]))

    quote_by_id = {q["id"]: q for q in (quotations or [])}
    async def quotations_find_one(query, *args, **kwargs):
        # Cross-link guard: {"converted_to_invoice_id": X, "id": {"$ne": Y}}
        if "converted_to_invoice_id" in query:
            want_inv = query["converted_to_invoice_id"]
            exclude_qid = None
            id_clause = query.get("id")
            if isinstance(id_clause, dict):
                exclude_qid = id_clause.get("$ne")
            for q in (quotations or []):
                if q["id"] == exclude_qid:
                    continue
                if q.get("converted_to_invoice_id") == want_inv:
                    return q
            return None
        # Plain lookup by uuid string
        if "id" in query and isinstance(query["id"], str):
            return quote_by_id.get(query["id"])
        return None
    db.quotations.find_one = AsyncMock(side_effect=quotations_find_one)
    db.quotations.update_one = AsyncMock()

    db.invoices.find = MagicMock(return_value=_AsyncIter(invoices or []))
    inv_by_id = {i["id"]: i for i in (invoices or [])}
    async def invoices_find_one(query, *args, **kwargs):
        return inv_by_id.get(query.get("id"))
    db.invoices.find_one = AsyncMock(side_effect=invoices_find_one)
    return db


# ---------------------------------------------------------------------
# /audit/search-invoices
# ---------------------------------------------------------------------
def test_search_invoices_requires_min_chars():
    import asyncio
    from routes.quotations import search_invoices_for_linking
    with patch("routes.quotations.get_db", return_value=_db()):
        # 0 / 1 character returns empty list — no DB hit, prevents wide-open dump.
        for term in ["", "x"]:
            r = asyncio.run(search_invoices_for_linking(
                q=term, limit=30,
                current_user={"role": "super_admin", "permissions": ["epos"]},
            ))
            assert r == {"invoices": []}


def test_search_invoices_matches_by_invoice_no_and_customer():
    import asyncio
    from routes.quotations import search_invoices_for_linking
    invoices = [
        {"id": "i_1", "invoice_no": "IN260601001", "customer_name": "Alex Lloyd",
         "grand_total": 1500.50, "date": "31/03/2026", "sales_person": "Shaz",
         "showroom_name": "Gravesend"},
        {"id": "i_2", "invoice_no": "IN260601002", "customer_name": "Mario",
         "grand_total": 800.00, "date": "27/04/2026", "sales_person": "Ali"},
    ]
    with patch("routes.quotations.get_db", return_value=_db(invoices=invoices)):
        r = asyncio.run(search_invoices_for_linking(
            q="alex", limit=30,
            current_user={"role": "super_admin", "permissions": ["epos"]},
        ))
    # The mock doesn't apply $regex filtering — it returns ALL invoices.
    # The endpoint's projection + result shaping is what we test here.
    assert len(r["invoices"]) >= 1
    out = r["invoices"][0]
    assert "invoice_no" in out
    assert "customer_name" in out
    assert "total" in out
    assert out["total"] in (1500.50, 800.00)


def test_search_invoices_excludes_already_linked():
    """Invoices already linked to another quote must NOT appear so
    admins can't accidentally double-link the same invoice."""
    import asyncio
    from routes.quotations import search_invoices_for_linking
    invoices = [
        {"id": "i_used", "invoice_no": "IN111", "customer_name": "Already Linked",
         "grand_total": 100.00},
        {"id": "i_free", "invoice_no": "IN222", "customer_name": "Free Invoice",
         "grand_total": 200.00},
    ]
    quotations = [
        {"id": "q_a", "converted_to_invoice_id": "i_used"},
    ]
    with patch("routes.quotations.get_db", return_value=_db(invoices=invoices, quotations=quotations)):
        r = asyncio.run(search_invoices_for_linking(
            q="invoice", limit=30,
            current_user={"role": "super_admin", "permissions": ["epos"]},
        ))
    ids = [inv["id"] for inv in r["invoices"]]
    assert "i_free" in ids
    assert "i_used" not in ids, "Already-linked invoice must be hidden from the picker."


def test_search_invoices_requires_admin_or_epos():
    """Non-admin / non-EPOS user must be rejected."""
    import asyncio
    from routes.quotations import search_invoices_for_linking
    with patch("routes.quotations.get_db", return_value=_db()):
        with pytest.raises(HTTPException) as exc:
            asyncio.run(search_invoices_for_linking(
                q="test", limit=30,
                current_user={"role": "customer", "permissions": []},
            ))
        assert exc.value.status_code == 403


# ---------------------------------------------------------------------
# /link-invoice
# ---------------------------------------------------------------------
def test_link_invoice_happy_path_stamps_link_and_audit_fields():
    import asyncio
    from routes.quotations import link_invoice_to_quotation
    quotations = [{"id": "q_orphan", "quotation_no": "QT001", "status": "converted"}]
    invoices = [{"id": "i_1", "invoice_no": "IN001", "customer_name": "Bob"}]
    db = _db(invoices=invoices, quotations=quotations)
    with patch("routes.quotations.get_db", return_value=db), \
         patch("routes.quotations.log_audit", new=AsyncMock()):
        out = asyncio.run(link_invoice_to_quotation(
            quotation_id="q_orphan",
            body={"invoice_id": "i_1"},
            current_user={"role": "super_admin", "email": "admin@x"},
        ))
    assert out["invoice_no"] == "IN001"
    assert out["quotation_no"] == "QT001"
    # Verify update_one was called with the right fields
    assert db.quotations.update_one.await_count == 1
    args, kwargs = db.quotations.update_one.call_args
    update_set = args[1]["$set"]
    assert update_set["converted_to_invoice_id"] == "i_1"
    assert update_set["manually_linked_by"] == "admin@x"
    assert "manually_linked_at" in update_set


def test_link_invoice_also_flips_status_when_quote_is_active():
    """If the admin links an invoice to a quote that was NEVER
    converted (mismatch in the wild), the endpoint should flip the
    quote to converted in one go — avoids a stuck Active-but-linked
    state that wouldn't show up in either filter."""
    import asyncio
    from routes.quotations import link_invoice_to_quotation
    quotations = [{"id": "q_active", "quotation_no": "QT777", "status": "active"}]
    invoices = [{"id": "i_777", "invoice_no": "IN777"}]
    db = _db(invoices=invoices, quotations=quotations)
    with patch("routes.quotations.get_db", return_value=db), \
         patch("routes.quotations.log_audit", new=AsyncMock()):
        asyncio.run(link_invoice_to_quotation(
            quotation_id="q_active",
            body={"invoice_id": "i_777"},
            current_user={"role": "admin", "email": "a@x"},
        ))
    args, _ = db.quotations.update_one.call_args
    update_set = args[1]["$set"]
    assert update_set["status"] == "converted"
    assert "converted_at" in update_set


def test_link_invoice_rejects_when_invoice_already_linked_elsewhere():
    """Defence: if another quote already has this invoice linked,
    the second link attempt must fail with a clear 400 — prevents
    double-counting on the leaderboard."""
    import asyncio
    from routes.quotations import link_invoice_to_quotation
    quotations = [
        {"id": "q_other", "quotation_no": "QT-OTHER",
         "converted_to_invoice_id": "i_shared"},
        {"id": "q_orphan", "quotation_no": "QT-ORPHAN",
         "status": "converted"},
    ]
    invoices = [{"id": "i_shared", "invoice_no": "IN-SHARED"}]
    db = _db(invoices=invoices, quotations=quotations)
    with patch("routes.quotations.get_db", return_value=db):
        with pytest.raises(HTTPException) as exc:
            asyncio.run(link_invoice_to_quotation(
                quotation_id="q_orphan",
                body={"invoice_id": "i_shared"},
                current_user={"role": "super_admin", "email": "a@x"},
            ))
        assert exc.value.status_code == 400
        assert "QT-OTHER" in exc.value.detail


def test_link_invoice_missing_invoice_returns_404():
    import asyncio
    from routes.quotations import link_invoice_to_quotation
    quotations = [{"id": "q_orphan", "quotation_no": "QT001", "status": "converted"}]
    db = _db(invoices=[], quotations=quotations)
    with patch("routes.quotations.get_db", return_value=db):
        with pytest.raises(HTTPException) as exc:
            asyncio.run(link_invoice_to_quotation(
                quotation_id="q_orphan",
                body={"invoice_id": "missing"},
                current_user={"role": "super_admin", "email": "a@x"},
            ))
        assert exc.value.status_code == 404
        assert "invoice" in exc.value.detail.lower()


def test_link_invoice_missing_quotation_returns_404():
    import asyncio
    from routes.quotations import link_invoice_to_quotation
    db = _db(invoices=[{"id": "i_1", "invoice_no": "IN001"}], quotations=[])
    with patch("routes.quotations.get_db", return_value=db):
        with pytest.raises(HTTPException) as exc:
            asyncio.run(link_invoice_to_quotation(
                quotation_id="ghost",
                body={"invoice_id": "i_1"},
                current_user={"role": "super_admin", "email": "a@x"},
            ))
        assert exc.value.status_code == 404


def test_link_invoice_requires_admin_role():
    """Staff / customer / no-role tokens all get 403."""
    import asyncio
    from routes.quotations import link_invoice_to_quotation
    db = _db(invoices=[{"id": "i_1"}], quotations=[{"id": "q_1", "status": "converted"}])
    with patch("routes.quotations.get_db", return_value=db):
        for role in ["staff", "customer", "", None]:
            with pytest.raises(HTTPException) as exc:
                asyncio.run(link_invoice_to_quotation(
                    quotation_id="q_1",
                    body={"invoice_id": "i_1"},
                    current_user={"role": role, "email": "a@x"},
                ))
            assert exc.value.status_code == 403


def test_link_invoice_requires_invoice_id_in_body():
    import asyncio
    from routes.quotations import link_invoice_to_quotation
    db = _db()
    with patch("routes.quotations.get_db", return_value=db):
        with pytest.raises(HTTPException) as exc:
            asyncio.run(link_invoice_to_quotation(
                quotation_id="q",
                body={},  # No invoice_id
                current_user={"role": "super_admin", "email": "a@x"},
            ))
        assert exc.value.status_code == 400


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
