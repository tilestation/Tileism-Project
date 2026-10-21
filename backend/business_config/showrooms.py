"""
Frozen, code-side copy of Tile Station showroom details.

Why this file exists
--------------------
The live `showrooms` MongoDB collection is the source of truth for the
storefront, but the AI City Landing Page generator (`routes/city_landing_pages.py`)
needs to inject real address / phone / postcode / opening-hours into its
LLM prompt every time it generates a page. Reading from MongoDB inside
the prompt builder works, but a frozen, version-controlled copy:

  • survives a DB outage,
  • makes the AI prompt deterministic and reviewable in code review,
  • lets us assign each town to its *nearest* showroom in one place.

If a showroom moves or a phone number changes, update this file AND the
DB record. Both must stay in sync. Last refreshed: Feb 2026 (from prod).
"""

from __future__ import annotations

# ─── Real showroom data (mirrored from production `showrooms` collection) ──
SHOWROOMS: dict[str, dict] = {
    "gravesend": {
        "name": "Tile Station Gravesend",
        "address": "Unit 3 Trade City, Coldharbour Road, Northfleet, Gravesend",
        "postcode": "DA11 8AB",
        "phone": "01474 878 989",
        "email": "gravesend@tilestation.co.uk",
        "hours": "Mon-Fri 07:00-18:00, Sat 08:00-18:00, Sun 10:00-16:00",
        "lat": 51.4413,
        "lng": 0.3669,
        "is_open": True,
    },
    "tonbridge": {
        "name": "Tile Station Tonbridge",
        "address": "Unit 6, 402 Vale Road, Postern Industrial Estate, Tonbridge, Kent",
        "postcode": "TN9 1SP",
        "phone": "01732 914 374",
        "email": "tonbridge@tilestation.co.uk",
        "hours": "Mon-Fri 07:30-17:30, Sat 08:30-17:30, Sun 10:00-16:00",
        "lat": 51.1952,
        "lng": 0.2746,
        "is_open": True,
    },
    "chingford": {
        "name": "Tile Station Chingford",
        "address": "Unit 10, Deacon Trading Estate, Chingford, London",
        "postcode": "E4 8QF",
        "phone": "020 8527 1363",
        "email": "chingford@tilestation.co.uk",
        "hours": "Mon-Fri 07:30-17:30, Sat 08:30-17:30, Sun 10:00-16:00",
        "lat": 51.6276,
        "lng": 0.0026,
        "is_open": False,  # permanently closed — kept for historical data lookups only
    },
    "sydenham": {
        "name": "Tile Station Sydenham",
        "address": "Unit 2, Sydenham Industrial Estate, Langley Bridge Road, Sydenham, London",
        "postcode": "SE26 5BA",
        "phone": "0204 629 7435",
        "email": "sydenham@tilestation.co.uk",
        "hours": "Opening soon — call ahead",
        "lat": 51.4286,
        "lng": -0.0548,
        "is_open": False,  # currently "Opening Soon" on prod
    },
}


# ─── Town → nearest *open* showroom mapping ────────────────────────────────
# Hand-curated to make sure each AI-generated page sends the customer to
# the showroom that's actually closest to them by drive time, ignoring
# any "Opening Soon" branches.
TOWN_NEAREST_SHOWROOM: dict[str, str] = {
    # Gravesend catchment — North/Mid Kent + South-East London/Essex bridge
    "gravesend": "gravesend",
    "dartford": "gravesend",
    "chatham": "gravesend",
    "rochester": "gravesend",
    "sittingbourne": "gravesend",
    "canterbury": "gravesend",
    "dover": "gravesend",
    "folkestone": "gravesend",
    "ashford": "gravesend",
    "margate": "gravesend",
    "whitstable": "gravesend",
    "bexley": "gravesend",
    "bromley": "gravesend",
    "greenwich": "gravesend",
    "lewisham": "gravesend",
    "chislehurst": "gravesend",
    "orpington": "gravesend",
    "grays": "gravesend",
    "tilbury": "gravesend",

    # Tonbridge catchment — South Kent + Sussex commuter belt
    "tonbridge": "tonbridge",
    "tunbridge-wells": "tonbridge",
    "sevenoaks": "tonbridge",
    "maidstone": "tonbridge",
    "redhill": "tonbridge",
    "reigate": "tonbridge",
    "guildford": "tonbridge",
    "brighton": "tonbridge",
    "eastbourne": "tonbridge",
    "hastings": "tonbridge",

    # North/East London + South Essex — Chingford showroom permanently
    # closed; routed to Gravesend (head office) via the default fallback
    # in get_nearest_showroom() below.
}


def get_nearest_showroom(town_slug: str) -> dict:
    """Return the showroom record nearest to a given town slug.

    Falls back to Gravesend (head-office showroom) if the town isn't in
    our hand-curated map — which means we'll still emit a real, callable
    address rather than a placeholder.
    """
    sr_slug = TOWN_NEAREST_SHOWROOM.get(town_slug, "gravesend")
    sr = SHOWROOMS.get(sr_slug) or SHOWROOMS["gravesend"]
    return {**sr, "slug": sr_slug}


def all_open_showrooms() -> list[dict]:
    """For nationwide pages: list every currently-open showroom."""
    return [{**sr, "slug": slug} for slug, sr in SHOWROOMS.items() if sr.get("is_open")]
