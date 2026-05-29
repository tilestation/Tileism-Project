"""
Tile search engine — single source of truth for storefront search.

Two endpoints used to drift:
  • /api/tiles/search          (header autocomplete)
  • /api/shop/search-all       (search-results page)

That created the customer-facing bug where "high polish tiles" or
"green tiles" surfaced products in the autocomplete but produced
"0 items" on the results page (or vice versa). Same backend collection,
two different queries.

This module is now the only search function. Both endpoints call
`build_tile_search_query()` and `run_tile_search()` so a tile that
shows up in suggestions ALWAYS shows up on the results page.

Algorithm:
  1. Tokenise the query into words. Drop common stop-words like "tile",
     "tiles", "the", "a" — typing "tiles" in a tile shop adds no info.
  2. For each remaining token, build an `$or` of regex matches across
     ALL searchable fields (name, display_name, series, original_series,
     supplier_code, category, sub_categories, attributes.color,
     attributes.finish, attributes.material, rooms).
  3. Combine token clauses with `$and` so EVERY non-stop-word must be
     found somewhere on the tile. ("green polished tiles" → tile must
     have "green" AND "polished" SOMEWHERE in any of its fields.)
  4. `is_active != False` filter applied uniformly so autocomplete and
     results page show the same set.

Edge cases covered by tests:
  • Single word query → exact substring fallback (matches "high"
    inside "highline" because users mid-type)
  • Empty query / query <2 chars → empty results (caller decides UX)
  • Query containing only stop-words → falls back to single-word
    match on the first stop-word so "tiles" still returns SOMETHING
"""
from __future__ import annotations

import re
from typing import Any, Iterable, Optional

# Words that don't help search in a tile-shop context. We strip them so
# customers can type natural language ("green tiles" / "polished marble
# effect") without the literal word "tile" sabotaging the regex.
STOP_WORDS = frozenset({
    "tile", "tiles", "tiling",
    "the", "a", "an", "and", "or", "with", "for",
    "of", "to", "in", "on",
})

# Searchable fields, in priority order. Fields earlier in the list are
# preferred for "exact name match wins" sorting.
SEARCH_FIELDS = (
    "display_name",
    "name",
    "series",
    "original_series",
    "website_name",          # admin-overridden public name (24 May 2026)
    "supplier_code",
    "sku",
    "category",
    "categories",
    "sub_categories",
    "sub_category",          # singular form lives on legacy rows (24 May 2026)
    "main_category",         # ditto
    # 24 May 2026 — `styles` is the array field the Bulk Category
    # Editor writes "slate-effect" / "stone-effect" / "concrete-effect"
    # into. Without this entry a search for "slate effect" splits into
    # tokens ["slate", "effect"], finds neither in name/category/etc.
    # and returns 0 — exactly the customer-reported bug.
    "styles",
    "style",                 # belt-and-braces — some rows used singular
    "attributes.style",
    "attributes.styles",
    "attributes.color",
    "attributes.finish",
    "attributes.material",
    "attributes.type",
    # Top-level mirrors of the same attributes (the supplier-sync writes
    # both for compatibility; legacy and freshly-imported rows differ).
    "color",
    "finish",
    "material",
    "suitability",
    # Long-form text fields — let customers find tiles via descriptive
    # words admin used in copy ("polished marble look", "rustic terracotta").
    "description",
    "short_description",
    "rooms",
    "tags",
    "labels",
)


def _tokenise(q: str) -> list[str]:
    """Split a free-text query into search tokens.

    Lowercase, strip non-alphanumeric, deduplicate while preserving order.
    """
    if not q:
        return []
    parts = re.findall(r"[A-Za-z0-9]+", q.lower())
    seen: set[str] = set()
    out: list[str] = []
    for p in parts:
        if p in seen:
            continue
        seen.add(p)
        out.append(p)
    return out


def _strip_stopwords(tokens: list[str]) -> list[str]:
    """Drop tokens that don't carry search signal in a tile shop.

    Always keeps at least ONE token: if the user only typed stop-words
    (e.g. "tiles"), we fall back to that as a substring match so the
    UX shows results rather than an empty page.
    """
    meaningful = [t for t in tokens if t not in STOP_WORDS]
    if meaningful:
        return meaningful
    # All-stopword fallback — keep the first token so we still search
    return tokens[:1] if tokens else []


def _regex_clause_for_token(token: str, fields: Iterable[str]) -> dict:
    """Returns a single `$or` clause covering all fields for one token."""
    pattern = {"$regex": re.escape(token), "$options": "i"}
    return {"$or": [{f: pattern} for f in fields]}


def build_tile_search_query(
    q: str,
    *,
    extra_filters: Optional[dict] = None,
    fields: Iterable[str] = SEARCH_FIELDS,
    require_active: bool = True,
) -> Optional[dict]:
    """Build a MongoDB query for `tiles` collection.

    Returns None when the query is too short to be meaningful (caller
    should treat this as "no results" rather than running an unbounded
    search).
    """
    if not q or len(q.strip()) < 2:
        return None
    tokens = _strip_stopwords(_tokenise(q))
    if not tokens:
        return None

    token_clauses = [_regex_clause_for_token(t, fields) for t in tokens]
    if len(token_clauses) == 1:
        match: dict[str, Any] = dict(token_clauses[0])
    else:
        match = {"$and": token_clauses}

    if require_active:
        # Only filter on `is_active` when the field is explicitly False —
        # a missing field is treated as active so legacy rows still surface.
        active_clause = {"is_active": {"$ne": False}}
        if "$and" in match:
            match["$and"].append(active_clause)
        else:
            match = {"$and": [match, active_clause]}

    if extra_filters:
        match = {"$and": [match, extra_filters]} if match else dict(extra_filters)

    return match


def build_product_search_query(
    q: str,
    *,
    fields: Iterable[str] = (
        "name", "sku", "description", "category_name",
    ),
    require_active: bool = True,
) -> Optional[dict]:
    """Same logic, but for the `products` collection (tools / grouts /
    accessories)."""
    if not q or len(q.strip()) < 2:
        return None
    tokens = _strip_stopwords(_tokenise(q))
    if not tokens:
        return None

    token_clauses = [_regex_clause_for_token(t, fields) for t in tokens]
    if len(token_clauses) == 1:
        match: dict[str, Any] = dict(token_clauses[0])
    else:
        match = {"$and": token_clauses}

    if require_active:
        active_clause = {"is_active": True}
        if "$and" in match:
            match["$and"].append(active_clause)
        else:
            match = {"$and": [match, active_clause]}
    return match


def rank_score(name: str, q: str) -> int:
    """Lower = better match. Used for sorting unified results."""
    if not name:
        return 100
    name_lower = name.lower()
    q_lower = (q or "").lower().strip()
    if not q_lower:
        return 50
    # Exact full-query substring match wins
    if q_lower in name_lower:
        return 0
    tokens = _tokenise(q_lower)
    matched = sum(1 for t in tokens if t in name_lower)
    if matched == 0:
        return 90
    # More tokens matched in name → better
    return 10 + (len(tokens) - matched)
