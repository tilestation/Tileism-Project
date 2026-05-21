"""
Trader Self-Service Credit Statement
─────────────────────────────────────
Per-trader, logged-in-only endpoints so traders can self-serve their
credit balance and transaction history. Reduces inbound queries to
showroom staff ("what's my balance?") and gives traders a sense of
ongoing relationship with us.

Created 21 May 2026 per owner request: "Build a Trade Credit statement
page inside the 'Trader' section."

Endpoints:
  GET /api/trader/credit-statement
      Returns: { balance, transactions[], summary, trade_account_number }
      Query: ?days=30 (default 90) — filter txns by recency

  GET /api/trader/credit-statement/pdf
      Returns: PDF bytes — branded statement document
      Query: ?days=90

  POST /api/trader/credit-statement/email
      Sends the PDF to the trader's on-file email address.

Auth: Uses the same `get_current_user` JWT path as the trader-account
page. Customer doc is looked up by `email` (trader logged in via their
own portal account). Non-trade accounts get 403.
"""
from __future__ import annotations

import io
import logging
import os
from datetime import datetime, timezone, timedelta
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from config import get_db

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/trader", tags=["trader-credit-statement"])


# ─── Auth dependency — reuses the shop_customer JWT path ────────────────


async def _get_trader_customer(request: Request) -> dict:
    """Resolve & validate the logged-in trade customer from the JWT.

    Wraps the existing `get_shop_customer` helper in `routes/shop.py` so
    we don't duplicate JWT-decode logic. Adds the trade-account guard
    (non-trade accounts are 403'd) so callers can rely on `is_trade=True`.
    """
    from routes.shop import get_shop_customer
    cust = await get_shop_customer(request)
    if not cust.get("is_trade"):
        raise HTTPException(
            status_code=403,
            detail="This account is not a registered trade account.",
        )
    return cust


# ─── DB helpers ───────────────────────────────────────────────────────────


# Map raw ledger types into display-friendly labels and sign
_TYPE_LABELS = {
    "earned_in_store": ("Earned in store",      "+"),
    "earned_online":   ("Earned online",        "+"),
    "manual_credit":   ("Adjustment / bonus",   "+"),
    "redeem":          ("Redeemed online",      "−"),
    "redeemed_in_store": ("Redeemed in store",  "−"),
    "reverse_earned_via_refund":      ("Reversed (refund)",     "−"),
    "reverse_redeemed_via_refund":    ("Returned to balance (refund)", "+"),
    "reversed_earned_via_invoice_edit": ("Reversed (return)",   "−"),
}


def _normalise_txn(t: dict) -> dict:
    """Turn a raw ledger row into a stable shape for the frontend."""
    raw_type = (t.get("type") or "").lower()
    label, sign = _TYPE_LABELS.get(raw_type, (raw_type or "Transaction", "?"))
    amt = float(t.get("amount") or 0)
    return {
        "id": t.get("id"),
        "date": t.get("created_at"),
        "type_raw": raw_type,
        "type_label": label,
        "direction": sign,
        "amount": round(abs(amt), 2),
        "signed_amount": round(amt, 2),
        "balance_after": (
            round(float(t["balance_after"]), 2)
            if t.get("balance_after") is not None
            else None
        ),
        "invoice_no": t.get("invoice_no"),
        "order_number": t.get("order_number"),
        "description": t.get("description") or "",
    }


# ─── GET /trader/credit-statement (JSON) ──────────────────────────────────


@router.get("/credit-statement")
async def get_my_credit_statement(
    days: int = Query(90, ge=1, le=3650),
    limit: int = Query(50, ge=1, le=500),
    cust: dict = Depends(_get_trader_customer),
):
    """Return the logged-in trader's balance + their recent ledger rows."""
    db = get_db()

    since = datetime.now(timezone.utc) - timedelta(days=days)
    cursor = db.credit_transactions.find(
        {
            "customer_id": cust["id"],
            "created_at": {"$gte": since.isoformat()},
        },
        {"_id": 0},
    ).sort("created_at", -1).limit(limit)
    raw = await cursor.to_list(length=limit)

    txns = [_normalise_txn(t) for t in raw]

    # Headline metrics
    balance = float(cust.get("credit_balance") or 0)
    earned_window = sum(t["amount"] for t in txns if t["direction"] == "+")
    redeemed_window = sum(t["amount"] for t in txns if t["direction"] == "−")

    return {
        "trade_account_number": cust.get("trade_account_number") or "",
        "business_name": cust.get("business_name") or "",
        "customer_name": cust.get("name") or cust.get("email") or "",
        "balance": round(balance, 2),
        "credit_rate": float(cust.get("credit_rate") or 5.0),
        "tier": cust.get("tier") or "Bronze",
        "window_days": days,
        "summary": {
            "earned_in_window": round(earned_window, 2),
            "redeemed_in_window": round(redeemed_window, 2),
            "transactions_in_window": len(txns),
        },
        "transactions": txns,
    }


# ─── GET /trader/credit-statement/pdf ─────────────────────────────────────


def _render_statement_pdf(
    cust: dict,
    txns: list[dict],
    balance: float,
    days: int,
) -> bytes:
    """Build a clean, branded PDF statement using reportlab."""
    from reportlab.lib.pagesizes import A4
    from reportlab.lib import colors
    from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
    from reportlab.platypus import (
        SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle, Image,
    )
    from reportlab.lib.units import mm

    buf = io.BytesIO()
    doc = SimpleDocTemplate(
        buf, pagesize=A4,
        leftMargin=18 * mm, rightMargin=18 * mm,
        topMargin=18 * mm, bottomMargin=18 * mm,
    )
    styles = getSampleStyleSheet()
    h1 = ParagraphStyle(
        "H1", parent=styles["Heading1"], fontSize=18, textColor=colors.HexColor("#1a1a2e"),
        spaceAfter=4, leading=22,
    )
    sub = ParagraphStyle(
        "Sub", parent=styles["Normal"], fontSize=10, textColor=colors.HexColor("#6b7280"),
        spaceAfter=14,
    )
    small = ParagraphStyle(
        "Small", parent=styles["Normal"], fontSize=9, textColor=colors.HexColor("#6b7280"),
    )

    story = []
    today = datetime.now(timezone.utc).strftime("%d %b %Y")
    story.append(Paragraph("Trade Credit Statement", h1))
    story.append(Paragraph(
        f"Generated {today} · Last {days} days", sub,
    ))

    # ── Account info + balance card ──
    info_cell_l = (
        f"<b>{cust.get('business_name') or cust.get('name') or ''}</b><br/>"
        f"{cust.get('name') or ''}<br/>"
        f"<font color='#6b7280' size='9'>Trade ref: "
        f"<b>{cust.get('trade_account_number') or '—'}</b></font>"
    )
    info_cell_r = (
        f"<font color='#6b7280' size='9'>Current balance</font><br/>"
        f"<font size='22' color='#059669'><b>£{balance:.2f}</b></font><br/>"
        f"<font color='#6b7280' size='9'>"
        f"Credit-back rate: {float(cust.get('credit_rate') or 5.0):.1f}%"
        f"</font>"
    )
    info_tbl = Table(
        [[Paragraph(info_cell_l, styles["Normal"]), Paragraph(info_cell_r, styles["Normal"])]],
        colWidths=[100 * mm, 70 * mm],
    )
    info_tbl.setStyle(TableStyle([
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("ALIGN", (1, 0), (1, 0), "RIGHT"),
        ("BACKGROUND", (0, 0), (-1, -1), colors.HexColor("#f9fafb")),
        ("BOX", (0, 0), (-1, -1), 1, colors.HexColor("#e5e7eb")),
        ("LEFTPADDING", (0, 0), (-1, -1), 12),
        ("RIGHTPADDING", (0, 0), (-1, -1), 12),
        ("TOPPADDING", (0, 0), (-1, -1), 12),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 12),
    ]))
    story.append(info_tbl)
    story.append(Spacer(1, 14))

    # ── Transactions table ──
    story.append(Paragraph(
        f"<b>Transactions</b> <font color='#9ca3af'>· {len(txns)} entries</font>",
        ParagraphStyle("H2", parent=styles["Normal"], fontSize=12,
                       textColor=colors.HexColor("#1a1a2e"), spaceAfter=6),
    ))

    header = ["Date", "Type", "Ref", "Amount", "Balance"]
    rows = [header]
    cell_style = ParagraphStyle("C", parent=styles["Normal"], fontSize=8, leading=10)
    for t in txns:
        date_str = ""
        try:
            date_str = datetime.fromisoformat(
                (t.get("date") or "").replace("Z", "+00:00")
            ).strftime("%d %b %Y")
        except Exception:
            date_str = (t.get("date") or "")[:10]
        ref = t.get("invoice_no") or t.get("order_number") or "—"
        sign = t.get("direction") or ""
        amount_str = f"{sign}£{t.get('amount', 0):.2f}"
        amount_color = "#059669" if sign == "+" else ("#dc2626" if sign == "−" else "#6b7280")
        bal_str = (
            f"£{t['balance_after']:.2f}"
            if t.get("balance_after") is not None else "—"
        )
        rows.append([
            Paragraph(date_str, cell_style),
            Paragraph(t.get("type_label") or "", cell_style),
            Paragraph(str(ref), cell_style),
            Paragraph(
                f"<font color='{amount_color}'><b>{amount_str}</b></font>",
                cell_style,
            ),
            Paragraph(bal_str, cell_style),
        ])

    if len(rows) == 1:
        rows.append([Paragraph(
            "<i>No transactions in this period.</i>", cell_style,
        ), "", "", "", ""])
    txns_tbl = Table(
        rows, colWidths=[22 * mm, 55 * mm, 35 * mm, 28 * mm, 28 * mm],
        repeatRows=1,
    )
    txns_tbl.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#1a1a2e")),
        ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
        ("FONTSIZE", (0, 0), (-1, 0), 9),
        ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
        ("ALIGN", (3, 0), (-1, -1), "RIGHT"),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("LINEBELOW", (0, 0), (-1, -1), 0.4, colors.HexColor("#e5e7eb")),
        ("LEFTPADDING", (0, 0), (-1, -1), 6),
        ("RIGHTPADDING", (0, 0), (-1, -1), 6),
        ("TOPPADDING", (0, 0), (-1, -1), 6),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
        ("ROWBACKGROUNDS", (0, 1), (-1, -1),
         [colors.white, colors.HexColor("#f9fafb")]),
    ]))
    story.append(txns_tbl)
    story.append(Spacer(1, 18))

    story.append(Paragraph(
        "Credit is non-transferable, has no cash value, and can be "
        "redeemed against your next purchase across any Tile Station "
        "showroom or our online store. Contact your local showroom "
        "for any questions about this statement.",
        small,
    ))
    story.append(Spacer(1, 6))
    story.append(Paragraph(
        "Tile Station Group · Company No: 11982550 · VAT No: 324 251 828",
        small,
    ))

    doc.build(story)
    return buf.getvalue()


@router.get("/credit-statement/pdf")
async def download_my_credit_statement_pdf(
    days: int = Query(90, ge=1, le=3650),
    cust: dict = Depends(_get_trader_customer),
):
    db = get_db()
    since = datetime.now(timezone.utc) - timedelta(days=days)
    cursor = db.credit_transactions.find(
        {"customer_id": cust["id"], "created_at": {"$gte": since.isoformat()}},
        {"_id": 0},
    ).sort("created_at", -1).limit(500)
    raw = await cursor.to_list(length=500)
    txns = [_normalise_txn(t) for t in raw]

    pdf_bytes = _render_statement_pdf(
        cust, txns, float(cust.get("credit_balance") or 0), days,
    )
    filename = (
        f"trade-credit-statement-"
        f"{cust.get('trade_account_number') or 'account'}-"
        f"{datetime.now(timezone.utc).strftime('%Y%m%d')}.pdf"
    )
    return StreamingResponse(
        io.BytesIO(pdf_bytes),
        media_type="application/pdf",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


# ─── POST /trader/credit-statement/email ──────────────────────────────────


class _EmailRequest(BaseModel):
    days: int = 90


@router.post("/credit-statement/email")
async def email_my_credit_statement(
    payload: _EmailRequest,
    cust: dict = Depends(_get_trader_customer),
):
    """Send the PDF statement to the trader's on-file email."""
    db = get_db()
    to_email = cust.get("email")
    if not to_email:
        raise HTTPException(status_code=400, detail="No email on file")

    since = datetime.now(timezone.utc) - timedelta(days=payload.days)
    raw = await db.credit_transactions.find(
        {"customer_id": cust["id"], "created_at": {"$gte": since.isoformat()}},
        {"_id": 0},
    ).sort("created_at", -1).limit(500).to_list(length=500)
    txns = [_normalise_txn(t) for t in raw]
    pdf_bytes = _render_statement_pdf(
        cust, txns, float(cust.get("credit_balance") or 0), payload.days,
    )

    try:
        from services.email import (
            send_simple_email_if_possible, render_email_signature,
        )
        signature_html = render_email_signature(None)
        balance = float(cust.get("credit_balance") or 0)
        html = (
            f"<div style='font-family:Arial,Helvetica,sans-serif;color:#1f2937;'>"
            f"<p>Hi {cust.get('name') or 'there'},</p>"
            f"<p>Here's your trade credit statement covering the last "
            f"<strong>{payload.days} days</strong>.</p>"
            f"<p>Your current balance is <strong style='color:#059669;'>"
            f"£{balance:.2f}</strong>.</p>"
            f"<p>The full statement is attached as a PDF.</p>"
            f"<p>Best regards,<br/><strong>The Tile Station Team</strong></p>"
            f"{signature_html}"
            f"</div>"
        )
        send_result = await send_simple_email_if_possible(
            to_email,
            f"Your trade credit statement · Balance £{balance:.2f}",
            html,
            attachments=[{
                "filename": f"trade-credit-statement-{cust.get('trade_account_number','')}.pdf",
                "content": pdf_bytes,
                "content_type": "application/pdf",
            }],
            from_override="Tile Station <online@tilestation.co.uk>",
        )
    except Exception as exc:
        logger.exception("Trader self-service statement email failed")
        raise HTTPException(status_code=502, detail=f"Send failed: {exc}")

    if not (send_result or {}).get("success"):
        raise HTTPException(
            status_code=502,
            detail=f"Send failed: {(send_result or {}).get('error') or 'unknown error'}",
        )
    return {"success": True, "email": to_email}
