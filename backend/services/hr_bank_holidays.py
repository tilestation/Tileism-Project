"""
UK bank holidays + working-days calculator for HR leave management
(13 Jun 2026).

Thin wrapper around the existing `website_admin.get_uk_holidays_cached()`
so the HR module doesn't reach into website_admin's module-private
state. Exposes:

    is_working_day(d: date) -> bool
    working_days_between(start: date, end: date) -> int
    upcoming_bank_holidays(year: int) -> List[dict]

Working-days definition: Mon-Fri AND not a UK bank holiday (England &
Wales — that's where every Tile Station showroom is).
"""
import logging
from datetime import date, timedelta
from typing import List

logger = logging.getLogger(__name__)


async def _all_holidays() -> List[dict]:
    """Returns [{'date': 'YYYY-MM-DD', 'name': ...}, ...]"""
    try:
        # Lazy import: website_admin pulls in heavy deps + we don't want
        # to require it at module-import time.
        from routes.website_admin import get_uk_holidays_cached  # noqa: PLC0415
        return await get_uk_holidays_cached()
    except Exception:
        logger.exception("hr-bank-holidays: holiday fetch failed, using empty set")
        return []


async def holiday_dates_set() -> set:
    rows = await _all_holidays()
    return {h["date"] for h in rows if isinstance(h, dict) and h.get("date")}


async def is_working_day(d: date) -> bool:
    if d.weekday() >= 5:  # Sat/Sun
        return False
    holidays = await holiday_dates_set()
    return d.isoformat() not in holidays


async def working_days_between(start: date, end: date) -> int:
    """Inclusive count of working days from start to end. Returns 0 if
    `end < start`."""
    if end < start:
        return 0
    holidays = await holiday_dates_set()
    count = 0
    cursor = start
    one = timedelta(days=1)
    while cursor <= end:
        if cursor.weekday() < 5 and cursor.isoformat() not in holidays:
            count += 1
        cursor += one
    return count


async def upcoming_bank_holidays(year: int = None) -> List[dict]:
    """Bank holidays in the given calendar year (default: current).
    Used by the HR calendar so admins see public holidays pre-marked."""
    from datetime import datetime, timezone  # noqa: PLC0415
    y = year or datetime.now(timezone.utc).year
    rows = await _all_holidays()
    return [h for h in rows if h.get("date", "").startswith(f"{y:04d}-")]
