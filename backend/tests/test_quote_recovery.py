"""
Tests for /api/quote-recovery — expired-quote listing + recovery
email + discount-code minting (3 Jun 2026).
"""
import os
from datetime import datetime, timezone, timedelta
from unittest.mock import patch, AsyncMock, MagicMock

import pytest


@pytest.fixture(autouse=True)
def _env_setup():
    os.environ.setdefault("MONGO_URL", "mongodb://localhost:27017")
    os.environ.setdefault("DB_NAME", "test_quote_recovery")


class _AsyncIter:
    def __init__(self, items):
        self._items = list(items)

    def __aiter__(self):
        self._iter = iter(self._items)
        return self

    async def __anext__(self):
        try:
            return next(self._iter)
        except StopIteration as e:
            raise StopAsyncIteration from e

    def sort(self, *a, **kw): return self
    def limit(self, *a, **kw): return self


def _quote(idx: int, *, age_days: int, converted: bool = False, email: str = "cust@example.com"):
    now = datetime.now(timezone.utc)
    return {
        "id": f"q-{idx}",
        "quote_number": f"Q-{1000 + idx}",
        "customer_name": f"Customer {idx}",
        "customer_email": email,
        "grand_total": 1000.0 + idx * 100,
        "created_at": now - timedelta(days=age_days),
        "converted_at": now if converted else None,
        "sales_person": "Syed",
        "showroom_name": "Gravesend",
    }


# ---------------------------------------------------------------------
# 1. Listing returns only old + non-converted quotes
# ---------------------------------------------------------------------
def test_list_expired_quotes_excludes_converted():
    import asyncio
    from routes.quote_recovery import list_expired_quotes
    quotes = [
        _quote(1, age_days=45),                          # expired
        _quote(2, age_days=45, converted=True),          # converted → excluded
        _quote(3, age_days=10),                          # too fresh → excluded
        _quote(4, age_days=60),                          # expired
    ]
    db = MagicMock()
    db.quotations.find = MagicMock(return_value=_AsyncIter(quotes))
    user = {"role": "super_admin", "email": "a@b"}
    with patch("routes.quote_recovery.get_db", return_value=db):
        result = asyncio.run(list_expired_quotes(limit=100, current_user=user))
    ids = [q["id"] for q in result["quotes"]]
    assert "q-1" in ids and "q-4" in ids
    assert "q-2" not in ids  # converted
    assert "q-3" not in ids  # too fresh
    assert result["total"] == 2


def test_list_includes_age_days_field():
    import asyncio
    from routes.quote_recovery import list_expired_quotes
    db = MagicMock()
    db.quotations.find = MagicMock(return_value=_AsyncIter([_quote(1, age_days=45)]))
    user = {"role": "super_admin", "email": "a@b"}
    with patch("routes.quote_recovery.get_db", return_value=db):
        result = asyncio.run(list_expired_quotes(limit=10, current_user=user))
    assert result["quotes"][0]["age_days"] is not None
    assert result["quotes"][0]["age_days"] >= 44


# ---------------------------------------------------------------------
# 2. Send-recovery mints a unique 1-use code with the admin's %
# ---------------------------------------------------------------------
def test_send_recovery_mints_code_and_logs_attempt():
    """Verify the discount code is created with the admin-picked
    percent, max_uses=1, locked to the customer email, and a recovery
    attempt is logged on the quote."""
    import asyncio
    from routes.quote_recovery import send_recovery_email, SendRecoveryReq

    db = MagicMock()
    db.quotations.find_one = AsyncMock(return_value=_quote(1, age_days=45))
    db.shop_discount_codes.find_one = AsyncMock(return_value=None)
    db.shop_discount_codes.insert_one = AsyncMock()
    db.quotations.update_one = AsyncMock()

    user = {"role": "super_admin", "email": "admin@test"}
    req = SendRecoveryReq(quote_id="q-1", percent_off=15, expires_days=21, custom_message="Stock back in")
    # Force a resend failure so the test doesn't actually send email
    # but still verifies the code-mint + log path.
    with patch("routes.quote_recovery.get_db", return_value=db), \
         patch.dict(os.environ, {"RESEND_API_KEY": ""}, clear=False):
        result = asyncio.run(send_recovery_email(req=req, current_user=user))

    assert result["percent_off"] == 15
    assert result["customer_email"] == "cust@example.com"
    assert result["code"].startswith("WB15-")
    # Code was inserted.
    db.shop_discount_codes.insert_one.assert_called_once()
    code_doc = db.shop_discount_codes.insert_one.call_args[0][0]
    assert code_doc["percent_off"] == 15
    assert code_doc["max_uses"] == 1
    assert code_doc["email"] == "cust@example.com"
    assert code_doc["source"] == "quote_recovery"
    assert code_doc["source_quote_id"] == "q-1"
    # Recovery attempt was logged on the quote.
    db.quotations.update_one.assert_called_once()
    push = db.quotations.update_one.call_args[0][1]["$push"]
    assert push["recovery_attempts"]["code"] == result["code"]
    assert push["recovery_attempts"]["percent_off"] == 15


# ---------------------------------------------------------------------
# 3. Rejects quote without customer email
# ---------------------------------------------------------------------
def test_send_recovery_rejects_no_email():
    import asyncio
    from routes.quote_recovery import send_recovery_email, SendRecoveryReq
    from fastapi import HTTPException

    q = _quote(1, age_days=45)
    q["customer_email"] = ""
    db = MagicMock()
    db.quotations.find_one = AsyncMock(return_value=q)
    user = {"role": "super_admin", "email": "admin@test"}
    req = SendRecoveryReq(quote_id="q-1", percent_off=10)
    with patch("routes.quote_recovery.get_db", return_value=db):
        with pytest.raises(HTTPException) as exc:
            asyncio.run(send_recovery_email(req=req, current_user=user))
    assert exc.value.status_code == 400
    assert "email" in exc.value.detail.lower()


# ---------------------------------------------------------------------
# 4. Non-admin roles cannot use either endpoint
# ---------------------------------------------------------------------
def test_listing_requires_admin_role():
    import asyncio
    from routes.quote_recovery import list_expired_quotes
    from fastapi import HTTPException
    db = MagicMock()
    db.quotations.find = MagicMock(return_value=_AsyncIter([]))
    with patch("routes.quote_recovery.get_db", return_value=db):
        for bad_role in ("staff", "customer", None):
            with pytest.raises(HTTPException) as exc:
                asyncio.run(list_expired_quotes(limit=10, current_user={"role": bad_role, "email": "x@y"}))
            assert exc.value.status_code == 403


def test_send_recovery_requires_admin_role():
    import asyncio
    from routes.quote_recovery import send_recovery_email, SendRecoveryReq
    from fastapi import HTTPException
    db = MagicMock()
    db.quotations.find_one = AsyncMock(return_value=_quote(1, age_days=45))
    with patch("routes.quote_recovery.get_db", return_value=db):
        req = SendRecoveryReq(quote_id="q-1", percent_off=10)
        with pytest.raises(HTTPException) as exc:
            asyncio.run(send_recovery_email(req=req, current_user={"role": "staff", "email": "s@t"}))
        assert exc.value.status_code == 403


# ---------------------------------------------------------------------
# 5. Percent boundary checks (Pydantic)
# ---------------------------------------------------------------------
@pytest.mark.parametrize("bad_pct", [0, -5, 51, 100])
def test_percent_must_be_1_to_50(bad_pct):
    from routes.quote_recovery import SendRecoveryReq
    from pydantic import ValidationError
    with pytest.raises(ValidationError):
        SendRecoveryReq(quote_id="q-1", percent_off=bad_pct)


# ---------------------------------------------------------------------
# 6. Code includes the percent prefix for traceability
# ---------------------------------------------------------------------
@pytest.mark.parametrize("pct", [5, 10, 20, 30])
def test_code_format_includes_percent(pct):
    import asyncio
    from routes.quote_recovery import send_recovery_email, SendRecoveryReq

    db = MagicMock()
    db.quotations.find_one = AsyncMock(return_value=_quote(1, age_days=45))
    db.shop_discount_codes.find_one = AsyncMock(return_value=None)
    db.shop_discount_codes.insert_one = AsyncMock()
    db.quotations.update_one = AsyncMock()
    user = {"role": "super_admin", "email": "admin@test"}
    req = SendRecoveryReq(quote_id="q-1", percent_off=pct)
    with patch("routes.quote_recovery.get_db", return_value=db):
        result = asyncio.run(send_recovery_email(req=req, current_user=user))
    assert result["code"].startswith(f"WB{pct}-"), \
        f"Code prefix must include the percent for traceability. Got {result['code']}"


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
