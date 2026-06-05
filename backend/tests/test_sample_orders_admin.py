"""
Tests for sample-orders admin endpoints + public tracking fallback
(5 Jun 2026). User reported `/shop/track` 404'd for SMP-… orders and
there was no admin page for paid sample orders.
"""
import os
from datetime import datetime, timezone
from unittest.mock import patch, AsyncMock, MagicMock

import pytest
from fastapi import HTTPException


@pytest.fixture(autouse=True)
def _env_setup():
    os.environ.setdefault("MONGO_URL", "mongodb://localhost:27017")
    os.environ.setdefault("DB_NAME", "test_sample_orders_admin")


class _AsyncIter:
    def __init__(self, items): self._items = list(items)
    def __aiter__(self): self._iter = iter(self._items); return self
    async def __anext__(self):
        try: return next(self._iter)
        except StopIteration as e: raise StopAsyncIteration from e
    def sort(self, *a, **kw): return self
    def skip(self, *a, **kw): return self
    def limit(self, *a, **kw): return self
    async def to_list(self, length=None): return list(self._items)


def _db(samples=None, orders=None):
    db = MagicMock()
    samples = samples or []
    orders = orders or []

    # shop_orders.find_one — returns None unless caller looks up an
    # order_number that matches an entry in `orders`.
    async def shop_find_one(query, *args, **kwargs):
        for o in orders:
            if "order_number" in query:
                pattern = query["order_number"]
                if hasattr(pattern, "pattern"):
                    if pattern.pattern.strip("^$").lower() == (o.get("order_number") or "").lower():
                        return o
                elif pattern == o.get("order_number"):
                    return o
        return None
    db.shop_orders.find_one = AsyncMock(side_effect=shop_find_one)

    async def sample_find_one(query, *args, **kwargs):
        for s in samples:
            # The endpoint queries by a regex on order_number AND
            # customer_email — match either via regex `.match()` or
            # via plain string equality so this helper handles both
            # the production code path and any future raw-string tests.
            def matches(field_name, doc_value):
                if field_name not in query:
                    return True
                pattern = query[field_name]
                if hasattr(pattern, "match"):
                    return pattern.match(doc_value or "") is not None
                return pattern == doc_value

            if matches("order_number", s.get("order_number")) \
               and matches("customer_email", s.get("customer_email")):
                return s
            if "id" in query and query["id"] == s.get("id"):
                return s
            if "$or" in query:
                for clause in query["$or"]:
                    if clause.get("id") == s.get("id") or clause.get("order_number") == s.get("order_number"):
                        return s
        return None
    db.sample_orders.find_one = AsyncMock(side_effect=sample_find_one)

    db.sample_orders.find = MagicMock(return_value=_AsyncIter(samples))
    db.sample_orders.count_documents = AsyncMock(return_value=len(samples))
    db.sample_orders.update_one = AsyncMock(return_value=MagicMock(matched_count=1))
    db.sample_orders.aggregate = MagicMock(return_value=_AsyncIter([{"_id": None, "sum": 12.50}]))

    db.showrooms.find_one = AsyncMock(return_value=None)
    return db


# ─────────────────────────────────────────────────────────────────
# 1. /shop/track/{order_number} falls through to sample_orders
# ─────────────────────────────────────────────────────────────────
def test_track_endpoint_returns_sample_order_when_shop_has_none():
    """The bug: customer tracked SMP-260526-81C96A → 404 because we
    only looked in shop_orders. The fix: fall through to
    sample_orders. The response shape stays the same so the public
    tracking page doesn't need to branch."""
    import asyncio
    from routes.shop import track_order_public
    samples = [{
        "id": "smp-id-1",
        "order_number": "SMP-260526-81C96A",
        "customer_email": "eviekate9@gmail.com",
        "customer_name": "Evie Taylor",
        "status": "paid",
        "paid_at": "2026-05-26T10:00:00+00:00",
        "products": [{"product_name": "Armani Marble Cream 60x60cm Matt", "price_gbp": 0}],
        "samples_subtotal": 0,
        "postage_fee": 2.99,
        "total": 2.99,
        "delivery_address": "1 High Street\nRye\nTN31 7JE",
        "created_at": "2026-05-26T09:59:00+00:00",
    }]
    with patch("routes.shop.get_db", return_value=_db(samples=samples)):
        out = asyncio.run(track_order_public(
            order_number="SMP-260526-81C96A",
            email="eviekate9@gmail.com",
        ))
    assert out["order_number"] == "SMP-260526-81C96A"
    assert out["order_kind"] == "sample"
    assert out["payment_status"] == "paid"
    assert out["status"] == "paid"
    assert out["total"] == 2.99
    assert out["delivery_fee"] == 2.99
    assert len(out["items"]) == 1
    assert out["items"][0]["name"] == "Armani Marble Cream 60x60cm Matt"
    assert out["items"][0]["is_sample"] is True
    # Address split into lines for the frontend
    assert "Rye" in out["delivery_address_lines"]


def test_track_endpoint_case_insensitive_for_sample_orders():
    """Same lookup with lowercase order number + capitalised email
    must still resolve (Gmail autofill bug we already fixed for
    shop_orders — applies here too)."""
    import asyncio
    from routes.shop import track_order_public
    samples = [{
        "id": "smp-2",
        "order_number": "SMP-260526-81C96A",
        "customer_email": "user@example.com",
        "status": "paid",
        "products": [],
        "total": 2.99, "postage_fee": 2.99, "samples_subtotal": 0,
        "created_at": "2026-05-26T09:59:00+00:00",
    }]
    with patch("routes.shop.get_db", return_value=_db(samples=samples)):
        out = asyncio.run(track_order_public(
            order_number="smp-260526-81c96a",
            email="User@Example.com",
        ))
    assert out["order_number"] == "SMP-260526-81C96A"


def test_track_endpoint_still_404s_for_unknown_order():
    import asyncio
    from routes.shop import track_order_public
    with patch("routes.shop.get_db", return_value=_db()):
        with pytest.raises(HTTPException) as exc:
            asyncio.run(track_order_public(
                order_number="SMP-NOPE", email="nobody@example.com",
            ))
        assert exc.value.status_code == 404


# ─────────────────────────────────────────────────────────────────
# 2. Admin list endpoint
# ─────────────────────────────────────────────────────────────────
def test_admin_list_sample_orders_requires_admin_role():
    import asyncio
    from routes.shop import admin_list_sample_orders
    with patch("routes.shop.get_db", return_value=_db()):
        with pytest.raises(HTTPException) as exc:
            asyncio.run(admin_list_sample_orders(
                current_user={"role": "customer"},
            ))
        assert exc.value.status_code == 403


def test_admin_list_sample_orders_returns_shaped_summary():
    import asyncio
    from routes.shop import admin_list_sample_orders
    samples = [{
        "id": "s1", "order_number": "SMP-1",
        "customer_name": "Evie", "customer_email": "e@x.com",
        "customer_phone": "07000",
        "status": "paid", "paid_at": "2026-05-26T09:59:00+00:00",
        "products": [{"product_name": "X", "price_gbp": 2.99}],
        "sample_count": 1, "paid_sample_count": 1, "free_sample_count": 0,
        "samples_subtotal": 2.99, "postage_fee": 2.99, "total": 5.98,
        "created_at": "2026-05-26T09:59:00+00:00",
    }]
    with patch("routes.shop.get_db", return_value=_db(samples=samples)):
        out = asyncio.run(admin_list_sample_orders(
            current_user={"role": "admin"},
        ))
    assert out["total"] == 1
    o = out["orders"][0]
    assert o["order_number"] == "SMP-1"
    assert o["sample_count"] == 1
    assert o["total"] == 5.98
    assert o["payment_status"] == "paid"  # derived from paid_at


def test_admin_list_sample_orders_excludes_unpaid_by_default():
    """`include_unpaid=False` (default) must build a query that
    filters out pending_payment drafts so the team only sees real
    paid orders."""
    import asyncio
    from routes.shop import admin_list_sample_orders
    db = _db()
    # Capture the find query so we can inspect the filter.
    captured = {}
    def capture(query, projection=None, **kw):
        captured["query"] = query
        return _AsyncIter([])
    db.sample_orders.find = MagicMock(side_effect=capture)
    db.sample_orders.count_documents = AsyncMock(return_value=0)
    with patch("routes.shop.get_db", return_value=db):
        asyncio.run(admin_list_sample_orders(
            current_user={"role": "admin"},
        ))
    q = captured["query"]
    # Either by status enum or by paid_at presence
    assert "$or" in q
    assert any("status" in c for c in q["$or"])
    assert any("paid_at" in c for c in q["$or"])


# ─────────────────────────────────────────────────────────────────
# 3. Admin detail + update
# ─────────────────────────────────────────────────────────────────
def test_admin_get_sample_order_returns_full_doc():
    import asyncio
    from routes.shop import admin_get_sample_order
    samples = [{
        "id": "s1", "order_number": "SMP-1",
        "customer_email": "e@x.com", "status": "paid",
        "products": [], "total": 2.99,
    }]
    with patch("routes.shop.get_db", return_value=_db(samples=samples)):
        out = asyncio.run(admin_get_sample_order(
            "s1", current_user={"role": "admin"},
        ))
    assert out["order_number"] == "SMP-1"


def test_admin_get_sample_order_404_when_missing():
    import asyncio
    from routes.shop import admin_get_sample_order
    with patch("routes.shop.get_db", return_value=_db()):
        with pytest.raises(HTTPException) as exc:
            asyncio.run(admin_get_sample_order(
                "nope", current_user={"role": "admin"},
            ))
        assert exc.value.status_code == 404


def test_admin_update_sample_order_validates_status():
    """Status must come from a closed enum so admins can't accidentally
    persist "shippd" / "delivvered" typos that break filters."""
    import asyncio
    from routes.shop import admin_update_sample_order
    samples = [{"id": "s1", "order_number": "SMP-1", "status": "paid"}]
    with patch("routes.shop.get_db", return_value=_db(samples=samples)):
        with pytest.raises(HTTPException) as exc:
            asyncio.run(admin_update_sample_order(
                "s1", body={"status": "shippd"},
                current_user={"role": "admin", "email": "a@x"},
            ))
        assert exc.value.status_code == 400
        assert "Invalid status" in exc.value.detail


def test_admin_update_sample_order_stamps_history_on_status_change():
    import asyncio
    from routes.shop import admin_update_sample_order
    samples = [{"id": "s1", "order_number": "SMP-1", "status": "paid"}]
    db = _db(samples=samples)
    with patch("routes.shop.get_db", return_value=db):
        asyncio.run(admin_update_sample_order(
            "s1", body={"status": "shipped"},
            current_user={"role": "admin", "email": "admin@x"},
        ))
    # Verify the update call carried both $set + $push (history)
    args, _ = db.sample_orders.update_one.call_args
    update_doc = args[1]
    assert "$set" in update_doc and update_doc["$set"]["status"] == "shipped"
    assert "$push" in update_doc and "status_history" in update_doc["$push"]
    assert update_doc["$push"]["status_history"]["status"] == "shipped"
    assert update_doc["$push"]["status_history"]["by"] == "admin@x"


def test_admin_update_sample_order_persists_tracking_block():
    import asyncio
    from routes.shop import admin_update_sample_order
    samples = [{"id": "s1", "order_number": "SMP-1", "status": "paid"}]
    db = _db(samples=samples)
    with patch("routes.shop.get_db", return_value=db):
        asyncio.run(admin_update_sample_order(
            "s1",
            body={"tracking": {
                "carrier": "Royal Mail",
                "tracking_number": "RM123456789GB",
                "url": "https://www.royalmail.com/track/RM123",
            }},
            current_user={"role": "admin", "email": "a@x"},
        ))
    args, _ = db.sample_orders.update_one.call_args
    tracking = args[1]["$set"]["tracking"]
    assert tracking["carrier"] == "Royal Mail"
    assert tracking["tracking_number"] == "RM123456789GB"
    assert tracking["url"].startswith("https://")


def test_admin_update_sample_order_requires_admin_role():
    import asyncio
    from routes.shop import admin_update_sample_order
    with patch("routes.shop.get_db", return_value=_db()):
        with pytest.raises(HTTPException) as exc:
            asyncio.run(admin_update_sample_order(
                "s1", body={"status": "shipped"},
                current_user={"role": "staff", "email": "s@x"},
            ))
        assert exc.value.status_code == 403


# ─────────────────────────────────────────────────────────────────
# 4. Stats endpoint
# ─────────────────────────────────────────────────────────────────
def test_admin_sample_orders_stats_returns_counters():
    import asyncio
    from routes.shop import admin_sample_orders_stats
    db = _db()
    db.sample_orders.count_documents = AsyncMock(side_effect=[3, 5, 2, 1])
    db.sample_orders.aggregate = MagicMock(return_value=_AsyncIter([{"_id": None, "sum": 17.94}]))
    with patch("routes.shop.get_db", return_value=db):
        out = asyncio.run(admin_sample_orders_stats(
            current_user={"role": "admin"},
        ))
    assert "orders_today" in out
    assert "revenue_today" in out
    assert "pending_dispatch" in out
    assert "awaiting_collection" in out
    assert "overdue" in out
    assert out["revenue_today"] == 17.94


def test_admin_sample_orders_stats_requires_admin_role():
    import asyncio
    from routes.shop import admin_sample_orders_stats
    with patch("routes.shop.get_db", return_value=_db()):
        with pytest.raises(HTTPException) as exc:
            asyncio.run(admin_sample_orders_stats(
                current_user={"role": "customer"},
            ))
        assert exc.value.status_code == 403


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
