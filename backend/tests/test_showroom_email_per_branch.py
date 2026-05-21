"""Regression tests for the 20 May 2026 per-showroom-email + order-alert
fanout fixes.

User-reported bugs (verbatim):
  1) "Why am I not receiving email notifications about the orders."
     Root cause: ORDERS_ADMIN_EMAIL defaulted to a black-hole inbox.
  2) "When Tonbridge staff sends a copy of invoice to customer, it goes
     to customer via gravesend@tilestation.co.uk."
     Root cause: from-address + body footer were hardcoded to Gravesend
     in the EPOS invoice email endpoint.
"""
import sys
sys.path.insert(0, "/app/backend")

from services.email import get_showroom_contact, SHOWROOM_CONTACTS


# ─── Per-showroom contact resolver ──────────────────────────────────────


def test_get_showroom_contact_by_slug_string():
    contact = get_showroom_contact("tonbridge")
    assert contact["email"] == "tonbridge@tilestation.co.uk"
    assert contact["phone"] == "01732 914 374"
    assert "Tonbridge" in contact["name"]
    assert "TN9" in contact["postcode"]


def test_get_showroom_contact_by_partial_name():
    """'Tile Station Tonbridge' must resolve to tonbridge — not gravesend."""
    contact = get_showroom_contact("Tile Station Tonbridge")
    assert contact["email"] == "tonbridge@tilestation.co.uk"
    assert "Tonbridge" in contact["name"]


def test_get_showroom_contact_by_dict_with_id():
    contact = get_showroom_contact({"id": "chingford", "name": "Tile Station Chingford"})
    assert contact["email"] == "chingford@tilestation.co.uk"
    assert contact["phone"] == "020 8527 1363"


def test_get_showroom_contact_db_values_override_static_defaults():
    """If the DB has a different (updated) phone on the showroom doc,
    that wins over the static SHOWROOM_CONTACTS phone."""
    contact = get_showroom_contact({
        "id": "gravesend",
        "name": "Tile Station Gravesend",
        "phone": "01474 999 999",  # newer phone in DB
        "email": "newgravesend@tilestation.co.uk",  # rebrand
    })
    assert contact["phone"] == "01474 999 999"
    assert contact["email"] == "newgravesend@tilestation.co.uk"


def test_get_showroom_contact_none_falls_back_to_gravesend():
    contact = get_showroom_contact(None)
    assert contact["email"] == "gravesend@tilestation.co.uk"
    assert contact["phone"] == "01474 878 989"


def test_get_showroom_contact_unknown_slug_falls_back_to_gravesend():
    contact = get_showroom_contact("nonexistent_showroom")
    assert contact["email"] == "gravesend@tilestation.co.uk"


def test_all_four_showrooms_have_distinct_contacts():
    """No two showrooms may share a phone, email, or postcode — that
    would mean the dispatcher dropped a key during refactoring."""
    emails = {c["email"] for c in SHOWROOM_CONTACTS.values()}
    phones = {c["phone"] for c in SHOWROOM_CONTACTS.values()}
    postcodes = {c["postcode"] for c in SHOWROOM_CONTACTS.values()}
    assert len(emails) == len(SHOWROOM_CONTACTS), "Showroom emails must be unique"
    assert len(phones) == len(SHOWROOM_CONTACTS), "Showroom phones must be unique"
    assert len(postcodes) == len(SHOWROOM_CONTACTS), "Showroom postcodes must be unique"


def test_contact_card_has_all_required_keys():
    """Every contact card must be safe to render — every key always present."""
    required = {"name", "email", "phone", "address", "postcode"}
    for slug, contact in SHOWROOM_CONTACTS.items():
        assert required.issubset(contact.keys()), (
            f"Showroom '{slug}' missing keys: {required - contact.keys()}"
        )
        for key in required:
            assert contact[key], f"Showroom '{slug}' has empty {key}"


def test_every_showroom_email_is_on_verified_domain():
    """Every showroom send-from address must be on @tilestation.co.uk
    so it's covered by the domain-level Resend verification. If a future
    contact card adds an off-domain email (e.g. @gmail.com), Resend will
    refuse to send and customers won't get the invoice."""
    for slug, contact in SHOWROOM_CONTACTS.items():
        assert contact["email"].endswith("@tilestation.co.uk"), (
            f"Showroom '{slug}' email '{contact['email']}' is NOT on the "
            f"verified @tilestation.co.uk domain — Resend will reject sends "
            f"from this address."
        )


# ─── send_simple_email_if_possible from_override behaviour ────────────────


def test_send_simple_accepts_from_override(monkeypatch):
    """from_override must take priority over the default SENDER_EMAIL.
    Critical for the 20 May 2026 email policy:
      • online@ for online-customer emails only
      • qasim@ for personal notifications only (never sending)
      • notifications@ for internal admin alerts
    """
    import asyncio
    from services import email as email_svc

    captured = {}

    class _StubEmails:
        @staticmethod
        def send(payload):
            captured.update(payload)
            return {"id": "stub-id"}

    monkeypatch.setattr(email_svc, "RESEND_AVAILABLE", True)
    monkeypatch.setattr(email_svc, "RESEND_API_KEY", "test_key")
    monkeypatch.setattr(email_svc.resend, "Emails", _StubEmails)

    asyncio.run(email_svc.send_simple_email_if_possible(
        "test@example.com",
        "Subject",
        "<p>Body</p>",
        from_override="Tile Station Alerts <notifications@tilestation.co.uk>",
    ))

    assert captured.get("from") == (
        "Tile Station Alerts <notifications@tilestation.co.uk>"
    ), f"from_override must win over default; got {captured.get('from')}"


def test_send_simple_default_from_is_company_alerts(monkeypatch):
    """When no override is passed, the legacy default is used."""
    import asyncio
    from services import email as email_svc

    captured = {}

    class _StubEmails:
        @staticmethod
        def send(payload):
            captured.update(payload)
            return {"id": "stub-id"}

    monkeypatch.setattr(email_svc, "RESEND_AVAILABLE", True)
    monkeypatch.setattr(email_svc, "RESEND_API_KEY", "test_key")
    monkeypatch.setattr(email_svc.resend, "Emails", _StubEmails)

    asyncio.run(email_svc.send_simple_email_if_possible(
        "test@example.com", "Subject", "<p>Body</p>",
    ))

    # Default From should include SENDER_EMAIL — typically online@ in prod,
    # but the EXACT value isn't asserted (depends on env). What we DO
    # assert: it's on the verified domain.
    from_header = captured.get("from", "")
    assert "@tilestation.co.uk>" in from_header or "tilestation.co.uk" in from_header, (
        f"Default from must be on the verified domain; got {from_header}"
    )
