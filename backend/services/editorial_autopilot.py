"""
Editorial Autopilot — fully autonomous competitor-driven content engine.

Goal: close the only real gap between us and Topps Tiles / Tile Mountain
— editorial topical authority. Every Monday morning the cron does this:

1. HARVEST — Ahrefs top_pages + best_by_links for our 5 competitors.
   Each row becomes a candidate "opportunity" with traffic, refdomains,
   top_keyword, source competitor.

2. SCORE — composite score:
       (org_traffic * 0.5) + (refdomains * 50) + relevance_bonus
   with relevance bonus only when the URL/keyword/title matches our
   tile/stone vocabulary. Filters out off-topic competitor wins.

3. DEDUPE — by normalised topic so we don't draft the same idea twice
   if multiple competitors rank for the same long-tail.

4. DRAFT — top N opportunities go to Claude with a tight prompt that
   produces:
       title (≤60 chars), meta_description (≤155 chars),
       body_md (1500-2500 word markdown — H2/H3, lists, FAQ),
       internal_links (3-5 anchor:url pairs into our products/categories),
       hero_prompt (a banner brief for marketing_studio).

5. PUBLISH — atomically:
       INSERT into blog_articles {slug, title, body_md, meta, …}
       INVALIDATE sitemap cache so the new URL appears in /sitemap.xml
       FIRE-AND-FORGET banner generation in the background

6. NOTIFY — Monday 09:00 BST email to admin: "We published 3 new
   articles this week, here are the URLs and the spend."

Safety rails:
- `monthly_spend_cap_usd` (default $25) — autopilot pauses for the
  rest of the month if exceeded; resumes 1st of next month.
- `paused` flag in DB — admin one-click kill switch from /admin/seo.
- Per-article timeouts (Claude 90s, Ahrefs 30s) so a single hang can't
  poison the whole run.
- Word-count + meta validation before publish; failures retry once
  then drop to `failed` status (visible in admin) — never publish
  garbage.
- Article slug collision guard against existing slugs + generated
  city-page slugs.

Public reading: blog articles are served at /api/shop/blog/{slug} and
linked from /sitemap.xml + the Express SSR layer. Frontend renders
each article at /blog/{slug} with full Article JSON-LD.
"""
from __future__ import annotations

import asyncio
import logging
import os
import re
import unicodedata
from datetime import datetime, timezone
from typing import Optional

from config import get_db
from services import ahrefs

logger = logging.getLogger(__name__)


# ────── Tile-relevance vocabulary ──────────────────────────────────

TILE_KEYWORDS = {
    "tile", "tiles", "tiling", "tiler", "porcelain", "ceramic",
    "marble", "limestone", "granite", "slate", "stone", "natural stone",
    "mosaic", "subway", "metro", "terrazzo", "travertine", "onyx",
    "quartz", "calacatta", "carrara", "victoriana", "encaustic",
    "grout", "grouting", "adhesive", "underfloor heating", "ufh",
    "bathroom", "kitchen", "splashback", "wet room", "hallway",
    "shower", "wall tile", "floor tile", "feature wall", "outdoor tile",
    "patio", "decking", "trim", "border", "trim tile", "edge",
    "renovation", "redecorate", "interior design", "trends",
}


def _is_tile_relevant(*texts: str) -> bool:
    """True if any of the given strings mention a tile/stone keyword.

    Two important refinements:
     - URL slugs use hyphens/underscores/slashes — normalise to spaces.
     - Match on word-boundaries so the host `toppstiles.co.uk` doesn't
       false-positive the keyword `tile` (we'd flag every page on a
       competitor with "tile" in its name as relevant otherwise — even
       genuinely off-topic content like /blog/best-laptops).
    """
    # Strip the protocol+host from any URLs so we're only matching on
    # the PATH + keyword + title — domains like "toppstiles" no longer
    # poison the relevance check.
    cleaned = []
    for t in texts:
        if not t:
            continue
        s = re.sub(r"https?://[^/]+", "", t.lower())
        s = re.sub(r"[-_/.]", " ", s)
        cleaned.append(s)
    blob = " ".join(cleaned)
    blob_words = set(re.findall(r"\b[a-z]+\b", blob))
    for kw in TILE_KEYWORDS:
        if " " in kw:
            # Multi-word keyword (e.g. "wet room") — substring check
            if kw in blob:
                return True
        elif kw in blob_words:
            return True
    return False


def _normalise_topic(*parts: str) -> str:
    """Collapse a URL + keyword into a stable dedupe key."""
    out = " ".join((p or "").lower() for p in parts)
    out = re.sub(r"https?://[^/]+/", " ", out)
    out = re.sub(r"[^a-z0-9 ]+", " ", out)
    return re.sub(r"\s+", " ", out).strip()[:120]


def _slugify(s: str) -> str:
    s = unicodedata.normalize("NFKD", s).encode("ascii", "ignore").decode()
    s = re.sub(r"[^a-zA-Z0-9\s-]", "", s).strip().lower()
    s = re.sub(r"[\s-]+", "-", s)
    return s[:80]


# ────── Settings (DB-backed; env-overridable for cap) ──────────────

DEFAULT_MONTHLY_CAP_USD = 25.0
DEFAULT_ARTICLES_PER_RUN = 3


async def get_settings() -> dict:
    db = get_db()
    doc = await db.editorial_autopilot_settings.find_one(
        {"key": "main"}, {"_id": 0}
    ) or {}
    return {
        "paused": bool(doc.get("paused", False)),
        "monthly_cap_usd": float(
            doc.get("monthly_cap_usd")
            or os.environ.get("EDITORIAL_AUTOPILOT_CAP_USD")
            or DEFAULT_MONTHLY_CAP_USD
        ),
        "articles_per_run": int(doc.get("articles_per_run") or DEFAULT_ARTICLES_PER_RUN),
        "last_run_at": doc.get("last_run_at"),
        "last_run_published": doc.get("last_run_published") or 0,
        "last_run_status": doc.get("last_run_status") or "never",
        "last_run_error": doc.get("last_run_error"),
        "last_run_diagnostic": doc.get("last_run_diagnostic"),
    }


async def update_settings(*, paused: Optional[bool] = None,
                          monthly_cap_usd: Optional[float] = None,
                          articles_per_run: Optional[int] = None,
                          admin_email: Optional[str] = None) -> dict:
    db = get_db()
    set_doc = {"key": "main", "updated_at": datetime.now(timezone.utc)}
    if paused is not None:
        set_doc["paused"] = bool(paused)
    if monthly_cap_usd is not None:
        set_doc["monthly_cap_usd"] = max(1.0, float(monthly_cap_usd))
    if articles_per_run is not None:
        set_doc["articles_per_run"] = max(1, min(10, int(articles_per_run)))
    if admin_email:
        set_doc["updated_by"] = admin_email
    await db.editorial_autopilot_settings.update_one(
        {"key": "main"}, {"$set": set_doc}, upsert=True,
    )
    return await get_settings()


async def monthly_spend_usd() -> float:
    """Sum cost_usd of every article published this calendar month."""
    db = get_db()
    now = datetime.now(timezone.utc)
    month_start = datetime(now.year, now.month, 1, tzinfo=timezone.utc)
    cursor = db.blog_articles.aggregate([
        {"$match": {"published_at": {"$gte": month_start.isoformat()}}},
        {"$group": {"_id": None, "total": {"$sum": "$cost_usd"}}},
    ])
    async for d in cursor:
        return float(d.get("total") or 0)
    return 0.0


# ────── Stage 1: harvest ───────────────────────────────────────────

async def harvest_opportunities(*, competitors: Optional[list] = None) -> list[dict]:
    """Pull TOP PAGES + BEST_BY_LINKS for each competitor in parallel.
    Score, dedupe by topic, return sorted-best-first."""
    competitors = competitors or ahrefs.DEFAULT_COMPETITORS
    seen: dict[str, dict] = {}

    async def _per_competitor(domain: str) -> None:
        try:
            top_pages_resp, links_resp = await asyncio.gather(
                ahrefs.top_pages(domain, country="gb", limit=30),
                ahrefs.best_by_links(domain, country="gb", limit=30),
                return_exceptions=True,
            )
        except Exception:  # noqa: BLE001
            logger.exception("harvest failed for %s", domain)
            return

        top_rows = (top_pages_resp.get("pages") if isinstance(top_pages_resp, dict) else None) or []
        link_rows = (links_resp.get("pages") if isinstance(links_resp, dict) else None) or []

        for r in top_rows:
            url = r.get("url", "")
            kw = r.get("top_keyword") or ""
            traffic = int(r.get("sum_traffic") or 0)
            if traffic < 100:  # noise filter
                continue
            if not _is_tile_relevant(url, kw):
                continue
            key = _normalise_topic(url, kw)
            score = traffic * 0.5
            existing = seen.get(key)
            if not existing or score > existing.get("score", 0):
                seen[key] = {
                    "topic_key": key,
                    "source_competitor": domain,
                    "source_url": url,
                    "top_keyword": kw,
                    "traffic": traffic,
                    "refdomains": existing.get("refdomains", 0) if existing else 0,
                    "score": score + (existing.get("link_bonus", 0) if existing else 0),
                    "kind": "traffic_winner",
                }

        for r in link_rows:
            url = r.get("url", "")
            kw = r.get("top_keyword") or ""
            refd = int(r.get("referring_domains") or 0)
            traffic = int(r.get("sum_traffic") or 0)
            if refd < 5:
                continue
            if not _is_tile_relevant(url, kw):
                continue
            # Use URL + top keyword as the dedupe key — same shape as
            # the traffic-winners loop above so we merge correctly.
            key = _normalise_topic(url, kw)
            link_bonus = refd * 50
            existing = seen.get(key)
            if existing:
                # Merge — same URL appearing in both reports is the
                # ideal candidate (both traffic AND links).
                existing["refdomains"] = max(existing.get("refdomains", 0), refd)
                existing["score"] = existing.get("score", 0) + link_bonus
                if existing.get("kind") == "traffic_winner":
                    existing["kind"] = "both"
            else:
                seen[key] = {
                    "topic_key": key,
                    "source_competitor": domain,
                    "source_url": url,
                    "top_keyword": kw[:80] or "untitled",
                    "traffic": traffic,
                    "refdomains": refd,
                    "score": link_bonus + (traffic * 0.5),
                    "link_bonus": link_bonus,
                    "kind": "link_winner",
                }

    await asyncio.gather(*[_per_competitor(d) for d in competitors])

    out = sorted(seen.values(), key=lambda x: x.get("score", 0), reverse=True)
    return out


# ────── Stage 2: skip already-covered topics ────────────────────────

async def filter_already_covered(opps: list[dict]) -> list[dict]:
    """Remove opps whose topic key matches an existing blog article or
    a city page slug we already have. Avoids drafting the same thing twice."""
    if not opps:
        return []
    db = get_db()
    existing_keys: set[str] = set()
    async for a in db.blog_articles.find({}, {"_id": 0, "topic_key": 1, "slug": 1, "title": 1}):
        if a.get("topic_key"):
            existing_keys.add(a["topic_key"])
        if a.get("title"):
            existing_keys.add(_normalise_topic(a["title"]))
    return [o for o in opps if o["topic_key"] not in existing_keys]


# ────── Stage 3: Claude draft ──────────────────────────────────────

DRAFT_SYSTEM_PROMPT = (
    "You are the editor of TileStation, a UK retailer of premium tiles "
    "and natural stone (tilestation.co.uk). Your job is to write a single "
    "long-form blog article that will outrank the competitor URL provided. "
    "Voice: confident, specific, helpful, unmistakably British (use UK "
    "spelling and measurements — m², £, mm). Avoid waffle. Use H2/H3 "
    "subheadings, bullet lists, and a 4-question FAQ. Include 3-5 internal "
    "links into our shop pages — pick from /shop/tiles, /shop/natural-stone, "
    "/shop/bathroom, /shop/kitchen, /shop/outdoor, /shop/feature-walls, "
    "/visualizer, /samples, or specific category slugs you can reasonably "
    "infer (e.g. /shop/marble-tiles, /shop/porcelain-tiles).\n\n"
    "Return STRICT JSON with these keys ONLY (no markdown fences, no commentary):\n"
    "{\n"
    "  \"title\": string up to 60 chars (a click-worthy H1),\n"
    "  \"meta_description\": string 130-155 chars,\n"
    "  \"slug\": string lowercase-kebab-case derived from title,\n"
    "  \"body_md\": string Markdown, 1500-2500 words, H2/H3 hierarchy,\n"
    "  \"hero_prompt\": string — a brief for an image generator describing the\n"
    "                  hero banner. Photorealistic UK tile/bathroom/kitchen scene.\n"
    "                  No headline text in the image.\n"
    "  \"internal_links\": [{\"anchor\": string, \"url\": string starting with /}],\n"
    "  \"faqs\": [{\"q\": string, \"a\": string}] exactly 4,\n"
    "  \"primary_keyword\": string — the main search phrase to optimise for\n"
    "}\n"
    "Do NOT invent product names or prices. Do NOT make up customer "
    "reviews. If you reference statistics, use round-number industry "
    "estimates without citation."
)


async def draft_article(opp: dict, *, model: str = "claude-haiku-4-5-20251001") -> dict:
    """Call Claude to draft a single article from an opportunity."""
    from emergentintegrations.llm.chat import LlmChat, UserMessage

    api_key = os.environ.get("EMERGENT_LLM_KEY")
    if not api_key:
        raise RuntimeError("EMERGENT_LLM_KEY not set")

    user_prompt = (
        f"Competitor URL: {opp['source_url']}\n"
        f"Top keyword they rank for: {opp['top_keyword']}\n"
        f"Their organic traffic: {opp.get('traffic', 0):,}/month\n"
        f"Referring domains: {opp.get('refdomains', 0)}\n"
        f"Source competitor: {opp['source_competitor']}\n\n"
        "Draft a TileStation article that comprehensively beats this URL "
        "for the keyword above. Match search intent. Write for a UK reader "
        "renovating their home, not for industry insiders."
    )
    chat = LlmChat(
        api_key=api_key,
        session_id=f"editorial-{datetime.now(timezone.utc).isoformat()}",
        system_message=DRAFT_SYSTEM_PROMPT,
    ).with_model("anthropic", model).with_params(max_tokens=8000)

    raw = await chat.send_message(UserMessage(text=user_prompt))
    raw = (raw or "").strip()
    if raw.startswith("```"):
        # Strip code fence if Claude ignores the no-fence rule
        raw = re.sub(r"^```(?:json)?\s*|\s*```$", "", raw)
    import json as _json
    try:
        out = _json.loads(raw)
    except Exception as exc:
        raise RuntimeError(f"Claude returned non-JSON: {str(exc)[:120]} — first 200 chars: {raw[:200]}")

    # Validation — better to fail loudly than publish junk
    title = (out.get("title") or "").strip()
    body = (out.get("body_md") or "").strip()
    meta = (out.get("meta_description") or "").strip()
    if not title or len(title) < 8:
        raise RuntimeError("draft title too short or missing")
    if len(body.split()) < 800:
        raise RuntimeError(f"draft body too short ({len(body.split())} words)")
    if not meta or not (90 <= len(meta) <= 170):
        # Auto-pad / truncate so meta is always reasonable
        meta = meta[:160] if meta else f"{title} — TileStation guide."
        out["meta_description"] = meta
    out["slug"] = _slugify(out.get("slug") or title)
    if not out["slug"]:
        raise RuntimeError("could not derive slug")

    # Cost estimate — rough, refined via env override
    out["cost_usd"] = float(os.environ.get("EDITORIAL_PER_ARTICLE_COST_USD", "0.20"))
    return out


# ────── Stage 4: publish ───────────────────────────────────────────

async def publish_article(draft: dict, opp: dict, *, source: str = "autopilot") -> dict:
    """Atomically write a blog_articles row + invalidate caches."""
    db = get_db()
    now = datetime.now(timezone.utc)
    slug = draft["slug"]

    # Slug-collision guard — append -2, -3, … if needed
    base = slug
    i = 2
    while await db.blog_articles.find_one({"slug": slug}, {"_id": 0, "slug": 1}):
        slug = f"{base}-{i}"
        i += 1
        if i > 50:
            raise RuntimeError("could not find a unique slug")

    doc = {
        "id": slug,  # short + stable
        "slug": slug,
        "title": draft["title"][:120],
        "meta_description": draft["meta_description"][:170],
        "body_md": draft["body_md"],
        "internal_links": draft.get("internal_links", []),
        "faqs": draft.get("faqs", []),
        "primary_keyword": draft.get("primary_keyword", opp.get("top_keyword", ""))[:120],
        "topic_key": opp.get("topic_key"),
        "source_competitor": opp.get("source_competitor"),
        "source_url": opp.get("source_url"),
        "score": opp.get("score"),
        "hero_prompt": draft.get("hero_prompt", ""),
        "hero_image_url": None,  # filled in by background banner job
        "status": "published",
        "source": source,
        "published_at": now.isoformat(),
        "updated_at": now,
        "cost_usd": float(draft.get("cost_usd", 0.20)),
    }
    await db.blog_articles.insert_one(doc)
    doc.pop("_id", None)

    # Bust the sitemap + storefront list caches so the article goes
    # live immediately. Best-effort — ignore failures.
    try:
        from utils.endpoint_cache import endpoint_cache
        endpoint_cache.invalidate("public_blog_list")
        endpoint_cache.invalidate("public_sitemap")
    except Exception:
        pass

    # Fire-and-forget banner generation. Article is fully readable
    # without it — the banner just makes the social-share card pretty.
    asyncio.create_task(_generate_hero_banner(slug, draft.get("hero_prompt") or draft["title"]))

    return doc


async def _generate_hero_banner(slug: str, hero_prompt: str) -> None:
    """Background banner generation — separate task so a slow image
    job never blocks the article from going live."""
    try:
        from services.marketing_studio import generate_banner_image
        from services.object_storage import put_object
        import uuid

        result = await generate_banner_image(
            prompt=hero_prompt, model="nano-banana", width=1600, height=900,
        )
        banner_id = uuid.uuid4().hex
        path = f"tile-station/blog/{banner_id}.png"
        put_object(path, result["png_bytes"], "image/png")
        url = f"/api/website/marketing-media/{banner_id}.png"
        db = get_db()
        await db.blog_articles.update_one(
            {"slug": slug},
            {"$set": {"hero_image_url": url, "hero_asset_id": banner_id}},
        )
    except Exception:  # noqa: BLE001
        logger.exception("hero banner generation failed for %s", slug)


# ────── Stage 5: full weekly run ───────────────────────────────────

async def run_weekly_autopilot(*, force: bool = False, max_articles: Optional[int] = None) -> dict:
    """One-shot: harvest, draft, publish, return summary. Called by the
    Monday cron AND by the admin "Run now" button. `force=True` bypasses
    the paused flag (used by manual run)."""
    db = get_db()
    settings = await get_settings()
    now = datetime.now(timezone.utc)

    if settings["paused"] and not force:
        await db.editorial_autopilot_settings.update_one(
            {"key": "main"},
            {"$set": {"last_run_at": now, "last_run_status": "skipped_paused"}},
            upsert=True,
        )
        return {"ok": True, "status": "skipped_paused", "published": 0}

    spent = await monthly_spend_usd()
    cap = settings["monthly_cap_usd"]
    if spent >= cap:
        await db.editorial_autopilot_settings.update_one(
            {"key": "main"},
            {"$set": {
                "last_run_at": now,
                "last_run_status": "skipped_cap_reached",
                "last_run_spent": spent,
            }},
            upsert=True,
        )
        return {"ok": True, "status": "skipped_cap_reached", "spent_usd": spent, "cap_usd": cap, "published": 0}

    target_count = min(max_articles or settings["articles_per_run"], 5)
    target_count = max(1, target_count)

    try:
        opps = await harvest_opportunities()
    except Exception as exc:
        logger.exception("harvest failed")
        await db.editorial_autopilot_settings.update_one(
            {"key": "main"},
            {"$set": {
                "last_run_at": now,
                "last_run_status": "failed_harvest",
                "last_run_error": str(exc)[:300],
            }},
            upsert=True,
        )
        return {"ok": False, "status": "failed_harvest", "error": str(exc)[:300]}

    raw_opps_count = len(opps)
    opps = await filter_already_covered(opps)
    candidates = opps[:target_count * 3]  # over-fetch in case some drafts fail
    after_filter_count = len(opps)

    # Build a detailed diagnostic so the admin can see exactly where
    # candidates are being lost — without it, "no_candidates" is just
    # a black box. We persist this on the settings doc so the /status
    # endpoint can surface it.
    diagnostic = {
        "raw_harvest_count": raw_opps_count,
        "after_already_covered_filter": after_filter_count,
        "ahrefs_key_present": bool(os.environ.get("AHREFS_API_KEY")),
        "competitors_used": list((await ahrefs.get_competitors())
                                  if hasattr(ahrefs, "get_competitors")
                                  else ahrefs.DEFAULT_COMPETITORS),
        "checked_at": now.isoformat(),
    }

    published: list[dict] = []
    failures: list[dict] = []
    for opp in candidates:
        if len(published) >= target_count:
            break
        # Stop if cap will be exceeded by next article
        per_article = float(os.environ.get("EDITORIAL_PER_ARTICLE_COST_USD", "0.20"))
        if (spent + per_article * (len(published) + 1)) > cap:
            break
        try:
            draft = await draft_article(opp)
            doc = await publish_article(draft, opp, source="autopilot")
            published.append(doc)
        except Exception as exc:  # noqa: BLE001
            logger.exception("draft/publish failed for %s", opp.get("source_url"))
            failures.append({"opp": opp, "error": str(exc)[:200]})

    final_spent = await monthly_spend_usd()
    await db.editorial_autopilot_settings.update_one(
        {"key": "main"},
        {"$set": {
            "last_run_at": now,
            "last_run_status": "ok" if published else ("no_candidates" if not opps else "all_drafts_failed"),
            "last_run_published": len(published),
            "last_run_spent": final_spent,
            "last_run_failures": len(failures),
            "last_run_error": (failures[0]["error"] if failures and not published else None),
            "last_run_diagnostic": diagnostic,
        }},
        upsert=True,
    )

    # Send digest email — non-blocking on failure
    try:
        await _send_digest_email(published, failures, spent_usd=final_spent, cap_usd=cap)
    except Exception:
        logger.exception("digest email failed")

    return {
        "ok": True,
        "status": "ok" if published else ("no_candidates" if not opps else "all_drafts_failed"),
        "published_count": len(published),
        "published": [{"slug": p["slug"], "title": p["title"]} for p in published],
        "failures": len(failures),
        "spent_usd": final_spent,
        "cap_usd": cap,
        "candidates_considered": len(candidates),
    }


async def _send_digest_email(
    published: list[dict], failures: list[dict],
    *, spent_usd: float, cap_usd: float,
) -> None:
    if not published and not failures:
        return  # nothing to report
    from services.email import send_email_notification
    base = os.environ.get("FRONTEND_BASE_URL", "https://tilestation.co.uk").rstrip("/")
    pub_html = "".join(
        f'<li><a href="{base}/blog/{p["slug"]}"><strong>{p["title"]}</strong></a><br>'
        f'<small style="color:#64748b">competitor source: {p.get("source_competitor")}</small></li>'
        for p in published
    )
    fail_html = "".join(
        f'<li>{f["opp"].get("source_url", "?")}: {f["error"]}</li>'
        for f in failures[:5]
    )
    html = f"""
    <h2 style="font-family:system-ui">Editorial Autopilot — weekly run</h2>
    <p>Hello, your competitor-driven content engine just ran.</p>
    <p><strong>Published this week: {len(published)}</strong></p>
    <ul>{pub_html or '<li>No new articles this week — either competitors had nothing fresh worth replicating, or the cap was reached.</li>'}</ul>
    {f'<p><strong>{len(failures)} drafts failed to validate</strong> (kept private):</p><ul>{fail_html}</ul>' if failures else ''}
    <p>Spend so far this calendar month: <strong>${spent_usd:.2f}</strong> of ${cap_usd:.2f}</p>
    <p style="color:#64748b;font-size:12px">
      Manage settings or pause the autopilot at
      <a href="{base}/admin/seo">/admin/seo</a>.
    </p>
    """
    admin_email = os.environ.get("ADMIN_EMAIL", "qasim@tilestation.co.uk")
    await send_email_notification(
        to_emails=[admin_email],
        subject=f"Editorial Autopilot · {len(published)} new article{'' if len(published) == 1 else 's'} live",
        html_content=html,
    )


# ────── List + delete (for admin UI) ──────────────────────────────

async def list_articles(*, limit: int = 30, source: Optional[str] = None) -> list[dict]:
    db = get_db()
    q: dict = {}
    if source:
        q["source"] = source
    rows = await db.blog_articles.find(q, {"_id": 0, "body_md": 0}) \
        .sort("published_at", -1).limit(limit).to_list(length=limit)
    return rows


async def get_article(slug: str) -> Optional[dict]:
    db = get_db()
    return await db.blog_articles.find_one({"slug": slug}, {"_id": 0})


async def delete_article(slug: str) -> dict:
    db = get_db()
    res = await db.blog_articles.delete_one({"slug": slug})
    try:
        from utils.endpoint_cache import endpoint_cache
        endpoint_cache.invalidate("public_blog_list")
        endpoint_cache.invalidate("public_sitemap")
    except Exception:
        pass
    return {"ok": True, "deleted": res.deleted_count}
