# Mission: Narrow the Gap to Topps Tiles
## 12-month SEO + organic growth roadmap

*Formalised 12 May 2026. Owner: SEO Autopilot system. Reviewed monthly.*

---

## North-Star framing

Topps Tiles is the UK tile market leader with ~25 years of SEO equity, hundreds of physical stores, and Domain Rating (DR) in the 60–70 range. **We will not match them in a year.** We *will* close the gap meaningfully and dominate the long tail (collection + city pages + buyer-intent keywords).

The mission is **gap closure**, not parity.

## Baseline (T-zero — to be measured Week 1)

| Metric | Tile Station (we) | Topps Tiles (target) | Gap |
|---|---|---|---|
| Domain Rating (Ahrefs) | TBD | ~65 | — |
| Organic monthly visits | TBD | ~600,000 | — |
| Indexed pages (Google) | ~1,070 | ~50,000 | ~47× |
| Referring domains | TBD | ~8,000 | — |
| Keywords ranking top-10 | TBD | ~120,000 | — |
| Keyword overlap (we appear for ≥1 of their top 1k) | TBD | n/a | — |

The Competitor Tracker (built this session) auto-captures these weekly into `db.competitor_tracker_snapshots` so we can see the lines converge over time.

---

## 12-month milestones

Each milestone has: target metric · auto-tracked source · "WHY this is the right move at this stage".

### Month 1 — **Foundation (NOW)**
- **Indexed pages**: 1,070 → **1,500** (collection PDPs being added via sitemap fix; auto-injected per session)
- **Soft 404 + Crawled-not-indexed (GSC)**: 192 → **<50** (SSR body-content injection)
- **SEO Autopilot overrides**: 530 → continuously growing
- **Why**: You can't rank pages Google can't index. Foundation first.

### Month 2 — **Long-tail launch**
- **Organic visits/month**: baseline → **2,500**
- **Editorial Autopilot articles published**: 12+ (3/week × 4 weeks)
- **Top-20 keywords (Ahrefs)**: baseline → **+25**
- **Why**: Each Editorial Autopilot article attacks a keyword Topps already ranks for. Long-tail commercial intent ("60x60 grey porcelain tiles", "marble effect splashback") is where a small player wins.

### Month 3 — **City + showroom dominance**
- **City landing pages indexed**: all 50+ (already approved + sitemap-listed)
- **Local pack (Google Maps) rankings**: top-3 in Tonbridge, Chingford, Gravesend
- **Top-10 keywords**: +25 cumulative
- **Why**: Local-intent keywords ("tile showroom Tonbridge", "bathroom tiles Kent") are 100% within reach. Topps wins national; we win local.

### Month 4 — **Backlink push**
- **Referring domains**: baseline → **+50**
- **Houzz Pro listing live** (P2 in roadmap)
- **Pinterest API unlocked** (status: trial pending) → 200+ posted Pins
- **DR (Ahrefs)**: baseline → **+5 points**
- **Why**: DR moves through referring domains. Editorial articles + Pinterest visual content + Houzz listing = 3 distinct channels for organic backlink acquisition.

### Month 5 — **Content velocity**
- **Indexed pages**: 1,500 → **2,500**
- **Editorial articles total**: 50+
- **Organic visits/month**: 2,500 → **8,000**
- **Why**: Compound effect — every article adds new keywords, internal links lift the whole domain, the trend curve starts to bend.

### Month 6 — **Half-year inflection**
- **DR**: baseline +10 points (e.g. 15 → 25)
- **Organic visits/month**: 8,000 → **15,000**
- **Keywords ranking top-3**: **25**
- **Top-10 keywords overlap with Topps** (we appear for keywords Topps also ranks for): **25%**
- **Sora 2 cross-post engine live** (Sora videos → IG Reels / TikTok / YouTube — P2)
- **Why**: Six months is the standard "Google trust" inflection. Articles published month 1-3 start ranking.

### Month 7 — **Authority expansion**
- **Referring domains**: baseline +200
- **Indexed pages**: 2,500 → **4,000** (every active tile + every active collection + every blog post)
- **Why**: Google Discover starts surfacing tile/design content. We have the volume to capture it.

### Month 8 — **Conversion + commercial intent**
- **Organic visits/month**: 15,000 → **25,000**
- **Trade-account registrations from organic**: track via `utm_medium=organic`
- **Sample requests from organic**: track
- **Why**: Volume is good; conversion is better. Commercial-intent keywords ("trade tile supplier Kent") convert at 5-10× generic keywords.

### Month 9 — **Adjacent-content authority**
- **Whole-home renovation content cluster** (kitchens, bathrooms, outdoor): 50+ pieces
- **Pinterest top-3 boards** showing >10k impressions/month each
- **Why**: Adjacent content (kitchen cabinets that go with our tiles, bathroom suites we don't sell but inform on) is how IKEA and John Lewis win — you become a destination, not a vendor.

### Month 10 — **Product page authority**
- **Average product page DR (URL-level)**: 5+ (Ahrefs)
- **Internal link graph density**: every PDP linked from ≥3 other pages
- **Why**: Topps wins because their product pages are individually authoritative. Internal link sculpting + featured-in-blog-posts gets us there.

### Month 11 — **National visibility**
- **Organic visits/month**: 25,000 → **40,000**
- **Top-10 national keywords**: 50
- **Branded search volume** ("tile station") in Ahrefs: 2,000+ monthly
- **Why**: At month 11, branded search becomes a real signal that customers know us. This is the moment Topps starts seeing us in their cannibalisation reports.

### Month 12 — **Gap report**

| Metric | T-zero | T+12 target | Topps |
|---|---|---|---|
| DR | TBD | +15 points | ~65 |
| Organic visits/month | TBD | **60,000** | ~600k |
| Indexed pages | 1,070 | **6,000** | ~50k |
| Keyword overlap | 0% | **40%** | n/a |
| Referring domains | TBD | +400 | ~8k |

**Realistic outcome**: 10× our T-zero organic traffic. **1/10th of Topps** instead of 1/600th. That's the gap closing meaningfully.

---

## Strategy pillars (what's actually doing the work)

### 1. Self-running content engine (BUILT)
- **Editorial Autopilot** publishes 3 articles every Monday. Pulls Topps' winning topics from Ahrefs and out-writes them.
- Status: live, ran successfully May 3 2026.

### 2. Self-running technical SEO (BUILT TODAY)
- **SEO Self-Crawler** weekly audit of every URL.
- **SEO Auto-Fixer** writes per-URL title/desc/JSON-LD/canonical overrides into `db.seo_overrides`.
- **GSC Indexing Scanner** polls 200 URLs/day through Google's API.
- **Dynamic redirects** serve 301s without redeploys.
- Status: live in code, deploys with next Railway push.

### 3. Self-running competitor tracking (BUILT TODAY)
- **Competitor Tracker** weekly Ahrefs poll captures our DR vs Topps' DR, our traffic vs theirs, keyword overlap %.
- **Mission Dashboard** at `/admin/competitor-tracker` shows the gap closing or widening in real time.
- Status: built this session.

### 4. Visual / social content (PARTIALLY BUILT)
- **Pinterest Engine** auto-generates and queues Pins — 9 boards, drip-fed daily, A/B copy variants, AI lifestyle renders.
- Status: BUILT but blocked on Pinterest API trial access. Day 1 of unlock = live.
- **Sora 2 cross-post engine** (Reels/TikTok/YouTube): P2 — needs Meta + TikTok + Google Cloud dev accounts.

### 5. Local SEO (PARTIALLY BUILT)
- 50+ city landing pages already in sitemap.
- **Google Business Profile API** integration: P2 — waiting on Google allowlist.

### 6. Backlinks (PLANNED — needs human input)
- Houzz Pro paid listing: P2 — requires paid Houzz membership decision.
- HARO (Help a Reporter Out) integration: NOT BUILT — would require admin to subscribe + monitor.
- Trade press / interior design blog outreach: NOT BUILT — would require manual outreach campaign.

---

## What requires human approval (intentionally not automated)

These are the ONLY touches the mission asks of the admin:

1. **Approve the Pinterest App Secret** when Pinterest unlocks trial access (1-time, takes 30 seconds — paste env var to Railway).
2. **Decide on Houzz Pro paid membership** (~£50/month, P2 backlog).
3. **Decide on HARO subscription** (~$19/month, optional — high backlink yield).
4. **Approve "thin content" repair when AI proposes new copy** (admin click in `/admin/seo-autopilot-v2` — keeps editorial quality high).

Everything else: autopilot.

---

## Tracking + reporting

- **Weekly snapshot**: Monday 06:30 BST → `competitor_tracker_snapshots` collection.
- **Telegram digest**: Every Monday morning, the mission gets a one-line health check ("Gap closed by 3% vs last week" / "Gap widened by 1% — investigate").
- **Admin dashboard**: `/admin/competitor-tracker` — DR trendline, traffic trendline, milestone progress, "are we on track for Month N?" status indicator.

---

## Risks + countermeasures

| Risk | Likelihood | Countermeasure |
|---|---|---|
| Google algorithm update penalises us | Medium | Algo-Update Watcher (existing) detects + Telegram alerts within 24h |
| Ahrefs API quota exceeded | Low | Tiered fetch — competitor data weekly not daily |
| Pinterest API never unlocks | Medium | Pinterest engine has fallback content output (still useful for Pin scheduler when unlocked) |
| Editorial autopilot quality degrades | Medium | Articles are deletable in one click; monthly £30 cap prevents runaway spend |
| Topps Tiles outpaces us | High | This isn't a horserace — we win the long tail and Kent local. National parity is not the goal in Year 1 |

---

## Owner

Tile Station SEO Autopilot system. Operates Mon-Fri 03:00 + 03:30 BST without human intervention. Surfaces only:
- Telegram pings when issue count goes UP week-over-week
- Telegram pings when DR / traffic drops materially
- Admin dashboard for visibility

**Mission is NOT a manual checklist.** It's a self-running system with a measurable gap-closing curve. The admin's job is to read the Monday digest and intervene only when something regresses.
