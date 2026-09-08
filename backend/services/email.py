"""
Email services using Resend
"""
import os
import asyncio
import logging
from datetime import datetime, timezone

try:
    import resend
    RESEND_AVAILABLE = True
except ImportError:
    RESEND_AVAILABLE = False

RESEND_API_KEY = os.environ.get("RESEND_API_KEY")

# Shared constants — defined here (top of module) so any helper below
# can reference them without an order-dependent import cycle.
COMPANY_NAME = "Tile Station"
COMPANY_WEBSITE = os.environ.get("SHOP_WEBSITE_URL", "https://tilestation.co.uk")
SENDER_EMAIL = os.environ.get("SENDER_EMAIL", "gravesend@tilestation.co.uk")
ADMIN_EMAIL = os.environ.get("ADMIN_EMAIL", "qasim@tilestation.co.uk")

# Store email mapping
SHOWROOM_EMAILS = {
    "gravesend": "gravesend@tilestation.co.uk",
    "tonbridge": "tonbridge@tilestation.co.uk", 
    "chingford": "chingford@tilestation.co.uk",
    "sydenham": "sydenham@tilestation.co.uk",
}


async def _render_trade_credit_balance_banner_html(customer_email: str) -> str:
    """
    Personalised "💷 You have £X credit ready to spend" banner injected at
    the top of every transactional email a TRADE customer receives — order
    confirmations, status updates, etc. Top-of-inbox placement of their own
    accrued balance turns every routine email into a passive redemption nudge.

    Renders ONLY when:
      • The recipient is a registered trade customer (`is_trade=True`)
      • Their `credit_balance` is strictly > £0

    Returns empty string in every other case (silent fallback) so a missing
    customer record or a £0 balance never leaks an awkward placeholder.
    """
    if not customer_email:
        return ""
    try:
        from config import get_db
        db = get_db()
        cust = await db.shop_customers.find_one(
            {"email": (customer_email or "").lower().strip()},
            {
                "_id": 0, "is_trade": 1, "credit_balance": 1,
                "trade_account_number": 1, "business_name": 1, "name": 1,
            },
        )
    except Exception:
        return ""
    if not cust or not cust.get("is_trade"):
        return ""
    balance = float(cust.get("credit_balance") or 0)
    if balance <= 0:  # NB: explicit per user request — no balance, no banner
        return ""

    t_ref = (cust.get("trade_account_number") or "").strip()
    spend_url = f"{COMPANY_WEBSITE}/shop/trade/account"
    return f"""
    <div style="margin: 0 0 16px 0; background: linear-gradient(135deg, #047857 0%, #059669 100%); border-radius: 12px; padding: 16px 20px; color: #ffffff;">
        <div style="display:flex; align-items:center; justify-content:space-between; gap:12px; flex-wrap:wrap;">
            <div style="min-width:0;">
                <div style="font-size:11px; font-weight:700; letter-spacing:0.1em; text-transform:uppercase; color:rgba(255,255,255,0.85);">
                    Your trade credit
                </div>
                <div style="font-size:20px; font-weight:700; line-height:1.3; margin-top:2px;">
                    💷 You have £{balance:.2f} ready to spend
                </div>
                {f'<div style="font-size:12px; color:rgba(255,255,255,0.85); margin-top:2px;">Account {t_ref}</div>' if t_ref else ''}
            </div>
            <a href="{spend_url}"
               style="display:inline-block; background:#1a1a2e; color:#f0c14b; padding:10px 18px; border-radius:8px; text-decoration:none; font-weight:700; font-size:13px; white-space:nowrap;">
                Spend now →
            </a>
        </div>
    </div>
    """


# Default email if showroom not found
DEFAULT_EMAIL = "gravesend@tilestation.co.uk"

# ─── Per-showroom contact card ─────────────────────────────────────────────
# Single source of truth for which phone, address, and reply-to email
# appears on EPOS-sent documents (Invoices, Proforma, Quotations, etc.)
# Keep in sync with /app/backend/business_config/showrooms.py.
#
# WHY this exists (20 May 2026 — user-reported bug):
#   "When Tonbridge staff sends a copy of invoice to customer, it goes to
#    customer via gravesend@tilestation.co.uk."
# The invoice email endpoint had `from` and the entire footer hardcoded
# to Gravesend. Customers got Tonbridge invoices stamped with Gravesend
# contact details. This helper makes the showroom's identity flow through
# every document email path.
SHOWROOM_CONTACTS = {
    "gravesend": {
        "name": "Tile Station Gravesend",
        "email": "gravesend@tilestation.co.uk",
        "phone": "01474 878 989",
        "address": "Unit 3 Trade City, Coldharbour Road, Northfleet, Gravesend",
        "postcode": "DA11 8AB",
    },
    "tonbridge": {
        "name": "Tile Station Tonbridge",
        "email": "tonbridge@tilestation.co.uk",
        "phone": "01732 914 374",
        "address": "Unit 6, 402 Vale Road, Postern Industrial Estate, Tonbridge, Kent",
        "postcode": "TN9 1SP",
    },
    "chingford": {
        "name": "Tile Station Chingford",
        "email": "chingford@tilestation.co.uk",
        "phone": "020 8527 1363",
        "address": "Unit 10, Deacon Trading Estate, Chingford, London",
        "postcode": "E4 8QF",
    },
    "sydenham": {
        "name": "Tile Station Sydenham",
        "email": "sydenham@tilestation.co.uk",
        "phone": "0204 629 7435",
        "address": "Unit 2, Sydenham Industrial Estate, Langley Bridge Road, Sydenham, London",
        "postcode": "SE26 5BA",
    },
}

# Gravesend is the head-office fallback when an invoice has no showroom_id
# or matches an unknown slug.
_FALLBACK_CONTACT = SHOWROOM_CONTACTS["gravesend"]


def get_showroom_contact(showroom: dict | str | None = None) -> dict:
    """Resolve a full contact card (name, email, phone, address, postcode)
    for a showroom doc OR a showroom slug/name string.

    Order of resolution:
      1) If `showroom` is a dict, prefer its own `id`/`name`/`slug` fields
         when looking up in `SHOWROOM_CONTACTS`. If the dict already has
         a phone/email/address, those values win over the static defaults
         (so DB edits propagate through).
      2) Partial substring match on slug → "Tile Station Tonbridge" still
         resolves to `tonbridge`.
      3) Final fallback: head-office Gravesend.

    The returned dict is always SAFE to render — every key is present.
    """
    base = dict(_FALLBACK_CONTACT)

    if showroom is None:
        return base

    # Coerce to slug-style key
    if isinstance(showroom, str):
        candidate = showroom.lower().strip()
        showroom_dict = None
    else:
        showroom_dict = showroom
        candidate = (
            (showroom.get("id") or "")
            or (showroom.get("slug") or "")
            or (showroom.get("name") or "")
        ).lower().strip()

    # Direct slug match
    for slug, contact in SHOWROOM_CONTACTS.items():
        if slug == candidate or slug in candidate:
            base = dict(contact)
            break

    # Let DB-stored values override static defaults — covers admin edits.
    if showroom_dict:
        for key in ("name", "email", "phone", "address", "postcode"):
            v = showroom_dict.get(key)
            if v:
                base[key] = v

    return base


def get_showroom_email(showroom_name: str = None) -> str:
    """Get the email address for a showroom"""
    if not showroom_name:
        return DEFAULT_EMAIL
    
    # Normalize showroom name to lowercase for matching
    showroom_key = showroom_name.lower().strip()
    
    # Direct match
    if showroom_key in SHOWROOM_EMAILS:
        return SHOWROOM_EMAILS[showroom_key]
    
    # Partial match (e.g., "Gravesend Store" -> "gravesend")
    for key, email in SHOWROOM_EMAILS.items():
        if key in showroom_key:
            return email
    
    return DEFAULT_EMAIL


# ─── Branded HTML email signature ──────────────────────────────────────────
# Logo URL (lifted from the production website header). Hosted by us so it
# never breaks if a third-party CDN goes down. The `tilestation-logo.png`
# is the yellow "Tile Station" wordmark + roof icon.
EMAIL_SIGNATURE_LOGO_URL = (
    "https://www.tilestation.co.uk/images/tilestation-logo.png"
)


def render_email_signature(showroom: dict | str | None = None, sender_name: str | None = None) -> str:
    """Return a fully-styled HTML email signature for the given showroom.

    Uses a TABLE-based layout with inline CSS so it renders correctly in
    Outlook 2019/365 / Gmail / Apple Mail / Yahoo / Thunderbird — flexbox
    and CSS Grid are not supported in most email clients.

    Layout:
        ┌───────────────────────────────────────────────┐
        │  [Logo]   <name (optional)>                   │
        │           Tile Station Tonbridge              │
        │           Address line 1, line 2              │
        │           Postcode                            │
        │           ──────────                          │
        │           ☎ 01732 914 374                     │
        │           ✉ tonbridge@tilestation.co.uk       │
        │           🌐 tilestation.co.uk                │
        │           ──────────                          │
        │           Amazing Tiles. Beautiful Bathrooms. │
        │           Excellent Service.                  │
        └───────────────────────────────────────────────┘

    Args:
        showroom: dict (showroom doc), slug string, or None (Gravesend fallback)
        sender_name: optional staff name (e.g. "Sarah" — shown above the showroom
                     name in bold, so customers know who emailed them).

    Returns: HTML <table>...</table> string ready to drop into any email body.
    """
    contact = get_showroom_contact(showroom)
    site_url = COMPANY_WEBSITE.rstrip("/")
    site_label = site_url.replace("https://", "").replace("http://", "").replace("www.", "")

    # Sender name block — only rendered when provided
    sender_block = (
        f"<div style=\"font-size:15px;font-weight:700;color:#1a1a2e;margin:0 0 2px 0;line-height:1.3;\">"
        f"{sender_name}"
        f"</div>"
    ) if sender_name else ""

    return f"""
<table cellpadding="0" cellspacing="0" border="0" style="font-family:Arial,Helvetica,sans-serif;border-collapse:collapse;margin-top:24px;max-width:520px;">
  <tr>
    <!-- Logo column -->
    <td valign="top" style="padding-right:18px;border-right:3px solid #f0c14b;">
      <a href="{site_url}" style="text-decoration:none;">
        <img src="{EMAIL_SIGNATURE_LOGO_URL}" alt="Tile Station" width="120" style="display:block;border:0;outline:none;text-decoration:none;width:120px;height:auto;" />
      </a>
    </td>
    <!-- Details column -->
    <td valign="top" style="padding-left:18px;color:#374151;font-size:13px;line-height:1.55;">
      {sender_block}
      <div style="font-size:15px;font-weight:700;color:#1a1a2e;letter-spacing:0.2px;margin:0 0 6px 0;line-height:1.3;">
        {contact['name']}
      </div>
      <div style="color:#6b7280;font-size:12px;line-height:1.45;margin:0 0 10px 0;">
        {contact['address']}<br/>
        <strong style="color:#374151;letter-spacing:0.5px;">{contact['postcode']}</strong>
      </div>
      <table cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;">
        <tr>
          <td style="padding:2px 0;font-size:13px;color:#374151;">
            <span style="color:#f0c14b;font-weight:700;margin-right:8px;">☎</span>
            <a href="tel:{contact['phone'].replace(' ', '')}" style="color:#374151;text-decoration:none;font-weight:600;">{contact['phone']}</a>
          </td>
        </tr>
        <tr>
          <td style="padding:2px 0;font-size:13px;color:#374151;">
            <span style="color:#f0c14b;font-weight:700;margin-right:8px;">✉</span>
            <a href="mailto:{contact['email']}" style="color:#374151;text-decoration:none;">{contact['email']}</a>
          </td>
        </tr>
        <tr>
          <td style="padding:2px 0;font-size:13px;color:#374151;">
            <span style="color:#f0c14b;font-weight:700;margin-right:8px;">🌐</span>
            <a href="{site_url}" style="color:#374151;text-decoration:none;">{site_label}</a>
          </td>
        </tr>
      </table>
      <div style="margin-top:10px;padding-top:8px;border-top:1px solid #e5e7eb;font-size:11px;color:#9ca3af;font-style:italic;letter-spacing:0.2px;">
        Amazing Tiles · Beautiful Bathrooms · Excellent Service
      </div>
    </td>
  </tr>
</table>
""".strip()


async def send_order_confirmation_email(invoice: dict):
    """Send order confirmation email to customer after invoice creation"""
    if not RESEND_AVAILABLE or not RESEND_API_KEY:
        logging.warning("Resend not available, skipping email")
        return
    
    customer_email = invoice.get("customer_email")
    if not customer_email:
        return
    
    invoice_no = invoice.get("invoice_no", "N/A")
    customer_name = invoice.get("customer_name", "Customer")
    gross_total = invoice.get("gross_total", 0)
    showroom_name = invoice.get("showroom_name", "Tile Station")
    line_items = invoice.get("line_items", [])
    
    # Get showroom email
    from_email = get_showroom_email(showroom_name)
    
    # Calculate deposits and outstanding
    deposits = invoice.get("deposits", [])
    total_deposits = sum(float(d.get("amount", 0)) for d in deposits if d.get("amount"))
    outstanding = gross_total - total_deposits
    
    # Build items table HTML
    items_html = ""
    for item in line_items:
        items_html += f"""
        <tr>
            <td style="padding: 8px; border-bottom: 1px solid #eee;">{item.get('product_name', '')}</td>
            <td style="padding: 8px; border-bottom: 1px solid #eee; text-align: center;">{item.get('quantity', 0)}</td>
            <td style="padding: 8px; border-bottom: 1px solid #eee; text-align: right;">£{item.get('total', 0):.2f}</td>
        </tr>
        """
    
    html_content = f"""
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <div style="background: #1a1a2e; color: white; padding: 20px; text-align: center;">
            <h1 style="margin: 0; color: #f0c14b;">TILE STATION</h1>
            <p style="margin: 5px 0 0 0; font-size: 14px;">Amazing Tiles - Beautiful Bathrooms - Excellent Service</p>
        </div>
        
        <div style="padding: 30px; background: #f9f9f9;">
            <h2 style="color: #1a1a2e; margin-top: 0;">Order Confirmation</h2>
            <p>Dear {customer_name},</p>
            
            <p>Thank you for your order! We're pleased to confirm that we have received your order <strong>#{invoice_no}</strong>.</p>
            
            <div style="background: white; padding: 20px; border-radius: 8px; margin: 20px 0; border-left: 4px solid #f0c14b;">
                <h3 style="margin-top: 0; color: #1a1a2e;">Order Summary</h3>
                <table style="width: 100%; border-collapse: collapse;">
                    <thead>
                        <tr style="background: #f5f5f5;">
                            <th style="padding: 10px; text-align: left;">Product</th>
                            <th style="padding: 10px; text-align: center;">Qty</th>
                            <th style="padding: 10px; text-align: right;">Total</th>
                        </tr>
                    </thead>
                    <tbody>
                        {items_html}
                    </tbody>
                </table>
                
                <div style="margin-top: 15px; padding-top: 15px; border-top: 2px solid #1a1a2e;">
                    <table style="width: 100%;">
                        <tr>
                            <td style="padding: 5px 0;"><strong>Order Total:</strong></td>
                            <td style="text-align: right; font-size: 18px; color: #1a1a2e;"><strong>£{gross_total:.2f}</strong></td>
                        </tr>
                        {'<tr><td style="padding: 5px 0;">Amount Paid:</td><td style="text-align: right;">£' + f'{total_deposits:.2f}' + '</td></tr>' if total_deposits > 0 else ''}
                        {'<tr style="color: #d97706;"><td style="padding: 5px 0;"><strong>Outstanding:</strong></td><td style="text-align: right;"><strong>£' + f'{outstanding:.2f}' + '</strong></td></tr>' if outstanding > 0.01 else ''}
                    </table>
                </div>
            </div>
            
            <div style="background: #e8f4e8; padding: 15px; border-radius: 8px; margin: 20px 0;">
                <p style="margin: 0; color: #2d5a2d;"><strong>What's Next?</strong></p>
                <p style="margin: 10px 0 0 0; color: #2d5a2d;">Our team at <strong>{showroom_name}</strong> will process your order shortly. We'll be in touch if we need any additional information.</p>
            </div>
            
            <p>If you have any questions about your order, please don't hesitate to contact us.</p>
            
            <p style="margin-top: 30px;">
                Best regards,<br>
                <strong>{showroom_name} - Tile Station</strong><br>
                Tel: 01474 878 989<br>
                Email: {from_email}
            </p>
        </div>
        
        <div style="background: #1a1a2e; color: #888; padding: 15px; text-align: center; font-size: 12px;">
            <p style="margin: 0;">Unit 3 Trade City, Coldharbour Road, Northfleet, Gravesend DA11 8AB</p>
            <p style="margin: 5px 0 0 0;">Company No: 11982550 | VAT No: 324 251 828</p>
        </div>
    </div>
    """
    
    resend.api_key = RESEND_API_KEY
    payload = {
        "from": f"{showroom_name} - Tile Station <{from_email}>",
        "to": [customer_email],
        "subject": f"Order Confirmation #{invoice_no} - {showroom_name}",
        "html": html_content,
    }

    # Attach HMRC-compliant VAT invoice PDF when the invoice is VATable.
    # Cash quotation conversions (apply_vat=False) skip the attachment so
    # we don't email a 0% VAT receipt that would confuse the customer.
    # Both retail and trade customers receive the PDF — the same VAT
    # invoice they could otherwise download from their dashboard.
    try:
        if invoice.get("apply_vat") is not False:
            from services.vat_invoice_pdf import (
                generate_vat_invoice_pdf_bytes,
                epos_invoice_to_order_and_customer,
                REPORTLAB_AVAILABLE,
            )
            import base64 as _b64
            if REPORTLAB_AVAILABLE:
                order_dict, customer_stub = epos_invoice_to_order_and_customer(invoice)
                pdf_bytes = await asyncio.to_thread(
                    generate_vat_invoice_pdf_bytes,
                    order_dict,
                    customer_stub,
                )
                if pdf_bytes:
                    payload["attachments"] = [{
                        "filename": f"VAT-Invoice-{invoice_no}.pdf",
                        "content": _b64.b64encode(pdf_bytes).decode("ascii"),
                    }]
    except Exception as _pdf_err:
        # Never block the confirmation email on a PDF generation failure —
        # the staff can always resend the VAT invoice manually from the
        # admin EPOS UI. Log so the next deploy can investigate.
        logging.warning(
            f"[order-confirm] VAT PDF attach failed for invoice "
            f"{invoice_no}: {_pdf_err}"
        )

    await asyncio.to_thread(resend.Emails.send, payload)


async def send_trade_credit_earned_email(
    invoice: dict,
    trade_customer: dict,
    credits_earned: float,
    balance_after: float,
) -> dict:
    """
    Trade re-engagement email — fires once per in-store invoice that accrued
    credit-back for a trade customer. Plays the same role for in-store
    purchases as the online order-confirmation email plays for web orders:
    a celebratory "you just earned £X at {showroom}" nudge that reminds the
    trader the balance is there to be spent on their next visit.

    Returns {"sent": bool, "error": str | None} so the caller can log delivery
    status on the invoice for audit / debugging purposes.
    """
    if not RESEND_AVAILABLE or not RESEND_API_KEY:
        return {"sent": False, "error": "resend_not_configured"}

    customer_email = invoice.get("customer_email")
    if not customer_email or credits_earned <= 0:
        return {"sent": False, "error": "skipped_no_email_or_zero_credit"}

    invoice_no = invoice.get("invoice_no", "")
    net_subtotal = float(invoice.get("subtotal") or 0)
    gross_total = float(invoice.get("gross_total") or 0)
    showroom_name = invoice.get("showroom_name", "Tile Station")
    credit_rate = float(invoice.get("trade_credit_rate") or 0)
    breakdown_rows = invoice.get("trade_credit_breakdown") or []
    t_ref = (trade_customer.get("trade_account_number") or "").strip()
    business_name = trade_customer.get("business_name") or trade_customer.get("name") or "there"
    first_name = (business_name.split(" ")[0] if business_name else "there")
    from_email = get_showroom_email(showroom_name)

    # Deep-link the trader straight to their dashboard to redeem the balance
    dashboard_url = f"{COMPANY_WEBSITE}/shop/trade/account"

    # ── Per-line credit-back breakdown HTML (optional) ─────────────────
    # When the invoice carries a `trade_credit_breakdown` array (stamped
    # for every invoice created after the per-product credit-back rollout
    # on 30-Apr-2026), render an audit-grade itemised table under the
    # summary card. Traders forward this email to their accountant for
    # month-end reconciliation, so every line needs to be visible — not
    # hidden behind a blended rate.
    breakdown_html = ""
    if breakdown_rows:
        rows_html = []
        for row in breakdown_rows:
            try:
                name = str(row.get("product_name") or row.get("sku") or "Line item")
                # Truncate server-side so long supplier SKUs don't break
                # the single-column layout on narrow Gmail mobile views.
                if len(name) > 48:
                    name = name[:47] + "…"
                rate = float(row.get("rate") or 0)
                net = float(row.get("net") or 0)
                credit = float(row.get("credit") or 0)
                rate_txt = f"{rate:g}% × £{net:.2f}"
                rows_html.append(f"""
                    <tr>
                        <td style="padding:8px 12px; color:#171717; font-size:13px; border-bottom:1px solid #f3f4f6;">{name}</td>
                        <td style="padding:8px 12px; color:#525252; font-size:13px; text-align:right; white-space:nowrap; border-bottom:1px solid #f3f4f6;">{rate_txt}</td>
                        <td style="padding:8px 12px; color:#047857; font-size:13px; font-weight:600; text-align:right; white-space:nowrap; border-bottom:1px solid #f3f4f6;">£{credit:.2f}</td>
                    </tr>
                """)
            except (TypeError, ValueError):
                continue
        if rows_html:
            rows_joined = "".join(rows_html)
            breakdown_html = f"""
            <div style="background: #ffffff; border: 1px solid #d1fae5; border-radius: 8px; padding: 0; margin: 20px 0; overflow:hidden;">
                <div style="background:#ecfdf5; padding:10px 14px; border-bottom:1px solid #d1fae5;">
                    <p style="margin:0; font-size:12px; font-weight:700; letter-spacing:0.5px; text-transform:uppercase; color:#047857;">Per-product credit breakdown</p>
                    <p style="margin:2px 0 0 0; font-size:12px; color:#525252;">Each line on this invoice earns credit at that product's specific rate.</p>
                </div>
                <table style="width:100%; border-collapse:collapse;">
                    <thead>
                        <tr style="background:#f9fafb;">
                            <th style="padding:6px 12px; font-size:11px; text-align:left; text-transform:uppercase; letter-spacing:0.5px; color:#525252; border-bottom:1px solid #e5e7eb;">Product</th>
                            <th style="padding:6px 12px; font-size:11px; text-align:right; text-transform:uppercase; letter-spacing:0.5px; color:#525252; border-bottom:1px solid #e5e7eb;">Rate × Net</th>
                            <th style="padding:6px 12px; font-size:11px; text-align:right; text-transform:uppercase; letter-spacing:0.5px; color:#525252; border-bottom:1px solid #e5e7eb;">Credit</th>
                        </tr>
                    </thead>
                    <tbody>
                        {rows_joined}
                        <tr style="background:#ecfdf5;">
                            <td style="padding:10px 12px; color:#047857; font-weight:700; font-size:13px;" colspan="2">Total credit earned</td>
                            <td style="padding:10px 12px; color:#047857; font-weight:700; font-size:14px; text-align:right; white-space:nowrap;">£{credits_earned:.2f}</td>
                        </tr>
                    </tbody>
                </table>
                <p style="margin:0; padding:8px 14px; font-size:11px; color:#6b7280; background:#fafaf9; border-top:1px solid #f3f4f6;">
                    Forward this email to your accountant for itemised records.
                </p>
            </div>
            """

    html_content = f"""
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; color: #1a1a2e;">
        <div style="background: linear-gradient(135deg, #047857 0%, #059669 100%); color: white; padding: 28px 24px; text-align: center;">
            <div style="display:inline-block; background:#f0c14b; color:#1a1a2e; font-weight:700; font-size:11px; letter-spacing:1px; padding:4px 10px; border-radius:999px;">TRADE CREDIT EARNED</div>
            <h1 style="margin: 12px 0 4px 0; color: #ffffff; font-size: 28px;">
                You just earned £{credits_earned:.2f} credit
            </h1>
            <p style="margin: 0; color: #d1fae5; font-size: 14px;">at {showroom_name}, thanks {first_name}!</p>
        </div>

        <div style="padding: 28px 24px; background: #f9fafb;">
            <p style="margin-top:0;">Hi {first_name},</p>
            <p>Thanks for shopping at <strong>{showroom_name}</strong>. As a trade customer{' on account ' + t_ref if t_ref else ''}, you just earned <strong>£{credits_earned:.2f}</strong> credit-back on invoice <strong>#{invoice_no}</strong>.</p>

            <div style="background: #ffffff; border: 1px solid #d1fae5; border-left: 4px solid #047857; border-radius: 8px; padding: 20px; margin: 20px 0;">
                <table style="width:100%; font-size:14px;">
                    <tr>
                        <td style="padding:6px 0; color:#525252;">Invoice total</td>
                        <td style="padding:6px 0; text-align:right; color:#171717; font-weight:600;">£{gross_total:.2f}</td>
                    </tr>
                    <tr>
                        <td style="padding:6px 0; color:#525252;">Credit-back rate</td>
                        <td style="padding:6px 0; text-align:right; color:#171717;">{credit_rate:.1f}% of £{net_subtotal:.2f} net</td>
                    </tr>
                    <tr>
                        <td style="padding:8px 0; color:#047857; font-weight:700; border-top:1px solid #d1fae5;">Credit earned today</td>
                        <td style="padding:8px 0; text-align:right; color:#047857; font-weight:700; font-size:18px; border-top:1px solid #d1fae5;">+£{credits_earned:.2f}</td>
                    </tr>
                    <tr>
                        <td style="padding:6px 0; color:#171717; font-weight:600;">New balance</td>
                        <td style="padding:6px 0; text-align:right; color:#171717; font-weight:700; font-size:16px;">£{balance_after:.2f}</td>
                    </tr>
                </table>
            </div>

            {breakdown_html}

            <p style="margin: 24px 0; text-align:center;">
                <a href="{dashboard_url}" style="background:#1a1a2e; color:#f0c14b; padding:14px 28px; text-decoration:none; border-radius:8px; font-weight:bold; display:inline-block;">
                    View my trade account →
                </a>
            </p>

            <p style="font-size:13px; color:#525252;">Your credit sits on your account ready to redeem against any future purchase — in store or online — just mention your account{(' ' + t_ref) if t_ref else ''} at the till or log in to redeem at checkout.</p>

            <p style="margin-top: 28px; font-size:13px; color:#525252;">
                Any questions? Reply to this email or call <strong>01474 878 989</strong> and we'll be happy to help.<br><br>
                Best regards,<br>
                <strong>{showroom_name} &middot; Tile Station</strong>
            </p>
        </div>

        <div style="background: #1a1a2e; color: #888; padding: 15px; text-align: center; font-size: 12px;">
            <p style="margin: 0;">Unit 3 Trade City, Coldharbour Road, Northfleet, Gravesend DA11 8AB</p>
            <p style="margin: 5px 0 0 0;">Company No: 11982550 | VAT No: 324 251 828</p>
        </div>
    </div>
    """

    try:
        resend.api_key = RESEND_API_KEY
        await asyncio.to_thread(resend.Emails.send, {
            "from": f"{showroom_name} - Tile Station <{from_email}>",
            "to": [customer_email],
            "reply_to": from_email,
            "subject": f"You earned £{credits_earned:.2f} trade credit at {showroom_name} — Invoice #{invoice_no}",
            "html": html_content,
        })
        return {"sent": True, "error": None}
    except Exception as exc:  # noqa: BLE001
        logging.exception("Trade credit-earned email failed for %s: %s", customer_email, exc)
        return {"sent": False, "error": str(exc)[:200]}



async def send_sample_followup_email(
    *,
    customer_email: str,
    customer_name: str,
    order: dict,
    voucher_code,
    voucher_amount_gbp: float,
    free_count: int,
    paid_count: int,
) -> dict:
    """Day-7 nudge: convert a sampler into a customer.

    Email body has 3 parts:
      1. Personalised hi + which samples they received (with thumbnails)
      2. EITHER a £X redemption voucher (if they paid for Full Size samples)
         OR a soft "ready to order?" CTA (if they only got free samples)
      3. Showroom-visit CTA + unsubscribe footer
    """
    if not RESEND_AVAILABLE or not RESEND_API_KEY:
        return {"sent": False, "error": "Email service not configured"}

    safe_name = (customer_name or "there").split(" ")[0]
    products = order.get("products") or []

    # Thumbnail strip — max 3 to keep the email tight
    thumb_html_parts = []
    for p in products[:3]:
        img = p.get("image") or "https://images.tilestation.co.uk/placeholder.jpg"
        name = p.get("name") or "Tile sample"
        tier_label = ""
        price_gbp = float(p.get("price_gbp") or 0)
        if price_gbp > 0:
            tier_label = '<span style="background:#fef3c7;color:#92400e;font-size:10px;padding:2px 6px;border-radius:4px;font-weight:700">FULL SIZE</span>'
        thumb_html_parts.append(f"""
            <div style="display:inline-block;width:30%;margin-right:2%;vertical-align:top;text-align:center">
              <img src="{img}" alt="{name}" style="width:100%;max-width:120px;height:90px;object-fit:cover;border-radius:6px;display:block;margin:0 auto" />
              <div style="font-size:11px;color:#444;margin-top:6px;line-height:1.3">{name[:30]}</div>
              {tier_label}
            </div>
        """)
    thumbs_html = "".join(thumb_html_parts) or '<div style="color:#888">your samples</div>'

    # Voucher block — only when paid samples were in the order
    if voucher_code and voucher_amount_gbp > 0:
        offer_block = f"""
        <div style="background:linear-gradient(135deg,#F7EA1C 0%,#ffd700 100%);border-radius:12px;padding:24px;text-align:center;margin:0 0 22px 0">
            <div style="font-size:11px;font-weight:700;letter-spacing:1px;color:#1a1a1a;text-transform:uppercase;margin-bottom:6px">Your full-size sample refund</div>
            <div style="font-family:ui-monospace,'SF Mono',Menlo,monospace;font-size:26px;font-weight:800;color:#1a1a1a;letter-spacing:2px">{voucher_code}</div>
            <div style="font-size:13px;color:#1a1a1a;opacity:0.85;margin-top:8px">
                <strong>£{voucher_amount_gbp:.2f} off</strong> when you order this tile.
                Single use · expires in 30 days.
            </div>
        </div>
        <p style="font-size:14px;color:#444;line-height:1.55;margin:0 0 22px 0">
            We're refunding what you paid for the Full Size Sample(s) against
            your order — it's our way of saying thanks for taking the time
            to evaluate properly. Just enter the code at checkout.
        </p>
        """
        subject = f"Hi {safe_name}, here's £{voucher_amount_gbp:.0f} off your tile order"
    else:
        offer_block = """
        <p style="font-size:15px;color:#333;line-height:1.55;margin:0 0 22px 0">
            We hope your samples helped you decide. If you're ready to order,
            we'd love to send your tiles your way — and any of our showroom
            team can help if you want a second opinion before committing.
        </p>
        """
        subject = f"Hi {safe_name}, ready to order your tiles?"

    view_links_html = ""
    for p in products[:3]:
        slug = p.get("slug")
        if slug:
            view_links_html += f'<li style="margin:6px 0"><a href="https://tilestation.co.uk/shop/collection/{slug}" style="color:#1a1a1a">View {p.get("name", "tile")} →</a></li>'

    summary_line = []
    if free_count:
        summary_line.append(f"{free_count} free sample{'s' if free_count != 1 else ''}")
    if paid_count:
        summary_line.append(f"{paid_count} Full Size sample{'s' if paid_count != 1 else ''}")
    summary_text = " + ".join(summary_line) or "your samples"

    html_content = f"""
    <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:600px;margin:0 auto;background:#ffffff">
        <div style="background:#1a1a1a;padding:28px 24px;text-align:center">
            <h1 style="color:#F7EA1C;margin:0;font-size:24px">How were your samples?</h1>
            <p style="color:#ddd;margin:8px 0 0 0;font-size:14px">Hope they helped you visualise the look.</p>
        </div>

        <div style="padding:28px 24px">
            <p style="font-size:16px;color:#222;margin:0 0 16px 0">Hi {safe_name},</p>
            <p style="font-size:15px;color:#444;line-height:1.55;margin:0 0 22px 0">
                You ordered {summary_text} from us about a week ago. Hope
                they helped you make a confident decision!
            </p>

            <div style="margin:0 0 26px 0;text-align:center">
                {thumbs_html}
            </div>

            {offer_block}

            <div style="text-align:center;margin:0 0 28px 0">
                <a href="https://tilestation.co.uk" style="display:inline-block;background:#1a1a1a;color:#F7EA1C;padding:14px 32px;border-radius:8px;text-decoration:none;font-weight:700;font-size:15px">Place your order online</a>
            </div>

            {('<ul style="font-size:13px;color:#444;list-style:none;padding:0">' + view_links_html + '</ul>') if view_links_html else ''}

            <div style="border-top:1px solid #eee;padding-top:18px;margin-top:22px">
                <p style="font-size:13px;color:#666;line-height:1.5;margin:0 0 6px 0">
                    <strong>Prefer to chat or see more samples in person?</strong>
                </p>
                <p style="font-size:13px;color:#666;line-height:1.5;margin:0 0 6px 0">
                    Pop into any of our showrooms — Tonbridge, Gravesend,
                    Chingford or Sydenham. Trade-quality advice, no appointment
                    needed, and showroom sample collection is always free.
                </p>
            </div>

            <p style="font-size:11px;color:#999;line-height:1.5;margin:24px 0 0 0">
                You're getting this because you ordered samples from Tile
                Station. We'll only follow up once per sample order — never
                a drip campaign. Reply to opt out and we'll stop.
            </p>
        </div>

        <div style="background:#f5f5f5;color:#888;padding:14px 24px;text-align:center;font-size:11px">
            Tile Station Ltd · Company No: 11982550
        </div>
    </div>
    """

    try:
        # 22 Jun 2026 — route through the marketing outbox so this
        # promotional follow-up gets admin approval in manual mode.
        # See services/marketing_outbox.py docstring for the full
        # rationale + the recent-completed-order safety net that
        # prevents Luke-style "you just paid full price but here's a
        # discount" incidents.
        from services.marketing_outbox import queue_email, CAT_SAMPLE_FOLLOWUP
        result = await queue_email(
            category=CAT_SAMPLE_FOLLOWUP,
            to=customer_email,
            subject=subject,
            html=html_content,
            recipient_name=customer_name or "",
            source_ref=order.get("order_number") or order.get("id"),
            preview=(
                f"Sample follow-up · voucher £{voucher_amount_gbp:.2f} ({voucher_code})"
                if voucher_code else "Sample follow-up · soft nudge (no voucher)"
            ),
            from_override="Tile Station <samples@tilestation.co.uk>",
            extra={
                "voucher_code": voucher_code,
                "voucher_amount_gbp": voucher_amount_gbp,
                "free_count": free_count,
                "paid_count": paid_count,
            },
        )
        return {
            "sent": bool(result.get("sent")),
            "queued": bool(result.get("queued")),
            "outbox_id": result.get("outbox_id"),
            "error": None,
        }
    except Exception as exc:  # noqa: BLE001
        logging.exception("Sample followup outbox queue failed for %s: %s", customer_email, exc)
        return {"sent": False, "queued": False, "outbox_id": None, "error": str(exc)[:200]}


async def send_sample_shipped_email(
    *,
    customer_email: str,
    customer_name: str,
    order: dict,
    tracking: dict | None = None,
) -> dict:
    """Auto-triggered when an admin flips a sample order to "shipped"
    in `/admin/sample-orders` (5 Jun 2026). Tells the customer their
    sample is in the post and (if available) gives them a one-tap
    tracking link.

    Idempotent at the caller — the PATCH endpoint checks
    `shipped_email_sent_at` before invoking so re-saving the row
    doesn't spam the customer.

    Returns the standard `{sent, error}` dict so callers can log
    failures without raising.
    """
    if not RESEND_AVAILABLE or not RESEND_API_KEY:
        return {"sent": False, "error": "Email service not configured"}

    safe_name = (customer_name or "there").split(" ")[0]
    products = order.get("products") or []
    order_no = order.get("order_number") or order.get("id") or ""

    # Build a 3-thumb sample strip (same visual language as the
    # follow-up email so the customer recognises the brand).
    thumb_html_parts = []
    for p in products[:3]:
        img = (
            p.get("image_url")
            or p.get("image")
            or "https://images.tilestation.co.uk/placeholder.jpg"
        )
        name = p.get("product_name") or p.get("name") or "Tile sample"
        thumb_html_parts.append(
            f'<div style="display:inline-block;width:30%;margin-right:2%;'
            f'vertical-align:top;text-align:center">'
            f'<img src="{img}" alt="{name}" style="width:100%;max-width:120px;'
            f'height:90px;object-fit:cover;border-radius:6px;display:block;'
            f'margin:0 auto" />'
            f'<div style="font-size:11px;color:#444;margin-top:6px;'
            f'line-height:1.3">{name[:30]}</div>'
            f'</div>'
        )
    thumbs_html = (
        "".join(thumb_html_parts)
        or '<div style="color:#888">your samples</div>'
    )

    # Tracking block — only render if we actually have a carrier OR
    # a tracking number OR a URL. Otherwise the email still goes out
    # (the dispatch confirmation is useful on its own).
    t = tracking or {}
    carrier = (t.get("carrier") or "").strip()
    tracking_no = (t.get("tracking_number") or "").strip()
    track_url = (t.get("url") or "").strip()
    tracking_html = ""
    if carrier or tracking_no or track_url:
        rows = []
        if carrier:
            rows.append(
                f'<tr><td style="padding:4px 0;color:#666;font-size:13px">'
                f'Carrier</td><td style="padding:4px 0;font-weight:600;'
                f'font-size:13px">{carrier}</td></tr>'
            )
        if tracking_no:
            rows.append(
                f'<tr><td style="padding:4px 0;color:#666;font-size:13px">'
                f'Tracking number</td><td style="padding:4px 0;font-weight:600;'
                f'font-size:13px;font-family:monospace">{tracking_no}</td></tr>'
            )
        cta_button = ""
        if track_url:
            cta_button = (
                f'<div style="text-align:center;margin-top:18px">'
                f'<a href="{track_url}" '
                f'style="display:inline-block;background:#0f5132;color:#fff;'
                f'text-decoration:none;padding:12px 28px;border-radius:6px;'
                f'font-weight:700;font-size:14px">Track your parcel ›</a>'
                f'</div>'
            )
        tracking_html = (
            f'<div style="background:#f5f9f5;border:1px solid #c8e0ce;'
            f'border-radius:8px;padding:18px;margin:18px 0">'
            f'<div style="font-size:11px;font-weight:700;letter-spacing:1px;'
            f'color:#0f5132;text-transform:uppercase;margin-bottom:10px">'
            f'Tracking details</div>'
            f'<table style="width:100%;border-collapse:collapse">'
            f'{"".join(rows)}</table>'
            f'{cta_button}</div>'
        )

    subject = f"Your samples are on the way — {order_no}"
    html_content = f"""
    <div style="max-width:600px;margin:0 auto;font-family:Arial,sans-serif;
                background:#fff;border:1px solid #e5e5e5;border-radius:8px;
                overflow:hidden">
        <div style="background:#0f5132;color:#fff;padding:24px 28px">
            <h1 style="margin:0;font-size:22px;font-weight:800">
                📦 Your samples are on the way
            </h1>
            <p style="margin:6px 0 0 0;font-size:13px;opacity:0.9">
                Order #{order_no}
            </p>
        </div>

        <div style="padding:24px 28px">
            <p style="font-size:15px;color:#222;margin:0 0 16px 0">
                Hi {safe_name},
            </p>
            <p style="font-size:14px;color:#444;line-height:1.6;margin:0 0 18px 0">
                Good news — we've dispatched your tile samples. They should
                land in 2–5 working days (Royal Mail).
            </p>

            <div style="margin:18px 0">{thumbs_html}</div>

            {tracking_html}

            <p style="font-size:13px;color:#666;line-height:1.5;margin:18px 0 0 0">
                Once they arrive, hold them up against your wall / floor in
                the actual light of the room — daylight + evening light can
                shift how a tile looks dramatically. If you want to discuss
                the look or feel, our showroom team is on
                <a href="tel:01622200400" style="color:#0f5132;font-weight:600">
                    01622 200 400</a>.
            </p>
        </div>

        <div style="background:#f5f5f5;color:#888;padding:14px 24px;
                    text-align:center;font-size:11px">
            Tile Station Ltd · Company No: 11982550
        </div>
    </div>
    """

    try:
        resend.api_key = RESEND_API_KEY
        await asyncio.to_thread(resend.Emails.send, {
            "from": "Tile Station <samples@tilestation.co.uk>",
            "to": [customer_email],
            "reply_to": "samples@tilestation.co.uk",
            "subject": subject,
            "html": html_content,
        })
        return {"sent": True, "error": None}
    except Exception as exc:  # noqa: BLE001
        logging.exception(
            "Sample shipped email failed for %s: %s", customer_email, exc,
        )
        return {"sent": False, "error": str(exc)[:200]}





async def send_lead_welcome_email(*, name: str, email: str, voucher_code: str, percent_off: int = 5, expires_at: str = "") -> dict:
    """Welcome email triggered when a customer drops their email at the till
    tablet (showroom-signup flow). Includes a single-use voucher code so the
    next online order is the natural conversion step.

    22 Jun 2026 — this now routes through the marketing outbox instead
    of firing directly to Resend. In manual mode (the post-Luke
    default) the message parks in `/admin/marketing/pending-emails`
    for owner review; in auto mode the outbox dispatches immediately.
    The recent-completed-order safety net (7-day look-back) still
    catches the "already paid" case in either mode.

    Returns {sent: bool, queued: bool, outbox_id: str|None, error: str|None}
    so the caller can log what happened without re-querying the DB.
    """
    safe_name = (name or "there").split(" ")[0]
    expires_str = ""
    try:
        if expires_at:
            expires_str = datetime.fromisoformat(expires_at.replace("Z", "+00:00")).strftime("%d %b %Y")
    except Exception:
        expires_str = ""

    html_content = f"""
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 560px; margin: 0 auto; background: #ffffff;">
        <div style="background: #1a1a1a; padding: 28px 24px; text-align: center;">
            <h1 style="color: #F7EA1C; margin: 0; font-size: 24px;">Welcome to Tile Station</h1>
            <p style="color: #ddd; margin: 8px 0 0 0; font-size: 14px;">Trade-quality tiles, delivered or collected.</p>
        </div>

        <div style="padding: 28px 24px;">
            <p style="font-size: 16px; color: #222; margin: 0 0 16px 0;">Hi {safe_name},</p>
            <p style="font-size: 15px; color: #444; line-height: 1.55; margin: 0 0 22px 0;">
                Thanks for signing up at the showroom. As promised, here's a
                little welcome from us — <strong>{percent_off}% off</strong>
                your first online order.
            </p>

            <div style="background: linear-gradient(135deg, #F7EA1C 0%, #ffd700 100%); border-radius: 12px; padding: 24px; text-align: center; margin: 0 0 22px 0;">
                <div style="font-size: 12px; font-weight: 700; letter-spacing: 1px; color: #1a1a1a; text-transform: uppercase; margin-bottom: 6px;">Your welcome code</div>
                <div style="font-family: ui-monospace, 'SF Mono', Menlo, monospace; font-size: 26px; font-weight: 800; color: #1a1a1a; letter-spacing: 2px;">{voucher_code}</div>
                <div style="font-size: 12px; color: #1a1a1a; opacity: 0.7; margin-top: 8px;">
                    {percent_off}% off your first online order{(' · expires ' + expires_str) if expires_str else ''} · single use
                </div>
            </div>

            <div style="text-align: center;">
                <a href="https://tilestation.co.uk/tiles" style="display: inline-block; background: #1a1a1a; color: #F7EA1C; padding: 14px 32px; border-radius: 8px; text-decoration: none; font-weight: 700; font-size: 15px;">Shop tiles online</a>
            </div>

            <p style="font-size: 13px; color: #666; line-height: 1.5; margin: 28px 0 0 0;">
                You're getting this email because you opted in at one of our
                showrooms. We'll only message you about new ranges, trade promos
                and showroom events. <a href="https://tilestation.co.uk/contact" style="color: #888;">Contact us</a> any time
                to unsubscribe.
            </p>
        </div>

        <div style="background: #f5f5f5; color: #888; padding: 14px 24px; text-align: center; font-size: 11px;">
            Tile Station Ltd · Unit 3 Trade City, Coldharbour Road, Gravesend DA11 8AB · Company No: 11982550
        </div>
    </div>
    """
    try:
        from services.marketing_outbox import queue_email, CAT_LEAD_WELCOME
        result = await queue_email(
            category=CAT_LEAD_WELCOME,
            to=email,
            subject=f"Welcome to Tile Station — here's {percent_off}% off your first online order",
            html=html_content,
            recipient_name=name or "",
            preview=f"Welcome voucher {voucher_code} ({percent_off}% off) for new lead",
            extra={"voucher_code": voucher_code, "percent_off": percent_off},
        )
        return {
            "sent": bool(result.get("sent")),
            "queued": bool(result.get("queued")),
            "outbox_id": result.get("outbox_id"),
            "error": None,
        }
    except Exception as exc:  # noqa: BLE001
        logging.exception("Lead welcome outbox queue failed for %s: %s", email, exc)
        return {"sent": False, "queued": False, "outbox_id": None, "error": str(exc)[:200]}


async def send_refund_email(refund: dict, recipient_email: str):
    """Send refund document via email"""
    if not RESEND_AVAILABLE or not RESEND_API_KEY:
        raise Exception("Email service not available")
    
    resend.api_key = RESEND_API_KEY
    
    refund_no = refund.get("refund_no", "N/A")
    customer_name = refund.get("customer_name", "Customer")
    gross_total = refund.get("gross_total", 0)
    showroom_name = refund.get("showroom_name", "Tile Station")
    line_items = refund.get("line_items", [])
    refund_date = refund.get("date", "")
    refund_method = refund.get("refund_method", "Cash")
    
    # Get showroom email
    from_email = get_showroom_email(showroom_name)
    
    # Build items table HTML
    items_html = ""
    for item in line_items:
        items_html += f"""
        <tr>
            <td style="padding: 8px; border-bottom: 1px solid #eee;">{item.get('product_name', '')}</td>
            <td style="padding: 8px; border-bottom: 1px solid #eee; text-align: center;">{item.get('quantity', 0)}</td>
            <td style="padding: 8px; border-bottom: 1px solid #eee; text-align: right;">£{item.get('refund_price', 0):.2f}</td>
            <td style="padding: 8px; border-bottom: 1px solid #eee; text-align: right;">£{item.get('total', 0):.2f}</td>
        </tr>
        """
    
    html_content = f"""
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <div style="background: #dc2626; color: white; padding: 20px; text-align: center;">
            <h1 style="margin: 0; color: white;">TILE STATION</h1>
            <p style="margin: 5px 0 0 0; font-size: 14px;">Refund Confirmation</p>
        </div>
        
        <div style="padding: 30px; background: #f9f9f9;">
            <h2 style="color: #dc2626; margin-top: 0;">Refund #{refund_no}</h2>
            <p>Dear {customer_name},</p>
            
            <p>This email confirms your refund has been processed.</p>
            
            <div style="background: white; padding: 20px; border-radius: 8px; margin: 20px 0; border-left: 4px solid #dc2626;">
                <h3 style="margin-top: 0; color: #333;">Refund Details</h3>
                <p><strong>Date:</strong> {refund_date}</p>
                <p><strong>Refund Method:</strong> {refund_method}</p>
                
                <table style="width: 100%; border-collapse: collapse; margin-top: 15px;">
                    <thead>
                        <tr style="background: #f5f5f5;">
                            <th style="padding: 10px; text-align: left; border-bottom: 2px solid #ddd;">Product</th>
                            <th style="padding: 10px; text-align: center; border-bottom: 2px solid #ddd;">Qty</th>
                            <th style="padding: 10px; text-align: right; border-bottom: 2px solid #ddd;">Price</th>
                            <th style="padding: 10px; text-align: right; border-bottom: 2px solid #ddd;">Total</th>
                        </tr>
                    </thead>
                    <tbody>
                        {items_html}
                    </tbody>
                </table>
                
                <div style="margin-top: 20px; padding-top: 15px; border-top: 2px solid #dc2626;">
                    <table style="width: 100%;">
                        <tr>
                            <td style="padding: 5px 0;"><strong>Subtotal:</strong></td>
                            <td style="text-align: right;">£{refund.get('subtotal', 0):.2f}</td>
                        </tr>
                        <tr>
                            <td style="padding: 5px 0;"><strong>VAT (20%):</strong></td>
                            <td style="text-align: right;">£{refund.get('vat', 0):.2f}</td>
                        </tr>
                        <tr style="font-size: 18px; color: #dc2626;">
                            <td style="padding: 10px 0;"><strong>Total Refund:</strong></td>
                            <td style="text-align: right;"><strong>£{gross_total:.2f}</strong></td>
                        </tr>
                    </table>
                </div>
            </div>
            
            <p style="color: #666; font-size: 14px;">If you have any questions about this refund, please contact us.</p>
            
            <p>Thank you for shopping with Tile Station.</p>
        </div>
        
        <div style="background: #333; color: #999; padding: 20px; text-align: center; font-size: 12px;">
            <p style="margin: 0;">© Tile Station - Amazing Tiles - Beautiful Bathrooms - Excellent Service</p>
        </div>
    </div>
    """
    
    resend.emails.send({
        "from": f"{showroom_name} - Tile Station <{from_email}>",
        "to": recipient_email,
        "subject": f"Refund Confirmation - {refund_no}",
        "html": html_content
    })
    
    logging.info(f"Refund email sent to {recipient_email} for refund {refund_no}")


async def send_invite_email(recipient_email: str, recipient_name: str, invite_url: str, discount: float = 0, showroom_name: str = None):
    """Send customer invite email"""
    if not RESEND_AVAILABLE or not RESEND_API_KEY:
        logging.warning("Resend not available, skipping email")
        return False
    
    from_email = get_showroom_email(showroom_name)
    display_name = f"{showroom_name} - Tile Station" if showroom_name else "Tile Station"
    
    html_content = f"""
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <div style="background: #1a1a2e; color: white; padding: 20px; text-align: center;">
            <h1 style="margin: 0; color: #f0c14b;">TILE STATION</h1>
        </div>
        
        <div style="padding: 30px; background: #f9f9f9;">
            <h2>You're Invited!</h2>
            <p>Dear {recipient_name or 'Valued Customer'},</p>
            <p>You've been invited to join Tile Station's customer portal.</p>
            
            {'<p style="background: #f0c14b; padding: 10px; border-radius: 5px;">Special offer: <strong>' + str(discount) + '% discount</strong> on your orders!</p>' if discount > 0 else ''}
            
            <p>Click the link below to register:</p>
            <a href="{invite_url}" style="display: inline-block; background: #1a1a2e; color: white; padding: 12px 24px; text-decoration: none; border-radius: 5px;">Register Now</a>
            
            <p style="margin-top: 30px;">Best regards,<br><strong>{display_name}</strong></p>
        </div>
    </div>
    """
    
    try:
        resend.api_key = RESEND_API_KEY
        await asyncio.to_thread(resend.Emails.send, {
            "from": f"{display_name} <{from_email}>",
            "to": [recipient_email],
            "subject": "You're Invited to Tile Station",
            "html": html_content
        })
        return True
    except Exception as e:
        logging.error(f"Failed to send invite email: {e}")
        return False


async def send_staff_invite_email(
    recipient_email: str, 
    recipient_name: str, 
    invite_url: str, 
    role: str,
    showroom_name: str = None,
    permissions: list = None,
    note: str = None
):
    """Send staff/admin invite email"""
    if not RESEND_AVAILABLE or not RESEND_API_KEY:
        logging.warning("Resend not available, skipping email")
        return False
    
    # Use showroom email if assigned, otherwise default
    from_email = get_showroom_email(showroom_name)
    display_name = f"{showroom_name} - Tile Station" if showroom_name else "Tile Station"
    
    role_display = role.title()
    permissions_html = ""
    if permissions:
        perm_items = "".join([f"<li>{p.replace('_', ' ').title()}</li>" for p in permissions[:8]])
        if len(permissions) > 8:
            perm_items += f"<li>+{len(permissions) - 8} more...</li>"
        permissions_html = f"""
        <div style="background: #e8f4e8; padding: 15px; border-radius: 8px; margin: 15px 0;">
            <p style="margin: 0 0 10px 0; font-weight: bold; color: #2d5a2d;">Permissions Granted:</p>
            <ul style="margin: 0; padding-left: 20px; color: #2d5a2d;">{perm_items}</ul>
        </div>
        """
    
    showroom_html = ""
    if showroom_name:
        showroom_html = f"""
        <p><strong>Assigned Store:</strong> {showroom_name}</p>
        """
    
    note_html = ""
    if note:
        note_html = f"""
        <div style="background: #fff3cd; padding: 15px; border-radius: 8px; margin: 15px 0; border-left: 4px solid #f0c14b;">
            <p style="margin: 0; color: #856404;"><strong>Note from Admin:</strong> {note}</p>
        </div>
        """
    
    html_content = f"""
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <div style="background: #1a1a2e; color: white; padding: 20px; text-align: center;">
            <h1 style="margin: 0; color: #f0c14b;">TILE STATION</h1>
            <p style="margin: 5px 0 0 0; font-size: 14px;">Staff Portal</p>
        </div>
        
        <div style="padding: 30px; background: #f9f9f9;">
            <h2 style="color: #1a1a2e; margin-top: 0;">Welcome to the Team!</h2>
            <p>Dear {recipient_name or 'Team Member'},</p>
            
            <p>You've been invited to join <strong>Tile Station</strong> as a <strong style="color: #1a1a2e;">{role_display}</strong>.</p>
            
            {showroom_html}
            {permissions_html}
            {note_html}
            
            <div style="text-align: center; margin: 30px 0;">
                <a href="{invite_url}" style="display: inline-block; background: #1a1a2e; color: white; padding: 15px 30px; text-decoration: none; border-radius: 8px; font-weight: bold; font-size: 16px;">
                    Complete Registration
                </a>
            </div>
            
            <p style="color: #666; font-size: 14px;">This invite link will expire in 7 days. If you have any questions, please contact your administrator.</p>
            
            <p style="margin-top: 30px;">
                Best regards,<br>
                <strong>{display_name}</strong><br>
                Tel: 01474 878 989
            </p>
        </div>
        
        <div style="background: #1a1a2e; color: #888; padding: 15px; text-align: center; font-size: 12px;">
            <p style="margin: 0;">If you didn't expect this invite, please ignore this email.</p>
        </div>
    </div>
    """
    
    try:
        resend.api_key = RESEND_API_KEY
        await asyncio.to_thread(resend.Emails.send, {
            "from": f"{display_name} <{from_email}>",
            "to": [recipient_email],
            "subject": f"You're Invited to Join Tile Station as {role_display}",
            "html": html_content
        })
        return True
    except Exception as e:
        logging.error(f"Failed to send staff invite email: {e}")
        return False


async def send_bulk_inquiry_notification(
    admin_emails: list,
    inquiry_data: dict,
    showroom_name: str = None
):
    """Send notification to admins when a new bulk inquiry is submitted"""
    if not RESEND_AVAILABLE or not RESEND_API_KEY:
        logging.warning("Resend not available, skipping bulk inquiry notification")
        return False
    
    if not admin_emails:
        logging.warning("No admin emails provided for bulk inquiry notification")
        return False
    
    from_email = get_showroom_email(showroom_name)
    
    customer_name = inquiry_data.get("customer_name", "Unknown")
    customer_email = inquiry_data.get("customer_email", "")
    customer_phone = inquiry_data.get("customer_phone", "")
    product_name = inquiry_data.get("product_name", "Unknown Product")
    product_sku = inquiry_data.get("product_sku", "")
    quantity_needed = inquiry_data.get("quantity_needed", 0)
    message = inquiry_data.get("message", "")
    
    html_content = f"""
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <div style="background: #1a1a2e; color: white; padding: 20px; text-align: center;">
            <h1 style="margin: 0; color: #f0c14b;">TILE STATION</h1>
            <p style="margin: 5px 0 0 0; font-size: 14px;">New Bulk Order Inquiry</p>
        </div>
        
        <div style="padding: 30px; background: #f9f9f9;">
            <div style="background: #fff3cd; border: 1px solid #ffc107; padding: 15px; border-radius: 8px; margin-bottom: 20px;">
                <h2 style="margin: 0 0 10px 0; color: #856404;">📦 New Bulk Inquiry Received</h2>
                <p style="margin: 0; color: #856404;">A customer has submitted a bulk order inquiry that requires your attention.</p>
            </div>
            
            <h3 style="color: #1a1a2e; border-bottom: 2px solid #1a1a2e; padding-bottom: 10px;">Customer Details</h3>
            <table style="width: 100%; margin-bottom: 20px;">
                <tr>
                    <td style="padding: 8px 0; color: #666;"><strong>Name:</strong></td>
                    <td style="padding: 8px 0;">{customer_name}</td>
                </tr>
                <tr>
                    <td style="padding: 8px 0; color: #666;"><strong>Email:</strong></td>
                    <td style="padding: 8px 0;"><a href="mailto:{customer_email}">{customer_email}</a></td>
                </tr>
                <tr>
                    <td style="padding: 8px 0; color: #666;"><strong>Phone:</strong></td>
                    <td style="padding: 8px 0;">{customer_phone or 'Not provided'}</td>
                </tr>
            </table>
            
            <h3 style="color: #1a1a2e; border-bottom: 2px solid #1a1a2e; padding-bottom: 10px;">Product Request</h3>
            <table style="width: 100%; margin-bottom: 20px;">
                <tr>
                    <td style="padding: 8px 0; color: #666;"><strong>Product:</strong></td>
                    <td style="padding: 8px 0;">{product_name}</td>
                </tr>
                <tr>
                    <td style="padding: 8px 0; color: #666;"><strong>SKU:</strong></td>
                    <td style="padding: 8px 0;">{product_sku or 'N/A'}</td>
                </tr>
                <tr>
                    <td style="padding: 8px 0; color: #666;"><strong>Quantity Needed:</strong></td>
                    <td style="padding: 8px 0; font-size: 18px; font-weight: bold; color: #1a1a2e;">{quantity_needed} units</td>
                </tr>
            </table>
            
            {f'''<h3 style="color: #1a1a2e; border-bottom: 2px solid #1a1a2e; padding-bottom: 10px;">Customer Message</h3>
            <div style="background: #fff; border: 1px solid #ddd; padding: 15px; border-radius: 8px; margin-bottom: 20px;">
                <p style="margin: 0; white-space: pre-wrap;">{message}</p>
            </div>''' if message else ''}
            
            <div style="text-align: center; margin: 30px 0;">
                <p style="color: #666;">Please review this inquiry in the admin panel.</p>
            </div>
        </div>
        
        <div style="background: #1a1a2e; color: #888; padding: 15px; text-align: center; font-size: 12px;">
            <p style="margin: 0;">This is an automated notification from Tile Station.</p>
        </div>
    </div>
    """
    
    try:
        resend.api_key = RESEND_API_KEY
        await asyncio.to_thread(resend.Emails.send, {
            "from": f"Tile Station <{from_email}>",
            "to": admin_emails,
            "subject": f"🔔 New Bulk Inquiry: {quantity_needed} units of {product_name}",
            "html": html_content
        })
        logging.info(f"Bulk inquiry notification sent to {len(admin_emails)} admin(s)")
        return True
    except Exception as e:
        logging.error(f"Failed to send bulk inquiry notification: {e}")
        return False


async def send_email_notification(
    to_emails: list,
    subject: str,
    html_content: str,
    from_name: str = "Tile Station",
    from_email: str = None
):
    """Send a notification email to multiple recipients"""
    if not RESEND_AVAILABLE or not RESEND_API_KEY:
        logging.warning("Resend not available, skipping notification email")
        return False
    
    if not to_emails:
        logging.warning("No recipients for notification email")
        return False
    
    if not from_email:
        from_email = DEFAULT_EMAIL
    
    try:
        resend.api_key = RESEND_API_KEY
        await asyncio.to_thread(resend.Emails.send, {
            "from": f"{from_name} <{from_email}>",
            "to": to_emails,
            "subject": subject,
            "html": html_content
        })
        logging.info(f"Notification email sent: {subject}")
        return True
    except Exception as e:
        logging.error(f"Failed to send notification email: {e}")
        return False



# ============ SUPER ADMIN ALERTS (refund overrides, device approvals) ============
#
# Reusable email helper for high-trust admin events that need:
#   - a clear subject line in every super admin's inbox
#   - a deep link straight to the approval / audit page
#   - a written reason / context so the email itself is self-contained
#
# Used by: refund no-invoice overrides, device approval requests, and
# any future super-admin escalation. Recipients are pulled live from
# Mongo (`users` where role=super_admin) so adding/removing a super
# admin doesn't require a backend env change.

async def _get_super_admin_emails() -> list:
    """Return the list of super admin email addresses (live from DB).

    Falls back to ADMIN_EMAIL env var if no super_admin users exist
    yet (clean install / restored backup) so we never silently drop
    a critical alert email.
    """
    try:
        from config import get_db
        db = get_db()
        cursor = db.users.find(
            {"role": "super_admin", "deleted_at": {"$exists": False}},
            {"_id": 0, "email": 1, "name": 1},
        )
        emails = []
        async for u in cursor:
            e = (u.get("email") or "").strip().lower()
            if e and e not in emails:
                emails.append(e)
        if not emails and ADMIN_EMAIL:
            emails = [ADMIN_EMAIL]
        return emails
    except Exception as e:
        logging.warning(f"_get_super_admin_emails fallback: {e}")
        return [ADMIN_EMAIL] if ADMIN_EMAIL else []


def _admin_alert_html(
    *,
    title: str,
    accent_colour: str,
    icon: str,
    summary: str,
    fields: list,
    cta_label: str,
    cta_url: str,
    footer_note: str = "",
) -> str:
    """Render a consistent admin-alert email template.

    fields: list of (label, value) tuples to render as a definition list.
    """
    rows = "".join(
        f'<tr><td style="padding:6px 14px 6px 0;color:#525252;white-space:nowrap;vertical-align:top;">{label}</td>'
        f'<td style="padding:6px 0;color:#111;word-break:break-word;">{value}</td></tr>'
        for label, value in fields
    )
    footer = (
        f'<p style="margin:18px 0 0;font-size:12px;color:#737373;">{footer_note}</p>'
        if footer_note else ""
    )
    return f"""\
<!DOCTYPE html>
<html><body style="margin:0;padding:24px;background:#f5f5f4;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#111;">
  <div style="max-width:560px;margin:0 auto;background:#fff;border:1px solid #e5e7eb;border-radius:12px;overflow:hidden;">
    <div style="background:{accent_colour};padding:18px 24px;color:#fff;">
      <div style="font-size:20px;font-weight:700;">{icon}&nbsp;{title}</div>
    </div>
    <div style="padding:22px 24px 8px;">
      <p style="margin:0 0 16px;font-size:15px;line-height:1.45;">{summary}</p>
      <table style="width:100%;border-collapse:collapse;font-size:14px;">{rows}</table>
      <div style="margin:24px 0 8px;">
        <a href="{cta_url}" style="display:inline-block;padding:11px 22px;background:{accent_colour};color:#fff;text-decoration:none;border-radius:8px;font-weight:600;font-size:14px;">{cta_label} &rarr;</a>
      </div>
      {footer}
    </div>
    <div style="background:#fafaf9;padding:12px 24px;border-top:1px solid #e5e7eb;color:#737373;font-size:11px;">
      You're receiving this because you're a Super Admin on Tile Station.
      Replies to this email are not monitored — use the link above to act.
    </div>
  </div>
</body></html>"""


async def send_super_admin_alert(
    *,
    title: str,
    summary: str,
    fields: list,
    cta_label: str,
    cta_path: str,
    accent_colour: str = "#b45309",
    icon: str = "⚠️",
    subject_prefix: str = "[Tile Station Admin]",
    footer_note: str = "",
) -> bool:
    """Send a deep-link admin alert email to every active super admin.

    cta_path: site-relative path (e.g. "/admin/refund-history") — we
    join it with SHOP_WEBSITE_URL so the email contains a real, clickable
    production link regardless of which environment fired the alert.
    """
    recipients = await _get_super_admin_emails()
    if not recipients:
        logging.warning("send_super_admin_alert: no super admin recipients")
        return False

    cta_url = (
        cta_path if cta_path.startswith("http")
        else f"{COMPANY_WEBSITE.rstrip('/')}{cta_path}"
    )

    html = _admin_alert_html(
        title=title,
        accent_colour=accent_colour,
        icon=icon,
        summary=summary,
        fields=fields,
        cta_label=cta_label,
        cta_url=cta_url,
        footer_note=footer_note,
    )

    subject = f"{subject_prefix} {title}"
    return await send_email_notification(
        to_emails=recipients,
        subject=subject,
        html_content=html,
    )




# ============ ORDER STATUS EMAIL NOTIFICATIONS ============

# (COMPANY_NAME / COMPANY_WEBSITE / SENDER_EMAIL constants are defined
#  at the top of this module so admin-alert helpers above can use them.)


def get_status_email_config(status: str) -> dict:
    """Get email subject and message based on order status"""
    configs = {
        "confirmed": {
            "subject": "Order Confirmed - {order_number}",
            "heading": "Thank You for Your Order!",
            "message": "We've received your order and it's being prepared. You'll receive another email when it ships.",
            "color": "#10b981",
            "icon": "✓"
        },
        "processing": {
            "subject": "Your Order is Being Prepared - {order_number}",
            "heading": "Your Order is Being Processed",
            "message": "Great news! We're preparing your order for dispatch. It won't be long now!",
            "color": "#3b82f6",
            "icon": "📦"
        },
        "shipped": {
            "subject": "Your Order Has Been Shipped! - {order_number}",
            "heading": "Your Order is On Its Way!",
            "message": "Exciting news! Your order has been dispatched and is on its way to you.",
            "color": "#6366f1",
            "icon": "🚚"
        },
        "delivered": {
            "subject": "Order Delivered - {order_number}",
            "heading": "Your Order Has Been Delivered",
            "message": "Your order has been delivered. We hope you love your new tiles!",
            "color": "#10b981",
            "icon": "🎉"
        },
        "ready_for_collection": {
            "subject": "Ready for Collection - {order_number}",
            "heading": "Your Order is Ready!",
            "message": "Your order is ready to collect from our showroom. Please bring your order confirmation or ID.",
            "color": "#f59e0b",
            "icon": "📍"
        },
        "collected": {
            "subject": "Order Collected - {order_number}",
            "heading": "Thank You for Collecting Your Order",
            "message": "You've collected your order. We hope you're happy with your purchase!",
            "color": "#10b981",
            "icon": "✅"
        },
        "cancelled": {
            "subject": "Order Cancelled - {order_number}",
            "heading": "Your Order Has Been Cancelled",
            "message": "Your order has been cancelled. If you didn't request this, please contact us immediately.",
            "color": "#ef4444",
            "icon": "❌"
        }
    }
    return configs.get(status, {
        "subject": "Order Update - {order_number}",
        "heading": "Order Status Update",
        "message": "There's been an update to your order.",
        "color": "#6b7280",
        "icon": "📋"
    })


def format_price_gbp(amount: float) -> str:
    """Format price in GBP"""
    return f"£{amount:,.2f}"


def format_date_readable(date_str: str) -> str:
    """Format ISO date string to readable format"""
    from datetime import datetime
    try:
        dt = datetime.fromisoformat(date_str.replace('Z', '+00:00'))
        return dt.strftime("%d %B %Y at %H:%M")
    except Exception:
        return date_str


def generate_order_status_email_html(
    order: dict,
    status: str,
    tracking_number: str = None,
    tracking_url: str = None,
    notes: str = None,
    trade_credit_banner_html: str = "",
) -> str:
    """Generate HTML email for order status update"""
    from datetime import datetime
    
    config = get_status_email_config(status)
    
    # Build items HTML
    items_html = ""
    for item in order.get("items", []):
        item_total = item.get("price", 0) * item.get("quantity", 1)
        items_html += f"""
        <tr>
            <td style="padding: 12px 0; border-bottom: 1px solid #e5e7eb;">
                <div style="font-weight: 500; color: #1f2937;">{item.get('name', 'Product')}</div>
                <div style="font-size: 14px; color: #6b7280;">Qty: {item.get('quantity', 1)}</div>
            </td>
            <td style="padding: 12px 0; border-bottom: 1px solid #e5e7eb; text-align: right; font-weight: 500;">
                {format_price_gbp(item_total)}
            </td>
        </tr>
        """
    
    # Tracking section
    tracking_html = ""
    if tracking_number or tracking_url:
        tracking_link = f'<a href="{tracking_url}" style="color: #0d9488; text-decoration: none; font-weight: 500;">Track your package →</a>' if tracking_url else ""
        tracking_html = f"""
        <div style="background-color: #f0fdfa; border: 1px solid #99f6e4; border-radius: 8px; padding: 16px; margin: 20px 0;">
            <div style="font-weight: 600; color: #0d9488; margin-bottom: 8px;">📦 Tracking Information</div>
            {f'<div style="color: #1f2937; margin-bottom: 8px;">Tracking Number: <strong>{tracking_number}</strong></div>' if tracking_number else ''}
            {tracking_link}
        </div>
        """
    
    # Notes section
    notes_html = ""
    if notes:
        notes_html = f"""
        <div style="background-color: #fffbeb; border: 1px solid #fde68a; border-radius: 8px; padding: 16px; margin: 20px 0;">
            <div style="font-weight: 600; color: #92400e; margin-bottom: 8px;">📝 Note from Tile Station</div>
            <div style="color: #78350f;">{notes}</div>
        </div>
        """
    
    # Delivery info
    delivery_html = ""
    if order.get("delivery_method") == "delivery" and order.get("shipping_address"):
        addr = order["shipping_address"]
        delivery_html = f"""
        <div style="margin-top: 24px; padding-top: 24px; border-top: 1px solid #e5e7eb;">
            <div style="font-weight: 600; color: #1f2937; margin-bottom: 8px;">Delivery Address</div>
            <div style="color: #6b7280; line-height: 1.6;">
                {addr.get('name', '')}<br>
                {addr.get('line1', '')}<br>
                {f"{addr.get('line2')}<br>" if addr.get('line2') else ''}
                {addr.get('city', '')}<br>
                {addr.get('postcode', '')}
            </div>
        </div>
        """
    elif order.get("delivery_method") == "collect" and order.get("store_name"):
        delivery_html = f"""
        <div style="margin-top: 24px; padding-top: 24px; border-top: 1px solid #e5e7eb;">
            <div style="font-weight: 600; color: #1f2937; margin-bottom: 8px;">Collection Point</div>
            <div style="color: #6b7280;">{order.get('store_name', 'Tile Station')}</div>
        </div>
        """

    # Savings strip — mirrors the cart-level "Total Savings" pill so trade
    # customers can forward the email/invoice to their accountant or end
    # client with itemised proof of value.
    savings_html = ""
    sm = order.get("savings_meta") or {}
    if sm and (sm.get("total_saved") or 0) >= 0.01:
        total_saved = sm.get("total_saved", 0)
        pct_off = sm.get("percent_off_retail", 0)
        lines_with = sm.get("lines_with_savings", 0)
        savings_html = f"""
        <div style="margin-top: 16px; background: linear-gradient(135deg, #10b981 0%, #059669 100%); border-radius: 12px; padding: 18px 20px; color: white;">
            <div style="font-size: 11px; font-weight: 700; letter-spacing: 0.1em; text-transform: uppercase; color: rgba(255,255,255,0.8); margin-bottom: 4px;">
                Total savings
            </div>
            <div style="font-size: 18px; font-weight: 700; line-height: 1.3;">
                Volume + Trade discounts saved you {format_price_gbp(total_saved)}
            </div>
            <div style="font-size: 13px; color: rgba(255,255,255,0.9); margin-top: 4px;">
                across {lines_with} line{'s' if lines_with != 1 else ''} · {pct_off}% off retail
            </div>
        </div>
        """
    
    html = f"""
    <!DOCTYPE html>
    <html>
    <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
    </head>
    <body style="margin: 0; padding: 0; background-color: #f3f4f6; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;">
        <div style="max-width: 600px; margin: 0 auto; padding: 20px;">
            <!-- Header -->
            <div style="background: linear-gradient(135deg, #0d9488 0%, #0f766e 100%); border-radius: 12px 12px 0 0; padding: 32px; text-align: center;">
                <div style="font-size: 40px; margin-bottom: 12px;">{config['icon']}</div>
                <h1 style="color: white; margin: 0; font-size: 24px; font-weight: 700;">{config['heading']}</h1>
            </div>
            
            <!-- Content -->
            <div style="background-color: white; padding: 32px; border-radius: 0 0 12px 12px; box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1);">
                {trade_credit_banner_html}
                <p style="color: #4b5563; font-size: 16px; line-height: 1.6; margin: 0 0 24px 0;">
                    {config['message']}
                </p>
                
                <!-- Order Info Box -->
                <div style="background-color: #f9fafb; border-radius: 8px; padding: 20px; margin-bottom: 24px;">
                    <table style="width: 100%; border-collapse: collapse;">
                        <tr>
                            <td style="padding: 8px 0; color: #6b7280;">Order Number</td>
                            <td style="padding: 8px 0; text-align: right; font-weight: 600; color: #1f2937;">{order.get('order_number', 'N/A')}</td>
                        </tr>
                        <tr>
                            <td style="padding: 8px 0; color: #6b7280;">Order Date</td>
                            <td style="padding: 8px 0; text-align: right; color: #1f2937;">{format_date_readable(order.get('created_at', ''))}</td>
                        </tr>
                        <tr>
                            <td style="padding: 8px 0; color: #6b7280;">Status</td>
                            <td style="padding: 8px 0; text-align: right;">
                                <span style="background-color: {config['color']}20; color: {config['color']}; padding: 4px 12px; border-radius: 20px; font-size: 13px; font-weight: 500;">
                                    {status.replace('_', ' ').title()}
                                </span>
                            </td>
                        </tr>
                    </table>
                </div>
                
                {tracking_html}
                {notes_html}
                
                <!-- Order Items -->
                <div style="margin-top: 24px;">
                    <h3 style="color: #1f2937; font-size: 16px; font-weight: 600; margin-bottom: 16px;">Order Summary</h3>
                    <table style="width: 100%; border-collapse: collapse;">
                        {items_html}
                        <tr>
                            <td style="padding: 12px 0; color: #6b7280;">Subtotal</td>
                            <td style="padding: 12px 0; text-align: right;">{format_price_gbp(order.get('subtotal', 0))}</td>
                        </tr>
                        <tr>
                            <td style="padding: 8px 0; color: #6b7280;">VAT (20%)</td>
                            <td style="padding: 8px 0; text-align: right;">{format_price_gbp(order.get('vat', 0))}</td>
                        </tr>
                        <tr>
                            <td style="padding: 8px 0; color: #6b7280;">Delivery</td>
                            <td style="padding: 8px 0; text-align: right;">{'FREE' if order.get('delivery_fee', 0) == 0 else format_price_gbp(order.get('delivery_fee', 0))}</td>
                        </tr>
                        <tr>
                            <td style="padding: 16px 0; font-weight: 700; font-size: 18px; border-top: 2px solid #e5e7eb;">Total</td>
                            <td style="padding: 16px 0; text-align: right; font-weight: 700; font-size: 18px; border-top: 2px solid #e5e7eb; color: #0d9488;">
                                {format_price_gbp(order.get('total', 0))}
                            </td>
                        </tr>
                    </table>
                </div>

                {savings_html}
                
                {delivery_html}
                
                <!-- CTA Button -->
                <div style="text-align: center; margin-top: 32px;">
                    <a href="{COMPANY_WEBSITE}/shop/track?order={order.get('order_number', '')}&email={order.get('customer_email', '')}" 
                       style="display: inline-block; background-color: #0d9488; color: white; padding: 14px 28px; border-radius: 8px; text-decoration: none; font-weight: 600;">
                        Track Your Order
                    </a>
                </div>
            </div>
            
            <!-- Footer -->
            <div style="text-align: center; padding: 24px; color: #9ca3af; font-size: 14px;">
                <p style="margin: 0 0 8px 0;">Need help? Contact us at support@tilestation.co.uk</p>
                <p style="margin: 0;">© {datetime.now().year} {COMPANY_NAME}. All rights reserved.</p>
            </div>
        </div>
    </body>
    </html>
    """
    
    return html


async def send_simple_email_if_possible(
    to,
    subject: str,
    html: str,
    attachments: list = None,
    from_override: str = None,
) -> dict:
    """Lightweight Resend send. Used for admin alerts (UI health, etc) —
    no template wrapper, just dispatches if Resend is configured. Always
    swallows errors so it never blocks the calling endpoint.

    `attachments`: optional list of {filename, content (bytes), content_type}.
    Resend accepts base64-encoded content; we encode here so callers pass raw bytes.

    `from_override`: optional full From-header (e.g. "Tile Station Alerts
    <notifications@tilestation.co.uk>"). When set, takes priority over the
    default `SENDER_EMAIL`-based header. Used for INTERNAL admin alerts so
    they never appear to come from `online@` (which is reserved for
    online-customer emails) or from a personal inbox like `qasim@`.
    """
    if not RESEND_AVAILABLE or not RESEND_API_KEY:
        return {"success": False, "error": "Email service not available"}
    if not to:
        return {"success": False, "error": "No recipients"}
    if isinstance(to, str):
        to = [to]
    try:
        resend.api_key = RESEND_API_KEY
        from_header = from_override or f"{COMPANY_NAME} Alerts <{SENDER_EMAIL}>"
        payload = {
            "from": from_header,
            "to": to,
            "subject": subject,
            "html": html,
        }
        if attachments:
            import base64 as _b64
            payload["attachments"] = [
                {
                    "filename": a["filename"],
                    "content": _b64.b64encode(a["content"]).decode("ascii")
                    if isinstance(a.get("content"), (bytes, bytearray))
                    else a.get("content"),
                    **({"content_type": a["content_type"]} if a.get("content_type") else {}),
                }
                for a in attachments
            ]
        result = await asyncio.to_thread(resend.Emails.send, payload)
        return {"success": True, "resend_id": (result or {}).get("id") if isinstance(result, dict) else None}
    except Exception as exc:
        logging.exception("Simple alert email failed")
        return {"success": False, "error": str(exc)}


async def send_order_custom_email(
    order: dict,
    subject: str,
    body: str,
    from_admin_email: str = None,
) -> dict:
    """Send a one-off custom email to the order's customer using the same
    branded wrapper as the status emails. Used when admin needs to send a
    bespoke message that no automated status template covers (e.g. "Your
    delivery driver will call 30min before arrival.")."""
    if not RESEND_AVAILABLE:
        return {"success": False, "error": "Email service not available"}
    if not RESEND_API_KEY:
        return {"success": False, "error": "Email service not configured"}

    customer_email = order.get("customer_email")
    if not customer_email:
        return {"success": False, "error": "No customer email"}

    subject = (subject or "").strip() or f"Update on your order {order.get('order_number','')}"
    body = (body or "").strip()
    if not body:
        return {"success": False, "error": "Body required"}

    # Convert plain newlines to <br> for HTML rendering, escape minimal HTML
    import html as _html
    body_html = _html.escape(body).replace("\n", "<br>")
    customer_name = (order.get("shipping_address") or {}).get("name") or order.get("customer_name") or "there"
    first_name = customer_name.split(" ")[0] if customer_name else "there"

    html_content = f"""
    <!DOCTYPE html>
    <html>
    <body style="margin:0;padding:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background-color:#f9fafb;">
        <div style="max-width:600px;margin:0 auto;background-color:#ffffff;">
            <!-- Header -->
            <div style="background:linear-gradient(135deg,#0d9488 0%,#0891b2 100%);padding:32px 24px;text-align:center;">
                <div style="font-size:36px;margin-bottom:8px;">✉️</div>
                <h1 style="color:#ffffff;font-size:22px;margin:0;font-weight:700;">{_html.escape(subject)}</h1>
                <p style="color:rgba(255,255,255,0.9);font-size:14px;margin:8px 0 0 0;">Order #{_html.escape(order.get('order_number',''))}</p>
            </div>

            <!-- Body -->
            <div style="padding:32px 24px;">
                <p style="color:#1f2937;font-size:16px;line-height:1.6;margin:0 0 20px 0;">Hi {_html.escape(first_name)},</p>
                <div style="color:#374151;font-size:15px;line-height:1.7;white-space:pre-wrap;">{body_html}</div>

                <!-- CTA -->
                <div style="text-align:center;margin-top:32px;">
                    <a href="{COMPANY_WEBSITE}/shop/track?order={order.get('order_number','')}&email={customer_email}"
                       style="display:inline-block;background-color:#0d9488;color:white;padding:14px 28px;border-radius:8px;text-decoration:none;font-weight:600;">
                        View Your Order
                    </a>
                </div>
            </div>

            <!-- Footer -->
            <div style="text-align:center;padding:24px;color:#9ca3af;font-size:13px;border-top:1px solid #e5e7eb;">
                <p style="margin:0 0 6px 0;">Need help? Reply to this email or contact support@tilestation.co.uk</p>
                <p style="margin:0;">© {datetime.now().year} {COMPANY_NAME}. All rights reserved.</p>
            </div>
        </div>
    </body>
    </html>
    """

    try:
        resend.api_key = RESEND_API_KEY
        result = await asyncio.to_thread(resend.Emails.send, {
            "from": f"{COMPANY_NAME} <{SENDER_EMAIL}>",
            "to": [customer_email],
            "subject": subject,
            "html": html_content,
            **({"reply_to": [from_admin_email]} if from_admin_email else {}),
        })
        # Persist a record on the order so admin can see "Custom email sent"
        try:
            from config import get_db
            db = get_db()
            await db.shop_orders.update_one(
                {"id": order.get("id")},
                {"$push": {"email_log": {
                    "type": "custom",
                    "subject": subject,
                    "to": customer_email,
                    "from_admin": from_admin_email,
                    "ok": True,
                    "resend_id": (result or {}).get("id") if isinstance(result, dict) else None,
                    "sent_at": datetime.now(timezone.utc).isoformat(),
                }}}
            )
        except Exception:
            pass
        return {"success": True, "resend_id": (result or {}).get("id") if isinstance(result, dict) else None}
    except Exception as exc:
        logging.exception("Custom email send failed")
        return {"success": False, "error": str(exc)}


async def send_order_status_notification(
    order: dict,
    new_status: str,
    tracking_number: str = None,
    tracking_url: str = None,
    notes: str = None
) -> dict:
    """Send email notification for order status update"""
    
    if not RESEND_AVAILABLE:
        logging.warning("Resend not available - Email not sent")
        return {"success": False, "error": "Email service not available"}
    
    if not RESEND_API_KEY:
        logging.warning("Resend API key not configured - Email not sent")
        return {"success": False, "error": "Email service not configured"}
    
    # Get customer email
    customer_email = order.get("customer_email")
    if not customer_email:
        logging.warning(f"No customer email for order {order.get('order_number')}")
        return {"success": False, "error": "No customer email"}
    
    try:
        config = get_status_email_config(new_status)
        subject = config["subject"].format(order_number=order.get("order_number", ""))

        # Personalised trade-credit balance banner (renders only if the
        # customer is a trade account with positive balance).
        trade_credit_banner_html = await _render_trade_credit_balance_banner_html(customer_email)

        html_content = generate_order_status_email_html(
            order=order,
            status=new_status,
            tracking_number=tracking_number,
            tracking_url=tracking_url,
            notes=notes,
            trade_credit_banner_html=trade_credit_banner_html,
        )
        
        # Send email
        resend.api_key = RESEND_API_KEY
        result = await asyncio.to_thread(resend.Emails.send, {
            "from": f"{COMPANY_NAME} <{SENDER_EMAIL}>",
            "to": [customer_email],
            "subject": subject,
            "html": html_content,
        })
        
        logging.info(f"Order status email sent to {customer_email} for order {order.get('order_number')} - Status: {new_status}")
        # Persist the success outcome on the order so admin can see "✓ delivered"
        try:
            from config import get_db
            db = get_db()
            await db.shop_orders.update_one(
                {"id": order.get("id")},
                {"$push": {"email_log": {
                    "status": new_status,
                    "to": customer_email,
                    "ok": True,
                    "resend_id": (result or {}).get("id") if isinstance(result, dict) else None,
                    "sent_at": datetime.now(timezone.utc).isoformat(),
                }}}
            )
        except Exception:
            pass
        return {"success": True, "email_id": (result or {}).get("id") if isinstance(result, dict) else None}
        
    except Exception as e:
        err = str(e)
        logging.error(f"Failed to send order status email: {err}")
        # Persist the failure too — admin will see it in the order detail page
        try:
            from config import get_db
            db = get_db()
            await db.shop_orders.update_one(
                {"id": order.get("id")},
                {"$push": {"email_log": {
                    "status": new_status,
                    "to": customer_email,
                    "ok": False,
                    "error": err[:300],
                    "sent_at": datetime.now(timezone.utc).isoformat(),
                }}}
            )
        except Exception:
            pass
        return {"success": False, "error": err}


async def send_shop_order_confirmation(order: dict) -> dict:
    """Send order confirmation email when shop order is placed"""
    return await send_order_status_notification(order, "confirmed")


# ─── Owner-notification + idempotent dispatch (16 Jun 2026 fix) ──────
# Built in response to a P0 incident: Carolina Santiago paid £834.63
# but neither she nor the owner received an email. Root cause: the
# polling endpoint sent the customer email but (a) the webhook fallback
# path didn't, and (b) there was no owner-notification email anywhere.
# This helper:
#   1. Atomically claims the right to email so webhook + poll path
#      can't double-send.
#   2. Sends the customer confirmation.
#   3. Sends a separate owner notification to ADMIN_EMAIL + online@.
#   4. Logs the attempt on the order doc for the admin UI.

ONLINE_ORDERS_INBOX = os.environ.get("ONLINE_ORDERS_INBOX", "online@tilestation.co.uk")


def _build_owner_notification_html(order: dict) -> str:
    """Minimal but complete summary the owner can read on their phone."""
    items_rows = ""
    for it in (order.get("items") or []):
        items_rows += (
            f"<tr><td style='padding:6px 8px;border-bottom:1px solid #e5e7eb'>"
            f"<strong>{it.get('name') or it.get('product_name') or 'Item'}</strong>"
            f"{' · ' + str(it.get('variant') or '') if it.get('variant') else ''}"
            f"</td>"
            f"<td style='padding:6px 8px;border-bottom:1px solid #e5e7eb;text-align:center'>"
            f"{it.get('quantity', 1)}</td>"
            f"<td style='padding:6px 8px;border-bottom:1px solid #e5e7eb;text-align:right'>"
            f"£{float(it.get('subtotal') or it.get('total') or (it.get('price', 0) * it.get('quantity', 1))):.2f}"
            f"</td></tr>"
        )
    addr = order.get("shipping_address") or order.get("delivery_address") or {}
    addr_str = ""
    if isinstance(addr, dict):
        parts = [addr.get(k) for k in ("line1", "line2", "city", "postcode", "country") if addr.get(k)]
        addr_str = "<br/>".join(parts)
    elif isinstance(addr, str):
        addr_str = addr.replace("\n", "<br/>")
    return f"""
    <div style="font-family:Arial,sans-serif;max-width:640px;margin:0 auto">
      <h2 style="background:#0f172a;color:#fff;padding:14px 18px;margin:0">
        🛒 New online order — {order.get('order_number') or order.get('id', '?')}
      </h2>
      <div style="padding:16px 18px;background:#f8fafc">
        <p><strong>Total:</strong> £{float(order.get('total', 0)):.2f}
           &middot; <strong>Items:</strong> {len(order.get('items') or [])}
           &middot; <strong>Status:</strong> {order.get('status', 'confirmed')}</p>
        <p><strong>Customer:</strong> {order.get('customer_name') or 'Guest'}
           &middot; <a href='mailto:{order.get('customer_email', '')}'>{order.get('customer_email', '')}</a>
           {' · ' + order.get('customer_phone', '') if order.get('customer_phone') else ''}</p>
        {f"<p><strong>Delivery to:</strong><br/>{addr_str}</p>" if addr_str else ""}
        <table style="width:100%;border-collapse:collapse;font-size:13px;margin-top:12px;background:#fff">
          <thead><tr style="background:#1e293b;color:#fff">
            <th style="padding:8px;text-align:left">Item</th>
            <th style="padding:8px;text-align:center">Qty</th>
            <th style="padding:8px;text-align:right">Subtotal</th>
          </tr></thead>
          <tbody>{items_rows or '<tr><td colspan=3 style=padding:10px>(no items)</td></tr>'}</tbody>
        </table>
        <p style="margin-top:18px;font-size:12px;color:#64748b">
          Open in admin: <a href='{COMPANY_WEBSITE}/admin/online-orders'>{COMPANY_WEBSITE}/admin/online-orders</a>
        </p>
      </div>
    </div>
    """


async def _send_owner_order_notification(order: dict) -> dict:
    """E-mail the owner / online-orders inbox that a new order has been placed."""
    if not RESEND_AVAILABLE or not RESEND_API_KEY:
        return {"success": False, "error": "Email service not available"}
    recipients = list({e for e in [ONLINE_ORDERS_INBOX, ADMIN_EMAIL] if e})
    if not recipients:
        return {"success": False, "error": "No owner recipients configured"}
    try:
        order_number = order.get("order_number") or order.get("id", "?")
        total = float(order.get("total", 0))
        subject = f"🛒 New order {order_number} — £{total:.2f}"
        resend.api_key = RESEND_API_KEY
        result = await asyncio.to_thread(resend.Emails.send, {
            "from": f"{COMPANY_NAME} Online <{SENDER_EMAIL}>",
            "to": recipients,
            "reply_to": [order.get("customer_email")] if order.get("customer_email") else None,
            "subject": subject,
            "html": _build_owner_notification_html(order),
        })
        logging.info(f"Owner notification sent for {order_number} to {recipients}")
        return {"success": True, "email_id": (result or {}).get("id") if isinstance(result, dict) else None}
    except Exception as e:  # noqa: BLE001
        logging.error(f"Owner notification failed for order {order.get('id')}: {e}")
        return {"success": False, "error": str(e)}


async def send_order_confirmation_emails_idempotent(order_id: str) -> dict:
    """Send the customer confirmation + owner notification for a paid
    shop order — exactly once, atomically.

    Multiple code paths can call this (Stripe webhook, success-page
    poll, "Resend confirmation" admin button). The first caller wins;
    every subsequent caller short-circuits with {already_sent: True}.

    Returns:
        {
          "already_sent": bool,    # True if a previous call already sent
          "customer":    {success, error?, email_id?},
          "owner":       {success, error?, email_id?},
        }
    """
    from config import get_db  # noqa: PLC0415 — avoid import cycle
    db = get_db()
    now_iso = datetime.now(timezone.utc).isoformat()

    # Atomic claim: only the first caller for whom the marker is unset
    # gets the row back; everyone else gets None.
    claimed = await db.shop_orders.find_one_and_update(
        {"id": order_id, "confirmation_email_sent_at": {"$in": [None, ""]}},
        {"$set": {"confirmation_email_sent_at": now_iso}},
        return_document=True,  # ReturnDocument.AFTER (motor accepts bool too)
    )
    # Fallback to the legacy shape where the field was never written
    if not claimed:
        claimed = await db.shop_orders.find_one_and_update(
            {"id": order_id, "confirmation_email_sent_at": {"$exists": False}},
            {"$set": {"confirmation_email_sent_at": now_iso}},
            return_document=True,
        )

    if not claimed:
        # Someone else already sent. Return early — DO NOT double-email.
        order = await db.shop_orders.find_one({"id": order_id}, {"_id": 0, "confirmation_email_sent_at": 1})
        return {
            "already_sent": True,
            "claimed_at": (order or {}).get("confirmation_email_sent_at"),
            "customer": {"success": True, "skipped": True},
            "owner":    {"success": True, "skipped": True},
        }

    # Strip _id (Motor sometimes returns it)
    claimed.pop("_id", None)

    # Send both in parallel — owner failures shouldn't block customer
    # email and vice versa.
    customer_result, owner_result = await asyncio.gather(
        send_shop_order_confirmation(claimed),
        _send_owner_order_notification(claimed),
        return_exceptions=True,
    )
    if isinstance(customer_result, Exception):
        customer_result = {"success": False, "error": str(customer_result)}
    if isinstance(owner_result, Exception):
        owner_result = {"success": False, "error": str(owner_result)}

    # If BOTH failed catastrophically, unset the marker so a retry can
    # succeed. (Customer-only success is enough to keep it claimed —
    # owner can be resent manually.)
    if (not customer_result.get("success")) and (not owner_result.get("success")):
        try:
            await db.shop_orders.update_one(
                {"id": order_id},
                {"$unset": {"confirmation_email_sent_at": ""}},
            )
        except Exception:
            pass

    # Audit log on the order doc
    try:
        await db.shop_orders.update_one(
            {"id": order_id},
            {"$push": {"email_log": {
                "kind": "order_confirmation",
                "sent_at": now_iso,
                "customer_ok": bool(customer_result.get("success")),
                "owner_ok":    bool(owner_result.get("success")),
                "customer_error": customer_result.get("error"),
                "owner_error":    owner_result.get("error"),
            }}}
        )
    except Exception:
        pass

    return {
        "already_sent": False,
        "claimed_at": now_iso,
        "customer": customer_result,
        "owner": owner_result,
    }



# ============ TRADE ACCOUNT REGISTRATION EMAILS ============

# ADMIN_EMAIL constant is defined at the top of the module.


async def send_trade_welcome_email(customer: dict) -> dict:
    """Send welcome/confirmation email to newly registered trade customer"""
    if not RESEND_AVAILABLE or not RESEND_API_KEY:
        logging.warning("Resend not available - skipping trade welcome email")
        return {"success": False, "error": "Email service not available"}

    try:
        customer_email = customer.get("email", "")
        customer_name = customer.get("name", customer.get("contact_name", ""))
        business_name = customer.get("business_name", "")
        trade_tier = (customer.get("trade_tier", "bronze") or "bronze").capitalize()
        trade_discount = customer.get("trade_discount", 5)

        html_content = f"""
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; background: #f9fafb;">
            <div style="background: #333333; padding: 30px 20px; text-align: center;">
                <h1 style="color: #F7EA1C; margin: 0; font-size: 24px;">Tile Station</h1>
                <p style="color: #ccc; margin: 8px 0 0; font-size: 14px;">Trade Account</p>
            </div>
            <div style="background: white; padding: 30px 20px;">
                <h2 style="color: #333; margin: 0 0 10px;">Welcome, {customer_name}!</h2>
                <p style="color: #666; line-height: 1.6;">
                    Your trade account for <strong>{business_name}</strong> has been created and is ready to use.
                    You can log in now with the email and password you registered with.
                </p>
                <div style="background: #f0fdf4; border: 1px solid #bbf7d0; border-radius: 8px; padding: 20px; margin: 20px 0;">
                    <h3 style="color: #166534; margin: 0 0 10px;">Your Trade Benefits</h3>
                    <ul style="color: #166534; padding-left: 20px; margin: 0;">
                        <li>Tier: <strong>{trade_tier}</strong></li>
                        <li>Trade Discount: <strong>{trade_discount}% off</strong></li>
                        <li>All prices shown <strong>ex. VAT</strong></li>
                        <li>Credit back on every order</li>
                    </ul>
                </div>
                <div style="text-align: center; margin: 25px 0;">
                    <a href="{COMPANY_WEBSITE}/shop/trade/login" style="background: #333333; color: #F7EA1C; padding: 14px 32px; text-decoration: none; border-radius: 8px; font-weight: bold; display: inline-block;">
                        Log In to Your Trade Account
                    </a>
                </div>
                <p style="color: #999; font-size: 13px; margin-top: 20px;">
                    If you have any questions, contact us at info@tilestation.co.uk or call 01732 424242.
                </p>
            </div>
            <div style="background: #f3f4f6; padding: 20px; text-align: center;">
                <p style="color: #9ca3af; font-size: 12px; margin: 0;">
                    &copy; {datetime.now().year} {COMPANY_NAME}. All rights reserved.
                </p>
            </div>
        </div>
        """

        resend.api_key = RESEND_API_KEY
        result = await asyncio.to_thread(resend.Emails.send, {
            "from": f"{COMPANY_NAME} <{SENDER_EMAIL}>",
            "to": [customer_email],
            "subject": f"Welcome to Tile Station Trade - Your Account is Ready!",
            "html": html_content,
        })

        logging.info(f"Trade welcome email sent to {customer_email}")
        return {"success": True, "email_id": result.get("id")}

    except Exception as e:
        logging.error(f"Failed to send trade welcome email: {str(e)}")
        return {"success": False, "error": str(e)}


async def send_trade_first_login_email(customer: dict, *, returning: bool) -> dict:
    """One-off note the first time a trader signs in (tracked since 8 Sep 2026):
    their trade ref + current credit balance. `returning` = account predates
    tracking, so we greet them as an existing customer, not a newcomer."""
    if not RESEND_AVAILABLE or not RESEND_API_KEY:
        return {"success": False, "error": "Email service not available"}
    to = customer.get("email") or ""
    if "@" not in to:
        return {"success": False, "error": "No email"}
    first = (customer.get("name") or "").strip().split(" ")[0] or "there"
    ref = customer.get("trade_account_number") or "—"
    credit = float(customer.get("credit_balance") or 0)
    rate = customer.get("credit_rate") or 5
    heading = f"Good to see you online, {first}" if returning else f"Welcome to Tile Station Trade, {first}"
    intro = ("Thanks for signing in to your trade account — here's everything you need at a glance."
             if returning else "Your trade account is live and you're signed in — here's everything you need at a glance.")
    credit_line = (f"You have <strong>£{credit:.2f}</strong> trade credit ready to use on your next order."
                   if credit > 0 else f"You earn <strong>{rate}% credit back</strong> on every order — it builds up here automatically.")
    html = f"""
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; background: #f9fafb;">
        <div style="background: #333333; padding: 26px 20px; text-align: center;">
            <h1 style="color: #F7EA1C; margin: 0; font-size: 24px;">Tile Station</h1>
            <p style="color: #ccc; margin: 8px 0 0; font-size: 14px;">Trade Account</p>
        </div>
        <div style="background: white; padding: 28px 20px;">
            <h2 style="color: #333; margin: 0 0 10px;">{heading}</h2>
            <p style="color: #666; line-height: 1.6;">{intro}</p>
            <div style="display:flex; gap:12px; margin: 20px 0;">
                <div style="flex:1; background:#f3f4f6; border-radius:8px; padding:16px; text-align:center;">
                    <div style="font-size:11px; letter-spacing:1px; color:#6b7280; text-transform:uppercase;">Your trade ref</div>
                    <div style="font-size:22px; font-weight:bold; color:#111; margin-top:4px; font-family:monospace;">{ref}</div>
                </div>
                <div style="flex:1; background:#f0fdf4; border:1px solid #bbf7d0; border-radius:8px; padding:16px; text-align:center;">
                    <div style="font-size:11px; letter-spacing:1px; color:#166534; text-transform:uppercase;">Credit balance</div>
                    <div style="font-size:22px; font-weight:bold; color:#166534; margin-top:4px;">£{credit:.2f}</div>
                </div>
            </div>
            <p style="color: #666; line-height: 1.6;">{credit_line} Quote your trade ref <strong>{ref}</strong> in any showroom and your account, prices and credit follow you.</p>
            <div style="text-align: center; margin: 24px 0 8px;">
                <a href="{COMPANY_WEBSITE}/shop/trade/account" style="background: #333333; color: #F7EA1C; padding: 13px 30px; text-decoration: none; border-radius: 8px; font-weight: bold; display: inline-block;">Open my trade dashboard</a>
            </div>
            <p style="color: #999; font-size: 13px; margin-top: 20px;">Questions? Reply to this email or call 01732 424242.</p>
        </div>
        <div style="background: #f3f4f6; padding: 16px; text-align: center;">
            <p style="color: #9ca3af; font-size: 12px; margin: 0;">&copy; {datetime.now().year} {COMPANY_NAME}. All rights reserved.</p>
        </div>
    </div>"""
    try:
        resend.api_key = RESEND_API_KEY
        result = await asyncio.to_thread(resend.Emails.send, {
            "from": f"{COMPANY_NAME} <{SENDER_EMAIL}>", "to": [to],
            "subject": f"{'Good to see you online' if returning else 'Welcome to Tile Station Trade'} — your trade ref is {ref}",
            "html": html,
        })
        return {"success": True, "email_id": (result or {}).get("id")}
    except Exception as e:
        logging.error(f"Failed to send trade first-login email: {e}")
        return {"success": False, "error": str(e)}


async def send_trade_admin_notification(customer: dict) -> dict:
    """Send notification email to admin when a new trade account is registered"""
    if not RESEND_AVAILABLE or not RESEND_API_KEY:
        logging.warning("Resend not available - skipping trade admin notification")
        return {"success": False, "error": "Email service not available"}

    try:
        customer_name = customer.get("name", customer.get("contact_name", ""))
        business_name = customer.get("business_name", "")
        trade_type = customer.get("trade_type", "")
        phone = customer.get("phone", "")
        email = customer.get("email", "")
        address = customer.get("address", {})
        estimated_spend = customer.get("estimated_monthly_spend", "")

        html_content = f"""
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; background: #f9fafb;">
            <div style="background: #333333; padding: 30px 20px; text-align: center;">
                <h1 style="color: #F7EA1C; margin: 0; font-size: 24px;">New Trade Account</h1>
            </div>
            <div style="background: white; padding: 30px 20px;">
                <h2 style="color: #333; margin: 0 0 15px;">New Trade Registration</h2>
                <p style="color: #666;">A new trade account has been created on the website:</p>
                <table style="width: 100%; border-collapse: collapse; margin: 20px 0;">
                    <tr style="border-bottom: 1px solid #eee;">
                        <td style="padding: 10px 0; color: #999; width: 140px;">Business Name</td>
                        <td style="padding: 10px 0; font-weight: bold;">{business_name}</td>
                    </tr>
                    <tr style="border-bottom: 1px solid #eee;">
                        <td style="padding: 10px 0; color: #999;">Contact Name</td>
                        <td style="padding: 10px 0;">{customer_name}</td>
                    </tr>
                    <tr style="border-bottom: 1px solid #eee;">
                        <td style="padding: 10px 0; color: #999;">Email</td>
                        <td style="padding: 10px 0;">{email}</td>
                    </tr>
                    <tr style="border-bottom: 1px solid #eee;">
                        <td style="padding: 10px 0; color: #999;">Phone</td>
                        <td style="padding: 10px 0;">{phone}</td>
                    </tr>
                    <tr style="border-bottom: 1px solid #eee;">
                        <td style="padding: 10px 0; color: #999;">Trade Type</td>
                        <td style="padding: 10px 0;">{trade_type}</td>
                    </tr>
                    <tr style="border-bottom: 1px solid #eee;">
                        <td style="padding: 10px 0; color: #999;">Est. Monthly Spend</td>
                        <td style="padding: 10px 0;">{estimated_spend}</td>
                    </tr>
                    <tr>
                        <td style="padding: 10px 0; color: #999;">Address</td>
                        <td style="padding: 10px 0;">{address.get('line1', '')} {address.get('city', '')} {address.get('postcode', '')}</td>
                    </tr>
                </table>
                <p style="color: #666; font-size: 13px;">
                    The account has been auto-approved with Bronze tier (5% discount).
                </p>
            </div>
            <div style="background: #f3f4f6; padding: 20px; text-align: center;">
                <p style="color: #9ca3af; font-size: 12px; margin: 0;">
                    &copy; {datetime.now().year} {COMPANY_NAME}. All rights reserved.
                </p>
            </div>
        </div>
        """

        resend.api_key = RESEND_API_KEY
        result = await asyncio.to_thread(resend.Emails.send, {
            "from": f"{COMPANY_NAME} <{SENDER_EMAIL}>",
            "to": [ADMIN_EMAIL],
            "subject": f"New Trade Account: {business_name} ({customer_name})",
            "html": html_content,
        })

        logging.info(f"Trade admin notification sent to {ADMIN_EMAIL} for {business_name}")
        return {"success": True, "email_id": result.get("id")}

    except Exception as e:
        logging.error(f"Failed to send trade admin notification: {str(e)}")
        return {"success": False, "error": str(e)}



# ============================================================================
# Shop Order Status — customer-facing transactional emails
# ============================================================================

# Map of internal order status → human-friendly subject + body copy.
# When the admin moves an order to one of these statuses on the Online Orders
# page, the customer gets a polite update by email.
_ORDER_STATUS_EMAIL_TEMPLATES = {
    "confirmed": {
        "subject": "We've got your order #{order_number} — thank you!",
        "headline": "Order confirmed",
        "body": (
            "Thanks for shopping with Tile Station! We've received your order and "
            "our team is starting work on it now. We'll let you know as soon as it's "
            "ready to ship or collect."
        ),
        "accent": "#1C1917",
    },
    "processing": {
        "subject": "Your order #{order_number} is being prepared",
        "headline": "We're packing your order",
        "body": (
            "Good news — your order is now in production / being packed by our "
            "warehouse team. The next update will come when it's ready to ship "
            "or available for collection."
        ),
        "accent": "#7C3AED",
    },
    "ready_for_collection": {
        "subject": "Order #{order_number} is ready for collection",
        "headline": "Ready for you to collect",
        "body": (
            "Your order is now ready to collect from our store. Please bring photo "
            "ID and your order number when you come in. Opening hours are on our "
            "website."
        ),
        "accent": "#0891B2",
    },
    "shipped": {
        "subject": "Order #{order_number} is on its way",
        "headline": "Out for delivery",
        "body": (
            "Your order has left our warehouse and is on its way to you. You should "
            "receive it within the timeframe we quoted at checkout. If anything looks "
            "wrong on arrival, just reply to this email and we'll sort it."
        ),
        "accent": "#EA580C",
    },
    "delivered": {
        "subject": "Order #{order_number} has been delivered",
        "headline": "Delivered — enjoy your tiles!",
        "body": (
            "Your order has been marked as delivered. We hope everything looks great. "
            "If you have any issues with the goods, please contact us within 14 days "
            "and we'll make it right."
        ),
        "accent": "#059669",
    },
    "collected": {
        "subject": "Thanks for collecting order #{order_number}",
        "headline": "Order collected — thank you!",
        "body": (
            "Thanks for picking up your order. We hope you love your tiles! If "
            "anything's not quite right, get in touch within 14 days and we'll help."
        ),
        "accent": "#059669",
    },
    "cancelled": {
        "subject": "Order #{order_number} has been cancelled",
        "headline": "Order cancelled",
        "body": (
            "Your order has been cancelled. Any payment taken will be refunded to your "
            "original payment method within 5 business days. If this was unexpected, "
            "please reply to this email so we can investigate."
        ),
        "accent": "#E11D48",
    },
}


def _format_currency_uk(value) -> str:
    try:
        return f"£{float(value):.2f}"
    except Exception:
        return "£—"


async def send_shop_order_status_email(order: dict, new_status: str):
    """
    Send a transactional email to the customer when their online order moves
    to one of the tracked statuses (confirmed / processing / ready_for_collection /
    shipped / delivered / collected / cancelled).

    Silently no-ops if Resend isn't configured or the customer email is missing.
    Errors are logged but never raised — status updates must NOT fail because of
    a flaky email service.
    """
    if not RESEND_AVAILABLE or not RESEND_API_KEY:
        logging.warning("[shop-status-email] Resend not configured — skipping")
        return False

    template = _ORDER_STATUS_EMAIL_TEMPLATES.get((new_status or "").lower())
    if not template:
        return False  # Not a status we email about (e.g. 'pending')

    customer_email = order.get("customer_email")
    if not customer_email:
        logging.warning(f"[shop-status-email] no customer_email on order {order.get('id')}")
        return False

    order_number = order.get("order_number", "")
    customer_name = order.get("customer_name") or "Customer"
    total = _format_currency_uk(order.get("total", 0))
    delivery_method = order.get("delivery_method", "delivery")

    subject = template["subject"].format(order_number=order_number)
    headline = template["headline"]
    body = template["body"]
    accent = template["accent"]

    # Build a compact item summary table (max 5 rows)
    items = order.get("items", []) or []
    item_rows_html = ""
    for it in items[:5]:
        name = (it.get("name") or it.get("product_id") or "—")[:80]
        qty = it.get("quantity", 0)
        price = _format_currency_uk(it.get("price", 0))
        line = _format_currency_uk(float(it.get("price", 0)) * float(it.get("quantity", 0)))
        item_rows_html += (
            f'<tr>'
            f'<td style="padding:8px 12px;border-bottom:1px solid #eee;">{name}</td>'
            f'<td style="padding:8px 12px;border-bottom:1px solid #eee;text-align:right;">{qty}</td>'
            f'<td style="padding:8px 12px;border-bottom:1px solid #eee;text-align:right;">{price}</td>'
            f'<td style="padding:8px 12px;border-bottom:1px solid #eee;text-align:right;font-weight:600;">{line}</td>'
            f'</tr>'
        )
    if len(items) > 5:
        item_rows_html += (
            f'<tr><td colspan="4" style="padding:8px 12px;color:#666;font-size:12px;">'
            f'...and {len(items) - 5} more item(s)</td></tr>'
        )

    delivery = order.get("delivery_address") or {}
    delivery_lines = [
        delivery.get("address1"), delivery.get("address2"),
        delivery.get("city"), delivery.get("county"),
        (delivery.get("postcode") or "").upper(),
    ]
    delivery_str = ", ".join([line for line in delivery_lines if line]) or "Click & Collect from store"

    # Personalised trade-credit balance banner — silent for non-trade or zero-balance.
    trade_credit_banner_html = await _render_trade_credit_balance_banner_html(customer_email)

    html_content = f"""
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif; max-width: 620px; margin: 0 auto; background:#F9F8F6;">
      <div style="background:#1C1917; padding:20px 24px;">
        <h1 style="color:#F7EA1C; margin:0; font-size:24px; letter-spacing:-0.5px;">Tile Station</h1>
      </div>
      <div style="background:#fff; padding:28px 24px;">
        {trade_credit_banner_html}
        <div style="display:inline-block; padding:6px 12px; background:{accent}; color:#fff; border-radius:999px; font-size:11px; font-weight:600; letter-spacing:0.4px; text-transform:uppercase; margin-bottom:14px;">
          {headline}
        </div>
        <h2 style="font-size:22px; color:#1C1917; margin:0 0 12px 0;">Hi {customer_name.split(' ')[0] if customer_name else 'there'},</h2>
        <p style="font-size:15px; color:#444; line-height:1.55; margin:0 0 18px 0;">{body}</p>

        <div style="background:#F9F8F6; border:1px solid #E7E5E4; border-radius:10px; padding:16px; margin:18px 0;">
          <div style="display:flex; justify-content:space-between; font-size:13px; color:#555;">
            <span><strong>Order:</strong> #{order_number}</span>
            <span><strong>Total:</strong> {total}</span>
          </div>
          <div style="font-size:13px; color:#555; margin-top:6px;"><strong>{'Collection' if delivery_method == 'collection' else 'Delivery to'}:</strong> {delivery_str}</div>
        </div>

        {f'''<table style="width:100%; border-collapse:collapse; margin:14px 0; font-size:13px;">
          <thead>
            <tr style="background:#F3F0EB;">
              <th style="padding:8px 12px; text-align:left; color:#555;">Item</th>
              <th style="padding:8px 12px; text-align:right; color:#555;">Qty</th>
              <th style="padding:8px 12px; text-align:right; color:#555;">Price</th>
              <th style="padding:8px 12px; text-align:right; color:#555;">Total</th>
            </tr>
          </thead>
          <tbody>{item_rows_html}</tbody>
        </table>''' if items else ''}

        <p style="font-size:13px; color:#888; margin:26px 0 0 0;">
          Need help? Just reply to this email or contact us at
          <a href="mailto:online@tilestation.co.uk" style="color:#1C1917;">online@tilestation.co.uk</a>.
        </p>
      </div>
      <div style="text-align:center; padding:14px 24px; color:#999; font-size:11px;">
        Tile Station · Unit 3 Trade City, Coldharbour Road, Northfleet, Gravesend DA11 8AB<br/>
        Company No: 11982550 · VAT No: 324 251 828
      </div>
    </div>
    """

    try:
        resend.api_key = RESEND_API_KEY
        sender = os.environ.get("SENDER_EMAIL", "onboarding@resend.dev")
        await asyncio.to_thread(resend.Emails.send, {
            "from": f"Tile Station <{sender}>",
            "to": [customer_email],
            "subject": subject,
            "html": html_content,
            "reply_to": "online@tilestation.co.uk",
        })
        logging.info(f"[shop-status-email] sent '{new_status}' to {customer_email} for {order_number}")
        return True
    except Exception as e:
        logging.error(f"[shop-status-email] failed for order {order_number}: {e}")
        return False
